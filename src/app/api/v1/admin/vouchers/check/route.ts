/*
  Pemeriksaan kode voucher.

  Endpoint ini menjawab satu pertanyaan yang paling sering ditanyakan operator: "kode ini masih
  berlaku, dan kalau dipakai, harganya jadi berapa?".

  Bentuk jawabannya sengaja memuat dua bagian yang terpisah:

  1. `blockers` — daftar alasan kode itu tidak dapat dipakai, masing-masing dengan sebabnya sendiri.
     Yang penting di sini adalah membedakan "kodenya tidak ada" dari "kodenya ada tetapi belum mulai",
     "sudah kedaluwarsa", "kuotanya habis", dan "pelanggan ini sudah pernah memakainya". Semuanya
     berakhir dengan pelanggan tidak mendapat potongan, tetapi tindakan yang harus diambil berbeda
     sama sekali.

  2. `prices` — akibatnya pada tiap harga: harga sebelum, potongan yang benar-benar dipakai, harga
     sesudah, dan aturan mana yang menang. Bagian ini yang menunjukkan aturan "potongan tidak
     menumpuk": bila flash sale sedang memberi potongan lebih besar, yang dipakai flash sale, dan
     kode yang kalah tetap ditampilkan sebagai berlaku supaya tidak terlihat seperti kode yang salah.

  Perhitungannya memakai fungsi yang sama dengan yang dipakai saat menagih, yaitu
  `matchedRulesForPrices`, bukan salinan aturan yang ditulis ulang untuk layar ini. Kalau dihitung
  ulang di sini, layar ini akan menjanjikan harga yang berbeda dari yang ditagih.

  Endpoint ini tidak menyimpan apa pun. Pemakaian voucher dicatat saat tagihan dibuat, bukan saat
  kode diperiksa.
*/
import {
  findVoucherByCode,
  matchedRulesForPrices,
  priceOptions,
  readVoucher,
  voucherPriceCounts,
  voucherRedemptionCounts,
  type PriceRef,
} from "@/lib/server/discounts";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { voucherCheckSchema } from "@/lib/schemas/admin-discount";
import { queryOne } from "@/lib/server/db";
import { parseAmount } from "@/lib/server/discount-price";

export const POST = routeHandler("admin.vouchers.check", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.read");

  /*
    Pemeriksaan yang mengubah data tidak terjadi di sini, tetapi token CSRF tetap diwajibkan: endpoint
    ini menerima POST, dan permintaan lintas situs yang dapat memicu POST sebaiknya ditolak sejak awal
    alih-alih bergantung pada kenyataan bahwa endpoint ini kebetulan tidak menulis apa pun.
  */
  await requireCsrf(request);

  const input = await parseJson(request, voucherCheckSchema);

  /*
    Voucher dicari tanpa menyaring keadaannya, justru supaya keadaannya dapat dijelaskan. Kalau
    pencariannya hanya mengembalikan voucher yang berlaku, jawaban untuk kode kedaluwarsa akan sama
    dengan jawaban untuk kode yang tidak pernah ada.
  */
  const voucher = await findVoucherByCode(input.code);

  if (!voucher) {
    return ok(
      {
        code: input.code.trim().toUpperCase(),
        applicable: false,
        voucher: null,
        blockers: [
          {
            code: "not_found",
            message: `Kode "${input.code.trim().toUpperCase()}" tidak terdaftar. Periksa ejaannya, atau buat voucher baru bila kode ini memang belum ada.`,
          },
        ],
        prices: [],
        total_before: 0,
        total_after: 0,
        total_discount: 0,
      },
      requestId,
    );
  }

  const [priceCounts, redemptionCounts] = await Promise.all([
    voucherPriceCounts([voucher.id]),
    voucherRedemptionCounts([voucher.id]),
  ]);
  const terpakai = redemptionCounts.get(voucher.id) ?? 0;

  /*
    Alasan kode tidak dapat dipakai dikumpulkan seluruhnya, bukan berhenti pada yang pertama.
    Operator yang memperbaiki satu syarat lalu menemukan syarat berikutnya akan menebak-nebak, dan
    itu yang membuat promo terasa rumit padahal isinya sederhana.
  */
  const blockers: { code: string; message: string }[] = [];
  const sekarang = Date.now();

  if (!voucher.is_active) {
    blockers.push({
      code: "inactive",
      message:
        "Voucher ini sedang dimatikan. Hidupkan kembali di halaman detailnya bila memang ingin dipakai.",
    });
  }
  if (voucher.starts_at !== null && voucher.starts_at.getTime() > sekarang) {
    blockers.push({
      code: "not_started",
      message: `Voucher ini baru berlaku sejak ${voucher.starts_at.toISOString()}. Sampai saat itu, kodenya belum bisa dipakai.`,
    });
  }
  if (voucher.ends_at !== null && voucher.ends_at.getTime() <= sekarang) {
    blockers.push({
      code: "ended",
      message: `Voucher ini sudah kedaluwarsa sejak ${voucher.ends_at.toISOString()}.`,
    });
  }
  if (voucher.max_redemptions !== null && terpakai >= voucher.max_redemptions) {
    blockers.push({
      code: "quota_exhausted",
      message: `Kuotanya sudah habis: ${terpakai} dari ${voucher.max_redemptions} pemakaian. Naikkan kuotanya bila promo masih ingin diteruskan.`,
    });
  }

  /*
    Pemakaian oleh pelanggan tertentu hanya dapat diperiksa bila pelanggannya disebutkan. Berbeda dari
    sisa pemeriksaan di atas, ini bukan sifat kodenya melainkan sifat orang yang memakainya, jadi
    jawabannya pun berbeda untuk tiap pelanggan.
  */
  if (input.customer_id) {
    const pemakaian = await queryOne<{ jumlah: number }>(
      `SELECT count(*)::int AS jumlah
       FROM discount_voucher_redemptions
       WHERE voucher_id = $1 AND customer_id = $2::uuid`,
      [voucher.id, input.customer_id],
    );

    if ((pemakaian?.jumlah ?? 0) > 0) {
      blockers.push({
        code: "already_used_by_customer",
        message:
          "Pelanggan ini sudah pernah memakai kode tersebut. Kode ini hanya berlaku sekali untuk satu pelanggan.",
      });
    }
  }

  /*
    Harga yang dihitung: satu harga tertentu bila diminta, atau seluruh harga paket bila tidak.
    Dihitung seluruhnya supaya operator dapat melihat sendiri paket mana yang terdampak, tanpa harus
    mencoba satu per satu.
  */
  const semuaHarga: PriceRef[] = (await priceOptions()).map((price) => ({
    id: price.id,
    plan_id: price.plan_id,
    amount: price.amount,
    currency: price.currency,
  }));

  const dihitung = input.plan_price_id
    ? semuaHarga.filter((price) => price.id === input.plan_price_id)
    : semuaHarga;

  /*
    Kode yang gagal tetap dihitung akibatnya, dengan satu catatan penting: bila ada alasan yang
    menghalanginya, kode itu tidak diikutkan sebagai calon sama sekali. Tanpa pemisahan ini, layar
    akan menampilkan potongan dari kode yang sebenarnya tidak boleh dipakai.
  */
  const akibat = await matchedRulesForPrices(
    dihitung,
    blockers.length > 0 ? {} : { customerId: input.customer_id ?? null, voucherCode: voucher.code },
  );

  /*
    Jumlah di bawah dihitung atas seluruh harga yang dikirim, termasuk yang tidak mendapat potongan.

    Angka ini bukan harga yang akan dibayar siapa pun: satu pelanggan berlangganan satu paket, bukan
    seluruh paket sekaligus. Gunanya untuk menjawab "seberapa besar promo ini kalau kena semua", dan
    karena itu harga yang tidak terdiskon tetap ikut dijumlahkan — mengeluarkannya akan membuat
    `total_before` tampak seperti harga paket yang didiskon saja.
  */
  const totalBefore = akibat.reduce((jumlah, price) => jumlah + parseAmount(price.amount), 0);
  const totalAfter = akibat.reduce((jumlah, price) => jumlah + price.amount_after, 0);

  return ok(
    {
      code: voucher.code,
      applicable: blockers.length === 0,
      voucher: await readVoucher(voucher.id),
      blockers,
      prices: akibat.map((price) => ({
        price_id: price.price_id,
        plan_id: price.plan_id,
        amount: price.amount,
        currency: price.currency,
        amount_after: price.amount_after,
        discount_amount: price.discount_amount,
        discount: price.discount,
        /*
          Semua aturan yang berlaku, termasuk yang kalah. Inilah yang membuat layar dapat mengatakan
          "kode Anda sah, tetapi flash sale sedang memberi potongan lebih besar" alih-alih diam-diam
          mengabaikan kode yang pelanggan sudah mengetik.
        */
        vouchers: price.vouchers,
        flash_sales: price.flash_sales,
      })),
      /* Jumlah harga terpilih ditampilkan supaya cakupan `all_prices` tidak terlihat sama saja. */
      voucher_price_count: priceCounts.get(voucher.id) ?? 0,
      voucher_redemption_count: terpakai,
      total_before: totalBefore,
      total_after: totalAfter,
      total_discount: totalBefore - totalAfter,
    },
    requestId,
  );
});

/*
  Validasi untuk modul diskon.

  Aturan penting diletakkan di sini, bukan di route handler, supaya layar admin dan endpoint memakai
  pemeriksaan yang sama.

  1. Kode voucher dinormalkan menjadi huruf besar. Kode itulah yang diketik pelanggan dan yang
     menjadi kunci unik, jadi "nayaka10" dan "NAYAKA10" tidak boleh menjadi dua voucher berbeda.

  2. Potongan harus punya tepi: persentase 1..100, nominal tetap minimal Rp1. Tanpa batas, satu
     salah ketik dapat membuat potongan melebihi harga paket mana pun, dan itu baru ketahuan saat
     pelanggan membayar.

  3. Nominal dikirim sebagai teks, bukan angka pecahan. Kolomnya bertipe numeric(14, 2), dan angka
     pecahan biner yang datang dari peramban dapat berubah nilai setelah beberapa kali dibulatkan.
     Teks seperti "50000.00" diteruskan apa adanya ke database, sehingga tidak ada langkah di
     antaranya yang dapat mengubah nominalnya.

  4. Waktu diperiksa di sini sebelum ke database, supaya pesan galatnya menunjuk kolom yang salah.
     Batasan `ends_at > starts_at` juga ada di database, tetapi galat dari sana berbentuk pelanggaran
     constraint dan tidak dapat dibaca operator.

  5. Cakupan `selected_prices` wajib berisi minimal satu harga, dan cakupan `all_prices` justru wajib
     kosong. Yang kedua bukan sekadar kerapian: trigger database menolak baris harga pada aturan
     bercakupan semua paket, dan menolaknya di sini menghasilkan pesan yang bisa dimengerti.

  6. Kuota per pelanggan tidak boleh melebihi kuota total. Batas 2 per pelanggan pada voucher yang
     hanya tersedia 1 tidak masuk akal, dan hampir selalu tanda salah isi.

  Bentuk pembuatan dan penyuntingan disusun dari potongan yang sama, dengan satu perbedaan yang
  disengaja: saat membuat, kolom penentu wajib diisi; saat menyunting, kolom yang tidak dikirim tidak
  ikut diubah. Karena itu aturan silangnya ditulis sekali dalam fungsi pemeriksa yang menerima
  penanda "wajib".
*/
import { z } from "zod";

/* Batas panjang teks mengikuti lebar kolom di database, supaya galatnya jelas sebelum sampai ke SQL. */
const NAMA_MAKS = 120;
const DESKRIPSI_MAKS = 500;
const KODE_MAKS = 32;

export const discountScopeSchema = z.enum(["all_prices", "selected_prices"]);

export const discountTypeSchema = z.enum(["percent", "fixed"]);

export const discountStateSchema = z.enum(["running", "scheduled", "ended", "inactive"]);

/*
  Nominal uang.

  Diterima sebagai teks atau angka, lalu selalu dikembalikan sebagai teks dengan dua angka di
  belakang koma. Angka diizinkan supaya pemanggil dari skrip tidak dipaksa menulis tanda kutip,
  tetapi hasilnya tetap teks sehingga tidak ada pembulatan pecahan di perjalanan.
*/
const amountText = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const teks = typeof value === "number" ? String(value) : value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(teks)) {
      ctx.addIssue({
        code: "custom",
        message: "Nominal harus berupa angka rupiah, tanpa pemisah ribuan.",
      });
      return z.NEVER;
    }
    const [utuh, pecahan = ""] = teks.split(".");
    return `${utuh}.${pecahan.padEnd(2, "0")}`;
  })
  .refine((teks) => Number(teks) > 0, { message: "Nominal harus lebih besar dari nol." });

/* Kode voucher: huruf besar, mengikuti batasan kolom ^[A-Z0-9_-]{3,32}$ di database. */
const codeSchema = z
  .string()
  .trim()
  .min(3, "Kode minimal 3 karakter.")
  .max(KODE_MAKS, `Kode maksimal ${KODE_MAKS} karakter.`)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "Kode hanya boleh berisi huruf, angka, garis bawah, dan tanda hubung.",
  )
  .transform((value) => value.toUpperCase());

/*
  Bentuk bidang, dipisahkan dari aturan silangnya.

  Pemisahan ini yang memungkinkan pembuatan dan penyuntingan memakai bidang yang sama tanpa
  menggandakan daftar kolomnya.
*/
const potonganFields = {
  discount_type: discountTypeSchema.optional(),
  percent_value: z.number().int().min(1).max(100).nullable().optional(),
  fixed_amount: amountText.nullable().optional(),
};

const cakupanFields = {
  scope: discountScopeSchema.optional(),
  price_ids: z.array(z.string().uuid()).max(500).optional(),
};

const jendelaFields = {
  starts_at: z.string().trim().min(1).nullable().optional(),
  ends_at: z.string().trim().min(1).nullable().optional(),
  starts_at_input: z.string().trim().min(1).nullable().optional(),
  ends_at_input: z.string().trim().min(1).nullable().optional(),
};

type PotonganValue = {
  discount_type?: "percent" | "fixed";
  percent_value?: number | null;
  fixed_amount?: string | null;
};

/*
  Aturan silang potongan.

  Saat membuat, `discount_type` wajib dan nilai yang sesuai harus ada. Saat menyunting, seluruh
  bidang boleh tidak dikirim; tetapi begitu salah satunya dikirim, jenisnya harus ikut dikirim,
  karena mengubah nilai tanpa menyebut jenisnya dapat menghasilkan kombinasi yang bertentangan
  dengan baris yang tersimpan.
*/
function periksaPotongan(
  value: PotonganValue,
  ctx: z.RefinementCtx,
  options: { wajib: boolean },
): void {
  const { wajib } = options;
  const jenisDikirim = value.discount_type !== undefined;
  const nilaiDikirim =
    value.percent_value !== undefined || value.fixed_amount !== undefined;

  if (!jenisDikirim) {
    if (wajib) {
      ctx.addIssue({
        code: "custom",
        path: ["discount_type"],
        message: "Jenis potongan wajib dipilih.",
      });
      return;
    }
    if (nilaiDikirim) {
      ctx.addIssue({
        code: "custom",
        path: ["discount_type"],
        message: "Sertakan jenis potongan bersama nilainya, supaya tidak bertentangan dengan yang tersimpan.",
      });
    }
    return;
  }

  if (value.discount_type === "percent") {
    if (value.percent_value === null || value.percent_value === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["percent_value"],
        message: "Besar persentase wajib diisi.",
      });
    }
    if (value.fixed_amount !== null && value.fixed_amount !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["fixed_amount"],
        message: "Potongan persentase tidak memakai nominal tetap. Kosongkan nominalnya.",
      });
    }
    return;
  }

  if (value.fixed_amount === null || value.fixed_amount === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["fixed_amount"],
      message: "Nominal potongan wajib diisi.",
    });
  }
  if (value.percent_value !== null && value.percent_value !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["percent_value"],
      message: "Potongan nominal tetap tidak memakai persentase. Kosongkan persentasenya.",
    });
  }
}

/*
  Aturan silang cakupan.

  Saat menyunting, `price_ids` boleh tidak dikirim, yang berarti daftar harga yang tersimpan
  dibiarkan apa adanya. Yang tidak boleh adalah mengirim cakupan baru dengan daftar yang tidak cocok.
*/
function periksaCakupan(
  value: { scope?: "all_prices" | "selected_prices"; price_ids?: string[] },
  ctx: z.RefinementCtx,
  options: { wajib: boolean },
): void {
  const { wajib } = options;

  if (value.scope === undefined) {
    if (wajib) {
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Cakupan potongan wajib dipilih.",
      });
    }
    return;
  }

  if (value.scope === "all_prices") {
    if (value.price_ids && value.price_ids.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["price_ids"],
        message:
          "Cakupan semua paket tidak memakai daftar harga terpilih. Ubah cakupannya bila hanya " +
          "sebagian paket yang ingin didiskon.",
      });
    }
    return;
  }

  if (value.price_ids !== undefined && value.price_ids.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["price_ids"],
      message: "Pilih minimal satu harga paket untuk cakupan ini.",
    });
  }
  if (wajib && value.price_ids === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["price_ids"],
      message: "Pilih minimal satu harga paket untuk cakupan ini.",
    });
  }
}

/*
  Aturan silang jendela waktu.

  Dua jenis masukan diterima untuk hal yang sama: `starts_at`/`ends_at` yang sudah ISO, atau
  `starts_at_input`/`ends_at_input` dari formulir. Bentuk kedua dipakai formulir karena kolom
  datetime-local mengirim "2026-09-14T09:30" tanpa keterangan zona, dan waktunya harus dibaca
  sebagai waktu setempat. Letak zona waktunya diatur di `discount-input.ts`, sesaat sebelum nilainya
  dikirim ke database.
*/
function periksaJendela(
  value: {
    starts_at?: string | null;
    ends_at?: string | null;
    starts_at_input?: string | null;
    ends_at_input?: string | null;
  },
  ctx: z.RefinementCtx,
  options: { wajib: boolean },
): void {
  const mulai = value.starts_at ?? value.starts_at_input ?? null;
  const selesai = value.ends_at ?? value.ends_at_input ?? null;

  if (mulai === null && options.wajib) {
    ctx.addIssue({
      code: "custom",
      path: ["starts_at_input", "starts_at"],
      message: "Waktu mulai wajib diisi.",
    });
  }
  if (selesai === null && options.wajib) {
    ctx.addIssue({
      code: "custom",
      path: ["ends_at_input", "ends_at"],
      message: "Waktu berakhir wajib diisi, supaya potongannya tidak berlaku selamanya.",
    });
  }
  if (mulai !== null && selesai !== null && Date.parse(selesai) <= Date.parse(mulai)) {
    ctx.addIssue({
      code: "custom",
      path: ["ends_at_input", "ends_at"],
      message: "Waktu berakhir harus setelah waktu mulai.",
    });
  }
}

/*
  Voucher yang dibuat.

  `starts_at` boleh kosong dan berarti berlaku sejak dibuat; `ends_at` boleh kosong dan berarti tidak
  kedaluwarsa. Keduanya berbeda dari flash sale yang jendelanya wajib, karena voucher baru berguna
  saat pelanggan mengetik kodenya.
*/
export const voucherCreateSchema = z
  .object({
    ...potonganFields,
    ...cakupanFields,
    ...jendelaFields,
    code: codeSchema,
    name: z.string().trim().min(1, "Nama voucher wajib diisi.").max(NAMA_MAKS),
    description: z.string().trim().max(DESKRIPSI_MAKS).nullable().optional(),
    max_redemptions: z.number().int().min(1).nullable().optional(),
    max_redemptions_per_customer: z.number().int().min(1).max(100).nullable().optional(),
    min_amount: amountText.nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    periksaPotongan(value, ctx, { wajib: true });
    periksaCakupan(value, ctx, { wajib: true });
    periksaJendela(value, ctx, { wajib: false });

    const total = value.max_redemptions ?? null;
    const perPelanggan = value.max_redemptions_per_customer ?? null;
    if (total !== null && perPelanggan !== null && perPelanggan > total) {
      ctx.addIssue({
        code: "custom",
        path: ["max_redemptions_per_customer"],
        message: "Batas per pelanggan tidak boleh melebihi kuota total.",
      });
    }
  });

/*
  Voucher yang disunting.

  `code` sengaja tidak ada di sini. Kode adalah yang diketik pelanggan dan yang tercatat pada riwayat
  pemakaian; mengubahnya berarti kode lama berhenti bekerja sementara catatan pemakaian lama menunjuk
  pada kode yang tidak lagi ada. Karena itu kode tidak dapat diubah, dan ketiadaannya di skema ini
  membuat permintaan yang mencoba mengubahnya tidak berpengaruh, bukan gagal dengan pesan yang
  membingungkan.
*/
export const voucherUpdateSchema = z
  .object({
    ...potonganFields,
    ...cakupanFields,
    ...jendelaFields,
    name: z.string().trim().min(1, "Nama voucher wajib diisi.").max(NAMA_MAKS).optional(),
    description: z.string().trim().max(DESKRIPSI_MAKS).nullable().optional(),
    max_redemptions: z.number().int().min(1).nullable().optional(),
    max_redemptions_per_customer: z.number().int().min(1).max(100).nullable().optional(),
    min_amount: amountText.nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    periksaPotongan(value, ctx, { wajib: false });
    periksaCakupan(value, ctx, { wajib: false });
    periksaJendela(value, ctx, { wajib: false });

    const total = value.max_redemptions ?? null;
    const perPelanggan = value.max_redemptions_per_customer ?? null;
    if (total !== null && perPelanggan !== null && perPelanggan > total) {
      ctx.addIssue({
        code: "custom",
        path: ["max_redemptions_per_customer"],
        message: "Batas per pelanggan tidak boleh melebihi kuota total.",
      });
    }
  });

/*
  Flash sale yang dibuat.

  Paket diterima sebagai daftar, bukan satu nilai, karena "semua paket kena flash sale" adalah hal
  yang wajar diminta operator. Di database satu baris tetap terikat pada satu paket, dan daftar ini
  diterjemahkan menjadi beberapa baris dalam satu transaksi. Membiarkannya satu nilai akan memaksa
  klien mengirim beberapa permintaan, dan promo yang gagal di tengah jalan akan meninggalkan
  sebagian paket terdiskon tanpa cara membatalkannya.

  Jendela waktunya wajib lengkap. Tanpa batas akhir, "flash sale" berubah menjadi harga normal yang
  tidak pernah berakhir, dan potongan yang tidak pernah ditutup adalah kesalahan termahal di modul
  ini.
*/
export const flashSaleCreateSchema = z
  .object({
    ...potonganFields,
    ...cakupanFields,
    ...jendelaFields,
    plan_ids: z
      .array(z.string().uuid())
      .min(1, "Pilih minimal satu paket yang kena flash sale.")
      .max(200),
    name: z.string().trim().max(NAMA_MAKS).optional(),
    description: z.string().trim().max(DESKRIPSI_MAKS).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    periksaPotongan(value, ctx, { wajib: true });
    periksaCakupan(value, ctx, { wajib: true });
    periksaJendela(value, ctx, { wajib: true });

    /*
      Paket yang sama tidak boleh muncul dua kali dalam satu permintaan. Bila lolos, dua baris dengan
      paket dan jendela waktu yang sama akan bertabrakan sendiri di trigger bentrok, dan pesan yang
      muncul menyebut nama flash sale yang baru saja dibuat.
    */
    const unik = new Set(value.plan_ids);
    if (unik.size !== value.plan_ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["plan_ids"],
        message: "Ada paket yang terpilih lebih dari sekali.",
      });
    }
  });

export const flashSaleUpdateSchema = z
  .object({
    ...potonganFields,
    ...cakupanFields,
    ...jendelaFields,
    name: z.string().trim().max(NAMA_MAKS).optional(),
    description: z.string().trim().max(DESKRIPSI_MAKS).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    periksaPotongan(value, ctx, { wajib: false });
    periksaCakupan(value, ctx, { wajib: false });
    periksaJendela(value, ctx, { wajib: false });
  });

/*
  Filter daftar.

  `is_active` datang sebagai teks dari query string, jadi diubah menjadi boolean di sini. Nilai
  kosong tidak ikut dikirim oleh `parseSearchParams`, sehingga "tidak difilter" dan "difilter false"
  tetap dapat dibedakan.
*/
export const voucherQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  state: discountStateSchema.optional(),
  scope: discountScopeSchema.optional(),
  is_active: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
});

export const flashSaleQuerySchema = voucherQuerySchema.extend({
  plan_id: z.string().uuid().optional(),
});

/*
  Pemeriksaan kode voucher tanpa menyimpan apa pun.

  Dipakai saat pelanggan mengetik kode di checkout: hasilnya menyebut apakah kodenya berlaku, dan
  bila tidak, bagian mana yang menghalangi. Endpoint checkout belum ada di repo ini, jadi untuk
  sekarang yang memakainya adalah layar uji di halaman voucher.
*/
export const voucherCheckSchema = z.object({
  code: z.string().trim().min(1, "Kode wajib diisi.").max(KODE_MAKS),
  customer_id: z.string().uuid().nullable().optional(),
  /* Bila diisi, hanya harga ini yang dihitung. Bila kosong, seluruh harga paket dihitung. */
  plan_price_id: z.string().uuid().nullable().optional(),
});

export type VoucherCreateInput = z.infer<typeof voucherCreateSchema>;
export type VoucherUpdateInput = z.infer<typeof voucherUpdateSchema>;
export type FlashSaleCreateInput = z.infer<typeof flashSaleCreateSchema>;
export type FlashSaleUpdateInput = z.infer<typeof flashSaleUpdateSchema>;
export type VoucherQuery = z.infer<typeof voucherQuerySchema>;
export type FlashSaleQuery = z.infer<typeof flashSaleQuerySchema>;
export type VoucherCheckInput = z.infer<typeof voucherCheckSchema>;

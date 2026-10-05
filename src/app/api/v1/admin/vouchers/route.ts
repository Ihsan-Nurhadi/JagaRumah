/*
  Daftar dan pembuatan kode voucher.

  Dua hal yang menentukan bentuk endpoint ini:

  1. Ringkasan dihitung dari seluruh tabel, bukan dari halaman yang sedang terbuka. Angka "3 sedang
     berjalan" harus berarti tiga di seluruh data, sama saat pengguna berada di halaman 1 maupun
     halaman 5.

  2. Filter keadaan (berjalan, menunggu waktu, kedaluwarsa, dimatikan) disaring di database. Bila
     disaring setelah halaman diambil, halaman akan berisi lebih sedikit baris daripada yang diminta
     sambil tetap mengirim cursor lanjutan, dan baris di antara dua halaman itu tidak pernah terlihat.
*/
import { query, queryOne, withTransaction } from "@/lib/server/db";
import { operatorFacingError, replaceVoucherPrices, resolveWindow } from "@/lib/server/discount-input";
import {
  VOUCHER_SELECT,
  readVoucher,
  voucherFilterConditions,
  voucherPayload,
  voucherPriceCounts,
  voucherRedemptionCounts,
  voucherSummary,
  type VoucherListRow,
} from "@/lib/server/discounts";
import { AppError, validationError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson, parseSearchParams } from "@/lib/server/parse";
import {
  buildPage,
  keysetCondition,
  orderBy,
  parsePageRequest,
  type SortAllowlist,
} from "@/lib/server/pagination";
import { created, listed } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { voucherCreateSchema, voucherQuerySchema } from "@/lib/schemas/admin-discount";

/*
  Kolom yang boleh dipakai untuk mengurutkan. Nama yang dipakai API sengaja dipisahkan dari nama
  kolom database supaya klien tidak dapat menebak isi skema, dan supaya nama kolom bisa berubah
  tanpa mematahkan pemanggil.

  Sortir berdasarkan jumlah pemakaian tidak disediakan: angka itu dibaca dari tabel catatan
  pemakaian, bukan dari kolom tabel voucher, jadi mengurutkannya menuntut kueri yang berbeda dan itu
  belum dibutuhkan.
*/
const SORT: SortAllowlist = {
  created_at: { column: "v.created_at", defaultDirection: "desc" },
  code: { column: "v.code", defaultDirection: "asc" },
  name: { column: "v.name", defaultDirection: "asc" },
  starts_at: { column: "v.starts_at", defaultDirection: "desc" },
  ends_at: { column: "v.ends_at", defaultDirection: "desc" },
};

export const GET = routeHandler("admin.vouchers.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.read");

  const url = new URL(request.url);
  const filter = parseSearchParams(url.searchParams, voucherQuerySchema);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const params: unknown[] = [];
  const filterSql = voucherFilterConditions(
    { q: filter.q, isActive: filter.is_active, state: filter.state, scope: filter.scope },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  const rows = await query<VoucherListRow>(
    `SELECT ${VOUCHER_SELECT},
            v.created_at::text AS cursor_value
     FROM discount_vouchers v
     WHERE true
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);

  /*
    Jumlah harga terpilih dan jumlah pemakaian dibaca lewat kueri yang meminta banyak id sekaligus.
    Membacanya per baris akan menjadi N+1 kueri untuk satu halaman.
  */
  const ids = items.map((row) => row.id);
  const [priceCounts, redemptionCounts, summary] = await Promise.all([
    voucherPriceCounts(ids),
    voucherRedemptionCounts(ids),
    voucherSummary(),
  ]);

  return listed(
    {
      vouchers: items.map((row) =>
        voucherPayload(row, {
          price_count: priceCounts.get(row.id) ?? 0,
          redemption_count: redemptionCounts.get(row.id) ?? 0,
        }),
      ),
      summary: {
        total: summary?.total ?? 0,
        running: summary?.running ?? 0,
        scheduled: summary?.scheduled ?? 0,
        ended: summary?.ended ?? 0,
        exhausted: summary?.exhausted ?? 0,
        inactive: summary?.inactive ?? 0,
        redemptions: summary?.redemptions ?? 0,
      },
    },
    pagination,
    requestId,
  );
});

export const POST = routeHandler("admin.vouchers.create", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.manage");
  await requireCsrf(request);

  const body = await parseJson(request, voucherCreateSchema);
  const { startsAt, endsAt } = resolveWindow(body, { requireEndsAt: false });

  /*
    Kode diperiksa lebih dulu dengan pesan yang menyebut kodenya langsung. Batasan unik di database
    tetap ada sebagai penjaga terakhir, tetapi galat pelanggaran constraint tidak menyebut kode mana
    yang bertabrakan sehingga tidak dapat ditindaklanjuti operator.
  */
  const existing = await queryOne<{ id: string }>(
    "SELECT id FROM discount_vouchers WHERE code = $1",
    [body.code],
  );
  if (existing) {
    throw validationError({
      code: `Kode "${body.code}" sudah dipakai voucher lain. Pakai kode yang berbeda.`,
    });
  }

  const priceIds = body.scope === "selected_prices" ? (body.price_ids ?? []) : [];

  const voucherId = await withTransaction(async (client) => {
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO discount_vouchers
         (code, name, description, discount_type, percent_value, fixed_amount, scope,
          starts_at, ends_at, max_redemptions, max_redemptions_per_customer, min_amount,
          is_active, created_by_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12::numeric, $13, $14)
       RETURNING id`,
      [
        body.code,
        body.name,
        body.description?.length ? body.description : null,
        body.discount_type,
        body.discount_type === "percent" ? (body.percent_value ?? null) : null,
        body.discount_type === "fixed" ? (body.fixed_amount ?? null) : null,
        body.scope,
        startsAt,
        endsAt,
        body.max_redemptions ?? null,
        body.max_redemptions_per_customer ?? 1,
        body.min_amount ?? null,
        body.is_active ?? true,
        admin.identity.id,
      ],
      client,
    );

    if (!inserted) {
      throw new AppError({
        code: "INTERNAL_ERROR",
        message: "Voucher gagal disimpan. Coba lagi sebentar lagi.",
      });
    }

    await replaceVoucherPrices(client, inserted.id, priceIds);
    return inserted.id;
  }).catch((error: unknown) => {
    /* Pesan dari trigger cakupan diteruskan apa adanya; pesan constraint bawaan tidak. */
    throw operatorFacingError(error) ?? error;
  });

  return created(await readVoucher(voucherId), requestId);
});

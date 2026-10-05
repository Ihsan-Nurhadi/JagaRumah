/*
  Daftar dan pembuatan flash sale paket.

  Bentuk endpoint ini mengikuti satu kenyataan di database: satu baris flash sale terikat pada satu
  paket. Yang membuatnya penting adalah permintaan "semua paket kena flash sale". Permintaan itu
  diterjemahkan menjadi beberapa baris dalam satu transaksi, bukan menjadi satu baris ajaib yang
  mengaku berlaku untuk semua paket.

  Alasannya bukan sekadar mengikuti skema. Aturan bentrok jendela waktu di database bekerja per
  paket, jadi satu baris yang berlaku untuk semua paket tidak dapat diperiksa bentroknya terhadap
  flash sale lain pada paket yang sama. Selain itu, transaksi tunggal membuat seluruh paket berubah
  bersama: bila satu paket ditolak trigger, tidak ada paket yang tertinggal dalam keadaan terdiskon
  setengah jalan.

  Cakupan `selected_prices` pada flash sale berarti sebagian harga dari paket yang ditunjuk, misalnya
  hanya harga bulanan, bukan harga tahunan.
*/
import { query, queryOne, withTransaction } from "@/lib/server/db";
import {
  operatorFacingError,
  replaceFlashSalePrices,
  resolveWindow,
} from "@/lib/server/discount-input";
import {
  FLASH_SALE_SELECT,
  flashSaleFilterConditions,
  flashSalePayload,
  flashSalePriceCounts,
  flashSaleSummary,
  readFlashSale,
  type FlashSaleListRow,
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
import { flashSaleCreateSchema, flashSaleQuerySchema } from "@/lib/schemas/admin-discount";

const SORT: SortAllowlist = {
  created_at: { column: "f.created_at", defaultDirection: "desc" },
  starts_at: { column: "f.starts_at", defaultDirection: "desc" },
  ends_at: { column: "f.ends_at", defaultDirection: "asc" },
  name: { column: "f.name", defaultDirection: "asc" },
};

export const GET = routeHandler("admin.flash_sales.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.read");

  const url = new URL(request.url);
  const filter = parseSearchParams(url.searchParams, flashSaleQuerySchema);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const params: unknown[] = [];
  const filterSql = flashSaleFilterConditions(
    {
      q: filter.q,
      isActive: filter.is_active,
      state: filter.state,
      scope: filter.scope,
      planId: filter.plan_id,
    },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  const rows = await query<FlashSaleListRow>(
    `SELECT ${FLASH_SALE_SELECT},
            f.created_at::text AS cursor_value
     FROM plan_flash_sales f
     JOIN subscription_plans p ON p.id = f.plan_id
     WHERE true
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);

  const ids = items.map((row) => row.id);
  const [priceCounts, summary] = await Promise.all([flashSalePriceCounts(ids), flashSaleSummary()]);

  return listed(
    {
      flash_sales: items.map((row) =>
        flashSalePayload(row, { price_count: priceCounts.get(row.id) ?? 0 }),
      ),
      summary: {
        total: summary?.total ?? 0,
        running: summary?.running ?? 0,
        scheduled: summary?.scheduled ?? 0,
        ended: summary?.ended ?? 0,
        inactive: summary?.inactive ?? 0,
        selected_prices: summary?.selected_prices ?? 0,
        plan_count: summary?.plan_count ?? 0,
      },
    },
    pagination,
    requestId,
  );
});

export const POST = routeHandler("admin.flash_sales.create", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.manage");
  await requireCsrf(request);

  const body = await parseJson(request, flashSaleCreateSchema);
  const { startsAt, endsAt } = resolveWindow(body, { requireEndsAt: true });

  /*
    Jendela waktu wajib, jadi nilainya tidak boleh kosong. Pemeriksaan ganda ini bukan sekadar
    kehati-hatian: kolomnya `NOT NULL` di database, dan galat dari sana berbentuk pelanggaran
    constraint yang tidak dapat dibaca operator.
  */
  if (startsAt === null || endsAt === null) {
    throw validationError({
      starts_at_input: "Waktu mulai dan waktu berakhir wajib diisi untuk flash sale.",
    });
  }

  /*
    Paket diperiksa lebih dulu supaya pesannya menyebut paket mana yang tidak ditemukan, bukan
    menghasilkan galat foreign key yang hanya menyebut nama constraint.
  */
  const ditemukan = await query<{ id: string }>(
    "SELECT id FROM subscription_plans WHERE id = ANY($1::uuid[])",
    [body.plan_ids],
  );
  const ada = new Set(ditemukan.map((row) => row.id));
  const hilang = body.plan_ids.filter((id) => !ada.has(id));

  if (hilang.length > 0) {
    throw validationError({
      plan_ids: `Paket yang dipilih tidak ditemukan (${hilang.length} paket). Muat ulang halaman lalu pilih kembali.`,
    });
  }

  /*
    Seluruh baris dibuat dalam satu transaksi supaya tidak ada paket yang tertinggal terdiskon
    setengah jalan bila salah satu paket ditolak trigger bentrok jendela waktu.
  */
  const dibuat = await withTransaction(async (client) => {
    const ids: string[] = [];

    for (const planId of body.plan_ids) {
      const inserted = await queryOne<{ id: string }>(
        `INSERT INTO plan_flash_sales
           (plan_id, name, description, discount_type, percent_value, fixed_amount, scope,
            starts_at, ends_at, is_active, created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          planId,
          body.name?.length ? body.name : "Flash sale",
          body.description?.length ? body.description : null,
          body.discount_type,
          body.discount_type === "percent" ? (body.percent_value ?? null) : null,
          body.discount_type === "fixed" ? (body.fixed_amount ?? null) : null,
          body.scope,
          startsAt,
          endsAt,
          body.is_active ?? true,
          admin.identity.id,
        ],
        client,
      );

      if (!inserted) {
        throw new AppError({
          code: "INTERNAL_ERROR",
          message: "Flash sale gagal disimpan. Coba lagi sebentar lagi.",
        });
      }

      ids.push(inserted.id);
    }

    /*
      Daftar harga terpilih dipasang setelah seluruh barisnya ada.

      Bila cakupannya `selected_prices`, setiap baris hanya menerima harga dari paketnya sendiri.
      Harga paket lain akan melanggar arti cakupannya, dan itu juga yang membuat pemeriksaan bentrok
      di database bekerja seperti yang dimaksud.

      Pemetaan harga ke paketnya dibaca sekali untuk semua harga yang dipilih, bukan per baris flash
      sale, supaya jumlah kuerinya tidak tumbuh bersama jumlah paket.
    */
    if (body.scope === "selected_prices") {
      const hargaTerpilih = body.price_ids ?? [];
      const harga = hargaTerpilih.length
        ? await query<{ id: string; plan_id: string }>(
            "SELECT id, plan_id FROM plan_prices WHERE id = ANY($1::uuid[])",
            [hargaTerpilih],
            client,
          )
        : [];

      const perPaket = new Map<string, string[]>();
      for (const baris of harga) {
        const daftar = perPaket.get(baris.plan_id) ?? [];
        daftar.push(baris.id);
        perPaket.set(baris.plan_id, daftar);
      }

      const baris = await query<{ id: string; plan_id: string }>(
        "SELECT id, plan_id FROM plan_flash_sales WHERE id = ANY($1::uuid[])",
        [ids],
        client,
      );

      for (const satu of baris) {
        await replaceFlashSalePrices(client, satu.id, perPaket.get(satu.plan_id) ?? []);
      }
    }

    return ids;
  }).catch((error: unknown) => {
    throw operatorFacingError(error) ?? error;
  });

  return created(
    { flash_sales: await Promise.all(dibuat.map((id) => readFlashSale(id))), count: dibuat.length },
    requestId,
  );
});

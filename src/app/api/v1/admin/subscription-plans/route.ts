/*
  Daftar dan pembuatan paket.

  Daftar ini memuat seluruh paket, termasuk yang tidak aktif, karena konsol dipakai untuk mengurus
  paket yang sedang tidak ditawarkan. Yang aktif saja akan membuat paket yang baru dinonaktifkan
  hilang dari layar, dan pertanyaan "tadi paketnya ke mana" tidak bisa dijawab dari halaman ini.

  Setiap paket dikirim bersama seluruh baris harganya, termasuk harga yang tidak aktif. Harga
  dibaca sekali untuk satu halaman, bukan satu kueri per paket, karena jumlah paket pada satu
  halaman bisa dua puluh dan itu berarti dua puluh perjalanan ke database.
*/
import { writeAudit } from "@/lib/server/audit";
import { query, queryOne, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import {
  buildPage,
  keysetCondition,
  orderBy,
  parsePageRequest,
  type SortAllowlist,
} from "@/lib/server/pagination";
import {
  nextSortOrder,
  planFilterConditions,
  planPayload,
  planPrices,
  planSummary,
  type PlanListRow,
} from "@/lib/server/plans";
import { created, listed } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import {
  createPlanSchema,
  normalizeDeviceLimit,
  normalizeSortOrder,
} from "@/lib/schemas/admin-plan";

/*
  Allowlist sortir. Kolom di luar daftar ini tidak bisa dipakai mengurutkan, dan itu sekaligus
  menutup jalan menyisipkan nama kolom sembarang lewat parameter.
*/
const SORT: SortAllowlist = {
  sort_order: { column: "p.sort_order", defaultDirection: "asc" },
  code: { column: "p.code", defaultDirection: "asc" },
  name: { column: "p.name", defaultDirection: "asc" },
  created_at: { column: "p.created_at", defaultDirection: "desc" },
};

export const GET = routeHandler("admin.subscription_plans.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "plan.read");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "sort_order");

  const isActiveParam = url.searchParams.get("is_active");
  if (isActiveParam !== null && isActiveParam !== "true" && isActiveParam !== "false") {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: 'Parameter is_active harus bernilai "true" atau "false".',
      details: { is_active: isActiveParam, allowed: ["true", "false"] },
    });
  }

  const filter = {
    q: url.searchParams.get("q")?.trim() || undefined,
    isActive: isActiveParam === null ? undefined : isActiveParam === "true",
  };

  const params: unknown[] = [];
  /*
    Filter dijalankan sebelum keyset, dan urutan push parameternya harus sama dengan urutan
    kemunculan $n di dalam SQL. Karena itu keduanya disusun berurutan di sini.
  */
  const filterSql = planFilterConditions(filter, params);
  const keysetSql = keysetCondition(page, params);

  /*
    Cursor berisi nilai kolom sortir, jadi bentuk teksnya harus mengikuti kolom yang dipakai
    mengurutkan. Kalau cursornya selalu tanggal, halaman berikutnya pada urutan sort_order akan
    membandingkan teks tanggal dengan kolom angka dan kuerinya gagal, bukan sekadar salah urutan.
    Nama kolomnya diambil dari allowlist, jadi tidak ada nama yang datang dari klien.
  */
  const cursorExpression = `p.${page.sortField}::text`;

  const rows = await query<PlanListRow>(
    `SELECT p.id,
            ${cursorExpression} AS cursor_value,
            p.code,
            p.name,
            p.description,
            p.device_limit,
            p.is_free,
            p.is_active,
            p.sort_order,
            (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id)
              AS subscription_count,
            p.created_at,
            p.updated_at
     FROM subscription_plans p
     WHERE true
           ${filterSql}
           ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);

  const [prices, summary, sortOrder] = await Promise.all([
    planPrices(items.map((row) => row.id)),
    planSummary(),
    nextSortOrder(),
  ]);

  return listed(
    {
      plans: items.map((row) =>
        planPayload(
          row,
          prices.filter((price) => price.plan_id === row.id),
        ),
      ),
      summary: {
        total: summary?.total ?? 0,
        active: summary?.active ?? 0,
        inactive: summary?.inactive ?? 0,
        unlimited_device_limit: summary?.unlimited_device_limit ?? 0,
        without_active_price: summary?.without_active_price ?? 0,
        price_total: summary?.price_total ?? 0,
        price_in_use: summary?.price_in_use ?? 0,
      },
      /*
        Urutan berikutnya dikirim server supaya formulir paket baru tidak meminta operator
        menebak angka urutan. Nilai ini dihitung dari data, bukan ditetapkan di klien.
      */
      next_sort_order: sortOrder,
      filters: {
        q: filter.q ?? null,
        is_active: filter.isActive ?? null,
      },
    },
    pagination,
    requestId,
  );
});

export const POST = routeHandler("admin.subscription_plans.create", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "plan.manage");
  await requireCsrf(request);

  const input = await parseJson(request, createPlanSchema);
  /*
    Kolom angka masih berbentuk teks di sini, karena formulir mengirim apa yang diketik operator.
    Perubahannya dilakukan sekali di depan, supaya nilai yang tersimpan, yang diaudit, dan yang
    dikembalikan ke klien adalah nilai yang sama.
  */
  const deviceLimit = normalizeDeviceLimit(input.device_limit);
  const sortOrder = normalizeSortOrder(input.sort_order);

  const result = await withTransaction(async (client) => {
    /*
      Kode paket diperiksa lebih dulu supaya pesannya menyebut paket yang sudah memakainya.
      Batasan UNIQUE di database tetap menjadi penjaga terakhir, karena pemeriksaan di sini bisa
      dilewati dua permintaan serentak.
    */
    const existing = await queryOne<{ name: string }>(
      "SELECT name FROM subscription_plans WHERE code = $1",
      [input.code],
      client,
    );
    if (existing) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message:
          `Kode paket "${input.code}" sudah dipakai paket ${existing.name}. Pakai kode lain, ` +
          `misalnya dengan menambahkan pembeda di belakangnya.`,
        details: { fields: { code: `Kode "${input.code}" sudah dipakai paket ${existing.name}.` } },
      });
    }

    const inserted = await queryOne<{ id: string; created_at: Date; updated_at: Date }>(
      `INSERT INTO subscription_plans
         (code, name, description, device_limit, is_free, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at, updated_at`,
      [
        input.code,
        input.name,
        input.description ?? null,
        deviceLimit,
        input.is_free,
        input.is_active,
        sortOrder,
      ],
      client,
    );
    if (!inserted) throw new Error("Penyisipan paket tidak mengembalikan baris.");

    /*
      Jejak audit ditulis di dalam transaksi yang sama. Kalau transaksinya dibatalkan, catatan
      paket yang tidak pernah ada tidak boleh tertinggal.
    */
    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "plan.create",
      entityType: "subscription_plan",
      entityId: inserted.id,
      newData: {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        device_limit: deviceLimit,
        is_free: input.is_free,
        is_active: input.is_active,
        sort_order: sortOrder,
      },
    });

    return inserted;
  });

  return created(
    {
      plan: {
        id: result.id,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        device_limit: deviceLimit,
        device_limit_unlimited: deviceLimit === null,
        is_free: input.is_free,
        is_active: input.is_active,
        sort_order: sortOrder,
        subscription_count: 0,
        has_active_price: false,
        prices: [],
        created_at: result.created_at.toISOString(),
        updated_at: result.updated_at.toISOString(),
      },
    },
    requestId,
  );
});

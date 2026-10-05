/*
  Daftar dan pembuatan harga paket.

  Harga dipisahkan dari paket sebagai sumber daya tersendiri karena satu paket dapat punya harga
  bulanan dan harga tahunan sekaligus, dan keduanya punya masa berlaku sendiri.

  Yang perlu diketahui sebelum menambah harga: satu paket hanya menyimpan satu baris harga per
  interval tagihan. Batasan itu ada di database, dan akibatnya harga tidak dapat diganti dengan
  menambah baris baru selama baris lama untuk interval yang sama masih ada. Harga untuk interval
  yang sudah terisi diubah dari baris yang sudah ada.
*/
import { writeAudit } from "@/lib/server/audit";
import { query, queryOne, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import {
  buildPage,
  keysetCondition,
  orderBy,
  parsePageRequest,
  type SortAllowlist,
} from "@/lib/server/pagination";
import { parseJson } from "@/lib/server/parse";
import {
  BILLING_INTERVALS,
  INTERVAL_LABELS,
  priceFilterConditions,
  priceSummary,
  type PriceListRow,
} from "@/lib/server/plans";
import { created, listed, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { createPriceSchema, normalizeAmount } from "@/lib/schemas/admin-plan";

/*
  Allowlist sortir. Kolom `amount` diarahkan ke salinan numeriknya, bukan ke teksnya, karena
  mengurutkan nominal sebagai teks menempatkan "9000" di atas "100000".
*/
const SORT: SortAllowlist = {
  created_at: { column: "created_at", defaultDirection: "desc" },
  amount: { column: "amount_value", defaultDirection: "asc" },
  billing_interval: { column: "billing_interval", defaultDirection: "asc" },
};

export const GET = routeHandler("admin.plan_prices.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "plan.read");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const planIdParam = url.searchParams.get("plan_id");
  const planId = planIdParam ? requireUuid(planIdParam, "plan_id") : undefined;

  const intervalParam = url.searchParams.get("billing_interval");
  if (
    intervalParam &&
    !BILLING_INTERVALS.includes(intervalParam as (typeof BILLING_INTERVALS)[number])
  ) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message:
        `Interval "${intervalParam}" tidak dikenal. Pilihan yang tersedia: ` +
        `${BILLING_INTERVALS.join(", ")}.`,
      details: { billing_interval: intervalParam, allowed: BILLING_INTERVALS },
    });
  }

  const isActiveParam = url.searchParams.get("is_active");
  if (isActiveParam !== null && isActiveParam !== "true" && isActiveParam !== "false") {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: 'Parameter is_active harus bernilai "true" atau "false".',
      details: { is_active: isActiveParam, allowed: ["true", "false"] },
    });
  }

  const filter = {
    planId,
    billingInterval: intervalParam ?? undefined,
    isActive: isActiveParam === null ? undefined : isActiveParam === "true",
  };

  const params: unknown[] = [];
  const filterSql = priceFilterConditions(filter, params);
  const keysetSql = keysetCondition(page, params);

  /*
    Cursor berisi nilai kolom sortir, jadi bentuk teksnya harus mengikuti kolom yang dipakai
    mengurutkan. Kalau cursornya selalu tanggal, halaman berikutnya akan membandingkan teks
    tanggal dengan kolom interval dan kuerinya gagal, bukan sekadar salah urutan.
  */
  const cursorExpression =
    page.sortField === "created_at" ? "pr.created_at::text" : `pr.${page.sortField}`;

  /*
    Pencarian harga dibungkus satu tabel turunan supaya kueri luarnya hanya punya satu kolom
    bernama `id`. Tanpa itu, syarat keyset yang menyebut `id` tanpa nama tabel menjadi ambigu
    antara plan_prices dan subscription_plans.
  */
  const rows = await query<PriceListRow>(
    `WITH rows AS (
       SELECT pr.id,
              ${cursorExpression} AS cursor_value,
              pr.plan_id,
              pr.billing_interval,
              pr.amount AS amount_value,
              pr.amount::text AS amount,
              pr.currency,
              pr.is_active,
              pr.created_at,
              pr.updated_at,
              p.code AS plan_code,
              p.name AS plan_name,
              (SELECT count(*)::int FROM subscriptions s WHERE s.plan_price_id = pr.id)
                AS subscription_count
       FROM plan_prices pr
       JOIN subscription_plans p ON p.id = pr.plan_id
       WHERE true
             ${filterSql}
     )
     SELECT id, cursor_value, plan_id, billing_interval, amount, currency, is_active,
            created_at, updated_at, plan_code, plan_name, subscription_count
     FROM rows
     WHERE true
           ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const summary = await priceSummary();

  return listed(
    {
      prices: items.map((row) => ({
        id: row.id,
        plan: { id: row.plan_id, code: row.plan_code, name: row.plan_name },
        billing_interval: row.billing_interval,
        amount: row.amount,
        currency: row.currency,
        is_active: row.is_active,
        /* Harga yang sudah dipakai langganan nominalnya terkunci. */
        amount_editable: row.subscription_count === 0,
        subscription_count: row.subscription_count,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      })),
      /*
        Ringkasan dihitung dari seluruh tabel harga, bukan dari hasil filter, dan itu disebutkan
        di halaman supaya angka di kartu ringkasan tidak disangka mengikuti filter yang dipasang.
      */
      summary: {
        total: summary?.total ?? 0,
        active: summary?.active ?? 0,
        inactive: summary?.inactive ?? 0,
        in_use: summary?.in_use ?? 0,
      },
      filters: {
        plan_id: filter.planId ?? null,
        billing_interval: filter.billingInterval ?? null,
        is_active: filter.isActive ?? null,
      },
    },
    pagination,
    requestId,
  );
});

export const POST = routeHandler("admin.plan_prices.create", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "plan.manage");
  await requireCsrf(request);

  const input = await parseJson(request, createPriceSchema);
  /* Nominal dikirim formulir sebagai teks, dan disimpan sebagai desimal dua angka di belakang koma. */
  const amount = normalizeAmount(input.amount);

  const result = await withTransaction(async (client) => {
    /*
      Baris paketnya dikunci lebih dulu. Dua permintaan yang menambahkan harga untuk paket yang
      sama pada saat bersamaan berjalan berurutan, sehingga yang kedua melihat harga yang baru
      saja dibuat yang pertama dan menerima pesan yang benar, bukan galat batasan database.
    */
    const plan = await queryOne<{ id: string; name: string }>(
      "SELECT id, name FROM subscription_plans WHERE id = $1 FOR UPDATE",
      [input.plan_id],
      client,
    );
    if (!plan) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message:
          "Paket itu tidak ada, jadi harganya tidak dapat ditambahkan. Kembali ke daftar paket " +
          "dan periksa paket yang dimaksud.",
      });
    }

    const existing = await queryOne<{ id: string; amount: string; is_active: boolean }>(
      `SELECT id, amount::text AS amount, is_active
       FROM plan_prices WHERE plan_id = $1 AND billing_interval = $2`,
      [input.plan_id, input.billing_interval],
      client,
    );
    if (existing) {
      throw new AppError({
        code: "PLAN_PRICE_INVALID",
        message:
          `Paket ${plan.name} sudah punya harga ${INTERVAL_LABELS[input.billing_interval]}, ` +
          `yaitu ${existing.amount} ${existing.is_active ? "(aktif)" : "(tidak aktif)"}. ` +
          `Satu paket hanya menyimpan satu harga per interval tagihan, jadi harganya diubah ` +
          `dari baris yang sudah ada, bukan dengan menambah baris baru.`,
        details: {
          plan_id: input.plan_id,
          billing_interval: input.billing_interval,
          existing_price_id: existing.id,
        },
      });
    }

    const inserted = await queryOne<{
      id: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO plan_prices (plan_id, billing_interval, amount, is_active)
       VALUES ($1, $2, $3, true)
       RETURNING id, created_at, updated_at`,
      [input.plan_id, input.billing_interval, amount],
      client,
    );
    if (!inserted) throw new Error("Penyisipan harga tidak mengembalikan baris.");

    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "plan_price.create",
      entityType: "plan_price",
      entityId: inserted.id,
      newData: {
        plan_id: input.plan_id,
        plan_name: plan.name,
        billing_interval: input.billing_interval,
        amount,
        is_active: true,
      },
    });

    return inserted;
  });

  return created(
    {
      price: {
        id: result.id,
        plan_id: input.plan_id,
        billing_interval: input.billing_interval,
        amount,
        currency: "IDR",
        is_active: true,
        subscription_count: 0,
        created_at: result.created_at.toISOString(),
        updated_at: result.updated_at.toISOString(),
      },
    },
    requestId,
  );
});

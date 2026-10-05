/*
  Daftar langganan.

  Ringkasan "akan berakhir" adalah alasan utama halaman ini ada. Tim penagihan memakainya untuk
  menemukan langganan yang perlu ditagih ulang sebelum pelanggan kehilangan layanan, dan itu
  lebih berguna daripada sekadar menghitung total langganan.
*/
import { query } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import {
  buildPage,
  keysetCondition,
  orderBy,
  parsePageRequest,
  type SortAllowlist,
} from "@/lib/server/pagination";
import { listed } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import {
  subscriptionFilterConditions,
  subscriptionSummary,
  type SubscriptionListRow,
} from "@/lib/server/subscriptions";

const SORT: SortAllowlist = {
  created_at: { column: "s.created_at", defaultDirection: "desc" },
  current_period_end: { column: "s.current_period_end", defaultDirection: "asc" },
  status: { column: "s.status", defaultDirection: "asc" },
};

const STATUSES = ["trialing", "active", "past_due", "canceled", "expired"] as const;

export const GET = routeHandler("admin.subscriptions.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "subscription.read");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const statusParam = url.searchParams.get("status");
  if (statusParam && !STATUSES.includes(statusParam as (typeof STATUSES)[number])) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: `Status "${statusParam}" tidak dikenal. Pilihan yang tersedia: ${STATUSES.join(", ")}.`,
      details: { status: statusParam, allowed: STATUSES },
    });
  }

  const params: unknown[] = [];
  const filterSql = subscriptionFilterConditions(
    {
      status: statusParam ?? undefined,
      planId: url.searchParams.get("plan_id") ?? undefined,
      customerId: url.searchParams.get("customer_id") ?? undefined,
      q: url.searchParams.get("q")?.trim() || undefined,
    },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  const rows = await query<SubscriptionListRow>(
    `SELECT s.id,
            s.created_at::text AS cursor_value,
            s.status,
            s.started_at,
            s.current_period_start,
            s.current_period_end,
            s.cancel_at_period_end,
            s.canceled_at,
            s.created_at,
            s.customer_id,
            c.full_name AS customer_name,
            c.status AS customer_status,
            s.plan_id,
            p.name AS plan_name,
            p.code AS plan_code,
            p.device_limit,
            p.sort_order,
            (
              SELECT count(*)::int FROM devices d
              WHERE d.customer_id = s.customer_id AND d.status = 'claimed'
            ) AS active_device_count,
            pr.amount::text AS price_amount,
            pr.billing_interval AS price_interval
     FROM subscriptions s
     LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     LEFT JOIN plan_prices pr ON pr.id = s.plan_price_id
     WHERE true
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const summary = await subscriptionSummary();

  return listed(
    {
      subscriptions: items.map((row) => ({
        id: row.id,
        status: row.status,
        customer: { id: row.customer_id, full_name: row.customer_name, status: row.customer_status },
        plan: {
          id: row.plan_id,
          name: row.plan_name,
          code: row.plan_code,
          device_limit: row.device_limit,
          device_limit_unlimited: row.device_limit === null,
        },
        active_device_count: row.active_device_count,
        price_amount: row.price_amount,
        price_interval: row.price_interval,
        started_at: row.started_at?.toISOString() ?? null,
        current_period_start: row.current_period_start?.toISOString() ?? null,
        current_period_end: row.current_period_end?.toISOString() ?? null,
        cancel_at_period_end: row.cancel_at_period_end,
        canceled_at: row.canceled_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
      })),
      summary: {
        total: summary?.total ?? 0,
        active: summary?.active ?? 0,
        past_due: summary?.past_due ?? 0,
        canceled: summary?.canceled ?? 0,
        expired: summary?.expired ?? 0,
        /*
          Langganan tanpa tanggal berakhir, yaitu paket gratis, tidak pernah masuk angka ini.
          Kalau ikut dihitung, seluruh pelanggan gratis akan muncul sebagai akan berakhir.
        */
        ending_soon: summary?.ending_soon ?? 0,
      },
    },
    pagination,
    requestId,
  );
});

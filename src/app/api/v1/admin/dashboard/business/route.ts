/*
  Dashboard bisnis.

  Isinya keadaan pelanggan, langganan, perangkat, dan pendapatan berulang bulanan. Semua angka
  dihitung dari satu potret data yang sama supaya tidak ada dua angka di satu layar yang saling
  bertentangan.

  Rentang tanggal wajib dikirim. Dashboard yang diam-diam memakai "bulan ini" akan membingungkan
  begitu tautannya dibuka ulang keesokan hari, karena angkanya berubah tanpa ada yang mengubah
  apa pun.
*/
import {
  businessMetrics,
  businessSeries,
  subscriptionsByPlan,
} from "@/lib/server/dashboard";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { parseSearchParams } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { dashboardPeriodSchema } from "@/lib/schemas/admin-dashboard";

export const GET = routeHandler("admin.dashboard.business", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "dashboard.read");

  const period = parseSearchParams(new URL(request.url).searchParams, dashboardPeriodSchema);
  const [metrics, byPlan, series] = await Promise.all([
    businessMetrics(period),
    subscriptionsByPlan(),
    businessSeries(period),
  ]);

  return ok(
    {
      customers: metrics?.customers ?? {
        total: 0,
        active: 0,
        suspended: 0,
        new_in_period: 0,
      },
      subscriptions: {
        active: metrics?.subscriptions.active ?? 0,
        expired: metrics?.subscriptions.expired ?? 0,
        canceled: metrics?.subscriptions.canceled ?? 0,
        by_plan: byPlan,
      },
      devices: metrics?.devices ?? {
        in_stock: 0,
        claimed: 0,
        suspended: 0,
        claim_rate_percent: null,
      },
      mrr: metrics
        ? {
            amount: metrics.mrr.amount,
            currency: metrics.mrr.currency,
            as_of: metrics.mrr.as_of.toISOString(),
          }
        : null,
      period: { from: period.from, to: period.to, granularity: period.granularity },
      series: series.map((row) => ({
        bucket: row.bucket,
        new_customers: row.new_customers,
        new_subscriptions: row.new_subscriptions,
        revenue: row.revenue,
      })),
    },
    requestId,
  );
});

/*
  Dashboard keuangan.

  Seluruh angka di sini memakai dasar kas. Pendapatan diakui pada `invoices.paid_at` dengan nilai
  `invoices.amount_paid`, yaitu jumlah tagihan tanpa biaya layanan penyedia.

  Biaya layanan bukan pendapatan. `provider_total_payment` adalah yang dibayar pelanggan dan
  selalu lebih besar, sehingga memakainya akan melebihkan angka dan tidak akan pernah cocok
  dengan mutasi rekening setelah dipotong biaya.
*/
import { financeMetrics, revenueChangePercent } from "@/lib/server/dashboard";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { parseSearchParams } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { dashboardPeriodSchema } from "@/lib/schemas/admin-dashboard";

export const GET = routeHandler("admin.dashboard.finance", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "dashboard.read");

  const period = parseSearchParams(new URL(request.url).searchParams, dashboardPeriodSchema);
  const metrics = await financeMetrics({ from: period.from, to: period.to });

  const inPeriod = metrics?.revenue.in_period ?? "0";
  const previousPeriod = metrics?.revenue.previous_period ?? "0";

  return ok(
    {
      revenue: {
        in_period: inPeriod,
        previous_period: previousPeriod,
        /*
          Perubahan dari periode kosong tidak punya persentase yang bermakna. Dikirim null,
          bukan angka apa pun, supaya layar dapat menyatakan bahwa pembandingnya belum ada
          daripada menampilkan pertumbuhan yang tidak berarti.
        */
        change_percent: revenueChangePercent(inPeriod, previousPeriod),
      },
      receivables: metrics?.receivables ?? {
        open_count: 0,
        open_amount: "0",
        past_due_count: 0,
        past_due_amount: "0",
      },
      refunds: metrics?.refunds ?? { count: 0, amount: "0" },
      payments: metrics?.payments ?? {
        settled_count: 0,
        pending_count: 0,
        failed_count: 0,
        unverified_count: 0,
      },
      period: { from: period.from, to: period.to },
    },
    requestId,
  );
});

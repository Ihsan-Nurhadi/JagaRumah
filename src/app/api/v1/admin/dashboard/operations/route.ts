/*
  Dashboard operasional.

  Jendela waktunya selalu sejak tengah malam hari ini, bukan rentang yang dikirim klien. Tujuan
  halaman ini memantau keadaan sekarang, dan rentang yang bisa diatur akan membuat "hari ini"
  berubah artinya tanpa ada yang menyadarinya.

  Bagian yang paling perlu diperhatikan adalah daftar job. Job rekonsiliasi pembayaran adalah
  pengaman utama integrasi pembayaran: notifikasi penyedia tidak bertanda tangan dan kebijakan
  ulangnya tidak terdokumentasi, sehingga job inilah yang memastikan pembayaran tidak
  menggantung tanpa batas. Job yang berhenti berjalan tidak akan terlihat dari halaman mana pun
  kecuali dinyatakan di sini.
*/
import { operationsMetrics } from "@/lib/server/dashboard";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

export const GET = routeHandler("admin.dashboard.operations", async (_request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "dashboard.read");

  const metrics = await operationsMetrics();

  return ok(
    {
      provider: metrics?.provider ?? {
        inbound_webhook_count: 0,
        inbound_verified_count: 0,
        inbound_rejected_count: 0,
        inbound_unknown_order_count: 0,
        inbound_pending_count: 0,
        outbound_call_count: 0,
        outbound_failed_count: 0,
        outbound_p95_duration_ms: null,
      },
      jobs: (metrics?.jobs ?? []).map((job) => ({
        job_name: job.job_name,
        last_started_at: job.last_started_at?.toISOString() ?? null,
        last_finished_at: job.last_finished_at?.toISOString() ?? null,
        last_outcome: job.last_outcome,
        expected_interval_minutes: job.expected_interval_minutes,
        is_stale: job.is_stale,
        /*
          Job yang mulai tetapi tidak pernah selesai dibedakan dari job yang tertinggal. Yang
          pertama berarti prosesnya mati di tengah jalan, yang kedua berarti penjadwalannya
          berhenti. Penanganannya berbeda, jadi keduanya tidak digabung.
        */
        stuck_running: job.stuck_running,
      })),
      claim_anomalies: metrics?.claim_anomalies ?? {
        flagged_customers: 0,
        flagged_ips: 0,
        failed_attempts: 0,
      },
      admin_sessions: metrics?.admin_sessions ?? { active: 0 },
      period: {
        from: (metrics?.period.from ?? new Date()).toISOString(),
        to: (metrics?.period.to ?? new Date()).toISOString(),
      },
    },
    requestId,
  );
});

/*
  Antrian tindakan.

  Isinya hal-hal yang menunggu keputusan manusia, bukan sekadar hal yang tidak normal. Setiap
  baris memuat alamat yang menuju langsung ke objeknya, sehingga bisa ditindaklanjuti tanpa
  pencarian tambahan di halaman lain.

  Urutannya disengaja. Pembayaran yang belum lolos verifikasi lebih dari lima belas menit ada di
  paling atas karena pelanggan sudah membayar dan belum menerima apa yang dibayarnya. Langganan
  yang akan berakhir ada di paling bawah karena masih ada waktu tiga hari.

  Setiap baris yang punya alamat pasti punya halaman tujuan yang benar-benar ada. Antrian yang
  menautkan ke halaman kosong lebih buruk daripada antrian yang tidak ada, karena membuat
  operator percaya sudah menindaklanjuti padahal belum.
*/
import { actionQueue } from "@/lib/server/dashboard";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

const KINDS = [
  "unverified_payment",
  "unknown_order_webhook",
  "claim_anomaly",
  "past_due_invoice",
  "expiring_subscription",
] as const;

export const GET = routeHandler("admin.action_queue.list", async (_request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "dashboard.read");

  const items = await actionQueue();
  const counts = Object.fromEntries(
    KINDS.map((kind) => [kind, items.filter((item) => item.kind === kind).length]),
  );

  return ok(
    {
      items: items.map((item) => ({
        kind: item.kind,
        severity: item.severity,
        reference_id: item.reference_id,
        reference_label: item.reference_label,
        summary: item.summary,
        occurred_at: item.occurred_at.toISOString(),
        action_label: item.action_label,
        action_href: item.action_href,
      })),
      counts_by_kind: counts,
      /*
        Perbedaan severity dijelaskan di response, bukan hanya di dokumen, supaya artinya ikut
        terbaca oleh siapa pun yang memakai data ini lewat API.
      */
      severity_meaning: {
        high: "Pelanggan sudah membayar atau ada indikasi pemalsuan, perlu ditangani lebih dulu",
        medium: "Perlu ditindaklanjuti hari ini, belum ada pelanggan yang dirugikan",
        low: "Masih ada waktu, perlu disiapkan sebelum tenggatnya tiba",
      },
    },
    requestId,
  );
});

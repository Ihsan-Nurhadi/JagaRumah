/*
  Detail pembayaran.

  Halaman ini menjawab satu pertanyaan yang paling sering muncul: "pelanggan bilang sudah
  membayar, jadi di mana uangnya". Jawabannya ada pada tiga bagian yang dikirim bersama:

  1. Percobaan pembayarannya sendiri, termasuk biaya layanan yang ditambahkan penyedia.
  2. Notifikasi yang masuk dari penyedia. Ini arah masuk.
  3. Panggilan kita ke penyedia. Ini arah keluar, dan panggilan yang gagal sering menjadi
     sebabnya.

  Kalau ketiganya kosong pada satu percobaan, artinya percobaan itu dibuat di sisi kita tetapi
  penyedia tidak pernah memberi kabar apa pun, dan itu sudah cukup untuk menyimpulkan bahwa
  pembayarannya tidak pernah diselesaikan pelanggan.
*/
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { findPayment, providerCalls, webhookEvents } from "@/lib/server/payments";
import { queryOne, query } from "@/lib/server/db";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Params = { params: Promise<{ payment_id?: string }> };

export const GET = routeHandler("admin.payments.detail", async (_request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "payment.read");

  const { payment_id: rawId } = await (context as Params).params;
  const paymentId = requireUuid(rawId, "payment_id");

  const payment = await findPayment(paymentId);
  if (!payment) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message:
        "Pembayaran itu tidak ditemukan. Periksa kembali tautannya, atau cari pembayarannya " +
        "lewat halaman daftar pembayaran.",
    });
  }

  const [webhooks, calls, refunds, invoice] = await Promise.all([
    webhookEvents({ providerOrderId: payment.provider_order_id ?? undefined, limit: 20 }),
    providerCalls({ paymentAttemptId: paymentId, limit: 20 }),
    query<{
      id: string;
      amount: string;
      reason: string;
      status: string;
      provider_refund_id: string | null;
      completed_at: Date | null;
      created_at: Date;
      requested_by_name: string | null;
    }>(
      `SELECT r.id, r.amount::text, r.reason, r.status, r.provider_refund_id, r.completed_at,
              r.created_at, a.full_name AS requested_by_name
       FROM payment_refunds r
       LEFT JOIN admin_users a ON a.id = r.requested_by_admin_id
       WHERE r.payment_attempt_id = $1
       ORDER BY r.created_at DESC`,
      [paymentId],
    ),
    queryOne<{
      id: string;
      invoice_number: string | null;
      status: string;
      total_amount: string;
      amount_paid: string;
      currency: string;
      due_at: Date | null;
      paid_at: Date | null;
    }>(
      `SELECT id, invoice_number, status, total_amount::text, amount_paid::text, currency,
              due_at, paid_at
       FROM invoices WHERE id = $1`,
      [payment.invoice_id],
    ),
  ]);

  return ok(
    {
      payment: {
        id: payment.id,
        attempt_sequence: payment.attempt_sequence,
        provider: payment.provider,
        payment_method: payment.payment_method,
        provider_order_id: payment.provider_order_id,
        amount: payment.amount,
        provider_fee: payment.provider_fee,
        provider_total_payment: payment.provider_total_payment,
        status: payment.status,
        expires_at: payment.expires_at?.toISOString() ?? null,
        paid_at: payment.paid_at?.toISOString() ?? null,
        /*
          Belum terverifikasi berbeda dari gagal. Pembayaran yang belum dikonfirmasi penyedia
          tidak boleh disimpulkan sebagai lunas maupun sebagai gagal.
        */
        verified_at: payment.verified_at?.toISOString() ?? null,
        verified_via: payment.verified_via,
        created_at: payment.created_at.toISOString(),
      },
      invoice: invoice
        ? {
            id: invoice.id,
            invoice_number: invoice.invoice_number,
            status: invoice.status,
            total_amount: invoice.total_amount,
            amount_paid: invoice.amount_paid,
            currency: invoice.currency,
            due_at: invoice.due_at?.toISOString() ?? null,
            paid_at: invoice.paid_at?.toISOString() ?? null,
          }
        : null,
      customer: { id: payment.customer_id, full_name: payment.customer_name },
      webhook_events: webhooks.map((event) => ({
        id: event.id,
        provider: event.provider,
        provider_event_id: event.provider_event_id,
        provider_order_id: event.provider_order_id,
        provider_status: event.provider_status,
        event_type: event.event_type,
        ip_address: event.ip_address,
        user_agent: event.user_agent,
        processed_at: event.processed_at?.toISOString() ?? null,
        processing_error: event.processing_error,
        payload: event.payload,
        created_at: event.created_at.toISOString(),
      })),
      provider_calls: calls.map((call) => ({
        id: call.id,
        provider: call.provider,
        operation: call.operation,
        order_id: call.order_id,
        http_status: call.http_status,
        duration_ms: call.duration_ms,
        outcome: call.outcome,
        error_message: call.error_message,
        attempt_number: call.attempt_number,
        request_body: call.request_body,
        response_body: call.response_body,
        created_at: call.created_at.toISOString(),
      })),
      refunds: refunds.map((refund) => ({
        id: refund.id,
        amount: refund.amount,
        reason: refund.reason,
        status: refund.status,
        provider_refund_id: refund.provider_refund_id,
        completed_at: refund.completed_at?.toISOString() ?? null,
        created_at: refund.created_at.toISOString(),
        requested_by: refund.requested_by_name,
      })),
    },
    requestId,
  );
});

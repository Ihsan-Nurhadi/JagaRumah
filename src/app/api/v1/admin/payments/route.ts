/*
  Daftar pembayaran.

  Ringkasan "sudah dibayar tetapi belum dikonfirmasi penyedia" adalah angka yang paling perlu
  diperhatikan di halaman ini. Penyedia pembayaran mengirim notifikasi berulang dan notifikasi
  itu tidak bertanda tangan, sehingga pembayaran yang hanya bersandar pada notifikasi memiliki
  keyakinan yang lebih lemah daripada yang terlihat di daftar.
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
import { paymentFilterConditions, paymentSummary, type PaymentListRow } from "@/lib/server/payments";
import { listed } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

const SORT: SortAllowlist = {
  created_at: { column: "pa.created_at", defaultDirection: "desc" },
  paid_at: { column: "pa.paid_at", defaultDirection: "desc" },
  amount: { column: "pa.amount", defaultDirection: "desc" },
  status: { column: "pa.status", defaultDirection: "asc" },
};

const STATUSES = ["pending", "paid", "expired", "failed", "canceled"] as const;
const VERIFIED_VIA = ["webhook", "reconciliation", "sync"] as const;

export const GET = routeHandler("admin.payments.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "payment.read");

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

  const verifiedParam = url.searchParams.get("verified_via");
  if (verifiedParam && !VERIFIED_VIA.includes(verifiedParam as (typeof VERIFIED_VIA)[number])) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: `Pemicu verifikasi "${verifiedParam}" tidak dikenal. Pilihan yang tersedia: ${VERIFIED_VIA.join(", ")}.`,
      details: { verified_via: verifiedParam, allowed: VERIFIED_VIA },
    });
  }

  const params: unknown[] = [];
  const filterSql = paymentFilterConditions(
    {
      status: statusParam ?? undefined,
      invoiceId: url.searchParams.get("invoice_id") ?? undefined,
      customerId: url.searchParams.get("customer_id") ?? undefined,
      verifiedVia: verifiedParam ?? undefined,
      q: url.searchParams.get("q")?.trim() || undefined,
      paidFrom: url.searchParams.get("paid_from") ?? undefined,
      paidTo: url.searchParams.get("paid_to") ?? undefined,
    },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  const rows = await query<PaymentListRow>(
    `SELECT pa.id,
            pa.created_at::text AS cursor_value,
            pa.attempt_sequence,
            pa.provider,
            pa.payment_method,
            pa.provider_order_id,
            pa.amount::text,
            pa.provider_fee::text,
            pa.provider_total_payment::text,
            pa.status,
            pa.expires_at,
            pa.paid_at,
            pa.verified_at,
            pa.verified_via,
            pa.created_at,
            pa.invoice_id,
            i.invoice_number,
            i.status AS invoice_status,
            i.customer_id,
            c.full_name AS customer_name
     FROM payment_attempts pa
     JOIN invoices i ON i.id = pa.invoice_id
     LEFT JOIN customers c ON c.id = i.customer_id
     WHERE true
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const summary = await paymentSummary();

  return listed(
    {
      payments: items.map((row) => ({
        id: row.id,
        attempt_sequence: row.attempt_sequence,
        provider: row.provider,
        payment_method: row.payment_method,
        provider_order_id: row.provider_order_id,
        amount: row.amount,
        provider_fee: row.provider_fee,
        provider_total_payment: row.provider_total_payment,
        status: row.status,
        expires_at: row.expires_at?.toISOString() ?? null,
        paid_at: row.paid_at?.toISOString() ?? null,
        verified_at: row.verified_at?.toISOString() ?? null,
        verified_via: row.verified_via,
        created_at: row.created_at.toISOString(),
        invoice: { id: row.invoice_id, invoice_number: row.invoice_number, status: row.invoice_status },
        customer: { id: row.customer_id, full_name: row.customer_name },
      })),
      summary: {
        total: summary?.total ?? 0,
        pending: summary?.pending ?? 0,
        paid: summary?.paid ?? 0,
        expired: summary?.expired ?? 0,
        failed: summary?.failed ?? 0,
        canceled: summary?.canceled ?? 0,
        unverified_paid: summary?.unverified_paid ?? 0,
      },
    },
    pagination,
    requestId,
  );
});

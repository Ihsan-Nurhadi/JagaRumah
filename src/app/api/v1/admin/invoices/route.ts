/*
  Daftar tagihan.

  Ringkasan "belum tertagih" adalah alasan utama halaman ini ada: itu daftar kerja tim
  penagihan. Angka itu hanya menjumlahkan tagihan yang masih menuntut pembayaran, bukan seluruh
  tagihan yang pernah diterbitkan.
*/
import { query } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { invoiceFilterConditions, invoiceSummary, type InvoiceListRow } from "@/lib/server/invoices";
import {
  buildPage,
  keysetCondition,
  orderBy,
  parsePageRequest,
  type SortAllowlist,
} from "@/lib/server/pagination";
import { listed } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

const SORT: SortAllowlist = {
  created_at: { column: "i.created_at", defaultDirection: "desc" },
  due_at: { column: "i.due_at", defaultDirection: "asc" },
  total_amount: { column: "i.total_amount", defaultDirection: "desc" },
  status: { column: "i.status", defaultDirection: "asc" },
};

const STATUSES = ["draft", "open", "paid", "past_due", "void", "uncollectible"] as const;

export const GET = routeHandler("admin.invoices.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "invoice.read");

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
  const filterSql = invoiceFilterConditions(
    {
      status: statusParam ?? undefined,
      customerId: url.searchParams.get("customer_id") ?? undefined,
      subscriptionId: url.searchParams.get("subscription_id") ?? undefined,
      q: url.searchParams.get("q")?.trim() || undefined,
      dueFrom: url.searchParams.get("due_from") ?? undefined,
      dueTo: url.searchParams.get("due_to") ?? undefined,
    },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  const rows = await query<InvoiceListRow>(
    `SELECT i.id,
            i.created_at::text AS cursor_value,
            i.invoice_number,
            i.status,
            i.currency,
            i.total_amount::text,
            i.amount_paid::text,
            i.due_at,
            i.period_start,
            i.period_end,
            i.paid_at,
            i.voided_at,
            i.created_at,
            i.customer_id,
            c.full_name AS customer_name,
            i.subscription_id,
            p.name AS plan_name,
            (SELECT count(*)::int FROM payment_attempts pa WHERE pa.invoice_id = i.id)
              AS attempt_count,
            (SELECT pa.status FROM payment_attempts pa
             WHERE pa.invoice_id = i.id ORDER BY pa.attempt_sequence DESC LIMIT 1)
              AS last_attempt_status
     FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id
     LEFT JOIN subscriptions s ON s.id = i.subscription_id
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     WHERE true
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const summary = await invoiceSummary();

  return listed(
    {
      invoices: items.map((row) => ({
        id: row.id,
        invoice_number: row.invoice_number,
        status: row.status,
        currency: row.currency,
        total_amount: row.total_amount,
        amount_paid: row.amount_paid,
        due_at: row.due_at?.toISOString() ?? null,
        period_start: row.period_start?.toISOString() ?? null,
        period_end: row.period_end?.toISOString() ?? null,
        paid_at: row.paid_at?.toISOString() ?? null,
        voided_at: row.voided_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
        customer: { id: row.customer_id, full_name: row.customer_name },
        subscription_id: row.subscription_id,
        plan_name: row.plan_name,
        attempt_count: row.attempt_count,
        last_attempt_status: row.last_attempt_status,
      })),
      summary: {
        total: summary?.total ?? 0,
        open: summary?.open ?? 0,
        paid: summary?.paid ?? 0,
        past_due: summary?.past_due ?? 0,
        void: summary?.void ?? 0,
        uncollectible: summary?.uncollectible ?? 0,
        outstanding_amount: summary?.outstanding_amount ?? "0",
        paid_this_month_amount: summary?.paid_this_month_amount ?? "0",
      },
    },
    pagination,
    requestId,
  );
});

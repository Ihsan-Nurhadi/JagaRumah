/*
  Detail tagihan.

  Butir tagihan ikut dikirim karena harga di dalamnya adalah salinan pada saat tagihan dibuat.
  Itulah catatan sebenarnya tentang apa yang ditagihkan, dan membacanya dari harga paket yang
  berlaku sekarang akan membuat tagihan lama berubah nilainya setiap kali harga diperbarui.

  Percobaan pembayaran juga ikut dikirim. Satu tagihan biasanya punya beberapa percobaan, dan
  pertanyaan "pelanggan mengaku sudah bayar" hanya bisa dijawab dengan melihat percobaan mana
  yang berhasil dan mana yang kedaluwarsa.
*/
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { findInvoice, invoiceItems, invoicePaymentAttempts } from "@/lib/server/invoices";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Params = { params: Promise<{ invoice_id?: string }> };

export const GET = routeHandler("admin.invoices.detail", async (_request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "invoice.read");

  const { invoice_id: rawId } = await (context as Params).params;
  const invoiceId = requireUuid(rawId, "invoice_id");

  const invoice = await findInvoice(invoiceId);
  if (!invoice) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message:
        "Tagihan itu tidak ditemukan. Periksa kembali tautannya, atau cari tagihannya lewat " +
        "halaman daftar tagihan.",
    });
  }

  const [items, attempts] = await Promise.all([
    invoiceItems(invoiceId),
    invoicePaymentAttempts(invoiceId),
  ]);

  return ok(
    {
      invoice: {
        id: invoice.id,
        invoice_number: invoice.invoice_number,
        status: invoice.status,
        currency: invoice.currency,
        total_amount: invoice.total_amount,
        amount_paid: invoice.amount_paid,
        due_at: invoice.due_at?.toISOString() ?? null,
        period_start: invoice.period_start?.toISOString() ?? null,
        period_end: invoice.period_end?.toISOString() ?? null,
        paid_at: invoice.paid_at?.toISOString() ?? null,
        voided_at: invoice.voided_at?.toISOString() ?? null,
        created_at: invoice.created_at.toISOString(),
      },
      customer: { id: invoice.customer_id, full_name: invoice.customer_name },
      subscription: invoice.subscription_id
        ? { id: invoice.subscription_id, plan_name: invoice.plan_name }
        : null,
      items: items.map((item) => ({
        id: item.id,
        description: item.description,
        quantity: item.quantity,
        unit_amount: item.unit_amount,
        total_amount: item.total_amount,
        metadata: item.metadata,
      })),
      payment_attempts: attempts.map((attempt) => ({
        id: attempt.id,
        attempt_sequence: attempt.attempt_sequence,
        provider: attempt.provider,
        payment_method: attempt.payment_method,
        provider_order_id: attempt.provider_order_id,
        amount: attempt.amount,
        /*
          Biaya layanan dikirim terpisah dari nominal tagihan, bukan dijumlahkan diam-diam.
          Yang benar-benar dibayar pelanggan adalah provider_total_payment, sedangkan yang
          dihitung sebagai pendapatan langganan hanya amount.
        */
        provider_fee: attempt.provider_fee,
        provider_total_payment: attempt.provider_total_payment,
        status: attempt.status,
        expires_at: attempt.expires_at?.toISOString() ?? null,
        paid_at: attempt.paid_at?.toISOString() ?? null,
        verified_at: attempt.verified_at?.toISOString() ?? null,
        verified_via: attempt.verified_via,
        created_at: attempt.created_at.toISOString(),
      })),
    },
    requestId,
  );
});

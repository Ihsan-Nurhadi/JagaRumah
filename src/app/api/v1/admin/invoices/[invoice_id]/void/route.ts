/*
  Membatalkan tagihan.

  Membatalkan tagihan berarti tagihan itu tidak akan pernah ditagih. Ini tindakan yang tidak
  dapat dikembalikan lewat antarmuka: tagihan yang sudah dibatalkan tidak bisa dihidupkan lagi
  karena nomornya sudah terpakai dan pembatalannya tercatat di jejak audit.

  Yang ditolak di sini, dan alasannya:

  - Tagihan yang sudah lunas tidak dapat dibatalkan. Uangnya sudah diterima, dan membatalkan
    tagihannya tidak mengembalikan uang itu. Kalau uangnya memang akan dikembalikan, jalurnya
    adalah refund pada pembayaran, bukan pembatalan tagihan.
  - Tagihan yang sudah dibatalkan tidak dapat dibatalkan lagi. Tanpa pemeriksaan ini, dua
    operator bisa menulis dua catatan pembatalan untuk satu keputusan.
*/
import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { voidInvoiceSchema } from "@/lib/schemas/admin-invoice";

type Params = { params: Promise<{ invoice_id?: string }> };

export const POST = routeHandler("admin.invoices.void", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "invoice.void");
  await requireCsrf(request);

  const { invoice_id: rawId } = await (context as Params).params;
  const invoiceId = requireUuid(rawId, "invoice_id");
  const input = await parseJson(request, voidInvoiceSchema);

  const result = await withTransaction(async (client) => {
    /*
      Baris dikunci sebelum dibaca. Dua operator yang membatalkan tagihan yang sama pada saat
      hampir bersamaan akan berjalan berurutan, sehingga yang kedua melihat status yang sudah
      berubah dan ditolak, bukan menulis catatan pembatalan kedua.
    */
    const invoice = await queryOne<{
      id: string;
      invoice_number: string | null;
      status: string;
      amount_paid: string;
    }>(
      `SELECT id, invoice_number, status, amount_paid::text
       FROM invoices WHERE id = $1 FOR UPDATE`,
      [invoiceId],
      client,
    );

    if (!invoice) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message:
          "Tagihan itu tidak ditemukan. Kembali ke daftar tagihan untuk memilih tagihan yang benar.",
      });
    }

    if (invoice.status === "void") {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message:
          `Tagihan ${invoice.invoice_number ?? "ini"} sudah dibatalkan sebelumnya, jadi tidak ` +
          `perlu dibatalkan lagi. Muat ulang halaman ini untuk melihat keadaan terbarunya.`,
        details: { invoice_status: invoice.status },
      });
    }

    /*
      Tagihan lunas diperiksa lewat jumlah yang sudah dibayar, bukan hanya lewat statusnya.
      Tagihan bisa berstatus lunas dengan pembayaran sebagian di beberapa kasus, dan yang
      menentukan di sini adalah apakah uangnya sudah masuk.
    */
    if (invoice.status === "paid" || Number(invoice.amount_paid) > 0) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message:
          `Tagihan ${invoice.invoice_number ?? "ini"} sudah menerima pembayaran sebesar ` +
          `${invoice.amount_paid}, jadi tidak dapat dibatalkan. Pembatalan tidak mengembalikan ` +
          `uang. Kalau dana memang akan dikembalikan, ajukan refund pada pembayarannya.`,
        details: { invoice_status: invoice.status, amount_paid: invoice.amount_paid },
      });
    }

    if (invoice.status === "draft") {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message:
          `Tagihan ${invoice.invoice_number ?? "ini"} masih berstatus draf dan belum pernah ` +
          `dikirimkan ke pelanggan, jadi membatalkannya tidak mengubah apa pun. Tagihan draf ` +
          `tidak pernah ditagihkan.`,
        details: { invoice_status: invoice.status },
      });
    }

    await client.query(
      `UPDATE invoices SET status = 'void', voided_at = now() WHERE id = $1`,
      [invoiceId],
    );

    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "invoice.void",
      entityType: "invoice",
      entityId: invoiceId,
      oldData: { status: invoice.status },
      newData: { status: "void", reason: input.reason },
    });

    return { invoiceNumber: invoice.invoice_number };
  });

  return ok(
    {
      invoice: { id: invoiceId, status: "void", voided_at: new Date().toISOString() },
      effect: {
        can_be_undone: false,
        note:
          `Tagihan ${result.invoiceNumber ?? "ini"} tidak akan ditagih lagi. Pembatalan ini ` +
          `tidak dapat dikembalikan dari konsol, jadi tagihan baru perlu diterbitkan bila ` +
          `ternyata masih harus ditagih.`,
      },
    },
    requestId,
  );
});

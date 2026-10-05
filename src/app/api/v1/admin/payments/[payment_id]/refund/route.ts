/*
  Pencatatan refund.

  Penting dipahami: endpoint ini MENCATAT refund, bukan memprosesnya. Dokumentasi penyedia
  pembayaran yang kita pegang tidak memuat API refund, sehingga pengembalian dana dilakukan
  manual dari dasbor penyedia.

  Kenapa tetap dicatat meski manual: tanpa catatan, laporan pengembalian dana selalu kosong dan
  tidak ada tempat untuk menjawab "kenapa uang pelanggan ini dikembalikan". Keputusan
  mengembalikan uang adalah keputusan yang paling sering ditanyakan ulang, dan itu tidak boleh
  hanya tersimpan di ingatan operator.

  Batas yang ditegakkan di sini:

  - Hanya pembayaran berstatus lunas yang dapat dikembalikan. Mengembalikan dana untuk
    pembayaran yang tidak pernah masuk adalah cara mempercepat kebocoran uang.
  - Total refund tidak boleh melebihi nominal tagihan yang benar-benar dibayar. Nominal yang
    dipakai adalah `amount`, bukan `provider_total_payment`, karena biaya layanan penyedia tidak
    pernah diterima sebagai pendapatan kita dan bukan hak pelanggan untuk dikembalikan oleh kita.
  - Satu pembayaran hanya boleh punya satu catatan refund yang tidak gagal. Pembayaran adalah
    satu transaksi, dan mengembalikannya dua kali hanya bisa terjadi karena kekeliruan.
*/
import { writeAudit } from "@/lib/server/audit";
import { query, queryOne, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { created, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { recordRefundSchema } from "@/lib/schemas/admin-payment";

type Params = { params: Promise<{ payment_id?: string }> };

export const POST = routeHandler("admin.payments.refund", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "payment.refund");
  await requireCsrf(request);

  const { payment_id: rawId } = await (context as Params).params;
  const paymentId = requireUuid(rawId, "payment_id");
  const input = await parseJson(request, recordRefundSchema);

  const result = await withTransaction(async (client) => {
    /*
      Baris pembayaran dikunci sebelum dibaca, sehingga dua permintaan refund yang datang
      bersamaan tidak bisa sama-sama lolos pemeriksaan jumlah refund yang sudah ada.
    */
    const payment = await queryOne<{
      id: string;
      invoice_id: string;
      status: string;
      amount: string;
      provider_order_id: string | null;
      invoice_number: string | null;
    }>(
      `SELECT pa.id, pa.invoice_id, pa.status, pa.amount::text, pa.provider_order_id,
              i.invoice_number
       FROM payment_attempts pa
       JOIN invoices i ON i.id = pa.invoice_id
       WHERE pa.id = $1
       FOR UPDATE OF pa`,
      [paymentId],
      client,
    );

    if (!payment) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message:
          "Pembayaran itu tidak ditemukan. Kembali ke daftar pembayaran untuk memilih pembayaran " +
          "yang benar.",
      });
    }

    if (payment.status !== "paid") {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message:
          `Pembayaran ini berstatus "${payment.status}", jadi tidak ada dana yang bisa ` +
          `dikembalikan. Refund hanya berlaku untuk pembayaran yang sudah benar-benar lunas.`,
        details: { payment_status: payment.status },
      });
    }

    const existing = await query<{ id: string; amount: string; status: string }>(
      `SELECT id, amount::text, status FROM payment_refunds
       WHERE payment_attempt_id = $1 ORDER BY created_at`,
      [paymentId],
      client,
    );

    /*
      Refund yang gagal tidak dihitung, karena dana yang gagal dikembalikan tidak mengurangi
      apa pun. Kalau kegagalan ikut dihitung, operator tidak akan bisa mencoba lagi.
    */
    const activeRefunds = existing.filter((refund) => refund.status !== "failed");
    const alreadyRefunded = activeRefunds.reduce(
      (total, refund) => total + Number(refund.amount),
      0,
    );
    const refundable = Number(payment.amount);

    if (activeRefunds.length > 0) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message:
          `Pembayaran ini sudah memiliki catatan refund sebesar ${alreadyRefunded.toLocaleString("id-ID")}. ` +
          `Satu pembayaran hanya boleh punya satu catatan refund yang tidak gagal, karena ` +
          `pembayaran adalah satu transaksi. Periksa catatan refund yang sudah ada sebelum ` +
          `mencatat yang baru.`,
        details: { already_refunded: alreadyRefunded, refundable },
      });
    }

    if (input.amount > refundable) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message:
          `Nominal refund ${input.amount.toLocaleString("id-ID")} melebihi jumlah yang ` +
          `sebenarnya dibayarkan, yaitu ${refundable.toLocaleString("id-ID")}. Nominal tagihan ` +
          `adalah batas pengembalian, dan biaya layanan penyedia tidak termasuk di dalamnya.`,
        details: { requested: input.amount, refundable },
      });
    }

    const refund = await queryOne<{ id: string; completed_at: Date | null }>(
      `INSERT INTO payment_refunds
         (payment_attempt_id, provider_refund_id, amount, reason, status,
          requested_by_admin_id, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, completed_at`,
      [
        paymentId,
        input.provider_refund_id,
        input.amount,
        input.reason,
        input.status,
        admin.identity.id,
        input.status === "completed" ? new Date() : null,
      ],
      client,
    );
    if (!refund) throw new Error("Penyisipan refund tidak mengembalikan baris.");

    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "payment.refund",
      entityType: "payment_attempt",
      entityId: paymentId,
      oldData: { refunded_amount: 0 },
      newData: {
        refund_id: refund.id,
        amount: input.amount,
        reason: input.reason,
        status: input.status,
        provider_refund_id: input.provider_refund_id,
        payment_amount: refundable,
        invoice_number: payment.invoice_number,
      },
    });

    return { refundId: refund.id, completedAt: refund.completed_at };
  });

  return created(
    {
      refund: {
        id: result.refundId,
        amount: input.amount,
        status: input.status,
        provider_refund_id: input.provider_refund_id,
        completed_at: result.completedAt?.toISOString() ?? null,
        reason: input.reason,
      },
      /*
        Dicatat apa adanya bahwa pengembalian dananya dilakukan di luar konsol ini. Operator
        tidak boleh menyimpulkan bahwa dananya sudah berpindah hanya karena catatannya tersimpan.
      */
      note:
        input.status === "completed"
          ? "Catatan refund tersimpan. Pastikan pengembalian dana sudah benar-benar dijalankan di dasbor penyedia pembayaran, karena konsol ini hanya mencatatnya."
          : "Catatan refund tersimpan dengan status belum selesai. Perbarui catatannya setelah penyedia menyelesaikan pengembalian dana.",
    },
    requestId,
  );
});

/*
  Pembaruan status refund.

  Refund manual sering belum selesai saat dicatat, karena penyedia memprosesnya beberapa waktu
  kemudian. Tanpa cara memperbarui statusnya, catatan itu akan macet pada status belum selesai
  selamanya.

  Akibat dari macetnya itu nyata dan tidak terlihat: laporan pengembalian dana memakai dasar kas
  dan mengakui refund pada tanggal selesainya. Refund yang tidak pernah ditandai selesai tidak
  akan muncul di laporan mana pun, sehingga laporan itu tampak lebih ringan daripada kenyataan,
  dan tidak ada satu pun tanda di layar yang menunjukkan ada yang salah.

  Karena itu perubahan status ke selesai mengisi `completed_at`, dan perubahan dari selesai ke
  status lain mengosongkannya kembali. Batasan di database menuntut keduanya konsisten, jadi
  keduanya diurus bersamaan.
*/
import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { updateRefundSchema } from "@/lib/schemas/admin-payment";

type Params = { params: Promise<{ payment_id?: string; refund_id?: string }> };

export const PATCH = routeHandler(
  "admin.payments.refund.update",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "payment.refund");
    await requireCsrf(request);

    const { payment_id: rawPaymentId, refund_id: rawRefundId } = await (context as Params).params;
    const paymentId = requireUuid(rawPaymentId, "payment_id");
    const refundId = requireUuid(rawRefundId, "refund_id");
    const input = await parseJson(request, updateRefundSchema);

    const result = await withTransaction(async (client) => {
      /*
        Refund dibaca bersama nomor pembayarannya, sehingga refund yang diberikan bukan milik
        pembayaran yang disebutkan di alamat akan ditolak. Tanpa pemeriksaan ini, satu refund
        bisa diubah lewat alamat pembayaran mana pun yang nomornya diketahui.
      */
      const refund = await queryOne<{
        id: string;
        payment_attempt_id: string;
        status: string;
        amount: string;
        provider_refund_id: string | null;
        completed_at: Date | null;
      }>(
        `SELECT id, payment_attempt_id, status, amount::text, provider_refund_id, completed_at
         FROM payment_refunds
         WHERE id = $1 AND payment_attempt_id = $2
         FOR UPDATE`,
        [refundId, paymentId],
        client,
      );

      if (!refund) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message:
            "Catatan refund itu tidak ada pada pembayaran yang disebutkan. Kembali ke halaman " +
            "pembayaran untuk melihat catatan refund yang benar.",
        });
      }

      if (refund.status === input.status) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            `Catatan refund ini sudah berstatus "${refund.status}", jadi tidak ada yang berubah. ` +
            `Muat ulang halaman ini untuk melihat keadaan terbarunya.`,
          details: { refund_status: refund.status },
        });
      }

      /*
        completed_at diisi hanya ketika statusnya selesai, dan dikosongkan kembali bila status
        berubah menjauh dari selesai. Batasan di database menuntut keduanya sejalan.
      */
      const updated = await queryOne<{ completed_at: Date | null }>(
        `UPDATE payment_refunds
         SET status = $2, completed_at = $3
         WHERE id = $1
         RETURNING completed_at`,
        [refundId, input.status, input.status === "completed" ? new Date() : null],
        client,
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "payment.refund.update",
        entityType: "payment_attempt",
        entityId: paymentId,
        oldData: {
          refund_id: refundId,
          status: refund.status,
          completed_at: refund.completed_at?.toISOString() ?? null,
        },
        newData: {
          refund_id: refundId,
          status: input.status,
          completed_at: updated?.completed_at?.toISOString() ?? null,
          note: input.note ?? null,
          provider_refund_id: refund.provider_refund_id,
          amount: refund.amount,
        },
      });

      return { completedAt: updated?.completed_at ?? null };
    });

    return ok(
      {
        refund: {
          id: refundId,
          status: input.status,
          completed_at: result.completedAt?.toISOString() ?? null,
        },
        effect: {
          counted_in_reports: input.status === "completed",
          note:
            input.status === "completed"
              ? "Refund ini sekarang dihitung pada laporan pengembalian dana, pada tanggal selesainya."
              : "Refund ini tidak dihitung pada laporan pengembalian dana selama statusnya belum selesai.",
        },
      },
      requestId,
    );
  },
);

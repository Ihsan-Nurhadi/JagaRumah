/*
  Mengaktifkan kembali akun admin yang dinonaktifkan.

  Alasan tetap wajib meskipun ini terasa seperti "mengembalikan ke keadaan semula".
  Pertanyaan yang perlu bisa dijawab adalah "atas dasar apa akun ini dinyalakan lagi", dan itu
  sama pentingnya dengan alasan penonaktifannya.

  Yang perlu diketahui operator: mengaktifkan akun tidak menghidupkan kembali sesi admin.
  Sesi lama sudah dicabut saat penonaktifan, jadi admin perlu masuk kembali dari konsol.
*/
import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { deactivateAdminUserSchema } from "@/lib/schemas/admin-user";

type Params = { params: Promise<{ admin_user_id?: string }> };

export const POST = routeHandler(
  "admin.admin_users.activate",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "admin.manage");
    await requireCsrf(request);

    const { admin_user_id: rawId } = await (context as Params).params;
    const adminUserId = requireUuid(rawId, "admin_user_id");
    const input = await parseJson(request, deactivateAdminUserSchema);

    const result = await withTransaction(async (client) => {
      const target = await queryOne<{ id: string; status: string; full_name: string }>(
        `SELECT id, status, full_name FROM admin_users WHERE id = $1 FOR UPDATE`,
        [adminUserId],
        client,
      );

      if (!target) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message: "Akun admin itu tidak ditemukan. Kembali ke daftar admin untuk memilih akun yang benar.",
        });
      }

      if (target.status === "active") {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message: `Akun ${target.full_name} sudah aktif, jadi tidak ada yang perlu diaktifkan. Muat ulang halaman ini untuk melihat keadaan terbarunya.`,
          details: { status: target.status },
        });
      }

      if (target.status === "locked") {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message: "Akun ini terkunci karena percobaan masuk berulang. Buka kunci terlebih dahulu melalui database atau hubungi administrator sistem.",
          details: { status: target.status },
        });
      }

      await client.query(
        `UPDATE admin_users SET status = 'active' WHERE id = $1`,
        [adminUserId],
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "admin_user.activate",
        entityType: "admin_user",
        entityId: adminUserId,
        oldData: { status: target.status },
        newData: { status: "active", reason: input.reason },
      });

      return { name: target.full_name };
    });

    return ok(
      {
        admin_user: { id: adminUserId, status: "active" },
        effect: {
          note: "Akun diaktifkan. Sesi lama tidak dihidupkan kembali. Admin perlu masuk ulang dari konsol.",
        },
      },
      requestId,
    );
  },
);

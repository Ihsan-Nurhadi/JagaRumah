/*
  Menonaktifkan akun admin.

  Dipisahkan dari `PATCH` karena akibatnya berbeda dari sekadar mengubah kolom: seluruh sesi
  akun itu dicabut, sehingga orangnya benar-benar keluar dan bukan hanya kehilangan izin saat
  token berikutnya diterbitkan.

  Yang ditolak di sini:

  - Menonaktifkan akun sendiri. Satu klik bisa membuat pelakunya langsung kehilangan akses, dan
    ia tidak bisa membatalkannya lagi.
  - Menonaktifkan pemegang terakhir izin mengelola admin. Setelah itu tidak ada lagi yang dapat
    mengelola admin, dan keadaannya hanya bisa diperbaiki lewat akses langsung ke database.
*/
import { writeAudit } from "@/lib/server/audit";
import { adminsLeftAbleToManage, findAdminUser } from "@/lib/server/admin-users";
import { query, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { deactivateAdminUserSchema } from "@/lib/schemas/admin-user";

type Params = { params: Promise<{ admin_user_id?: string }> };

export const POST = routeHandler(
  "admin.admin_users.deactivate",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "admin.manage");
    await requireCsrf(request);

    const { admin_user_id: rawId } = await (context as Params).params;
    const adminUserId = requireUuid(rawId, "admin_user_id");
    const input = await parseJson(request, deactivateAdminUserSchema);

    const result = await withTransaction(async (client) => {
      const target = await query<{ id: string; status: string }>(
        `SELECT id, status FROM admin_users WHERE id = $1 FOR UPDATE`,
        [adminUserId],
        client,
      );

      if (target.length === 0) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message: "Akun admin itu tidak ditemukan. Kembali ke daftar admin untuk memilih akun yang benar.",
        });
      }

      if (adminUserId === admin.identity.id) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            "Akun sendiri tidak dapat dinonaktifkan dari halaman ini. Mintalah admin lain " +
            "melakukannya, supaya Anda tidak kehilangan akses secara tiba-tiba.",
        });
      }

      if (target[0]!.status === "inactive") {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            "Akun ini sudah tidak aktif sebelumnya. Muat ulang halaman ini untuk melihat " +
            "keadaan terbarunya.",
          details: { status: target[0]!.status },
        });
      }

      /*
        Keadaan sesudah penonaktifan dihitung dengan membuang akun ini dari daftar penyelamat.
        Kalau tidak ada yang tersisa, penonaktifannya ditolak, karena setelah itu tidak ada lagi
        yang dapat mengelola admin.
      */
      const sisa = (await adminsLeftAbleToManage("admin.manage", {}, client)).filter(
        (row) => row.admin_id !== adminUserId,
      );
      if (sisa.length === 0) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            "Akun ini satu-satunya admin aktif yang dapat mengelola admin lain. " +
            "Menonaktifkannya akan membuat tidak ada siapa pun yang dapat mengelola admin. " +
            "Berikan izin itu ke admin lain lebih dulu.",
          details: { reason: "ADMIN_MANAGE_LAST_HOLDER" },
        });
      }

      await client.query(
        `UPDATE admin_users SET status = 'inactive' WHERE id = $1`,
        [adminUserId],
      );

      /* Sesi dicabut supaya aksesnya benar-benar berhenti, bukan menunggu token kedaluwarsa. */
      const dicabut = await client.query(
        `UPDATE admin_sessions SET revoked_at = now()
         WHERE admin_user_id = $1 AND revoked_at IS NULL`,
        [adminUserId],
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "admin_user.deactivate",
        entityType: "admin_user",
        entityId: adminUserId,
        oldData: { status: target[0]!.status },
        newData: {
          status: "inactive",
          sessions_revoked: dicabut.rowCount ?? 0,
          reason: input.reason,
        },
      });

      return { sessionsRevoked: dicabut.rowCount ?? 0 };
    });

    const user = await findAdminUser(adminUserId);

    return ok(
      {
        admin_user: user
          ? {
              id: user.id,
              username: user.username,
              full_name: user.full_name,
              status: user.status,
            }
          : null,
        effect: {
          sessions_revoked: result.sessionsRevoked,
          note:
            `Akun dinonaktifkan dan ${result.sessionsRevoked} sesinya dicabut, sehingga aksesnya ` +
            `berhenti saat itu juga. Datanya tidak dihapus, dan akun ini masih dapat diaktifkan ` +
            `kembali kapan saja.`,
        },
      },
      requestId,
    );
  },
);

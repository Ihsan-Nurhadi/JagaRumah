/*
  Detail dan perubahan peran.

  Satu penjagaan penting ada di sini, dan alasannya bukan soal format melainkan soal mencegah
  keadaan yang tidak bisa diperbaiki sendiri:

  Izin `admin.manage` tidak boleh dicabut dari peran terakhir yang memilikinya, selama masih ada
  admin aktif yang menggantungkan izinnya pada peran itu dan tidak punya peran lain sebagai
  pengganti. Kalau itu terjadi, tidak ada satu pun orang yang dapat mengelola admin lagi, dan
  keadaannya hanya bisa diperbaiki lewat akses langsung ke database.

  Pencabutan izin juga mencabut sesi seluruh pemegang peran. Tanpa itu, izin yang sudah dicabut
  tetap berlaku sampai token aksesnya kedaluwarsa, karena izin ikut tertanam di dalam token.
*/
import { writeAudit } from "@/lib/server/audit";
import { adminsLeftAbleToManage, findRole } from "@/lib/server/admin-users";
import { query, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { updateRoleSchema } from "@/lib/schemas/admin-user";

type Params = { params: Promise<{ role_id?: string }> };

export const GET = routeHandler("admin.roles.detail", async (_request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "admin.manage");

  const { role_id: rawId } = await (context as Params).params;
  const roleId = requireUuid(rawId, "role_id");

  const role = await findRole(roleId);
  if (!role) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message: "Peran itu tidak ditemukan. Kembali ke daftar peran untuk memilih peran yang benar.",
    });
  }

  const pemegang = await query<{ id: string; full_name: string; username: string; status: string }>(
    `SELECT u.id, u.full_name, u.username, u.status
     FROM admin_user_roles ur JOIN admin_users u ON u.id = ur.admin_user_id
     WHERE ur.role_id = $1 ORDER BY u.full_name`,
    [roleId],
  );

  return ok(
    {
      role: {
        id: role.id,
        code: role.code,
        name: role.name,
        description: role.description,
        created_at: role.created_at.toISOString(),
        permissions: role.permissions,
        permission_count: role.permission_count,
      },
      holders: pemegang.map((user) => ({
        id: user.id,
        full_name: user.full_name,
        username: user.username,
        status: user.status,
      })),
    },
    requestId,
  );
});

export const PATCH = routeHandler("admin.roles.update", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "admin.manage");
  await requireCsrf(request);

  const { role_id: rawId } = await (context as Params).params;
  const roleId = requireUuid(rawId, "role_id");
  const input = await parseJson(request, updateRoleSchema);

  const result = await withTransaction(async (client) => {
    const lama = await query<{ id: string; code: string; name: string; description: string | null }>(
      `SELECT id, code, name, description FROM admin_roles WHERE id = $1 FOR UPDATE`,
      [roleId],
      client,
    );

    if (lama.length === 0) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message: "Peran itu tidak ditemukan. Muat ulang halaman ini.",
      });
    }

    const izinLama = await query<{ code: string }>(
      `SELECT p.code FROM admin_role_permissions rp
       JOIN admin_permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1 ORDER BY p.code`,
      [roleId],
      client,
    );

    let izinBaru: { id: string; code: string }[] | null = null;
    if (input.permission_codes) {
      izinBaru = await query<{ id: string; code: string }>(
        `SELECT id, code FROM admin_permissions WHERE code = ANY($1::text[]) ORDER BY code`,
        [input.permission_codes],
        client,
      );

      const dikenal = new Set(izinBaru.map((row) => row.code));
      const tidakDikenal = input.permission_codes.filter((code) => !dikenal.has(code));
      if (tidakDikenal.length > 0) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message: "Ada kode izin yang tidak dikenal, jadi perubahannya dibatalkan.",
          details: { fields: { permission_codes: tidakDikenal } },
        });
      }

      /*
        Pencabutan izin mengelola admin diperiksa lebih dulu, sebelum ada yang ditulis. Kalau
        tidak, peran bisa sudah berubah saat pemeriksaannya gagal.
      */
      const akanMencabutAdminManage =
        izinLama.some((row) => row.code === "admin.manage") &&
        !izinBaru.some((row) => row.code === "admin.manage");

      /*
        Pencabutan izin mengelola admin diperiksa dengan satu pertanyaan saja: setelah perubahan
        ini, apakah masih ada admin aktif yang dapat mengelola admin? Selama jawabannya ada,
        perubahan apa pun boleh dilakukan, sekalipun peran yang dicabut sedang dipakai orang.

        Pertanyaan itu dijawab dengan menghitung keadaan sesudah perubahan, bukan dengan memeriksa
        peran satu per satu. Cara per peran mudah salah: mencabut izin dari peran yang sejak awal
        tidak memberi izin itu bukan masalah, tetapi cara itu akan menolaknya, dan penolakan yang
        tidak perlu membuat orang berhenti mempercayai pesannya.
      */
      if (akanMencabutAdminManage) {
        const sisa = await adminsLeftAbleToManage(
          "admin.manage",
          { exceptRoleId: roleId },
          client,
        );

        if (sisa.length === 0) {
          const pemegangSekarang = await adminsLeftAbleToManage("admin.manage", {}, client);
          throw new AppError({
            code: "VALIDATION_ERROR",
            message:
              `Mencabut izin mengelola admin dari peran ini akan membuat tidak ada seorang pun ` +
              `yang dapat mengelola admin, karena ${pemegangSekarang.length} admin yang ` +
              `memegangnya sekarang kehilangan seluruh aksesnya dan tidak ada peran lain yang ` +
              `menggantikannya. Berikan izin itu lewat peran lain lebih dulu.`,
            details: {
              reason: "ADMIN_MANAGE_LAST_HOLDER",
              kandidat: pemegangSekarang.map((row) => row.full_name),
            },
          });
        }
      }
    }

    await client.query(
      `UPDATE admin_roles
       SET name = COALESCE($2, name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END
       WHERE id = $1`,
      [
        roleId,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
      ],
    );

    if (izinBaru) {
      await client.query(`DELETE FROM admin_role_permissions WHERE role_id = $1`, [roleId]);
      for (const permission of izinBaru) {
        await client.query(
          `INSERT INTO admin_role_permissions (role_id, permission_id) VALUES ($1, $2)`,
          [roleId, permission.id],
        );
      }
    }

    /*
      Sesi seluruh pemegang dicabut ketika izin berubah. Tanpa pencabutan, izin yang sudah
      dicabut tetap berlaku sampai token aksesnya kedaluwarsa.
    */
    let sesiDicabut = 0;
    if (izinBaru) {
      const dicabut = await client.query(
        `UPDATE admin_sessions SET revoked_at = now()
         WHERE revoked_at IS NULL
           AND admin_user_id IN (
             SELECT admin_user_id FROM admin_user_roles WHERE role_id = $1
           )`,
        [roleId],
      );
      sesiDicabut = dicabut.rowCount ?? 0;
    }

    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "role.update",
      entityType: "admin_role",
      entityId: roleId,
      oldData: {
        name: lama[0]!.name,
        description: lama[0]!.description,
        permissions: izinLama.map((row) => row.code),
      },
      newData: {
        name: input.name ?? lama[0]!.name,
        description:
          input.description !== undefined ? input.description : lama[0]!.description,
        permissions: izinBaru ? izinBaru.map((row) => row.code) : undefined,
        sessions_revoked: sesiDicabut,
        reason: input.reason,
      },
    });

    return { sesiDicabut, izinBerubah: izinBaru !== null };
  });

  const role = await findRole(roleId);

  return ok(
    {
      role: role
        ? {
            id: role.id,
            code: role.code,
            name: role.name,
            description: role.description,
            permissions: role.permissions,
            permission_count: role.permission_count,
            user_count: role.user_count,
          }
        : null,
      effect: {
        sessions_revoked: result.sesiDicabut,
        note: result.izinBerubah
          ? "Izin peran diperbarui dan sesi seluruh pemegangnya dicabut, sehingga izin barunya berlaku sejak mereka masuk kembali."
          : "Perubahan tersimpan. Izin peran tidak berubah, jadi sesi yang berjalan tidak terpengaruh.",
      },
    },
    requestId,
  );
});

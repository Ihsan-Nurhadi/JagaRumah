/*
  Detail akun admin.

  Halaman ini menampilkan tiga hal yang saling melengkapi: peran, izin efektif, dan sesi.
*/
import { writeAudit } from "@/lib/server/audit";
import { query, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { updateAdminUserSchema } from "@/lib/schemas/admin-user";

type Params = { params: Promise<{ admin_user_id?: string }> };

export const GET = routeHandler(
  "admin.admin_users.detail",
  async (_request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "admin.read");

    const { admin_user_id: rawId } = await (context as Params).params;
    const adminUserId = requireUuid(rawId, "admin_user_id");

    const [user, roles, sessions] = await Promise.all([
      query<{
        id: string;
        username: string;
        email: string;
        full_name: string;
        status: string;
        is_super_admin: boolean;
        last_login_at: Date | null;
        created_at: Date;
      }>(`SELECT id, username, email, full_name, status, is_super_admin, last_login_at, created_at
           FROM admin_users WHERE id = $1`, [adminUserId]),
      query<{
        id: string;
        code: string;
        name: string;
        granted_at: Date;
      }>(
        `SELECT ar.id, ar.code, ar.name, ar.created_at AS granted_at
         FROM admin_roles ar
         JOIN admin_user_roles ur ON ur.role_id = ar.id
         WHERE ur.admin_user_id = $1
         ORDER BY ar.code`,
        [adminUserId],
      ),
      query<{
        id: string;
        ip_address: string | null;
        user_agent: string | null;
        created_at: Date;
        last_used_at: Date | null;
        expires_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT id, ip_address, user_agent, created_at, last_used_at, expires_at, revoked_at
         FROM admin_sessions
         WHERE admin_user_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [adminUserId],
      ),
    ]);

    if (user.length === 0) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message: "Akun admin itu tidak ditemukan. Kembali ke daftar admin untuk memilih akun yang benar.",
      });
    }

    const target = user[0]!;
    const self = admin.identity.id === target.id;

    /*
      Izin efektif dihitung dari gabungan seluruh peran yang dipegang.
      Super admin mendapat seluruh izin tanpa perlu peran.
    */
    let permissions: { code: string; name: string; via_roles: string[] }[];
    if (target.is_super_admin) {
      permissions = (
        await query<{ code: string; name: string }>(
          `SELECT code, name FROM admin_permissions ORDER BY code`,
        )
      ).map((p) => ({ ...p, via_roles: ["super admin"] }));
    } else {
      const roleCodes = roles.map((r) => r.code);
      if (roleCodes.length === 0) {
        permissions = [];
      } else {
        const rows = await query<{
          code: string;
          name: string;
          role_code: string;
        }>(
          `SELECT p.code, p.name, r.code AS role_code
           FROM admin_permissions p
           JOIN admin_role_permissions rp ON rp.permission_id = p.id
           JOIN admin_roles r ON r.id = rp.role_id
           WHERE r.code = ANY($1)
           ORDER BY p.code`,
          [roleCodes],
        );
        const byCode = new Map<string, { name: string; via_roles: string[] }>();
        for (const row of rows) {
          const existing = byCode.get(row.code);
          if (existing) {
            existing.via_roles.push(row.role_code);
          } else {
            byCode.set(row.code, { name: row.name, via_roles: [row.role_code] });
          }
        }
        permissions = Array.from(byCode.entries()).map(([code, info]) => ({
          code,
          ...info,
        }));
      }
    }

    return ok(
      {
        admin_user: {
          id: target.id,
          username: target.username,
          email: target.email,
          full_name: target.full_name,
          status: target.status,
          is_super_admin: target.is_super_admin,
          last_login_at: target.last_login_at?.toISOString() ?? null,
          created_at: target.created_at.toISOString(),
        },
        roles: roles.map((role) => ({
          id: role.id,
          code: role.code,
          name: role.name,
          granted_at: role.granted_at.toISOString(),
        })),
        effective_permissions: permissions,
        sessions: sessions.map((session) => ({
          id: session.id,
          ip_address: session.ip_address,
          user_agent: session.user_agent,
          created_at: session.created_at.toISOString(),
          last_used_at: session.last_used_at?.toISOString() ?? null,
          expires_at: session.expires_at.toISOString(),
          revoked_at: session.revoked_at?.toISOString() ?? null,
        })),
        is_self: self,
      },
      requestId,
    );
  },
);

/*
  Perbaikan data akun admin.

  Hanya nama, email, dan kata sandi yang dapat diubah lewat endpoint ini.
  Status dan peran punya mekanisme sendiri.
*/
export const PATCH = routeHandler(
  "admin.admin_users.update",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "admin.manage");
    await requireCsrf(request);

    const { admin_user_id: rawId } = await (context as Params).params;
    const adminUserId = requireUuid(rawId, "admin_user_id");
    const input = await parseJson(request, updateAdminUserSchema);

    const result = await withTransaction(async (client) => {
      const before = await query<{
        id: string;
        full_name: string;
        email: string;
        status: string;
        password_hash: string;
      }>(`SELECT id, full_name, email, status, password_hash FROM admin_users WHERE id = $1`, [
        adminUserId,
      ]);

      if (before.length === 0) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message: "Akun admin itu tidak ditemukan. Kembali ke daftar admin untuk memilih akun yang benar.",
        });
      }

      const existing = before[0]!;

      if (input.email && input.email !== existing.email) {
        const emailCheck = await query<{ id: string }>(
          `SELECT id FROM admin_users WHERE email = $1 AND id <> $2`,
          [input.email, adminUserId],
        );
        if (emailCheck.length > 0) {
          throw new AppError({
            code: "VALIDATION_ERROR",
            message: "Alamat email itu sudah dipakai oleh admin lain.",
            details: { email: input.email },
          });
        }
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 2;

      if (input.full_name && input.full_name !== existing.full_name) {
        updates.push(`full_name = $${paramIndex++}`);
        values.push(input.full_name);
      }
      if (input.email && input.email !== existing.email) {
        updates.push(`email = $${paramIndex++}`);
        values.push(input.email);
      }
      if (input.password) {
        const bcrypt = await import("bcryptjs");
        const hash = await bcrypt.hash(input.password, 12);
        updates.push(`password_hash = $${paramIndex++}`);
        values.push(hash);
      }

      if (updates.length === 0) {
        return { unchanged: true };
      }

      await client.query(
        `UPDATE admin_users SET ${updates.join(", ")} WHERE id = $1`,
        [adminUserId, ...values],
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "admin_user.update",
        entityType: "admin_user",
        entityId: adminUserId,
        oldData: {
          full_name: existing.full_name,
          email: existing.email,
          has_password: existing.password_hash.length > 0,
        },
        newData: input.full_name
          ? { full_name: input.full_name }
          : input.email
            ? { email: input.email }
            : { password_updated: true },
      });

      return { unchanged: false };
    });

    return ok(
      {
        admin_user: {
          id: adminUserId,
          status: result.unchanged ? "unchanged" : "updated",
        },
      },
      requestId,
    );
  },
);

/*
  Menghapus akun admin secara permanen.

  Hanya berlaku untuk akun yang sudah tidak aktif (`inactive`). Akun aktif atau super admin
  tidak boleh dihapus langsung dari sini, supaya tidak ada yang hilang tanpa jejak.
  Seluruh sesi dicabut lebih dulu, sehingga yang tersisa hanya jejak audit.
*/
export const DELETE = routeHandler(
  "admin.admin_users.delete",
  async (_request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "admin.manage");
    await requireCsrf(_request);

    const { admin_user_id: rawId } = await (context as Params).params;
    const adminUserId = requireUuid(rawId, "admin_user_id");

    await withTransaction(async (client) => {
      const user = await query<{
        id: string;
        username: string;
        email: string;
        full_name: string;
        status: string;
        is_super_admin: boolean;
      }>(`SELECT id, username, email, full_name, status, is_super_admin FROM admin_users WHERE id = $1`, [
        adminUserId,
      ]);

      if (user.length === 0) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message: "Akun admin itu tidak ditemukan. Kembali ke daftar admin untuk memilih akun yang benar.",
        });
      }

      const target = user[0]!;

      if (target.status !== "inactive") {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message: "Hanya akun yang sudah dinonaktifkan yang dapat dihapus secara permanen. Nonaktifkan akun ini lebih dulu dari halaman ini.",
          details: { status: target.status },
        });
      }

      if (target.is_super_admin) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message: "Akun super admin tidak dapat dihapus secara permanen lewat halaman ini.",
        });
      }

      await client.query(
        `DELETE FROM admin_user_roles WHERE admin_user_id = $1`,
        [adminUserId],
      );

      await client.query(
        `DELETE FROM admin_sessions WHERE admin_user_id = $1`,
        [adminUserId],
      );

      await client.query(
        `DELETE FROM admin_users WHERE id = $1`,
        [adminUserId],
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "admin_user.delete",
        entityType: "admin_user",
        entityId: adminUserId,
        oldData: {
          username: target.username,
          email: target.email,
          full_name: target.full_name,
          status: "inactive",
        },
        newData: { deleted: true },
      });
    });

    return ok({ deleted: true }, requestId);
  },
);

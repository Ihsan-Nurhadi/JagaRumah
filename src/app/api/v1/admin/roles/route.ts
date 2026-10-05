/*
  Daftar dan pembuatan peran.

  Izin diberikan lewat peran, tidak langsung ke akun. Karena itu halaman peran adalah tempat
  satu-satunya di mana cakupan kerja seseorang ditentukan.

  `user_count` ditampilkan di daftar karena perubahan izin sebuah peran berlaku untuk semua
  pemegangnya sekaligus. Mengubah peran yang dipakai lima orang adalah perubahan pada lima orang,
  dan itu perlu terlihat sebelum tombol simpan ditekan.
*/
import { writeAudit } from "@/lib/server/audit";
import { allPermissions, findRole } from "@/lib/server/admin-users";
import { query, queryOne, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import {
  buildPage,
  keysetCondition,
  orderBy,
  parsePageRequest,
  type SortAllowlist,
} from "@/lib/server/pagination";
import { parseJson } from "@/lib/server/parse";
import { created, listed } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { createRoleSchema } from "@/lib/schemas/admin-user";

const SORT: SortAllowlist = {
  code: { column: "r.code", defaultDirection: "asc" },
  name: { column: "r.name", defaultDirection: "asc" },
  created_at: { column: "r.created_at", defaultDirection: "desc" },
};

type RoleListRow = {
  id: string;
  cursor_value: string;
  code: string;
  name: string;
  description: string | null;
  created_at: Date;
  permission_count: number;
  user_count: number;
  permissions: string[];
};

export const GET = routeHandler("admin.roles.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "admin.manage");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "code");

  const params: unknown[] = [];
  const conditions: string[] = [];
  const q = url.searchParams.get("q")?.trim();
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    conditions.push(
      `AND (r.code ILIKE $${params.push(pattern)} OR r.name ILIKE $${params.length})`,
    );
  }
  const keysetSql = keysetCondition(page, params);

  const rows = await query<RoleListRow>(
    `SELECT r.id, r.code, r.name, r.description, r.created_at,
            r.code::text AS cursor_value,
            (SELECT count(*)::int FROM admin_role_permissions rp WHERE rp.role_id = r.id)
              AS permission_count,
            (SELECT count(*)::int FROM admin_user_roles ur WHERE ur.role_id = r.id)
              AS user_count,
            COALESCE((
              SELECT array_agg(p.code ORDER BY p.code)
              FROM admin_role_permissions rp JOIN admin_permissions p ON p.id = rp.permission_id
              WHERE rp.role_id = r.id
            ), ARRAY[]::text[]) AS permissions
     FROM admin_roles r
     WHERE true
          ${conditions.join("\n          ")}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const permissions = await allPermissions();

  return listed(
    {
      roles: items.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        description: row.description,
        created_at: row.created_at.toISOString(),
        permission_count: row.permission_count,
        user_count: row.user_count,
        permissions: row.permissions,
      })),
      permissions: permissions.map((permission) => ({
        code: permission.code,
        name: permission.name,
        description: permission.description,
        role_count: permission.role_count,
      })),
    },
    pagination,
    requestId,
  );
});

export const POST = routeHandler("admin.roles.create", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "admin.manage");
  await requireCsrf(request);

  const input = await parseJson(request, createRoleSchema);

  const result = await withTransaction(async (client) => {
    const bentrok = await queryOne<{ id: string }>(
      `SELECT id FROM admin_roles WHERE code = $1`,
      [input.code],
      client,
    );
    if (bentrok) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message: `Peran dengan kode "${input.code}" sudah ada. Pilih kode yang lain.`,
        details: { fields: { code: "Kode peran sudah dipakai." } },
      });
    }

    /*
      Kode izin diperiksa lebih dulu. Kode yang salah ketik kalau dibiarkan akan membuat peran
      yang terlihat punya izin padahal izin itu tidak pernah ada.
    */
    const izin = await query<{ id: string; code: string }>(
      `SELECT id, code FROM admin_permissions WHERE code = ANY($1::text[]) ORDER BY code`,
      [input.permission_codes],
      client,
    );

    const dikenal = new Set(izin.map((row) => row.code));
    const tidakDikenal = input.permission_codes.filter((code) => !dikenal.has(code));
    if (tidakDikenal.length > 0) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message:
          "Ada kode izin yang tidak dikenal, jadi perannya tidak dibuat. Pilih izin dari daftar " +
          "yang tersedia.",
        details: { fields: { permission_codes: tidakDikenal } },
      });
    }

    const baru = await queryOne<{ id: string }>(
      `INSERT INTO admin_roles (code, name, description) VALUES ($1, $2, $3) RETURNING id`,
      [input.code, input.name, input.description ?? null],
      client,
    );
    if (!baru) throw new Error("Penyisipan peran tidak mengembalikan baris.");

    for (const permission of izin) {
      await client.query(
        `INSERT INTO admin_role_permissions (role_id, permission_id) VALUES ($1, $2)`,
        [baru.id, permission.id],
      );
    }

    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "role.create",
      entityType: "admin_role",
      entityId: baru.id,
      newData: {
        code: input.code,
        name: input.name,
        permissions: izin.map((row) => row.code),
      },
    });

    return { id: baru.id };
  });

  const role = await findRole(result.id);

  return created(
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
      note:
        "Peran dibuat tanpa pemegang. Berikan peran ini ke akun admin agar izinnya mulai berlaku.",
    },
    requestId,
  );
});

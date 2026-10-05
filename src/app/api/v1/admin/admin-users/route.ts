/*
  Daftar dan pembuatan akun admin.

  Membuat akun admin memerlukan peran. Akun tanpa peran tidak dapat melakukan apa pun, jadi
  membuatnya tanpa peran hanya menghasilkan akun yang tidak berguna dan membingungkan pemiliknya.

  Kata sandi di-hash dengan bcrypt sebelum disimpan; nilai aslinya tidak pernah masuk ke
  database maupun ke jejak audit.
*/
import { writeAudit } from "@/lib/server/audit";
import { adminUserFilterConditions, adminUserSummary, type AdminUserListRow } from "@/lib/server/admin-users";
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
import { hashPassword } from "@/lib/server/password";
import { parseJson } from "@/lib/server/parse";
import { created, listed } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { createAdminUserSchema } from "@/lib/schemas/admin-user";

const SORT: SortAllowlist = {
  created_at: { column: "u.created_at", defaultDirection: "desc" },
  full_name: { column: "u.full_name", defaultDirection: "asc" },
  last_login_at: { column: "u.last_login_at", defaultDirection: "desc" },
  status: { column: "u.status", defaultDirection: "asc" },
};

const STATUSES = ["active", "inactive", "locked"] as const;

export const GET = routeHandler("admin.admin_users.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "admin.manage");

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
  const filterSql = adminUserFilterConditions(
    {
      status: statusParam ?? undefined,
      roleCode: url.searchParams.get("role") ?? undefined,
      q: url.searchParams.get("q")?.trim() || undefined,
    },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  const rows = await query<AdminUserListRow>(
    `SELECT u.id, u.username, u.email, u.full_name, u.status, u.is_super_admin,
            u.last_login_at, u.created_at, u.created_at::text AS cursor_value,
            (SELECT count(*)::int FROM admin_user_roles ur WHERE ur.admin_user_id = u.id)
              AS role_count,
            COALESCE((
              SELECT array_agg(r.code ORDER BY r.code)
              FROM admin_user_roles ur JOIN admin_roles r ON r.id = ur.role_id
              WHERE ur.admin_user_id = u.id
            ), ARRAY[]::text[]) AS roles,
            (
              SELECT count(*)::int FROM admin_sessions s
              WHERE s.admin_user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()
            ) AS active_sessions
     FROM admin_users u
     WHERE true
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const summary = await adminUserSummary();

  return listed(
    {
      admin_users: items.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        full_name: row.full_name,
        status: row.status,
        is_super_admin: row.is_super_admin,
        last_login_at: row.last_login_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
        role_count: row.role_count,
        roles: row.roles,
        active_sessions: row.active_sessions,
      })),
      summary: summary ?? {
        total: 0,
        active: 0,
        inactive: 0,
        locked: 0,
        without_role: 0,
        super_admins: 0,
      },
    },
    pagination,
    requestId,
  );
});

export const POST = routeHandler("admin.admin_users.create", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "admin.manage");
  await requireCsrf(request);

  const input = await parseJson(request, createAdminUserSchema);
  const passwordHash = await hashPassword(input.password);

  const result = await withTransaction(async (client) => {
    /*
      Peran diperiksa lebih dulu. Tanpa pemeriksaan ini, ID peran yang salah akan gagal di
      batasan kunci asing dengan pesan database yang tidak menerangkan kolom mana yang salah.
    */
    const peran = await query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM admin_roles WHERE id = ANY($1::uuid[]) ORDER BY code`,
      [input.role_ids],
      client,
    );

    if (peran.length !== new Set(input.role_ids).size) {
      const dikenal = new Set(peran.map((row) => row.id));
      const tidakDikenal = input.role_ids.filter((id) => !dikenal.has(id));
      throw new AppError({
        code: "VALIDATION_ERROR",
        message:
          `Ada ${tidakDikenal.length} peran yang tidak ditemukan, jadi akunnya tidak dibuat. ` +
          `Buka halaman Peran untuk melihat daftar peran yang tersedia.`,
        details: { fields: { role_ids: tidakDikenal } },
      });
    }

    const bentrok = await queryOne<{ username: string; email: string }>(
      `SELECT username, email FROM admin_users
       WHERE username = $1 OR email = $2 LIMIT 1`,
      [input.username, input.email.toLowerCase()],
      client,
    );

    if (bentrok) {
      /*
        Dua kolom diperiksa bersamaan, tetapi pesannya menunjuk kolom yang benar-benar bentrok.
        Pesan "sudah dipakai" tanpa menyebut kolomnya akan membuat admin menebak-nebak kolom
        mana yang perlu diubah.
      */
      const usernameBentrok = bentrok.username === input.username;
      throw new AppError({
        code: usernameBentrok ? "ADMIN_USERNAME_TAKEN" : "ADMIN_EMAIL_TAKEN",
        message: usernameBentrok
          ? `Nama pengguna "${input.username}" sudah dipakai akun lain. Pilih nama pengguna yang lain.`
          : `Alamat email "${input.email}" sudah dipakai akun lain. Pilih alamat email yang lain.`,
        details: { field: usernameBentrok ? "username" : "email" },
      });
    }

    const baru = await queryOne<{ id: string }>(
      `INSERT INTO admin_users (username, email, full_name, password_hash, status, is_super_admin)
       VALUES ($1, $2, $3, $4, 'active', false)
       RETURNING id`,
      [input.username, input.email.toLowerCase(), input.full_name, passwordHash],
      client,
    );
    if (!baru) throw new Error("Penyisipan admin tidak mengembalikan baris.");

    for (const role of peran) {
      await client.query(
        `INSERT INTO admin_user_roles (admin_user_id, role_id) VALUES ($1, $2)`,
        [baru.id, role.id],
      );
    }

    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "admin_user.create",
      entityType: "admin_user",
      entityId: baru.id,
      newData: {
        username: input.username,
        email: input.email.toLowerCase(),
        full_name: input.full_name,
        roles: peran.map((row) => row.code),
      },
    });

    return { id: baru.id, roles: peran.map((row) => row.code) };
  });

  return created(
    {
      admin_user: {
        id: result.id,
        username: input.username,
        email: input.email.toLowerCase(),
        full_name: input.full_name,
        status: "active",
        roles: result.roles,
      },
      /*
        Kata sandi tidak pernah dikembalikan, dan itu dinyatakan supaya jelas bahwa admin baru
        perlu diberi tahu kata sandinya lewat jalur lain, bukan dari layar ini.
      */
      note:
        "Akun dibuat. Kata sandinya tidak ditampilkan lagi di mana pun, jadi sampaikan kepada " +
        "pemiliknya lewat jalur yang aman, atau ganti kata sandinya bila sudah terlanjur hilang.",
    },
    requestId,
  );
});

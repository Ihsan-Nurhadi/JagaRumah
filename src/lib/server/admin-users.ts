import { query, queryOne, type Queryable } from "./db";

/*
  Data admin, peran, dan izin.

  Satu aturan yang menentukan seluruh bentuk berkas ini: izin yang berlaku bagi seorang admin
  adalah gabungan izin dari seluruh perannya. Tidak ada izin yang diberikan langsung ke akun,
  sehingga untuk mengetahui apa yang boleh dilakukan seseorang, yang perlu dibaca adalah
  perannya.

  Konsekuensi yang penting dan sering terlewat: admin yang tidak punya peran sama sekali tidak
  dapat melakukan apa pun, termasuk membuka halaman yang tampaknya umum. Karena itu jumlah peran
  ikut ditampilkan di daftar, supaya akun tanpa peran langsung terlihat sebagai masalah dan bukan
  sebagai akun biasa.
*/

export type AdminUserListRow = {
  id: string;
  /* Nilai kolom pengurut, dikirim balik sebagai kursor ke halaman berikutnya. */
  cursor_value: string;
  username: string;
  email: string;
  full_name: string;
  status: string;
  is_super_admin: boolean;
  last_login_at: Date | null;
  created_at: Date;
  role_count: number;
  roles: string[];
  active_sessions: number;
};

export type AdminUserFilter = {
  status?: string;
  roleCode?: string;
  q?: string;
};

export function adminUserFilterConditions(filter: AdminUserFilter, params: unknown[]): string {
  const conditions: string[] = [];

  if (filter.status) {
    conditions.push(`AND u.status = $${params.push(filter.status)}`);
  }

  if (filter.roleCode) {
    /*
      Pencarian berdasarkan kode peran memakai EXISTS, bukan JOIN, supaya admin yang punya
      beberapa peran tidak muncul berkali-kali di daftar.
    */
    conditions.push(
      `AND EXISTS (
         SELECT 1 FROM admin_user_roles ur
         JOIN admin_roles r ON r.id = ur.role_id
         WHERE ur.admin_user_id = u.id AND r.code = $${params.push(filter.roleCode)}
       )`,
    );
  }

  if (filter.q) {
    /* Tanda persen dan garis bawah di-escape, kalau tidak pencarian "%" cocok dengan semua. */
    const pattern = `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    conditions.push(
      `AND (u.username ILIKE $${params.push(pattern)}
            OR u.email ILIKE $${params.length}
            OR u.full_name ILIKE $${params.length})`,
    );
  }

  return conditions.join("\n          ");
}

export async function findAdminUser(
  adminUserId: string,
  executor?: Queryable,
): Promise<AdminUserListRow | null> {
  return queryOne<AdminUserListRow>(
    `SELECT u.id, u.username, u.email, u.full_name, u.status, u.is_super_admin,
            u.last_login_at, u.created_at,
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
     WHERE u.id = $1`,
    [adminUserId],
    executor,
  );
}

export async function adminUserRoles(
  adminUserId: string,
  executor?: Queryable,
): Promise<{ id: string; code: string; name: string; granted_at: Date }[]> {
  return query(
    `SELECT r.id, r.code, r.name, ur.created_at AS granted_at
     FROM admin_user_roles ur
     JOIN admin_roles r ON r.id = ur.role_id
     WHERE ur.admin_user_id = $1
     ORDER BY r.code`,
    [adminUserId],
    executor,
  );
}

/*
  Izin efektif seorang admin, yaitu gabungan dari seluruh perannya.

  Ditampilkan di halaman detail karena inilah yang sebenarnya menentukan apa yang boleh dilakukan
  seseorang. Membaca daftar peran saja tidak cukup: nama peran seperti "finance" tidak
  memberitahu izin apa saja yang melekat padanya.
*/
export async function effectivePermissions(
  adminUserId: string,
  executor?: Queryable,
): Promise<{ code: string; name: string; via_roles: string[] }[]> {
  return query(
    `SELECT p.code, p.name,
            array_agg(DISTINCT r.code ORDER BY r.code) AS via_roles
     FROM admin_user_roles ur
     JOIN admin_role_permissions rp ON rp.role_id = ur.role_id
     JOIN admin_permissions p ON p.id = rp.permission_id
     JOIN admin_roles r ON r.id = ur.role_id
     WHERE ur.admin_user_id = $1
     GROUP BY p.code, p.name
     ORDER BY p.code`,
    [adminUserId],
    executor,
  );
}

export async function adminSessionsOf(
  adminUserId: string,
  executor?: Queryable,
): Promise<
  {
    id: string;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
    last_used_at: Date | null;
    expires_at: Date;
    revoked_at: Date | null;
  }[]
> {
  return query(
    `SELECT id, host(ip_address) AS ip_address, user_agent, created_at, last_used_at,
            expires_at, revoked_at
     FROM admin_sessions
     WHERE admin_user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [adminUserId],
    executor,
  );
}

/*
  Ringkasan daftar admin.

  `without_role` adalah angka yang paling perlu diperhatikan di halaman ini, tetapi hanya untuk
  akun yang bukan super admin. Super admin memperoleh seluruh izin tanpa perlu peran, sehingga
  menghitungnya sebagai "tanpa peran" akan memunculkan peringatan palsu pada akun yang justru
  paling berwenang. Kesalahan seperti itu membuat orang mengabaikan angkanya, dan itu merusak
  gunanya.
*/
export async function adminUserSummary(
  executor?: Queryable,
): Promise<{
  total: number;
  active: number;
  inactive: number;
  locked: number;
  without_role: number;
  super_admins: number;
} | null> {
  return queryOne(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'inactive')::int AS inactive,
            count(*) FILTER (WHERE status = 'locked')::int AS locked,
            count(*) FILTER (
              WHERE NOT is_super_admin
                AND NOT EXISTS (
                  SELECT 1 FROM admin_user_roles ur WHERE ur.admin_user_id = u.id
                )
            )::int AS without_role,
            count(*) FILTER (WHERE is_super_admin)::int AS super_admins
     FROM admin_users u`,
    [],
    executor,
  );
}

export type RoleRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  created_at: Date;
  permission_count: number;
  user_count: number;
  permissions: string[];
};

export async function findRole(roleId: string, executor?: Queryable): Promise<RoleRow | null> {
  return queryOne<RoleRow>(
    `SELECT r.id, r.code, r.name, r.description, r.created_at,
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
     WHERE r.id = $1`,
    [roleId],
    executor,
  );
}

/*
  Admin aktif yang dapat memakai izin tertentu, menurut keadaan database saat ini.

  Super admin ikut dihitung, karena ia memperoleh seluruh izin tanpa perlu peran. Ini satu-satunya
  sumber kebenaran untuk pertanyaan "siapa yang masih bisa melakukan ini", dan pertanyaan itu
  dipakai untuk mencegah konsol terkunci.
*/
export async function adminsWithPermission(
  permissionCode: string,
  executor?: Queryable,
): Promise<{ admin_id: string; full_name: string }[]> {
  return query(
    `SELECT DISTINCT u.id AS admin_id, u.full_name
     FROM admin_users u
     LEFT JOIN admin_user_roles ur ON ur.admin_user_id = u.id
     LEFT JOIN admin_role_permissions rp ON rp.role_id = ur.role_id
     LEFT JOIN admin_permissions p ON p.id = rp.permission_id
     WHERE u.status = 'active'
       AND (u.is_super_admin OR p.code = $1)
     ORDER BY u.full_name`,
    [permissionCode],
    executor,
  );
}

/*
  Sisa admin aktif yang masih dapat mengelola admin, bila sebuah perubahan diterapkan.

  Inilah satu-satunya pertanyaan yang perlu dijawab untuk mencegah konsol terkunci: setelah
  perubahan ini, apakah masih ada orang yang dapat mengelola admin? Selama jawabannya ada,
  perubahan apa pun boleh dilakukan, sekalipun peran yang dicabut sedang dipakai orang.

  Fungsi ini ada karena cara lain mudah salah. Memeriksa per peran menghasilkan penolakan yang
  tidak perlu, misalnya menolak mencabut izin dari peran yang sejak awal tidak memberi izin itu.
  Memeriksa per pemegang juga salah, karena pemegang yang kehilangan izin lewat satu peran bisa
  tetap memilikinya lewat peran lain, dan bisa juga tidak.

  `exceptRoleId` membuang satu peran dari perhitungan, dan `asIfAdminId` menambahkan satu admin
  seolah peran barunya memberi izin itu. Keduanya dipakai untuk menghitung keadaan sesudah
  perubahan, bukan keadaan sekarang.
*/
export async function adminsLeftAbleToManage(
  permissionCode: string,
  options: { exceptRoleId?: string; asIfAdminId?: string } = {},
  executor?: Queryable,
): Promise<{ admin_id: string; full_name: string }[]> {
  return query(
    `SELECT DISTINCT u.id AS admin_id, u.full_name
     FROM admin_users u
     LEFT JOIN admin_user_roles ur ON ur.admin_user_id = u.id
     LEFT JOIN admin_role_permissions rp ON rp.role_id = ur.role_id
     LEFT JOIN admin_permissions p ON p.id = rp.permission_id
     WHERE u.status = 'active'
       AND (
         u.is_super_admin
         OR (p.code = $1 AND ($2::uuid IS NULL OR ur.role_id <> $2::uuid))
         OR (u.id = $3::uuid AND EXISTS (
              SELECT 1 FROM admin_user_roles ur2
              JOIN admin_role_permissions rp2 ON rp2.role_id = ur2.role_id
              JOIN admin_permissions p2 ON p2.id = rp2.permission_id
              WHERE ur2.admin_user_id = u.id AND p2.code = $1
                AND ($2::uuid IS NULL OR ur2.role_id <> $2::uuid)
            ))
       )
     ORDER BY u.full_name`,
    [permissionCode, options.exceptRoleId ?? null, options.asIfAdminId ?? null],
    executor,
  );
}

/*
  Pemegang izin tertentu, dikelompokkan menurut peran yang memberikannya.

  Dipakai untuk memeriksa apakah sebuah perubahan akan menghapus pemegang terakhir sebuah izin.
  Super admin sengaja dikeluarkan dari peta ini: ia tidak menggantungkan izinnya pada peran mana
  pun, sehingga mencabut izin dari sebuah peran tidak pernah membuat super admin kehilangan
  apa pun. Pemeriksaan pemegang terakhir karena itu hanya perlu memikirkan admin biasa.
*/
export async function permissionHoldersByRole(
  permissionCode: string,
  executor?: Queryable,
): Promise<Map<string, { admin_id: string; full_name: string }[]>> {
  const rows = await query<{
    role_id: string;
    admin_id: string;
    full_name: string;
  }>(
    `SELECT r.id AS role_id, u.id AS admin_id, u.full_name
     FROM admin_roles r
     JOIN admin_role_permissions rp ON rp.role_id = r.id
     JOIN admin_permissions p ON p.id = rp.permission_id
     JOIN admin_user_roles ur ON ur.role_id = r.id
     JOIN admin_users u ON u.id = ur.admin_user_id
     WHERE p.code = $1 AND u.status = 'active' AND NOT u.is_super_admin
     ORDER BY u.full_name`,
    [permissionCode],
    executor,
  );

  const peta = new Map<string, { admin_id: string; full_name: string }[]>();
  for (const row of rows) {
    const daftar = peta.get(row.role_id) ?? [];
    daftar.push({ admin_id: row.admin_id, full_name: row.full_name });
    peta.set(row.role_id, daftar);
  }
  return peta;
}

export async function allPermissions(
  executor?: Queryable,
): Promise<{ code: string; name: string; description: string | null; role_count: number }[]> {
  return query(
    `SELECT p.code, p.name, p.description,
            (SELECT count(*)::int FROM admin_role_permissions rp WHERE rp.permission_id = p.id)
              AS role_count
     FROM admin_permissions p
     ORDER BY p.code`,
    [],
    executor,
  );
}

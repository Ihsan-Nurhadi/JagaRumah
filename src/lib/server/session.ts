import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import {
  ADMIN_ACCESS_TTL_SECONDS,
  ADMIN_REFRESH_ABSOLUTE_TTL_SECONDS,
  ADMIN_REFRESH_TTL_SECONDS,
} from "./config";
import { query, queryOne, withTransaction, type Queryable } from "./db";
import { AppError } from "./errors";

/*
  Sesi admin.

  Pembagian tugasnya:
  - Access token: JWT berumur 15 menit, tidak disimpan di database. Server cukup memeriksa
    tanda tangan dan nomor sesinya.
  - Refresh token: nilai acak 32 byte, yang disimpan hanya hash SHA-256-nya. Umurnya 8 jam
    dan dirotasi setiap dipakai, dengan batas absolut 12 jam sejak sesi pertama dibuat.

  Batas absolut itu yang membuat sesi tidak bisa diperpanjang tanpa henti. Tanpa batas itu,
  sesi yang dirotasi terus-menerus akan hidup selamanya selama penyerang rajin memakai
  tokennya, dan pencabutan role tidak akan pernah efektif.
*/

export type SessionEventType =
  | "login"
  | "refresh"
  | "logout"
  | "revoked"
  | "expired"
  | "password_changed";

export type AdminIdentity = {
  id: string;
  username: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  isSuperAdmin: boolean;
  permissions: string[];
};

export type IssuedSession = {
  sessionId: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  refreshExpiresAt: Date;
};

type AdminRow = {
  id: string;
  username: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
  is_super_admin: boolean;
};

/*
  Token disimpan dalam bentuk hash, jadi pencarian selalu lewat hash. SHA-256 dipakai, bukan
  bcrypt, karena token ini acak 256 bit: tidak ada kamus yang bisa menebaknya, sehingga
  memperlambat perbandingan justru hanya membebani setiap request.
*/
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/*
  Membaca seluruh permission efektif dari database, bukan dari token. Super admin memakai
  seluruh daftar permission yang ada, supaya penambahan permission baru otomatis berlaku
  tanpa perlu menyunting baris role.
*/
export async function loadAdminIdentity(
  adminUserId: string,
  executor?: Queryable,
): Promise<AdminIdentity | null> {
  const admin = await queryOne<AdminRow>(
    `SELECT id, username, email, full_name, avatar_url, is_super_admin
     FROM admin_users WHERE id = $1`,
    [adminUserId],
    executor,
  );
  if (!admin) return null;

  const permissions = admin.is_super_admin
    ? await query<{ code: string }>(
        "SELECT code FROM admin_permissions ORDER BY code",
        [],
        executor,
      )
    : await query<{ code: string }>(
        `SELECT DISTINCT p.code
         FROM admin_user_roles ur
         JOIN admin_role_permissions rp ON rp.role_id = ur.role_id
         JOIN admin_permissions p ON p.id = rp.permission_id
         WHERE ur.admin_user_id = $1
         ORDER BY p.code`,
        [adminUserId],
        executor,
      );

  return {
    id: admin.id,
    username: admin.username,
    email: admin.email,
    fullName: admin.full_name,
    avatarUrl: admin.avatar_url,
    isSuperAdmin: admin.is_super_admin,
    permissions: permissions.map((row) => row.code),
  };
}

export async function writeSessionEvent(
  client: PoolClient,
  input: {
    sessionId: string | null;
    adminUserId: string;
    eventType: SessionEventType;
    ipAddress: string | null;
    userAgent: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO admin_session_events
       (admin_session_id, admin_user_id, event_type, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.sessionId,
      input.adminUserId,
      input.eventType,
      input.ipAddress,
      input.userAgent,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}

/*
  Membuat sesi baru. Dipakai saat login dan saat rotasi refresh token.

  `chainStartedAt` adalah waktu sesi pertama dalam rantai rotasi. Batas absolut dihitung dari
  titik itu, bukan dari waktu rotasi terakhir.
*/
export async function createAdminSession(
  client: PoolClient,
  input: {
    adminUserId: string;
    chainStartedAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  },
): Promise<IssuedSession> {
  const now = Date.now();
  const refreshExpiresAt = new Date(
    Math.min(
      now + ADMIN_REFRESH_TTL_SECONDS * 1000,
      input.chainStartedAt.getTime() + ADMIN_REFRESH_ABSOLUTE_TTL_SECONDS * 1000,
    ),
  );

  if (refreshExpiresAt.getTime() <= now) {
    throw new AppError({
      code: "TOKEN_EXPIRED",
      message:
        "Sesi ini sudah mencapai batas waktu maksimal 12 jam. Masuk kembali untuk melanjutkan.",
    });
  }

  const refreshToken = newRefreshToken();
  const result = await client.query<{ id: string }>(
    `INSERT INTO admin_sessions
       (admin_user_id, refresh_token_hash, ip_address, user_agent, expires_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING id`,
    [
      input.adminUserId,
      hashRefreshToken(refreshToken),
      input.ipAddress,
      input.userAgent,
      refreshExpiresAt.toISOString(),
    ],
  );

  return {
    sessionId: result.rows[0].id,
    refreshToken,
    accessExpiresInSeconds: ADMIN_ACCESS_TTL_SECONDS,
    refreshExpiresAt,
  };
}

/*
  Menelusuri akar rantai rotasi. Dipakai untuk menegakkan batas absolut 12 jam dan untuk
  mencabut seluruh rantai saat token lama dipakai ulang.
*/
async function sessionChain(
  client: PoolClient,
  sessionId: string,
): Promise<{ ids: string[]; startedAt: Date }> {
  const result = await client.query<{ id: string; created_at: Date }>(
    `WITH RECURSIVE chain AS (
       SELECT id, replaced_by_session_id, created_at
       FROM admin_sessions WHERE id = $1
       UNION ALL
       SELECT s.id, s.replaced_by_session_id, s.created_at
       FROM admin_sessions s
       JOIN chain c ON s.replaced_by_session_id = c.id
     )
     SELECT id, created_at FROM chain`,
    [sessionId],
  );

  if (result.rowCount === 0) {
    throw new AppError({
      code: "TOKEN_REVOKED",
      message: "Sesi tidak ditemukan. Masuk kembali untuk melanjutkan.",
    });
  }

  const startedAt = result.rows.reduce(
    (oldest, row) => (row.created_at < oldest ? row.created_at : oldest),
    result.rows[0].created_at,
  );

  return { ids: result.rows.map((row) => row.id), startedAt };
}

export type RotatedSession = IssuedSession & {
  previousSessionId: string;
  adminUserId: string;
};

/*
  Rotasi refresh token.

  Tiga hal yang ditangani sekaligus:
  1. Token yang tidak dikenal ditolak.
  2. Token yang sudah dipakai lalu dipakai lagi dianggap pencurian. Seluruh rantai sesinya
     dicabut, termasuk sesi yang sedang aktif, karena tidak ada cara mengetahui pemegang yang
     sah adalah pemanggil sekarang atau sebelumnya.
  3. Token yang lewat masa berlaku dicatat sebagai `expired` supaya pertanyaan "kenapa sesi
     ini berakhir" punya jawaban di halaman audit.
*/
export async function rotateAdminSession(input: {
  refreshToken: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<RotatedSession> {
  const tokenHash = hashRefreshToken(input.refreshToken);

  return withTransaction(async (client) => {
    const existing = await client.query<{
      id: string;
      admin_user_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      replaced_by_session_id: string | null;
      user_agent: string | null;
    }>(
      `SELECT id, admin_user_id, expires_at, revoked_at, replaced_by_session_id, user_agent
       FROM admin_sessions
       WHERE refresh_token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );

    const session = existing.rows[0];
    if (!session) {
      throw new AppError({
        code: "TOKEN_REVOKED",
        message: "Sesi tidak dikenali. Masuk kembali untuk melanjutkan.",
      });
    }

    if (session.revoked_at !== null) {
      // Sesi yang sudah digantikan lalu dipakai lagi berarti tokennya pernah tersalin.
      if (session.replaced_by_session_id !== null) {
        const chain = await sessionChain(client, session.id);
        await client.query(
          `UPDATE admin_sessions SET revoked_at = now()
           WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`,
          [chain.ids],
        );
        await writeSessionEvent(client, {
          sessionId: session.id,
          adminUserId: session.admin_user_id,
          eventType: "revoked",
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          metadata: { reason: "refresh_token_reuse", chain_length: chain.ids.length },
        });
      }

      throw new AppError({
        code: "TOKEN_REVOKED",
        message:
          "Sesi ini sudah tidak berlaku. Jika Anda tidak keluar sendiri, segera ganti kata sandi " +
          "karena token sesi Anda kemungkinan tersalin.",
      });
    }

    if (session.expires_at.getTime() <= Date.now()) {
      await client.query("UPDATE admin_sessions SET revoked_at = now() WHERE id = $1", [
        session.id,
      ]);
      await writeSessionEvent(client, {
        sessionId: session.id,
        adminUserId: session.admin_user_id,
        eventType: "expired",
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      throw new AppError({
        code: "TOKEN_EXPIRED",
        message: "Sesi Anda sudah berakhir. Masuk kembali untuk melanjutkan.",
      });
    }

    const chain = await sessionChain(client, session.id);
    const issued = await createAdminSession(client, {
      adminUserId: session.admin_user_id,
      chainStartedAt: chain.startedAt,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    await client.query(
      `UPDATE admin_sessions
       SET revoked_at = now(), replaced_by_session_id = $2, last_used_at = now()
       WHERE id = $1`,
      [session.id, issued.sessionId],
    );

    await writeSessionEvent(client, {
      sessionId: issued.sessionId,
      adminUserId: session.admin_user_id,
      eventType: "refresh",
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      metadata: { previous_session_id: session.id },
    });

    return { ...issued, previousSessionId: session.id, adminUserId: session.admin_user_id };
  });
}

/*
  Menutup sesi sendiri. Peristiwanya dicatat meski tidak ada data yang berubah, karena tanpa
  catatan ini pertanyaan "apakah sesi ini benar-benar ditutup" tidak bisa dijawab.
*/
export async function revokeOwnSession(input: {
  sessionId: string;
  adminUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query(
      "UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [input.sessionId],
    );

    await writeSessionEvent(client, {
      sessionId: input.sessionId,
      adminUserId: input.adminUserId,
      eventType: "logout",
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      metadata: result.rowCount === 0 ? { already_revoked: true } : undefined,
    });
  });
}

export type ActiveSession = {
  identity: AdminIdentity;
  sessionId: string;
  expiresAt: Date;
};

/*
  Memeriksa access token sekaligus keadaannya di database.

  Status akun dan status sesi diperiksa setiap kali. Token yang masih berlaku secara
  kriptografis tetap ditolak kalau akunnya dinonaktifkan atau sesinya dicabut, sehingga
  pencabutan berlaku seketika dan tidak menunggu 15 menit.
*/
export async function loadActiveSession(input: {
  adminUserId: string;
  sessionId: string;
}): Promise<ActiveSession | null> {
  const session = await queryOne<{
    id: string;
    admin_user_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    status: string;
  }>(
    `SELECT s.id, s.admin_user_id, s.expires_at, s.revoked_at, u.status
     FROM admin_sessions s
     JOIN admin_users u ON u.id = s.admin_user_id
     WHERE s.id = $1 AND s.admin_user_id = $2`,
    [input.sessionId, input.adminUserId],
  );

  if (!session || session.revoked_at !== null || session.expires_at.getTime() <= Date.now()) {
    return null;
  }
  if (session.status !== "active") return null;

  const identity = await loadAdminIdentity(session.admin_user_id);
  if (!identity) return null;

  return { identity, sessionId: session.id, expiresAt: session.expires_at };
}

import type { PoolClient } from "pg";
import {
  LOGIN_ACCOUNT_MAX_FAILURES,
  LOGIN_IP_MAX_FAILURES,
  LOGIN_WINDOW_MINUTES,
} from "./config";
import { queryOne, withTransaction } from "./db";
import { AppError } from "./errors";
import { burnPasswordTime, verifyPassword } from "./password";
import {
  createAdminSession,
  loadAdminIdentity,
  writeSessionEvent,
  type AdminIdentity,
  type IssuedSession,
} from "./session";

/*
  Masuk admin.

  Dua hal yang dijaga di sini:

  1. Pembatasan percobaan. Dihitung per akun dan per IP. Per akun saja tidak cukup karena
     penyerang bisa menyebar ke banyak akun dari satu mesin; per IP saja tidak cukup karena
     satu IP bisa dipakai menyerang satu akun dengan pelan.

  2. Pesan galat yang seragam. Email yang tidak terdaftar dan kata sandi yang salah sama-sama
     dibalas "email atau kata sandi salah", dan waktu prosesnya disamakan dengan menjalankan
     hash tiruan saat email tidak ditemukan. Tanpa keduanya, halaman login bisa dipakai
     memastikan email mana yang punya akun admin di sini.
*/

export type LoginResult = {
  identity: AdminIdentity;
  issued: IssuedSession;
};

const ACCOUNT_FAILURE_REASON = {
  UNKNOWN_USER: "unknown_user",
  WRONG_PASSWORD: "wrong_password",
  INACTIVE: "inactive",
  LOCKED: "locked",
  RATE_LIMITED: "rate_limited",
} as const;

type FailureReason = (typeof ACCOUNT_FAILURE_REASON)[keyof typeof ACCOUNT_FAILURE_REASON];

/*
  Kegagalan dihitung sejak keberhasilan terakhir, bukan sekadar dalam rentang waktu. Bedanya
  penting: dengan cara ini, admin yang berhasil masuk di tengah serangan tidak mewarisi
  hitungan lama, sedangkan penyerang tidak bisa mereset hitungannya sendiri.
*/
async function consecutiveFailures(input: {
  username: string | null;
  ipAddress: string | null;
}): Promise<{ account: number; ip: number; retryAfterSeconds: number }> {
  const windowInterval = `${LOGIN_WINDOW_MINUTES} minutes`;

  const account = input.username
    ? await queryOne<{ failures: number; oldest: Date | null }>(
        `SELECT count(*)::int AS failures, min(created_at) AS oldest
         FROM admin_login_attempts
         WHERE username_attempted = $1
           AND success = false
           AND created_at > now() - $2::interval
           AND created_at > COALESCE(
             (SELECT max(created_at) FROM admin_login_attempts
              WHERE username_attempted = $1 AND success), '-infinity'::timestamptz)`,
        [input.username, windowInterval],
      )
    : null;

  const ip = input.ipAddress
    ? await queryOne<{ failures: number; oldest: Date | null }>(
        `SELECT count(*)::int AS failures, min(created_at) AS oldest
         FROM admin_login_attempts
         WHERE ip_address = $1
           AND success = false
           AND created_at > now() - $2::interval`,
        [input.ipAddress, windowInterval],
      )
    : null;

  const oldest = [account?.oldest, ip?.oldest]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  // Retry-After dihitung dari kegagalan tertua, karena hitungan baru turun setelah catatan itu
  // keluar dari rentang waktu.
  const retryAfterSeconds = oldest
    ? Math.max(
        1,
        Math.ceil(
          (oldest.getTime() + LOGIN_WINDOW_MINUTES * 60_000 - Date.now()) / 1000,
        ),
      )
    : LOGIN_WINDOW_MINUTES * 60;

  return {
    account: account?.failures ?? 0,
    ip: ip?.failures ?? 0,
    retryAfterSeconds,
  };
}

async function recordAttempt(
  client: PoolClient,
  input: {
    adminUserId: string | null;
    username: string;
    ipAddress: string | null;
    success: boolean;
    failureReason: FailureReason | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO admin_login_attempts
       (admin_user_id, username_attempted, ip_address, success, failure_reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.adminUserId,
      input.username,
      input.ipAddress,
      input.success,
      input.failureReason,
    ],
  );
}

/*
  Kegagalan dicatat di transaksi terpisah dari pemeriksaan, karena pemeriksaan itu sendiri
  tidak mengubah data. Kalau pencatatan gagal, permintaan tetap dilanjutkan: menolak login
  hanya karena tabel catatan bermasalah akan mengunci semua orang keluar.
*/
async function noteFailure(input: {
  adminUserId: string | null;
  username: string;
  ipAddress: string | null;
  reason: FailureReason;
}): Promise<void> {
  try {
    await withTransaction((client) =>
      recordAttempt(client, { ...input, success: false, failureReason: input.reason }),
    );
  } catch (error) {
    console.error("[login] gagal mencatat percobaan login:", error);
  }
}

const INVALID_CREDENTIALS_MESSAGE = "Email atau kata sandi salah. Periksa keduanya lalu coba lagi.";

export async function login(input: {
  email: string;
  password: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  const failures = await consecutiveFailures({ username: email, ipAddress: input.ipAddress });

  if (failures.ip >= LOGIN_IP_MAX_FAILURES) {
    await noteFailure({
      adminUserId: null,
      username: email,
      ipAddress: input.ipAddress,
      reason: ACCOUNT_FAILURE_REASON.RATE_LIMITED,
    });
    throw new AppError({
      code: "AUTH_RATE_LIMITED",
      message:
        `Terlalu banyak percobaan masuk dari jaringan ini. Coba lagi dalam ` +
        `${Math.ceil(failures.retryAfterSeconds / 60)} menit.`,
      headers: { "Retry-After": String(failures.retryAfterSeconds) },
    });
  }

  const admin = await queryOne<{
    id: string;
    password_hash: string;
    status: string;
  }>(
    "SELECT id, password_hash, status FROM admin_users WHERE email = $1",
    [email],
  );

  if (!admin) {
    // Waktu proses disamakan dengan kasus kata sandi salah, supaya selisih waktunya tidak
    // memberi tahu bahwa email ini tidak terdaftar.
    await burnPasswordTime(input.password);
    await noteFailure({
      adminUserId: null,
      username: email,
      ipAddress: input.ipAddress,
      reason: ACCOUNT_FAILURE_REASON.UNKNOWN_USER,
    });
    throw new AppError({ code: "INVALID_CREDENTIALS", message: INVALID_CREDENTIALS_MESSAGE });
  }

  if (failures.account >= LOGIN_ACCOUNT_MAX_FAILURES) {
    await noteFailure({
      adminUserId: admin.id,
      username: email,
      ipAddress: input.ipAddress,
      reason: ACCOUNT_FAILURE_REASON.RATE_LIMITED,
    });
    throw new AppError({
      code: "AUTH_RATE_LIMITED",
      message:
        `Akun ini terkunci sementara karena ${failures.account} percobaan masuk yang gagal. ` +
        `Coba lagi dalam ${Math.ceil(failures.retryAfterSeconds / 60)} menit, atau minta admin ` +
        `lain membuka kuncinya dari halaman /admin-users.`,
      headers: { "Retry-After": String(failures.retryAfterSeconds) },
    });
  }

  const passwordMatches = await verifyPassword(input.password, admin.password_hash);
  if (!passwordMatches) {
    await noteFailure({
      adminUserId: admin.id,
      username: email,
      ipAddress: input.ipAddress,
      reason: ACCOUNT_FAILURE_REASON.WRONG_PASSWORD,
    });
    throw new AppError({ code: "INVALID_CREDENTIALS", message: INVALID_CREDENTIALS_MESSAGE });
  }

  /*
    Status akun diperiksa setelah kata sandi cocok, bukan sebelum. Urutan ini membuat pesan
    "akun dinonaktifkan" hanya muncul bagi orang yang memang tahu kata sandinya.
  */
  if (admin.status !== "active") {
    const reason =
      admin.status === "locked"
        ? ACCOUNT_FAILURE_REASON.LOCKED
        : ACCOUNT_FAILURE_REASON.INACTIVE;
    await noteFailure({
      adminUserId: admin.id,
      username: email,
      ipAddress: input.ipAddress,
      reason,
    });
    throw new AppError({
      code: "PERMISSION_DENIED",
      message:
        admin.status === "locked"
          ? "Akun ini sedang terkunci. Minta super admin membuka kuncinya dari halaman /admin-users."
          : "Akun ini sudah dinonaktifkan. Minta super admin mengaktifkannya kembali.",
    });
  }

  return withTransaction(async (client) => {
    await recordAttempt(client, {
      adminUserId: admin.id,
      username: email,
      ipAddress: input.ipAddress,
      success: true,
      failureReason: null,
    });

    const issued = await createAdminSession(client, {
      adminUserId: admin.id,
      chainStartedAt: new Date(),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    await client.query("UPDATE admin_users SET last_login_at = now() WHERE id = $1", [admin.id]);

    /*
      Peristiwa login ditulis dengan nomor sesi yang sebenarnya. Kolomnya tetap nullable
      karena baris sesi bisa terhapus sementara catatan peristiwanya harus tetap ada.
    */
    await writeSessionEvent(client, {
      sessionId: issued.sessionId,
      adminUserId: admin.id,
      eventType: "login",
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    const identity = await loadAdminIdentity(admin.id, client);
    if (!identity) {
      throw new AppError({
        code: "INTERNAL_ERROR",
        message: "Akun ini hilang saat sesi dibuat. Coba masuk sekali lagi.",
      });
    }

    return { identity, issued };
  });
}

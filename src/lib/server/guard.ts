import { cookies } from "next/headers";
import {
  COOKIE_ADMIN_ACCESS,
  COOKIE_ADMIN_CSRF,
  COOKIE_ADMIN_REFRESH,
  HEADER_CSRF,
  cookieSecure,
} from "./config";
import { isCsrfTokenValid } from "./csrf";
import { AppError } from "./errors";
import { clientIp, cookieOptions, readCookie, userAgent } from "./request";
import { loadActiveSession, type AdminIdentity, type ActiveSession } from "./session";
import { verifyAdminAccessToken } from "./token";

/*
  Penjaga akses untuk seluruh endpoint admin.

  Dua lapis diperiksa dan keduanya diperlukan:
  1. Tanda tangan access token, supaya permintaan dengan token palsu ditolak tanpa menyentuh
     database.
  2. Keadaan sesi dan akun di database, supaya pencabutan sesi dan penonaktifan akun berlaku
     seketika, bukan menunggu access token kedaluwarsa 15 menit lagi.

  Lapis kedua inilah yang membuat janji "server tetap memeriksa status dan permission terbaru"
  di API_Contract.md bisa ditepati.
*/

export type AdminContext = {
  identity: AdminIdentity;
  sessionId: string;
  ipAddress: string | null;
  userAgent: string | null;
};

export async function currentAdmin(): Promise<AdminContext | null> {
  const token = await readCookie(COOKIE_ADMIN_ACCESS);
  if (!token) return null;

  let claims;
  try {
    claims = await verifyAdminAccessToken(token);
  } catch {
    // Token kedaluwarsa atau rusak bukan kegagalan server. Klien akan mencoba refresh.
    return null;
  }

  const active: ActiveSession | null = await loadActiveSession({
    adminUserId: claims.adminUserId,
    sessionId: claims.sessionId,
  });
  if (!active) return null;

  return {
    identity: active.identity,
    sessionId: active.sessionId,
    ipAddress: await clientIp(),
    userAgent: await userAgent(),
  };
}

/*
  Dipakai endpoint yang wajib login. Pesannya menyebut langkah berikutnya, bukan sekadar
  "unauthorized".
*/
export async function requireAdmin(): Promise<AdminContext> {
  const admin = await currentAdmin();
  if (!admin) {
    throw new AppError({
      code: "TOKEN_EXPIRED",
      message: "Sesi Anda sudah berakhir. Masuk kembali untuk melanjutkan.",
    });
  }
  return admin;
}

export function requirePermission(admin: AdminContext, permission: string): void {
  if (admin.identity.permissions.includes(permission)) return;

  throw new AppError({
    code: "PERMISSION_DENIED",
    message:
      `Akun Anda tidak memiliki izin "${permission}" yang dibutuhkan untuk tindakan ini. ` +
      `Minta admin lain menambahkan izin tersebut lewat halaman /admin-users.`,
    details: { required_permission: permission },
  });
}

/*
  Pemeriksaan CSRF untuk setiap mutasi berbasis cookie.

  Dijalankan setelah login diperiksa, karena urutan pesan galat menentukan langkah yang harus
  diambil klien: belum masuk dan token CSRF salah adalah dua hal berbeda.
*/
export async function requireCsrf(request: Request): Promise<void> {
  const cookieValue = await readCookie(COOKIE_ADMIN_CSRF);
  const headerValue = request.headers.get(HEADER_CSRF);

  if (!isCsrfTokenValid(cookieValue, headerValue)) {
    throw new AppError({
      code: "CSRF_TOKEN_INVALID",
      message:
        "Token keamanan formulir tidak cocok atau sudah kedaluwarsa. Muat ulang halaman lalu " +
        "ulangi tindakan ini.",
    });
  }
}

// ------------------------------------------------------------------ penulisan cookie

export async function setAdminCookies(input: {
  accessToken: string;
  refreshToken: string;
  accessMaxAgeSeconds: number;
  refreshExpiresAt: Date;
  csrfToken: string;
  /*
    Diisi hanya saat keluar. Umur token CSRF dipisahkan dari umur access token supaya halaman
    login yang muncul setelah keluar tetap punya token yang berlaku, bukan token yang ikut
    kedaluwarsa bersama sesi yang baru saja ditutup.
  */
  csrfMaxAgeSeconds?: number;
}): Promise<void> {
  const store = await cookies();
  const secure = cookieSecure();

  store.set(
    COOKIE_ADMIN_ACCESS,
    input.accessToken,
    cookieOptions({
      path: "/",
      maxAgeSeconds: input.accessMaxAgeSeconds,
      secure,
      httpOnly: true,
    }),
  );

  /*
    Path refresh cookie sengaja dibatasi ke /api/v1/admin/auth. Dengan begitu cookie ini tidak
    ikut terkirim pada setiap request halaman, sehingga peluangnya tersadap jauh lebih kecil.
  */
  const refreshMaxAge = Math.max(
    0,
    Math.floor((input.refreshExpiresAt.getTime() - Date.now()) / 1000),
  );
  store.set(
    COOKIE_ADMIN_REFRESH,
    input.refreshToken,
    cookieOptions({
      path: "/api/v1/admin/auth",
      maxAgeSeconds: refreshMaxAge,
      secure,
      httpOnly: true,
    }),
  );

  /*
    Cookie CSRF tidak HttpOnly karena klien harus bisa membacanya untuk dikirim balik sebagai
    header. Isinya bukan rahasia sesi: yang membuatnya berguna justru keharusan menebaknya
    dari domain lain, dan itu tidak mungkin tanpa bisa membaca cookie ini.
  */
  store.set(
    COOKIE_ADMIN_CSRF,
    input.csrfToken,
    cookieOptions({
      path: "/",
      maxAgeSeconds: input.csrfMaxAgeSeconds ?? input.accessMaxAgeSeconds,
      secure,
      httpOnly: false,
    }),
  );
}

export async function clearAdminCookies(): Promise<void> {
  const store = await cookies();
  store.delete({ name: COOKIE_ADMIN_ACCESS, path: "/" });
  store.delete({ name: COOKIE_ADMIN_REFRESH, path: "/api/v1/admin/auth" });
  store.delete({ name: COOKIE_ADMIN_CSRF, path: "/" });
}

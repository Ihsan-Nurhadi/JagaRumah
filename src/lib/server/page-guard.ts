import { cookies } from "next/headers";
import { COOKIE_ADMIN_ACCESS, COOKIE_ADMIN_REFRESH } from "./config";
import { verifyAdminAccessToken } from "./token";

/*
  Pemeriksaan sesi untuk halaman server, bukan untuk API.

  Aturan yang dipakai: halaman admin boleh dirender kalau salah satu dari dua hal ini benar.

  1. Access token ada dan tanda tangannya sah.
  2. Access token tidak ada atau sudah kedaluwarsa, tetapi cookie refresh masih ada. Klien
     akan memakainya untuk memperpanjang sesi lewat /api/v1/admin/auth/refresh.

  Aturan kedua itu yang membuat sesi 15 menit tidak berarti login ulang setiap 15 menit.
  Kalau halaman ini hanya menerima access token yang masih sah, admin yang sedang membaca
  tabel akan terlempar ke halaman login di tengah pekerjaannya.

  Batasnya harus tegas: hasil fungsi ini menentukan kerangka mana yang dirender, bukan data apa
  yang boleh keluar. Tidak ada data yang diambil di sini. Seluruh data datang dari endpoint API
  yang memeriksa sesi, status akun, dan permission secara penuh ke database. Cookie refresh
  yang dipalsukan hanya menghasilkan kerangka kosong, bukan satu baris data pun.
*/

export type PageSession = {
  adminUserId: string | null;
  sessionId: string | null;
  accessTokenValid: boolean;
};

export async function getPageSession(): Promise<PageSession | null> {
  const store = await cookies();
  const accessToken = store.get(COOKIE_ADMIN_ACCESS)?.value;

  if (accessToken) {
    try {
      const claims = await verifyAdminAccessToken(accessToken);
      return {
        adminUserId: claims.adminUserId,
        sessionId: claims.sessionId,
        accessTokenValid: true,
      };
    } catch {
      // Diteruskan ke pemeriksaan cookie refresh di bawah.
    }
  }

  if (store.get(COOKIE_ADMIN_REFRESH)?.value) {
    return { adminUserId: null, sessionId: null, accessTokenValid: false };
  }

  return null;
}

import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_ADMIN_ACCESS, COOKIE_ADMIN_REFRESH } from "@/lib/server/config";
import { verifyAdminAccessToken } from "@/lib/server/token";

/*
  Penjaga rute halaman.

  Tugas proxy di sini sengaja dibatasi pada satu hal: memutuskan apakah kerangka halaman admin
  boleh dirender. Tidak ada database yang disentuh, sesuai catatan dokumentasi Next.js bahwa
  proxy bukan tempat mengelola sesi.

  Aturan lolosnya ada dua, dan yang kedua itu yang membuat sesi 15 menit tidak berarti login
  ulang setiap 15 menit:

  1. Access token ada dan tanda tangannya sah.
  2. Access token tidak ada atau sudah kedaluwarsa, tetapi cookie refresh masih ada. Klien akan
     memperpanjang sesinya lewat /api/v1/admin/auth/refresh saat halaman dimuat.

  Yang tidak dilakukan di sini adalah otorisasi. Permission, status akun, dan keadaan sesi
  diperiksa di setiap endpoint API. Proxy hanya menyembunyikan antarmuka; kalau proxy suatu saat
  dilewati, tidak ada satu baris data pun yang terbuka karenanya.

  Cookie refresh yang dipalsukan hanya menghasilkan kerangka halaman kosong. Halaman itu akan
  menampilkan keadaan "sesi tidak dikenali" begitu permintaan datanya ditolak server.
*/
const PUBLIC_PATHS = ["/login"];

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const accessToken = request.cookies.get(COOKIE_ADMIN_ACCESS)?.value;

  if (accessToken) {
    try {
      await verifyAdminAccessToken(accessToken);
      return NextResponse.next();
    } catch {
      /*
        Token rusak atau kedaluwarsa. Cookie-nya tidak dihapus di sini, karena percobaan
        perpanjangan sesi masih mungkin berhasil dan cookie refresh berada di path yang berbeda.
        Kalau perpanjangan gagal, klien yang akan mengalihkan ke /login.
      */
      if (request.cookies.get(COOKIE_ADMIN_REFRESH)?.value) return NextResponse.next();
    }
  } else if (request.cookies.get(COOKIE_ADMIN_REFRESH)?.value) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") {
    // Tujuan awal disimpan supaya admin mendarat kembali di halaman yang tadi dibuka.
    loginUrl.searchParams.set("lanjut", `${pathname}${search}`);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
      Seluruh halaman disaring, kecuali aset statis dan endpoint API. Endpoint API memeriksa
      sesinya sendiri dan membalas JSON, jadi mengalihkannya ke halaman login akan merusak
      pemanggilnya.
    */
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

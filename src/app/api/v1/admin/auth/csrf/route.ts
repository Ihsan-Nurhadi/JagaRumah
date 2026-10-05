import { cookies } from "next/headers";
import { ADMIN_ACCESS_TTL_SECONDS, COOKIE_ADMIN_CSRF, HEADER_CSRF, cookieSecure } from "@/lib/server/config";
import { issueCsrfToken } from "@/lib/server/csrf";
import { ok, cookieOptions } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

/*
  Token CSRF untuk mutasi berbasis cookie.

  Satu endpoint mengembalikan token sekaligus menuliskannya ke cookie, karena keduanya harus
  selalu berasal dari nilai yang sama. Kalau dipisah, akan ada jeda di mana halaman memegang
  token lama sementara cookie sudah berisi token baru, dan setiap mutasi gagal tanpa sebab
  yang jelas bagi pengguna.

  Endpoint ini tidak butuh login, karena halaman login sendiri perlu token ini sebelum ada sesi.
*/
export const GET = routeHandler("admin.auth.csrf", async (_request, requestId) => {
  const token = issueCsrfToken();

  const store = await cookies();
  store.set(
    COOKIE_ADMIN_CSRF,
    token,
    cookieOptions({
      path: "/",
      maxAgeSeconds: ADMIN_ACCESS_TTL_SECONDS,
      secure: cookieSecure(),
      // Klien harus bisa membaca nilainya untuk dikirim balik lewat header.
      httpOnly: false,
    }),
  );

  return ok(
    {
      csrf_token: token,
      header_name: HEADER_CSRF,
      // Klien perlu tahu kapan harus meminta token baru, tanpa menunggu kegagalan pertama.
      expires_in_seconds: ADMIN_ACCESS_TTL_SECONDS,
    },
    requestId,
  );
});

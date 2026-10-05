import { ADMIN_ACCESS_TTL_SECONDS, COOKIE_ADMIN_REFRESH } from "@/lib/server/config";
import { requireCsrf, setAdminCookies } from "@/lib/server/guard";
import { issueCsrfToken } from "@/lib/server/csrf";
import { clientIp, ok, readCookie, userAgent } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { hashRefreshToken, revokeOwnSession } from "@/lib/server/session";
import { queryOne } from "@/lib/server/db";

/*
  Keluar.

  Sesi dicabut di database, bukan hanya cookie-nya dihapus. Menghapus cookie saja membuat
  refresh token tetap sah sampai masa berlakunya habis, sehingga token yang sudah tersalin
  masih bisa dipakai memperpanjang sesi meski pengguna merasa sudah keluar.

  Cookie juga diterbitkan ulang sebagai kosong supaya browser langsung berhenti mengirimkannya.
*/
export const POST = routeHandler("admin.auth.logout", async (request, requestId) => {
  await requireCsrf(request);

  const refreshToken = await readCookie(COOKIE_ADMIN_REFRESH);

  if (refreshToken) {
    const session = await queryOne<{ id: string; admin_user_id: string }>(
      "SELECT id, admin_user_id FROM admin_sessions WHERE refresh_token_hash = $1",
      [hashRefreshToken(refreshToken)],
    );

    if (session) {
      const [ipAddress, agent] = await Promise.all([clientIp(), userAgent()]);
      await revokeOwnSession({
        sessionId: session.id,
        adminUserId: session.admin_user_id,
        ipAddress,
        userAgent: agent,
      });
    }
  }

  /*
    Cookie CSRF diterbitkan ulang dengan umur normal, bukan dikosongkan bersama token sesi.
    Halaman login yang muncul setelah keluar membutuhkan token ini, dan memberikannya sekarang
    menghindari satu perjalanan bolak-balik yang tidak perlu.

    Cookie sesi dikosongkan dengan cara menimpanya bernilai kosong dan umur nol. `store.delete`
    tidak dipakai karena menghapus cookie tanpa atribut path yang sama dengan saat ditulis akan
    meninggalkan cookie aslinya utuh di browser.
  */
  const csrfToken = issueCsrfToken();
  await setAdminCookies({
    accessToken: "",
    refreshToken: "",
    accessMaxAgeSeconds: 0,
    refreshExpiresAt: new Date(),
    csrfToken,
    csrfMaxAgeSeconds: ADMIN_ACCESS_TTL_SECONDS,
  });

  return ok({ signed_out: true, csrf_token: csrfToken }, requestId);
});

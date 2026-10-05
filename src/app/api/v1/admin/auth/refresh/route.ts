import { issueCsrfToken } from "@/lib/server/csrf";
import { AppError } from "@/lib/server/errors";
import { requireCsrf, setAdminCookies } from "@/lib/server/guard";
import { clientIp, ok, readCookie, userAgent } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { COOKIE_ADMIN_REFRESH } from "@/lib/server/config";
import { loadAdminIdentity, rotateAdminSession } from "@/lib/server/session";
import { signAdminAccessToken } from "@/lib/server/token";

/*
  Rotasi refresh token.

  Dipanggil klien ketika access token sudah kedaluwarsa. Cookie refresh dibatasi pada path ini,
  jadi hanya endpoint ini yang menerimanya.

  Token akses dan token CSRF sama-sama diterbitkan ulang, karena keduanya memiliki umur yang
  sama. Mengganti satu tanpa yang lain akan menyisakan token CSRF yang hampir kedaluwarsa
  menempel pada sesi yang baru saja diperpanjang.
*/
export const POST = routeHandler("admin.auth.refresh", async (request, requestId) => {
  await requireCsrf(request);

  const refreshToken = await readCookie(COOKIE_ADMIN_REFRESH);
  if (!refreshToken) {
    throw new AppError({
      code: "TOKEN_REVOKED",
      message: "Tidak ada sesi yang bisa diperpanjang. Masuk kembali untuk melanjutkan.",
    });
  }

  const [ipAddress, agent] = await Promise.all([clientIp(), userAgent()]);
  const rotated = await rotateAdminSession({ refreshToken, ipAddress, userAgent: agent });

  /*
    Identitas dibaca setelah transaksi rotasi selesai. Nomor adminnya sudah ikut dikembalikan
    fungsi rotasi, jadi tidak perlu kueri tambahan hanya untuk mencarinya.
  */
  const identity = await loadAdminIdentity(rotated.adminUserId);
  if (!identity) {
    throw new AppError({
      code: "TOKEN_REVOKED",
      message: "Sesi ini tidak lagi terhubung ke akun mana pun. Masuk kembali untuk melanjutkan.",
    });
  }

  const accessToken = await signAdminAccessToken({
    adminUserId: identity.id,
    sessionId: rotated.sessionId,
  });

  const csrfToken = issueCsrfToken();

  await setAdminCookies({
    accessToken,
    refreshToken: rotated.refreshToken,
    accessMaxAgeSeconds: rotated.accessExpiresInSeconds,
    refreshExpiresAt: rotated.refreshExpiresAt,
    csrfToken,
  });

  return ok(
    {
      admin: {
        id: identity.id,
        username: identity.username,
        email: identity.email,
        full_name: identity.fullName,
        avatar_url: identity.avatarUrl,
        is_super_admin: identity.isSuperAdmin,
      },
      permissions: identity.permissions,
      session: {
        session_id: rotated.sessionId,
        access_expires_in_seconds: rotated.accessExpiresInSeconds,
        refresh_expires_at: rotated.refreshExpiresAt.toISOString(),
      },
      csrf_token: csrfToken,
    },
    requestId,
  );
});

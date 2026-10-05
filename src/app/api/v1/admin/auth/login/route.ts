import { adminLoginSchema } from "@/lib/schemas/admin-auth";
import { issueCsrfToken } from "@/lib/server/csrf";
import { requireCsrf, setAdminCookies } from "@/lib/server/guard";
import { login } from "@/lib/server/login";
import { parseJson } from "@/lib/server/parse";
import { clientIp, ok, userAgent } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { signAdminAccessToken } from "@/lib/server/token";

/*
  Masuk admin.

  Token tidak pernah dikirim di body, hanya lewat cookie HttpOnly, sehingga skrip di halaman
  tidak bisa membacanya. Body response hanya memuat profil dan daftar permission, yang memang
  dibutuhkan antarmuka untuk menyembunyikan menu yang tidak boleh dipakai.

  Token CSRF diperiksa walaupun belum ada sesi, supaya halaman lain tidak bisa memaksa browser
  admin melakukan login ke akun milik penyerang.
*/
export const POST = routeHandler("admin.auth.login", async (request, requestId) => {
  await requireCsrf(request);

  const body = await parseJson(request, adminLoginSchema);
  const [ipAddress, agent] = await Promise.all([clientIp(), userAgent()]);

  const { identity, issued } = await login({
    email: body.email,
    password: body.password,
    ipAddress,
    userAgent: agent,
  });

  const accessToken = await signAdminAccessToken({
    adminUserId: identity.id,
    sessionId: issued.sessionId,
  });

  /*
    Token CSRF diterbitkan ulang saat login. Token lama mungkin sudah berpindah tangan saat
    halaman login dibuka di perangkat bersama, dan mengulanginya berarti sesi baru mewarisi
    risiko dari halaman sebelum ada sesi.
  */
  const csrfToken = issueCsrfToken();

  await setAdminCookies({
    accessToken,
    refreshToken: issued.refreshToken,
    accessMaxAgeSeconds: issued.accessExpiresInSeconds,
    refreshExpiresAt: issued.refreshExpiresAt,
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
        session_id: issued.sessionId,
        access_expires_in_seconds: issued.accessExpiresInSeconds,
        refresh_expires_at: issued.refreshExpiresAt.toISOString(),
      },
      csrf_token: csrfToken,
    },
    requestId,
  );
});

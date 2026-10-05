import { requireAdmin } from "@/lib/server/guard";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

/*
  Profil admin yang sedang masuk.

  Halaman admin memanggil ini sekali saat dimuat untuk memastikan sesi masih berlaku dan untuk
  mendapatkan daftar permission terbaru. Permission dibaca dari database pada setiap panggilan,
  sehingga perubahan role langsung terlihat tanpa perlu login ulang.
*/
export const GET = routeHandler("admin.me", async (_request, requestId) => {
  const admin = await requireAdmin();

  return ok(
    {
      admin: {
        id: admin.identity.id,
        username: admin.identity.username,
        email: admin.identity.email,
        full_name: admin.identity.fullName,
        avatar_url: admin.identity.avatarUrl,
        is_super_admin: admin.identity.isSuperAdmin,
      },
      permissions: admin.identity.permissions,
      session: { session_id: admin.sessionId },
    },
    requestId,
  );
});

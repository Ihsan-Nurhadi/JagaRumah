/*
  Daftar izin.

  Halaman ini hanya membaca. Izin tidak dibuat lewat konsol, karena setiap kode izin harus
  sepadan dengan pemeriksaan yang benar-benar ada di server. Izin yang dibuat dari layar tanpa
  pemeriksaan di server hanya akan menjadi kotak centang yang tidak mengubah apa pun.

  `role_count` menunjukkan berapa peran memegang izin itu, dan itu berguna untuk mengetahui izin
  mana yang benar-benar dipakai dan mana yang belum pernah diberikan.
*/
import { allPermissions } from "@/lib/server/admin-users";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

export const GET = routeHandler("admin.permissions.list", async (_request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "admin.manage");

  const permissions = await allPermissions();

  /*
    Izin dikelompokkan menurut awalan kodenya, karena itulah yang menentukan halaman mana yang
    terbuka. Mengelompokkannya membuat peran baru lebih mudah disusun: seseorang dapat melihat
    seluruh izin satu modul sekaligus.
  */
  const perModul = new Map<string, typeof permissions>();
  for (const permission of permissions) {
    const modul = permission.code.split(".")[0] ?? "lain";
    const daftar = perModul.get(modul) ?? [];
    daftar.push(permission);
    perModul.set(modul, daftar);
  }

  return ok(
    {
      permissions: permissions.map((permission) => ({
        code: permission.code,
        name: permission.name,
        description: permission.description,
        role_count: permission.role_count,
      })),
      by_module: Object.fromEntries(
        [...perModul.entries()].map(([modul, daftar]) => [
          modul,
          daftar.map((permission) => permission.code),
        ]),
      ),
      total: permissions.length,
    },
    requestId,
  );
});

/*
  Pilihan pelanggan untuk pemilih di halaman lain.

  Endpoint ini ada karena menugaskan perangkat memerlukan pelanggan yang tepat, dan meminta
  operator mengetik nomor pelanggan dengan tangan adalah cara paling mudah salah orang. Nama
  pelanggan bisa kembar, jadi nomor yang salah ketik akan menugaskan perangkat ke akun yang
  bukan pemiliknya, dan perpindahan itu tercatat sebagai tindakan yang sah.

  Hasilnya sengaja hanya memuat pelanggan aktif. Perangkat yang ditugaskan ke akun nonaktif
  tidak akan terpakai, dan menawarkannya di sini hanya menyiapkan kesalahan.
*/
import { customerOptions } from "@/lib/server/customers";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

export const GET = routeHandler("admin.customer_options.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "customer.read");

  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() || null;

  /*
    Daftar kosong dikembalikan sebelum mencari bila kata kuncinya masih terlalu pendek.
    Tanpa batas ini, pencarian dengan satu huruf akan menarik dua puluh pelanggan pertama yang
    kebetulan cocok, dan daftar itu lebih banyak salahnya daripada gunanya.
  */
  if (search !== null && search.length < 2) {
    return ok({ customers: [], minimum_query_length: 2 }, requestId);
  }

  const customers = await customerOptions(search, 20);

  return ok(
    {
      customers: customers.map((customer) => ({
        id: customer.id,
        full_name: customer.full_name,
        email: customer.email,
        plan_name: customer.plan_name,
        device_count: customer.device_count,
      })),
    },
    requestId,
  );
});

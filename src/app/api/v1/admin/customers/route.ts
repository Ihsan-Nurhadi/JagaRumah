/*
  Daftar dan pencarian pelanggan.

  Halaman ini melayani dua kebutuhan yang berbeda, dan keduanya memakai endpoint yang sama:

  1. Lead support yang mencari satu pelanggan tertentu lewat nama, email, atau nomor WhatsApp.
  2. Lead kerja yang mencari sekelompok pelanggan, terutama yang sudah mendaftar tetapi belum
     punya perangkat terpasang.

  Karena itu filter `q` mencakup ketiga identitas sekaligus, dan ringkasannya memuat jumlah
  pelanggan aktif tanpa perangkat.
*/
import { query, withTransaction } from "@/lib/server/db";
import { writeAudit } from "@/lib/server/audit";
import {
  createCustomer,
  customerFilterConditions,
  customerSummary,
  type CustomerListRow,
} from "@/lib/server/customers";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import {
  buildPage,
  keysetCondition,
  orderBy,
  parsePageRequest,
  type SortAllowlist,
} from "@/lib/server/pagination";
import { created, listed } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { createCustomerSchema } from "@/lib/schemas/admin-customer";

/*
  Kolom yang boleh dipakai untuk mengurutkan. Daftar tertutup, bukan nilai bebas, karena nama
  kolom disisipkan ke dalam SQL dan tidak bisa diparameterkan seperti nilai biasa.
*/
const SORT: SortAllowlist = {
  created_at: { column: "c.created_at", defaultDirection: "desc" },
  full_name: { column: "c.full_name", defaultDirection: "asc" },
  status: { column: "c.status", defaultDirection: "asc" },
};

const STATUSES = ["active", "suspended", "deleted"] as const;

export const GET = routeHandler("admin.customers.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "customer.read");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const statusParam = url.searchParams.get("status");
  if (statusParam && !STATUSES.includes(statusParam as (typeof STATUSES)[number])) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: `Status "${statusParam}" tidak dikenal. Pilihan yang tersedia: ${STATUSES.join(", ")}.`,
      details: { status: statusParam, allowed: STATUSES },
    });
  }

  const params: unknown[] = [];
  /*
    Urutan push parameter harus sama dengan urutan kemunculan $n di SQL. Filter disusun lebih
    dulu, lalu keyset, karena keduanya menulis ke array yang sama.
  */
  const filterSql = customerFilterConditions(
    {
      status: statusParam ?? undefined,
      q: url.searchParams.get("q")?.trim() || undefined,
      createdFrom: url.searchParams.get("created_from") ?? undefined,
      createdTo: url.searchParams.get("created_to") ?? undefined,
    },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  const rows = await query<CustomerListRow>(
    `SELECT c.id,
            c.created_at::text AS cursor_value,
            c.full_name,
            c.status,
            c.created_at,
            (
              SELECT a.email::text FROM customer_auth_accounts a
              WHERE a.customer_id = c.id AND a.email IS NOT NULL
              ORDER BY a.created_at LIMIT 1
            ) AS email,
            (
              SELECT a.phone_e164 FROM customer_auth_accounts a
              WHERE a.customer_id = c.id AND a.phone_e164 IS NOT NULL
              ORDER BY a.created_at LIMIT 1
            ) AS phone_e164,
            (
              SELECT array_agg(a.provider ORDER BY a.provider)
              FROM customer_auth_accounts a WHERE a.customer_id = c.id
            ) AS providers,
            (
              SELECT p.name FROM subscriptions s
              JOIN subscription_plans p ON p.id = s.plan_id
              WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1
            ) AS plan_name,
            (
              SELECT s.status FROM subscriptions s
              WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1
            ) AS subscription_status,
            (
              SELECT count(*)::int FROM devices d
              WHERE d.customer_id = c.id AND d.status = 'claimed'
            ) AS device_count
     FROM customers c
     WHERE c.status <> 'deleted'
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const summary = await customerSummary();

  return listed(
    {
      customers: items.map((row) => ({
        id: row.id,
        full_name: row.full_name,
        status: row.status,
        email: row.email,
        phone_e164: row.phone_e164,
        providers: row.providers ?? [],
        plan_name: row.plan_name,
        subscription_status: row.subscription_status,
        device_count: row.device_count,
        created_at: row.created_at.toISOString(),
      })),
      summary: {
        total: summary?.total ?? 0,
        active: summary?.active ?? 0,
        suspended: summary?.suspended ?? 0,
        /*
          Pelanggan aktif yang belum punya perangkat terpasang. Ini angka yang dipakai support
          untuk menghubungi pelanggan yang sudah mendaftar tetapi belum menyelesaikan pemasangan.
        */
        active_without_device: summary?.without_device ?? 0,
      },
    },
    pagination,
    requestId,
  );
});

/*
  Pembuatan pelanggan manual dari konsol.

  Jalur ini ada untuk pendaftaran yang tidak terjadi di aplikasi: pelanggan korporat yang
  didaftarkan sales, atau pelanggan yang mendaftar lewat telepon. Akun yang dibuat di sini
  langsung aktif dan cara masuknya langsung terverifikasi, karena adminlah yang menerima
  identitasnya secara langsung — meminta verifikasi ulang kepada pelanggan berarti konsol
  meragukan tindakan adminnya sendiri.

  Kata sandi yang diisi operator tidak ditampilkan lagi setelah akun dibuat; penyampaiannya
  kepada pelanggan adalah tanggung jawab operator, lewat jalur yang aman.
*/
export const POST = routeHandler("admin.customers.create", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "customer.create");
  await requireCsrf(request);

  const input = await parseJson(request, createCustomerSchema);

  const customer = await withTransaction(async (client) => {
    const createdCustomer = await createCustomer(client, input);

    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "customer.create",
      entityType: "customer",
      entityId: createdCustomer.id,
      newData: {
        full_name: createdCustomer.full_name,
        email: createdCustomer.email,
        phone_e164: createdCustomer.phone_e164,
        providers: createdCustomer.providers,
      },
    });

    return createdCustomer;
  });

  return created({ customer }, requestId);
});

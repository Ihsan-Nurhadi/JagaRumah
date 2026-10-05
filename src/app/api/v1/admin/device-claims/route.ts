/*
  Log percobaan claim.

  Menampilkan seluruh percobaan dari device_claim_attempts, termasuk yang gagal. Endpoint ini
  adalah alat utama untuk menelusuri penyalahgunaan jalur nomor seri, karena nomor seri CCTV
  umumnya tercetak di bodi dan berurutan sehingga bisa ditebak.

  Yang dicari operator di sini bukan sekadar "ada yang gagal", melainkan polanya: satu IP yang
  mencoba banyak nomor seri, atau satu akun yang berulang kali gagal. Karena itu ringkasannya
  mengelompokkan percobaan gagal per IP dan per akun, bukan hanya menghitung totalnya.
*/
import { query } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import {
  buildPage,
  keysetCondition,
  orderBy,
  parsePageRequest,
  type SortAllowlist,
} from "@/lib/server/pagination";
import { listed } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

const SORT: SortAllowlist = {
  created_at: { column: "a.created_at", defaultDirection: "desc" },
  success: { column: "a.success", defaultDirection: "desc" },
};

type ClaimRow = {
  id: string;
  cursor_value: string;
  success: boolean;
  failure_reason: string | null;
  submitted_kind: string;
  submitted_value_masked: string | null;
  ip_address: string | null;
  device_id: string | null;
  device_uid: string | null;
  serial_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  created_at: Date;
};

export const GET = routeHandler("admin.device_claims.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "device.read");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const params: unknown[] = [];
  const conditions: string[] = [];

  const successParam = url.searchParams.get("success");
  if (successParam !== null && successParam !== "") {
    if (successParam !== "true" && successParam !== "false") {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message: 'Parameter success hanya menerima "true" atau "false".',
        details: { success: successParam },
      });
    }
    conditions.push(`AND a.success = $${params.push(successParam === "true")}`);
  }

  const kind = url.searchParams.get("submitted_kind");
  if (kind) {
    if (kind !== "qr" && kind !== "serial") {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message: 'Parameter submitted_kind hanya menerima "qr" atau "serial".',
        details: { submitted_kind: kind },
      });
    }
    conditions.push(`AND a.submitted_kind = $${params.push(kind)}`);
  }

  const customerId = url.searchParams.get("customer_id");
  if (customerId) {
    conditions.push(`AND a.customer_id = $${params.push(customerId)}::uuid`);
  }

  const from = url.searchParams.get("created_from");
  if (from) {
    conditions.push(`AND a.created_at >= $${params.push(from)}::timestamptz`);
  }

  const to = url.searchParams.get("created_to");
  if (to) {
    conditions.push(`AND a.created_at <= $${params.push(to)}::timestamptz`);
  }

  const keyset = keysetCondition(page, params);
  const where = [...conditions, keyset].filter(Boolean).join("\n         ");

  const rows = await query<ClaimRow>(
    `SELECT a.id,
            a.created_at::text AS cursor_value,
            a.success,
            a.failure_reason,
            a.submitted_kind,
            a.submitted_value_masked,
            host(a.ip_address) AS ip_address,
            a.device_id,
            d.device_uid,
            d.serial_number,
            a.customer_id,
            c.full_name AS customer_name,
            a.created_at
     FROM device_claim_attempts a
     LEFT JOIN devices d ON d.id = a.device_id
     LEFT JOIN customers c ON c.id = a.customer_id
     WHERE true
         ${where}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);

  /*
    Ringkasan polanya dibaca dari jendela 24 jam terakhir, bukan dari seluruh riwayat. Yang
    dicari adalah percobaan yang sedang berlangsung, dan angka sepanjang masa akan tertutup
    oleh percobaan wajar dari berbulan-bulan sebelumnya.
  */
  const [topIps, topCustomers, totals] = await Promise.all([
    query<{ ip_address: string | null; failures: number }>(
      `SELECT host(a.ip_address) AS ip_address, count(*)::int AS failures
       FROM device_claim_attempts a
       WHERE NOT a.success AND a.created_at >= now() - interval '24 hours'
       GROUP BY a.ip_address
       ORDER BY failures DESC, ip_address
       LIMIT 5`,
    ),
    query<{ customer_id: string | null; customer_name: string | null; failures: number }>(
      `SELECT a.customer_id, c.full_name AS customer_name, count(*)::int AS failures
       FROM device_claim_attempts a
       LEFT JOIN customers c ON c.id = a.customer_id
       WHERE NOT a.success AND a.created_at >= now() - interval '24 hours'
       GROUP BY a.customer_id, c.full_name
       ORDER BY failures DESC, c.full_name
       LIMIT 5`,
    ),
    query<{ total: number; failed: number; last_24h_failed: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE NOT success)::int AS failed,
              count(*) FILTER (WHERE NOT success AND created_at >= now() - interval '24 hours')::int
                AS last_24h_failed
       FROM device_claim_attempts`,
    ),
  ]);

  return listed(
    {
      claims: items.map((row) => ({
        id: row.id,
        success: row.success,
        failure_reason: row.failure_reason,
        submitted_kind: row.submitted_kind,
        submitted_value_masked: row.submitted_value_masked,
        ip_address: row.ip_address,
        device: row.device_id
          ? { id: row.device_id, device_uid: row.device_uid, serial_number: row.serial_number }
          : null,
        customer: row.customer_id
          ? { id: row.customer_id, full_name: row.customer_name }
          : null,
        created_at: row.created_at.toISOString(),
      })),
      summary: {
        total: totals[0]?.total ?? 0,
        failed: totals[0]?.failed ?? 0,
        failed_last_24h: totals[0]?.last_24h_failed ?? 0,
        /*
          Batas yang berlaku, ditampilkan di samping angkanya supaya operator tahu kapan sebuah
          pola sudah menyentuh batas dan kapan masih wajar.
        */
        limits: { failures_per_customer_per_hour: 5, failures_per_ip_per_hour: 10 },
        top_ips_24h: topIps.map((row) => ({
          ip_address: row.ip_address,
          failures: row.failures,
        })),
        top_customers_24h: topCustomers.map((row) => ({
          customer_id: row.customer_id,
          full_name: row.customer_name,
          failures: row.failures,
        })),
      },
    },
    pagination,
    requestId,
  );
});

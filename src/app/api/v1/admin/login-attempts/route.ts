/*
  Percobaan masuk admin.

  Endpoint ini sumber data utama untuk mendeteksi percobaan masuk berulang. Yang dicari operator
  bukan sekadar "ada yang gagal", melainkan polanya: satu alamat IP yang mencoba banyak email,
  atau satu email yang digempur berulang kali. Karena itu ringkasannya mengelompokkan kegagalan
  24 jam terakhir per IP dan per email, bukan hanya menghitung totalnya.

  Baris di sini tidak pernah menyimpan kata sandi, hanya alasan kegagalannya.
*/
import {
  LOGIN_OUTCOMES,
  loginAttemptFilterConditions,
  loginAttemptSummary,
  type LoginAttemptListRow,
} from "@/lib/server/audit-query";
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
  email: { column: "a.username_attempted", defaultDirection: "asc" },
  success: { column: "a.success", defaultDirection: "desc" },
};

export const GET = routeHandler("admin.audit.login_attempts.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "audit.read");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const outcome = url.searchParams.get("outcome");
  if (outcome && !LOGIN_OUTCOMES.includes(outcome as (typeof LOGIN_OUTCOMES)[number])) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message:
        `Hasil "${outcome}" tidak dikenal. Pilihan yang tersedia: ${LOGIN_OUTCOMES.join(", ")}.`,
      details: { outcome, allowed: LOGIN_OUTCOMES },
    });
  }

  const params: unknown[] = [];
  const filterSql = loginAttemptFilterConditions(
    {
      outcome: outcome ?? undefined,
      email: url.searchParams.get("email")?.trim() || undefined,
      ipAddress: url.searchParams.get("ip_address")?.trim() || undefined,
      createdFrom: url.searchParams.get("created_from") ?? undefined,
      createdTo: url.searchParams.get("created_to") ?? undefined,
    },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  const rows = await query<LoginAttemptListRow>(
    `SELECT a.id,
            a.created_at::text AS cursor_value,
            a.admin_user_id,
            a.username_attempted::text AS email,
            (SELECT u.full_name FROM admin_users u WHERE u.id = a.admin_user_id) AS admin_name,
            host(a.ip_address) AS ip_address,
            a.success,
            a.failure_reason,
            a.created_at
     FROM admin_login_attempts a
     WHERE true
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const summary = await loginAttemptSummary();

  return listed(
    {
      attempts: items.map((row) => ({
        id: row.id,
        email: row.email,
        /*
          admin_user_id null berarti email yang dicoba tidak terdaftar. Baris seperti itu tetap
          ditampilkan dengan nama kosong, bukan disembunyikan, karena percobaan ke email yang
          tidak ada justru bagian dari pola penebakan.
        */
        admin: row.admin_user_id
          ? { id: row.admin_user_id, full_name: row.admin_name }
          : null,
        ip_address: row.ip_address,
        success: row.success,
        failure_reason: row.failure_reason,
        created_at: row.created_at.toISOString(),
      })),
      summary: {
        total: summary.total,
        succeeded: summary.succeeded,
        failed: summary.failed,
        failed_last_24h: summary.failed_last_24h,
        succeeded_last_24h: summary.succeeded_last_24h,
        limits: summary.limits,
        top_ips_24h: summary.top_ips_24h,
        top_emails_24h: summary.top_emails_24h,
      },
    },
    pagination,
    requestId,
  );
});

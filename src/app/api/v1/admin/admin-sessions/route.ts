/*
  Sesi admin.

  Menampilkan siklus hidup sesi: yang masih aktif, yang sudah dicabut, dan yang lewat masa
  berlakunya. Kolom `refresh_token_hash` tidak pernah diambil sama sekali, bukan hanya tidak
  dikirim: hash token tetap bahan rahasia, dan tidak ada satu pun pertanyaan di halaman audit
  yang membutuhkannya.
*/
import {
  ADMIN_SESSION_STATUSES,
  adminSessionFilterConditions,
  adminSessionSummary,
  uuidFilter,
  type AdminSessionListRow,
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
  created_at: { column: "s.created_at", defaultDirection: "desc" },
  expires_at: { column: "s.expires_at", defaultDirection: "asc" },
  last_used_at: { column: "s.last_used_at", defaultDirection: "desc" },
};

export const GET = routeHandler("admin.audit.sessions.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "audit.read");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const status = url.searchParams.get("status");
  if (status && !ADMIN_SESSION_STATUSES.includes(status as (typeof ADMIN_SESSION_STATUSES)[number])) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message:
        `Status sesi "${status}" tidak dikenal. Pilihan yang tersedia: ` +
        `${ADMIN_SESSION_STATUSES.join(", ")}.`,
      details: { status, allowed: ADMIN_SESSION_STATUSES },
    });
  }

  const adminUserId = url.searchParams.get("admin_user_id");

  const params: unknown[] = [];
  const filterSql = adminSessionFilterConditions(
    {
      status: status ?? undefined,
      adminUserId: adminUserId ? uuidFilter(adminUserId, "admin_user_id") : undefined,
    },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  const rows = await query<AdminSessionListRow>(
    `SELECT s.id,
            s.created_at::text AS cursor_value,
            s.admin_user_id,
            (SELECT u.full_name FROM admin_users u WHERE u.id = s.admin_user_id) AS admin_name,
            (SELECT u.email::text FROM admin_users u WHERE u.id = s.admin_user_id) AS admin_email,
            host(s.ip_address) AS ip_address,
            s.user_agent,
            s.expires_at,
            s.revoked_at,
            s.replaced_by_session_id,
            s.last_used_at,
            s.created_at,
            (SELECT count(*)::int FROM admin_session_events e
              WHERE e.admin_session_id = s.id) AS event_count
     FROM admin_sessions s
     WHERE true
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const summary = await adminSessionSummary();

  return listed(
    {
      sessions: items.map((row) => ({
        id: row.id,
        admin: { id: row.admin_user_id, full_name: row.admin_name, email: row.admin_email },
        /*
          Status dihitung dari dua kolom, bukan dibaca dari kolom status yang tidak ada. Sesi
          yang dicabut karena rotasi refresh token tetap dihitung tercabut, dan penandanya
          dibedakan lewat replaced_by_session_id supaya rotasi wajar tidak terbaca sebagai
          pencabutan paksa.
        */
        status:
          row.revoked_at !== null
            ? "revoked"
            : row.expires_at.getTime() <= Date.now()
              ? "expired"
              : "active",
        replaced_by_session_id: row.replaced_by_session_id,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        event_count: row.event_count,
        expires_at: row.expires_at.toISOString(),
        revoked_at: row.revoked_at?.toISOString() ?? null,
        last_used_at: row.last_used_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
      })),
      summary: {
        total: summary.total,
        active: summary.active,
        revoked: summary.revoked,
        expired: summary.expired,
      },
    },
    pagination,
    requestId,
  );
});

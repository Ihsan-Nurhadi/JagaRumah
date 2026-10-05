/*
  Siklus hidup sesi admin: masuk, token diperbarui, keluar, dicabut, kedaluwarsa, dan kata sandi
  diubah.

  Dipisahkan dari `admin-sessions` karena keduanya menjawab pertanyaan yang berbeda.
  `admin-sessions` menjawab "sesi mana yang masih hidup sekarang", sedangkan endpoint ini
  menjawab "apa yang terjadi pada sesi-sesi itu". Sesi yang sudah dihapus tetap punya jejak di
  sini, dan justru itu yang dicari saat menelusuri masuk yang mencurigakan.

  Alamat endpoint ini tidak ada di `API_Contract.md`; tabelnya sendiri disyaratkan di poin 13
  bagian catatan kontrak, jadi alamat ini ditambahkan mengikuti pola jalur datar yang dipakai
  `audit-logs`, `login-attempts`, dan `admin-sessions`.
*/
import {
  sessionEventFilterConditions,
  sessionEventSummary,
  type SessionEventListRow,
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
  created_at: { column: "e.created_at", defaultDirection: "desc" },
};

/*
  Daftar tertutup dari batasan kolomnya di database. Memakai daftar yang diambil dari data akan
  menyembunyikan jenis peristiwa yang belum pernah terjadi, padahal "belum pernah terjadi" juga
  sebuah jawaban yang berguna.
*/
const EVENT_TYPES = [
  "login",
  "refresh",
  "logout",
  "revoked",
  "expired",
  "password_changed",
] as const;

export const GET = routeHandler("admin.session_events.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "audit.read");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const eventType = url.searchParams.get("event_type");
  if (eventType && !EVENT_TYPES.includes(eventType as (typeof EVENT_TYPES)[number])) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message:
        `Jenis peristiwa "${eventType}" tidak dikenal. Pilihan yang tersedia: ` +
        `${EVENT_TYPES.join(", ")}.`,
      details: { event_type: eventType, allowed: EVENT_TYPES },
    });
  }

  const params: unknown[] = [];
  const filterSql = sessionEventFilterConditions(
    {
      eventType: eventType ?? undefined,
      adminUserId: url.searchParams.get("admin_user_id") ?? undefined,
      createdFrom: url.searchParams.get("created_from") ?? undefined,
      createdTo: url.searchParams.get("created_to") ?? undefined,
    },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  const rows = await query<SessionEventListRow>(
    `SELECT e.id, e.event_type, e.admin_user_id,
            u.full_name AS admin_name, u.email AS admin_email,
            e.admin_session_id, e.ip_address::text AS ip_address,
            e.user_agent, e.metadata, e.created_at,
            e.created_at::text AS cursor_value
     FROM admin_session_events e
     JOIN admin_users u ON u.id = e.admin_user_id
     WHERE true
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const summary = await sessionEventSummary();

  return listed(
    {
      events: items.map((row) => ({
        id: row.id,
        event_type: row.event_type,
        admin: {
          id: row.admin_user_id,
          full_name: row.admin_name,
          email: row.admin_email,
        },
        admin_session_id: row.admin_session_id,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        metadata: row.metadata,
        created_at: row.created_at.toISOString(),
      })),
      summary,
    },
    pagination,
    requestId,
  );
});

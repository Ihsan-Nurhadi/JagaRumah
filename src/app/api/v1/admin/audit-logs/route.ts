/*
  Jejak perubahan data.

  Satu garis waktu untuk tindakan admin dan tindakan sistem, sesuai API_Contract.md. Kolom
  actor_type yang membedakan keduanya, dan baris sistem tidak punya admin_user_id sama sekali.

  old_data dan new_data ikut dikirim karena tanpa keduanya pertanyaan "apa yang sebenarnya
  berubah" tidak bisa dijawab dari catatan ini. Isinya bukan bahan rahasia: writeAudit() sengaja
  tidak pernah menulis kode claim, kata sandi, atau token ke kolom ini, jadi yang tampil hanya
  nilai data yang memang terlihat di layar konsol.
*/
import {
  AUDIT_ACTOR_TYPES,
  auditLogFilterConditions,
  auditLogSummary,
  uuidFilter,
  type AuditLogListRow,
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
  action: { column: "a.action", defaultDirection: "asc" },
  entity_type: { column: "a.entity_type", defaultDirection: "asc" },
  actor_type: { column: "a.actor_type", defaultDirection: "asc" },
};

export const GET = routeHandler("admin.audit.logs.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "audit.read");

  const url = new URL(request.url);
  const page = parsePageRequest(url.searchParams, SORT, "-created_at");

  const actorType = url.searchParams.get("actor_type");
  if (actorType && !AUDIT_ACTOR_TYPES.includes(actorType as (typeof AUDIT_ACTOR_TYPES)[number])) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message:
        `Pelaku "${actorType}" tidak dikenal. Pilihan yang tersedia: ` +
        `${AUDIT_ACTOR_TYPES.join(", ")}.`,
      details: { actor_type: actorType, allowed: AUDIT_ACTOR_TYPES },
    });
  }

  const entityId = url.searchParams.get("entity_id");
  const adminUserId = url.searchParams.get("admin_user_id");

  const params: unknown[] = [];
  /*
    Urutan push parameter harus sama dengan urutan kemunculan $n di SQL. Filter disusun lebih
    dulu, lalu keyset, karena keduanya menulis ke array yang sama.
  */
  const filterSql = auditLogFilterConditions(
    {
      actorType: actorType ?? undefined,
      action: url.searchParams.get("action") ?? undefined,
      entityType: url.searchParams.get("entity_type") ?? undefined,
      entityId: entityId ? uuidFilter(entityId, "entity_id") : undefined,
      adminUserId: adminUserId ? uuidFilter(adminUserId, "admin_user_id") : undefined,
      createdFrom: url.searchParams.get("created_from") ?? undefined,
      createdTo: url.searchParams.get("created_to") ?? undefined,
      q: url.searchParams.get("q")?.trim() || undefined,
    },
    params,
  );
  const keysetSql = keysetCondition(page, params);

  /*
    Nama pelaku dibaca lewat subquery, bukan JOIN. keysetCondition() dan orderBy() menulis `id`
    tanpa nama tabel, dan `id` pada JOIN antara audit_logs dan admin_users menjadi ambigu
    sehingga kueri gagal saat halaman berikutnya dibuka.
  */
  const rows = await query<AuditLogListRow>(
    `SELECT a.id,
            a.created_at::text AS cursor_value,
            a.actor_type,
            a.admin_user_id,
            (SELECT u.full_name FROM admin_users u WHERE u.id = a.admin_user_id) AS actor_name,
            (SELECT u.email::text FROM admin_users u WHERE u.id = a.admin_user_id) AS actor_email,
            a.action,
            a.entity_type,
            a.entity_id,
            a.old_data,
            a.new_data,
            host(a.ip_address) AS ip_address,
            a.user_agent,
            a.created_at
     FROM audit_logs a
     WHERE true
          ${filterSql}
          ${keysetSql}
     ${orderBy(page)}
     LIMIT ${page.limit + 1}`,
    params,
  );

  const { items, pagination } = buildPage(rows, page);
  const summary = await auditLogSummary();

  return listed(
    {
      logs: items.map((row) => ({
        id: row.id,
        actor_type: row.actor_type,
        /*
          Pelaku sistem dikirim sebagai null, bukan sebagai admin tanpa nama. Pembedaan ini yang
          membuat antarmuka bisa menulis "Sistem" tanpa menebak dari nama yang kosong.
        */
        actor: row.admin_user_id
          ? { id: row.admin_user_id, full_name: row.actor_name, email: row.actor_email }
          : null,
        action: row.action,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        old_data: row.old_data,
        new_data: row.new_data,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        created_at: row.created_at.toISOString(),
      })),
      summary: {
        total: summary.total,
        last_24h: summary.last_24h,
        by_admin: summary.by_admin,
        by_system: summary.by_system,
        actions: summary.actions,
        entity_types: summary.entity_types,
      },
    },
    pagination,
    requestId,
  );
});

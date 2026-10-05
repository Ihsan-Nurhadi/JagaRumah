import type { PoolClient } from "pg";
import { query } from "./db";

/*
  Jejak audit.

  Setiap perubahan data admin menulis satu baris di sini. `old_data` dan `new_data` memuat nilai
  sebelum dan sesudah, karena tanpa keduanya pertanyaan "jadi apa yang berubah" tidak bisa
  dijawab dari catatan mana pun.

  Tindakan otomatis dari job memakai actor_type `system` dengan admin_user_id null. Batasan itu
  ditegakkan di database, bukan hanya di sini, supaya jalur penulisan baru tidak bisa
  diam-diam melanggarnya.
*/

export type AdminActor = {
  adminUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
};

export type AuditEntry = {
  actor: AdminActor | { system: true };
  action: string;
  entityType: string;
  entityId?: string | null;
  oldData?: unknown;
  newData?: unknown;
};

/*
  Nilai yang dikirim ke database disusun di satu tempat, supaya arti "pelaku sistem" hanya
  ditentukan sekali: tanpa id, tanpa IP, tanpa user agent.
*/
function columns(entry: AuditEntry) {
  const actor = entry.actor;
  if ("system" in actor) {
    return {
      actorType: "system",
      adminUserId: null,
      ipAddress: null,
      userAgent: null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      oldData: entry.oldData === undefined ? null : JSON.stringify(entry.oldData),
      newData: entry.newData === undefined ? null : JSON.stringify(entry.newData),
    };
  }

  return {
    actorType: "admin",
    adminUserId: actor.adminUserId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    oldData: entry.oldData === undefined ? null : JSON.stringify(entry.oldData),
    newData: entry.newData === undefined ? null : JSON.stringify(entry.newData),
  };
}

const INSERT_AUDIT = `
  INSERT INTO audit_logs
    (actor_type, admin_user_id, action, entity_type, entity_id, old_data, new_data, ip_address, user_agent)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`;

function values(column: ReturnType<typeof columns>) {
  return [
    column.actorType,
    column.adminUserId,
    column.action,
    column.entityType,
    column.entityId,
    column.oldData,
    column.newData,
    column.ipAddress,
    column.userAgent,
  ];
}

/*
  Menerima klien transaksi sebagai parameter pertama. Audit yang ditulis di luar transaksi
  perubahan datanya bisa hilang saat transaksi itu dibatalkan, dan yang tersisa adalah catatan
  perubahan yang tidak pernah terjadi.
*/
export async function writeAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  const column = columns(entry);
  await client.query(INSERT_AUDIT, values(column));
}

/*
  Audit yang gagal ditulis tidak boleh menggagalkan tindakan yang sudah sah. Dipakai untuk
  tindakan yang tidak sedang berada di dalam transaksi.
*/
export async function writeAuditDetached(entry: AuditEntry): Promise<void> {
  const column = columns(entry);
  try {
    await query(INSERT_AUDIT, values(column));
  } catch (error) {
    console.error("[audit] gagal menulis jejak audit:", error);
  }
}

/*
  Lapisan baca untuk halaman audit.

  Empat tabel yang dibaca di sini bersifat tambah-saja, jadi seluruh berkas ini hanya berisi
  pembacaan. Tidak ada fungsi yang mengubah atau menghapus baris, karena catatan audit yang bisa
  disunting dari konsol yang sama tidak berguna sebagai bukti.

  Berkas ini dipisah dari audit.ts, yang menulis jejak di dalam transaksi perubahan data.
  Alasannya: jalur tulis dipakai setiap endpoint yang mengubah data, sedangkan penyusun filter
  dan ringkasan di sini hanya dipakai halaman audit. Digabung, setiap endpoint yang mengubah
  data ikut memuat kode daftar yang tidak pernah dipakainya.
*/
import { LOGIN_ACCOUNT_MAX_FAILURES, LOGIN_IP_MAX_FAILURES, LOGIN_WINDOW_MINUTES } from "./config";
import { query, queryOne } from "./db";
import { AppError } from "./errors";

export const AUDIT_ACTOR_TYPES = ["admin", "system"] as const;
export const LOGIN_OUTCOMES = ["success", "failed"] as const;
export const ADMIN_SESSION_STATUSES = ["active", "revoked", "expired"] as const;
export const SESSION_EVENT_TYPES = [
  "login",
  "refresh",
  "logout",
  "revoked",
  "expired",
  "password_changed",
] as const;

/*
  Jendela 24 jam dipakai untuk seluruh angka pola di halaman ini. Yang dicari adalah percobaan
  yang sedang berlangsung, dan angka sepanjang masa akan tertutup oleh riwayat berbulan-bulan
  sebelumnya.
*/
const RECENT_WINDOW = "24 hours";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/*
  Nilai uuid dari parameter filter diperiksa bentuknya sebelum masuk ke SQL.

  Dipakai `VALIDATION_ERROR` di sini, bukan `requireUuid()` di request.ts: helper itu untuk id
  di alamat rute, di mana bentuk yang salah berarti datanya tidak ada. Pada filter, yang salah
  adalah parameternya, bukan datanya. Tanpa pemeriksaan ini, uuid yang salah ketik akan ditolak
  driver PostgreSQL dan berubah menjadi galat 500.
*/
export function uuidFilter(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: `Parameter ${field} harus berupa uuid yang sah.`,
      details: { [field]: value },
    });
  }
  return value;
}

/*
  Nilai pencarian dijadikan pola ILIKE dengan karakter khusus yang di-escape lebih dulu, supaya
  tanda % dan _ yang diketik operator dicari apa adanya, bukan berlaku sebagai wildcard.
*/
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

// ------------------------------------------------------------------ audit_logs

export type AuditLogListRow = {
  id: string;
  cursor_value: string;
  actor_type: string;
  admin_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_data: unknown;
  new_data: unknown;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
};

export type AuditLogFilter = {
  actorType?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  adminUserId?: string;
  createdFrom?: string;
  createdTo?: string;
  /** Pencarian bebas pada tindakan, entitas, pelaku, dan alamat IP. */
  q?: string;
};

export function auditLogFilterConditions(filter: AuditLogFilter, params: unknown[]): string {
  const conditions: string[] = [];

  if (filter.actorType) {
    conditions.push(`AND a.actor_type = $${params.push(filter.actorType)}`);
  }
  if (filter.action) {
    conditions.push(`AND a.action = $${params.push(filter.action)}`);
  }
  if (filter.entityType) {
    conditions.push(`AND a.entity_type = $${params.push(filter.entityType)}`);
  }
  if (filter.entityId) {
    conditions.push(`AND a.entity_id = $${params.push(filter.entityId)}::uuid`);
  }
  if (filter.adminUserId) {
    conditions.push(`AND a.admin_user_id = $${params.push(filter.adminUserId)}::uuid`);
  }
  if (filter.createdFrom) {
    conditions.push(`AND a.created_at >= $${params.push(filter.createdFrom)}::timestamptz`);
  }
  if (filter.createdTo) {
    conditions.push(`AND a.created_at <= $${params.push(filter.createdTo)}::timestamptz`);
  }
  if (filter.q) {
    /*
      Pencarian mencakup nama dan email pelaku, karena pertanyaan pertama halaman ini adalah
      "siapa yang melakukan ini". Kolom entity_id ikut dicari dalam bentuk teks supaya id yang
      disalin dari tempat lain bisa ditemukan tanpa memisahkan filternya.
    */
    const index = params.push(likePattern(filter.q));
    conditions.push(
      `AND (a.action ILIKE $${index}
            OR a.entity_type ILIKE $${index}
            OR a.entity_id::text ILIKE $${index}
            OR host(a.ip_address) ILIKE $${index}
            OR EXISTS (
              SELECT 1 FROM admin_users u
              WHERE u.id = a.admin_user_id
                AND (u.full_name ILIKE $${index} OR u.email::text ILIKE $${index})
            ))`,
    );
  }

  return conditions.join("\n         ");
}

export async function auditLogSummary() {
  const [totals, actions, entityTypes] = await Promise.all([
    queryOne<{
      total: number;
      last_24h: number;
      by_admin: number;
      by_system: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE created_at >= now() - interval '${RECENT_WINDOW}')::int
                AS last_24h,
              count(*) FILTER (WHERE actor_type = 'admin')::int AS by_admin,
              count(*) FILTER (WHERE actor_type = 'system')::int AS by_system
       FROM audit_logs`,
    ),
    /*
      Tindakan dan jenis entitas yang benar-benar ada di catatan. Daftar ini yang mengisi pilihan
      filter, sehingga filter tidak pernah menawarkan tindakan yang belum pernah terjadi. Jumlah
      barisnya terbatas karena nilai kolom ini ditulis oleh kode, bukan oleh pengguna.
    */
    query<{ action: string; total: number }>(
      `SELECT action, count(*)::int AS total
       FROM audit_logs
       GROUP BY action
       ORDER BY action`,
    ),
    query<{ entity_type: string; total: number }>(
      `SELECT entity_type, count(*)::int AS total
       FROM audit_logs
       GROUP BY entity_type
       ORDER BY entity_type`,
    ),
  ]);

  return {
    total: totals?.total ?? 0,
    last_24h: totals?.last_24h ?? 0,
    by_admin: totals?.by_admin ?? 0,
    by_system: totals?.by_system ?? 0,
    actions,
    entity_types: entityTypes,
  };
}

// ------------------------------------------------------------------ admin_login_attempts

export type LoginAttemptListRow = {
  id: string;
  cursor_value: string;
  admin_user_id: string | null;
  email: string;
  admin_name: string | null;
  ip_address: string | null;
  success: boolean;
  failure_reason: string | null;
  created_at: Date;
};

export type LoginAttemptFilter = {
  outcome?: string;
  email?: string;
  ipAddress?: string;
  createdFrom?: string;
  createdTo?: string;
};

export function loginAttemptFilterConditions(
  filter: LoginAttemptFilter,
  params: unknown[],
): string {
  const conditions: string[] = [];

  if (filter.outcome) {
    conditions.push(`AND a.success = $${params.push(filter.outcome === "success")}`);
  }
  if (filter.email) {
    conditions.push(`AND a.username_attempted ILIKE $${params.push(likePattern(filter.email))}`);
  }
  if (filter.ipAddress) {
    /*
      IP dibandingkan sebagai teks lewat host(), bukan sebagai inet. Cara ini membuat alamat
      yang salah ketik hanya menghasilkan daftar kosong, bukan galat driver yang berujung 500.
    */
    conditions.push(`AND host(a.ip_address) = $${params.push(filter.ipAddress)}`);
  }
  if (filter.createdFrom) {
    conditions.push(`AND a.created_at >= $${params.push(filter.createdFrom)}::timestamptz`);
  }
  if (filter.createdTo) {
    conditions.push(`AND a.created_at <= $${params.push(filter.createdTo)}::timestamptz`);
  }

  return conditions.join("\n         ");
}

/*
  Ringkasan percobaan masuk.

  Angka polanya sengaja dibaca dari seluruh tabel, bukan dari hasil filter yang sedang dipasang.
  Percobaan masuk yang gagal adalah sinyal penyusupan, dan sinyal itu justru harus tetap terlihat
  ketika operator sedang menyaring daftar untuk keperluan lain. Kalau ikut tersaring, angka
  serangan bisa hilang dari layar hanya karena ada filter tanggal yang tertinggal.
*/
export async function loginAttemptSummary() {
  const [totals, topIps, topEmails] = await Promise.all([
    queryOne<{
      total: number;
      succeeded: number;
      failed: number;
      failed_last_24h: number;
      succeeded_last_24h: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE success)::int AS succeeded,
              count(*) FILTER (WHERE NOT success)::int AS failed,
              count(*) FILTER (WHERE NOT success
                               AND created_at >= now() - interval '${RECENT_WINDOW}')::int
                AS failed_last_24h,
              count(*) FILTER (WHERE success
                               AND created_at >= now() - interval '${RECENT_WINDOW}')::int
                AS succeeded_last_24h
       FROM admin_login_attempts`,
    ),
    query<{ ip_address: string | null; failures: number; emails: number }>(
      `SELECT host(ip_address) AS ip_address,
              count(*)::int AS failures,
              count(DISTINCT username_attempted)::int AS emails
       FROM admin_login_attempts
       WHERE NOT success AND created_at >= now() - interval '${RECENT_WINDOW}'
       GROUP BY ip_address
       ORDER BY failures DESC, ip_address NULLS LAST
       LIMIT 5`,
    ),
    query<{ email: string; failures: number; ips: number }>(
      `SELECT username_attempted::text AS email,
              count(*)::int AS failures,
              count(DISTINCT ip_address)::int AS ips
       FROM admin_login_attempts
       WHERE NOT success AND created_at >= now() - interval '${RECENT_WINDOW}'
       GROUP BY username_attempted
       ORDER BY failures DESC, email
       LIMIT 5`,
    ),
  ]);

  return {
    total: totals?.total ?? 0,
    succeeded: totals?.succeeded ?? 0,
    failed: totals?.failed ?? 0,
    failed_last_24h: totals?.failed_last_24h ?? 0,
    succeeded_last_24h: totals?.succeeded_last_24h ?? 0,
    /*
      Batas yang berlaku ikut dikirim supaya angka percobaan gagal bisa ditafsirkan: 3 kegagalan
      berarti berbeda tergantung seberapa dekat angka itu dengan batasnya.
    */
    limits: {
      failures_per_account: LOGIN_ACCOUNT_MAX_FAILURES,
      failures_per_ip: LOGIN_IP_MAX_FAILURES,
      window_minutes: LOGIN_WINDOW_MINUTES,
    },
    top_ips_24h: topIps.map((row) => ({
      ip_address: row.ip_address,
      failures: row.failures,
      emails: row.emails,
    })),
    top_emails_24h: topEmails.map((row) => ({
      email: row.email,
      failures: row.failures,
      ips: row.ips,
    })),
  };
}

// ------------------------------------------------------------------ admin_sessions

export type AdminSessionListRow = {
  id: string;
  cursor_value: string;
  admin_user_id: string;
  admin_name: string | null;
  admin_email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by_session_id: string | null;
  last_used_at: Date | null;
  created_at: Date;
  event_count: number;
};

export type AdminSessionFilter = {
  status?: string;
  adminUserId?: string;
};

/*
  Tiga keadaan sesi diterjemahkan menjadi syarat SQL di satu tempat.

  `expired` berarti sesi yang lewat masa berlakunya tanpa pernah dicabut. Pembedaan ini penting:
  sesi yang dicabut berarti ada yang menghentikannya, sedangkan sesi kedaluwarsa hanya berjalan
  sampai habis waktunya, dan keduanya menuntut pemeriksaan yang berbeda.
*/
export function adminSessionFilterConditions(
  filter: AdminSessionFilter,
  params: unknown[],
): string {
  const conditions: string[] = [];

  if (filter.status === "active") {
    conditions.push("AND s.revoked_at IS NULL AND s.expires_at > now()");
  } else if (filter.status === "revoked") {
    conditions.push("AND s.revoked_at IS NOT NULL");
  } else if (filter.status === "expired") {
    conditions.push("AND s.revoked_at IS NULL AND s.expires_at <= now()");
  }

  if (filter.adminUserId) {
    conditions.push(`AND s.admin_user_id = $${params.push(filter.adminUserId)}::uuid`);
  }

  return conditions.join("\n         ");
}

export async function adminSessionSummary() {
  const totals = await queryOne<{
    total: number;
    active: number;
    revoked: number;
    expired: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS active,
            count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
            count(*) FILTER (WHERE revoked_at IS NULL AND expires_at <= now())::int AS expired
     FROM admin_sessions`,
  );

  return {
    total: totals?.total ?? 0,
    active: totals?.active ?? 0,
    revoked: totals?.revoked ?? 0,
    expired: totals?.expired ?? 0,
  };
}

// ------------------------------------------------------------------ admin_session_events

export type SessionEventListRow = {
  id: string;
  cursor_value: string;
  event_type: string;
  admin_user_id: string;
  admin_name: string | null;
  admin_email: string | null;
  admin_session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: unknown;
  created_at: Date;
};

export type SessionEventFilter = {
  eventType?: string;
  adminUserId?: string;
  createdFrom?: string;
  createdTo?: string;
};

export function sessionEventFilterConditions(
  filter: SessionEventFilter,
  params: unknown[],
): string {
  const conditions: string[] = [];

  if (filter.eventType) {
    conditions.push(`AND e.event_type = $${params.push(filter.eventType)}`);
  }
  if (filter.adminUserId) {
    conditions.push(`AND e.admin_user_id = $${params.push(filter.adminUserId)}::uuid`);
  }
  if (filter.createdFrom) {
    conditions.push(`AND e.created_at >= $${params.push(filter.createdFrom)}::timestamptz`);
  }
  if (filter.createdTo) {
    conditions.push(`AND e.created_at <= $${params.push(filter.createdTo)}::timestamptz`);
  }

  return conditions.join("\n         ");
}

export async function sessionEventSummary() {
  const totals = await queryOne<{
    total: number;
    last_24h: number;
    login_24h: number;
    ended_24h: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE created_at >= now() - interval '${RECENT_WINDOW}')::int
              AS last_24h,
            count(*) FILTER (WHERE event_type = 'login'
                             AND created_at >= now() - interval '${RECENT_WINDOW}')::int
              AS login_24h,
            count(*) FILTER (WHERE event_type IN ('logout', 'revoked', 'expired', 'password_changed')
                             AND created_at >= now() - interval '${RECENT_WINDOW}')::int
              AS ended_24h
     FROM admin_session_events`,
  );

  return {
    total: totals?.total ?? 0,
    last_24h: totals?.last_24h ?? 0,
    login_24h: totals?.login_24h ?? 0,
    ended_24h: totals?.ended_24h ?? 0,
  };
}

/*
  Lapisan data untuk perangkat.

  Aturan bisnis modul ini yang mudah salah kalau ditulis di route handler:

  1. Perangkat yang di-deactivate berstatus `suspended`, bukan dihapus, dan tetap terikat pada
     customer tersebut. Karena itu perangkat yang suspended TIDAK dihitung dalam batas paket.
  2. Claim code bersifat sekali pakai dan tidak pernah diterbitkan ulang otomatis. Setelah
     unassign, kode lama tetap dianggap terpakai; perangkat hanya bisa diklaim lagi setelah
     admin merotasi kode baru.
  3. Penghapusan perangkat memakai status `deleted`, bukan DELETE, karena nomor seri perangkat
     yang pernah beredar harus tetap bisa ditelusuri.
*/
import type { PoolClient } from "pg";

import { AppError } from "./errors";
import { query, queryOne, type Queryable } from "./db";
import {
  claimQrPayload,
  formatClaimToken,
  generateClaimToken,
  hashClaimToken,
} from "./claim-code";

/*
  Status yang dihitung sebagai pemakaian batas paket.

  `suspended` sengaja tidak termasuk, sesuai API_Contract.md: perangkat yang dinonaktifkan
  tidak lagi dihitung dalam device_limit.
*/
export const COUNTED_DEVICE_STATUSES = ["claimed"] as const;

export type DeviceListRow = {
  id: string;
  cursor_value: string;
  device_uid: string;
  serial_number: string;
  name: string | null;
  model: string | null;
  batch_number: string | null;
  status: string;
  claim_method: string | null;
  claimed_at: Date | null;
  customer_id: string | null;
  customer_name: string | null;
  created_at: Date;
};


export type DeviceFilter = {
  status?: string;
  model?: string;
  batchNumber?: string;
  customerId?: string;
  /** Pencarian pada nomor seri atau nomor perangkat. */
  q?: string;
};

/*
  Menyusun syarat filter dan mengumpulkan parameternya.

  Nilai selalu dikirim sebagai parameter, tidak pernah disambung ke SQL. Pencarian memakai
  ILIKE dengan pola yang di-escape lebih dulu, supaya karakter % dan _ yang diketik operator
  dicari apa adanya alih-alih berlaku sebagai wildcard.
*/
export function deviceFilterConditions(
  filter: DeviceFilter,
  params: unknown[],
): string {
  const conditions: string[] = [];

  if (filter.status) {
    conditions.push(`AND d.status = $${params.push(filter.status)}`);
  }
  if (filter.model) {
    conditions.push(`AND d.model = $${params.push(filter.model)}`);
  }
  if (filter.batchNumber) {
    conditions.push(`AND d.batch_number = $${params.push(filter.batchNumber)}`);
  }
  if (filter.customerId) {
    conditions.push(`AND d.customer_id = $${params.push(filter.customerId)}::uuid`);
  }
  if (filter.q) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const index = params.push(pattern);
    conditions.push(`AND (d.serial_number ILIKE $${index} OR d.device_uid ILIKE $${index})`);
  }

  return conditions.join("\n         ");
}

export async function findDevice(deviceId: string, executor?: Queryable) {
  return queryOne<{
    id: string;
    device_uid: string;
    serial_number: string;
    name: string | null;
    model: string | null;
    hardware_revision: string | null;
    batch_number: string | null;
    mac_address: string | null;
    imei: string | null;
    status: string;
    claim_method: string | null;
    customer_id: string | null;
    customer_name: string | null;
    customer_status: string | null;
    registered_by_admin_id: string | null;
    registered_by_name: string | null;
    warranty_start_at: Date | null;
    claimed_at: Date | null;
    activated_at: Date | null;
    deactivated_at: Date | null;
    created_at: Date;
    updated_at: Date;
    stream_url: string | null;
    connection_status: "active" | "offline" | "unknown";
    recording_status: "recording" | "not_recording" | "unknown";
    last_seen_at: Date | null;
  }>(
    `SELECT d.id, d.device_uid, d.serial_number, d.name, d.model, d.hardware_revision,
            d.batch_number, d.mac_address, d.imei, d.status, d.claim_method, d.customer_id,
            c.full_name AS customer_name, c.status AS customer_status,
            d.registered_by_admin_id, a.full_name AS registered_by_name,
            d.warranty_start_at, d.claimed_at, d.activated_at, d.deactivated_at,
            d.created_at, d.updated_at, t.stream_url,
            COALESCE(t.connection_status, 'unknown') AS connection_status,
            COALESCE(t.recording_status, 'unknown') AS recording_status,
            t.last_seen_at
     FROM devices d
     LEFT JOIN camera_telemetry t ON t.device_id = d.id
     LEFT JOIN customers c ON c.id = d.customer_id
     LEFT JOIN admin_users a ON a.id = d.registered_by_admin_id
     WHERE d.id = $1`,
    [deviceId],
    executor,
  );
}

/*
  Daftar model dan batch yang benar-benar ada di inventory.

  Dipakai mengisi pilihan filter. Daftar ini dibaca dari data, bukan dari daftar tetap di kode,
  supaya filter tidak pernah menawarkan model yang tidak dimiliki satu perangkat pun.
*/
export async function deviceFilterOptions(executor?: Queryable) {
  const [models, batches, counts] = await Promise.all([
    query<{ model: string }>(
      "SELECT DISTINCT model FROM devices WHERE model IS NOT NULL ORDER BY model",
      [],
      executor,
    ),
    query<{ batch_number: string }>(
      "SELECT DISTINCT batch_number FROM devices WHERE batch_number IS NOT NULL ORDER BY batch_number",
      [],
      executor,
    ),
    query<{ status: string; total: number; cursor_value: string }>(
      `SELECT status, count(*)::int AS total, '' AS cursor_value
       FROM devices GROUP BY status ORDER BY status`,
      [],
      executor,
    ),
  ]);

  return {
    models: models.map((row) => row.model),
    batches: batches.map((row) => row.batch_number),
    countsByStatus: Object.fromEntries(counts.map((row) => [row.status, row.total])),
  };
}

/*
  Ringkasan untuk kartu di atas tabel. Dibaca dari data yang sama dengan tabelnya, sehingga
  angka ringkasan dan isi tabel tidak mungkin saling bertentangan.
*/
export async function deviceSummary(executor?: Queryable) {
  return queryOne<{
    total: number;
    in_stock: number;
    claimed: number;
    suspended: number;
    retired: number;
    unclaimed_with_active_code: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'in_stock')::int AS in_stock,
            count(*) FILTER (WHERE status = 'claimed')::int AS claimed,
            count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
            count(*) FILTER (WHERE status = 'retired')::int AS retired,
            count(*) FILTER (
              WHERE status = 'in_stock'
                AND EXISTS (
                  SELECT 1 FROM device_claim_codes cc
                  WHERE cc.device_id = devices.id AND cc.used_at IS NULL
                )
            )::int AS unclaimed_with_active_code
     FROM devices
     WHERE status <> 'deleted'`,
    [],
    executor,
  );
}

/*
  Mendaftarkan perangkat baru, sekaligus menerbitkan kode claim pertamanya.

  Dijalankan dalam satu transaksi bersama caller, karena perangkat tanpa kode claim adalah
  perangkat yang tidak bisa diklaim siapa pun, dan itu keadaan yang tidak boleh tersimpan.
*/
export async function registerDevice(
  client: PoolClient,
  input: {
    serialNumber: string;
    name: string | null;
    model: string | null;
    hardwareRevision: string | null;
    batchNumber: string | null;
    macAddress: string | null;
    imei: string | null;
    warrantyStartAt: Date | null;
    adminUserId: string;
  },
): Promise<{ deviceId: string; deviceUid: string; claimToken: string }> {
  /*
    Nomor seri diperiksa lebih dulu supaya pesannya jelas. Batasan UNIQUE di database tetap
    menjadi penjaga terakhir, karena pemeriksaan di sini bisa dilewati dua permintaan serentak.
  */
  const existing = await queryOne<{ id: string; device_uid: string }>(
    "SELECT id, device_uid FROM devices WHERE serial_number = $1",
    [input.serialNumber],
    client,
  );
  if (existing) {
    throw new AppError({
      code: "SERIAL_NUMBER_ALREADY_REGISTERED",
      message:
        `Nomor seri ${input.serialNumber} sudah terdaftar sebagai perangkat ` +
        `${existing.device_uid}. Periksa kembali label perangkatnya, atau buka perangkat itu ` +
        `kalau memang perangkat yang sama.`,
      details: { serial_number: input.serialNumber, device_uid: existing.device_uid },
    });
  }

  const device = await queryOne<{ id: string; device_uid: string }>(
    `INSERT INTO devices
       (serial_number, name, model, hardware_revision, batch_number, mac_address, imei,
        warranty_start_at, registered_by_admin_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'in_stock')
     RETURNING id, device_uid`,
    [
      input.serialNumber,
      input.name,
      input.model,
      input.hardwareRevision,
      input.batchNumber,
      input.macAddress,
      input.imei,
      input.warrantyStartAt,
      input.adminUserId,
    ],
    client,
  );
  if (!device) throw new Error("Penyisipan perangkat tidak mengembalikan baris.");

  const claimToken = await issueClaimCode(client, device.id);

  return { deviceId: device.id, deviceUid: device.device_uid, claimToken };
}

/*
  Menerbitkan kode claim, mencabut kode lama kalau ada.

  Satu perangkat hanya boleh punya satu kode aktif. Kalau baris lama dibiarkan, kode yang sudah
  dicabut masih bisa dipakai mengklaim perangkat, dan itu berarti label lama yang seharusnya
  sudah tidak berlaku tetap berfungsi.
*/
export async function issueClaimCode(
  client: PoolClient,
  deviceId: string,
): Promise<string> {
  await client.query("DELETE FROM device_claim_codes WHERE device_id = $1", [deviceId]);

  /*
    Kode asli hanya ada di memori dan di nilai kembalian ini. Yang tersimpan adalah hash-nya,
    sehingga bocornya isi tabel tidak langsung memberi kode yang bisa dipakai mengklaim.
  */
  const token = generateClaimToken();

  await client.query(
    `INSERT INTO device_claim_codes (device_id, code_hash, format)
     VALUES ($1, $2, 'both')`,
    [deviceId, hashClaimToken(token)],
  );

  return token;
}

/*
  Keadaan kode claim sebuah perangkat.

  Yang dikembalikan adalah keadaannya, bukan kodenya. Kode asli tidak dapat ditampilkan lagi
  setelah dibuat, dan halaman detail harus mengatakan itu apa adanya alih-alih menyediakan
  tombol yang tidak bisa bekerja.
*/
export async function claimCodeState(deviceId: string, executor?: Queryable) {
  const row = await queryOne<{
    id: string;
    created_at: Date;
    used_at: Date | null;
    attempt_count: number;
    used_by_customer_id: string | null;
    used_by_name: string | null;
  }>(
    `SELECT cc.id, cc.created_at, cc.used_at, cc.attempt_count, cc.used_by_customer_id,
            c.full_name AS used_by_name
     FROM device_claim_codes cc
     LEFT JOIN customers c ON c.id = cc.used_by_customer_id
     WHERE cc.device_id = $1`,
    [deviceId],
    executor,
  );

  if (!row) {
    return { has_code: false as const, is_used: false as const };
  }

  return {
    has_code: true as const,
    created_at: row.created_at,
    is_used: row.used_at !== null,
    used_at: row.used_at,
    used_by_customer_id: row.used_by_customer_id,
    used_by_name: row.used_by_name,
    attempt_count: row.attempt_count,
    // Keadaan kode asli: tidak dapat ditampilkan lagi karena yang tersimpan hanya hash-nya.
    can_be_shown_again: false as const,
  };
}

export function claimLabel(token: string) {
  return {
    claim_token: token,
    claim_token_formatted: formatClaimToken(token),
    qr_payload: claimQrPayload(token),
  };
}

/*
  Riwayat percobaan claim untuk satu perangkat.

  dipakai halaman detail perangkat, karena pertanyaan "kenapa pelanggan ini tidak bisa
  mengklaim" paling sering jawabannya ada di percobaan yang gagal.
*/
export async function deviceClaimAttempts(deviceId: string, limit = 20, executor?: Queryable) {
  return query<{
    id: string;
    success: boolean;
    failure_reason: string | null;
    submitted_kind: string;
    submitted_value_masked: string | null;
    ip_address: string | null;
    customer_id: string | null;
    customer_name: string | null;
    created_at: Date;
  }>(
    `SELECT a.id, a.success, a.failure_reason, a.submitted_kind, a.submitted_value_masked,
            host(a.ip_address) AS ip_address, a.customer_id, c.full_name AS customer_name,
            a.created_at
     FROM device_claim_attempts a
     LEFT JOIN customers c ON c.id = a.customer_id
     WHERE a.device_id = $1
     ORDER BY a.created_at DESC
     LIMIT $2`,
    [deviceId, limit],
    executor,
  );
}

/*
  Batas perangkat yang berlaku untuk seorang customer.

  device_limit NULL berarti tanpa batas. Ini sengaja dibedakan dari 0, karena 0 berarti tidak
  boleh ada perangkat sama sekali, dan menyamakan keduanya akan membuat paket tanpa batas
  berubah menjadi paket yang menolak semua perangkat.
*/
export async function deviceLimitFor(
  customerId: string,
  executor?: Queryable,
): Promise<{ planName: string; deviceLimit: number | null; activeCount: number } | null> {
  const row = await queryOne<{
    plan_name: string;
    device_limit: number | null;
    active_count: number;
  }>(
    `SELECT p.name AS plan_name,
            p.device_limit,
            (SELECT count(*)::int FROM devices d
              WHERE d.customer_id = s.customer_id
                AND d.status = ANY($2::text[])) AS active_count
     FROM subscriptions s
     JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.customer_id = $1
       AND s.status IN ('trialing', 'active', 'past_due')
     LIMIT 1`,
    [customerId, COUNTED_DEVICE_STATUSES],
    executor,
  );

  if (!row) return null;

  return {
    planName: row.plan_name,
    deviceLimit: row.device_limit,
    activeCount: row.active_count,
  };
}

export function assertWithinDeviceLimit(state: {
  planName: string;
  deviceLimit: number | null;
  activeCount: number;
}): void {
  if (state.deviceLimit === null) return;
  if (state.activeCount < state.deviceLimit) return;

  throw new AppError({
    code: "DEVICE_LIMIT_REACHED",
    message:
      `Batas perangkat paket ${state.planName} sudah tercapai: ${state.activeCount} dari ` +
      `${state.deviceLimit} perangkat terpakai. Nonaktifkan salah satu perangkat, atau ` +
      `naikkan paketnya lebih dulu.`,
    details: {
      device_limit: state.deviceLimit,
      active_device_count: state.activeCount,
      plan_name: state.planName,
    },
  });
}

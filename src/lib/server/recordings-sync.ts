import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { query } from "./db";
import { ensureMediamtxPath } from "./mobile-data";

export const RECORDINGS_DIR = process.env.MEDIAMTX_RECORDINGS_DIR ?? "/recordings";
const RETENTION_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 60 * 1000;
const ACTIVE_SEGMENT_GRACE_MS = 15 * 1000;

let schemaReady = false;
let syncRunning = false;

async function ensureRecordingSchema(): Promise<void> {
  if (schemaReady) return;
  try {
    await query(`
      ALTER TABLE camera_recordings
        ADD COLUMN IF NOT EXISTS file_path text,
        ADD COLUMN IF NOT EXISTS file_size_bytes bigint;
    `);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS camera_recordings_device_file_idx
        ON camera_recordings (device_id, file_path)
        WHERE file_path IS NOT NULL;
    `);
    schemaReady = true;
  } catch (err) {
    console.warn("[recordings-sync] gagal memastikan kolom schema camera_recordings:", err);
  }
}

/**
 * Mengonversi nama file rekaman MediaMTX (`YYYY-MM-DD_HH-MM-SS.mp4`) menjadi Date UTC.
 */
function parseSegmentStartTime(filename: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.mp4$/i.exec(filename);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Mendaftarkan seluruh kamera aktif ke MediaMTX agar selalu streaming & merekam 24/7.
 */
export async function syncAllAlwaysOnStreams(): Promise<void> {
  const devices = await query<{ id: string; serial_number: string; stream_url: string | null }>(
    `SELECT d.id, d.serial_number, t.stream_url
     FROM devices d
     LEFT JOIN camera_telemetry t ON t.device_id = d.id
     WHERE d.status IN ('claimed', 'suspended')
       AND t.stream_url LIKE 'rtsp://%'`,
  );

  for (const device of devices) {
    if (!device.stream_url) continue;
    const streamKey = `cam-${device.serial_number.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    await ensureMediamtxPath(streamKey, device.stream_url);
  }
}

/**
 * Memindai segmen rekaman di disk, mengindeks ke `camera_recordings`, dan menghapus record > 24 jam.
 */
export async function syncRecordingsFromDisk(): Promise<void> {
  await ensureRecordingSchema();

  const now = Date.now();
  const cutoffMs = now - RETENTION_MS;

  // 1. Hapus langsung seluruh record yang usianya sudah melewati 1 hari (24 jam)
  await query(
    `DELETE FROM camera_recordings
     WHERE started_at < now() - interval '24 hours'
        OR (expires_at IS NOT NULL AND expires_at < now())`,
  );

  // 2. Ambil daftar device untuk memetakan folder streamKey -> device_id
  const devices = await query<{ id: string; serial_number: string }>(
    `SELECT id, serial_number FROM devices WHERE status IN ('claimed', 'suspended')`,
  );
  const keyToDeviceId = new Map<string, string>();
  for (const d of devices) {
    const streamKey = `cam-${d.serial_number.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    keyToDeviceId.set(streamKey, d.id);
  }

  // 3. Scan direktori /recordings/<streamKey>/*.mp4
  let dirEntries;
  try {
    dirEntries = await readdir(RECORDINGS_DIR, { withFileTypes: true });
  } catch {
    // Folder /recordings belum tersedia (misal di environment lokal non-Docker)
    return;
  }

  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const deviceId = keyToDeviceId.get(entry.name);
    if (!deviceId) continue;

    const camDir = path.join(RECORDINGS_DIR, entry.name);
    let files;
    try {
      files = await readdir(camDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".mp4")) continue;
      const startedAt = parseSegmentStartTime(file.name);
      if (!startedAt) continue;

      // Abaikan file yang lebih tua dari 24 jam (akan dihapus otomatis oleh MediaMTX)
      if (startedAt.getTime() < cutoffMs) continue;

      const relativePath = `${entry.name}/${file.name}`;
      const fullPath = path.join(camDir, file.name);
      let fileStat;
      try {
        fileStat = await stat(fullPath);
      } catch {
        continue;
      }

      // Lewati file yang baru saja ditulis dalam 15 detik terakhir (masih aktif direkam MediaMTX)
      if (now - fileStat.mtimeMs < ACTIVE_SEGMENT_GRACE_MS || fileStat.size === 0) {
        continue;
      }

      const endedAt = new Date(Math.max(startedAt.getTime(), fileStat.mtimeMs));
      const durationSeconds = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
      const expiresAt = new Date(startedAt.getTime() + RETENTION_MS);

      await query(
        `INSERT INTO camera_recordings (
           device_id, status, started_at, ended_at, duration_seconds,
           expires_at, file_path, file_size_bytes
         )
         VALUES ($1, 'available', $2, $3, $4, $5, $6, $7)
         ON CONFLICT (device_id, file_path) WHERE file_path IS NOT NULL
         DO UPDATE SET
           ended_at = EXCLUDED.ended_at,
           duration_seconds = EXCLUDED.duration_seconds,
           file_size_bytes = EXCLUDED.file_size_bytes,
           expires_at = EXCLUDED.expires_at,
           status = 'available'`,
        [
          deviceId,
          startedAt.toISOString(),
          endedAt.toISOString(),
          durationSeconds,
          expiresAt.toISOString(),
          relativePath,
          fileStat.size,
        ],
      );
    }
  }

  // 4. Bersihkan record yang file fisiknya sudah tidak ada di disk
  const indexedRows = await query<{ id: string; file_path: string }>(
    `SELECT id, file_path FROM camera_recordings WHERE file_path IS NOT NULL`,
  );
  for (const row of indexedRows) {
    const fullPath = path.join(RECORDINGS_DIR, row.file_path);
    try {
      await stat(fullPath);
    } catch {
      await query(`DELETE FROM camera_recordings WHERE id = $1`, [row.id]);
    }
  }
}

export async function runRecordingSyncTick(): Promise<void> {
  if (syncRunning) return;
  syncRunning = true;
  try {
    await syncAllAlwaysOnStreams();
    await syncRecordingsFromDisk();
  } catch (err) {
    console.error("[recordings-sync] error saat sinkronisasi berkala:", err);
  } finally {
    syncRunning = false;
  }
}

export function startRecordingSyncLoop(): void {
  const g = globalThis as typeof globalThis & { __nayakaRecordingSyncStarted?: boolean };
  if (g.__nayakaRecordingSyncStarted) return;
  g.__nayakaRecordingSyncStarted = true;

  setTimeout(() => {
    void runRecordingSyncTick();
  }, 3000);

  setInterval(() => {
    void runRecordingSyncTick();
  }, SYNC_INTERVAL_MS);
}

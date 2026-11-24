import { z } from "zod";
import { query, queryOne } from "@/lib/server/db";
import { isCameraMutedBySleepSchedule } from "@/lib/server/evidence";
import { sendAlertPushNotification } from "@/lib/server/fcm";
import { AppError } from "@/lib/server/errors";
import { parseJson } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

function assertInternalSecret(request: Request): void {
  const expected = process.env.INTERNAL_WORKER_SECRET?.trim();
  if (!expected) return;
  const provided = request.headers.get("x-internal-secret")?.trim();
  if (provided !== expected) {
    throw new AppError({ code: "INVALID_CREDENTIALS", message: "Internal worker secret tidak valid." });
  }
}

const ingestSchema = z.object({
  alert_id: z.string().uuid(),
  device_id: z.string().uuid(),
  alert_type: z.enum(["motion", "person"]),
  onvif_topic: z.string().min(1).max(300),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  snapshot_path: z.string().nullable().optional(),
  clip_path: z.string().nullable().optional(),
  clip_duration_seconds: z.number().int().min(0).max(120).nullable().optional(),
  evidence_status: z.enum(["none", "processing", "ready", "failed"]).default("ready"),
});

export const GET = routeHandler("internal.onvif_events.cameras", async (request, requestId) => {
  assertInternalSecret(request);

  const rows = await query<{
    device_id: string;
    serial_number: string;
    stream_url: string;
    motion_detection_enabled: boolean;
    person_detection_enabled: boolean;
    cooldown_seconds: number;
  }>(
    `SELECT d.id AS device_id,
            d.serial_number,
            t.stream_url,
            COALESCE(s.motion_detection_enabled, true) AS motion_detection_enabled,
            COALESCE(s.person_detection_enabled, true) AS person_detection_enabled,
            COALESCE(s.cooldown_seconds, 30) AS cooldown_seconds
     FROM devices d
     JOIN camera_telemetry t ON t.device_id = d.id
     LEFT JOIN camera_alert_settings s ON s.device_id = d.id
     WHERE d.status IN ('claimed', 'suspended')
       AND t.stream_url LIKE 'rtsp://%'`,
  );

  const cameras = rows.map((row) => ({
    device_id: row.device_id,
    serial_number: row.serial_number,
    stream_key: `cam-${row.serial_number.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
    stream_url: row.stream_url,
    motion_detection_enabled: row.motion_detection_enabled,
    person_detection_enabled: row.person_detection_enabled,
    cooldown_seconds: row.cooldown_seconds,
  }));

  return ok({ cameras }, requestId);
});

export const POST = routeHandler("internal.onvif_events.ingest", async (request, requestId) => {
  assertInternalSecret(request);
  const input = await parseJson(request, ingestSchema);

  const device = await queryOne<{
    id: string;
    customer_id: string | null;
    name: string | null;
    notifications_enabled: boolean;
  }>(
    `SELECT d.id,
            d.customer_id,
            COALESCE(d.name, d.device_uid) AS name,
            COALESCE(s.notifications_enabled, true) AS notifications_enabled
     FROM devices d
     LEFT JOIN camera_alert_settings s ON s.device_id = d.id
     WHERE d.id = $1`,
    [input.device_id],
  );

  if (!device) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Perangkat tidak ditemukan." });
  }

  const isPerson = input.alert_type === "person";
  const severity = isPerson ? "critical" : "warning";
  const title = isPerson ? "Orang Terdeteksi" : "Gerakan Terdeteksi";
  const cameraName = device.name ?? "Kamera";
  const message = isPerson
    ? `Seseorang terdeteksi di area kamera ${cameraName}.`
    : `Gerakan terdeteksi di area kamera ${cameraName}.`;
  const occurredAt = input.occurred_at ? new Date(input.occurred_at) : new Date();
  const thumbnailUrl = input.snapshot_path ? `/api/v1/mobile/alerts/${input.alert_id}/snapshot` : null;

  await query(
    `INSERT INTO camera_alerts (
       id, device_id, alert_type, severity, title, message,
       thumbnail_url, occurred_at, snapshot_path, clip_path,
       clip_duration_seconds, evidence_status, onvif_topic
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO UPDATE SET
       snapshot_path = COALESCE(EXCLUDED.snapshot_path, camera_alerts.snapshot_path),
       clip_path = COALESCE(EXCLUDED.clip_path, camera_alerts.clip_path),
       clip_duration_seconds = COALESCE(EXCLUDED.clip_duration_seconds, camera_alerts.clip_duration_seconds),
       evidence_status = EXCLUDED.evidence_status,
       thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, camera_alerts.thumbnail_url)`,
    [
      input.alert_id,
      input.device_id,
      input.alert_type,
      severity,
      title,
      message,
      thumbnailUrl,
      occurredAt.toISOString(),
      input.snapshot_path ?? null,
      input.clip_path ?? null,
      input.clip_duration_seconds ?? null,
      input.evidence_status,
      input.onvif_topic,
    ],
  );

  let pushSent = false;
  if (device.customer_id && device.notifications_enabled) {
    const muted = await isCameraMutedBySleepSchedule(device.customer_id, device.id);
    if (!muted) {
      pushSent = true;
      void sendAlertPushNotification({
        customerId: device.customer_id,
        alertId: input.alert_id,
        cameraId: device.id,
        cameraName,
        alertType: input.alert_type,
        severity,
        title,
        body: message,
        occurredAt: occurredAt.toISOString(),
      });
    }
  }

  return ok({ alert_id: input.alert_id, push_dispatched: pushSent }, requestId);
});

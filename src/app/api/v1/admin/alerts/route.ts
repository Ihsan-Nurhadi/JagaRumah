import { query } from "@/lib/server/db";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

export const GET = routeHandler("admin.alerts.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "device.read");

  const url = new URL(request.url);
  const deviceId = url.searchParams.get("device_id");
  const alertType = url.searchParams.get("type");
  const severity = url.searchParams.get("severity");
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "30", 10);
  const limit = Number.isNaN(limitRaw) ? 30 : Math.min(Math.max(limitRaw, 1), 100);

  const values: unknown[] = [];
  const where: string[] = ["1=1"];

  if (deviceId) {
    values.push(deviceId);
    where.push(`a.device_id = $${values.length}::uuid`);
  }
  if (alertType && ["motion", "person"].includes(alertType)) {
    values.push(alertType);
    where.push(`a.alert_type = $${values.length}`);
  }
  if (severity && ["info", "warning", "critical"].includes(severity)) {
    values.push(severity);
    where.push(`a.severity = $${values.length}`);
  }

  values.push(limit);

  const rows = await query<{
    id: string;
    device_id: string;
    device_uid: string;
    camera_name: string | null;
    customer_id: string | null;
    customer_name: string | null;
    alert_type: string;
    severity: string;
    title: string;
    message: string | null;
    snapshot_path: string | null;
    clip_path: string | null;
    clip_duration_seconds: number | null;
    evidence_status: string;
    onvif_topic: string | null;
    occurred_at: Date;
    is_read: boolean;
  }>(
    `SELECT a.id,
            a.device_id,
            d.device_uid,
            COALESCE(d.name, d.device_uid) AS camera_name,
            d.customer_id,
            c.full_name AS customer_name,
            a.alert_type,
            a.severity,
            a.title,
            a.message,
            a.snapshot_path,
            a.clip_path,
            a.clip_duration_seconds,
            a.evidence_status,
            a.onvif_topic,
            a.occurred_at,
            a.is_read
     FROM camera_alerts a
     JOIN devices d ON d.id = a.device_id
     LEFT JOIN customers c ON c.id = d.customer_id
     WHERE ${where.join(" AND ")}
     ORDER BY a.occurred_at DESC
     LIMIT $${values.length}`,
    values,
  );

  const alerts = rows.map((r) => ({
    id: r.id,
    device_id: r.device_id,
    device_uid: r.device_uid,
    camera_name: r.camera_name,
    customer_id: r.customer_id,
    customer_name: r.customer_name,
    type: r.alert_type,
    severity: r.severity,
    title: r.title,
    message: r.message,
    snapshot_url: r.snapshot_path ? `/api/v1/admin/alerts/${r.id}/snapshot` : null,
    clip_url: r.clip_path ? `/api/v1/admin/alerts/${r.id}/clip` : null,
    clip_duration_seconds: r.clip_duration_seconds,
    evidence_status: r.evidence_status,
    onvif_topic: r.onvif_topic,
    occurred_at: r.occurred_at.toISOString(),
    is_read: r.is_read,
  }));

  return ok({ alerts }, requestId);
});

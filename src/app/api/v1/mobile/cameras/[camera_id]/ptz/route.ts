import { z } from "zod";
import { queryOne } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireMobile } from "@/lib/server/mobile";
import { sendOnvifPtzCommand } from "@/lib/server/onvif-ptz";
import { ok, requireUuid } from "@/lib/server/request";
import { parseJson } from "@/lib/server/parse";
import { routeHandler } from "@/lib/server/route";

const ptzSchema = z.object({
  direction: z.enum(["up", "down", "left", "right", "zoom_in", "zoom_out", "stop"]),
  speed: z.number().min(0.1).max(1).optional().default(0.5),
  duration_ms: z.number().int().min(0).max(3000).optional().default(400),
});

type Context = { params: Promise<{ camera_id?: string }> };

export const POST = routeHandler("mobile.cameras.ptz", async (request, requestId, context) => {
  const session = await requireMobile(request);
  const cameraId = requireUuid((await (context as Context).params).camera_id, "camera_id");
  const input = await parseJson(request, ptzSchema);

  const row = await queryOne<{ id: string; stream_url: string | null }>(
    `SELECT d.id, t.stream_url
     FROM devices d
     LEFT JOIN camera_telemetry t ON t.device_id = d.id
     WHERE d.id = $1 AND d.customer_id = $2 AND d.status IN ('claimed', 'suspended')`,
    [cameraId, session.customerId],
  );

  if (!row) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Kamera tidak ditemukan." });
  }
  if (!row.stream_url?.startsWith("rtsp://")) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: "Kamera belum memiliki konfigurasi RTSP/ONVIF untuk kontrol PTZ.",
    });
  }

  await sendOnvifPtzCommand({
    streamUrl: row.stream_url,
    direction: input.direction,
    speed: input.speed,
    durationMs: input.duration_ms,
  });

  // Catat waktu PTZ terakhir agar worker AI mengkalibrasi ulang baseline kendaraan parkir
  await queryOne(
    `INSERT INTO camera_alert_settings (device_id, last_ptz_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (device_id) DO UPDATE SET
       last_ptz_at = now(),
       updated_at = now()
     RETURNING device_id`,
    [cameraId],
  ).catch(() => {});

  return ok(
    {
      camera_id: cameraId,
      direction: input.direction,
      executed: true,
    },
    requestId,
  );
});

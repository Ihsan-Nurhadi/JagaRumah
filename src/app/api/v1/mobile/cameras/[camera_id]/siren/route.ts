import { z } from "zod";
import { queryOne } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireMobile } from "@/lib/server/mobile";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { triggerCameraSiren } from "@/lib/server/talkback";

const sirenSchema = z.object({
  duration_seconds: z.number().int().min(3).max(20).optional().default(8),
});

type Context = { params: Promise<{ camera_id?: string }> };

export const POST = routeHandler("mobile.cameras.siren", async (request, requestId, context) => {
  const session = await requireMobile(request);
  const cameraId = requireUuid((await (context as Context).params).camera_id, "camera_id");

  let durationSeconds = 8;
  try {
    const rawText = await request.text();
    if (rawText.trim()) {
      const parsed = sirenSchema.parse(JSON.parse(rawText));
      durationSeconds = parsed.duration_seconds;
    }
  } catch {
    throw new AppError({ code: "VALIDATION_ERROR", message: "Parameter sirine tidak valid (duration_seconds: 3..20)." });
  }

  const device = await queryOne<{ id: string; stream_url: string | null }>(
    `SELECT d.id, t.stream_url
     FROM devices d
     LEFT JOIN camera_telemetry t ON t.device_id = d.id
     WHERE d.id = $1 AND d.customer_id = $2 AND d.status IN ('claimed', 'suspended')`,
    [cameraId, session.customerId],
  );

  if (!device) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Kamera tidak ditemukan." });
  }
  if (!device.stream_url?.startsWith("rtsp://")) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: "Kamera belum memiliki konfigurasi RTSP/Tapo untuk memicu sirine.",
    });
  }

  const result = await triggerCameraSiren({
    rtspUrl: device.stream_url,
    durationSeconds,
  });

  return ok(
    {
      camera_id: cameraId,
      triggered: true,
      mode: result.mode,
    },
    requestId,
  );
});

import { z } from "zod";
import { queryOne } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Context = { params: Promise<{ device_id?: string }> };

const patchSchema = z.object({
  motion_detection_enabled: z.boolean(),
  person_detection_enabled: z.boolean(),
  notifications_enabled: z.boolean(),
  cooldown_seconds: z.number().int().min(5).max(3600),
});

export const GET = routeHandler("admin.devices.alert_settings.get", async (_request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "device.read");
  const deviceId = requireUuid((await (context as Context).params).device_id, "device_id");

  const exists = await queryOne<{ id: string }>("SELECT id FROM devices WHERE id = $1", [deviceId]);
  if (!exists) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Perangkat tidak ditemukan." });
  }

  const settings = await queryOne<{
    motion_detection_enabled: boolean;
    person_detection_enabled: boolean;
    notifications_enabled: boolean;
    cooldown_seconds: number;
  }>(
    `SELECT motion_detection_enabled, person_detection_enabled, notifications_enabled, cooldown_seconds
     FROM camera_alert_settings
     WHERE device_id = $1`,
    [deviceId],
  );

  return ok(
    {
      settings: settings ?? {
        motion_detection_enabled: true,
        person_detection_enabled: true,
        notifications_enabled: true,
        cooldown_seconds: 30,
      },
    },
    requestId,
  );
});

export const PATCH = routeHandler("admin.devices.alert_settings.patch", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "device.write");
  await requireCsrf(request);

  const deviceId = requireUuid((await (context as Context).params).device_id, "device_id");
  const input = await parseJson(request, patchSchema);

  const exists = await queryOne<{ id: string }>("SELECT id FROM devices WHERE id = $1", [deviceId]);
  if (!exists) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Perangkat tidak ditemukan." });
  }

  await queryOne(
    `INSERT INTO camera_alert_settings (
       device_id, motion_detection_enabled, person_detection_enabled, notifications_enabled, cooldown_seconds, updated_at
     ) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (device_id) DO UPDATE SET
       motion_detection_enabled = EXCLUDED.motion_detection_enabled,
       person_detection_enabled = EXCLUDED.person_detection_enabled,
       notifications_enabled = EXCLUDED.notifications_enabled,
       cooldown_seconds = EXCLUDED.cooldown_seconds,
       updated_at = now()
     RETURNING device_id`,
    [
      deviceId,
      input.motion_detection_enabled,
      input.person_detection_enabled,
      input.notifications_enabled,
      input.cooldown_seconds,
    ],
  );

  return ok({ settings: input }, requestId);
});

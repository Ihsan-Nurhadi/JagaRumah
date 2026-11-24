import { z } from "zod";
import { query, queryOne, withTransaction } from "@/lib/server/db";
import { requireMobile } from "@/lib/server/mobile";
import { parseJson } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

const updateAlertSettingsSchema = z.object({
  cameras: z.array(
    z.object({
      camera_id: z.string().uuid(),
      motion_detection_enabled: z.boolean(),
      person_detection_enabled: z.boolean().optional().default(true),
      notifications_enabled: z.boolean(),
    }),
  ),
  sleep_mode: z.object({
    enabled: z.boolean(),
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
    active_days: z.array(z.enum(["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"])),
    camera_ids: z.array(z.string().uuid()),
  }),
});

export const GET = routeHandler("mobile.alerts.settings.get", async (request, requestId) => {
  const session = await requireMobile(request);

  const cameras = await query<{
    camera_id: string;
    camera_name: string;
    motion_detection_enabled: boolean;
    person_detection_enabled: boolean;
    notifications_enabled: boolean;
  }>(
    `SELECT d.id AS camera_id,
            COALESCE(d.name, d.device_uid) AS camera_name,
            COALESCE(s.motion_detection_enabled, true) AS motion_detection_enabled,
            COALESCE(s.person_detection_enabled, true) AS person_detection_enabled,
            COALESCE(s.notifications_enabled, true) AS notifications_enabled
     FROM devices d
     LEFT JOIN camera_alert_settings s ON s.device_id = d.id
     WHERE d.customer_id = $1 AND d.status IN ('claimed', 'suspended')
     ORDER BY d.name, d.device_uid`,
    [session.customerId],
  );

  const sleep = await queryOne<{
    enabled: boolean;
    start_time: string;
    end_time: string;
    active_days: string[];
    camera_ids: string[];
  }>(
    `SELECT enabled, start_time, end_time, active_days, camera_ids
     FROM customer_sleep_schedules
     WHERE customer_id = $1`,
    [session.customerId],
  );

  return ok(
    {
      cameras,
      sleep_mode: sleep ?? {
        enabled: false,
        start_time: "22:00",
        end_time: "06:00",
        active_days: ["Sen", "Sel", "Rab", "Kam", "Jum"],
        camera_ids: [],
      },
    },
    requestId,
  );
});

export const PUT = routeHandler("mobile.alerts.settings.put", async (request, requestId) => {
  const session = await requireMobile(request);
  const input = await parseJson(request, updateAlertSettingsSchema);

  await withTransaction(async (client) => {
    const ownedRows = await query<{ id: string }>(
      `SELECT id FROM devices WHERE customer_id = $1 AND status IN ('claimed', 'suspended')`,
      [session.customerId],
      client,
    );
    const ownedIds = new Set(ownedRows.map((r) => r.id));

    for (const cam of input.cameras) {
      if (!ownedIds.has(cam.camera_id)) continue;
      await query(
        `INSERT INTO camera_alert_settings (
           device_id, motion_detection_enabled, person_detection_enabled, notifications_enabled, updated_at
         ) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (device_id) DO UPDATE SET
           motion_detection_enabled = EXCLUDED.motion_detection_enabled,
           person_detection_enabled = EXCLUDED.person_detection_enabled,
           notifications_enabled = EXCLUDED.notifications_enabled,
           updated_at = now()`,
        [cam.camera_id, cam.motion_detection_enabled, cam.person_detection_enabled, cam.notifications_enabled],
        client,
      );
    }

    const filteredSleepCameraIds = input.sleep_mode.camera_ids.filter((id) => ownedIds.has(id));
    await query(
      `INSERT INTO customer_sleep_schedules (
         customer_id, enabled, start_time, end_time, active_days, camera_ids, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::uuid[], now())
       ON CONFLICT (customer_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         start_time = EXCLUDED.start_time,
         end_time = EXCLUDED.end_time,
         active_days = EXCLUDED.active_days,
         camera_ids = EXCLUDED.camera_ids,
         updated_at = now()`,
      [
        session.customerId,
        input.sleep_mode.enabled,
        input.sleep_mode.start_time,
        input.sleep_mode.end_time,
        input.sleep_mode.active_days,
        filteredSleepCameraIds,
      ],
      client,
    );
  });

  return ok({ saved: true }, requestId);
});

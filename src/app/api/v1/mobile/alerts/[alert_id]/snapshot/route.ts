import { queryOne } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { streamSnapshotFile } from "@/lib/server/evidence";
import { requireMobile } from "@/lib/server/mobile";
import { requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Context = { params: Promise<{ alert_id?: string }> };

export const GET = routeHandler("mobile.alerts.snapshot", async (request, _requestId, context) => {
  const session = await requireMobile(request);
  const alertId = requireUuid((await (context as Context).params).alert_id, "alert_id");

  const row = await queryOne<{ snapshot_path: string | null }>(
    `SELECT a.snapshot_path
     FROM camera_alerts a
     JOIN devices d ON d.id = a.device_id
     WHERE a.id = $1 AND d.customer_id = $2`,
    [alertId, session.customerId],
  );
  if (!row) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Alert tidak ditemukan." });
  }

  return streamSnapshotFile(row.snapshot_path);
});

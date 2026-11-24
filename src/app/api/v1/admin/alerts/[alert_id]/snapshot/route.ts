import { queryOne } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { streamSnapshotFile } from "@/lib/server/evidence";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Context = { params: Promise<{ alert_id?: string }> };

export const GET = routeHandler("admin.alerts.snapshot", async (_request, _requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "device.read");

  const alertId = requireUuid((await (context as Context).params).alert_id, "alert_id");
  const row = await queryOne<{ snapshot_path: string | null }>(
    `SELECT snapshot_path FROM camera_alerts WHERE id = $1`,
    [alertId],
  );
  if (!row) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Alert tidak ditemukan." });
  }
  return streamSnapshotFile(row.snapshot_path);
});

import { queryOne } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { streamClipFile } from "@/lib/server/evidence";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Context = { params: Promise<{ alert_id?: string }> };

export const GET = routeHandler("admin.alerts.clip", async (request, _requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "device.read");

  const alertId = requireUuid((await (context as Context).params).alert_id, "alert_id");
  const row = await queryOne<{ clip_path: string | null; alert_type: string }>(
    `SELECT clip_path, alert_type FROM camera_alerts WHERE id = $1`,
    [alertId],
  );
  if (!row) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Alert tidak ditemukan." });
  }

  const url = new URL(request.url);
  const isDownload = url.searchParams.get("download") === "1";
  const downloadName = isDownload ? `evidence-${row.alert_type}-${alertId.slice(0, 8)}.mp4` : undefined;
  return streamClipFile(request, row.clip_path, downloadName);
});

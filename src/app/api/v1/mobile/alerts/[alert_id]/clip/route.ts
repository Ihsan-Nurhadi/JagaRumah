import { queryOne } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { streamClipFile } from "@/lib/server/evidence";
import { requireMobile } from "@/lib/server/mobile";
import { requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Context = { params: Promise<{ alert_id?: string }> };

export const GET = routeHandler("mobile.alerts.clip", async (request, _requestId, context) => {
  const session = await requireMobile(request);
  const alertId = requireUuid((await (context as Context).params).alert_id, "alert_id");

  const row = await queryOne<{ clip_path: string | null; alert_type: string }>(
    `SELECT a.clip_path, a.alert_type
     FROM camera_alerts a
     JOIN devices d ON d.id = a.device_id
     WHERE a.id = $1 AND d.customer_id = $2`,
    [alertId, session.customerId],
  );
  if (!row) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Alert tidak ditemukan." });
  }

  const url = new URL(request.url);
  const isDownload = url.searchParams.get("download") === "1";
  const downloadName = isDownload ? `evidence-${row.alert_type}-${alertId.slice(0, 8)}.mp4` : undefined;
  return streamClipFile(request, row.clip_path, downloadName);
});

import { requireMobile } from "@/lib/server/mobile";
import { cameraStreamUrls } from "@/lib/server/mobile-data";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Context = { params: Promise<{ camera_id?: string }> };

export const GET = routeHandler("mobile.cameras.stream", async (request, requestId, context) => {
  const session = await requireMobile(request);
  const cameraId = requireUuid((await (context as Context).params).camera_id, "camera_id");
  const result = await cameraStreamUrls(session.customerId, cameraId);
  return ok(result, requestId);
});

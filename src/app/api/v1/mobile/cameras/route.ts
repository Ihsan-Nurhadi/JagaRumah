import { requireMobile } from "@/lib/server/mobile";
import { cameraList, mobilePage } from "@/lib/server/mobile-data";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const GET = routeHandler("mobile.cameras.list", async (request, requestId) => { const s=await requireMobile(request); return ok(await cameraList(s.customerId,mobilePage(request)),requestId); });

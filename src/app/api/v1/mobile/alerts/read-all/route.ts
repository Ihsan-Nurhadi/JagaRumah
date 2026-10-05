import { requireMobile } from "@/lib/server/mobile";
import { markAlertRead } from "@/lib/server/mobile-data";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const POST=routeHandler("mobile.alerts.read-all",async(request,requestId)=>{const s=await requireMobile(request);return ok(await markAlertRead(s.customerId),requestId);});

import { requireMobile } from "@/lib/server/mobile";
import { alertDetail, markAlertRead } from "@/lib/server/mobile-data";
import { noContent, ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
type C={params:Promise<{alert_id?:string}>};
export const GET=routeHandler("mobile.alerts.detail",async(request,requestId,context)=>{const s=await requireMobile(request);return ok(await alertDetail(s.customerId,requireUuid((await(context as C).params).alert_id,"alert_id")),requestId);});
export const POST=routeHandler("mobile.alerts.read",async(request,requestId,context)=>{const s=await requireMobile(request);await markAlertRead(s.customerId,requireUuid((await(context as C).params).alert_id,"alert_id"));return noContent(requestId);});

import { requireMobile } from "@/lib/server/mobile";
import { cameraDetail } from "@/lib/server/mobile-data";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
type C={params:Promise<{camera_id?:string}>};
export const GET=routeHandler("mobile.cameras.detail",async(request,requestId,context)=>{const s=await requireMobile(request);const id=requireUuid((await(context as C).params).camera_id,"camera_id");return ok(await cameraDetail(s.customerId,id),requestId);});

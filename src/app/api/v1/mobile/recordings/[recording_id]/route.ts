import { requireMobile } from "@/lib/server/mobile";
import { recordingDetail } from "@/lib/server/mobile-data";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
type C={params:Promise<{recording_id?:string}>};
export const GET=routeHandler("mobile.recordings.detail",async(request,requestId,context)=>{const s=await requireMobile(request);return ok(await recordingDetail(s.customerId,requireUuid((await(context as C).params).recording_id,"recording_id")),requestId);});

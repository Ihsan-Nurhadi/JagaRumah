import { requireMobile } from "@/lib/server/mobile";
import { recordingList, mobilePage } from "@/lib/server/mobile-data";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const GET=routeHandler("mobile.recordings.list",async(request,requestId)=>{const s=await requireMobile(request);return ok(await recordingList(s.customerId,mobilePage(request)),requestId);});

import { requireMobile } from "@/lib/server/mobile";
import { setBiometric } from "@/lib/server/mobile-data";
import { ok, noContent } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const POST=routeHandler("mobile.biometric.enable",async(request,requestId)=>{const s=await requireMobile(request);return ok(await setBiometric(s.customerId,request,true),requestId);});
export const DELETE=routeHandler("mobile.biometric.disable",async(request,requestId)=>{const s=await requireMobile(request);await setBiometric(s.customerId,request,false);return noContent(requestId);});

import { requireMobile } from "@/lib/server/mobile";
import { registerPush } from "@/lib/server/mobile-data";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const POST=routeHandler("mobile.push-tokens.register",async(request,requestId)=>{const s=await requireMobile(request);return ok(await registerPush(s.customerId,request),requestId);});

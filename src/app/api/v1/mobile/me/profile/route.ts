import { requireMobile } from "@/lib/server/mobile";
import { updateProfile } from "@/lib/server/mobile-data";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const PATCH=routeHandler("mobile.me.patch",async(request,requestId)=>{const s=await requireMobile(request);return ok(await updateProfile(request,s.customerId),requestId);});

import { requireMobile } from "@/lib/server/mobile";
import { settingsGet, settingsPatch } from "@/lib/server/mobile-data";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const GET=routeHandler("mobile.settings.get",async(request,requestId)=>{const s=await requireMobile(request);return ok(await settingsGet(s.customerId,s.installationId),requestId);});
export const PATCH=routeHandler("mobile.settings.patch",async(request,requestId)=>{const s=await requireMobile(request);return ok(await settingsPatch(request,s.customerId),requestId);});

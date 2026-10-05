import { terms } from "@/lib/server/mobile-data";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const GET=routeHandler("mobile.terms.get",async(request,requestId)=>{const u=new URL(request.url);return ok(await terms(u.searchParams.get("locale")??"id-ID",u.searchParams.get("version")??undefined),requestId);});

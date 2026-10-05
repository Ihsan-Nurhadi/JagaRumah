import { mobileLogin, mobileLoginSchema } from "@/lib/server/mobile";
import { parseJson } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const POST=routeHandler("mobile.auth.login",async(request,requestId)=>ok(await mobileLogin(await parseJson(request,mobileLoginSchema)),requestId));

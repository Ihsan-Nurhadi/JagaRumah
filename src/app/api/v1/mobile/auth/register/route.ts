import { mobileRegister, mobileRegisterSchema } from "@/lib/server/mobile";
import { parseJson } from "@/lib/server/parse";
import { created } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const POST=routeHandler("mobile.auth.register",async(request,requestId)=>created(await mobileRegister(await parseJson(request,mobileRegisterSchema)),requestId));

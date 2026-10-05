import { forgotPassword, forgotPasswordSchema } from "@/lib/server/mobile";
import { parseJson } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const POST=routeHandler("mobile.auth.forgot-password",async(request,requestId)=>ok(await forgotPassword(await parseJson(request,forgotPasswordSchema)),requestId));

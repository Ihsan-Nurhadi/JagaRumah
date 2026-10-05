import { resetPassword, resetPasswordSchema } from "@/lib/server/mobile";
import { parseJson } from "@/lib/server/parse";
import { noContent } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const POST=routeHandler("mobile.auth.reset-password",async(request,requestId)=>{await resetPassword(await parseJson(request,resetPasswordSchema));return noContent(requestId);});

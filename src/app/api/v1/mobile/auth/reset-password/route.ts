import { resetPassword, resetPasswordSchema } from "@/lib/server/mobile";
import { parseJson } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

export const POST = routeHandler("mobile.auth.reset-password", async (request, requestId) => {
  const result = await resetPassword(await parseJson(request, resetPasswordSchema));
  return ok(result, requestId);
});

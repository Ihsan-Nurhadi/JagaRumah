import { mobileGoogleLogin, mobileGoogleLoginSchema } from "@/lib/server/mobile";
import { parseJson } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

export const POST = routeHandler(
  "mobile.auth.google",
  async (request, requestId) =>
    ok(
      await mobileGoogleLogin(await parseJson(request, mobileGoogleLoginSchema)),
      requestId,
    ),
);

import { mobileRefreshSchema, refreshMobileSession } from "@/lib/server/mobile";
import { parseJson } from "@/lib/server/parse";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

export const POST = routeHandler("mobile.auth.refresh", async (request, requestId) =>
  ok(await refreshMobileSession(await parseJson(request, mobileRefreshSchema)), requestId),
);

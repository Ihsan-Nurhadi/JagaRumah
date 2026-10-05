import { query } from "@/lib/server/db";
import { requireMobile } from "@/lib/server/mobile";
import { noContent } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

export const POST = routeHandler("mobile.auth.logout", async (request, requestId) => {
  const session = await requireMobile(request);
  await query("UPDATE customer_sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL", [session.sessionId]);
  return noContent(requestId);
});

export const DELETE = POST;

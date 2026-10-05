import { requireMobile } from "@/lib/server/mobile";
import { dashboard } from "@/lib/server/mobile-data";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
export const GET = routeHandler("mobile.dashboard", async (request, requestId) => ok(await dashboard((await requireMobile(request)).customerId), requestId));

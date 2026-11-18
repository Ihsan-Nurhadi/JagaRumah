import { z } from "zod";
import { claimDeviceByCode } from "@/lib/server/devices";
import { requireMobile } from "@/lib/server/mobile";
import { parseJson } from "@/lib/server/parse";
import { clientIp, ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

const claimSchema = z.object({
  code: z.string().trim().min(4, "Kode klaim minimal 4 karakter.").max(100),
});

export const POST = routeHandler("mobile.devices.claim", async (request, requestId) => {
  const session = await requireMobile(request);
  const body = await parseJson(request, claimSchema);
  const rawIp = await clientIp();
  const ip = rawIp ?? undefined;
  const userAgent = request.headers.get("user-agent") ?? undefined;

  const result = await claimDeviceByCode(session.customerId, body.code, ip, userAgent);
  return ok(result, requestId);
});

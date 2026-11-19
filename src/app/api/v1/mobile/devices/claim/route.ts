import { z } from "zod";
import { claimDeviceByCode } from "@/lib/server/devices";
import { requireMobile } from "@/lib/server/mobile";
import { parseJson } from "@/lib/server/parse";
import { clientIp, ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

const claimSchema = z
  .object({
    code: z.string().trim().optional(),
    claim_code: z.string().trim().optional(),
    token: z.string().trim().optional(),
  })
  .refine((data) => data.code || data.claim_code || data.token, {
    message: "Kode klaim wajib diisi.",
  });

export const POST = routeHandler("mobile.devices.claim", async (request, requestId) => {
  const session = await requireMobile(request);
  const body = await parseJson(request, claimSchema);
  const claimCode = (body.code || body.claim_code || body.token) as string;
  const rawIp = await clientIp();
  const ip = rawIp ?? undefined;
  const userAgent = request.headers.get("user-agent") ?? undefined;

  const result = await claimDeviceByCode(session.customerId, claimCode, ip, userAgent);
  return ok(result, requestId);
});

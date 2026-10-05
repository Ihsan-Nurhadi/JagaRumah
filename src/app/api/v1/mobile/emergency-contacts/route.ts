import { requireMobile } from "@/lib/server/mobile";
import { emergencyContactPayload, mobileEmergencyContacts } from "@/lib/server/emergency-contacts";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

export const GET = routeHandler("mobile.emergency_contacts.list", async (request, requestId) => {
  await requireMobile(request);
  const rows = await mobileEmergencyContacts();
  return ok({ contacts: rows.map(emergencyContactPayload) }, requestId);
});

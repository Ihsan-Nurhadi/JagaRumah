import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import { emergencyContact, emergencyContactPayload, type EmergencyContact } from "@/lib/server/emergency-contacts";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { emergencyContactUpdateSchema } from "@/lib/schemas/admin-emergency-contact";

type Params = { params: Promise<{ contact_id?: string }> };

export const GET = routeHandler("admin.emergency_contacts.detail", async (_request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "emergency_contact.read");
  const id = requireUuid((await (context as Params).params).contact_id, "contact_id");
  const row = await emergencyContact(id);
  if (!row) throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Nomor emergency tidak ditemukan." });
  return ok({ contact: emergencyContactPayload(row) }, requestId);
});

export const PATCH = routeHandler("admin.emergency_contacts.update", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "emergency_contact.manage");
  await requireCsrf(request);
  const id = requireUuid((await (context as Params).params).contact_id, "contact_id");
  const input = await parseJson(request, emergencyContactUpdateSchema);
  const row = await withTransaction(async (client) => {
    const before = await queryOne<EmergencyContact>(
      `SELECT id, name, phone, description, category, sort_order, is_active, created_at, updated_at
       FROM emergency_contacts WHERE id = $1 FOR UPDATE`,
      [id],
      client,
    );
    if (!before) throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Nomor emergency tidak ditemukan." });
    const allowedFields = new Set(["name", "phone", "description", "category", "sort_order", "is_active"]);
    const fields = Object.entries(input).filter(([field, value]) => value !== undefined && allowedFields.has(field));
    const values: unknown[] = [id];
    const assignments = fields.map(([field, value]) => `${field} = $${values.push(field === "description" && typeof value === "string" ? value.trim() || null : value)}`);
    const updated = await queryOne<EmergencyContact>(
      `UPDATE emergency_contacts SET ${assignments.join(", ")}, updated_at = now()
       WHERE id = $1
       RETURNING id, name, phone, description, category, sort_order, is_active, created_at, updated_at`,
      values,
      client,
    );
    if (!updated) throw new Error("emergency contact update failed");
    await writeAudit(client, { actor: { adminUserId: admin.identity.id, ipAddress: admin.ipAddress, userAgent: admin.userAgent }, action: "update", entityType: "emergency_contact", entityId: id, oldData: emergencyContactPayload(before), newData: emergencyContactPayload(updated) });
    return updated;
  });
  return ok({ contact: emergencyContactPayload(row) }, requestId);
});

export const DELETE = routeHandler("admin.emergency_contacts.deactivate", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "emergency_contact.manage");
  await requireCsrf(request);
  const id = requireUuid((await (context as Params).params).contact_id, "contact_id");
  const row = await withTransaction(async (client) => {
    const before = await queryOne<EmergencyContact>(
      `SELECT id, name, phone, description, category, sort_order, is_active, created_at, updated_at
       FROM emergency_contacts WHERE id = $1 FOR UPDATE`,
      [id],
      client,
    );
    if (!before) throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Nomor emergency tidak ditemukan." });
    const updated = await queryOne<EmergencyContact>(
      `UPDATE emergency_contacts SET is_active = false, updated_at = now()
       WHERE id = $1
       RETURNING id, name, phone, description, category, sort_order, is_active, created_at, updated_at`,
      [id],
      client,
    );
    if (!updated) throw new Error("emergency contact deactivate failed");
    await writeAudit(client, { actor: { adminUserId: admin.identity.id, ipAddress: admin.ipAddress, userAgent: admin.userAgent }, action: "deactivate", entityType: "emergency_contact", entityId: id, oldData: emergencyContactPayload(before), newData: emergencyContactPayload(updated) });
    return updated;
  });
  return ok({ contact: emergencyContactPayload(row) }, requestId);
});

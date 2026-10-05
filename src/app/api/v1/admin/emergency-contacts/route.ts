import { writeAudit } from "@/lib/server/audit";
import { query, queryOne, withTransaction } from "@/lib/server/db";
import { emergencyContactPayload, type EmergencyContact } from "@/lib/server/emergency-contacts";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { created, ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { emergencyContactCreateSchema } from "@/lib/schemas/admin-emergency-contact";

export const GET = routeHandler("admin.emergency_contacts.list", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "emergency_contact.read");
  const url = new URL(request.url);
  const active = url.searchParams.get("is_active");
  if (active !== null && active !== "true" && active !== "false") {
    return Response.json({ error: { code: "VALIDATION_ERROR", message: "is_active tidak valid.", request_id: requestId } }, { status: 400 });
  }
  const rows = await query<EmergencyContact>(
    `SELECT id, name, phone, description, category, sort_order, is_active, created_at, updated_at
     FROM emergency_contacts
     WHERE ($1::boolean IS NULL OR is_active = $1::boolean)
     ORDER BY sort_order, name, id`,
    [active === null ? null : active === "true"],
  );
  return ok({ contacts: rows.map(emergencyContactPayload) }, requestId);
});

export const POST = routeHandler("admin.emergency_contacts.create", async (request, requestId) => {
  const admin = await requireAdmin();
  requirePermission(admin, "emergency_contact.manage");
  await requireCsrf(request);
  const input = await parseJson(request, emergencyContactCreateSchema);
  const row = await withTransaction(async (client) => {
    const inserted = await queryOne<EmergencyContact>(
      `INSERT INTO emergency_contacts (name, phone, description, category, sort_order, is_active, created_by_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, phone, description, category, sort_order, is_active, created_at, updated_at`,
      [input.name, input.phone, input.description?.trim() || null, input.category, input.sort_order, input.is_active, admin.identity.id],
      client,
    );
    if (!inserted) throw new Error("emergency contact insert failed");
    await writeAudit(client, { actor: { adminUserId: admin.identity.id, ipAddress: admin.ipAddress, userAgent: admin.userAgent }, action: "create", entityType: "emergency_contact", entityId: inserted.id, newData: emergencyContactPayload(inserted) });
    return inserted;
  });
  return created({ contact: emergencyContactPayload(row) }, requestId);
});

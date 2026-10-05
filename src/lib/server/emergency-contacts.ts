import { query, queryOne, type Queryable } from "./db";

export type EmergencyContact = {
  id: string;
  name: string;
  phone: string;
  description: string | null;
  category: "security" | "police" | "fire" | "ambulance" | "technician" | "custom";
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export async function mobileEmergencyContacts(executor?: Queryable) {
  return query<EmergencyContact>(
    `SELECT id, name, phone, description, category, sort_order, is_active, created_at, updated_at
     FROM emergency_contacts
     WHERE is_active = true
     ORDER BY sort_order ASC, name ASC, id ASC`,
    [],
    executor,
  );
}

export async function emergencyContact(id: string, executor?: Queryable) {
  return queryOne<EmergencyContact>(
    `SELECT id, name, phone, description, category, sort_order, is_active, created_at, updated_at
     FROM emergency_contacts WHERE id = $1`,
    [id],
    executor,
  );
}

export function emergencyContactPayload(row: EmergencyContact) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    description: row.description,
    category: row.category,
    sort_order: row.sort_order,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

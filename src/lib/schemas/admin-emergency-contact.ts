import { z } from "zod";

export const emergencyCategorySchema = z.enum([
  "security",
  "police",
  "fire",
  "ambulance",
  "technician",
  "custom",
]);

const phone = z
  .string()
  .trim()
  .min(6)
  .max(30)
  .regex(/^\+?[0-9][0-9 .()\-]{5,29}$/, "Nomor telepon tidak valid.");

export const emergencyContactCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone,
  description: z.string().trim().max(500).nullable().optional(),
  category: emergencyCategorySchema,
  sort_order: z.number().int().min(0).max(100000).default(0),
  is_active: z.boolean().default(true),
});

export const emergencyContactUpdateSchema = emergencyContactCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "Kirim minimal satu field untuk diubah.",
);

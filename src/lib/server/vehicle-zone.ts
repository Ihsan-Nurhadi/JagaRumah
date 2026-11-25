import { z } from "zod";

export const parkingZoneSchema = z
  .object({
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
    x2: z.number().min(0).max(1),
    y2: z.number().min(0).max(1),
  })
  .refine((zone) => zone.x2 - zone.x1 >= 0.05 && zone.y2 - zone.y1 >= 0.05, {
    message: "Ukuran zona parkir minimal 5% dari lebar dan tinggi layar.",
  });

export type ParkingZone = z.infer<typeof parkingZoneSchema>;

export function normalizeParkingZone(raw: unknown): ParkingZone | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = parkingZoneSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

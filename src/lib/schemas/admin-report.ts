import { z } from "zod";

import { REPORT_TYPES } from "@/lib/server/reports";

/*
  Parameter laporan.

  `from` dan `to` wajib. Rentang yang diam-diam diisi sendiri oleh server akan membuat angka di
  layar tidak bisa dikaitkan dengan periode apa pun, dan laporan yang tidak menyebut periodenya
  tidak dapat dipakai untuk apa-apa.

  Rentang dibatasi 366 hari per permintaan, sesuai kontrak.
*/

const tanggal = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus dalam bentuk YYYY-MM-DD.");

export const reportQuerySchema = z
  .object({
    from: tanggal,
    to: tanggal,
    granularity: z.enum(["day", "week", "month"]).default("day"),
  })
  .refine((value) => value.from <= value.to, {
    message: "Tanggal awal tidak boleh melewati tanggal akhir.",
    path: ["from"],
  })
  .refine(
    (value) =>
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000 <=
      366,
    { message: "Rentang maksimal 366 hari.", path: ["to"] },
  );

export const reportTypeSchema = z.enum(REPORT_TYPES as [string, ...string[]], {
  message: `Jenis laporan harus salah satu dari: ${REPORT_TYPES.join(", ")}.`,
});

export type ReportQueryInput = z.infer<typeof reportQuerySchema>;

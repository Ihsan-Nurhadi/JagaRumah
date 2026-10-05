import { z } from "zod";

/*
  Rentang tanggal dashboard.

  Batasnya wajib dikirim, bukan disimpulkan dari hari ini, supaya angka yang dilihat operator
  selalu bisa dikaitkan dengan periode yang tertulis di layar. Dashboard yang diam-diam memakai
  "bulan ini" akan membingungkan begitu seseorang membuka ulang tautannya keesokan hari.
*/

const tanggal = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus dalam bentuk YYYY-MM-DD.");

export const dashboardPeriodSchema = z
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
    (value) => {
      /*
        Rentang dibatasi satu tahun per permintaan. Deret harian selama satu tahun sudah 366
        titik, dan lebih dari itu berarti yang diminta adalah arsip, bukan dashboard.
      */
      const selisih =
        (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) /
        86_400_000;
      return selisih <= 366;
    },
    { message: "Rentang maksimal 366 hari.", path: ["to"] },
  );

export type DashboardPeriodInput = z.infer<typeof dashboardPeriodSchema>;

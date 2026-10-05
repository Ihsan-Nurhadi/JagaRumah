import { z } from "zod";

/*
  Skema pembatalan tagihan.

  Alasan wajib karena pembatalan tagihan menghapus kewajiban bayar pelanggan, dan itu keputusan
  yang perlu bisa dipertanggungjawabkan berbulan-bulan kemudian. Tanpa alasan, catatan auditnya
  hanya berisi "tagihan dibatalkan" tanpa keterangan apa pun.
*/

export const voidInvoiceSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

export type VoidInvoiceInput = z.infer<typeof voidInvoiceSchema>;

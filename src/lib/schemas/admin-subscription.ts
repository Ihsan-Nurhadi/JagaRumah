import { z } from "zod";

/*
  Skema pembatalan langganan.

  Dua mode pembatalan dibedakan secara eksplisit, bukan disimpulkan dari ada tidaknya tanggal
  berakhir. Alasannya: operator yang menekan "Batalkan" hampir selalu bermaksud berhenti
  memperpanjang, bukan memutus layanan hari itu. Membuat niat itu harus dinyatakan membuat
  kesalahan yang mahal, yaitu pelanggan kehilangan layanan yang sudah dibayarnya, menjadi tidak
  mungkin terjadi tanpa disadari.
*/

export const cancelSubscriptionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
  /*
    `at_period_end` adalah nilai bawaannya karena itulah yang adil bagi pelanggan: masa yang
    sudah dibayar tetap dihormati.
  */
  mode: z.enum(["at_period_end", "immediate"], {
    message: 'Cara pembatalan harus "at_period_end" atau "immediate".',
  }).default("at_period_end"),
});

export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;

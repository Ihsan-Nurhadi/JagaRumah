import { z } from "zod";

/*
  Skema pencatatan refund.

  Refund dicatat, bukan diproses dari sini. Dokumentasi penyedia pembayaran yang kita pegang
  tidak memuat API refund, sehingga pengembalian dana dilakukan manual dari dasbor penyedia.
  Yang dilakukan konsol ini adalah mencatat bahwa refund itu terjadi, supaya:

  - laporan refund punya angka, dan
  - pertanyaan "kenapa uang pelanggan ini dikembalikan" bisa dijawab dari catatan.

  Karena itu kolom nomor rujukan refund dari penyedia ikut diminta. Tanpa nomor itu, catatan
  kita tidak bisa dicocokkan dengan mutasi di dasbor penyedia saat ada sengketa.
*/

export const recordRefundSchema = z.object({
  amount: z
    .number({ message: "Nominal refund harus berupa angka." })
    .positive("Nominal refund harus lebih besar dari nol.")
    .max(999_999_999_999, "Nominal refund terlalu besar."),
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
  /*
    Nomor rujukan wajib diisi. Refund manual yang tidak punya nomor rujukan tidak bisa
    dicocokkan dengan apa pun di sisi penyedia, sehingga catatannya tidak berguna saat
    diperiksa.
  */
  provider_refund_id: z
    .string()
    .trim()
    .min(3, "Nomor rujukan refund dari penyedia minimal 3 karakter.")
    .max(120, "Nomor rujukan refund maksimal 120 karakter."),
  /*
    Status awal tidak selalu selesai. Refund manual kadang masih diproses di sisi penyedia, dan
    mencatatnya sebagai selesai akan membuat laporan mengakui pengeluaran yang belum terjadi.
  */
  status: z.enum(["pending", "completed", "failed"], {
    message: 'Status refund harus "pending", "completed", atau "failed".',
  }),
});

export type RecordRefundInput = z.infer<typeof recordRefundSchema>;

/*
  Pembaruan status refund.

  Diperlukan karena refund manual sering belum selesai saat dicatat: penyedia memprosesnya
  beberapa waktu kemudian. Tanpa cara memperbarui statusnya, catatan refund akan macet pada
  status belum selesai selamanya.

  Akibatnya nyata: laporan pengembalian dana memakai dasar kas dan mengakui refund pada tanggal
  selesainya, sehingga refund yang macet tidak akan pernah muncul di laporan, dan laporan itu
  akan terlihat lebih ringan daripada kenyataannya.
*/
export const updateRefundSchema = z.object({
  status: z.enum(["pending", "completed", "failed"], {
    message: 'Status refund harus "pending", "completed", atau "failed".',
  }),
  note: z
    .string()
    .trim()
    .max(500, "Catatan maksimal 500 karakter.")
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional(),
});

export type UpdateRefundInput = z.infer<typeof updateRefundSchema>;

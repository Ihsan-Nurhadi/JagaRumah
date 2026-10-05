import { z } from "zod";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/password-rules";

/*
  Skema pelanggan untuk konsol admin.

  Batas yang ditegakkan di sini mengikuti aturan yang sama di klien dan server, jadi tidak ada
  kolom yang tampak boleh diisi di layar tetapi ditolak diam-diam oleh server.
*/

/*
  Alasan wajib untuk tindakan yang mengubah akses pelanggan.

  Menangguhkan akun memutus perangkat pelanggan dari layanan. Pertanyaan "kenapa akun saya
  dimatikan" harus bisa dijawab dari catatan, bukan dari ingatan operator yang bertugas.
*/
const reason = z
  .string()
  .trim()
  .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
  .max(500, "Alasan maksimal 500 karakter.");

export const suspendCustomerSchema = z.object({
  reason,
  /*
    Menangguhkan pelanggan dengan perangkat terpasang punya akibat yang lebih besar daripada
    menangguhkan akun kosong. Operator perlu menyadarinya sebelum menekan tombol, jadi
    persetujuannya diminta secara eksplisit, bukan disimpulkan dari alasan yang diketik.
  */
  acknowledge_devices: z
    .boolean()
    .optional()
    .default(false),
});

export type SuspendCustomerInput = z.infer<typeof suspendCustomerSchema>;

export const activateCustomerSchema = z.object({
  reason,
});

export type ActivateCustomerInput = z.infer<typeof activateCustomerSchema>;

/*
  Nomor WhatsApp dalam format E.164: tanda plus diikuti 8 sampai 15 angka, angka pertama
  bukan nol. Batasan ini ditulis di sini, bukan mengandalkan unik database, supaya pesan
  kesalahannya menyebutkan format yang benar sebelum permintaan dikirim.
*/
const phoneE164 = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{7,14}$/, "Nomor WhatsApp harus format internasional, contoh +6281234567890.");

/*
  Pembuatan pelanggan manual dari konsol admin.

  Cara masuk email dan WhatsApp sama-sama opsional, tetapi salah satunya wajib diisi: akun
  tanpa satu pun cara masuk tidak dapat dipakai siapa pun, dan membuatnya hanya menghasilkan
  baris yang tidak berguna di daftar pelanggan. Kata sandi wajib menyertai email, karena
  akun email tanpa kata sandi melanggar batasan tabel dan tidak akan pernah bisa dipakai masuk.

  Batasan kata sandi mengikuti aturan bersama di `@/lib/password-rules`, sama seperti akun
  admin dan pendaftaran mobile, supaya konsol tidak menolak kata sandi yang diterima jalur lain.
*/
export const createCustomerSchema = z
  .object({
    full_name: z
      .string()
      .trim()
      .min(2, "Nama minimal 2 karakter.")
      .max(120, "Nama maksimal 120 karakter."),
    /*
      String kosong diperlakukan sebagai tidak diisi, bukan nilai sah. Formulir HTML selalu
      mengirim string kosong untuk isian yang dibiarkan kosong; tanpa transformasi ini,
      kolom email yang sengaja dilewati operator akan berubah menjadi baris cara masuk
      dengan alamat kosong.
    */
    email: z
      .union([
        z.literal(""),
        z.email("Alamat email tidak sah.").max(160, "Alamat email maksimal 160 karakter."),
      ])
      .transform((value) => (value === "" ? undefined : value.toLowerCase()))
      .optional(),
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `Kata sandi minimal ${PASSWORD_MIN_LENGTH} karakter.`)
      .max(PASSWORD_MAX_LENGTH, "Kata sandi terlalu panjang.")
      .refine((value) => /[a-z]/.test(value), "Tambahkan minimal satu huruf kecil.")
      .refine((value) => /[A-Z]/.test(value), "Tambahkan minimal satu huruf besar.")
      .refine((value) => /[0-9]/.test(value), "Tambahkan minimal satu angka.")
      .optional()
      .or(z.literal(""))
      .transform((value) => (value === "" ? undefined : value)),
    phone_e164: z
      .union([z.literal(""), phoneE164])
      .transform((value) => (value === "" ? undefined : value))
      .optional(),
  })
  .refine((value) => value.email !== undefined || value.phone_e164 !== undefined, {
    message: "Isi minimal satu cara masuk: email atau nomor WhatsApp.",
  })
  .refine((value) => value.email === undefined || value.password !== undefined, {
    message: "Kata sandi wajib diisi bila email dipakai sebagai cara masuk.",
    path: ["password"],
  });

export type CreateCustomerInput = z.input<typeof createCustomerSchema>;

/*
  Nama pelanggan boleh diperbaiki admin, karena kesalahan ketik saat pendaftaran adalah hal yang
  biasa dan menunggu pelanggan memperbaikinya sendiri di aplikasi tidak selalu masuk akal.
  Status dan cara masuk tidak dapat diubah lewat endpoint ini: status punya jalurnya sendiri
  yang mewajibkan alasan, sedangkan cara masuk adalah milik pelanggan.
*/
export const updateCustomerSchema = z
  .object({
    full_name: z
      .string()
      .trim()
      .min(2, "Nama minimal 2 karakter.")
      .max(120, "Nama maksimal 120 karakter.")
      .optional(),
  })
  .refine((value) => value.full_name !== undefined, {
    message: "Tidak ada perubahan yang dikirim. Isi minimal satu kolom.",
  });

export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

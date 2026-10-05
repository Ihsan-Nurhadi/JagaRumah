import { z } from "zod";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/password-rules";

/*
  Skema akun admin, peran, dan izin.

  Beberapa aturan di sini bukan soal format, melainkan soal mencegah keadaan yang tidak bisa
  diperbaiki sendiri lewat konsol:

  - Kata sandi memakai syarat yang sama dengan `WEAK_PASSWORD` di kontrak, dan diperiksa di
    server. Panjang minimum lebih penting daripada aturan karakter campuran.
  - Peran tidak boleh dikosongkan pada `PATCH` tanpa disengaja. Admin tanpa peran tidak dapat
    melakukan apa pun, dan itu keadaan yang mudah terjadi tanpa disadari.
*/

/*
  Batas dan pesan diambil dari `@/lib/password-rules`, bukan ditulis ulang di sini, supaya
  formulir, server, dan skrip pembuat admin pertama tidak pernah menolak kata sandi yang sama
  dengan alasan yang berbeda.
*/
const kataSandi = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Kata sandi minimal ${PASSWORD_MIN_LENGTH} karakter.`)
  .max(PASSWORD_MAX_LENGTH, "Kata sandi terlalu panjang.")
  .refine((value) => /[a-z]/.test(value), "Tambahkan minimal satu huruf kecil.")
  .refine((value) => /[A-Z]/.test(value), "Tambahkan minimal satu huruf besar.")
  .refine((value) => /[0-9]/.test(value), "Tambahkan minimal satu angka.");

const teksWajib = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, `${label} minimal ${min} karakter.`)
    .max(max, `${label} maksimal ${max} karakter.`);

/*
  Nama pengguna dan kode peran dibatasi ke huruf, angka, titik, garis bawah, dan tanda hubung.
  Spasi dan karakter aneh membuatnya sulit dirujuk di log dan di alamat, dan keduanya sering
  dipakai untuk merujuk.
*/
const polaKode = /^[a-z0-9._-]+$/;

export const createAdminUserSchema = z.object({
  username: teksWajib("Nama pengguna", 3, 40)
    .transform((value) => value.toLowerCase())
    .refine(
      (value) => polaKode.test(value),
      "Nama pengguna hanya boleh berisi huruf kecil, angka, titik, garis bawah, dan tanda hubung.",
    ),
  email: z.email("Alamat email tidak sah.").max(160, "Alamat email maksimal 160 karakter."),
  full_name: teksWajib("Nama lengkap", 2, 120),
  password: kataSandi,
  /*
    Peran wajib diisi saat pembuatan akun. Akun tanpa peran tidak dapat melakukan apa pun,
    sehingga membuatnya tanpa peran hanya menghasilkan akun yang tidak berguna.
  */
  role_ids: z
    .array(z.uuid("ID peran harus berupa UUID."))
    .min(1, "Pilih minimal satu peran, karena akun tanpa peran tidak dapat melakukan apa pun.")
    .max(20, "Maksimal 20 peran per akun."),
});

export const updateAdminUserSchema = z
  .object({
    full_name: teksWajib("Nama lengkap", 2, 120).optional(),
    email: z
      .email("Alamat email tidak sah.")
      .max(160, "Alamat email maksimal 160 karakter.")
      .optional(),
    status: z
      .enum(["active", "inactive", "locked"], {
        message: 'Status harus "active", "inactive", atau "locked".',
      })
      .optional(),
    /* Kata sandi hanya diganti bila diisi. Mengirim kosong berarti tidak mengubahnya. */
    password: kataSandi.optional(),
    /*
      Peran diganti seluruhnya, bukan ditambah. Mengganti seluruhnya lebih mudah diperiksa
      daripada menambah dan mengurangi, dan hasil akhirnya selalu jelas.
    */
    role_ids: z.array(z.uuid("ID peran harus berupa UUID.")).max(20, "Maksimal 20 peran per akun.").optional(),
    reason: teksWajib("Alasan perubahan", 10, 500),
  })
  .refine(
    (value) =>
      value.full_name !== undefined ||
      value.email !== undefined ||
      value.status !== undefined ||
      value.password !== undefined ||
      value.role_ids !== undefined,
    { message: "Tidak ada yang diubah. Isi minimal satu kolom." },
  );

export const deactivateAdminUserSchema = z.object({
  reason: teksWajib("Alasan penonaktifan", 10, 500),
});

export const createRoleSchema = z.object({
  code: teksWajib("Kode peran", 2, 40)
    .transform((value) => value.toLowerCase())
    .refine(
      (value) => polaKode.test(value),
      "Kode peran hanya boleh berisi huruf kecil, angka, titik, garis bawah, dan tanda hubung.",
    ),
  name: teksWajib("Nama peran", 2, 80),
  description: z
    .string()
    .trim()
    .max(300, "Keterangan maksimal 300 karakter.")
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional(),
  permission_codes: z
    .array(z.string().trim().min(1))
    .max(100, "Maksimal 100 izin per peran.")
    .default([]),
});

export const updateRoleSchema = z
  .object({
    name: teksWajib("Nama peran", 2, 80).optional(),
    description: z
      .string()
      .trim()
      .max(300, "Keterangan maksimal 300 karakter.")
      .transform((value) => (value === "" ? null : value))
      .nullable()
      .optional(),
    permission_codes: z.array(z.string().trim().min(1)).max(100, "Maksimal 100 izin per peran.").optional(),
    reason: teksWajib("Alasan perubahan", 10, 500),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.permission_codes !== undefined,
    { message: "Tidak ada yang diubah. Isi minimal satu kolom." },
  );

export type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>;
export type UpdateAdminUserInput = z.infer<typeof updateAdminUserSchema>;
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

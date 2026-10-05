import { z } from "zod";

/*
  Skema untuk boundary HTTP. Dipakai bersama oleh route handler dan form di klien, supaya
  aturan yang terlihat di layar sama persis dengan aturan yang ditegakkan server.
*/

export const adminLoginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email wajib diisi.")
    .max(254, "Email terlalu panjang.")
    .email("Format email tidak sah. Contoh yang benar: nama@perusahaan.com"),
  password: z.string().min(1, "Kata sandi wajib diisi.").max(200, "Kata sandi terlalu panjang."),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

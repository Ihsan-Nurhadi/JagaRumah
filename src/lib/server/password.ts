import bcrypt from "bcryptjs";

/*
  Kata sandi.

  Algoritma yang dipakai adalah bcrypt, sesuai DB_Plan.md bagian "Password dan token". Ini
  bukan pilihan terkuat yang tersedia, tetapi pilihan yang paling pasti ada di lingkungan
  deploy tanpa langkah build tambahan. Kalau nanti diganti ke Argon2id, kolom
  `admin_users.password_hash` perlu menyimpan penanda algoritma, dan `verify` di bawah harus
  memilih berdasarkan penanda itu supaya kata sandi lama tetap bisa diverifikasi.
*/

const ROUNDS = 12;

/*
  Hasil hash asli dari frasa yang sengaja tidak berarti. Dipakai saat login dengan email yang
  tidak ada, supaya waktu responsnya tetap sama dengan email yang ada. Tanpa ini, selisih waktu
  antara "email tidak dikenal" dan "kata sandi salah" bisa dipakai menebak email mana yang
  terdaftar.
*/
const DUMMY_HASH = "$2b$12$RfFZPMJGA7EX4APqgFrZ/OZBt80/rwwZkAJmYsVvBkQaCGrjl2JOO";

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    // Hash yang rusak atau kosong dianggap tidak cocok, bukan memicu galat 500.
    return false;
  }
}

export async function burnPasswordTime(password: string): Promise<void> {
  await bcrypt.compare(password, DUMMY_HASH).catch(() => false);
}

/*
  Syarat kata sandi ada di `@/lib/password-rules`, bukan disalin ke sini.

  Diteruskan ulang dari berkas ini supaya pemanggil di sisi server tetap punya satu tempat untuk
  mengambil pemeriksaan kata sandi bersama fungsi hash-nya.
*/
export { passwordProblem } from "@/lib/password-rules";

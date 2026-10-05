import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Skrip sekali pakai untuk memeriksa database. Bukan bagian dari aplikasi, dan isinya
    // sering berisi potongan kueri sementara yang tidak perlu ikut aturan gaya kode.
    ".cache/**",
    /*
      Skrip pemeriksaan di scripts/verify sengaja tidak ikut aturan gaya kode aplikasi.

      Isinya membaca tanggapan JSON mentah dari server untuk memeriksa perilaku, sehingga
      tipenya longgar dengan sengaja: membuat tipe lengkap untuk setiap bentuk tanggapan akan
      menambah kode yang justru harus ikut diperbarui setiap kali bentuk tanggapan berubah.
      Skrip ini juga tidak pernah dikirim ke produksi.
    */
    "scripts/verify/**",
  ]),
]);

export default eslintConfig;

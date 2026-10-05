/*
  Lingkungan untuk skrip CLI di luar Next.js.

  Next.js memuat `.env` sendiri saat aplikasi berjalan, tetapi skrip `tsx` tidak. Karena itu
  berkas ini memuatnya secara eksplisit. Di server produksi, nilai biasanya datang dari
  environment platform dan `.env` tidak dipakai.
*/
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadDotEnv(): void {
  const path = resolve(REPO_ROOT, ".env");
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

export function databaseUrl(): string {
  loadDotEnv();
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "DATABASE_URL belum diisi. Salin .env.example menjadi .env lalu isi connection string " +
        "dari Supabase, lalu jalankan ulang perintah ini.",
    );
  }
  return value;
}

// Ditampilkan ke layar, jadi tidak boleh memuat kata sandi.
export function describeTarget(): string {
  try {
    const url = new URL(databaseUrl());
    const database = url.pathname.replace(/^\//, "") || "(tanpa nama database)";
    return `${url.hostname}:${url.port || "5432"}/${database}`;
  } catch {
    return "(DATABASE_URL tidak dapat dibaca)";
  }
}

export function migrationsDir(): string {
  return resolve(REPO_ROOT, "db", "migrations");
}

export function repoPath(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments);
}

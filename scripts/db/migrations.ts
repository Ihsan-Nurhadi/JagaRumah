/*
  Pembacaan berkas migrasi.

  Nama berkas menentukan urutan penerapan, jadi pola namanya diperiksa ketat. Berkas yang
  tidak cocok pola akan menggagalkan runner, bukan dilewati diam-diam, karena migrasi yang
  terlewat tanpa suara adalah kegagalan yang baru terasa jauh di kemudian hari.
*/
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoPath } from "./env";

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export type Migration = {
  version: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
};

export function migrationsDir(): string {
  return repoPath("db", "migrations");
}

export async function loadMigrations(): Promise<Migration[]> {
  const dir = migrationsDir();
  const entries = await readdir(dir);
  const migrations: Migration[] = [];
  const seen = new Set<string>();

  for (const entry of entries.sort()) {
    const match = FILE_PATTERN.exec(entry);
    if (!match) {
      throw new Error(
        `Berkas ${entry} di db/migrations tidak mengikuti pola NNNN_nama.sql. ` +
          `Ubah namanya atau pindahkan berkas itu keluar dari folder migrasi.`,
      );
    }

    const [, version] = match;
    if (seen.has(version)) {
      throw new Error(
        `Nomor migrasi ${version} dipakai lebih dari satu berkas. Setiap migrasi harus punya ` +
          `nomor sendiri supaya urutannya tidak ditentukan oleh urutan abjad nama.`,
      );
    }
    seen.add(version);

    const path = join(dir, entry);
    const sql = await readFile(path, "utf8");
    migrations.push({
      version,
      name: entry,
      path,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }

  return migrations;
}

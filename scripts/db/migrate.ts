/*
  Runner migrasi.

  Aturan yang dipegang di sini:
  - Berkas migrasi hanya boleh ditambah atau diubah sebelum pernah diterapkan. Setelah
    diterapkan, isinya dikunci oleh checksum. Mengubah migrasi lama membuat checksum tidak
    cocok dan runner berhenti, karena database yang sudah jalan tidak akan pernah tahu
    perubahan itu.
  - Seluruh migrasi berjalan di bawah satu advisory lock. Dua proses deploy yang jalan
    bersamaan tidak boleh menerapkan migrasi yang sama dua kali.
  - Setiap berkas berjalan dalam satu transaksi. Migrasi yang gagal di tengah tidak
    meninggalkan tabel setengah jadi.
*/
import { Client } from "pg";
import { databaseUrl, describeTarget, migrationsDir } from "./env";
import { assertEncrypted, buildConnectionConfig, describeTls } from "../../src/lib/server/tls";
import { loadMigrations, type Migration } from "./migrations";

const LOCK_KEY = "nayaka:migrations";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

async function appliedChecksums(client: Client): Promise<Map<string, string>> {
  const result = await client.query<{ version: string; checksum: string }>(
    "SELECT version, checksum FROM schema_migrations",
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

async function applyOne(client: Client, migration: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
      [migration.version, migration.name, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(
      `Migrasi ${migration.name} gagal dan sudah dibatalkan seluruhnya. ` +
        `Perbaiki berkasnya lalu jalankan ulang. Penyebab: ${(error as Error).message}`,
    );
  }
}

async function main(): Promise<void> {
  const migrations = await loadMigrations();
  const client = new Client({ ...buildConnectionConfig(databaseUrl()) });

  console.log(`Target   : ${describeTarget()}`);
  console.log(`Enkripsi : ${describeTls(databaseUrl())}`);
  console.log(`Migrasi  : ${migrationsDir()} (${migrations.length} berkas)`);

  await client.connect();
  assertEncrypted(client, databaseUrl());
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    await client.query(CREATE_TABLE);

    const applied = await appliedChecksums(client);

    for (const migration of migrations) {
      const previous = applied.get(migration.version);
      if (previous === undefined) continue;
      if (previous !== migration.checksum) {
        throw new Error(
          `Migrasi ${migration.name} sudah pernah diterapkan tetapi isinya berubah. ` +
            `Kembalikan isinya seperti semula, lalu buat berkas migrasi baru untuk ` +
            `perubahan yang diinginkan.`,
        );
      }
    }

    const pending = migrations.filter((migration) => !applied.has(migration.version));
    if (pending.length === 0) {
      console.log(`Tidak ada migrasi baru. ${applied.size} migrasi sudah diterapkan.`);
      return;
    }

    for (const migration of pending) {
      const startedAt = Date.now();
      await applyOne(client, migration);
      console.log(`  ok ${migration.name} (${Date.now() - startedAt} ms)`);
    }
    console.log(`Selesai. ${pending.length} migrasi baru diterapkan.`);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY])
      .catch(() => {});
    await client.end();
  }
}

main().catch((error: Error) => {
  console.error(`\nMigrasi berhenti: ${error.message}`);
  process.exitCode = 1;
});

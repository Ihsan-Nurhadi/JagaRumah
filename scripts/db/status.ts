/*
  Menampilkan selisih antara berkas migrasi di repo dan yang sudah diterapkan di database.
  Dipakai sebelum deploy untuk tahu apa yang akan berubah.
*/
import { Client } from "pg";
import { databaseUrl, describeTarget } from "./env";
import { buildConnectionConfig, describeTls } from "../../src/lib/server/tls";
import { loadMigrations } from "./migrations";

async function main(): Promise<void> {
  const migrations = await loadMigrations();
  const client = new Client({ ...buildConnectionConfig(databaseUrl()) });
  await client.connect();

  try {
    const tableExists = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
    );

    console.log(`Target   : ${describeTarget()}`);
    console.log(`Enkripsi  : ${describeTls(databaseUrl())}`);

    if (!tableExists.rows[0]?.exists) {
      console.log("Tabel schema_migrations belum ada. Belum ada migrasi yang diterapkan.");
      console.log(`Menunggu: ${migrations.length} migrasi.`);
      return;
    }

    const result = await client.query<{ version: string; name: string; applied_at: Date }>(
      "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
    );
    const applied = new Map(result.rows.map((row) => [row.version, row]));

    console.log("");
    for (const migration of migrations) {
      const row = applied.get(migration.version);
      const label = row ? `sudah (${row.applied_at.toISOString()})` : "menunggu";
      console.log(`  ${migration.version}  ${label.padEnd(34)} ${migration.name}`);
    }

    const unknown = result.rows.filter(
      (row) => !migrations.some((migration) => migration.version === row.version),
    );
    for (const row of unknown) {
      console.log(
        `  ${row.version}  ${"ada di database".padEnd(34)} ${row.name} (berkasnya tidak ada di repo)`,
      );
    }

    const pending = migrations.filter((migration) => !applied.has(migration.version)).length;
    console.log("");
    console.log(`Menunggu: ${pending} migrasi.`);
  } finally {
    await client.end();
  }
}

main().catch((error: Error) => {
  console.error(`Gagal membaca status: ${error.message}`);
  process.exitCode = 1;
});

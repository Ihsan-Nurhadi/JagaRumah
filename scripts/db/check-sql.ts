/*
  Pemeriksa sintaks migrasi.

  Dipakai sebelum `db:migrate` kalau database belum bisa dijangkau, atau di CI. Parser di sini
  adalah parser PostgreSQL asli (libpg_query versi 17, sama dengan versi Supabase saat ini),
  bukan pemeriksa tanda kurung buatan sendiri, jadi yang dilaporkan adalah galat yang
  benar-benar akan ditolak server.

  Yang tidak diperiksa di sini: apakah tabel yang dirujuk ada, apakah tipe kolomnya cocok, dan
  apakah constraint-nya masuk akal. Pertanyaan-pertanyaan itu hanya bisa dijawab database
  sungguhan lewat `db:migrate`.
*/
import { Parser } from "@pgsql/parser";
import { loadMigrations } from "./migrations";

async function main(): Promise<void> {
  const parser = new Parser({ version: 17 });
  const migrations = await loadMigrations();
  const failures: string[] = [];

  for (const migration of migrations) {
    try {
      await parser.parse(migration.sql);
      console.log(`  ok     ${migration.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(migration.name);
      console.error(`  gagal  ${migration.name}`);
      console.error(`         ${message.split("\n").slice(0, 3).join(" | ")}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} migrasi tidak lolos pemeriksaan sintaks.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nSintaks ${migrations.length} migrasi lolos pemeriksaan parser PostgreSQL 17.`);
}

main().catch((error: Error) => {
  console.error(`Pemeriksaan gagal: ${error.message}`);
  process.exitCode = 1;
});

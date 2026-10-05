/*
  Menjalankan berkas SQL mentah terhadap database yang dipakai aplikasi.

  Dipakai untuk pembersihan data selama pengembangan, bukan bagian dari aplikasi. Perintah ini
  menerima satu argumen: jalur berkas SQL. Semua pernyataan di dalamnya dijalankan dalam satu
  transaksi, supaya berkas yang gagal di tengah tidak meninggalkan database dalam keadaan separuh
  berubah.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import pg from "pg";

import { buildConnectionConfig } from "../../src/lib/server/tls";
import { databaseUrl } from "./env";

async function main(): Promise<void> {
  const jalur = process.argv[2];
  if (!jalur) {
    console.error("Pakai: npm run db:sql -- <jalur-berkas.sql>");
    process.exit(1);
  }

  const isi = readFileSync(resolve(process.cwd(), jalur), "utf8");
  const client = new pg.Client(buildConnectionConfig(databaseUrl()));

  await client.connect();
  try {
    await client.query("BEGIN");
    const hasil = await client.query(isi);
    await client.query("COMMIT");
    const baris = Array.isArray(hasil) ? hasil.at(-1)?.rows : hasil.rows;
    if (baris?.length) console.log(JSON.stringify(baris, null, 2));
    else console.log("Selesai.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Gagal:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error: Error) => {
  console.error(`Berhenti: ${error.message}`);
  process.exitCode = 1;
});

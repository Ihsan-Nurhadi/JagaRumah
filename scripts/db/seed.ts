/*
  Data awal.

  Isi skrip ini sengaja sempit: hanya paket gratis. Paket berbayar tidak dibuat di sini karena
  harga dan batas perangkatnya keputusan bisnis, dan angka karangan di database akan terbaca
  sebagai keputusan yang sudah diambil. Paket berbayar dibuat lewat halaman /plans setelah
  angkanya ditetapkan.

  Batas paket gratis diisi 1, dan angka itu BELUM diputuskan pemilik produk. Nilai ini dipakai
  sementara karena NULL pada kolom itu berarti tanpa batas, sehingga membiarkannya berarti satu
  pelanggan gratis dapat mengklaim kamera sebanyak apa pun. Batas 1 adalah penahan
  penyalahgunaan, bukan keputusan bisnis. Lihat peringatan yang dicetak setelah seed.

  Semua penulisan memakai ON CONFLICT DO NOTHING sehingga skrip ini aman dijalankan berulang.
*/
import { Client } from "pg";
import { databaseUrl, describeTarget } from "./env";
import { buildConnectionConfig, describeTls } from "../../src/lib/server/tls";

async function main(): Promise<void> {
  const client = new Client({ ...buildConnectionConfig(databaseUrl()) });
  console.log(`Target   : ${describeTarget()}`);
  console.log(`Enkripsi : ${describeTls(databaseUrl())}`);

  await client.connect();
  try {
    // Diperiksa lebih dulu supaya pesan galatnya menunjuk langkah berikutnya, bukan sekadar
    // "relation does not exist".
    const ready = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.subscription_plans') IS NOT NULL AS exists",
    );
    if (!ready.rows[0]?.exists) {
      throw new Error(
        "Tabel subscription_plans belum ada. Jalankan `npm run db:migrate` lebih dulu.",
      );
    }

    await client.query("BEGIN");

    /*
      device_limit diisi 1 sebagai penahan sementara, bukan sebagai keputusan bisnis.

      Di PostgreSQL, NULL pada kolom ini berarti tanpa batas. Membiarkannya NULL membuat satu
      pelanggan gratis dapat mengklaim kamera sebanyak apa pun, dan jalur klaim gratis adalah
      jalur yang paling lemah pengawasannya. Angka 1 menutup celah itu sambil menunggu pemilik
      produk menetapkan angkanya. Peringatan setelah seed menyebutkan bahwa angka ini belum
      final, supaya tidak terbaca sebagai keputusan yang sudah diambil.
    */
    await client.query(
      `INSERT INTO subscription_plans (code, name, description, device_limit, is_free, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (code) DO NOTHING`,
      [
        "free",
        "Gratis",
        "Tanpa biaya. Batas perangkat 1, angka sementara yang belum ditetapkan pemilik produk.",
        1,
        true,
        true,
        // Paket gratis harus menempati tingkat terendah, karena arah upgrade ditentukan sort_order.
        0,
      ],
    );

    await client.query(
      `INSERT INTO plan_prices (plan_id, billing_interval, amount, currency, is_active)
       SELECT id, 'monthly', 0, 'IDR', true FROM subscription_plans WHERE code = 'free'
       ON CONFLICT (plan_id, billing_interval) DO NOTHING`,
    );

    await client.query("COMMIT");

    const unresolved = await client.query<{ code: string }>(
      "SELECT code FROM subscription_plans WHERE device_limit IS NULL ORDER BY sort_order",
    );

    console.log("Selesai. Paket gratis siap.");
    if (unresolved.rows.length > 0) {
      console.log("");
      console.log(
        `Perhatian: ${unresolved.rows.map((r) => r.code).join(", ")} belum punya batas perangkat.`,
      );
      console.log(
        "  device_limit NULL berarti TANPA BATAS, bukan belum diisi. Selama nilainya NULL,",
      );
      console.log(
        "  pelanggan paket ini dapat mengklaim perangkat sebanyak apa pun. Tetapkan angkanya",
      );
      console.log("  sebelum pendaftaran customer dibuka.");
    } else {
      console.log("");
      console.log("Perhatian: batas paket Gratis bernilai 1, dan angka itu belum final.");
      console.log("  Angka ini dipakai sebagai penahan sementara supaya jalur klaim gratis");
      console.log("  tidak terbuka tanpa batas. Tetapkan angkanya lewat halaman /plans.");
    }
    console.log("Paket berbayar belum dibuat. Isi lewat halaman /plans setelah harga ditetapkan.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: Error) => {
  console.error(`Seed gagal: ${error.message}`);
  process.exitCode = 1;
});

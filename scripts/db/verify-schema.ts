/*
  Memeriksa bahwa batasan di database benar-benar bekerja, bukan sekadar terpasang.

  Kenapa ini ada: migrasi yang berhasil diterapkan hanya membuktikan sintaksnya sah. Yang perlu
  diketahui adalah apakah database benar-benar menolak data yang salah. Batasan yang salah tulis
  tetap terpasang tanpa galat, dan baru ketahuan setelah ada perangkat terklaim tanpa pemilik
  atau pelanggan tertagih dua kali.

  Semua uji batasan berjalan di dalam satu transaksi yang dibatalkan di akhir, sehingga tidak
  ada data uji yang tertinggal. Uji trigger updated_at adalah pengecualian dan dijelaskan di
  tempatnya.

  Jalankan dengan: npm run db:verify
*/
import { Client } from "pg";
import { databaseUrl, describeTarget } from "./env";
import { buildConnectionConfig, describeTls } from "../../src/lib/server/tls";

let lulus = 0;
let gagal = 0;

function hasil(nama: string, ok: boolean, detail = ""): void {
  if (ok) {
    lulus += 1;
    console.log(`  lulus  ${nama}`);
  } else {
    gagal += 1;
    console.log(`  GAGAL  ${nama} ${detail}`);
  }
}

/* Menjalankan pernyataan yang seharusnya ditolak database. Ditolak berarti lulus. */
async function harusDitolak(c: Client, nama: string, sql: string, params: unknown[] = []) {
  await c.query("SAVEPOINT s");
  try {
    await c.query(sql, params as never[]);
    await c.query("RELEASE SAVEPOINT s");
    hasil(nama, false, "-> malah diterima");
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT s");
    hasil(nama, true);
  }
}

/* Menjalankan pernyataan yang seharusnya diterima database. */
async function harusDiterima(c: Client, nama: string, sql: string, params: unknown[] = []) {
  await c.query("SAVEPOINT s");
  try {
    await c.query(sql, params as never[]);
    await c.query("RELEASE SAVEPOINT s");
    hasil(nama, true);
  } catch (error) {
    await c.query("ROLLBACK TO SAVEPOINT s");
    hasil(nama, false, `-> ${(error as Error).message.split("\n")[0]}`);
  }
}

async function ujiBatasan(c: Client): Promise<void> {
  const customerId = (
    await c.query<{ id: string }>("INSERT INTO customers (full_name) VALUES ('Uji Skema') RETURNING id")
  ).rows[0].id;
  const planId = (
    await c.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'free'")
  ).rows[0].id;
  const adminId = (
    await c.query<{ id: string }>(
      `INSERT INTO admin_users (username, email, full_name, password_hash, is_super_admin, status)
       VALUES ('uji-skema', 'uji-skema@nayaka.test', 'Uji', 'x', true, 'active') RETURNING id`,
    )
  ).rows[0].id;

  console.log("\n-- akun auth customer --");
  await harusDitolak(c, "email tanpa kata sandi ditolak",
    `INSERT INTO customer_auth_accounts (customer_id, provider, email) VALUES ($1,'email','a@b.test')`, [customerId]);
  await harusDiterima(c, "email dengan kata sandi diterima",
    `INSERT INTO customer_auth_accounts (customer_id, provider, email, password_hash) VALUES ($1,'email','a@b.test','hash')`, [customerId]);
  await harusDitolak(c, "whatsapp dengan kata sandi ditolak",
    `INSERT INTO customer_auth_accounts (customer_id, provider, phone_e164, password_hash) VALUES ($1,'whatsapp','+62811','hash')`, [customerId]);
  await harusDitolak(c, "is_verified tanpa verified_at ditolak",
    `INSERT INTO customer_auth_accounts (customer_id, provider, phone_e164, is_verified) VALUES ($1,'whatsapp','+62812',true)`, [customerId]);
  await harusDitolak(c, "verified_at tanpa is_verified ditolak",
    `INSERT INTO customer_auth_accounts (customer_id, provider, phone_e164, verified_at) VALUES ($1,'whatsapp','+62813', now())`, [customerId]);
  /*
    Perbandingan tanpa peduli huruf besar-kecil bergantung pada ekstensi citext. Kalau ekstensi
    itu tidak terpasang, "A@B.TEST" akan lolos sebagai akun kedua dan satu orang punya dua akun.
  */
  await harusDitolak(c, "email beda huruf besar-kecil ditolak",
    `INSERT INTO customer_auth_accounts (customer_id, provider, email, password_hash) VALUES ($1,'email','A@B.TEST','hash')`, [customerId]);

  console.log("\n-- subscription --");
  await harusDiterima(c, "subscription aktif pertama diterima",
    `INSERT INTO subscriptions (customer_id, plan_id, status) VALUES ($1,$2,'active')`, [customerId, planId]);
  await harusDitolak(c, "subscription aktif kedua ditolak",
    `INSERT INTO subscriptions (customer_id, plan_id, status) VALUES ($1,$2,'active')`, [customerId, planId]);
  await harusDiterima(c, "subscription kedaluwarsa boleh menumpuk",
    `INSERT INTO subscriptions (customer_id, plan_id, status) VALUES ($1,$2,'expired')`, [customerId, planId]);
  await harusDitolak(c, "event sistem dengan pelaku ditolak",
    `INSERT INTO subscription_events (subscription_id, customer_id, event_type, actor_type, actor_id)
     SELECT id, $1, 'activated', 'system', $2 FROM subscriptions WHERE customer_id=$1 LIMIT 1`, [customerId, adminId]);
  await harusDiterima(c, "event sistem tanpa pelaku diterima",
    `INSERT INTO subscription_events (subscription_id, customer_id, event_type, actor_type)
     SELECT id, $1, 'activated', 'system' FROM subscriptions WHERE customer_id=$1 LIMIT 1`, [customerId]);

  console.log("\n-- perangkat --");
  await harusDitolak(c, "status claimed tanpa pemilik ditolak",
    `INSERT INTO devices (device_uid, serial_number, status, claimed_at) VALUES ('U-1','S-1','claimed', now())`);
  await harusDitolak(c, "perangkat gudang dengan claimed_at ditolak",
    `INSERT INTO devices (device_uid, serial_number, status, claimed_at) VALUES ('U-2','S-2','in_stock', now())`);
  await harusDiterima(c, "perangkat gudang diterima",
    `INSERT INTO devices (device_uid, serial_number, status, registered_by_admin_id) VALUES ('U-3','S-3','in_stock',$1)`, [adminId]);
  await harusDitolak(c, "device_uid duplikat ditolak",
    `INSERT INTO devices (device_uid, serial_number) VALUES ('U-3','S-9')`);
  await harusDitolak(c, "serial_number duplikat ditolak",
    `INSERT INTO devices (device_uid, serial_number) VALUES ('U-9','S-3')`);

  console.log("\n-- percobaan claim --");
  await harusDitolak(c, "gagal tanpa alasan ditolak",
    `INSERT INTO device_claim_attempts (submitted_kind, success, failure_reason) VALUES ('serial', false, NULL)`);
  await harusDitolak(c, "berhasil dengan alasan ditolak",
    `INSERT INTO device_claim_attempts (submitted_kind, success, failure_reason) VALUES ('qr', true, 'aneh')`);
  await harusDiterima(c, "berhasil tanpa alasan diterima",
    `INSERT INTO device_claim_attempts (submitted_kind, success) VALUES ('qr', true)`);

  console.log("\n-- invoice --");
  await harusDitolak(c, "status paid tanpa paid_at ditolak",
    `INSERT INTO invoices (customer_id, invoice_number, status, total_amount) VALUES ($1,'INV-1','paid',100)`, [customerId]);
  await harusDitolak(c, "paid_at tanpa status paid ditolak",
    `INSERT INTO invoices (customer_id, invoice_number, status, total_amount, paid_at) VALUES ($1,'INV-2','open',100, now())`, [customerId]);
  await harusDitolak(c, "void tanpa voided_at ditolak",
    `INSERT INTO invoices (customer_id, invoice_number, status, total_amount) VALUES ($1,'INV-3','void',100)`, [customerId]);
  await harusDiterima(c, "open dengan total diterima",
    `INSERT INTO invoices (customer_id, invoice_number, status, total_amount) VALUES ($1,'INV-4','open',150000.55)`, [customerId]);

  /*
    Uang wajib memakai numeric. Kalau kolomnya float, penjumlahan di bawah ini akan menghasilkan
    150000.54999999999 dan laporan keuangan tidak akan pernah cocok dengan mutasi bank.
  */
  const uang = await c.query<{ t: string }>(
    `SELECT round(sum(total_amount),2)::text AS t FROM invoices WHERE customer_id=$1`, [customerId]);
  hasil(`penjumlahan uang tepat (${uang.rows[0].t})`, uang.rows[0].t === "150000.55");

  console.log("\n-- percobaan pembayaran --");
  const invoiceId = (await c.query<{ id: string }>("SELECT id FROM invoices WHERE invoice_number='INV-4'")).rows[0].id;
  await harusDiterima(c, "attempt pertama diterima",
    `INSERT INTO payment_attempts (invoice_id, attempt_sequence, payment_method, provider_order_id, amount, status)
     VALUES ($1,1,'qris','INV-4-1',150000.55,'pending')`, [invoiceId]);
  await harusDitolak(c, "attempt_sequence duplikat ditolak",
    `INSERT INTO payment_attempts (invoice_id, attempt_sequence, payment_method, provider_order_id, amount, status)
     VALUES ($1,1,'bri_va','INV-4-1b',150000.55,'pending')`, [invoiceId]);
  await harusDitolak(c, "provider_order_id duplikat ditolak",
    `INSERT INTO payment_attempts (invoice_id, attempt_sequence, payment_method, provider_order_id, amount, status)
     VALUES ($1,2,'bri_va','INV-4-1',150000.55,'pending')`, [invoiceId]);
  await harusDitolak(c, "status paid tanpa paid_at ditolak",
    `INSERT INTO payment_attempts (invoice_id, attempt_sequence, payment_method, provider_order_id, amount, status)
     VALUES ($1,3,'qris','INV-4-3',150000.55,'paid')`, [invoiceId]);
  await harusDitolak(c, "verified_at tanpa verified_via ditolak",
    `INSERT INTO payment_attempts (invoice_id, attempt_sequence, payment_method, provider_order_id, amount, status, verified_at)
     VALUES ($1,4,'qris','INV-4-4',150000.55,'pending', now())`, [invoiceId]);
  await harusDiterima(c, "verified_at dengan verified_via diterima",
    `INSERT INTO payment_attempts (invoice_id, attempt_sequence, payment_method, provider_order_id, amount, status, paid_at, verified_at, verified_via)
     VALUES ($1,5,'qris','INV-4-5',150000.55,'paid', now(), now(), 'webhook')`, [invoiceId]);

  console.log("\n-- webhook --");
  await harusDiterima(c, "webhook pertama diterima",
    `INSERT INTO payment_webhook_events (provider_event_id, event_type, payload) VALUES ('INV-4-1:completed','payment.completed','{}'::jsonb)`);
  await harusDitolak(c, "webhook dengan kunci sama ditolak",
    `INSERT INTO payment_webhook_events (provider_event_id, event_type, payload) VALUES ('INV-4-1:completed','payment.completed','{}'::jsonb)`);

  console.log("\n-- voucher dan flash sale --");
  /*
    Modul diskon diuji pada paket yang dibuat khusus di sini, bukan pada paket `free` yang sudah ada.

    Alasannya: paket `free` sudah punya harga bulanan, sedangkan satu paket hanya boleh punya satu
    harga per interval. Uji ini butuh dua harga pada paket yang sama untuk membedakan cakupan
    `all_prices` dari `selected_prices`, dan menumpangkan harga kedua ke paket `free` akan mengubah
    data paket yang sungguhan dipakai.

    Paket kedua ada untuk membuktikan pembatasan jendela flash sale berlaku per paket, bukan global.
  */
  const planUjiId = (
    await c.query<{ id: string }>(
      `INSERT INTO subscription_plans (code, name, device_limit, is_free, is_active, sort_order)
       VALUES ('uji-diskon-a', 'Paket Uji Diskon A', 1, false, true, 900) RETURNING id`,
    )
  ).rows[0].id;
  const planUjiLainId = (
    await c.query<{ id: string }>(
      `INSERT INTO subscription_plans (code, name, device_limit, is_free, is_active, sort_order)
       VALUES ('uji-diskon-b', 'Paket Uji Diskon B', 1, false, true, 901) RETURNING id`,
    )
  ).rows[0].id;

  const priceBulananId = (
    await c.query<{ id: string }>(
      `INSERT INTO plan_prices (plan_id, billing_interval, amount)
       VALUES ($1, 'monthly', 100000) RETURNING id`,
      [planUjiId],
    )
  ).rows[0].id;
  const priceTahunanId = (
    await c.query<{ id: string }>(
      `INSERT INTO plan_prices (plan_id, billing_interval, amount)
       VALUES ($1, 'yearly', 1000000) RETURNING id`,
      [planUjiId],
    )
  ).rows[0].id;

  await harusDiterima(c, "voucher persen diterima",
    `INSERT INTO discount_vouchers (code, name, discount_type, percent_value, scope)
     VALUES ('HEMAT20', 'Hemat 20 persen', 'percent', 20, 'all_prices')`);
  await harusDitolak(c, "voucher persen di atas 100 ditolak",
    `INSERT INTO discount_vouchers (code, name, discount_type, percent_value, scope)
     VALUES ('LEBIH', 'Terlalu besar', 'percent', 150, 'all_prices')`);
  await harusDiterima(c, "voucher nominal tetap diterima",
    `INSERT INTO discount_vouchers (code, name, discount_type, fixed_amount, scope)
     VALUES ('POTONG50', 'Potong lima puluh ribu', 'fixed', 50000, 'selected_prices')`);
  /*
    Dua bentuk nilai tidak boleh terisi bersamaan. Kalau boleh, tidak ada cara mengetahui mana yang
    dimaksud saat menghitung, dan potongan yang dipakai bergantung pada urutan pemeriksaan di kode.
  */
  await harusDitolak(c, "voucher dengan dua nilai ditolak",
    `INSERT INTO discount_vouchers (code, name, discount_type, percent_value, fixed_amount, scope)
     VALUES ('DUA', 'Dua nilai', 'percent', 10, 5000, 'all_prices')`);
  await harusDitolak(c, "voucher tanpa nilai ditolak",
    `INSERT INTO discount_vouchers (code, name, discount_type, scope)
     VALUES ('KOSONG', 'Tanpa nilai', 'percent', 'all_prices')`);
  await harusDitolak(c, "jenis potongan asing ditolak",
    `INSERT INTO discount_vouchers (code, name, discount_type, fixed_amount, scope)
     VALUES ('ANEH', 'Jenis asing', 'gratis', 5000, 'all_prices')`);
  await harusDitolak(c, "kode voucher huruf kecil ditolak",
    `INSERT INTO discount_vouchers (code, name, discount_type, fixed_amount, scope)
     VALUES ('hemat30', 'Huruf kecil', 'fixed', 5000, 'all_prices')`);
  await harusDitolak(c, "kode voucher duplikat ditolak",
    `INSERT INTO discount_vouchers (code, name, discount_type, percent_value, scope)
     VALUES ('HEMAT20', 'Kembar', 'percent', 25, 'all_prices')`);
  await harusDitolak(c, "jendela voucher terbalik ditolak",
    `INSERT INTO discount_vouchers (code, name, discount_type, percent_value, scope, starts_at, ends_at)
     VALUES ('TERBALIK', 'Terbalik', 'percent', 10, 'all_prices', now(), now() - interval '1 day')`);

  /*
    Daftar harga terpilih hanya boleh ada untuk voucher bercakupan `selected_prices`. Baris sisa
    untuk voucher `all_prices` membuat cakupannya tidak lagi dapat disimpulkan dari data.
  */
  const voucherId = (
    await c.query<{ id: string }>("SELECT id FROM discount_vouchers WHERE code = 'POTONG50'")
  ).rows[0].id;
  const allPricesVoucherId = (
    await c.query<{ id: string }>("SELECT id FROM discount_vouchers WHERE code = 'HEMAT20'")
  ).rows[0].id;
  await harusDiterima(c, "harga terpilih untuk voucher selected_prices diterima",
    `INSERT INTO discount_voucher_prices (voucher_id, plan_price_id) VALUES ($1,$2)`,
    [voucherId, priceBulananId]);
  await harusDitolak(c, "harga terpilih untuk voucher all_prices ditolak",
    `INSERT INTO discount_voucher_prices (voucher_id, plan_price_id) VALUES ($1,$2)`,
    [allPricesVoucherId, priceBulananId]);
  /*
    Satu harga boleh dipakai beberapa voucher, tetapi tidak boleh dua kali oleh voucher yang sama.
    Baris kembar tidak mengubah arti apa pun, dan justru membuat jumlah harga terpilih pada layar
    terlihat berbeda dari yang sebenarnya.
  */
  await harusDitolak(c, "harga terpilih kembar pada voucher yang sama ditolak",
    `INSERT INTO discount_voucher_prices (voucher_id, plan_price_id) VALUES ($1,$2)`,
    [voucherId, priceBulananId]);

  /*
    Voucher bercakupan `selected_prices` yang didaftarkan hanya pada harga bulanan tidak boleh
    mengenai harga tahunan. Inilah bedanya cakupan terpilih dari `all_prices`, dan pemeriksaan ini
    yang membuktikannya.
  */
  const sasaranTahunan = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM discount_voucher_prices vp
     JOIN plan_prices p ON p.id = vp.plan_price_id
     WHERE vp.voucher_id = $1 AND vp.plan_price_id = $2`,
    [voucherId, priceTahunanId],
  );
  hasil("voucher selected_prices tidak mengenai harga tahunan", sasaranTahunan.rows[0].n === 0);

  await harusDiterima(c, "penukaran voucher pertama diterima",
    `INSERT INTO discount_voucher_redemptions
       (voucher_id, customer_id, code, amount_before, discount_amount, amount_after)
     VALUES ($1,$2,'POTONG50',100000,50000,50000)`, [voucherId, customerId]);
  await harusDitolak(c, "penukaran kedua oleh pelanggan yang sama ditolak",
    `INSERT INTO discount_voucher_redemptions
       (voucher_id, customer_id, code, amount_before, discount_amount, amount_after)
     VALUES ($1,$2,'POTONG50',100000,50000,50000)`, [voucherId, customerId]);
  /*
    Selisih yang tidak cocok berarti potongan yang dicatat bukan potongan yang diberikan. Angka itu
    yang dipakai laporan, jadi ketidakcocokannya harus ditolak database, bukan dibiarkan lewat.
  */
  await harusDitolak(c, "penukaran dengan selisih tidak cocok ditolak",
    `INSERT INTO discount_voucher_redemptions
       (voucher_id, code, amount_before, discount_amount, amount_after)
     VALUES ($1,'BEDA',100000,50000,60000)`, [voucherId]);
  await harusDitolak(c, "penukaran dengan potongan negatif ditolak",
    `INSERT INTO discount_voucher_redemptions
       (voucher_id, code, amount_before, discount_amount, amount_after)
     VALUES ($1,'NEGATIF',100000,-5000,105000)`, [voucherId]);

  /*
    Pemeriksaan yang paling penting di modul ini: potongan tidak boleh melebihi harga. Tanpa batas
    ini, satu voucher bernilai besar dapat menghasilkan tagihan bernilai negatif.
  */
  await harusDitolak(c, "potongan melebihi harga ditolak",
    `INSERT INTO invoices (customer_id, invoice_number, status, subtotal, discount_amount, total_amount)
     VALUES ($1,'INV-D1','open',100000,150000,-50000)`, [customerId]);
  await harusDiterima(c, "potongan sama dengan harga diterima",
    `INSERT INTO invoices (customer_id, invoice_number, status, subtotal, discount_amount, total_amount)
     VALUES ($1,'INV-D2','open',100000,100000,0)`, [customerId]);

  await harusDiterima(c, "flash sale paket diterima",
    `INSERT INTO plan_flash_sales (plan_id, name, discount_type, percent_value, scope, starts_at, ends_at)
     VALUES ($1,'Flash sale uji','percent',30,'all_prices', now(), now() + interval '1 day')`, [planUjiId]);
  /*
    Dua jendela yang bertabrakan pada paket yang sama membuat harga akhir bergantung pada urutan
    pembacaan baris. Karena itu tabrakan ditolak, bukan diselesaikan diam-diam.
  */
  await harusDitolak(c, "jendela flash sale bertabrakan pada paket sama ditolak",
    `INSERT INTO plan_flash_sales (plan_id, name, discount_type, percent_value, scope, starts_at, ends_at)
     VALUES ($1,'Bertabrakan','percent',10,'all_prices', now() + interval '1 hour', now() + interval '2 day')`, [planUjiId]);
  await harusDiterima(c, "jendela flash sale setelah yang lama ditutup diterima",
    `INSERT INTO plan_flash_sales (plan_id, name, discount_type, percent_value, scope, starts_at, ends_at)
     VALUES ($1,'Setelahnya','percent',10,'all_prices', now() + interval '2 day', now() + interval '3 day')`, [planUjiId]);
  await harusDitolak(c, "jendela flash sale terbalik ditolak",
    `INSERT INTO plan_flash_sales (plan_id, name, discount_type, percent_value, scope, starts_at, ends_at)
     VALUES ($1,'Terbalik','percent',10,'all_prices', now() + interval '1 day', now())`, [planUjiId]);
  await harusDiterima(c, "jendela flash sale pada paket lain diterima",
    `INSERT INTO plan_flash_sales (plan_id, name, discount_type, percent_value, scope, starts_at, ends_at)
     VALUES ($1,'Paket lain','percent',10,'all_prices', now(), now() + interval '1 day')`, [planUjiLainId]);
  /*
    Flash sale yang dinonaktifkan tidak boleh menghalangi jendela baru pada paket yang sama. Tanpa
    pengecualian ini, promo yang sudah dibatalkan akan terus memblokir jadwal berikutnya.
  */
  await harusDiterima(c, "flash sale nonaktif dalam jendela sama diterima",
    `INSERT INTO plan_flash_sales (plan_id, name, discount_type, percent_value, scope, starts_at, ends_at, is_active)
     VALUES ($1,'Sudah dibatalkan','percent',20,'all_prices', now(), now() + interval '1 day', false)`, [planUjiId]);

  console.log("\n-- panggilan ke provider --");
  await harusDitolak(c, "durasi negatif ditolak",
    `INSERT INTO payment_provider_calls (operation, duration_ms, outcome) VALUES ('transactiondetail', -1, 'success')`);
  await harusDitolak(c, "operasi tidak dikenal ditolak",
    `INSERT INTO payment_provider_calls (operation, duration_ms, outcome) VALUES ('hapusdata', 10, 'success')`);
  await harusDiterima(c, "panggilan gagal tanpa order_id diterima",
    `INSERT INTO payment_provider_calls (operation, duration_ms, outcome, error_message) VALUES ('transactioncreate', 5012, 'failed', 'timeout')`);

  console.log("\n-- idempotency --");
  await harusDiterima(c, "kunci pertama diterima",
    `INSERT INTO idempotency_keys (actor_key, actor_type, actor_id, endpoint, idempotency_key, request_hash, expires_at)
     VALUES ('customer:'||$1::text,'customer',$1::uuid,'/devices/claim','k1','h1', now() + interval '1 day')`, [customerId]);
  await harusDitolak(c, "kunci sama dengan isi berbeda ditolak",
    `INSERT INTO idempotency_keys (actor_key, actor_type, actor_id, endpoint, idempotency_key, request_hash, expires_at)
     VALUES ('customer:'||$1::text,'customer',$1::uuid,'/devices/claim','k1','h2', now() + interval '1 day')`, [customerId]);
  /*
    Bagian terpenting dari tabel ini. Permintaan tanpa login harus tetap terdedup. Kalau unique
    index memakai actor_id, keduanya akan lolos karena di PostgreSQL setiap NULL dianggap
    berbeda dari NULL lain, dan pendaftaran ganda tidak akan pernah tercegah.
  */
  await harusDiterima(c, "anon pertama diterima",
    `INSERT INTO idempotency_keys (actor_key, actor_type, endpoint, idempotency_key, request_hash, expires_at)
     VALUES ('anon:abc','anon','/register','k9','h9', now() + interval '1 day')`);
  await harusDitolak(c, "anon dengan kunci sama tetap terdedup",
    `INSERT INTO idempotency_keys (actor_key, actor_type, endpoint, idempotency_key, request_hash, expires_at)
     VALUES ('anon:abc','anon','/register','k9','h9', now() + interval '1 day')`);

  console.log("\n-- job terjadwal --");
  await harusDiterima(c, "job berjalan diterima",
    `INSERT INTO scheduled_job_runs (job_name, outcome) VALUES ('reconcile_payments','running')`);
  await harusDitolak(c, "job berjalan dengan finished_at ditolak",
    `INSERT INTO scheduled_job_runs (job_name, outcome, finished_at) VALUES ('reconcile_payments','running', now())`);
  await harusDitolak(c, "job sukses tanpa finished_at ditolak",
    `INSERT INTO scheduled_job_runs (job_name, outcome) VALUES ('reconcile_payments','success')`);
  await harusDitolak(c, "job sukses dengan error_message ditolak",
    `INSERT INTO scheduled_job_runs (job_name, outcome, finished_at, error_message) VALUES ('reconcile_payments','success', now(), 'ada galat')`);
  await harusDitolak(c, "nama job tidak dikenal ditolak",
    `INSERT INTO scheduled_job_runs (job_name, outcome) VALUES ('job_karangan','running')`);
}

/*
  Trigger updated_at diuji di luar transaksi utama.

  now() di PostgreSQL mengembalikan waktu mulai transaksi, bukan waktu pernyataan. Di dalam satu
  transaksi, created_at dan updated_at karena itu selalu bernilai sama dan pergerannya tidak
  dapat diamati. Uji di dalam transaksi akan selalu melaporkan "tidak bergerak" meski
  trigger-nya bekerja, dan itu sudah pernah terjadi.
*/
async function ujiTriggerUpdatedAt(url: string): Promise<void> {
  console.log("\n-- trigger updated_at (transaksi terpisah) --");
  const tulis = new Client({ ...buildConnectionConfig(url) });
  await tulis.connect();

  let id: string | null = null;
  try {
    const dibuat = await tulis.query<{ id: string; created_at: Date; updated_at: Date }>(
      "INSERT INTO customers (full_name) VALUES ('Uji Trigger') RETURNING id, created_at, updated_at",
    );
    id = dibuat.rows[0].id;

    // Jeda nyata, supaya transaksi berikutnya benar-benar mulai di waktu yang berbeda.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const lain = new Client({ ...buildConnectionConfig(url) });
    await lain.connect();
    const sesudah = (
      await lain.query<{ created_at: Date; updated_at: Date }>(
        "UPDATE customers SET full_name='Berubah' WHERE id=$1 RETURNING created_at, updated_at",
        [id],
      )
    ).rows[0];
    await lain.end();

    hasil(
      "updated_at bergerak maju",
      sesudah.updated_at.getTime() > dibuat.rows[0].updated_at.getTime(),
      `-> ${dibuat.rows[0].updated_at.toISOString()} menjadi ${sesudah.updated_at.toISOString()}`,
    );
    hasil(
      "created_at tidak ikut tersentuh",
      sesudah.created_at.getTime() === dibuat.rows[0].created_at.getTime(),
    );
  } finally {
    // Baris uji dibersihkan meski ada langkah yang gagal.
    if (id) await tulis.query("DELETE FROM customers WHERE id=$1", [id]).catch(() => {});
    await tulis.end();
  }
}

async function main(): Promise<void> {
  const url = databaseUrl();
  console.log(`Target   : ${describeTarget()}`);
  console.log(`Enkripsi : ${describeTls(url)}`);

  const c = new Client({ ...buildConnectionConfig(url) });
  await c.connect();

  try {
    console.log("\n-- jumlah tabel --");
    const tabel = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'schema_migrations'`,
    );
    hasil(`44 tabel domain (dapat ${tabel.rows[0].n})`, tabel.rows[0].n === 44);

    await c.query("BEGIN");
    await ujiBatasan(c);
    await c.query("ROLLBACK");
    console.log("\nTransaksi dibatalkan, tidak ada data uji yang tersimpan.");
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await c.end();
  }

  await ujiTriggerUpdatedAt(url);

  console.log(`\n===== ${lulus} lulus, ${gagal} gagal =====`);
  if (gagal > 0) process.exitCode = 1;
}

main().catch((error: Error) => {
  console.error(`Pemeriksaan skema gagal: ${error.message}`);
  process.exitCode = 1;
});

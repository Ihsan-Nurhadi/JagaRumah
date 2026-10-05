/*
  Modul diskon: kode voucher dan potongan waktu terbatas (flash sale).

  Yang dimuat di sini adalah dua cara memotong harga langganan:

  1. Voucher — kode yang diketik pelanggan saat checkout.
  2. Flash sale — potongan yang berlaku sendiri selama jendela waktunya terbuka, tanpa kode.

  Keduanya memotong harga baris `plan_prices` yang dipilih, bukan harga paket secara umum. Alasannya:
  satu paket bisa punya harga bulanan dan tahunan sekaligus, dan diskon yang ditujukan untuk
  berlangganan setahun hampir tidak pernah dimaksudkan untuk yang bulanan. Karena itu kolom
  `scope` menentukan apakah potongannya mengenai satu harga saja atau seluruh harga paket itu.

  Potongan hanya boleh sampai harga menjadi nol, tidak pernah negatif. Voucher bernilai Rp50.000
  untuk paket Rp25.000 memotong Rp25.000, bukan Rp50.000; selisihnya tidak dikembalikan sebagai
  utang dan tidak dapat dipindahkan ke tagihan lain. Batas ini ditegakkan di database lewat
  `CHECK (discount_amount <= subtotal)`, bukan hanya di kode, supaya baris yang mustahil tidak
  dapat masuk dari jalur mana pun, termasuk perbaikan data manual.
*/
CREATE TABLE discount_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /*
    Kode voucher ditulis dengan huruf besar semua dan angka, tanpa spasi.

    Pelanggan membacanya dari baliho, obrolan, atau potongan tulisan tangan, dan huruf besar
    menghilangkan satu sumber salah ketik. Pemeriksaan saat penukaran juga mengabaikan besar-kecil
    huruf dan spasi di tepi, jadi yang tersimpan selalu bentuk bakunya.
  */
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),
  name text NOT NULL,
  description text,

  /*
    Jenis potongan. `percent` disimpan sebagai bilangan bulat 1..100, bukan pecahan 0..1, karena
    konsol menampilkan dan menerima persen sebagai bilangan bulat. Menyimpan 0,15 di kolom yang
    di layar terbaca "15%" adalah jalan tercepat menuju potongan seratus kali lipat.
  */
  discount_type text NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  percent_value integer CHECK (percent_value IS NULL OR (percent_value >= 1 AND percent_value <= 100)),
  fixed_amount numeric(14, 2) CHECK (fixed_amount IS NULL OR fixed_amount > 0),
  currency char(3) NOT NULL DEFAULT 'IDR',

  /*
    Kedua bentuk di atas saling meniadakan. Salah satu harus ada, dan yang lain harus kosong,
    supaya tidak pernah ada baris yang menyimpan dua nilai dan menimbulkan pertanyaan mana yang
    dipakai saat menghitung.
  */
  CONSTRAINT discount_vouchers_value_consistency CHECK (
    (discount_type = 'percent' AND percent_value IS NOT NULL AND fixed_amount IS NULL)
    OR (discount_type = 'fixed' AND fixed_amount IS NOT NULL AND percent_value IS NULL)
  ),

  /*
    Cakupan potongan.

    `all_prices` berarti seluruh harga paket yang bersangkutan, termasuk interval yang harganya
    ditambahkan kemudian. `selected_prices` berarti hanya baris harga yang didaftarkan di
    discount_voucher_prices.
  */
  scope text NOT NULL CHECK (scope IN ('all_prices', 'selected_prices')),

  /*
    Kuota dan masa berlaku.

    `max_redemptions` NULL berarti tanpa kuota total. `max_redemptions_per_customer` minimal 1 dan
    dibatasi 1..100, dengan 1 sebagai nilai yang paling masuk akal untuk promo akuisisi.
    `starts_at` NULL berarti sudah berlaku sejak dibuat, `ends_at` NULL berarti tidak kedaluwarsa.
  */
  max_redemptions integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  max_redemptions_per_customer integer NOT NULL DEFAULT 1
    CHECK (max_redemptions_per_customer >= 1 AND max_redemptions_per_customer <= 100),

  /*
    minimal_amount adalah harga sebelum potongan. Voucher di bawah ambang itu ditolak, dengan pesan
    yang menyebut nominal yang kurang, bukan sekadar "voucher tidak berlaku".
  */
  min_amount numeric(14, 2) CHECK (min_amount IS NULL OR min_amount > 0),

  /*
    Langganan berjalan tidak dapat diupgrade memakai voucher. Kolom ini disediakan supaya batas itu
    tidak perlu dipaksa lewat skema baru bila nanti diperbolehkan.
  */
  applies_to text NOT NULL DEFAULT 'initial_checkout'
    CHECK (applies_to IN ('initial_checkout', 'all_checkout')),

  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_by_admin_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT discount_vouchers_period_consistency CHECK (
    starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at
  )
);

CREATE TRIGGER discount_vouchers_set_updated_at
  BEFORE UPDATE ON discount_vouchers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/*
  Pencarian kode voucher selalu berupa pencocokan tepat pada bentuk bakunya, jadi index biasa sudah
  cukup. Index tambahan untuk daftar konsol disusun menurut waktu dibuat, karena itu urutan yang
  dipakai halaman voucher dan urutan itu juga yang dipakai keyset pagination.
*/
CREATE INDEX discount_vouchers_created_idx ON discount_vouchers (created_at DESC);

CREATE INDEX discount_vouchers_active_idx ON discount_vouchers (is_active, ends_at);

COMMENT ON TABLE discount_vouchers IS
  'Kode voucher yang dapat diketik pelanggan saat checkout. Potongan tidak menumpuk dengan flash sale; yang dipakai adalah yang paling menguntungkan pelanggan.';

-- ---------------------------------------------------------------- discount_voucher_prices

/*
  Harga mana saja yang terkena voucher, untuk voucher bercakupan `selected_prices`.

  Baris di sini tidak boleh ada untuk voucher bercakupan `all_prices`. Aturan itu ditegakkan
  trigger di bawah, bukan hanya oleh kode pemanggil, karena baris sisa seperti itu membuat
  pertanyaan "sebenarnya voucher ini mengenai harga yang mana" tidak dapat dijawab dari data.
*/
CREATE TABLE discount_voucher_prices (
  voucher_id uuid NOT NULL REFERENCES discount_vouchers (id) ON DELETE CASCADE,
  plan_price_id uuid NOT NULL REFERENCES plan_prices (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (voucher_id, plan_price_id)
);

CREATE INDEX discount_voucher_prices_price_idx ON discount_voucher_prices (plan_price_id);

CREATE FUNCTION discount_voucher_prices_check_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  voucher_scope text;
BEGIN
  SELECT scope INTO voucher_scope
  FROM discount_vouchers
  WHERE id = NEW.voucher_id;

  IF voucher_scope = 'all_prices' THEN
    RAISE EXCEPTION
      'Voucher bercakupan all_prices tidak boleh punya daftar harga terpilih. Ubah cakupannya menjadi selected_prices lebih dulu.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER discount_voucher_prices_scope
  BEFORE INSERT OR UPDATE ON discount_voucher_prices
  FOR EACH ROW EXECUTE FUNCTION discount_voucher_prices_check_scope();

-- ---------------------------------------------------------------- discount_voucher_redemptions

/*
  Catatan penukaran voucher.

  Satu baris ditulis untuk setiap pemakaian yang berhasil. Jumlah baris per voucher adalah kuota yang
  sudah terpakai, dan jumlah baris per (voucher, pelanggan) adalah pemakaian pelanggan itu. Keduanya
  dihitung dari tabel ini, bukan dari penghitung terpisah, supaya angka kuota tidak dapat melenceng
  dari kenyataan pemakaiannya.

  Tabel ini juga yang menegakkan "sekali per pelanggan": batasan UNIQUE di bawah membuat dua
  permintaan checkout serentak dari pelanggan yang sama tidak dapat sama-sama berhasil.
*/
CREATE TABLE discount_voucher_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES discount_vouchers (id) ON DELETE CASCADE,

  /*
    Pelanggan dan langganan boleh dikosongkan karena keduanya bisa hilang: langganan dihapus saat
    pelanggan dihapus. Catatan keuangannya tetap disimpan supaya pemakaian voucher tidak lenyap dari
    riwayat hanya karena akunnya dibersihkan. Karena itu tindakan yang dipilih adalah SET NULL,
    bukan CASCADE.
  */
  customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES subscriptions (id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES invoices (id) ON DELETE SET NULL,

  /*
    Kode voucher disalin ke sini. Tanpa salinan ini, menghapus voucher akan menghapus satu-satunya
    keterangan tentang potongan apa yang pernah diberikan pada sebuah invoice.
  */
  code text NOT NULL,

  /*
    Nominal sebelum dan sesudah potongan disimpan apa adanya. Selisihnya adalah potongan yang
    diberikan, dan angka itulah yang dipakai laporan bila nanti dibutuhkan. Nilai ini tidak dihitung
    ulang dari master, karena master bisa berubah sedangkan transaksi yang sudah terjadi tidak.
  */
  amount_before numeric(14, 2) NOT NULL CHECK (amount_before >= 0),
  discount_amount numeric(14, 2) NOT NULL CHECK (discount_amount >= 0),
  amount_after numeric(14, 2) NOT NULL CHECK (amount_after >= 0),

  redeemed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT discount_voucher_redemptions_amount_consistency CHECK (
    amount_after = amount_before - discount_amount
  ),
  CONSTRAINT discount_voucher_redemptions_positive_discount CHECK (discount_amount >= 0),
  CONSTRAINT discount_voucher_redemptions_once_per_customer
    UNIQUE (voucher_id, customer_id)
);

CREATE INDEX discount_voucher_redemptions_voucher_idx
  ON discount_voucher_redemptions (voucher_id, redeemed_at DESC);

CREATE INDEX discount_voucher_redemptions_customer_idx
  ON discount_voucher_redemptions (customer_id);

-- ---------------------------------------------------------------- plan_flash_sales

/*
  Flash sale paket: potongan yang berlaku sendiri selama jendela waktunya terbuka.

  Berbeda dari voucher yang dipanggil pelanggan, flash sale aktif karena waktu, jadi yang menentukan
  adalah rentang `starts_at` sampai `ends_at` dan keduanya wajib. Tanpa jendela waktu, "flash sale"
  berubah menjadi harga normal yang tidak pernah berakhir, dan potongan yang tidak pernah ditutup
  adalah kesalahan yang paling mahal di modul ini.

  Cakupan harganya sama dengan voucher: seluruh harga paket atau harga terpilih. Harga terpilih
  dipakai saat hanya interval tertentu yang didiskon.
*/
CREATE TABLE plan_flash_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES subscription_plans (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,

  discount_type text NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  percent_value integer CHECK (percent_value IS NULL OR (percent_value >= 1 AND percent_value <= 100)),
  fixed_amount numeric(14, 2) CHECK (fixed_amount IS NULL OR fixed_amount > 0),
  currency char(3) NOT NULL DEFAULT 'IDR',

  CONSTRAINT plan_flash_sales_value_consistency CHECK (
    (discount_type = 'percent' AND percent_value IS NOT NULL AND fixed_amount IS NULL)
    OR (discount_type = 'fixed' AND fixed_amount IS NOT NULL AND percent_value IS NULL)
  ),

  scope text NOT NULL CHECK (scope IN ('all_prices', 'selected_prices')),

  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by_admin_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT plan_flash_sales_period_consistency CHECK (ends_at > starts_at)
);

/*
  Trigger, bukan batasan CHECK biasa.

  Pemeriksaan bentrok jendela waktu perlu membaca baris lain pada tabel yang sama, dan CHECK tidak
  dapat melihat baris lain. Aturannya: satu harga hanya boleh punya satu flash sale aktif pada satu
  saat. Tanpa aturan ini, dua flash sale yang terlipat menghasilkan pertanyaan "yang dipakai yang
  mana" yang tidak punya jawaban benar, dan menyelesaikannya di kode berarti kedua jalur penulisan
  harus mengingatnya selamanya.

  Cakupan `all_prices` cocok dengan semua harga paket, jadi bentroknya diperiksa per paket. Cakupan
  `selected_prices` diperiksa per harga yang didaftarkan.
*/
CREATE FUNCTION plan_flash_sales_check_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bentrok text;
BEGIN
  IF NOT NEW.is_active THEN
    RETURN NEW;
  END IF;

  SELECT f.name INTO bentrok
  FROM plan_flash_sales f
  WHERE f.id <> NEW.id
    AND f.is_active
    AND f.starts_at < NEW.ends_at
    AND f.ends_at > NEW.starts_at
    AND (
      (f.scope = 'all_prices' AND f.plan_id = NEW.plan_id)
      OR (
        NEW.scope = 'all_prices'
        AND f.scope = 'selected_prices'
        AND f.plan_id = NEW.plan_id
      )
      OR (
        f.scope = 'selected_prices'
        AND NEW.scope = 'selected_prices'
        AND EXISTS (
          SELECT 1
          FROM plan_flash_sale_prices fp
          JOIN plan_flash_sale_prices np ON np.plan_price_id = fp.plan_price_id
          WHERE fp.flash_sale_id = f.id
            AND np.flash_sale_id = NEW.id
        )
      )
    )
  LIMIT 1;

  IF bentrok IS NOT NULL THEN
    RAISE EXCEPTION
      'Jendela waktu flash sale ini bertabrakan dengan "%" pada paket yang sama. Persingkat salah satu jendelanya, atau nonaktifkan yang lama lebih dulu.',
      bentrok
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER plan_flash_sales_no_overlap
  BEFORE INSERT OR UPDATE ON plan_flash_sales
  FOR EACH ROW EXECUTE FUNCTION plan_flash_sales_check_overlap();

CREATE TRIGGER plan_flash_sales_set_updated_at
  BEFORE UPDATE ON plan_flash_sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX plan_flash_sales_window_idx ON plan_flash_sales (starts_at, ends_at) WHERE is_active;

CREATE INDEX plan_flash_sales_plan_idx ON plan_flash_sales (plan_id, starts_at DESC);

COMMENT ON TABLE plan_flash_sales IS
  'Potongan harga paket yang berlaku menurut jendela waktu. Satu harga hanya boleh punya satu flash sale aktif pada satu saat.';

-- ---------------------------------------------------------------- plan_flash_sale_prices

CREATE TABLE plan_flash_sale_prices (
  flash_sale_id uuid NOT NULL REFERENCES plan_flash_sales (id) ON DELETE CASCADE,
  plan_price_id uuid NOT NULL REFERENCES plan_prices (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flash_sale_id, plan_price_id)
);

CREATE INDEX plan_flash_sale_prices_price_idx ON plan_flash_sale_prices (plan_price_id);

CREATE FUNCTION plan_flash_sale_prices_check_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  flash_scope text;
BEGIN
  SELECT scope INTO flash_scope
  FROM plan_flash_sales
  WHERE id = NEW.flash_sale_id;

  IF flash_scope = 'all_prices' THEN
    RAISE EXCEPTION
      'Flash sale bercakupan all_prices tidak boleh punya daftar harga terpilih. Ubah cakupannya menjadi selected_prices lebih dulu.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER plan_flash_sale_prices_scope
  BEFORE INSERT OR UPDATE ON plan_flash_sale_prices
  FOR EACH ROW EXECUTE FUNCTION plan_flash_sale_prices_check_scope();

-- ---------------------------------------------------------------- izin konsol

/*
  Dua izin baru, dipisah baca dan kelola seperti modul lain.

  Cetakannya sengaja mengikuti `plan.read` dan `plan.manage`: harga paket dan potongannya dibaca
  orang yang sama, dan memisahkannya hanya akan menghasilkan dua tempat untuk memeriksa hal yang
  sama. Peran `finance` diberi izin baca karena mereka yang menyusun promo, dan peran bawaan lainnya
  tidak diberi izin kelola apa pun secara diam-diam.
*/
INSERT INTO admin_permissions (code, name, description) VALUES
  ('discount.read', 'Lihat diskon', 'Membuka daftar voucher dan flash sale paket.'),
  ('discount.manage', 'Kelola diskon', 'Membuat, mengubah, dan menonaktifkan voucher serta flash sale.');

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
JOIN admin_permissions p ON p.code IN ('discount.read', 'discount.manage')
WHERE r.code = 'super_admin';

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
JOIN admin_permissions p ON p.code = 'discount.read'
WHERE r.code = 'finance';

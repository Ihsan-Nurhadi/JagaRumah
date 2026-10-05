-- 0004: modul paket subscription dan modul invoice dan pembayaran.
--
-- Rancangan DB_Plan.md bagian 4 dan 5. Keduanya digabung dalam satu berkas karena invoice
-- tidak punya arti tanpa subscription, dan memisahkannya hanya akan membuat migrasi yang tidak
-- bisa diterapkan sendiri.

-- ---------------------------------------------------------------- subscription_plans

CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  /*
    NULL berarti tanpa batas. Paket yang batasnya belum ditetapkan pemilik produk dibiarkan
    NULL, bukan diisi angka karangan, karena angka yang salah di sini akan menolak pelanggan
    yang seharusnya boleh menambah perangkat.
  */
  device_limit integer CHECK (device_limit IS NULL OR device_limit >= 0),
  is_free boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  -- Urutan tingkat paket. Dipakai menolak downgrade dan menentukan arah upgrade.
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER subscription_plans_set_updated_at
  BEFORE UPDATE ON subscription_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX subscription_plans_order_idx ON subscription_plans (sort_order);

-- ---------------------------------------------------------------- plan_prices

CREATE TABLE plan_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES subscription_plans (id) ON DELETE CASCADE,
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly', 'yearly')),
  /*
    numeric, bukan float. Nilai uang dalam float menghasilkan pembulatan yang tidak dapat
    dipertanggungjawabkan pada perhitungan prorata.
  */
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'IDR',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Satu paket hanya punya satu harga aktif per interval.
  UNIQUE (plan_id, billing_interval)
);

CREATE TRIGGER plan_prices_set_updated_at
  BEFORE UPDATE ON plan_prices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- subscriptions

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES subscription_plans (id),
  plan_price_id uuid REFERENCES plan_prices (id),
  status text NOT NULL CHECK (
    status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')
  ),
  started_at timestamptz NOT NULL DEFAULT now(),
  current_period_start timestamptz NOT NULL DEFAULT now(),
  /*
    NULL berarti tidak kedaluwarsa. Paket gratis memakai nilai ini, sehingga pemeriksaan batas
    perangkat tetap memakai mekanisme subscription yang sama dengan paket berbayar.
  */
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/*
  Satu customer hanya boleh punya satu subscription berjalan. Batasan ini ditegakkan index,
  bukan hanya oleh kode, karena dua permintaan checkout yang datang bersamaan dapat lolos dari
  pemeriksaan kode dan menghasilkan dua subscription aktif yang menagih pelanggan dua kali.
*/
CREATE UNIQUE INDEX one_active_subscription_per_customer
  ON subscriptions (customer_id)
  WHERE status IN ('trialing', 'active', 'past_due');

CREATE INDEX subscriptions_customer_idx ON subscriptions (customer_id, created_at DESC);
CREATE INDEX subscriptions_status_idx ON subscriptions (status, current_period_end);

-- ---------------------------------------------------------------- subscription_events

CREATE TABLE subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (
    event_type IN ('activated', 'renewed', 'upgraded', 'expired', 'canceled', 'past_due', 'manual_change')
  ),
  from_plan_id uuid REFERENCES subscription_plans (id),
  to_plan_id uuid REFERENCES subscription_plans (id),
  invoice_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('customer', 'admin', 'system')),
  actor_id uuid,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  /*
    Tindakan admin dan customer wajib punya pelaku. Tanpa batasan ini, perubahan subscription
    bisa tercatat tanpa penjelasan siapa yang melakukannya.
  */
  CONSTRAINT subscription_events_actor_consistency CHECK (
    (actor_type = 'system' AND actor_id IS NULL) OR
    (actor_type <> 'system' AND actor_id IS NOT NULL)
  )
);

CREATE INDEX subscription_events_subscription_idx
  ON subscription_events (subscription_id, created_at DESC);
CREATE INDEX subscription_events_customer_idx
  ON subscription_events (customer_id, created_at DESC);

-- ---------------------------------------------------------------- invoices

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions (id) ON DELETE SET NULL,
  invoice_number text NOT NULL UNIQUE,
  status text NOT NULL CHECK (
    status IN ('draft', 'open', 'paid', 'past_due', 'void', 'uncollectible')
  ),
  currency char(3) NOT NULL DEFAULT 'IDR',
  subtotal numeric(14, 2) NOT NULL DEFAULT 0,
  discount_amount numeric(14, 2) NOT NULL DEFAULT 0,
  tax_amount numeric(14, 2) NOT NULL DEFAULT 0,
  total_amount numeric(14, 2) NOT NULL DEFAULT 0,
  /*
    amount_paid diisi sebesar nominal tagihan, bukan total yang dibayar customer. Biaya layanan
    provider tidak pernah masuk ke sini, karena biaya itu bukan pendapatan subscription.
  */
  amount_paid numeric(14, 2) NOT NULL DEFAULT 0,
  due_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_paid_at_consistency CHECK (
    (status = 'paid' AND paid_at IS NOT NULL) OR (status <> 'paid' AND paid_at IS NULL)
  ),
  CONSTRAINT invoices_voided_at_consistency CHECK (
    (status = 'void' AND voided_at IS NOT NULL) OR (status <> 'void' AND voided_at IS NULL)
  )
);

CREATE TRIGGER invoices_set_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX invoices_customer_idx ON invoices (customer_id, created_at DESC);
CREATE INDEX invoices_status_idx ON invoices (status, due_at);
/*
  Laporan pendapatan memakai dasar kas pada paid_at, jadi index ini yang melayani laporan
  keuangan dan sekaligus memisahkan invoice yang belum dibayar.
*/
CREATE INDEX invoices_paid_at_idx ON invoices (paid_at DESC) WHERE paid_at IS NOT NULL;

-- ---------------------------------------------------------------- invoice_items

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  description text NOT NULL,
  plan_id uuid REFERENCES subscription_plans (id),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- Harga disalin, supaya invoice lama tidak ikut berubah saat harga master diperbarui.
  unit_amount numeric(14, 2) NOT NULL,
  total_amount numeric(14, 2) NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invoice_items_invoice_idx ON invoice_items (invoice_id);

-- ---------------------------------------------------------------- payment_attempts

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  attempt_sequence integer NOT NULL CHECK (attempt_sequence > 0),
  provider text NOT NULL DEFAULT 'pakasir',
  payment_method text NOT NULL,
  -- Kunci transaksi di sisi Pakasir, sekaligus penghubung dari webhook ke attempt ini.
  provider_order_id text NOT NULL UNIQUE,
  provider_payment_id text,
  provider_fee numeric(14, 2),
  provider_total_payment numeric(14, 2),
  amount numeric(14, 2) NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending', 'paid', 'expired', 'failed', 'canceled')
  ),
  checkout_url text,
  qr_string text,
  va_number text,
  expires_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  canceled_at timestamptz,
  /*
    Diisi hanya setelah status dikonfirmasi lewat transactiondetail. Kolom ini yang membedakan
    pembayaran yang benar-benar terverifikasi dari yang statusnya masih diandaikan.
  */
  verified_at timestamptz,
  verified_via text CHECK (verified_via IS NULL OR verified_via IN ('webhook', 'reconciliation', 'sync')),
  raw_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, attempt_sequence),
  CONSTRAINT payment_attempts_verified_via_consistency CHECK (
    (verified_at IS NULL AND verified_via IS NULL) OR (verified_at IS NOT NULL AND verified_via IS NOT NULL)
  ),
  CONSTRAINT payment_attempts_paid_at_consistency CHECK (
    (status = 'paid' AND paid_at IS NOT NULL) OR (status <> 'paid' AND paid_at IS NULL)
  )
);

CREATE TRIGGER payment_attempts_set_updated_at
  BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX payment_attempts_invoice_idx ON payment_attempts (invoice_id, attempt_sequence);
CREATE INDEX payment_attempts_status_idx ON payment_attempts (status, expires_at);

-- ---------------------------------------------------------------- payment_webhook_events

CREATE TABLE payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'pakasir',
  /*
    Pakasir tidak mengirim event ID, jadi kuncinya disusun sebagai {order_id}:{status}. Satu
    order_id mewakili satu transaksi, sehingga kombinasi itu cukup mencegah pemrosesan ganda.
  */
  provider_event_id text NOT NULL UNIQUE,
  payment_attempt_id uuid REFERENCES payment_attempts (id) ON DELETE SET NULL,
  provider_order_id text,
  provider_status text,
  event_type text NOT NULL,
  -- Payload webhook disimpan apa adanya karena tidak memuat kredensial apa pun.
  payload jsonb NOT NULL,
  ip_address inet,
  user_agent text,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_webhook_events_attempt_idx ON payment_webhook_events (payment_attempt_id);
CREATE INDEX payment_webhook_events_order_idx ON payment_webhook_events (provider_order_id, created_at DESC);
-- Job proses ulang webhook menyaring baris yang belum diproses, jadi index parsial ini yang dipakai.
CREATE INDEX payment_webhook_events_unprocessed_idx ON payment_webhook_events (created_at)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------- payment_provider_calls

CREATE TABLE payment_provider_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'pakasir',
  operation text NOT NULL CHECK (
    operation IN ('transactioncreate', 'transactioncancel', 'transactiondetail', 'paymentsimulation')
  ),
  payment_attempt_id uuid REFERENCES payment_attempts (id) ON DELETE SET NULL,
  -- Nullable karena panggilan create yang gagal sebelum order dibuat tetap perlu tercatat.
  order_id text,
  request_body jsonb,
  response_body jsonb,
  http_status integer,
  -- Wajib diisi meski gagal, karena timeout juga punya durasi, dan durasi itulah yang
  -- menunjukkan berapa lama pengguna menunggu.
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failed')),
  error_message text,
  attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN payment_provider_calls.request_body IS
  'Disaring saat penulisan: field api_key selalu diganti "[disaring]". Berbeda dari payload webhook yang disimpan apa adanya, karena request kita memuat kredensial sedangkan webhook tidak.';

CREATE INDEX payment_provider_calls_created_at_idx ON payment_provider_calls (created_at DESC);
CREATE INDEX payment_provider_calls_order_idx ON payment_provider_calls (order_id, created_at DESC);
CREATE INDEX payment_provider_calls_outcome_idx ON payment_provider_calls (outcome, created_at DESC);

-- ---------------------------------------------------------------- payment_refunds

CREATE TABLE payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_attempt_id uuid NOT NULL REFERENCES payment_attempts (id),
  provider_refund_id text,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  requested_by_admin_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT payment_refunds_completed_at_consistency CHECK (
    (status = 'completed' AND completed_at IS NOT NULL) OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE INDEX payment_refunds_attempt_idx ON payment_refunds (payment_attempt_id);
-- Laporan pengembalian dana memakai dasar kas pada completed_at.
CREATE INDEX payment_refunds_completed_idx ON payment_refunds (completed_at DESC)
  WHERE completed_at IS NOT NULL;

-- ---------------------------------------------------------------- tautan yang menunggu

-- subscription_events.invoice_id tidak bisa memakai REFERENCES saat tabel invoices belum ada,
-- karena subscription_events dibuat lebih dulu di berkas ini. Batasannya ditambahkan di sini.
ALTER TABLE subscription_events
  ADD CONSTRAINT subscription_events_invoice_fk
  FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE SET NULL;

CREATE INDEX subscription_events_invoice_idx ON subscription_events (invoice_id)
  WHERE invoice_id IS NOT NULL;

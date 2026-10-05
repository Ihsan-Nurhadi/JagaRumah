-- 0003: modul customer mobile dan perangkat CCTV.
--
-- Rancangan DB_Plan.md bagian 2 dan 3. Modul ini diletakkan sebelum subscription karena
-- subscription menunjuk ke customers, sedangkan perangkat menunjuk ke keduanya.

-- ---------------------------------------------------------------- customers

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  avatar_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- customer_auth_accounts

/*
  Cara masuk customer dipisah dari profilnya, karena satu customer bisa punya lebih dari satu
  cara masuk, dan aturan tiap cara berbeda. Email memakai kata sandi, WhatsApp memakai OTP,
  Google memakai subjek dari token.
*/
CREATE TABLE customer_auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('email', 'whatsapp', 'google')),
  provider_subject text,
  email citext,
  phone_e164 text,
  password_hash text,
  is_verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  /*
    Aturan per provider ditegakkan di database, bukan hanya di kode. Tanpa batasan ini, baris
    provider email tanpa kata sandi bisa lolos dan menghasilkan akun yang tidak bisa dimasuki
    siapa pun, atau lebih buruk, akun tanpa kata sandi yang dianggap sah.
  */
  CONSTRAINT customer_auth_accounts_provider_fields CHECK (
    (provider = 'email'    AND email IS NOT NULL AND password_hash IS NOT NULL) OR
    (provider = 'whatsapp' AND phone_e164 IS NOT NULL AND password_hash IS NULL) OR
    (provider = 'google'   AND provider_subject IS NOT NULL AND password_hash IS NULL)
  ),
  CONSTRAINT customer_auth_accounts_verified_at_consistency CHECK (
    (is_verified AND verified_at IS NOT NULL) OR (NOT is_verified AND verified_at IS NULL)
  )
);

CREATE TRIGGER customer_auth_accounts_set_updated_at
  BEFORE UPDATE ON customer_auth_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX customer_auth_accounts_provider_subject_key
  ON customer_auth_accounts (provider, provider_subject)
  WHERE provider_subject IS NOT NULL;
CREATE UNIQUE INDEX customer_auth_accounts_email_key
  ON customer_auth_accounts (email)
  WHERE email IS NOT NULL;
CREATE UNIQUE INDEX customer_auth_accounts_phone_key
  ON customer_auth_accounts (phone_e164)
  WHERE phone_e164 IS NOT NULL;
CREATE INDEX customer_auth_accounts_customer_idx
  ON customer_auth_accounts (customer_id);

-- ---------------------------------------------------------------- customer_sessions

CREATE TABLE customer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  /*
    device_id di sini adalah penanda instalasi aplikasi mobile, bukan perangkat CCTV. Namanya
    mengikuti DB_Plan.md dan sengaja tidak diganti supaya tidak ada dua istilah untuk hal yang
    sama di dokumen dan di database.
  */
  device_id text,
  platform text,
  app_version text,
  ip_address inet,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by_session_id uuid REFERENCES customer_sessions (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX customer_sessions_customer_idx ON customer_sessions (customer_id, created_at DESC);
CREATE INDEX customer_sessions_active_idx ON customer_sessions (expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- auth_verification_codes

CREATE TABLE auth_verification_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers (id) ON DELETE CASCADE,
  target text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  purpose text NOT NULL CHECK (
    purpose IN ('login', 'verify_email', 'verify_phone', 'change_email', 'change_phone', 'reset_password')
  ),
  -- Hanya hash yang disimpan. Kode asli tidak pernah masuk database.
  code_hash text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_verification_codes_target_idx
  ON auth_verification_codes (target, purpose, created_at DESC);
CREATE INDEX auth_verification_codes_active_idx
  ON auth_verification_codes (expires_at)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------- devices

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_uid text NOT NULL UNIQUE,
  serial_number text NOT NULL UNIQUE,
  name text,
  model text,
  hardware_revision text,
  batch_number text,
  mac_address text,
  imei text,
  /*
    Nullable karena perangkat didaftarkan ke gudang sebelum dimiliki siapa pun. NULL berarti
    masih di gudang, bukan data yang belum lengkap.
  */
  customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'in_stock'
    CHECK (status IN ('in_stock', 'claimed', 'suspended', 'retired', 'deleted')),
  claim_method text CHECK (claim_method IS NULL OR claim_method IN ('qr', 'serial')),
  registered_by_admin_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  warranty_start_at timestamptz,
  claimed_at timestamptz,
  activated_at timestamptz,
  deactivated_at timestamptz,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  /*
    Perangkat yang terklaim wajib punya pemilik dan waktu klaim, dan perangkat di gudang tidak
    boleh punya keduanya. Tanpa batasan ini, perangkat bisa berstatus terklaim tanpa pemilik,
    dan pemeriksaan batas perangkat akan menghitungnya sebagai milik seseorang yang tidak ada.
  */
  CONSTRAINT devices_claim_consistency CHECK (
    (status = 'claimed'   AND customer_id IS NOT NULL AND claimed_at IS NOT NULL) OR
    (status = 'suspended' AND customer_id IS NOT NULL) OR
    (status IN ('in_stock', 'retired', 'deleted') AND claimed_at IS NULL)
  )
);

CREATE TRIGGER devices_set_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

/*
  Batas perangkat dihitung dengan menyaring customer dan status, jadi index ini yang dipakai
  setiap kali customer mengklaim atau membuka daftar perangkatnya.
*/
CREATE INDEX devices_customer_idx ON devices (customer_id, status);
CREATE INDEX devices_status_idx ON devices (status, created_at DESC);
CREATE INDEX devices_model_idx ON devices (model);
CREATE INDEX devices_batch_idx ON devices (batch_number);

-- ---------------------------------------------------------------- device_claim_codes

CREATE TABLE device_claim_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unik karena satu perangkat hanya punya satu kode claim aktif.
  device_id uuid NOT NULL UNIQUE REFERENCES devices (id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  format text NOT NULL DEFAULT 'both' CHECK (format IN ('qr', 'both')),
  /*
    Nullable berarti tidak kedaluwarsa. Dipakai pada v1 supaya perangkat yang lama tersimpan di
    gudang tetap bisa diklaim.
  */
  expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  used_at timestamptz,
  used_by_customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_claim_codes_active_idx ON device_claim_codes (created_at DESC)
  WHERE used_at IS NULL;

-- ---------------------------------------------------------------- device_claim_attempts

/*
  Catatan setiap percobaan claim, berhasil maupun gagal. Tabel ini wajib ada karena jalur
  nomor seri bisa ditebak, sehingga tanpa catatan ini penyalahgunaan tidak bisa ditelusuri dan
  pembatasan percobaan tidak bisa dihitung.
*/
CREATE TABLE device_claim_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable karena percobaan dengan nomor seri yang tidak dikenal tidak terhubung ke perangkat.
  device_id uuid REFERENCES devices (id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
  submitted_kind text NOT NULL CHECK (submitted_kind IN ('qr', 'serial')),
  -- Nilai yang dikirim customer disimpan tersamarkan, bukan apa adanya.
  submitted_value_masked text,
  ip_address inet,
  user_agent text,
  success boolean NOT NULL,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_claim_attempts_reason_matches_success CHECK (
    (success AND failure_reason IS NULL) OR (NOT success AND failure_reason IS NOT NULL)
  )
);

CREATE INDEX device_claim_attempts_customer_idx
  ON device_claim_attempts (customer_id, created_at DESC);
CREATE INDEX device_claim_attempts_ip_idx
  ON device_claim_attempts (ip_address, created_at DESC);
CREATE INDEX device_claim_attempts_failed_idx
  ON device_claim_attempts (created_at DESC)
  WHERE NOT success;

-- ---------------------------------------------------------------- fase 2

/*
  Dua tabel berikut dibuat sekarang meski belum dipakai, sesuai urutan di DB_Plan.md. Alasannya:
  perangkat sudah mulai didaftarkan pada v1, dan menambahkan tabel kredensial belakangan berarti
  ada perangkat yang sudah beredar tanpa tempat menyimpan kredensialnya.
*/
CREATE TABLE device_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL UNIQUE REFERENCES devices (id) ON DELETE CASCADE,
  credential_type text NOT NULL,
  encrypted_username text,
  encrypted_secret text NOT NULL,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER device_credentials_set_updated_at
  BEFORE UPDATE ON device_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE device_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_events_device_idx ON device_events (device_id, occurred_at DESC);

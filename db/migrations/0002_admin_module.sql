-- 0002: modul admin web.
--
-- Sembilan tabel rancangan DB_Plan.md bagian 1: admin_users, admin_roles, admin_permissions,
-- admin_user_roles, admin_role_permissions, admin_sessions, admin_login_attempts,
-- admin_session_events, audit_logs.
--
-- Modul ini didahulukan karena tidak bergantung pada tabel lain, dan seluruh tindakan admin
-- pada modul berikutnya menulis jejaknya ke sini. Selama tabel ini belum ada, tidak ada satu
-- pun perubahan data yang bisa ditelusuri ke pelakunya.

-- ---------------------------------------------------------------- admin_users

CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username citext NOT NULL UNIQUE,
  email citext NOT NULL UNIQUE,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  avatar_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'locked')),
  is_super_admin boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN admin_users.password_hash IS
  'Hash bcrypt. Kata sandi asli tidak pernah disimpan maupun dicatat di log.';
COMMENT ON COLUMN admin_users.is_super_admin IS
  'Jalan pintas untuk master user awal. Otorisasi sehari-hari tetap lewat role dan permission.';

-- ---------------------------------------------------------------- admin_roles

CREATE TABLE admin_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- admin_permissions

CREATE TABLE admin_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text
);

-- ---------------------------------------------------------------- relasi

CREATE TABLE admin_user_roles (
  admin_user_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES admin_roles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_user_id, role_id)
);

CREATE TABLE admin_role_permissions (
  role_id uuid NOT NULL REFERENCES admin_roles (id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES admin_permissions (id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ---------------------------------------------------------------- admin_sessions

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  ip_address inet,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by_session_id uuid REFERENCES admin_sessions (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

COMMENT ON COLUMN admin_sessions.refresh_token_hash IS
  'SHA-256 dari refresh token. Token asli hanya ada di cookie browser dan tidak pernah masuk database.';
COMMENT ON COLUMN admin_sessions.replaced_by_session_id IS
  'Diisi saat rotasi. Rantai ini yang membedakan sesi yang digantikan dari sesi yang dicabut paksa.';

-- Rotasi refresh token menelusuri rantai penggantian, dan halaman sesi menyaring sesi yang
-- masih aktif. Keduanya butuh index pada kolom yang dipakai menyaring.
CREATE INDEX admin_sessions_user_idx ON admin_sessions (admin_user_id, created_at DESC);
CREATE INDEX admin_sessions_active_idx ON admin_sessions (expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- admin_login_attempts

-- Tanpa ON DELETE, baris ini sengaja dipertahankan meski admin dihapus. Catatan percobaan
-- login yang ikut terhapus bersama akunnya menghapus bukti brute-force tepat saat bukti itu
-- paling dibutuhkan.
CREATE TABLE admin_login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  username_attempted citext NOT NULL,
  ip_address inet,
  success boolean NOT NULL,
  failure_reason text CHECK (
    failure_reason IS NULL
    OR failure_reason IN ('unknown_user', 'wrong_password', 'inactive', 'locked', 'rate_limited')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_login_attempts_reason_matches_success CHECK (
    (success AND failure_reason IS NULL) OR (NOT success AND failure_reason IS NOT NULL)
  )
);

COMMENT ON CONSTRAINT admin_login_attempts_reason_matches_success ON admin_login_attempts IS
  'Percobaan berhasil tidak punya alasan gagal, dan percobaan gagal wajib punya alasan. Tanpa batasan ini, baris gagal tanpa alasan akan menyulitkan saat menelusuri pola serangan.';

CREATE INDEX admin_login_attempts_username_idx
  ON admin_login_attempts (username_attempted, created_at DESC);
CREATE INDEX admin_login_attempts_ip_idx
  ON admin_login_attempts (ip_address, created_at DESC);
CREATE INDEX admin_login_attempts_failed_idx
  ON admin_login_attempts (created_at DESC)
  WHERE NOT success;

-- ---------------------------------------------------------------- admin_session_events

CREATE TABLE admin_session_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_session_id uuid REFERENCES admin_sessions (id) ON DELETE SET NULL,
  admin_user_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (
    event_type IN ('login', 'refresh', 'logout', 'revoked', 'expired', 'password_changed')
  ),
  ip_address inet,
  user_agent text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_session_events_user_idx
  ON admin_session_events (admin_user_id, created_at DESC);
CREATE INDEX admin_session_events_session_idx
  ON admin_session_events (admin_session_id, created_at DESC);

-- ---------------------------------------------------------------- audit_logs

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL DEFAULT 'admin' CHECK (actor_type IN ('admin', 'system')),
  admin_user_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  old_data jsonb,
  new_data jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_actor_consistency CHECK (
    (actor_type = 'admin' AND admin_user_id IS NOT NULL)
    OR (actor_type = 'system' AND admin_user_id IS NULL)
  )
);

COMMENT ON CONSTRAINT audit_logs_actor_consistency ON audit_logs IS
  'Tindakan admin wajib punya pelaku, tindakan sistem tidak boleh punya pelaku. Tanpa batasan ini, tindakan otomatis bisa tercatat seolah dilakukan manusia, dan pertanyaan "siapa yang mengubah ini" kehilangan jawabannya.';

CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_admin_idx ON audit_logs (admin_user_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);

-- ---------------------------------------------------------------- trigger updated_at

CREATE TRIGGER admin_users_set_updated_at
  BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- data awal

-- Role awal. Hanya role yang sudah pasti dipakai yang dimasukkan. Role tambahan dibuat lewat
-- halaman /roles setelah kebutuhan nyata muncul.
INSERT INTO admin_roles (code, name, description) VALUES
  ('super_admin', 'Super Admin', 'Akses penuh, termasuk mengelola admin dan role.'),
  ('finance', 'Keuangan', 'Membaca invoice dan pembayaran, memproses refund.'),
  ('customer_support', 'Dukungan Pelanggan', 'Menangani data customer dan perangkat yang mereka klaim.'),
  ('device_operator', 'Operator Perangkat', 'Mengelola stok dan penugasan perangkat.');

-- Permission awal, dikelompokkan per modul supaya halaman /roles bisa ditampilkan rapi.
INSERT INTO admin_permissions (code, name, description) VALUES
  ('dashboard.read', 'Lihat dashboard', 'Membuka ringkasan bisnis, keuangan, dan operasional.'),
  ('customer.read', 'Lihat customer', 'Membuka daftar dan detail customer.'),
  ('customer.update', 'Ubah customer', 'Mengubah data customer.'),
  ('customer.suspend', 'Suspend customer', 'Menonaktifkan dan mengaktifkan kembali customer.'),
  ('device.read', 'Lihat perangkat', 'Membuka daftar dan detail perangkat.'),
  ('device.create', 'Tambah perangkat', 'Mendaftarkan perangkat baru ke inventory.'),
  ('device.update', 'Ubah perangkat', 'Mengubah data, status, dan penugasan perangkat.'),
  ('device.claim_code', 'Kelola kode claim', 'Menerbitkan dan mencabut kode claim perangkat.'),
  ('subscription.read', 'Lihat subscription', 'Membuka daftar dan detail subscription.'),
  ('subscription.manage', 'Kelola subscription', 'Mengubah dan membatalkan subscription.'),
  ('plan.read', 'Lihat paket', 'Membuka daftar paket dan harga.'),
  ('plan.manage', 'Kelola paket', 'Menambah dan mengubah paket serta harga.'),
  ('invoice.read', 'Lihat invoice', 'Membuka daftar dan detail invoice.'),
  ('invoice.void', 'Batalkan invoice', 'Membatalkan invoice yang masih terbuka.'),
  ('payment.read', 'Lihat pembayaran', 'Membuka pembayaran, log gateway, dan log provider.'),
  ('payment.verify', 'Verifikasi pembayaran', 'Menandai pembayaran terverifikasi secara manual.'),
  ('payment.refund', 'Refund pembayaran', 'Memproses pengembalian dana.'),
  ('report.read', 'Lihat laporan', 'Membuka laporan dan mengunduh CSV.'),
  ('audit.read', 'Lihat audit', 'Membuka log audit, percobaan login, dan sesi admin.'),
  ('admin.manage', 'Kelola admin', 'Mengelola akun admin, role, dan permission.');

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
CROSS JOIN admin_permissions p
WHERE r.code = 'super_admin';

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
JOIN admin_permissions p ON p.code IN (
  'dashboard.read', 'customer.read', 'subscription.read', 'plan.read',
  'invoice.read', 'payment.read', 'report.read'
)
WHERE r.code = 'finance';

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
JOIN admin_permissions p ON p.code IN (
  'dashboard.read', 'customer.read', 'customer.update', 'customer.suspend',
  'device.read', 'device.claim_code', 'subscription.read', 'invoice.read', 'payment.read'
)
WHERE r.code = 'customer_support';

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
JOIN admin_permissions p ON p.code IN (
  'dashboard.read', 'device.read', 'device.create', 'device.update', 'device.claim_code',
  'customer.read'
)
WHERE r.code = 'device_operator';

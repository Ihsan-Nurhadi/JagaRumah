-- 0005: modul infrastruktur API.
--
-- Rancangan DB_Plan.md bagian 6. Dua tabel di sini menopang keandalan, bukan fitur: satu
-- mencegah request yang diulang membuat data ganda, satu lagi membuat job terjadwal yang mati
-- tetap terlihat.

-- ---------------------------------------------------------------- idempotency_keys

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /*
    Penanda pelaku dalam bentuk teks yang selalu terisi, misalnya customer:<uuid>,
    admin:<uuid>, atau anon:<hash-ip>. Unique index memakai kolom ini, bukan actor_id.
  */
  actor_key text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('customer', 'admin', 'anon')),
  /*
    Nullable dan hanya untuk penelusuran. Unique index tidak boleh memakai kolom ini, karena
    pada endpoint tanpa login seperti register nilainya NULL, dan di PostgreSQL setiap NULL
    dianggap berbeda dari NULL lain sehingga dedup tidak akan pernah bekerja.
  */
  actor_id uuid,
  endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  -- Memastikan kunci yang sama tidak dipakai ulang dengan isi request yang berbeda.
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_anon_has_no_actor CHECK (
    (actor_type = 'anon' AND actor_id IS NULL) OR actor_type <> 'anon'
  )
);

CREATE UNIQUE INDEX idempotency_keys_unique_request
  ON idempotency_keys (actor_key, endpoint, idempotency_key);

-- Job pembersih menyaring baris kedaluwarsa, jadi index ini yang dipakainya.
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

COMMENT ON COLUMN idempotency_keys.response_body IS
  'Tidak boleh memuat access token, refresh token, OTP, atau claim token plaintext. Untuk endpoint yang mengembalikan token, simpan hanya penanda bahwa response sudah pernah dihasilkan.';

-- ---------------------------------------------------------------- scheduled_job_runs

CREATE TABLE scheduled_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL CHECK (
    job_name IN (
      'reconcile_payments',
      'reprocess_webhooks',
      'expire_payment_attempts',
      'expire_invoices',
      'expire_subscriptions',
      'cleanup_idempotency_keys',
      'cleanup_verification_codes'
    )
  ),
  started_at timestamptz NOT NULL DEFAULT now(),
  /*
    Nullable karena baris dibuat saat job mulai lalu diperbarui saat selesai. Cara ini membuat
    job yang mati di tengah jalan tetap terlihat sebagai baris running yang tidak pernah
    selesai, bukan hilang tanpa jejak.
  */
  finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('running', 'success', 'failed')),
  /*
    Berapa baris yang disentuh. Job rekonsiliasi yang berjalan sukses tetapi menyentuh nol baris
    selama berhari-hari adalah tanda ada yang salah pada konfigurasi atau kredensial provider.
    Tanpa angka ini, job yang berjalan tetapi tidak melakukan apa pun akan tampak sehat.
  */
  affected_rows integer NOT NULL DEFAULT 0 CHECK (affected_rows >= 0),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_job_runs_finished_consistency CHECK (
    (outcome = 'running' AND finished_at IS NULL) OR (outcome <> 'running' AND finished_at IS NOT NULL)
  ),
  CONSTRAINT scheduled_job_runs_error_matches_outcome CHECK (
    (outcome = 'failed') OR (outcome <> 'failed' AND error_message IS NULL)
  )
);

CREATE INDEX scheduled_job_runs_job_idx ON scheduled_job_runs (job_name, started_at DESC);
-- Halaman operasional mencari job yang belum selesai dan job yang terakhir berjalan.
CREATE INDEX scheduled_job_runs_running_idx ON scheduled_job_runs (started_at DESC)
  WHERE outcome = 'running';

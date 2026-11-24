-- 0018_alert_evidence.sql
-- Menyimpan metadata evidence (snapshot & cuplikan video 10 detik) untuk ONVIF motion/person alerts
-- serta pengaturan deteksi & jadwal sleep mode per kamera/customer.

ALTER TABLE camera_alerts
  ADD COLUMN IF NOT EXISTS snapshot_path text,
  ADD COLUMN IF NOT EXISTS clip_path text,
  ADD COLUMN IF NOT EXISTS clip_duration_seconds integer CHECK (clip_duration_seconds IS NULL OR clip_duration_seconds >= 0),
  ADD COLUMN IF NOT EXISTS evidence_status text NOT NULL DEFAULT 'none'
    CHECK (evidence_status IN ('none', 'processing', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS onvif_topic text,
  ADD COLUMN IF NOT EXISTS metadata jsonb;

CREATE INDEX IF NOT EXISTS camera_alerts_dedup_idx
  ON camera_alerts (device_id, alert_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS camera_alert_settings (
  device_id uuid PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  motion_detection_enabled boolean NOT NULL DEFAULT true,
  person_detection_enabled boolean NOT NULL DEFAULT true,
  notifications_enabled boolean NOT NULL DEFAULT true,
  cooldown_seconds integer NOT NULL DEFAULT 30 CHECK (cooldown_seconds >= 5 AND cooldown_seconds <= 3600),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_sleep_schedules (
  customer_id uuid PRIMARY KEY REFERENCES customers (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  start_time text NOT NULL DEFAULT '22:00' CHECK (start_time ~ '^\d{2}:\d{2}$'),
  end_time text NOT NULL DEFAULT '06:00' CHECK (end_time ~ '^\d{2}:\d{2}$'),
  active_days text[] NOT NULL DEFAULT ARRAY['Sen', 'Sel', 'Rab', 'Kam', 'Jum'],
  camera_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  updated_at timestamptz NOT NULL DEFAULT now()
);

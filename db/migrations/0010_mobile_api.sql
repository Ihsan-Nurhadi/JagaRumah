-- 0010: mobile CCTV telemetry, alerts, recordings, preferences, and content.
-- Device inventory remains source of ownership; these tables hold runtime/mobile data.

CREATE TABLE camera_telemetry (
  device_id uuid PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  connection_status text NOT NULL CHECK (connection_status IN ('active', 'offline', 'unknown')),
  recording_status text NOT NULL CHECK (recording_status IN ('recording', 'not_recording', 'unknown')),
  thumbnail_url text,
  thumbnail_expires_at timestamptz,
  last_seen_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX camera_telemetry_status_idx ON camera_telemetry (connection_status, last_seen_at DESC);
CREATE INDEX camera_telemetry_recording_idx ON camera_telemetry (recording_status, last_seen_at DESC);

CREATE TABLE camera_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  alert_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title text NOT NULL,
  message text,
  thumbnail_url text,
  thumbnail_expires_at timestamptz,
  occurred_at timestamptz NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  recording_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT camera_alerts_read_consistency CHECK ((is_read AND read_at IS NOT NULL) OR (NOT is_read AND read_at IS NULL))
);

CREATE INDEX camera_alerts_device_idx ON camera_alerts (device_id, occurred_at DESC);
CREATE INDEX camera_alerts_unread_idx ON camera_alerts (is_read, occurred_at DESC);

CREATE TABLE camera_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('available', 'processing', 'expired')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  thumbnail_url text,
  thumbnail_expires_at timestamptz,
  playback_url text,
  playback_expires_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT camera_recordings_period_consistency CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX camera_recordings_device_idx ON camera_recordings (device_id, started_at DESC);
CREATE INDEX camera_recordings_status_idx ON camera_recordings (status, started_at DESC);

ALTER TABLE camera_alerts
  ADD CONSTRAINT camera_alerts_recording_fk FOREIGN KEY (recording_id) REFERENCES camera_recordings (id) ON DELETE SET NULL;

CREATE TABLE customer_mobile_settings (
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  notifications_enabled boolean NOT NULL DEFAULT true,
  alerts_enabled boolean NOT NULL DEFAULT true,
  critical_alerts_only boolean NOT NULL DEFAULT false,
  biometric_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, installation_id)
);

CREATE TABLE customer_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  token text NOT NULL,
  permission text NOT NULL CHECK (permission IN ('granted', 'denied', 'not_determined', 'unknown')),
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, installation_id)
);

CREATE TABLE mobile_help_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  category text NOT NULL,
  locale text NOT NULL DEFAULT 'id-ID',
  title text NOT NULL,
  summary text NOT NULL,
  content text NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mobile_help_articles_search_idx ON mobile_help_articles (locale, category, updated_at DESC);

CREATE TABLE legal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type text NOT NULL CHECK (document_type IN ('terms_and_conditions')),
  version text NOT NULL,
  locale text NOT NULL DEFAULT 'id-ID',
  title text NOT NULL,
  content text NOT NULL,
  effective_at timestamptz NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_type, version, locale)
);

CREATE UNIQUE INDEX legal_documents_current_idx ON legal_documents (document_type, locale) WHERE is_current;

CREATE TABLE mobile_terms_acceptances (
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES legal_documents (id) ON DELETE RESTRICT,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, document_id)
);

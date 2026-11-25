-- 0019_vehicle_detection.sql
-- Menambahkan pengaturan deteksi kendaraan berbasis AI (YOLO ONNX),
-- mode jaga parkir (anti-curanmor), koordinat zona parkir ternormalisasi (0..1),
-- serta timestamp PTZ terakhir untuk kalibrasi ulang baseline kendaraan parkir.

ALTER TABLE camera_alert_settings
  ADD COLUMN IF NOT EXISTS vehicle_detection_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS vehicle_guard_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS parking_zone jsonb,
  ADD COLUMN IF NOT EXISTS last_ptz_at timestamptz;

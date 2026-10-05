-- 0015: URL live stream demo untuk kamera mobile.
ALTER TABLE camera_telemetry
  ADD COLUMN stream_url text;

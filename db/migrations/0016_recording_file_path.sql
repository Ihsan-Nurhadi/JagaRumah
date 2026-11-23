ALTER TABLE camera_recordings
  ADD COLUMN IF NOT EXISTS file_path text,
  ADD COLUMN IF NOT EXISTS file_size_bytes bigint;

CREATE UNIQUE INDEX IF NOT EXISTS camera_recordings_device_file_idx
  ON camera_recordings (device_id, file_path)
  WHERE file_path IS NOT NULL;

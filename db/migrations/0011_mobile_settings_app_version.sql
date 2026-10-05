-- 0011: melengkapi metadata instalasi yang dipakai response settings mobile.
ALTER TABLE customer_mobile_settings
  ADD COLUMN app_version text;

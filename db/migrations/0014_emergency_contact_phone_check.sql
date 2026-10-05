-- 0014: perbaikan validasi nomor emergency agar awalan + diterima.
ALTER TABLE emergency_contacts
  DROP CONSTRAINT emergency_contacts_phone_check;

ALTER TABLE emergency_contacts
  ADD CONSTRAINT emergency_contacts_phone_check
  CHECK (phone ~ E'^\\+?[0-9][0-9 .()\\-]{5,29}$');

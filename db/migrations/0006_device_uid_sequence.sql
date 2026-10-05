-- 0006: pembangkit nomor perangkat.
--
-- device_uid adalah nomor yang dibaca manusia dan dicetak pada label, contoh NYK-000001.
-- Nilainya harus unik dan berurutan supaya mudah dirujuk lewat telepon.
--
-- Kenapa memakai sequence PostgreSQL, bukan MAX(device_uid)+1 di kode:
-- dua permintaan pendaftaran yang datang bersamaan akan membaca MAX yang sama, lalu keduanya
-- menulis nomor yang sama. Yang kalah akan gagal karena batasan UNIQUE, dan operator melihat
-- galat yang tidak bisa dijelaskan. nextval() mengambil nomor secara atomik, jadi skenario itu
-- tidak mungkin terjadi. Nomor yang terlewat karena transaksi dibatalkan adalah konsekuensi
-- yang diterima, karena nomor perangkat tidak perlu rapat tanpa celah.
CREATE SEQUENCE device_uid_seq START WITH 1;

ALTER TABLE devices
  ALTER COLUMN device_uid SET DEFAULT 'NYK-' || lpad(nextval('device_uid_seq')::text, 6, '0');

COMMENT ON SEQUENCE device_uid_seq IS
  'Pembangkit nomor urut untuk devices.device_uid. Dipakai lewat DEFAULT kolom, bukan dipanggil dari kode, supaya pendaftaran serentak tidak menghasilkan nomor kembar.';

-- 0001: ekstensi dan fungsi bersama.
--
-- Ditulis terpisah dari migrasi tabel karena keduanya dipakai oleh seluruh modul, dan
-- kegagalan di sini harus terlihat sebagai kegagalan prasyarat, bukan kegagalan tabel.

CREATE EXTENSION IF NOT EXISTS citext;

-- Username dan email admin dibandingkan tanpa peduli huruf besar-kecil. Tanpa citext,
-- "Admin" dan "admin" akan lolos sebagai dua akun berbeda.
COMMENT ON EXTENSION citext IS
  'Dipakai untuk kolom username dan email agar perbandingan tidak membedakan huruf besar-kecil.';

-- Semua tabel memakai gen_random_uuid() sebagai default kolom id. Fungsi ini sudah ada di
-- PostgreSQL 13 ke atas, jadi tidak perlu pgcrypto.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'Trigger bersama untuk kolom updated_at. Dipasang per tabel lewat CREATE TRIGGER, bukan otomatis, supaya tabel yang tidak punya updated_at tidak ikut tersentuh.';

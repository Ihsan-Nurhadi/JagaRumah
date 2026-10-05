/*
  Batas potongan pada tagihan.

  `invoices` sudah punya kolom `discount_amount` sejak migrasi 0004, tetapi tidak ada satu pun
  batasan yang mengikatnya pada `subtotal`. Akibatnya, selama kolom itu belum pernah diisi siapa pun,
  tidak ada yang terasa. Begitu modul diskon mengisinya, satu voucher bernilai Rp150.000 pada tagihan
  Rp100.000 dapat menghasilkan `total_amount` bernilai negatif, dan tagihan negatif akan terbaca
  sebagai piutang terbalik di laporan keuangan.

  Batasnya `discount_amount <= subtotal`, bukan `total_amount >= 0`, supaya potongan tidak pernah
  melebihi harga tanpa bergantung pada apakah pajak ikut dihitung di baris itu. Aturan untuk pemakainya
  sederhana: potongan hanya boleh membuat harga menjadi nol, tidak pernah menjadi utang.

  Batas ini sengaja ditaruh di database, bukan hanya di kode penghitung diskon, karena tagihan juga
  dapat dibuat dari jalur lain seperti perbaikan data manual. Pemeriksaan di kode tetap ada supaya
  pesan galatnya jelas; batasan di sini adalah penjaga terakhirnya.

  Kedua nilai masih NULL-able secara teori, tetapi keduanya `NOT NULL DEFAULT 0` sejak 0004, jadi
  batasan ini tidak dapat diloloskan lewat nilai kosong.
*/
ALTER TABLE invoices
  ADD CONSTRAINT invoices_discount_within_subtotal
  CHECK (discount_amount <= subtotal);

COMMENT ON CONSTRAINT invoices_discount_within_subtotal ON invoices IS
  'Potongan tidak boleh melebihi harga sebelum potongan. Voucher bernilai besar memotong sampai nol, tidak menghasilkan tagihan negatif.';

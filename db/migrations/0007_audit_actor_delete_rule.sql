/*
  Memperbaiki aturan penghapusan pelaku pada jejak audit.

  Sebelumnya `audit_logs.admin_user_id` memakai `ON DELETE SET NULL`, sedangkan batasan
  `audit_logs_actor_consistency` mewajibkan kolom itu terisi selama `actor_type` bernilai
  `admin`. Keduanya tidak dapat dipenuhi bersamaan: begitu seorang admin dihapus, database
  mencoba mengosongkan kolomnya, lalu batasan itu langsung menolaknya. Akibatnya penghapusan
  admin yang pernah melakukan satu tindakan saja selalu gagal, dan galatnya muncul sebagai
  pelanggaran batasan yang tidak menerangkan sebab sebenarnya.

  Yang dipilih adalah `ON DELETE RESTRICT`, bukan melonggarkan batasannya. Alasannya: jejak
  audit hanya berguna kalau pelakunya masih dapat disebut. Membiarkan kolom pelaku kosong akan
  menghasilkan baris yang tampak seperti tindakan sistem padahal dilakukan orang, dan itu justru
  merusak gunanya sebagai bukti.

  Konsekuensinya disengaja: admin tidak dihapus, melainkan dinonaktifkan. Konsol ini memang tidak
  menyediakan penghapusan admin, hanya penonaktifan, jadi aturan ini sejalan dengan yang sudah
  berlaku. Admin yang belum pernah melakukan tindakan apa pun tetap dapat dihapus.
*/
ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_admin_user_id_fkey;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_admin_user_id_fkey
  FOREIGN KEY (admin_user_id) REFERENCES admin_users (id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT audit_logs_admin_user_id_fkey ON audit_logs IS
  'Pelaku tindakan tidak boleh dihapus selama jejak auditnya masih ada. Nonaktifkan admin, jangan hapus.';

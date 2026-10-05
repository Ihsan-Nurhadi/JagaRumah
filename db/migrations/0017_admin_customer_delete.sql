-- 0017: izin menghapus pelanggan dari konsol admin.
--
-- Sebelumnya penghapusan akun hanya tersedia dari sisi pelanggan lewat aplikasi. Admin
-- membutuhkan jalur yang sama untuk akun uji dan akun bermasalah; penghapusan tetap berupa
-- status `deleted` (soft delete), bukan DELETE baris, supaya histori tagihan tetap utuh.

INSERT INTO admin_permissions (code, name, description) VALUES
  ('customer.delete', 'Hapus customer', 'Menghapus akun customer (soft delete): status menjadi deleted dan seluruh sesinya dicabut.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
JOIN admin_permissions p ON p.code = 'customer.delete'
WHERE r.code IN ('super_admin', 'customer_support')
ON CONFLICT DO NOTHING;

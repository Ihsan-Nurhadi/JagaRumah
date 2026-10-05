-- 0016: izin menambah pelanggan manual dari konsol admin.
--
-- Sebelumnya pelanggan hanya bisa dibuat lewat pendaftaran di aplikasi mobile. Admin yang
-- menangani pendaftaran manual (misalnya pelanggan korporat atau pendaftaran lewat telepon)
-- membutuhkan jalur resmi supaya tidak perlu menyisipkan baris langsung ke database.

INSERT INTO admin_permissions (code, name, description) VALUES
  ('customer.create', 'Tambah customer', 'Membuat akun customer baru beserta cara masuk emailnya dari konsol admin.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
JOIN admin_permissions p ON p.code = 'customer.create'
WHERE r.code IN ('super_admin', 'customer_support')
ON CONFLICT DO NOTHING;

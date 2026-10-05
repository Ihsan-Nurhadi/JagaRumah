/*
  Pembersihan menyeluruh sisa data uji.

  Urutannya penting: jejak audit dihapus sebelum akunnya, karena aturan di migrasi 0007 menahan
  penghapusan pelaku yang masih punya jejak. Urutan ini hanya untuk akun uji; admin sungguhan
  dinonaktifkan, bukan dihapus.
*/
DELETE FROM audit_logs WHERE admin_user_id IN (SELECT id FROM admin_users WHERE username LIKE 'uji%');
DELETE FROM admin_session_events WHERE admin_user_id IN (SELECT id FROM admin_users WHERE username LIKE 'uji%');
DELETE FROM admin_sessions WHERE admin_user_id IN (SELECT id FROM admin_users WHERE username LIKE 'uji%');
DELETE FROM admin_user_roles WHERE admin_user_id IN (SELECT id FROM admin_users WHERE username LIKE 'uji%');
DELETE FROM admin_users WHERE username LIKE 'uji%';
DELETE FROM audit_logs WHERE entity_type = 'admin_role'
  AND entity_id IN (SELECT id FROM admin_roles WHERE code LIKE 'uji\_%');
DELETE FROM admin_role_permissions WHERE role_id IN (SELECT id FROM admin_roles WHERE code LIKE 'uji\_%');
DELETE FROM admin_roles WHERE code LIKE 'uji\_%';
/* Sesi penguji dikosongkan supaya uji selalu mulai dari keadaan bersih. */
DELETE FROM admin_session_events WHERE admin_user_id = (SELECT id FROM admin_users WHERE username = 'verifikasi.sementara');
DELETE FROM admin_sessions WHERE admin_user_id = (SELECT id FROM admin_users WHERE username = 'verifikasi.sementara');
UPDATE admin_users SET is_super_admin = true, status = 'active' WHERE username = 'verifikasi.sementara';
DELETE FROM admin_user_roles WHERE admin_user_id = (SELECT id FROM admin_users WHERE username = 'verifikasi.sementara');
INSERT INTO admin_user_roles (admin_user_id, role_id)
SELECT a.id, r.id FROM admin_users a, admin_roles r
WHERE a.username = 'verifikasi.sementara' AND r.code = 'super_admin'
ON CONFLICT DO NOTHING;
INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM admin_roles r, admin_permissions p
WHERE r.code = 'super_admin' ON CONFLICT DO NOTHING;
SELECT
  (SELECT count(*) FROM admin_users) AS admin_users,
  (SELECT count(*) FROM admin_roles) AS admin_roles,
  (SELECT count(*) FROM admin_role_permissions rp JOIN admin_roles r ON r.id = rp.role_id
     WHERE r.code = 'super_admin') AS izin_super_admin;

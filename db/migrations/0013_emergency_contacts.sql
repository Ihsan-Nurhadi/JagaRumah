-- 0013: nomor panggilan darurat yang dikelola admin dan dibaca aplikasi mobile.
CREATE TABLE emergency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  phone text NOT NULL CHECK (phone ~ '^\\+?[0-9][0-9 .()-]{5,29}$'),
  description text,
  category text NOT NULL CHECK (category IN ('security', 'police', 'fire', 'ambulance', 'technician', 'custom')),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by_admin_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX emergency_contacts_active_order_idx
  ON emergency_contacts (is_active, sort_order, name);

CREATE TRIGGER emergency_contacts_set_updated_at
  BEFORE UPDATE ON emergency_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO admin_permissions (code, name, description) VALUES
  ('emergency_contact.read', 'Lihat nomor darurat', 'Membuka daftar nomor panggilan darurat.'),
  ('emergency_contact.manage', 'Kelola nomor darurat', 'Membuat, mengubah, dan menonaktifkan nomor panggilan darurat.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
CROSS JOIN admin_permissions p
WHERE r.code = 'super_admin'
  AND p.code IN ('emergency_contact.read', 'emergency_contact.manage')
ON CONFLICT DO NOTHING;

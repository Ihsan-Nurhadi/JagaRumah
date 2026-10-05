import type { Metadata } from "next";

import { AuditConsole } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Audit",
};

/*
  Halaman audit.

  Isinya komponen klien, karena keempat tabnya mengambil datanya sendiri dari endpoint yang
  berpaginasi. Pemeriksaan sesi sudah dilakukan di layout, dan setiap endpoint memeriksa ulang
  sesi, status akun, serta permission `audit.read`. Jadi memuat halaman ini tidak mengambil satu
  baris data pun, dan admin tanpa izin itu tidak melihat apa-apa selain pesan penolakan.
*/
export default function AuditPage() {
  return <AuditConsole />;
}

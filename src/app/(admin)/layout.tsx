import { SessionBootstrap } from "@/components/session-bootstrap";
import { AppShell } from "@/components/molecules";
import { getPageSession } from "@/lib/server/page-guard";
import { redirect } from "next/navigation";

/*
  Kerangka halaman admin.

  Server memutuskan lebih dulu apakah kerangka ini boleh dirender, memakai pemeriksaan ringan
  yang tidak menyentuh database. Yang dijaga di sini adalah tampilannya, bukan datanya: tidak
  ada satu baris data pun yang diambil saat render. Seluruh data datang dari endpoint API yang
  memeriksa sesi, status akun, dan permission secara penuh.
*/
export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const session = await getPageSession();
  if (!session) redirect("/login?alasan=sesi-berakhir");

  return (
    <AppShell>
      <SessionBootstrap />
      {children}
    </AppShell>
  );
}

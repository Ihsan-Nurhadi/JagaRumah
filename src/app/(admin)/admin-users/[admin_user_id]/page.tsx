import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AdminUserDetail } from "@/components/organisms";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = {
  title: "Detail admin",
};

/*
  Alamat yang jelas bukan UUID ditolak sebelum halaman dirender, supaya tautan yang rusak tidak
  menghasilkan halaman galat yang menyalahkan server.
*/
export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ admin_user_id: string }>;
}) {
  const { admin_user_id: adminUserId } = await params;

  if (!isUuid(adminUserId)) notFound();

  return <AdminUserDetail adminUserId={adminUserId} />;
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RoleDetail } from "@/components/organisms";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = {
  title: "Detail peran",
};

export default async function RoleDetailPage({
  params,
}: {
  params: Promise<{ role_id: string }>;
}) {
  const { role_id: roleId } = await params;

  if (!isUuid(roleId)) notFound();

  return <RoleDetail roleId={roleId} />;
}

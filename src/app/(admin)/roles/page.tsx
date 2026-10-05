import type { Metadata } from "next";

import { RoleList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Peran dan izin",
};

export default function RolesPage() {
  return <RoleList />;
}

import type { Metadata } from "next";

import { AdminUserList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Admin dan peran",
};

export default function AdminUsersPage() {
  return <AdminUserList />;
}

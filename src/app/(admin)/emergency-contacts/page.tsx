import type { Metadata } from "next";

import { EmergencyContactList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Nomor emergency",
};

export default function EmergencyContactsPage() {
  return <EmergencyContactList />;
}

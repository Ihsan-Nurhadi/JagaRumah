import type { Metadata } from "next";

import { AlertList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Notifikasi Deteksi ONVIF",
};

export default function AlertsPage() {
  return <AlertList />;
}

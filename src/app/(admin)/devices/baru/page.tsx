import type { Metadata } from "next";

import { DeviceCreateForm } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Daftarkan perangkat",
};

export default function NewDevicePage() {
  return <DeviceCreateForm />;
}

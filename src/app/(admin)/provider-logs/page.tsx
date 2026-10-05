import type { Metadata } from "next";

import { ProviderLogList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Log provider pembayaran",
};

export default function ProviderLogsPage() {
  return <ProviderLogList />;
}

import type { Metadata } from "next";

import { InvoiceList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Tagihan",
};

export default function InvoicesPage() {
  return <InvoiceList />;
}

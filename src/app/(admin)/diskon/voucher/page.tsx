import type { Metadata } from "next";

import { VoucherList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Kode voucher",
};

export default function VoucherPage() {
  return <VoucherList />;
}

import type { Metadata } from "next";

import { PaymentList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Pembayaran",
};

export default function PaymentsPage() {
  return <PaymentList />;
}

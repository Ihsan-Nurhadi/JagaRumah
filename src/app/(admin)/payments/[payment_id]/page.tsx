import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PaymentDetail } from "@/components/organisms";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = {
  title: "Detail pembayaran",
};

export default async function PaymentDetailPage({
  params,
}: {
  params: Promise<{ payment_id: string }>;
}) {
  const { payment_id: paymentId } = await params;

  if (!isUuid(paymentId)) notFound();

  return <PaymentDetail paymentId={paymentId} />;
}

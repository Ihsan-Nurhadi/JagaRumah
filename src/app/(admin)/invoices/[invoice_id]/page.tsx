import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { InvoiceDetail } from "@/components/organisms";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = {
  title: "Detail tagihan",
};

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ invoice_id: string }>;
}) {
  const { invoice_id: invoiceId } = await params;

  if (!isUuid(invoiceId)) notFound();

  return <InvoiceDetail invoiceId={invoiceId} />;
}

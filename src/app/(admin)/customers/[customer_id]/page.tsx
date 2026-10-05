import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CustomerDetail } from "@/components/organisms";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = {
  title: "Detail pelanggan",
};

/*
  Alamat yang jelas bukan UUID ditolak sebelum halaman dirender. Tanpa pemeriksaan ini, tautan
  yang rusak akan mengirim permintaan ke API dan menghasilkan halaman galat yang menyalahkan
  server, padahal masalahnya ada di tautannya.
*/
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customer_id: string }>;
}) {
  const { customer_id: customerId } = await params;

  if (!isUuid(customerId)) notFound();

  return <CustomerDetail customerId={customerId} />;
}

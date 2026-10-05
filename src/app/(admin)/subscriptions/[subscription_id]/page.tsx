import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SubscriptionDetail } from "@/components/organisms";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = {
  title: "Detail langganan",
};

export default async function SubscriptionDetailPage({
  params,
}: {
  params: Promise<{ subscription_id: string }>;
}) {
  const { subscription_id: subscriptionId } = await params;

  if (!isUuid(subscriptionId)) notFound();

  return <SubscriptionDetail subscriptionId={subscriptionId} />;
}

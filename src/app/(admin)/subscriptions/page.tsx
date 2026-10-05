import type { Metadata } from "next";

import { SubscriptionList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Langganan",
};

export default function SubscriptionsPage() {
  return <SubscriptionList />;
}

import type { Metadata } from "next";

import { ActionQueue } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Perlu tindakan",
};

export default function ActionQueuePage() {
  return <ActionQueue />;
}

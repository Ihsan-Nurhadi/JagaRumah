import type { Metadata } from "next";

import { FlashSaleList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Flash sale paket",
};

export default function FlashSalePage() {
  return <FlashSaleList />;
}

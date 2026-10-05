import type { Metadata } from "next";

import { PlanList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Paket dan harga",
};

export default function PlansPage() {
  return <PlanList />;
}

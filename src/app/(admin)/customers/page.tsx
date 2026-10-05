import type { Metadata } from "next";

import { CustomerList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Pelanggan",
};

export default function CustomersPage() {
  return <CustomerList />;
}

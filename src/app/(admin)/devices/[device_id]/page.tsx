import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DeviceDetail } from "@/components/organisms";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = {
  title: "Detail perangkat",
};

export default async function DeviceDetailPage({
  params,
}: {
  params: Promise<{ device_id: string }>;
}) {
  const { device_id: deviceId } = await params;

  if (!isUuid(deviceId)) notFound();

  return <DeviceDetail deviceId={deviceId} />;
}

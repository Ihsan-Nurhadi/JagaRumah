import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ReportPage } from "@/components/organisms";
import { REPORT_LABELS, isReportType } from "@/lib/report-labels";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ jenis: string }>;
}): Promise<Metadata> {
  const { jenis } = await params;
  const label = REPORT_LABELS[jenis];
  return { title: label ? `Laporan ${label.title.toLowerCase()}` : "Laporan" };
}

export default async function LaporanDetailPage({
  params,
}: {
  params: Promise<{ jenis: string }>;
}) {
  const { jenis } = await params;

  /*
    Jenis yang tidak dikenal ditolak di sini, bukan dibiarkan sampai ke API. Tanpa pemeriksaan
    ini, alamat yang salah ketik akan menampilkan halaman laporan dengan galat server, padahal
    yang salah adalah alamatnya.
  */
  if (!isReportType(jenis)) notFound();

  return <ReportPage type={jenis} />;
}

"use client";

import { useState } from "react";

import { jakartaToday, type Period } from "@/components/molecules";

import { ReportView } from "./report-view";

/*
  Pembungkus halaman laporan yang menyimpan pilihan rentang tanggal.

  Rentang disimpan di sini, bukan di dalam tampilan laporan, karena berpindah jenis laporan tidak
  boleh mengembalikan rentangnya ke awal. Operator yang sedang menelusuri bulan tertentu akan
  kehilangan konteksnya kalau setiap perpindahan jenis mengatur ulang tanggalnya.
*/
export function ReportPage({ type }: { type: string }) {
  const [period, setPeriod] = useState<Period>(() => {
    const hariIni = jakartaToday();
    return { from: `${hariIni.slice(0, 7)}-01`, to: hariIni };
  });

  return <ReportView type={type} period={period} onPeriodChange={setPeriod} />;
}

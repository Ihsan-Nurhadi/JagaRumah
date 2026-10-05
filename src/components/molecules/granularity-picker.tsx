"use client";

import { Button } from "@/components/atoms";
import { cn } from "@/lib/utils";

/*
  Pemilih pengelompokan waktu untuk laporan yang punya arti per periode.

  Nilainya dikirim ke server, bukan dikelompokkan di klien. Pengelompokan di klien hanya bisa
  dilakukan atas baris yang sedang terbuka, dan laporan bisa memuat puluhan ribu baris.

  Batas hari, minggu, dan bulan mengikuti kalender Jakarta dan dihitung di server, karena
  tanggal yang sama diterjemahkan berbeda di mesin pengguna dan itu membuat laporan bulanan
  tidak cocok dengan catatan keuangan.
*/

export type Granularitas = "day" | "week" | "month";

const PILIHAN: { nilai: Granularitas; label: string; keterangan: string }[] = [
  { nilai: "day", label: "Harian", keterangan: "Satu baris untuk setiap hari" },
  { nilai: "week", label: "Mingguan", keterangan: "Satu baris untuk setiap minggu, mulai hari Senin" },
  { nilai: "month", label: "Bulanan", keterangan: "Satu baris untuk setiap bulan" },
];

export function GranularityPicker({
  value,
  onChange,
  loading,
  className,
}: {
  value: Granularitas;
  onChange: (next: Granularitas) => void;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <span className="text-[13px] font-medium">Pengelompokan</span>
      <div role="group" aria-label="Pengelompokan waktu" className="flex flex-wrap items-center gap-2">
        {PILIHAN.map((pilihan) => {
          const aktif = pilihan.nilai === value;
          return (
            <Button
              key={pilihan.nilai}
              type="button"
              variant={aktif ? "secondary" : "ghost"}
              aria-pressed={aktif}
              disabled={loading}
              className="h-9 px-3 text-[13px]"
              onClick={() => onChange(pilihan.nilai)}
            >
              {pilihan.label}
            </Button>
          );
        })}
      </div>
      {/*
        Keterangan yang sedang berlaku ditulis di samping, bukan disimpan di atribut `title`.
        Keterangan yang hanya muncul saat kursor berhenti di atas tombol tidak terbaca oleh
        pengguna papan tuntas dan tidak terbaca di layar sentuh.
      */}
      <span className="text-muted-foreground text-[13px]">
        {PILIHAN.find((pilihan) => pilihan.nilai === value)?.keterangan}
      </span>
    </div>
  );
}

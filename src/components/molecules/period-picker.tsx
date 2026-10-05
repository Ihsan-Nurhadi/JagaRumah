"use client";

import { ArrowClockwiseIcon } from "@phosphor-icons/react";

import { Button, TextInput } from "@/components/atoms";
import { cn } from "@/lib/utils";

/*
  Pemilih rentang tanggal.

  Dipakai oleh dashboard dan halaman laporan, dan di kedua tempat itu rentangnya harus terlihat
  jelas. Laporan yang tidak menyebutkan periodenya tidak dapat dipakai untuk apa pun, karena
  angkanya tidak bisa dikaitkan dengan kurun waktu tertentu.

  Nilainya dikirim ke server, bukan disaring di klien. Daftar dan laporan bisa memuat puluhan
  ribu baris, dan menyaring di klien hanya akan menyaring yang sedang terbuka di layar.

  Batas hari yang diterjemahkan dari tanggal ini mengikuti zona waktu Jakarta, dan penerjemahan
  itu dilakukan di sisi server, bukan di sini. Tanggal yang sama akan menghasilkan batas hari
  yang berbeda bila diterjemahkan di mesin pengguna, dan itu membuat laporan bulanan tidak cocok
  dengan catatan keuangan.
*/

export type Period = { from: string; to: string };

/*
  Pintasan rentang yang paling sering dipakai. Dihitung dari tanggal hari ini di zona waktu
  Jakarta, supaya "bulan ini" berarti bulan berjalan menurut kalender setempat, bukan menurut
  UTC.
*/
export function periodShortcuts(today = jakartaToday()): { label: string; period: Period }[] {
  const [year, month] = today.split("-").map(Number);
  const awalBulan = `${year}-${String(month).padStart(2, "0")}-01`;
  const akhirBulan = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const bulanLalu = month === 1 ? 12 : month - 1;
  const tahunLalu = month === 1 ? year - 1 : year;
  const awalBulanLalu = `${tahunLalu}-${String(bulanLalu).padStart(2, "0")}-01`;
  const akhirBulanLalu = new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
  const tujuhHariLalu = new Date(`${today}T00:00:00Z`);
  tujuhHariLalu.setUTCDate(tujuhHariLalu.getUTCDate() - 6);

  return [
    { label: "7 hari terakhir", period: { from: tujuhHariLalu.toISOString().slice(0, 10), to: today } },
    { label: "Bulan ini", period: { from: awalBulan, to: today } },
    { label: "Bulan lalu", period: { from: awalBulanLalu, to: akhirBulanLalu } },
    { label: "Bulan ini penuh", period: { from: awalBulan, to: akhirBulan } },
  ];
}

/*
  Tanggal hari ini menurut Jakarta.

  Memakai `toISOString()` langsung akan memberi tanggal UTC, dan pada pukul 07.00 WIB tanggal 1
  angkanya masih tertulis tanggal terakhir bulan sebelumnya, sehingga pintasan "bulan ini" akan
  menunjuk bulan yang salah.
*/
export function jakartaToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
}

export function PeriodPicker({
  value,
  onChange,
  onReload,
  loading,
  shortcuts = true,
  className,
}: {
  value: Period;
  onChange: (next: Period) => void;
  onReload?: () => void;
  loading?: boolean;
  shortcuts?: boolean;
  className?: string;
}) {
  const daftar = periodShortcuts();

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="periode-dari" className="text-[13px] font-medium">
            Dari tanggal
          </label>
          <TextInput
            id="periode-dari"
            type="date"
            value={value.from}
            max={value.to}
            onChange={(event) => {
              if (event.target.value) onChange({ ...value, from: event.target.value });
            }}
            className="w-40"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="periode-sampai" className="text-[13px] font-medium">
            Sampai tanggal
          </label>
          <TextInput
            id="periode-sampai"
            type="date"
            value={value.to}
            min={value.from}
            onChange={(event) => {
              if (event.target.value) onChange({ ...value, to: event.target.value });
            }}
            className="w-40"
          />
        </div>

        {onReload ? (
          <Button
            type="button"
            variant="secondary"
            onClick={onReload}
            disabled={loading}
            className="mb-0"
          >
            <ArrowClockwiseIcon aria-hidden className="size-4" />
            {loading ? "Memuat" : "Muat ulang"}
          </Button>
        ) : null}
      </div>

      {shortcuts ? (
        <div className="flex flex-wrap items-center gap-2">
          {daftar.map((pintasan) => {
            const aktif =
              pintasan.period.from === value.from && pintasan.period.to === value.to;
            return (
              <Button
                key={pintasan.label}
                type="button"
                variant={aktif ? "secondary" : "ghost"}
                aria-pressed={aktif}
                /* Target sentuh tetap memadai meski tombolnya kecil, sesuai ketentuan aksesibilitas. */
                className="h-9 px-3 text-[13px]"
                onClick={() => onChange(pintasan.period)}
              >
                {pintasan.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

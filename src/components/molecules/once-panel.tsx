"use client";

import { XIcon } from "@phosphor-icons/react";

import { Button } from "@/components/atoms";
import { cn } from "@/lib/utils";

/*
  Panel yang muncul di atas tabel untuk menampilkan sesuatu yang hanya terlihat sekali,
  terutama kode claim perangkat.

  Kenapa panel, bukan toast: kode claim harus bisa disalin, dibacakan, dan dicetak. Toast
  menghilang sendiri setelah beberapa detik, dan kode yang belum sempat dicatat tidak bisa
  ditampilkan lagi karena server hanya menyimpan hash-nya. Panel yang menetap sampai ditutup
  memberi waktu yang cukup, dan tombol salin bekerja jauh lebih andal daripada meminta operator
  menyalin lima belas karakter dari layar.

  Setelah ditutup, kode tidak dapat ditampilkan kembali, dan panel kedua menjelaskan bahwa
  jalan satu-satunya adalah merotasi kode baru.
*/
export function OncePanel({
  title,
  description,
  code,
  codeLabel,
  qrPayload,
  warning,
  onClose,
  className,
}: {
  title: string;
  description: string;
  code: string;
  codeLabel: string;
  qrPayload?: string;
  warning?: string;
  onClose: () => void;
  className?: string;
}) {
  return (
    <section
      /* Wilayah ini muncul tanpa dipicu pengguna, jadi diberi peran status agar pembaca layar
         mengumumkannya alih-alih melewatkannya. */
      role="status"
      aria-label={title}
      className={cn(
        "border-warning/40 bg-warning-surface/60 flex flex-col gap-3 rounded-xl border p-4",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-muted-foreground text-[13px] leading-relaxed">{description}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={`Tutup ${title}`}>
          <XIcon aria-hidden className="size-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
        <span className="text-muted-foreground text-[13px]">{codeLabel}</span>
        {/* Teks kode dipilih otomatis saat diklik, supaya bisa disalin tanpa menyeret mouse. */}
        <code className="tabular text-lg font-semibold tracking-[0.15em] select-all break-all">
          {code}
        </code>
        {qrPayload ? (
          <span className="text-muted-foreground text-[12px]">
            Isi kode QR pada label: <span className="tabular break-all">{qrPayload}</span>
          </span>
        ) : null}
      </div>

      {warning ? (
        <p className="text-warning text-[13px] leading-relaxed font-medium">{warning}</p>
      ) : null}
    </section>
  );
}

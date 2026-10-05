import { cn } from "@/lib/utils";

/*
  Kartu angka ringkasan.

  Aturannya: kalau angkanya belum diketahui, katakan belum diketahui. Jangan menampilkan nol
  sebagai pengganti, karena nol adalah nilai yang sah dan berbeda artinya. Karena itu `value`
  menerima null, dan null dirender sebagai teks abu-abu, bukan sebagai angka.

  `hint` dipakai untuk menyebut satuan atau pembanding yang membuat angka itu bisa ditafsirkan,
  misalnya "dari 40 perangkat terdaftar" atau "batas 2 per jam".
*/
export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
  className,
}: {
  label: string;
  /** Angka yang sudah diformat, atau null kalau belum diketahui. */
  value: string | null;
  hint?: string;
  tone?: "neutral" | "warning" | "danger" | "success";
  className?: string;
}) {
  const toneClass = {
    neutral: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  }[tone];

  return (
    <div className={cn("bg-card flex flex-col gap-1 rounded-xl border border-border p-4", className)}>
      <span className="text-muted-foreground text-[13px]">{label}</span>
      {value === null ? (
        <span className="text-muted-foreground text-2xl font-semibold tracking-tight">
          Belum diketahui
        </span>
      ) : (
        <span className={cn("tabular text-2xl font-semibold tracking-tight", toneClass)}>
          {value}
        </span>
      )}
      {hint ? <span className="text-muted-foreground text-[13px] leading-snug">{hint}</span> : null}
    </div>
  );
}

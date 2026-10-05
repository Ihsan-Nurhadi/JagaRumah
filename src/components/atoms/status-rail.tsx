import { cn } from "@/lib/utils";

/*
  Nada semantik dipakai bersama oleh rail, lencana, dan teks status.
  Warnanya selalu berpasangan dengan teks, tidak pernah berdiri sendiri.
*/
export type Tone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

const railTone: Record<Tone, string> = {
  neutral: "bg-input",
  accent: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

/*
  Rail status adalah penanda identitas panel ini: tepi vertikal yang membawa
  keadaan baris, bukan hiasan. Karena maknanya sudah dibawa teks di sebelahnya,
  elemen ini disembunyikan dari pembaca layar.
*/
export function StatusRail({
  tone,
  className,
}: {
  tone: Tone;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={cn("block w-[3px] shrink-0 self-stretch", railTone[tone], className)}
    />
  );
}

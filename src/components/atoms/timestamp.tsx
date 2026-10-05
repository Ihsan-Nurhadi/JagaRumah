import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/*
  Waktu kosong ditampilkan sebagai teks, bukan tanda hubung,
  supaya artinya jelas tanpa perlu dijelaskan di tempat lain.
*/
export function Timestamp({
  value,
  fallback = "Belum ada",
  className,
}: {
  value: string | null | undefined;
  fallback?: string;
  className?: string;
}) {
  const formatted = formatDateTime(value);

  if (!value || !formatted) {
    return <span className={cn("text-muted-foreground", className)}>{fallback}</span>;
  }

  return (
    <time dateTime={value} className={cn("tabular whitespace-nowrap", className)}>
      {formatted}
    </time>
  );
}

import { formatRupiah } from "@/lib/format";
import { cn } from "@/lib/utils";

/*
  Nilai uang selalu memakai angka tabular supaya kolom nominal sejajar
  dan mudah dibandingkan antar baris.
*/
export function Money({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  return (
    <span className={cn("tabular whitespace-nowrap", className)}>
      {formatRupiah(value)}
    </span>
  );
}

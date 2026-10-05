import { cn } from "@/lib/utils";

/*
  UUID dan nomor seri panjang dipotong secara visual, tetapi nilai utuhnya
  tetap ada di atribut title supaya bisa diperiksa tanpa membuka detail.
*/
export function Identifier({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <span
      title={value}
      className={cn("tabular text-muted-foreground block max-w-[18ch] truncate", className)}
    >
      {value}
    </span>
  );
}

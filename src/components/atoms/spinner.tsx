import { CircleNotchIcon } from "@phosphor-icons/react/dist/ssr";
import { cn } from "@/lib/utils";

/*
  Indikator memuat wajib disertai teks di pemanggilnya, karena spinner
  tanpa keterangan tidak memberi tahu apa yang sedang dimuat.
*/
export function Spinner({
  className,
  label = "Memuat",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <CircleNotchIcon
      aria-hidden="true"
      weight="bold"
      className={cn("size-4 shrink-0 animate-spin motion-reduce:animate-none", className)}
      data-label={label}
    />
  );
}

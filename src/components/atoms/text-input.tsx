import { Input as ShadcnInput } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/*
  Tinggi 44px di layar sentuh memenuhi ukuran target sentuh minimum,
  dan kembali 36px di layar besar supaya tabel tetap padat.
*/
export function TextInput({
  className,
  ...props
}: React.ComponentProps<typeof ShadcnInput>) {
  return (
    <ShadcnInput
      className={cn("rounded-md h-11 px-3 sm:h-9", className)}
      {...props}
    />
  );
}

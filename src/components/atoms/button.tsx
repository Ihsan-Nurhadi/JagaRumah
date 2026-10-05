"use client";

import { Button as ShadcnButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
  Ukuran tombol dibatasi dua saja supaya hierarki tetap terbaca: aksi biasa
  dan aksi ikon. Tinggi 44px di layar sentuh, 36px di layar besar.
*/
type ButtonProps = Omit<React.ComponentProps<typeof ShadcnButton>, "size"> & {
  size?: "default" | "icon";
};

export function Button({ className, size = "default", ...props }: ButtonProps) {
  return (
    <ShadcnButton
      size={size === "icon" ? "icon" : "default"}
      className={cn(
        "rounded-md font-medium",
        size === "icon"
          ? "size-11 sm:size-9"
          : "h-11 px-4 sm:h-9 sm:px-3.5",
        className,
      )}
      {...props}
    />
  );
}

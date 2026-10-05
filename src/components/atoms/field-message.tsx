import { WarningCircleIcon } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

/*
  Pesan galat disampaikan sebagai teks, bukan hanya warna merah,
  dan diberi ikon supaya tetap terbaca tanpa membedakan warna.
*/
export function FieldMessage({
  children,
  tone = "hint",
  id,
  className,
}: {
  children: React.ReactNode;
  tone?: "hint" | "error";
  id?: string;
  className?: string;
}) {
  if (tone === "error") {
    return (
      <p
        id={id}
        role="alert"
        className={cn("text-danger flex items-start gap-1.5 text-[13px]", className)}
      >
        <WarningCircleIcon aria-hidden="true" weight="fill" className="mt-px size-3.5 shrink-0" />
        <span>{children}</span>
      </p>
    );
  }

  return (
    <p id={id} className={cn("text-muted-foreground text-[13px]", className)}>
      {children}
    </p>
  );
}

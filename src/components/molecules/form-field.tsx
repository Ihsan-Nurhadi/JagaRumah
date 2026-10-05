"use client";

import { useId } from "react";

import { FieldMessage, RequiredMark } from "@/components/atoms";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/*
  FieldShell menyusun label, kontrol, dan pesan, sekaligus menyambungkan
  atribut ARIA supaya pesan galat benar-benar terbaca pembaca layar.
  Id dibagikan lewat render prop agar kontrol dan pesan tidak pernah lepas.
*/
type FieldShellProps = {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: (props: {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
  }) => React.ReactNode;
};

export function FieldShell({
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id} className="text-[13px] font-medium">
        {label}
        {required ? <RequiredMark /> : null}
      </Label>

      {children({ id, describedBy, invalid: Boolean(error) })}

      {hint ? <FieldMessage id={hintId}>{hint}</FieldMessage> : null}
      {error ? (
        <FieldMessage id={errorId} tone="error">
          {error}
        </FieldMessage>
      ) : null}
    </div>
  );
}

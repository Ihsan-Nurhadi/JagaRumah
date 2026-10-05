"use client";

import { useId, useState } from "react";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react/dist/ssr";
import {
  Controller,
  type Control,
  type FieldValues,
  type Path,
} from "react-hook-form";

import { FieldMessage, TextArea, TextInput } from "@/components/atoms";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { FieldShell } from "./form-field";

/*
  Field yang sudah tersambung react-hook-form.
  Semuanya memakai FieldShell supaya label, hint, galat, dan atribut ARIA
  konsisten di seluruh aplikasi.
*/

type BaseFieldProps<T extends FieldValues> = {
  control: Control<T>;
  name: Path<T>;
  label: string;
  hint?: string;
  required?: boolean;
  className?: string;
};

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  hint,
  required,
  className,
  ...input
}: BaseFieldProps<T> & {
  placeholder?: string;
  type?: string;
  autoComplete?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const isPassword = input.type === "password";

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldShell
          label={label}
          hint={hint}
          required={required}
          error={fieldState.error?.message}
          className={className}
        >
          {({ id, describedBy, invalid }) => (
            <div className="relative">
              <TextInput
                {...input}
                type={isPassword && passwordVisible ? "text" : input.type}
                id={id}
                name={field.name}
                value={field.value ?? ""}
                onChange={field.onChange}
                onBlur={field.onBlur}
                ref={field.ref}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className={isPassword ? "pr-12" : undefined}
              />
              {isPassword ? (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
                  onClick={() => setPasswordVisible((visible) => !visible)}
                  aria-label={passwordVisible ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"}
                  aria-pressed={passwordVisible}
                >
                  {passwordVisible ? (
                    <EyeSlashIcon aria-hidden weight="regular" className="size-5" />
                  ) : (
                    <EyeIcon aria-hidden weight="regular" className="size-5" />
                  )}
                </button>
              ) : null}
            </div>
          )}
        </FieldShell>
      )}
    />
  );
}

/*
  Kotak teks panjang. Dipisahkan dari TextField karena alasan dan catatan perlu ruang lebih
  dari satu baris, dan memaksa operator menulis alasan panjang di kolom satu baris membuat
  isinya tidak terbaca saat ditinjau ulang.
*/
export function TextAreaField<T extends FieldValues>({
  control,
  name,
  label,
  hint,
  required,
  className,
  placeholder,
  rows,
}: BaseFieldProps<T> & { placeholder?: string; rows?: number }) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldShell
          label={label}
          hint={hint}
          required={required}
          error={fieldState.error?.message}
          className={className}
        >
          {({ id, describedBy, invalid }) => (
            <TextArea
              id={id}
              name={field.name}
              value={field.value ?? ""}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={field.ref}
              placeholder={placeholder}
              rows={rows}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FieldShell>
      )}
    />
  );
}

export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  hint,
  required,
  className,
  placeholder,
  options,
}: BaseFieldProps<T> & {
  placeholder: string;
  options: { value: string; label: string }[];
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldShell
          label={label}
          hint={hint}
          required={required}
          error={fieldState.error?.message}
          className={className}
        >
          {({ id, describedBy, invalid }) => (
            <Select value={field.value ?? ""} onValueChange={field.onChange}>
              <SelectTrigger
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className="rounded-md data-[size=default]:h-11 w-full sm:data-[size=default]:h-9"
              >
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FieldShell>
      )}
    />
  );
}

/*
  Kotak centang memakai tata letak mendatar, jadi tidak memakai FieldShell.
  Seluruh baris label bisa diklik, sehingga target sentuhnya cukup besar.
*/
export function CheckboxField<T extends FieldValues>({
  control,
  name,
  label,
  hint,
  className,
}: BaseFieldProps<T>) {
  const id = useId();

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <div className={cn("flex flex-col gap-1.5", className)}>
          <div className="flex items-start gap-2.5">
            <Checkbox
              id={id}
              checked={Boolean(field.value)}
              onCheckedChange={field.onChange}
              aria-describedby={hint ? `${id}-hint` : undefined}
              aria-invalid={Boolean(fieldState.error)}
              className="mt-0.5 size-5"
            />
            <Label htmlFor={id} className="py-1 text-sm leading-snug font-normal">
              {label}
            </Label>
          </div>
          {hint ? <FieldMessage id={`${id}-hint`}>{hint}</FieldMessage> : null}
          {fieldState.error?.message ? (
            <FieldMessage tone="error">{fieldState.error.message}</FieldMessage>
          ) : null}
        </div>
      )}
    />
  );
}

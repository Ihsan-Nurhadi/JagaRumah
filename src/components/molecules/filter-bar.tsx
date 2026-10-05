"use client";

import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";

import { Button, TextInput } from "@/components/atoms";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/*
  Penanda pilihan "semua".

  Radix Select menolak item bernilai string kosong, karena string kosong dipakainya untuk
  menandai "belum ada pilihan". Jadi pilihan "semua" diberi penanda sendiri, lalu diterjemahkan
  kembali menjadi undefined sebelum dikirim ke server.
*/
const ANY = "__semua__";

/*
  Baris filter di atas tabel.

  Nilainya dikirim ke server, bukan disaring di klien. Alasannya: daftar ini berpaginasi, dan
  menyaring di klien hanya akan menyaring halaman yang sedang terbuka. Operator akan melihat
  hasil yang tampak benar padahal ada kecocokan di halaman berikutnya yang tidak muncul.

  Pencarian dikirim saat tombol ditekan atau Enter ditekan, bukan pada setiap ketikan. Setiap
  ketikan berarti satu permintaan ke server, dan daftar perangkat bisa berisi puluhan ribu baris.
*/
export type FilterOption = { value: string; label: string };

export type FilterDefinition =
  | {
      kind: "search";
      key: string;
      label: string;
      placeholder: string;
    }
  | {
      kind: "select";
      key: string;
      label: string;
      options: FilterOption[];
      /** Label untuk pilihan kosong, misalnya "Semua status". */
      anyLabel: string;
    }
  | {
      /**
       * Rentang tanggal. Nilainya dikirim apa adanya dalam bentuk YYYY-MM-DD, dan penerjemahan
       * ke batas hari dilakukan pemanggil, karena batas hari itu mengikuti zona waktu pengguna,
       * bukan zona waktu server.
       */
      kind: "date";
      key: string;
      label: string;
    };

export function FilterBar({
  filters,
  values,
  onChange,
  onReset,
  className,
}: {
  filters: FilterDefinition[];
  values: Record<string, string | undefined>;
  onChange: (next: Record<string, string | undefined>) => void;
  onReset: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const filter of filters) {
      if (filter.kind === "search") initial[filter.key] = values[filter.key] ?? "";
    }
    return initial;
  });

  const submitSearch = useCallback(
    (key: string) => {
      onChange({ ...values, [key]: draft[key]?.trim() || undefined });
    },
    [draft, onChange, values],
  );

  const hasActiveFilter = filters.some((filter) => Boolean(values[filter.key]));

  /*
    Pembersihan ikut mengosongkan kotak pencarian. Tanpa ini, teks pencarian lama tetap terlihat
    di layar padahal daftarnya sudah tidak disaring lagi, dan kotak itu berbohong tentang isi
    tabel di bawahnya.
  */
  const reset = useCallback(() => {
    const empty: Record<string, string> = {};
    for (const filter of filters) {
      if (filter.kind === "search") empty[filter.key] = "";
    }
    setDraft(empty);
    onReset();
  }, [filters, onReset]);

  return (
    <form
      /* Form, bukan div, supaya tombol Enter di kolom pencarian bekerja tanpa JavaScript
         tambahan dan supaya pembaca layar mengumumkan jumlah kolom filter dengan benar. */
      role="search"
      aria-label="Filter daftar"
      onSubmit={(event) => {
        event.preventDefault();
        const firstSearch = filters.find((filter) => filter.kind === "search");
        if (firstSearch) submitSearch(firstSearch.key);
      }}
      className={cn(
        /* flex-wrap supaya baris filter yang panjang turun ke baris berikutnya, bukan meluber
           ke samping pada layar yang sempit. */
        "bg-card flex flex-col gap-3 rounded-xl border border-border p-4 lg:flex-row lg:flex-wrap lg:items-end",
        className,
      )}
    >
      {filters.map((filter) => {
        if (filter.kind === "search") {
          return (
            <div key={filter.key} className="flex flex-1 flex-col gap-1.5 lg:min-w-64">
              <label htmlFor={`filter-${filter.key}`} className="text-[13px] font-medium">
                {filter.label}
              </label>
              <div className="flex gap-2">
                <TextInput
                  id={`filter-${filter.key}`}
                  value={draft[filter.key] ?? ""}
                  placeholder={filter.placeholder}
                  onChange={(event) =>
                    setDraft((previous) => ({ ...previous, [filter.key]: event.target.value }))
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    submitSearch(filter.key);
                  }}
                />
                <Button type="submit" variant="secondary">
                  <MagnifyingGlassIcon aria-hidden className="size-4" />
                  Cari
                </Button>
              </div>
            </div>
          );
        }

        if (filter.kind === "date") {
          return (
            <div key={filter.key} className="flex flex-col gap-1.5 lg:w-48">
              <label htmlFor={`filter-${filter.key}`} className="text-[13px] font-medium">
                {filter.label}
              </label>
              <TextInput
                id={`filter-${filter.key}`}
                type="date"
                value={values[filter.key] ?? ""}
                onChange={(event) =>
                  onChange({ ...values, [filter.key]: event.target.value || undefined })
                }
              />
            </div>
          );
        }

        return (
          <div key={filter.key} className="flex flex-col gap-1.5 lg:w-56">
            <label htmlFor={`filter-${filter.key}`} className="text-[13px] font-medium">
              {filter.label}
            </label>
            <Select
              value={values[filter.key] ?? ANY}
              onValueChange={(next) =>
                onChange({ ...values, [filter.key]: next === ANY ? undefined : next })
              }
            >
              <SelectTrigger
                id={`filter-${filter.key}`}
                className="rounded-md data-[size=default]:h-11 w-full sm:data-[size=default]:h-9"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{filter.anyLabel}</SelectItem>
                {filter.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}

      {hasActiveFilter ? (
        <Button type="button" variant="ghost" onClick={reset} className="lg:mb-0.5">
          <XIcon aria-hidden className="size-4" />
          Bersihkan filter
        </Button>
      ) : null}
    </form>
  );
}

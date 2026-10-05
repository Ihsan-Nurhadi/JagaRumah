"use client";

import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";

import { FieldMessage, TextInput } from "@/components/atoms";
import { cn } from "@/lib/utils";

/*
  Pemilih pelanggan.

  Dibuat sebagai pencarian, bukan daftar gulir berisi semua pelanggan, karena jumlah pelanggan
  akan bertambah terus dan daftar panjang membuat pemilih ini makin sulit dipakai justru saat
  paling dibutuhkan.

  Perilaku yang disengaja:

  - Pencarian baru dijalankan setelah dua huruf. Satu huruf mencocokkan terlalu banyak nama,
    dan hasilnya lebih banyak salah daripada berguna.
  - Pilihan yang sudah diambil ditampilkan sebagai baris terpilih, bukan dibiarkan sebagai teks
    di dalam kolom pencarian. Kalau hasil pencarian menimpa tampilannya, operator bisa lupa
    pelanggan mana yang sedang terpilih.
  - Keadaan kosong membedakan "belum mencari" dan "tidak ketemu", karena yang pertama berarti
    operator perlu mengetik dan yang kedua berarti pelanggannya memang tidak ada.
*/

export type CustomerChoice = {
  id: string;
  full_name: string;
  email: string | null;
  plan_name: string | null;
  device_count: number;
};

type Options = { customers: CustomerChoice[]; minimum_query_length?: number };

export function CustomerPicker({
  value,
  onChange,
  label,
  hint,
  error,
}: {
  value: CustomerChoice | null;
  onChange: (customer: CustomerChoice | null) => void;
  label: string;
  hint?: string;
  error?: string;
}) {
  const [search, setSearch] = useState("");

  /*
    Hasil disimpan bersama kata kunci yang menghasilkannya, supaya keadaan "sedang mencari"
    dapat disimpulkan alih-alih disetel di dalam efek. Menyetel keadaan di dalam efek memicu
    render berantai, dan pada kolom pencarian itu terasa sebagai kedipan setiap kali mengetik.
  */
  const [result, setResult] = useState<{
    term: string;
    customers: CustomerChoice[];
    error: string | null;
  } | null>(null);

  const term = search.trim();
  const tooShort = term.length < 2;

  const inputId = useId();
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  /*
    Permintaan yang sudah digantikan tidak boleh menimpa hasil yang lebih baru. Ini terjadi saat
    operator mengetik cepat: respons untuk "bu" bisa tiba setelah respons untuk "budi", dan
    hasilnya adalah daftar yang tidak cocok dengan apa yang tertulis di kolom.
  */
  const requestRef = useRef(0);

  useEffect(() => {
    if (tooShort) return;

    const requestId = ++requestRef.current;
    const controller = new AbortController();

    /*
      Penundaan singkat sebelum memanggil server. Tanpa ini, mengetik "budi" mengirim empat
      permintaan berurutan, dan tiga di antaranya langsung tidak terpakai.
    */
    const timer = setTimeout(async () => {
      let next: { term: string; customers: CustomerChoice[]; error: string | null };

      try {
        const response = await fetch(
          `/api/v1/admin/customer-options?q=${encodeURIComponent(term)}`,
          { credentials: "same-origin", signal: controller.signal },
        );
        const body = (await response.json().catch(() => null)) as
          | { data?: Options; error?: { message: string } }
          | null;

        if (!response.ok || body?.error) {
          next = {
            term,
            customers: [],
            error: body?.error?.message ?? "Pencarian pelanggan gagal dijalankan.",
          };
        } else {
          next = { term, customers: body?.data?.customers ?? [], error: null };
        }
      } catch {
        if (controller.signal.aborted) return;
        next = {
          term,
          customers: [],
          error: "Pencarian pelanggan gagal dijalankan. Periksa sambungan lalu coba lagi.",
        };
      }

      if (requestId === requestRef.current) setResult(next);
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, tooShort]);

  /*
    Keadaan tampilan disimpulkan dari kata kunci yang sedang diketik, bukan disimpan. Selama
    hasil yang ada belum berasal dari kata kunci terakhir, tampilannya adalah sedang mencari.
  */
  const fresh = result && result.term === term ? result : null;
  const state: "diam" | "memuat" | "siap" | "galat" = tooShort
    ? "diam"
    : !fresh
      ? "memuat"
      : fresh.error
        ? "galat"
        : "siap";
  const results = fresh?.customers ?? [];
  const errorMessage = fresh?.error ?? null;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[13px] font-medium">
        {label}
      </label>

      {value ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-muted/40 px-3 py-2.5">
          <div className="flex flex-col">
            <span className="text-[14px] font-medium">{value.full_name}</span>
            <span className="text-muted-foreground text-[12px]">
              {value.email ?? "Tanpa email"}
              {value.plan_name ? `, paket ${value.plan_name}` : ""}
              {`, ${value.device_count} perangkat terpasang`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setSearch("");
            }}
            className="text-muted-foreground rounded-sm text-[13px] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Ganti
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <MagnifyingGlassIcon
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <TextInput
              id={inputId}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Ketik nama, email, atau nomor WhatsApp pelanggan"
              className="pl-9"
              aria-invalid={Boolean(error)}
              aria-describedby={describedBy}
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls={`${inputId}-list`}
              autoComplete="off"
            />
          </div>

          <div
            id={`${inputId}-list`}
            role="listbox"
            aria-label="Hasil pencarian pelanggan"
            className="flex flex-col gap-0.5"
          >
            {state === "memuat" ? (
              <p className="text-muted-foreground px-1 py-2 text-[13px]">Mencari pelanggan...</p>
            ) : null}

            {state === "galat" ? (
              <FieldMessage tone="error">{errorMessage}</FieldMessage>
            ) : null}

            {state === "diam" ? (
              <p className="text-muted-foreground px-1 py-2 text-[13px]">
                Ketik minimal dua huruf untuk mulai mencari.
              </p>
            ) : null}

            {state === "siap" && results.length === 0 ? (
              <p className="text-muted-foreground px-1 py-2 text-[13px]">
                Tidak ada pelanggan aktif yang cocok. Periksa ejaan namanya, atau pastikan akun
                pelanggan tidak sedang ditangguhkan.
              </p>
            ) : null}

            {results.map((customer) => (
              <button
                key={customer.id}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => onChange(customer)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left",
                  "hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                )}
              >
                <span className="flex flex-col">
                  <span className="text-[14px]">{customer.full_name}</span>
                  <span className="text-muted-foreground text-[12px]">
                    {customer.email ?? "Tanpa email"}
                    {customer.plan_name ? `, paket ${customer.plan_name}` : ""}
                    {`, ${customer.device_count} perangkat terpasang`}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {error ? (
        <FieldMessage id={`${inputId}-error`} tone="error">
          {error}
        </FieldMessage>
      ) : hint ? (
        <FieldMessage id={`${inputId}-hint`}>{hint}</FieldMessage>
      ) : null}
    </div>
  );
}

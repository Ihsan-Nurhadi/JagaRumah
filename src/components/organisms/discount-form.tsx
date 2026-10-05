"use client";

import { useMemo } from "react";
import { useWatch, type Control, type FieldValues, type Path } from "react-hook-form";
import { z } from "zod";

import { Button, FieldMessage, Spinner } from "@/components/atoms";
import {
  CheckboxField,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/molecules";
import { cn } from "@/lib/utils";

/*
  Bahan formulir yang dipakai bersama voucher dan flash sale.

  Dua jenis potongan ini hampir sama di layar: jenis potongan, besar potongan, cakupan, jendela
  waktu. Yang berbeda hanya objeknya (kode atau paket). Menyalin bagian yang sama ke dua formulir
  berarti setiap perbaikan harus dikerjakan dua kali, dan cepat atau lambat salah satunya
  tertinggal.

  Isi berkas ini seluruhnya bahan formulir: daftar pilihan, aturan validasi, bidang yang tersambung
  react-hook-form, dan dua pemilih. Tidak ada pemanggilan server di sini.
*/

/* ------------------------------------------------------------------------------------------------
  Daftar pilihan.
------------------------------------------------------------------------------------------------ */

export const DISCOUNT_TYPES = ["percent", "fixed"] as const;
export const DISCOUNT_SCOPES = ["all_prices", "selected_prices"] as const;

export type DiscountType = (typeof DISCOUNT_TYPES)[number];
export type DiscountScope = (typeof DISCOUNT_SCOPES)[number];

export const DISCOUNT_TYPE_LABELS: Record<DiscountType, string> = {
  percent: "Persentase (%)",
  fixed: "Nominal tetap (Rp)",
};

export const DISCOUNT_SCOPE_LABELS: Record<DiscountScope, string> = {
  all_prices: "Semua harga paket",
  selected_prices: "Harga tertentu saja",
};

/*
  Keadaan dari server dipetakan ke nada lencana yang sudah ada.

  "Menunggu waktu" diberi nada info, bukan warning: promo yang belum mulai adalah keadaan normal
  hasil penjadwalan. Yang benar-benar menuntut perhatian adalah kuota habis, dan itu ditandai
  terpisah di kolomnya sendiri.
*/
export const STATE_TONES: Record<string, "success" | "info" | "neutral" | "warning"> = {
  running: "success",
  scheduled: "info",
  ended: "neutral",
  inactive: "warning",
};

export function stateTone(state: string): "success" | "info" | "neutral" | "warning" {
  return STATE_TONES[state] ?? "neutral";
}

/* ------------------------------------------------------------------------------------------------
  Nilai formulir.
------------------------------------------------------------------------------------------------ */

/*
  Seluruh kolom angka berbentuk teks.

  Formulir mengirim apa yang benar-benar diketik operator, dan teks itulah yang diteruskan ke
  database. Mengubahnya menjadi angka di formulir berarti menjalankan nominal rupiah lewat pecahan
  biner, yang dapat menggeser nilainya setelah dibulatkan.
*/
export type DiscountFormValues = {
  /* Hanya dipakai formulir voucher saat membuat; kode tidak dapat diubah setelah dibuat. */
  code: string;
  name: string;
  description: string;
  discount_type: DiscountType;
  percent_value: string;
  fixed_amount: string;
  scope: DiscountScope;
  min_amount: string;
  /* Kuota total dalam bentuk teks; kosong berarti tanpa batas. Hanya dipakai voucher. */
  max_redemptions: string;
  starts_at_input: string;
  ends_at_input: string;
  is_active: boolean;
};

export const emptyDiscountForm: DiscountFormValues = {
  code: "",
  name: "",
  description: "",
  discount_type: "percent",
  percent_value: "",
  fixed_amount: "",
  scope: "all_prices",
  min_amount: "",
  max_redemptions: "",
  starts_at_input: "",
  ends_at_input: "",
  is_active: true,
};

const angkaBulat = (label: string, maks: number) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d+$/.test(value), {
      message: `${label} harus berupa angka bulat tanpa pemisah ribuan.`,
    })
    .refine((value) => value === "" || Number(value) <= maks, {
      message: `${label} maksimal ${maks}.`,
    });

/*
  Aturan silang potongan.

  Ditulis di sini supaya formulir menolak kombinasi yang sama dengan yang ditolak server, dan
  pesannya jatuh di kolom yang benar. Server tetap memeriksa ulang; yang ini hanya membuat operator
  tidak menemukan galat baru setelah menekan simpan.
*/
function periksaPotongan(value: DiscountFormValues): { field: string; message: string } | null {
  if (value.discount_type === "percent") {
    if (value.percent_value.trim() === "") {
      return { field: "percent_value", message: "Besar persentase wajib diisi." };
    }
    const persen = Number(value.percent_value);
    if (!Number.isInteger(persen) || persen < 1 || persen > 100) {
      return {
        field: "percent_value",
        message: "Persentase harus berupa angka bulat antara 1 dan 100.",
      };
    }
    return null;
  }

  if (value.fixed_amount.trim() === "") {
    return { field: "fixed_amount", message: "Nominal potongan wajib diisi." };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(value.fixed_amount.trim())) {
    return {
      field: "fixed_amount",
      message: "Nominal potongan harus berupa angka rupiah tanpa pemisah ribuan.",
    };
  }
  if (Number(value.fixed_amount) <= 0) {
    return { field: "fixed_amount", message: "Nominal potongan harus lebih besar dari nol." };
  }
  return null;
}

/*
  Skema dibangun dari pilihan, bukan ditulis dua kali.

  Dua formulir hanya berbeda pada satu hal: flash sale wajib punya nama, voucher tidak (nama
  voucher defaultnya kode itu sendiri). Perbedaan itu masuk sebagai argumen dan sisanya sama.
*/
/*
  Kode voucher hanya perlu ada saat membuat. Saat menyunting, kode tidak dapat diubah, jadi kolomnya
  tidak pernah ditampilkan dan tidak pernah ikut dikirim.
*/
export function discountFormSchema(options: { requireName: boolean; requireCode: boolean }) {
  return z
    .object({
      code: z
        .string()
        .trim()
        .refine((value) => value === "" || /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(value), {
          message:
            "Kode harus 3 sampai 32 karakter, diawali huruf atau angka, dan hanya boleh berisi " +
            "huruf, angka, garis bawah, serta tanda hubung.",
        }),
      name: z.string(),
      description: z.string(),
      discount_type: z.enum(DISCOUNT_TYPES),
      percent_value: z.string(),
      fixed_amount: z.string(),
      scope: z.enum(DISCOUNT_SCOPES),
      min_amount: angkaBulat("Minimal belanja", 999_999_999_999),
      max_redemptions: angkaBulat("Kuota total", 1_000_000),
      starts_at_input: z.string(),
      ends_at_input: z.string(),
      is_active: z.boolean(),
    })
    .superRefine((value, ctx) => {
      const potongan = periksaPotongan(value);
      if (potongan) {
        ctx.addIssue({ code: "custom", path: [potongan.field], message: potongan.message });
      }

      /*
        Potongan tetap yang lebih besar daripada syarat minimalnya berarti voucher memotong sampai
        nol pada belanja sekecil apa pun. Kombinasi itu hampir selalu salah isi, jadi ditolak di
        sini alih-alih menghasilkan promo gratis yang tidak disengaja.
      */
      if (value.min_amount.trim() !== "" && value.discount_type === "fixed") {
        const minimal = Number(value.min_amount);
        const potongan = Number(value.fixed_amount);
        if (Number.isFinite(minimal) && Number.isFinite(potongan) && potongan >= minimal) {
          ctx.addIssue({
            code: "custom",
            path: ["min_amount"],
            message:
              "Minimal belanja harus lebih besar daripada potongan tetapnya, kalau tidak " +
              "potongannya menghabiskan seluruh harga pada belanja sekecil apa pun.",
          });
        }
      }

      if (value.starts_at_input.trim() !== "" && value.ends_at_input.trim() !== "") {
        const mulai = Date.parse(value.starts_at_input);
        const selesai = Date.parse(value.ends_at_input);
        if (!Number.isNaN(mulai) && !Number.isNaN(selesai) && selesai <= mulai) {
          ctx.addIssue({
            code: "custom",
            path: ["ends_at_input"],
            message: "Waktu berakhir harus setelah waktu mulai.",
          });
        }
      }

      if (options.requireName && value.name.trim() === "") {
        ctx.addIssue({ code: "custom", path: ["name"], message: "Nama flash sale wajib diisi." });
      }

      /*
        Kode wajib saat voucher baru dibuat. Tanpa kode, voucher tidak dapat dipakai siapa pun,
        karena kode itulah satu-satunya cara pelanggan mengenalinya.
      */
      if (options.requireCode && value.code.trim() === "") {
        ctx.addIssue({ code: "custom", path: ["code"], message: "Kode voucher wajib diisi." });
      }
    });
}

/*
  Susunan badan permintaan.

  `includeName` dan `includeMinAmount` yang membedakan voucher dari flash sale: endpoint voucher
  menerima `min_amount` dan namanya wajib, endpoint flash sale menerima nama dan tidak menerima
  `min_amount` sama sekali. Field yang tidak dikenal akan ditolak skema server, jadi field yang
  tidak dipakai memang tidak dikirim.
*/
export function discountBody(
  values: DiscountFormValues,
  options: {
    priceIds: string[];
    includeName?: boolean;
    includeCode?: boolean;
    includeMinAmount?: boolean;
    includeMaxRedemptions?: boolean;
  },
) {
  const body: Record<string, unknown> = {
    discount_type: values.discount_type,
    percent_value: values.discount_type === "percent" ? Number(values.percent_value) : null,
    fixed_amount: values.discount_type === "fixed" ? values.fixed_amount.trim() : null,
    scope: values.scope,
    /* Cakupan semua harga wajib mengirim daftar kosong; trigger database menolak sisanya. */
    price_ids: values.scope === "selected_prices" ? options.priceIds : [],
    starts_at_input: values.starts_at_input.trim() === "" ? null : values.starts_at_input.trim(),
    ends_at_input: values.ends_at_input.trim() === "" ? null : values.ends_at_input.trim(),
    is_active: values.is_active,
    description: values.description.trim() === "" ? null : values.description.trim(),
  };

  if (options.includeCode) {
    /* Kode dinormalkan huruf besar; skema server melakukan hal yang sama. */
    body.code = values.code.trim().toUpperCase();
  }
  if (options.includeName) {
    body.name = values.name.trim() === "" ? null : values.name.trim();
  }
  if (options.includeMinAmount) {
    body.min_amount = values.min_amount.trim() === "" ? null : values.min_amount.trim();
  }
  if (options.includeMaxRedemptions) {
    body.max_redemptions =
      values.max_redemptions.trim() === "" ? null : Number(values.max_redemptions);
  }

  return body;
}

/* ------------------------------------------------------------------------------------------------
  Menerjemahkan bentuk server menjadi bentuk formulir.
------------------------------------------------------------------------------------------------ */

/*
  Waktu dari server berbentuk ISO UTC, sedangkan kolom datetime-local menuntut waktu setempat tanpa
  keterangan zona. ISO yang ditempel apa adanya akan ditolak kolomnya sebagai nilai tidak sah, dan
  promo yang dibuka untuk disunting tampak kehilangan jendela waktunya.

  Per geseran zona peramban dipakai, bukan UTC: operator melihat jam yang sama dengan jam di
  dindingnya, dan jam itu yang dikirim kembali dan dibaca server sebagai waktu Jakarta.
*/
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const tanggal = new Date(iso);
  if (Number.isNaN(tanggal.getTime())) return "";
  const geser = tanggal.getTimezoneOffset() * 60_000;
  return new Date(tanggal.getTime() - geser).toISOString().slice(0, 16);
}

/* Nilai dari database berbentuk "50000.00"; kotak isian menampilkan "50000". */
export function amountForInput(value: string | null | undefined): string {
  if (!value) return "";
  const angka = Number(value);
  if (!Number.isFinite(angka)) return value;
  return Number.isInteger(angka) ? String(angka) : angka.toFixed(2);
}

export type DiscountSource = {
  name: string;
  description: string | null;
  discount_type: DiscountType;
  percent_value: number | null;
  fixed_amount: string | null;
  scope: DiscountScope;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
};

/*
  Nilai awal formulir dari baris yang tersimpan.

  `code` selalu dikosongkan meskipun sumbernya punya kode: kolom kode tidak pernah ditampilkan saat
  menyunting, dan mengisinya hanya akan mengirim kode lama yang memang tidak boleh berubah.
*/
export function seedFrom(
  source: DiscountSource,
  extras: { minAmount?: string | null; maxRedemptions?: number | null } = {},
): DiscountFormValues {
  return {
    code: "",
    name: source.name,
    description: source.description ?? "",
    discount_type: source.discount_type,
    percent_value: source.percent_value === null ? "" : String(source.percent_value),
    fixed_amount: amountForInput(source.fixed_amount),
    scope: source.scope,
    min_amount: amountForInput(extras.minAmount),
    max_redemptions:
      extras.maxRedemptions === null || extras.maxRedemptions === undefined
        ? ""
        : String(extras.maxRedemptions),
    starts_at_input: toLocalInput(source.starts_at),
    ends_at_input: toLocalInput(source.ends_at),
    is_active: source.is_active,
  };
}

/* ------------------------------------------------------------------------------------------------
  Bidang yang tersambung react-hook-form.
------------------------------------------------------------------------------------------------ */

/*
  Seluruh bidang potongan bersama.

  Nilai potongan yang ditampilkan mengikuti `discount_type` yang sedang dipilih, dan jenis itu
  dibaca lewat `useWatch` — bukan disimpan sebagai state terpisah. State terpisah berarti dua
  sumber kebenaran untuk satu nilai, dan keduanya pasti berbeda begitu formulir memuat nilai awal
  dari server. Kolom yang tidak dipakai tidak ditampilkan sama sekali, sehingga tidak ada angka
  sisa dari jenis sebelumnya yang ikut terkirim.
*/
export function DiscountFields<T extends FieldValues>({
  control,
  codeLabel,
  codeHint,
  nameLabel,
  nameHint,
  namePlaceholder,
  nameRequired,
  maxRedemptionsHint,
}: {
  control: Control<T>;
  /** Bila diisi, kolom kode ditampilkan. Kosongkan saat menyunting, karena kode tidak dapat berubah. */
  codeLabel?: string;
  codeHint?: string;
  nameLabel: string;
  nameHint?: string;
  namePlaceholder?: string;
  nameRequired?: boolean;
  /** Bila diisi, kolom kuota total ditampilkan. Hanya voucher yang punya kuota. */
  maxRedemptionsHint?: string;
}) {
  const jenis = useWatch({ control, name: "discount_type" as Path<T> }) as DiscountType;

  return (
    <>
      {codeLabel ? (
        <TextField<T>
          control={control}
          name={"code" as Path<T>}
          label={codeLabel}
          placeholder="Contoh: NAYAKA10"
          hint={codeHint}
          autoComplete="off"
          required
        />
      ) : null}

      <TextField<T>
        control={control}
        name={"name" as Path<T>}
        label={nameLabel}
        placeholder={namePlaceholder}
        hint={nameHint}
        required={nameRequired}
      />

      <SelectField<T>
        control={control}
        name={"discount_type" as Path<T>}
        label="Jenis potongan"
        placeholder="Pilih jenis potongan"
        options={DISCOUNT_TYPES.map((value) => ({
          value,
          label: DISCOUNT_TYPE_LABELS[value],
        }))}
        required
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {jenis === "fixed" ? (
          <TextField<T>
            control={control}
            name={"fixed_amount" as Path<T>}
            label="Nominal potongan (Rp)"
            inputMode="numeric"
            placeholder="Contoh: 20000"
            hint="Tanpa titik pemisah ribuan dan tanpa tanda mata uang."
            required
          />
        ) : (
          <TextField<T>
            control={control}
            name={"percent_value" as Path<T>}
            label="Besar potongan (%)"
            inputMode="numeric"
            placeholder="Contoh: 10"
            hint="Angka bulat antara 1 dan 100."
            required
          />
        )}

        <TextField<T>
          control={control}
          name={"min_amount" as Path<T>}
          label="Minimal belanja"
          inputMode="numeric"
          placeholder="Kosongkan bila tidak ada syarat"
          hint="Potongan baru berlaku bila harga sebelum potongan mencapai angka ini."
        />
      </div>

      {maxRedemptionsHint ? (
        <TextField<T>
          control={control}
          name={"max_redemptions" as Path<T>}
          label="Kuota total"
          inputMode="numeric"
          placeholder="Kosongkan untuk tanpa batas"
          hint={maxRedemptionsHint}
        />
      ) : null}

      <SelectField<T>
        control={control}
        name={"scope" as Path<T>}
        label="Cakupan"
        placeholder="Pilih cakupan"
        options={DISCOUNT_SCOPES.map((value) => ({
          value,
          label: DISCOUNT_SCOPE_LABELS[value],
        }))}
        hint="Cakupan menentukan harga mana yang benar-benar dipotong, bukan sekadar siapa yang boleh memakainya."
        required
      />

      <TextAreaField<T>
        control={control}
        name={"description" as Path<T>}
        label="Keterangan"
        placeholder="Catatan singkat untuk admin lain, misalnya alasan promo diadakan"
        rows={3}
      />

      <CheckboxField<T>
        control={control}
        name={"is_active" as Path<T>}
        label="Potongan aktif"
        hint="Yang dimatikan tetap tersimpan dan tetap terlihat di daftar, tetapi tidak lagi dihitung saat harga ditagih."
      />
    </>
  );
}

/*
  Jendela waktu.

  Satu perbedaan yang disengaja antara voucher dan flash sale, dan alasannya ditulis di layar
  supaya tidak terlihat seperti syarat yang dikarang sistem: voucher baru berguna saat pelanggan
  mengetik kodenya, jadi ia boleh berlaku tanpa batas akhir. Flash sale justru sebaliknya.
*/
export function WindowFields<T extends FieldValues>({
  control,
  requireWindow,
}: {
  control: Control<T>;
  requireWindow: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField<T>
        control={control}
        name={"starts_at_input" as Path<T>}
        type="datetime-local"
        label="Mulai berlaku"
        required={requireWindow}
        hint={
          requireWindow
            ? "Wajib, dan dibaca sebagai waktu Jakarta."
            : "Kosongkan bila kode boleh dipakai sejak dibuat."
        }
      />
      <TextField<T>
        control={control}
        name={"ends_at_input" as Path<T>}
        type="datetime-local"
        label="Berakhir"
        required={requireWindow}
        hint={
          requireWindow
            ? "Wajib. Potongan tanpa batas akhir berubah menjadi harga normal yang tidak pernah berakhir."
            : "Kosongkan bila kode tidak kedaluwarsa."
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
  Pemilih harga dan paket.
------------------------------------------------------------------------------------------------ */

export type PriceChoice = {
  id: string;
  plan_id: string;
  plan_name: string;
  plan_is_active: boolean;
  billing_interval_label: string;
  amount: string;
  is_active: boolean;
};

export type PlanChoice = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  is_free: boolean;
  price_count: number;
};

/*
  Pemilih harga untuk cakupan "harga tertentu saja".

  Daftarnya dikelompokkan per paket, karena pertanyaan yang sebenarnya ditanyakan operator bukan
  "harga mana" melainkan "paket mana, interval mana". Daftar rata berisi puluhan baris dengan nama
  paket berulang membuat paket yang berbeda sulit dibedakan.

  Harga dan paket yang tidak aktif tetap ditampilkan. Menyembunyikannya akan membuat promo yang
  menempel padanya hilang dari layar, padahal promo yang menempel pada paket tidak aktif justru
  keadaan yang paling perlu terlihat.
*/
export function PricePicker({
  prices,
  selected,
  onChange,
  limitToPlanIds,
  error,
  hint,
}: {
  prices: PriceChoice[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Bila diisi, hanya harga milik paket-paket ini yang dapat dipilih. */
  limitToPlanIds?: string[];
  error?: string;
  hint?: string;
}) {
  const terlihat = useMemo(
    () => (limitToPlanIds ? prices.filter((price) => limitToPlanIds.includes(price.plan_id)) : prices),
    [prices, limitToPlanIds],
  );

  const perPaket = useMemo(() => {
    const peta = new Map<string, { nama: string; aktif: boolean; harga: PriceChoice[] }>();
    for (const price of terlihat) {
      const isi = peta.get(price.plan_id) ?? {
        nama: price.plan_name,
        aktif: price.plan_is_active,
        harga: [],
      };
      isi.harga.push(price);
      peta.set(price.plan_id, isi);
    }
    return [...peta.entries()];
  }, [terlihat]);

  if (terlihat.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Harga yang dipotong</span>
        <p className="text-muted-foreground text-[13px]">
          {limitToPlanIds
            ? "Paket yang dipilih belum punya harga sama sekali. Isi harganya dulu di halaman Paket dan harga, karena potongan hanya dapat menempel pada harga yang sudah ada."
            : "Belum ada harga paket yang dapat dipilih. Isi dulu harga pada halaman Paket dan harga."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium">Harga yang dipotong</span>
      <p className="text-muted-foreground text-[13px] leading-snug">
        {hint ?? "Potongan hanya berlaku pada harga yang dicentang. Harga lain tetap ditagih penuh."}
      </p>

      <div className="border-border flex max-h-72 flex-col gap-3 overflow-y-auto rounded-md border p-3">
        {perPaket.map(([planId, isi]) => (
          <fieldset key={planId} className="flex flex-col gap-0.5">
            <legend className="text-[13px] font-medium">
              {isi.nama}
              {isi.aktif ? null : (
                <span className="text-muted-foreground font-normal"> · paket tidak aktif</span>
              )}
            </legend>

            {isi.harga.map((price) => (
              <label
                key={price.id}
                htmlFor={`harga-${price.id}`}
                className={cn(
                  "hover:bg-accent focus-within:bg-accent flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5",
                )}
              >
                <span className="flex items-center gap-2.5">
                  <input
                    id={`harga-${price.id}`}
                    type="checkbox"
                    checked={selected.includes(price.id)}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...selected, price.id]
                          : selected.filter((id) => id !== price.id),
                      )
                    }
                    className="accent-primary size-4"
                  />
                  <span className="flex flex-col">
                    <span className="text-[13px]">{price.billing_interval_label}</span>
                    <span className="text-muted-foreground text-[12px]">
                      {price.plan_name}
                      {price.is_active ? "" : " · harga tidak aktif"}
                    </span>
                  </span>
                </span>
                <span className="tabular text-[13px]">{formatNominal(price.amount)}</span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>

      {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
    </div>
  );
}

/*
  Pemilih paket untuk flash sale.

  Berbeda dari pemilih harga, pilihannya di sini adalah paket. Cakupan harga pada flash sale bekerja
  di dalam paket yang dipilih, jadi paket ditentukan lebih dulu dan harga hanya relevan setelahnya.
  Tombol "pilih semua" ada karena permintaan "semua paket kena flash sale" memang wajar.
*/
export function PlanPicker({
  plans,
  selected,
  onChange,
  error,
}: {
  plans: PlanChoice[];
  selected: string[];
  onChange: (next: string[]) => void;
  error?: string;
}) {
  if (plans.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Paket yang kena flash sale</span>
        <p className="text-muted-foreground text-[13px]">
          Belum ada paket yang dapat dipilih. Buat paket terlebih dahulu di halaman Paket dan harga.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium">Paket yang kena flash sale</span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange(plans.map((plan) => plan.id))}
          >
            Pilih semua paket
          </Button>
          <Button type="button" variant="ghost" onClick={() => onChange([])}>
            Kosongkan pilihan
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground text-[13px] leading-snug">
        Boleh satu paket saja atau semuanya. Setiap paket disimpan sebagai barisnya sendiri, karena
        aturan bentrok jadwal bekerja per paket.
      </p>

      <div className="border-border flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-md border p-3">
        {plans.map((plan) => (
          <label
            key={plan.id}
            htmlFor={`paket-${plan.id}`}
            className="hover:bg-accent focus-within:bg-accent flex cursor-pointer items-start gap-2.5 rounded-sm px-2 py-1.5"
          >
            <input
              id={`paket-${plan.id}`}
              type="checkbox"
              checked={selected.includes(plan.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, plan.id]
                    : selected.filter((id) => id !== plan.id),
                )
              }
              className="accent-primary mt-0.5 size-4"
            />
            <span className="flex flex-col">
              <span className="text-[13px]">
                {plan.name}
                {plan.is_free ? " · paket gratis" : ""}
              </span>
              <span className="tabular text-muted-foreground text-[12px]">
                {plan.code} · {plan.price_count} harga
                {plan.is_active ? "" : " · paket tidak aktif"}
              </span>
            </span>
          </label>
        ))}
      </div>

      {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
  Kalimat ringkas untuk tabel.
------------------------------------------------------------------------------------------------ */

export function formatNominal(value: string | number | null): string {
  const angka = value === null ? Number.NaN : typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(angka)) return "Belum ada";
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(angka);
}

export function discountText(potongan: {
  discount_type: DiscountType;
  percent_value: number | null;
  fixed_amount: string | number | null;
}): string {
  if (potongan.discount_type === "percent") return `${potongan.percent_value ?? 0}%`;
  return formatNominal(potongan.fixed_amount);
}

export function windowText(mulai: string | null, selesai: string | null): string {
  const format = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat("id-ID", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Asia/Jakarta",
        }).format(new Date(iso))
      : null;

  const dari = format(mulai);
  const sampai = format(selesai);

  if (!dari && !sampai) return "Tanpa batas waktu";
  if (!dari) return `Sampai ${sampai}`;
  if (!sampai) return `Sejak ${dari}, tanpa batas akhir`;
  return `${dari} — ${sampai}`;
}

/* Dipakai formulir untuk menampilkan tombol simpan yang seragam. */
export function DialogActions({
  onClose,
  isSubmitting,
  submitLabel,
}: {
  onClose: () => void;
  isSubmitting: boolean;
  submitLabel: string;
}) {
  return (
    <>
      <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
        Batal
      </Button>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? <Spinner label="Menyimpan" /> : null}
        {submitLabel}
      </Button>
    </>
  );
}

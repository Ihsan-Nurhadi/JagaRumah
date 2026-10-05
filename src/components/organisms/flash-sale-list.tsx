"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Button, Timestamp } from "@/components/atoms";
import {
  DataTable,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  StatCard,
  StatusBadge,
  type Column,
  type FilterDefinition,
} from "@/components/molecules";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirmAction, notifyError, notifySuccess } from "@/lib/alert";
import { formatNumber } from "@/lib/format";
import { toErrorMessage } from "@/lib/http";
import { mutate, tableStatus, useApiQuery, usePagedQuery } from "@/lib/use-api";
import { useSessionStore } from "@/stores/session-store";

import {
  DialogActions,
  DiscountFields,
  PlanPicker,
  PricePicker,
  WindowFields,
  discountBody,
  discountFormSchema,
  discountText,
  emptyDiscountForm,
  seedFrom,
  stateTone,
  windowText,
  type DiscountFormValues,
  type DiscountScope,
  type DiscountType,
  type PlanChoice,
  type PriceChoice,
} from "./discount-form";

/*
  Flash sale paket.

  Halaman ini menjawab pertanyaan yang muncul saat diskon berjendela waktu disiapkan:

  1. Paket mana yang sedang didiskon, dan sampai kapan?
  2. Potongannya berapa, dan berlaku untuk semua harga paket atau hanya sebagian?

  Satu hal yang harus terlihat dari tabel, bukan dari dokumen: satu baris di sini adalah satu paket.
  Permintaan "semua paket kena flash sale" menghasilkan beberapa baris, satu per paket, karena
  aturan bentrok jadwal di database bekerja per paket. Kolom paket karena itu ditulis pertama.
*/

type FlashSale = {
  id: string;
  plan_id: string;
  plan_name: string;
  name: string;
  description: string | null;
  discount_type: DiscountType;
  percent_value: number | null;
  fixed_amount: string | null;
  currency: string;
  scope: DiscountScope;
  starts_at: string;
  ends_at: string;
  is_active: boolean;
  state: string;
  state_label: string;
  price_count: number;
  created_at: string;
  updated_at: string;
};

type FlashSalesResponse = {
  flash_sales: FlashSale[];
  summary: {
    total: number;
    running: number;
    scheduled: number;
    ended: number;
    inactive: number;
    selected_prices: number;
    plan_count: number;
  };
};

type FlashSaleDetail = {
  flash_sale: FlashSale;
  prices: { id: string; plan_name: string; billing_interval: string; amount: string }[];
};

type Options = {
  prices: PriceChoice[];
  plans: PlanChoice[];
};

export function FlashSaleList() {
  const query = usePagedQuery<FlashSalesResponse>("/api/v1/admin/flash-sales");
  const options = usePagedQuery<Options>("/api/v1/admin/discount-options");

  const permissions = useSessionStore((state) => state.permissions);
  const isSuperAdmin = useSessionStore((state) => state.admin?.is_super_admin ?? false);
  const canManage = isSuperAdmin || permissions.includes("discount.manage");

  const [form, setForm] = useState<{ flashSale: FlashSale | null } | null>(null);

  const rows = query.data?.flash_sales ?? [];
  const summary = query.data?.summary;

  const filters: FilterDefinition[] = [
    { kind: "search", key: "q", label: "Cari flash sale", placeholder: "Nama flash sale" },
    {
      kind: "select",
      key: "state",
      label: "Keadaan",
      anyLabel: "Semua keadaan",
      options: [
        { value: "running", label: "Berjalan" },
        { value: "scheduled", label: "Menunggu waktu" },
        { value: "ended", label: "Kedaluwarsa" },
        { value: "inactive", label: "Dimatikan" },
      ],
    },
    {
      kind: "select",
      key: "scope",
      label: "Cakupan",
      anyLabel: "Semua cakupan",
      options: [
        { value: "all_prices", label: "Semua harga paket" },
        { value: "selected_prices", label: "Harga tertentu saja" },
      ],
    },
  ];

  const columns: Column<FlashSale>[] = [
    {
      key: "plan",
      header: "Paket",
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{row.plan_name}</span>
          <span className="text-muted-foreground text-[12px]">{row.name}</span>
        </div>
      ),
    },
    {
      key: "discount",
      header: "Potongan",
      cell: (row) => <span className="tabular">{discountText(row)}</span>,
    },
    {
      key: "scope",
      header: "Cakupan",
      cell: (row) =>
        row.scope === "all_prices" ? (
          <span className="text-[13px]">Semua harga paket</span>
        ) : (
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px]">Harga tertentu</span>
            <span className="text-muted-foreground text-[12px]">
              {formatNumber(row.price_count)} harga dipilih
            </span>
          </div>
        ),
    },
    {
      key: "window",
      header: "Berlaku",
      cell: (row) => <span className="text-[13px]">{windowText(row.starts_at, row.ends_at)}</span>,
    },
    {
      key: "state",
      header: "Keadaan",
      cell: (row) => <StatusBadge tone={stateTone(row.state)}>{row.state_label}</StatusBadge>,
    },
    {
      key: "created_at",
      header: "Dibuat",
      cell: (row) => <Timestamp value={row.created_at} />,
    },
  ];

  if (canManage) {
    columns.push({
      key: "actions",
      header: "Tindakan",
      cell: (row) => (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setForm({ flashSale: row })}>
            Ubah
          </Button>
          {row.is_active ? (
            <Button variant="ghost" onClick={() => void nonaktifkan(row, query.reload)}>
              Hentikan
            </Button>
          ) : null}
        </div>
      ),
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Flash sale paket"
        description="Potongan yang berlaku sendiri selama jendela waktunya terbuka, tanpa kode yang perlu diketik. Boleh satu paket saja atau semuanya sekaligus."
        actions={
          canManage ? (
            <Button onClick={() => setForm({ flashSale: null })} disabled={options.status !== "siap"}>
              <PlusIcon aria-hidden className="size-4" />
              Tambah flash sale
            </Button>
          ) : null
        }
      />

      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Sedang berjalan"
            value={summary ? formatNumber(summary.running) : null}
            hint="Baris yang jendela waktunya sudah terbuka dan belum ditutup"
          />
          <StatCard
            label="Menunggu waktu"
            value={summary ? formatNumber(summary.scheduled) : null}
            hint="Sudah dijadwalkan, belum mulai"
          />
          <StatCard
            label="Paket terdampak"
            value={summary ? formatNumber(summary.plan_count) : null}
            hint={`Dari ${formatNumber(summary?.total ?? 0)} baris flash sale yang pernah dibuat`}
          />
          <StatCard
            label="Cakupan harga tertentu"
            value={summary ? formatNumber(summary.selected_prices) : null}
            hint="Baris yang hanya memotong sebagian harga paketnya, bukan seluruhnya"
          />
        </div>
      )}

      <FilterBar
        filters={filters}
        values={{
          q: query.params.q as string | undefined,
          state: query.params.state as string | undefined,
          scope: query.params.scope as string | undefined,
        }}
        onChange={(next) => query.setParams(next)}
        onReset={() => query.setParams({})}
      />

      <DataTable
        label="Daftar flash sale"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat daftar flash sale"
        errorTitle="Daftar flash sale gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        emptyState={
          query.params.q || query.params.state || query.params.scope ? (
            <EmptyState
              title="Tidak ada flash sale yang cocok"
              description="Tidak ada flash sale yang sesuai dengan filter yang dipasang. Pencarian memakai nama flash sale. Bersihkan filter untuk melihat seluruhnya."
            />
          ) : (
            <EmptyState
              title="Belum ada flash sale"
              description="Belum ada potongan berjendela waktu yang disiapkan. Tambahkan flash sale pertama, lalu pilih paket yang kena dan rentang waktunya."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        hasMore={query.hasMore}
        unit="baris"
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />

      <section className="bg-card flex flex-col gap-2 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Yang perlu diketahui tentang flash sale</h2>
        <ul className="text-muted-foreground flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-relaxed">
          <li>
            Satu baris di tabel ini terikat pada satu paket. Memilih beberapa paket sekaligus
            menghasilkan beberapa baris, dan semuanya dibuat dalam satu langkah supaya tidak ada
            paket yang tertinggal terdiskon setengah jalan.
          </li>
          <li>
            Jendela waktunya wajib lengkap. Potongan tanpa batas akhir berubah menjadi harga normal
            yang tidak pernah berakhir, dan itu kesalahan termahal di halaman ini.
          </li>
          <li>
            Dua flash sale pada paket yang sama tidak boleh berjendela bertabrakan. Aturan itu
            ditegakkan database, dan pesannya menyebut nama flash sale yang bentrok.
          </li>
          <li>
            Paket tidak dapat dipindahkan setelah barisnya dibuat. Baris baru saja yang bisa, karena
            mengubah paket berarti mengubah arti aturan bentrok jadwalnya.
          </li>
          <li>
            Potongan tidak menumpuk dengan voucher. Kalau keduanya berlaku pada harga yang sama, yang
            dipakai adalah yang paling menguntungkan pelanggan.
          </li>
        </ul>
      </section>

      {form ? (
        <FlashSaleDialog
          flashSale={form.flashSale}
          options={options.data ?? { prices: [], plans: [] }}
          onClose={() => setForm(null)}
          onDone={() => {
            setForm(null);
            query.reload();
            options.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/*
  Menghentikan flash sale.

  Dikonfirmasi lebih dulu karena akibatnya langsung terasa: harga kembali normal untuk semua
  pelanggan yang sedang membayar. Kalimatnya menyebut paketnya, supaya tidak ada keraguan baris
  mana yang sedang dihentikan.
*/
async function nonaktifkan(flashSale: FlashSale, onDone: () => void) {
  const setuju = await confirmAction({
    title: `Hentikan flash sale paket ${flashSale.plan_name}?`,
    text:
      `Harga paket ${flashSale.plan_name} kembali normal sejak saat dihentikan. Barisnya tetap ` +
      `tersimpan lengkap dengan jendela waktunya, karena potongan yang sudah berjalan pernah ` +
      `memotong harga yang tercatat pada tagihan pelanggan.`,
    confirmLabel: "Hentikan flash sale",
    destructive: true,
  });
  if (!setuju) return;

  try {
    await mutate(`/api/v1/admin/flash-sales/${flashSale.id}`, { method: "DELETE" });
    notifySuccess(
      "Flash sale dihentikan",
      `Harga paket ${flashSale.plan_name} kembali normal.`,
    );
    onDone();
  } catch (error) {
    notifyError("Flash sale gagal dihentikan", toErrorMessage(error));
  }
}

/*
  Formulir flash sale.

  Saat menambah, paket boleh lebih dari satu. Saat mengubah, paketnya ditampilkan sebagai keterangan
  dan tidak dapat dipindahkan: baris flash sale terikat pada satu paket, dan memindahkannya berarti
  mengubah arti aturan bentrok jadwal yang sudah diperiksa terhadap paket lamanya.

  Menambah dan mengubah dipecah menjadi dua komponen, bukan satu komponen dengan percabangan di
  dalamnya: mode mengubah perlu membaca daftar harga yang tersimpan dari server, sedangkan mode
  menambah tidak.
*/
function FlashSaleDialog({
  flashSale,
  options,
  onClose,
  onDone,
}: {
  flashSale: FlashSale | null;
  options: Options;
  onClose: () => void;
  onDone: () => void;
}) {
  if (!flashSale) {
    return (
      <FormShell
        title="Tambah flash sale"
        description="Satu baris flash sale terikat pada satu paket. Memilih beberapa paket sekaligus menghasilkan beberapa baris dalam satu langkah."
        onClose={onClose}
      >
        <FlashSaleCreateForm options={options} onClose={onClose} onDone={onDone} />
      </FormShell>
    );
  }

  return (
    <FlashSaleEditDialog flashSale={flashSale} options={options} onClose={onClose} onDone={onDone} />
  );
}

/*
  Mode menambah.

  Dipisahkan dari mode mengubah karena tidak ada detail yang perlu dibaca: baris yang belum ada belum
  punya daftar harga tersimpan, jadi pilihan harganya dimulai dari kosong.
*/
function FlashSaleCreateForm({
  options,
  onClose,
  onDone,
}: {
  options: Options;
  onClose: () => void;
  onDone: () => void;
}) {
  const [planIds, setPlanIds] = useState<string[]>([]);
  const [priceIds, setPriceIds] = useState<string[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  return (
    <FlashSaleForm
      flashSale={null}
      options={options}
      planIds={planIds}
      setPlanIds={(next) => {
        setPlanIds(next);
        setPlanError(null);
        /*
          Paket yang dibatalkan pilihannya tidak boleh meninggalkan harga terpilihnya: cakupan
          harga pada flash sale hanya berlaku di dalam paket yang dipilih, jadi sisa harga dari
          paket yang sudah dilepas akan membuat server menolak permintaannya.
        */
        setPriceIds((sebelumnya) =>
          sebelumnya.filter((id) =>
            options.prices.some((price) => price.id === id && next.includes(price.plan_id)),
          ),
        );
      }}
      planError={planError}
      setPlanError={setPlanError}
      priceIds={priceIds}
      setPriceIds={(next) => {
        setPriceIds(next);
        setPriceError(null);
      }}
      priceError={priceError}
      setPriceError={setPriceError}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/*
  Mode mengubah, dipisahkan supaya pembacaan detailnya hanya berjalan saat memang ada yang dibaca.

  Daftar harga yang tersimpan dibaca dari endpoint detail, bukan dari baris tabel, karena baris tabel
  hanya memuat jumlahnya.
*/
function FlashSaleEditDialog({
  flashSale,
  options,
  onClose,
  onDone,
}: {
  flashSale: FlashSale;
  options: Options;
  onClose: () => void;
  onDone: () => void;
}) {
  const detail = useApiQuery<FlashSaleDetail>(`/api/v1/admin/flash-sales/${flashSale.id}`);

  return (
    <FormShell
      title={`Ubah flash sale paket ${flashSale.plan_name}`}
      description="Paket tidak dapat dipindahkan setelah barisnya dibuat. Perubahan lain langsung berlaku saat disimpan."
      onClose={onClose}
    >
      {detail.status === "siap" ? (
        <FlashSaleEditForm
          flashSale={flashSale}
          options={options}
          initialPriceIds={detail.data?.prices.map((price) => price.id) ?? []}
          onClose={onClose}
          onDone={onDone}
        />
      ) : (
        <p className="text-muted-foreground py-6 text-[13px]" role="status">
          {detail.status === "galat"
            ? `Harga yang sedang dipilih flash sale ini gagal dimuat${detail.error ? `: ${detail.error}` : ""}. Tutup lalu buka lagi untuk mencoba.`
            : "Memuat harga yang sedang dipilih flash sale ini."}
        </p>
      )}
    </FormShell>
  );
}

function FlashSaleEditForm({
  flashSale,
  options,
  initialPriceIds,
  onClose,
  onDone,
}: {
  flashSale: FlashSale;
  options: Options;
  initialPriceIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [priceIds, setPriceIds] = useState(initialPriceIds);
  const [priceError, setPriceError] = useState<string | null>(null);

  return (
    <FlashSaleForm
      flashSale={flashSale}
      options={options}
      planIds={[flashSale.plan_id]}
      setPlanIds={() => undefined}
      planError={null}
      setPlanError={() => undefined}
      priceIds={priceIds}
      setPriceIds={(next) => {
        setPriceIds(next);
        setPriceError(null);
      }}
      priceError={priceError}
      setPriceError={setPriceError}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/*
  Kerangka dialog yang sama untuk kedua mode, supaya judul dan ukurannya tidak berbeda diam-diam.

  Klik di luar dialog dicegah karena formulir diskon bisa berisi belasan kolom. Tombol Batal,
  tombol silang, dan Escape tetap menutup dialog melalui kontrol Radix.
*/
function FormShell({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description: string;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function FlashSaleForm({
  flashSale,
  options,
  planIds,
  setPlanIds,
  planError,
  setPlanError,
  priceIds,
  setPriceIds,
  priceError,
  setPriceError,
  onClose,
  onDone,
}: {
  flashSale: FlashSale | null;
  options: Options;
  planIds: string[];
  setPlanIds: (next: string[]) => void;
  planError: string | null;
  setPlanError: (next: string | null) => void;
  priceIds: string[];
  setPriceIds: (next: string[]) => void;
  priceError: string | null;
  setPriceError: (next: string | null) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const awal: DiscountFormValues = flashSale ? seedFrom(flashSale) : emptyDiscountForm;

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DiscountFormValues>({
    resolver: zodResolver(discountFormSchema({ requireName: true, requireCode: false })),
    defaultValues: awal,
  });

  const scope = useWatch({ control, name: "scope" });

  async function submit(values: DiscountFormValues) {
    if (!flashSale && planIds.length === 0) {
      setPlanError("Pilih minimal satu paket yang kena flash sale.");
      return;
    }
    if (values.scope === "selected_prices" && priceIds.length === 0) {
      setPriceError("Pilih minimal satu harga paket untuk cakupan ini.");
      return;
    }

    const body = discountBody(values, {
      priceIds,
      includeName: true,
      includeMinAmount: false,
    });

    try {
      if (flashSale) {
        await mutate(`/api/v1/admin/flash-sales/${flashSale.id}`, { method: "PATCH", body });
        notifySuccess(
          "Flash sale diperbarui",
          `Perubahan pada paket ${flashSale.plan_name} sudah disimpan dan langsung dipakai saat harga ditagih.`,
        );
      } else {
        await mutate("/api/v1/admin/flash-sales", {
          method: "POST",
          body: { ...body, plan_ids: planIds },
        });
        notifySuccess(
          "Flash sale ditambahkan",
          planIds.length === 1
            ? "Flash sale untuk satu paket sudah dibuat dan berlaku sesuai jendela waktunya."
            : `Flash sale untuk ${formatNumber(planIds.length)} paket sudah dibuat, satu baris per paket.`,
        );
      }
      onDone();
    } catch (error) {
      const message = toErrorMessage(error);
      setError("root", { message });
      notifyError(
        flashSale ? "Flash sale gagal diperbarui" : "Flash sale gagal ditambahkan",
        message,
      );
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          {flashSale ? (
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Paket</span>
              <span className="text-[13px]">{flashSale.plan_name}</span>
              <p className="text-muted-foreground text-[13px]">
                Paket tidak dapat dipindahkan setelah barisnya dibuat. Aturan bentrok jadwal sudah
                diperiksa terhadap paket ini, dan memindahkannya akan membuat pemeriksaan itu tidak lagi
                berlaku.
              </p>
            </div>
          ) : (
            <PlanPicker
              plans={options.plans}
              selected={planIds}
              onChange={setPlanIds}
              error={planError ?? undefined}
            />
          )}

          <DiscountFields
            control={control}
            nameLabel="Nama flash sale"
            namePlaceholder="Contoh: Flash sale September"
            nameHint="Nama ini yang muncul di daftar dan di pesan bentrok jadwal, jadi pakai nama yang membedakannya dari flash sale lain."
            nameRequired
          />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <WindowFields control={control} requireWindow />

          {scope === "selected_prices" ? (
            <PricePicker
              prices={options.prices}
              selected={priceIds}
              onChange={setPriceIds}
              limitToPlanIds={flashSale ? [flashSale.plan_id] : planIds}
              hint="Hanya harga milik paket yang dipilih di atas yang dapat dicentang. Harga paket lain akan melanggar arti cakupannya."
              error={priceError ?? undefined}
            />
          ) : null}
        </div>
      </div>

      {errors.root?.message ? (
        <p className="text-danger text-[13px]" role="alert">
          {errors.root.message}
        </p>
      ) : null}

      <DialogFooter>
        <DialogActions
          onClose={onClose}
          isSubmitting={isSubmitting}
          submitLabel={flashSale ? "Simpan perubahan" : "Tambah flash sale"}
        />
      </DialogFooter>
    </form>
  );
}

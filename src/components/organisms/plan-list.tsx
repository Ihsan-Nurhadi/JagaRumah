"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, Money, Spinner } from "@/components/atoms";
import {
  CheckboxField,
  Column,
  DataTable,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  SelectField,
  StatCard,
  StatusBadge,
  TextAreaField,
  TextField,
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
import { notifyError, notifySuccess } from "@/lib/alert";
import { formatNumber } from "@/lib/format";
import { toErrorMessage } from "@/lib/http";
import {
  BILLING_INTERVALS,
  createPlanSchema,
  priceAmount,
  type CreatePlanInput,
} from "@/lib/schemas/admin-plan";
import { mutate, tableStatus, usePagedQuery } from "@/lib/use-api";
import { useSessionStore } from "@/stores/session-store";

/*
  Paket dan harga.

  Halaman ini menjawab pertanyaan yang muncul berurutan saat paket disiapkan:

  1. Paket apa saja yang ada, dan mana yang masih ditawarkan?
  2. Berapa batas perangkat dan berapa harganya?
  3. Paket mana yang belum punya harga aktif? Paket seperti itu ada di daftar tetapi belum dapat
     dipilih pelanggan, dan itu keadaan yang paling mudah terlewat.

  Nominal paket berbayar dan batas perangkat paket Gratis adalah keputusan pemilik produk yang
  belum diambil. Halaman ini karena itu menyediakan kolom isian untuk keduanya dan tidak mengisi
  nilai bawaan yang masuk akal, karena nilai bawaan yang dikarang akan tersimpan sebagai keputusan
  yang tidak pernah diambil siapa pun.
*/

type Price = {
  id: string;
  billing_interval: string;
  amount: string;
  currency: string;
  is_active: boolean;
  amount_editable: boolean;
  subscription_count: number;
  created_at: string;
  updated_at: string;
};

type Plan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  device_limit: number | null;
  device_limit_unlimited: boolean;
  is_free: boolean;
  is_active: boolean;
  sort_order: number;
  subscription_count: number;
  has_active_price: boolean;
  prices: Price[];
  created_at: string;
  updated_at: string;
};

type PlansResponse = {
  plans: Plan[];
  summary: {
    total: number;
    active: number;
    inactive: number;
    unlimited_device_limit: number;
    without_active_price: number;
    price_total: number;
    price_in_use: number;
  };
  next_sort_order: number;
};

const INTERVAL_LABELS: Record<string, string> = {
  monthly: "Bulanan",
  yearly: "Tahunan",
};

/*
  Interval yang belum punya harga pada paket ini.

  Dibatasi hanya pada interval yang kosong karena satu paket menyimpan satu harga per interval.
  Menawarkan interval yang sudah terisi hanya akan menghasilkan penolakan server, dan pilihan yang
  pasti ditolak lebih baik tidak ditampilkan.
*/
function availableIntervals(plan: Plan): string[] {
  return BILLING_INTERVALS.filter(
    (interval) => !plan.prices.some((price) => price.billing_interval === interval),
  );
}

/*
  Nominal dari database berbentuk "99000.00". Kotak isian menampilkan "99000" untuk angka bulat,
  supaya operator tidak perlu menghapus dua angka nol di belakang koma setiap kali menyunting.
*/
function amountForInput(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(2);
}

export function PlanList() {
  const query = usePagedQuery<PlansResponse>("/api/v1/admin/subscription-plans");

  /*
    Izin dibaca sebagai potongan state, bukan lewat hasPermission(), karena fungsi itu membaca
    state pada saat dipanggil sehingga komponennya tidak dirender ulang ketika daftar izin baru
    tiba. Akibatnya tombol yang seharusnya muncul tetap tersembunyi.
  */
  const permissions = useSessionStore((state) => state.permissions);
  const isSuperAdmin = useSessionStore((state) => state.admin?.is_super_admin ?? false);
  const canManage = isSuperAdmin || permissions.includes("plan.manage");

  const [planForm, setPlanForm] = useState<{ plan: Plan | null } | null>(null);
  const [priceForm, setPriceForm] = useState<{ plan: Plan; price: Price | null } | null>(null);

  const rows = query.data?.plans ?? [];
  const summary = query.data?.summary;

  const filters: FilterDefinition[] = [
    {
      kind: "search",
      key: "q",
      label: "Cari paket",
      placeholder: "Kode atau nama paket",
    },
    {
      kind: "select",
      key: "is_active",
      label: "Status paket",
      anyLabel: "Semua status",
      options: [
        { value: "true", label: "Aktif" },
        { value: "false", label: "Tidak aktif" },
      ],
    },
  ];

  const columns: Column<Plan>[] = [
    {
      key: "name",
      header: "Paket",
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{row.name}</span>
          <span className="tabular text-muted-foreground text-[12px]">{row.code}</span>
        </div>
      ),
    },
    {
      key: "device_limit",
      header: "Batas perangkat",
      cell: (row) =>
        row.device_limit_unlimited ? (
          <span className="text-muted-foreground text-[13px]">Tanpa batas</span>
        ) : (
          <span className="tabular">{formatNumber(row.device_limit ?? 0)}</span>
        ),
    },
    {
      key: "prices",
      header: "Harga",
      cell: (row) =>
        row.prices.length === 0 ? (
          <span className="text-muted-foreground text-[13px]">Belum ada harga</span>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {row.prices.map((price) => (
              <li key={price.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground text-[12px]">
                  {INTERVAL_LABELS[price.billing_interval] ?? price.billing_interval}
                </span>
                <Money value={Number(price.amount)} className="text-[13px]" />
                <StatusBadge tone={price.is_active ? "success" : "neutral"}>
                  {price.is_active ? "Aktif" : "Tidak aktif"}
                </StatusBadge>
                {canManage ? (
                  <Button variant="ghost" onClick={() => setPriceForm({ plan: row, price })}>
                    Ubah harga
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: "subscription_count",
      header: "Langganan",
      cell: (row) => <span className="tabular">{formatNumber(row.subscription_count)}</span>,
    },
    {
      key: "is_active",
      header: "Status",
      cell: (row) => (
        <StatusBadge tone={row.is_active ? "success" : "neutral"}>
          {row.is_active ? "Aktif" : "Tidak aktif"}
        </StatusBadge>
      ),
    },
  ];

  /*
    Kolom tindakan hanya ada kalau akun ini memang boleh mengubah paket. Kolom kosong berisi
    tombol yang pasti ditolak server hanya menambah lebar tabel tanpa menambah kemampuan.
  */
  if (canManage) {
    columns.push({
      key: "actions",
      header: "Tindakan",
      cell: (row) => (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setPlanForm({ plan: row })}>
            Ubah paket
          </Button>
          {availableIntervals(row).length > 0 ? (
            <Button variant="ghost" onClick={() => setPriceForm({ plan: row, price: null })}>
              Tambah harga
            </Button>
          ) : null}
        </div>
      ),
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Paket dan harga"
        description="Paket langganan yang ditawarkan, batas perangkatnya, dan harganya. Paket tanpa harga aktif tetap ada di daftar ini, karena keadaan itu perlu terlihat."
        actions={
          canManage ? (
            <Button onClick={() => setPlanForm({ plan: null })}>
              <PlusIcon aria-hidden className="size-4" />
              Tambah paket
            </Button>
          ) : null
        }
      />

      {/*
        Kartu ringkasan disembunyikan saat galat, karena menampilkan "Belum diketahui" untuk
        semuanya hanya menambah kebisingan di layar yang sudah menjelaskan masalahnya.
      */}
      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Paket aktif"
            value={summary ? formatNumber(summary.active) : null}
            hint="Paket yang ditampilkan di aplikasi pelanggan"
          />
          <StatCard
            label="Paket tanpa harga aktif"
            value={summary ? formatNumber(summary.without_active_price) : null}
            hint="Belum ada harga aktif, jadi belum ada nominal yang ditawarkan ke pelanggan"
            tone={summary && summary.without_active_price > 0 ? "warning" : "neutral"}
          />
          <StatCard
            label="Tanpa batas perangkat"
            value={summary ? formatNumber(summary.unlimited_device_limit) : null}
            hint="Paket ini tidak membatasi jumlah perangkat"
          />
          <StatCard
            label="Harga dipakai langganan"
            value={summary ? formatNumber(summary.price_in_use) : null}
            hint={`Dari ${formatNumber(summary?.price_total ?? 0)} baris harga, dan nominalnya sudah terkunci`}
          />
        </div>
      )}

      <FilterBar
        filters={filters}
        values={{
          q: query.params.q as string | undefined,
          is_active: query.params.is_active as string | undefined,
        }}
        onChange={(next) => query.setParams(next)}
        onReset={() => query.setParams({})}
      />

      <DataTable
        label="Daftar paket dan harga"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat daftar paket"
        errorTitle="Daftar paket gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        emptyState={
          query.params.q || query.params.is_active ? (
            <EmptyState
              title="Tidak ada paket yang cocok"
              description="Tidak ada paket yang sesuai dengan filter yang dipasang. Pencarian memakai kode dan nama paket. Bersihkan filter untuk melihat seluruh paket."
            />
          ) : (
            <EmptyState
              title="Belum ada paket"
              description="Daftar paket masih kosong. Tambahkan paket pertama, lalu isi harga bulanan atau tahunannya supaya paket itu punya nominal yang ditawarkan ke pelanggan."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="paket"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />

      <section className="bg-card flex flex-col gap-2 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Yang perlu diketahui sebelum mengubah harga</h2>
        <ul className="text-muted-foreground flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-relaxed">
          <li>
            Satu paket hanya menyimpan satu harga per interval, jadi paket yang sudah punya harga
            bulanan tidak dapat ditambahi harga bulanan kedua.
          </li>
          <li>
            Nominal harga yang sudah dipakai langganan tidak dapat diubah, karena angka itu yang
            tercatat pada langganan lama dan dipakai saat menagih ulang.
          </li>
          <li>
            Paket dan harga yang tidak aktif tidak ditampilkan di aplikasi pelanggan, tetapi
            keduanya tetap terlihat di halaman ini.
          </li>
          <li>
            Batas perangkat tiap paket adalah keputusan pemilik produk, bukan angka yang
            ditentukan sistem. Angka yang terisi sekarang masih dapat berubah.
          </li>
        </ul>
      </section>

      {planForm ? (
        <PlanDialog
          plan={planForm.plan}
          nextSortOrder={query.data?.next_sort_order ?? 0}
          onClose={() => setPlanForm(null)}
          onDone={() => {
            setPlanForm(null);
            query.reload();
          }}
        />
      ) : null}

      {priceForm ? (
        <PriceDialog
          plan={priceForm.plan}
          price={priceForm.price}
          onClose={() => setPriceForm(null)}
          onDone={() => {
            setPriceForm(null);
            query.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/*
  Formulir paket dipakai untuk menambah dan mengubah.

  Saat mengubah, kode paket ditampilkan sebagai keterangan dan bukan sebagai kolom isian. Kode itu
  memang tidak dapat diubah setelah dibuat, karena klien memakainya untuk mengenali paket, dan
  kolom yang tidak dapat diisi hanya menambah pertanyaan tanpa menambah kemampuan.
*/
function PlanDialog({
  plan,
  nextSortOrder,
  onClose,
  onDone,
}: {
  plan: Plan | null;
  nextSortOrder: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreatePlanInput>({
    resolver: zodResolver(createPlanSchema),
    defaultValues: plan
      ? {
          code: plan.code,
          name: plan.name,
          description: plan.description,
          device_limit: plan.device_limit,
          is_free: plan.is_free,
          is_active: plan.is_active,
          sort_order: plan.sort_order,
        }
      : {
          code: "",
          name: "",
          description: null,
          device_limit: null,
          is_free: false,
          is_active: true,
          sort_order: nextSortOrder,
        },
  });

  async function submit(values: CreatePlanInput) {
    try {
      if (plan) {
        await mutate(`/api/v1/admin/subscription-plans/${plan.id}`, {
          method: "PATCH",
          body: {
            name: values.name,
            description: values.description,
            device_limit: values.device_limit,
            is_free: values.is_free,
            is_active: values.is_active,
            sort_order: values.sort_order,
          },
        });
        notifySuccess("Paket diperbarui", `Perubahan paket ${values.name} sudah disimpan.`);
      } else {
        await mutate("/api/v1/admin/subscription-plans", { method: "POST", body: values });
        notifySuccess(
          "Paket ditambahkan",
          `Paket ${values.name} sudah dibuat. Isi harganya supaya ada nominal yang ditawarkan ke pelanggan.`,
        );
      }
      onDone();
    } catch (error) {
      const message = toErrorMessage(error);
      setError("root", { message });
      notifyError(plan ? "Paket gagal diperbarui" : "Paket gagal ditambahkan", message);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{plan ? `Ubah paket ${plan.name}` : "Tambah paket"}</DialogTitle>
          <DialogDescription>
            Batas perangkat dan urutan paket menentukan aturan yang ditegakkan server saat
            pelanggan memasang perangkat atau naik paket.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          {plan ? (
            /*
              Kode ditampilkan sebagai keterangan, bukan sebagai kolom yang dimatikan. Kolom yang
              dimatikan mengundang orang mencoba mengisinya, sedangkan kode paket memang tidak
              dapat diubah setelah dibuat karena klien memakainya untuk mengenali paket.
            */
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Kode paket</span>
              <span className="tabular text-[13px]">{plan.code}</span>
              <p className="text-muted-foreground text-[13px]">
                Kode paket tidak dapat diubah setelah dibuat.
              </p>
            </div>
          ) : (
            <TextField<CreatePlanInput>
              control={control}
              name="code"
              label="Kode paket"
              placeholder="Contoh: basic"
              hint="Huruf kecil, angka, titik, garis bawah, dan tanda hubung."
              required
            />
          )}

          <TextField<CreatePlanInput>
            control={control}
            name="name"
            label="Nama paket"
            placeholder="Contoh: Dasar"
            required
          />

          <TextAreaField<CreatePlanInput>
            control={control}
            name="description"
            label="Keterangan"
            placeholder="Penjelasan singkat isi paket ini"
            rows={3}
          />

          <TextField<CreatePlanInput>
            control={control}
            name="device_limit"
            label="Batas perangkat"
            inputMode="numeric"
            placeholder="Kosongkan untuk tanpa batas"
            hint="Kosongkan untuk tanpa batas. Isi 0 kalau paket ini tidak boleh punya perangkat sama sekali."
          />

          <TextField<CreatePlanInput>
            control={control}
            name="sort_order"
            label="Urutan paket"
            inputMode="numeric"
            hint="Paket dengan urutan lebih besar dianggap paket yang lebih tinggi saat pelanggan naik paket."
            required
          />

          <CheckboxField<CreatePlanInput>
            control={control}
            name="is_free"
            label="Paket gratis"
            hint="Laporan pendapatan memakai penanda ini untuk memisahkan langganan berbayar dari yang gratis."
          />

          <CheckboxField<CreatePlanInput>
            control={control}
            name="is_active"
            label="Tampilkan paket di aplikasi pelanggan"
            hint="Paket yang tidak aktif tetap ada di halaman ini, tetapi tidak ditawarkan ke pelanggan."
          />

          {errors.root?.message ? (
            <p className="text-danger text-[13px]" role="alert">
              {errors.root.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Menyimpan" /> : null}
              {plan ? "Simpan perubahan" : "Tambah paket"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/*
  Formulir harga.

  Dua hal yang membuat bentuknya begini:

  1. Interval tidak dapat diubah setelah barisnya dibuat, jadi pada mode ubah intervalnya
     ditampilkan sebagai keterangan, bukan sebagai pilihan yang bisa diubah.
  2. Nominal hanya dikirim saat harganya belum dipakai langganan. Untuk harga yang sudah dipakai,
     nominalnya ditampilkan sebagai keterangan dan tidak ikut dikirim, karena server menolak
     perubahan nominal pada harga yang sudah dipakai.
*/
const priceFormSchema = z.object({
  billing_interval: z.enum(BILLING_INTERVALS, { message: "Interval tagihan harus dipilih." }),
  amount: priceAmount,
  is_active: z.boolean(),
});

type PriceFormValues = z.infer<typeof priceFormSchema>;

function PriceDialog({
  plan,
  price,
  onClose,
  onDone,
}: {
  plan: Plan;
  price: Price | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const intervals = availableIntervals(plan);

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PriceFormValues>({
    resolver: zodResolver(priceFormSchema),
    defaultValues: {
      billing_interval: (price?.billing_interval ?? intervals[0] ?? "monthly") as
        | "monthly"
        | "yearly",
      amount: price ? amountForInput(price.amount) : "",
      is_active: price ? price.is_active : true,
    },
  });

  async function submit(values: PriceFormValues) {
    try {
      if (price) {
        await mutate(`/api/v1/admin/plan-prices/${price.id}`, {
          method: "PATCH",
          body: {
            is_active: values.is_active,
            /* Nominal tidak ikut dikirim untuk harga yang sudah dipakai langganan, karena server menolaknya. */
            ...(price.amount_editable ? { amount: values.amount } : {}),
          },
        });
        notifySuccess(
          "Harga diperbarui",
          `Harga ${INTERVAL_LABELS[price.billing_interval]} paket ${plan.name} sudah disimpan.`,
        );
      } else {
        await mutate("/api/v1/admin/plan-prices", {
          method: "POST",
          body: {
            plan_id: plan.id,
            billing_interval: values.billing_interval,
            amount: values.amount,
          },
        });
        notifySuccess(
          "Harga ditambahkan",
          `Harga ${INTERVAL_LABELS[values.billing_interval]} paket ${plan.name} sudah dibuat.`,
        );
      }
      onDone();
    } catch (error) {
      const message = toErrorMessage(error);
      setError("root", { message });
      notifyError(price ? "Harga gagal diperbarui" : "Harga gagal ditambahkan", message);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {price
              ? `Ubah harga ${INTERVAL_LABELS[price.billing_interval] ?? price.billing_interval}`
              : `Tambah harga paket ${plan.name}`}
          </DialogTitle>
          <DialogDescription>
            {price
              ? `Harga ini dipakai ${formatNumber(price.subscription_count)} langganan.`
              : "Satu paket menyimpan satu harga per interval, jadi pilih interval yang belum terisi."}
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          {price ? (
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Interval tagihan</span>
              <span className="text-[13px]">
                {INTERVAL_LABELS[price.billing_interval] ?? price.billing_interval}
              </span>
              <p className="text-muted-foreground text-[13px]">
                Interval tidak dapat diubah setelah harga dibuat.
              </p>
            </div>
          ) : (
            <SelectField<PriceFormValues>
              control={control}
              name="billing_interval"
              label="Interval tagihan"
              placeholder="Pilih interval"
              options={intervals.map((interval) => ({
                value: interval,
                label: INTERVAL_LABELS[interval] ?? interval,
              }))}
              required
            />
          )}

          {price && !price.amount_editable ? (
            /*
              Nominal yang sudah dipakai langganan ditampilkan sebagai keterangan, bukan sebagai
              kolom yang dimatikan, karena nilainya memang tidak dikirim dan tidak diubah. Kolom
              yang dimatikan akan terlihat seperti kolom yang rusak.
            */
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">Nominal</span>
              <Money value={Number(price.amount)} className="text-[13px]" />
              <p className="text-muted-foreground text-[13px]">
                Nominal dikunci karena harga ini sudah dipakai {formatNumber(price.subscription_count)}{" "}
                langganan. Menimpanya akan mengubah harga yang tercatat pada langganan lama.
              </p>
            </div>
          ) : (
            <TextField<PriceFormValues>
              control={control}
              name="amount"
              label="Nominal"
              inputMode="numeric"
              placeholder="Contoh: 99000"
              hint="Tanpa titik pemisah ribuan dan tanpa tanda mata uang. Nominal selalu dalam rupiah."
              required
            />
          )}

          {price ? (
            <CheckboxField<PriceFormValues>
              control={control}
              name="is_active"
              label="Harga aktif"
              hint="Harga yang tidak aktif tidak ditampilkan di aplikasi pelanggan, tetapi tetap tercatat di sini."
            />
          ) : null}

          {errors.root?.message ? (
            <p className="text-danger text-[13px]" role="alert">
              {errors.root.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Menyimpan" /> : null}
              {price ? "Simpan harga" : "Tambah harga"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

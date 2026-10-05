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
  PricePicker,
  WindowFields,
  discountBody,
  discountFormSchema,
  discountText,
  emptyDiscountForm,
  formatNominal,
  seedFrom,
  stateTone,
  windowText,
  type DiscountFormValues,
  type DiscountScope,
  type DiscountType,
  type PriceChoice,
} from "./discount-form";
import { VoucherCheckPanel } from "./voucher-check";

/*
  Kode voucher.

  Tiga pertanyaan yang dijawab halaman ini, berurutan:

  1. Kode apa saja yang ada, dan mana yang masih berlaku?
  2. Berapa kuotanya, dan berapa yang sudah terpakai?
  3. Kode ini, kalau dipakai sekarang, harganya jadi berapa?

  Pertanyaan ketiga dijawab panel uji di bawah tabel. Panel itu memakai perhitungan yang sama dengan
  yang dipakai saat menagih, jadi angkanya bukan perkiraan.

  Kolom kuota dipisahkan dari kolom keadaan karena keduanya sebab yang berbeda: kode yang kehabisan
  kuota masih di dalam jendela waktunya, sedangkan kode kedaluwarsa tidak lagi. Menyatukan keduanya
  membuat operator menebak-nebak kenapa sebuah kode berhenti bekerja.
*/

type Voucher = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  discount_type: DiscountType;
  percent_value: number | null;
  fixed_amount: string | null;
  currency: string;
  scope: DiscountScope;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  max_redemptions_per_customer: number;
  min_amount: string | null;
  applies_to: string;
  is_active: boolean;
  state: string;
  state_label: string;
  price_count: number;
  redemption_count: number;
  remaining_redemptions: number | null;
  quota_exhausted: boolean;
  created_at: string;
  updated_at: string;
};

type VouchersResponse = {
  vouchers: Voucher[];
  summary: {
    total: number;
    running: number;
    scheduled: number;
    ended: number;
    exhausted: number;
    inactive: number;
    redemptions: number;
  };
};

type VoucherDetail = {
  voucher: Voucher;
  selected_price_count: number;
  redemption_count: number;
  prices: { id: string; plan_id: string; plan_name: string; amount: string }[];
};

type Options = {
  prices: PriceChoice[];
  plans: { id: string; code: string; name: string; is_active: boolean; is_free: boolean; price_count: number }[];
};

export function VoucherList() {
  const query = usePagedQuery<VouchersResponse>("/api/v1/admin/vouchers");
  /*
    Daftar harga dibaca sekali di sini, bukan di dalam dialog.

    Dialog dibuka berulang kali, dan memuat daftar harga setiap kali akan mengirim ulang seluruh
    katalog paket hanya untuk menampilkan pemilih harga.
  */
  const options = useApiQuery<Options>("/api/v1/admin/discount-options");

  const permissions = useSessionStore((state) => state.permissions);
  const isSuperAdmin = useSessionStore((state) => state.admin?.is_super_admin ?? false);
  const canManage = isSuperAdmin || permissions.includes("discount.manage");

  const [form, setForm] = useState<{ voucher: Voucher | null } | null>(null);

  const rows = query.data?.vouchers ?? [];
  const summary = query.data?.summary;

  const filters: FilterDefinition[] = [
    { kind: "search", key: "q", label: "Cari voucher", placeholder: "Kode atau nama voucher" },
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

  const columns: Column<Voucher>[] = [
    {
      key: "code",
      header: "Kode",
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          {/* Kode ditulis apa adanya seperti yang diketik pelanggan, jadi bentuknya tidak diubah. */}
          <span className="tabular font-medium tracking-wide">{row.code}</span>
          <span className="text-muted-foreground text-[12px]">{row.name}</span>
        </div>
      ),
    },
    {
      key: "discount",
      header: "Potongan",
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <span className="tabular">{discountText(row)}</span>
          {row.min_amount ? (
            <span className="text-muted-foreground text-[12px]">
              minimal belanja {formatNominal(row.min_amount)}
            </span>
          ) : null}
        </div>
      ),
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
      key: "quota",
      header: "Kuota",
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <span className="tabular">
            {row.max_redemptions === null
              ? "Tanpa batas"
              : `${formatNumber(row.redemption_count)} dari ${formatNumber(row.max_redemptions)}`}
          </span>
          <span className="text-muted-foreground text-[12px]">
            {row.max_redemptions === null
              ? `${formatNumber(row.redemption_count)} pemakaian tercatat`
              : row.quota_exhausted
                ? "Kuota habis"
                : `sisa ${formatNumber(row.remaining_redemptions ?? 0)}`}
          </span>
        </div>
      ),
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

  /*
    Kolom tindakan hanya ada kalau akun ini memang boleh mengubah voucher. Kolom berisi tombol yang
    pasti ditolak server hanya menambah lebar tabel tanpa menambah kemampuan.
  */
  if (canManage) {
    columns.push({
      key: "actions",
      header: "Tindakan",
      cell: (row) => (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setForm({ voucher: row })}>
            Ubah
          </Button>
          {row.is_active ? (
            <Button variant="ghost" onClick={() => void nonaktifkan(row, query.reload)}>
              Matikan
            </Button>
          ) : null}
        </div>
      ),
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Kode voucher"
        description="Kode yang diketik pelanggan saat membayar. Setiap kode punya masa berlaku, kuota, dan cakupan harga sendiri, dan potongannya tidak menumpuk dengan flash sale."
        actions={
          canManage ? (
            <Button
              onClick={() => setForm({ voucher: null })}
              disabled={options.status !== "siap"}
            >
              <PlusIcon aria-hidden className="size-4" />
              Tambah voucher
            </Button>
          ) : null
        }
      />

      {/* Kartu ringkasan disembunyikan saat galat; menampilkan "Belum diketahui" untuk semuanya
          hanya menambah kebisingan di layar yang sudah menjelaskan masalahnya. */}
      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Sedang berjalan"
            value={summary ? formatNumber(summary.running) : null}
            hint="Kode yang jendela waktunya sudah terbuka dan belum ditutup"
          />
          <StatCard
            label="Menunggu waktu"
            value={summary ? formatNumber(summary.scheduled) : null}
            hint="Sudah dijadwalkan, belum mulai. Masih bisa dibatalkan sebelum jalan"
          />
          <StatCard
            label="Kuota habis"
            value={summary ? formatNumber(summary.exhausted) : null}
            hint="Kode yang pemakaiannya sudah mencapai batasnya, jadi berhenti bekerja"
            tone={summary && summary.exhausted > 0 ? "warning" : "neutral"}
          />
          <StatCard
            label="Pemakaian tercatat"
            value={summary ? formatNumber(summary.redemptions) : null}
            hint={`Dari ${formatNumber(summary?.total ?? 0)} kode yang pernah dibuat`}
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
        label="Daftar kode voucher"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat daftar voucher"
        errorTitle="Daftar voucher gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        emptyState={
          query.params.q || query.params.state || query.params.scope ? (
            <EmptyState
              title="Tidak ada voucher yang cocok"
              description="Tidak ada voucher yang sesuai dengan filter yang dipasang. Pencarian memakai kode dan nama voucher. Bersihkan filter untuk melihat seluruh voucher."
            />
          ) : (
            <EmptyState
              title="Belum ada kode voucher"
              description="Belum ada kode yang bisa diketik pelanggan. Tambahkan voucher pertama, lalu uji kodenya di panel uji di bawah tabel sebelum diberitahukan ke pelanggan."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        hasMore={query.hasMore}
        unit="voucher"
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />

      {/* Panel uji hanya muncul kalau daftar harganya siap; tanpa daftar itu tidak ada yang bisa
          dihitung, dan kolom kosong lebih membingungkan daripada keterangan. */}
      {options.status === "siap" ? (
        <VoucherCheckPanel prices={options.data?.prices ?? []} />
      ) : (
        <section className="bg-card flex flex-col gap-2 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Uji kode voucher</h2>
          <p className="text-muted-foreground text-[13px]">
            {options.status === "galat"
              ? "Daftar harga paket gagal dimuat, jadi kode belum bisa diuji dari sini. Muat ulang halaman untuk mencoba lagi."
              : "Menyiapkan daftar harga paket yang dibutuhkan untuk menghitung akibat sebuah kode."}
          </p>
        </section>
      )}

      <section className="bg-card flex flex-col gap-2 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Yang perlu diketahui tentang kode voucher</h2>
        <ul className="text-muted-foreground flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-relaxed">
          <li>
            Kode tidak dapat diubah setelah dibuat. Kode itu yang diketik pelanggan dan yang tercatat
            pada riwayat pemakaian, jadi mengubahnya memutus catatan yang sudah ada.
          </li>
          <li>
            Voucher tidak dapat dihapus, hanya dimatikan. Riwayat pemakaian menunjuk ke barisnya, dan
            menghapusnya membuat tagihan lama tidak dapat dijelaskan.
          </li>
          <li>
            Satu kode hanya berlaku sekali untuk satu pelanggan. Batas itu ditegakkan database, bukan
            hanya diperiksa aplikasi.
          </li>
          <li>
            Potongan tidak menumpuk dengan flash sale. Kalau keduanya berlaku pada harga yang sama,
            yang dipakai adalah yang paling menguntungkan pelanggan.
          </li>
        </ul>
      </section>

      {form ? (
        <VoucherDialog
          voucher={form.voucher}
          prices={options.data?.prices ?? []}
          onClose={() => setForm(null)}
          onDone={() => {
            setForm(null);
            query.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/*
  Menonaktifkan voucher.

  Dikonfirmasi lebih dulu karena akibatnya baru terasa di sisi pelanggan: kode yang mungkin sudah
  diumumkan berhenti bekerja. Kalimatnya menyebut kodenya, supaya tidak ada keraguan voucher mana
  yang sedang dimatikan.
*/
async function nonaktifkan(voucher: Voucher, onDone: () => void) {
  const setuju = await confirmAction({
    title: `Matikan voucher ${voucher.code}?`,
    text:
      `Kode ${voucher.code} tidak lagi memberi potongan, termasuk untuk pelanggan yang ` +
      `mendapatkannya dari pengumuman. Riwayat pemakaiannya tetap tersimpan, dan kodenya masih ` +
      `dapat dihidupkan kembali lewat tombol Ubah.`,
    confirmLabel: "Matikan voucher",
    destructive: true,
  });
  if (!setuju) return;

  try {
    await mutate(`/api/v1/admin/vouchers/${voucher.id}`, { method: "DELETE" });
    notifySuccess("Voucher dimatikan", `Kode ${voucher.code} tidak lagi memberi potongan.`);
    onDone();
  } catch (error) {
    notifyError("Voucher gagal dimatikan", toErrorMessage(error));
  }
}

/*
  Formulir voucher, untuk menambah dan mengubah.

  Dua hal yang berbeda dari formulir flash sale:

  1. Saat menyunting, kode ditampilkan sebagai keterangan dan bukan sebagai kolom isian. Kode itu
     memang tidak dapat diubah, dan kolom yang tidak dapat diisi hanya menambah pertanyaan.
  2. Voucher punya `min_amount` dan kuota total; flash sale tidak.

  Menambah dan mengubah dipecah menjadi dua komponen, bukan satu komponen dengan percabangan di
  dalamnya: mode mengubah perlu membaca daftar harga yang tersimpan dari server, sedangkan mode
  menambah tidak. Memaksa keduanya menjadi satu komponen berarti salah satu mode harus melewati
  pembacaan itu, dan percabangan seperti itu yang membuat urutan hook menjadi tidak pasti.
*/
function VoucherDialog({
  voucher,
  prices,
  onClose,
  onDone,
}: {
  voucher: Voucher | null;
  prices: PriceChoice[];
  onClose: () => void;
  onDone: () => void;
}) {
  if (!voucher) {
    return (
      <FormShell
        title="Tambah voucher"
        description="Kode diketik pelanggan, jadi pakai huruf kapital tanpa spasi. Kode yang sama tidak dapat dipakai dua kali."
        onClose={onClose}
      >
        <VoucherCreateForm prices={prices} onClose={onClose} onDone={onDone} />
      </FormShell>
    );
  }

  return <VoucherEditDialog voucher={voucher} prices={prices} onClose={onClose} onDone={onDone} />;
}

/*
  Mode menambah.

  Dipisahkan dari mode mengubah karena tidak ada detail yang perlu dibaca: voucher yang belum ada
  belum punya daftar harga tersimpan, jadi pilihan harganya dimulai dari kosong.
*/
function VoucherCreateForm({
  prices,
  onClose,
  onDone,
}: {
  prices: PriceChoice[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [priceIds, setPriceIds] = useState<string[]>([]);
  const [priceError, setPriceError] = useState<string | null>(null);

  return (
    <VoucherForm
      voucher={null}
      prices={prices}
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

  Daftar harga yang sedang dipilih dibaca dari endpoint detail, bukan dari baris tabel. Baris tabel
  hanya memuat jumlahnya, dan memilih ulang dari jumlah itu akan menghapus pilihan yang sudah ada.
*/
function VoucherEditDialog({
  voucher,
  prices,
  onClose,
  onDone,
}: {
  voucher: Voucher;
  prices: PriceChoice[];
  onClose: () => void;
  onDone: () => void;
}) {
  const detail = useApiQuery<VoucherDetail>(`/api/v1/admin/vouchers/${voucher.id}`);

  return (
    <FormShell
      title={`Ubah voucher ${voucher.code}`}
      description="Kode tidak dapat diubah. Perubahan berlaku sejak disimpan, dan langsung dipakai saat harga ditagih."
      onClose={onClose}
    >
      {detail.status === "siap" ? (
        <VoucherEditForm
          voucher={voucher}
          prices={prices}
          initialPriceIds={detail.data?.prices.map((price) => price.id) ?? []}
          onClose={onClose}
          onDone={onDone}
        />
      ) : (
        <p className="text-muted-foreground py-6 text-[13px]" role="status">
          {detail.status === "galat"
            ? `Harga yang sedang dipilih voucher ini gagal dimuat${detail.error ? `: ${detail.error}` : ""}. Tutup lalu buka lagi untuk mencoba.`
            : "Memuat harga yang sedang dipilih voucher ini."}
        </p>
      )}
    </FormShell>
  );
}

/*
  Kerangka dialog yang sama untuk kedua mode, supaya judul dan ukurannya tidak berbeda diam-diam.

  Klik di luar dialog dicegah karena formulir diskon bisa berisi belasan kolom. Tombol Batal,
  tombol silang, dan Escape tetap menutup dialog melalui kontrol Radix.
*/
function VoucherEditForm({
  voucher,
  prices,
  initialPriceIds,
  onClose,
  onDone,
}: {
  voucher: Voucher;
  prices: PriceChoice[];
  initialPriceIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [priceIds, setPriceIds] = useState(initialPriceIds);
  const [priceError, setPriceError] = useState<string | null>(null);

  return (
    <VoucherForm
      voucher={voucher}
      prices={prices}
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
    <Dialog open onOpenChange={(open) => {
      if (!open) onClose?.();
    }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function VoucherForm({
  voucher,
  prices,
  priceIds,
  setPriceIds,
  priceError,
  setPriceError,
  onClose,
  onDone,
}: {
  voucher: Voucher | null;
  prices: PriceChoice[];
  priceIds: string[];
  setPriceIds: (next: string[]) => void;
  priceError: string | null;
  setPriceError: (next: string | null) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const awal: DiscountFormValues = voucher
    ? seedFrom(voucher, { minAmount: voucher.min_amount, maxRedemptions: voucher.max_redemptions })
    : emptyDiscountForm;

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DiscountFormValues>({
    resolver: zodResolver(discountFormSchema({ requireName: false, requireCode: !voucher })),
    defaultValues: awal,
  });

  const scope = useWatch({ control, name: "scope" });

  async function submit(values: DiscountFormValues) {
    /*
      Cakupan harga tertentu wajib punya minimal satu harga. Diperiksa di sini karena daftar
      harganya bukan bagian dari react-hook-form: pemilihnya kumpulan kotak centang yang nilainya
      dipegang komponen ini.
    */
    if (values.scope === "selected_prices" && priceIds.length === 0) {
      setPriceError("Pilih minimal satu harga paket untuk cakupan ini.");
      return;
    }

    const body = discountBody(values, {
      priceIds,
      includeCode: !voucher,
      includeMinAmount: true,
      includeMaxRedemptions: true,
    });

    try {
      if (voucher) {
        await mutate(`/api/v1/admin/vouchers/${voucher.id}`, { method: "PATCH", body });
        notifySuccess(
          "Voucher diperbarui",
          `Perubahan pada ${voucher.code} sudah disimpan dan langsung berlaku saat harga ditagih.`,
        );
      } else {
        await mutate("/api/v1/admin/vouchers", { method: "POST", body });
        notifySuccess(
          "Voucher ditambahkan",
          "Kodenya sudah bisa dipakai. Uji dulu di panel uji sebelum diberitahukan ke pelanggan.",
        );
      }
      onDone();
    } catch (error) {
      const message = toErrorMessage(error);
      setError("root", { message });
      notifyError(voucher ? "Voucher gagal diperbarui" : "Voucher gagal ditambahkan", message);
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
      {voucher ? (
        /*
          Kode ditampilkan sebagai keterangan, bukan sebagai kolom yang dimatikan. Kolom yang
          dimatikan mengundang orang mencoba mengisinya, sedangkan kode voucher memang tidak dapat
          diubah setelah dibuat.
        */
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">Kode voucher</span>
          <span className="tabular text-[13px] tracking-wide">{voucher.code}</span>
          <p className="text-muted-foreground text-[13px]">
            Kode tidak dapat diubah setelah dibuat, karena kode itu yang diketik pelanggan dan yang
            tercatat pada riwayat pemakaian.
          </p>
        </div>
      ) : null}

      <DiscountFields
        control={control}
        codeLabel={voucher ? undefined : "Kode voucher"}
        codeHint={
          voucher
            ? undefined
            : "3 sampai 32 karakter. Huruf kecil otomatis diubah menjadi huruf besar, sehingga kode tidak pernah berbeda hanya karena besar-kecil hurufnya."
        }
        nameLabel="Nama voucher"
        namePlaceholder="Contoh: Promo September"
        nameHint="Nama ini hanya terlihat oleh admin. Kode yang diketik pelanggan diisi di kolom terpisah."
        maxRedemptionsHint="Kosongkan bila kode boleh dipakai sebanyak apa pun. Tidak dapat diturunkan di bawah jumlah yang sudah terpakai."
      />

      <WindowFields control={control} requireWindow={false} />

      {scope === "selected_prices" ? (
        <PricePicker
          prices={prices}
          selected={priceIds}
          onChange={setPriceIds}
          error={priceError ?? undefined}
        />
      ) : null}

      {errors.root?.message ? (
        <p className="text-danger text-[13px]" role="alert">
          {errors.root.message}
        </p>
      ) : null}

      <DialogFooter>
        <DialogActions
          onClose={onClose}
          isSubmitting={isSubmitting}
          submitLabel={voucher ? "Simpan perubahan" : "Tambah voucher"}
        />
      </DialogFooter>
    </form>
  );
}

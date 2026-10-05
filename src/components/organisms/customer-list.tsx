"use client";

import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon, ProhibitIcon, TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, Spinner, Timestamp } from "@/components/atoms";
import {
  Column,
  DataTable,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  StatCard,
  StatusLabel,
  TextField,
  statusTone,
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
import { PASSWORD_HINT } from "@/lib/password-rules";
import { createCustomerSchema, type CreateCustomerInput } from "@/lib/schemas/admin-customer";
import { mutate, tableStatus, usePagedQuery } from "@/lib/use-api";

/*
  Daftar pelanggan.

  Warna rail pada tiap baris mengikuti status akun, bukan status langganan, karena halaman ini
  diurutkan berdasarkan akun. Status langganan ditampilkan sebagai lencana terpisah supaya
  keduanya tidak tercampur menjadi satu sinyal.

  Kolom "cara masuk" penting karena pelanggan yang tidak bisa masuk aplikasi hampir selalu
  memakai salah satu dari tiga cara masuk, dan operator perlu tahu cara mana yang dipakai
  sebelum menyuruh pelanggan mencoba lagi.
*/

type CustomerRow = {
  id: string;
  full_name: string;
  status: string;
  email: string | null;
  phone_e164: string | null;
  providers: string[];
  plan_name: string | null;
  subscription_status: string | null;
  device_count: number;
  created_at: string;
};

type CustomersResponse = {
  customers: CustomerRow[];
  summary: {
    total: number;
    active: number;
    suspended: number;
    active_without_device: number;
  };
};

/*
  Nama cara masuk diterjemahkan karena istilah teknisnya tidak dikenal operator lapangan.
  Cara masuk yang tidak dikenali ditampilkan apa adanya, bukan disamarkan.
*/
const PROVIDER_LABELS: Record<string, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  google: "Google",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export function CustomerList() {
  const query = usePagedQuery<CustomersResponse>("/api/v1/admin/customers");
  const [createOpen, setCreateOpen] = useState(false);
  const [suspendTarget, setSuspendTarget] = useState<CustomerRow | null>(null);

  const filters: FilterDefinition[] = [
    {
      kind: "search",
      key: "q",
      label: "Cari pelanggan",
      placeholder: "Nama, email, atau nomor WhatsApp",
    },
    {
      kind: "select",
      key: "status",
      label: "Status akun",
      anyLabel: "Semua status",
      options: [
        { value: "active", label: "Aktif" },
        { value: "suspended", label: "Ditangguhkan" },
      ],
    },
  ];

  const rows = query.data?.customers ?? [];
  const summary = query.data?.summary;

  async function deleteCustomer(row: CustomerRow) {
    const confirmed = await confirmAction({
      title: `Hapus akun ${row.full_name}?`,
      text:
        (row.device_count > 0
          ? `${row.device_count} perangkatnya dilepas dan dapat diklaim akun lain. `
          : "") +
        "Sesi aplikasinya dicabut dan akun menghilang dari daftar, tetapi histori tagihannya tetap tersimpan.",
      confirmLabel: "Ya, hapus akun",
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await mutate(`/api/v1/admin/customers/${row.id}`, {
        method: "DELETE",
        body: { reason: "Dihapus admin dari daftar pelanggan." },
      });
      notifySuccess("Pelanggan dihapus", `Akun ${row.full_name} tidak lagi tampil di daftar.`);
      query.reload();
    } catch (error) {
      notifyError("Pelanggan gagal dihapus", toErrorMessage(error));
    }
  }

  const columns: Column<CustomerRow>[] = [
    {
      key: "full_name",
      header: "Nama",
      cell: (row) => (
        <Link
          href={`/customers/${row.id}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {row.full_name}
        </Link>
      ),
    },
    {
      key: "contact",
      header: "Kontak",
      cell: (row) =>
        row.email || row.phone_e164 ? (
          <div className="flex flex-col">
            {row.email ? <span className="text-[13px]">{row.email}</span> : null}
            {row.phone_e164 ? (
              <span className="tabular text-muted-foreground text-[13px]">{row.phone_e164}</span>
            ) : null}
          </div>
        ) : (
          /*
            Pelanggan tanpa cara masuk sama sekali adalah keadaan yang wajar pada akun yang
            baru dibuat, tetapi juga bisa berarti pendaftarannya tidak selesai. Karena itu
            keadaannya disebutkan, bukan dibiarkan kosong tanpa keterangan.
          */
          <span className="text-muted-foreground text-[13px]">Belum ada cara masuk</span>
        ),
    },
    {
      key: "providers",
      header: "Cara masuk",
      cell: (row) =>
        row.providers.length > 0 ? (
          <span className="text-muted-foreground text-[13px]">
            {row.providers.map(providerLabel).join(", ")}
          </span>
        ) : (
          <span className="text-muted-foreground text-[13px]">Belum ada</span>
        ),
    },
    {
      key: "status",
      header: "Status akun",
      cell: (row) => <StatusLabel kind="customer" value={row.status} />,
    },
    {
      key: "plan",
      header: "Paket",
      cell: (row) =>
        row.plan_name ? (
          <div className="flex flex-col items-start gap-1">
            <span className="text-[13px]">{row.plan_name}</span>
            <StatusLabel kind="subscription" value={row.subscription_status} />
          </div>
        ) : (
          <span className="text-muted-foreground text-[13px]">Belum berlangganan</span>
        ),
    },
    {
      key: "device_count",
      header: "Perangkat",
      cell: (row) =>
        row.device_count > 0 ? (
          <span className="tabular">{formatNumber(row.device_count)}</span>
        ) : (
          <span className="text-muted-foreground">Belum ada</span>
        ),
    },
    {
      key: "created_at",
      header: "Terdaftar",
      cell: (row) => <Timestamp value={row.created_at} />,
    },
    /*
      Aksi baris. Nama pelanggan sendiri sudah menjadi tautan ke detail, jadi kolom ini hanya
      memuat tindakan yang mengubah sesuatu. Perbaikan nama tetap di halaman detail, supaya
      daftar tidak penuh dengan dialog kecil. Tangguhkan hanya untuk akun aktif — akun yang
      sudah ditangguhkan diaktifkan kembali dari halaman detailnya, karena keputusan itu perlu
      melihat riwayatnya lebih dulu.
    */
    {
      key: "actions",
      header: "Aksi",
      cell: (row) => (
        <div className="flex items-center gap-1">
          {row.status === "active" ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Tangguhkan ${row.full_name}`}
              onClick={() => setSuspendTarget(row)}
            >
              <ProhibitIcon aria-hidden className="size-4" />
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Hapus ${row.full_name}`}
            onClick={() => void deleteCustomer(row)}
          >
            <TrashIcon aria-hidden className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pelanggan"
        description="Akun pelanggan aplikasi Nayaka. Perangkat dan langganan pelanggan dikelola dari halaman detail masing-masing."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden />
            Tambah pelanggan
          </Button>
        }
      />

      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Pelanggan aktif"
            value={summary ? formatNumber(summary.active) : null}
            hint="Akun yang dapat memakai aplikasi dan perangkatnya"
          />
          <StatCard
            label="Ditangguhkan"
            value={summary ? formatNumber(summary.suspended) : null}
            hint="Akun yang aksesnya dihentikan sementara"
            tone={summary && summary.suspended > 0 ? "warning" : "neutral"}
          />
          <StatCard
            label="Aktif tanpa perangkat"
            value={summary ? formatNumber(summary.active_without_device) : null}
            hint="Sudah mendaftar tetapi belum memasang kamera"
          />
          <StatCard
            label="Total pelanggan"
            value={summary ? formatNumber(summary.total) : null}
            hint="Seluruh akun yang belum dihapus"
          />
        </div>
      )}

      <FilterBar
        filters={filters}
        values={{
          q: query.params.q as string | undefined,
          status: query.params.status as string | undefined,
        }}
        onChange={(next) => query.setParams(next)}
        onReset={() => query.setParams({})}
      />

      <DataTable
        label="Daftar pelanggan"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat daftar pelanggan"
        errorTitle="Daftar pelanggan gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) => statusTone("customer", row.status)}
        emptyState={
          query.params.q || query.params.status ? (
            <EmptyState
              title="Tidak ada pelanggan yang cocok"
              description="Tidak ada pelanggan yang sesuai dengan filter yang dipasang. Pencarian mencakup nama, email, dan nomor WhatsApp. Bersihkan filter untuk melihat seluruh pelanggan."
            />
          ) : (
            <EmptyState
              title="Belum ada pelanggan"
              description="Pelanggan mendaftar sendiri lewat aplikasi Nayaka, jadi daftar ini akan terisi setelah pendaftaran pertama. Akun yang dibuat lewat aplikasi otomatis mendapat paket Gratis."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="pelanggan"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />

      <CreateCustomerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false);
          query.reload();
        }}
      />

      <SuspendRowDialog
        target={suspendTarget}
        onClose={() => setSuspendTarget(null)}
        onDone={() => {
          setSuspendTarget(null);
          query.reload();
        }}
      />
    </div>
  );
}

/*
  Dialog penambahan pelanggan manual.

  Dipisah dari daftar supaya formulir dan hook-nya hanya hidup saat dialog dibuka, bukan
  sepanjang halaman daftar ditampilkan. Menutup dialog mengosongkan isian, karena kata sandi
  yang tertinggal di formulir yang dibuka ulang adalah kata sandi yang paling mudah terkirim
  dua kali tanpa disadari.
*/
function CreateCustomerDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const {
    control,
    handleSubmit,
    reset,
    setError,
    formState: { isSubmitting },
  } = useForm<CreateCustomerInput>({
    resolver: zodResolver(createCustomerSchema),
    defaultValues: { full_name: "", email: undefined, password: "", phone_e164: undefined },
  });

  async function submit(values: CreateCustomerInput) {
    try {
      const result = await mutate<{ customer: { id: string; full_name: string } }>(
        "/api/v1/admin/customers",
        {
          method: "POST",
          body: {
            full_name: values.full_name,
            ...(values.email ? { email: values.email, password: values.password } : {}),
            ...(values.phone_e164 ? { phone_e164: values.phone_e164 } : {}),
          },
        },
      );
      notifySuccess(
        "Pelanggan ditambahkan",
        `Akun ${result.customer.full_name} sudah aktif dan dapat dipakai masuk.`,
      );
      reset();
      onDone();
    } catch (error) {
      const message = toErrorMessage(error);
      setError("root", { message });
      notifyError("Pelanggan gagal ditambahkan", message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tambah pelanggan</DialogTitle>
          <DialogDescription>
            Akun langsung aktif dan cara masuknya langsung terverifikasi, jadi pastikan
            identitasnya benar sebelum menyimpan. Kata sandi tidak ditampilkan lagi setelah
            akun dibuat — sampaikan kepada pelanggan lewat jalur yang aman.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <TextField<CreateCustomerInput>
            control={control}
            name="full_name"
            label="Nama lengkap"
            placeholder="Contoh: Budi Santoso"
            required
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField<CreateCustomerInput>
              control={control}
              name="email"
              label="Email"
              placeholder="nama@contoh.com"
              hint="Cara masuk pertama. Boleh dikosongkan bila hanya memakai WhatsApp."
            />
            <TextField<CreateCustomerInput>
              control={control}
              name="password"
              label="Kata sandi"
              type="password"
              placeholder="Kata sandi awal"
              hint={PASSWORD_HINT}
            />
          </div>

          <TextField<CreateCustomerInput>
            control={control}
            name="phone_e164"
            label="Nomor WhatsApp"
            placeholder="+6281234567890"
            hint="Format internasional dengan tanda plus di depan. Boleh dikosongkan bila hanya memakai email."
          />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Menyimpan" /> : null}
              {isSubmitting ? "Menyimpan..." : "Simpan pelanggan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/*
  Dialog tangguhkan akun dari daftar.

  Alasan tetap wajib sama seperti di halaman detail — daftar yang bisa menangguhkan tanpa
  alasan adalah jalan pintas yang mengosongkan jejak audit.
*/
const suspendSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

type SuspendValues = z.infer<typeof suspendSchema>;

function SuspendRowDialog({
  target,
  onClose,
  onDone,
}: {
  target: CustomerRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<SuspendValues>({
    resolver: zodResolver(suspendSchema),
    values: { reason: "" },
  });

  async function submit(values: SuspendValues) {
    if (!target) return;
    try {
      const result = await mutate<{ effect?: { note?: string } }>(
        `/api/v1/admin/customers/${target.id}/suspend`,
        {
          method: "POST",
          body: {
            reason: values.reason,
            /*
              Jumlah perangkatnya sudah terbaca di baris daftar, jadi persetujuannya diminta
              lewat konfirmasi sebelum dialog dibuka, bukan kotak centang kedua di sini.
            */
            acknowledge_devices: target.device_count > 0,
          },
        },
      );
      notifySuccess("Akun ditangguhkan", result.effect?.note ?? `${target.full_name} ditangguhkan.`);
      reset();
      onDone();
    } catch (error) {
      notifyError("Akun gagal ditangguhkan", toErrorMessage(error));
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tangguhkan {target?.full_name ?? ""}?</DialogTitle>
          <DialogDescription>
            Seluruh perangkat pelanggan berhenti melayani dan sesi aplikasinya dicabut.
            {target && target.device_count > 0
              ? ` Pelanggan ini punya ${target.device_count} perangkat terpasang.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <TextField<SuspendValues>
            control={control}
            name="reason"
            label="Alasan"
            placeholder="Contoh: menunggak pembayaran lebih dari tiga puluh hari"
            hint="Tersimpan pada jejak audit, jadi sebutkan dasar keputusannya."
            required
          />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" variant="destructive" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Memproses" /> : null}
              Tangguhkan akun
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

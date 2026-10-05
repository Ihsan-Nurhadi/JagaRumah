"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, Identifier, Money, Spinner, Timestamp } from "@/components/atoms";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  StatusLabel,
  TextField,
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
import { mutate, useApiQuery } from "@/lib/use-api";

/*
  Detail pelanggan.

  Susunan halamannya mengikuti urutan pertanyaan yang muncul saat menangani keluhan:

  1. Akunnya bagaimana? Status dan cara masuknya ada di bagian pertama.
  2. Perangkatnya apa saja? Ini yang paling sering ditanyakan pelanggan.
  3. Langganannya bagaimana? Paket dan batas perangkatnya.
  4. Tagihannya bagaimana? Sepuluh terakhir saja, karena yang lama jarang dibutuhkan di sini dan
     daftar penuh membuat halaman ini berat.
  5. Tindakan apa yang boleh saya lakukan? Dikumpulkan di satu bagian, dengan akibatnya
     dijelaskan sebelum tombol ditekan.

  Tindakan yang mengubah akses memakai dialog yang menyebutkan akibatnya, bukan konfirmasi
  "Yakin?". Operator perlu tahu berapa perangkat yang berhenti melayani, dan itu harus terbaca
  sebelum menekan tombol, bukan sesudahnya.
*/

type Detail = {
  customer: {
    id: string;
    full_name: string;
    status: string;
    email: string | null;
    phone_e164: string | null;
    providers: string[];
    created_at: string;
  };
  auth_accounts: {
    id: string;
    provider: string;
    email: string | null;
    phone_e164: string | null;
    is_verified: boolean;
    last_login_at: string | null;
    created_at: string;
  }[];
  devices: {
    id: string;
    device_uid: string;
    serial_number: string;
    name: string | null;
    model: string | null;
    status: string;
    claim_method: string | null;
    claimed_at: string | null;
  }[];
  subscription: {
    id: string;
    status: string;
    plan_name: string | null;
    plan_code: string | null;
    device_limit: number | null;
    device_limit_unlimited: boolean;
    active_device_count: number;
    price_amount: string | null;
    price_interval: string | null;
    started_at: string | null;
    current_period_end: string | null;
    canceled_at: string | null;
  } | null;
  invoices: {
    id: string;
    invoice_number: string | null;
    status: string;
    total_amount: string;
    amount_paid: string;
    currency: string;
    due_at: string | null;
    paid_at: string | null;
    created_at: string;
  }[];
  suspend_impact: { active_devices: number; has_devices: boolean };
};

/*
  Skema dialog tindakan.

  Alasan wajib ada di ketiga tindakan. Nama juga wajib saat memperbaiki nama, karena
  mengosongkan nama pelanggan akan membuat akunnya sulit ditemukan lagi di daftar.
*/
const reasonForm = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

const nameForm = z.object({
  full_name: z
    .string()
    .trim()
    .min(2, "Nama minimal 2 karakter.")
    .max(120, "Nama maksimal 120 karakter."),
});

type ReasonValues = z.infer<typeof reasonForm>;
type NameValues = z.infer<typeof nameForm>;

const PROVIDER_LABELS: Record<string, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  google: "Google",
};

export function CustomerDetail({ customerId }: { customerId: string }) {
  const router = useRouter();
  const query = useApiQuery<Detail>(`/api/v1/admin/customers/${customerId}`);

  const [action, setAction] = useState<"suspend" | "activate" | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  if (query.status === "memuat") return <LoadingState label="Memuat data pelanggan" />;

  if (query.status === "galat" || !query.data) {
    return (
      <ErrorState
        title="Data pelanggan gagal dimuat"
        description={query.error ?? "Server tidak mengirim keterangan galat."}
        onRetry={query.reload}
      />
    );
  }

  const data = query.data;
  const customer = data.customer;
  const suspended = customer.status === "suspended";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link
          href="/customers"
          className="text-muted-foreground inline-flex w-fit items-center gap-1.5 text-[13px] underline-offset-4 hover:underline"
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Daftar pelanggan
        </Link>

        <PageHeader
          title={customer.full_name}
          description={`Terdaftar ${new Date(customer.created_at).toLocaleDateString("id-ID", { dateStyle: "long", timeZone: "Asia/Jakarta" })}`}
          actions={
            <div className="flex items-center gap-3">
              <StatusLabel kind="customer" value={customer.status} />
              <Button variant="secondary" onClick={() => setEditOpen(true)}>
                Perbaiki nama
              </Button>
            </div>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4 lg:col-span-2">
          <h2 className="text-base font-semibold">Cara masuk</h2>
          {data.auth_accounts.length === 0 ? (
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              Akun ini belum punya cara masuk sama sekali. Keadaan ini wajar pada pendaftaran yang
              belum selesai, dan pelanggan perlu menyelesaikannya dari aplikasi.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {data.auth_accounts.map((account) => (
                <li key={account.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                  <span className="text-[13px] font-medium">
                    {PROVIDER_LABELS[account.provider] ?? account.provider}
                  </span>
                  <span className="tabular text-[13px]">
                    {account.email ?? account.phone_e164 ?? "Tanpa alamat"}
                  </span>
                  {account.is_verified ? null : (
                    <span className="text-warning text-[12px] font-medium">Belum diverifikasi</span>
                  )}
                  <span className="text-muted-foreground ml-auto text-[12px]">
                    Masuk terakhir: <Timestamp value={account.last_login_at} fallback="Belum pernah" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Langganan</h2>
          {data.subscription ? (
            <dl className="flex flex-col gap-2 text-[13px]">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Paket</dt>
                <dd className="font-medium">{data.subscription.plan_name ?? "Tidak diketahui"}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  <StatusLabel kind="subscription" value={data.subscription.status} />
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Harga</dt>
                <dd className="tabular">
                  {data.subscription.price_amount
                    ? `${formatRupiahFromDecimal(data.subscription.price_amount)} per bulan`
                    : "Belum ditetapkan"}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Perangkat terpakai</dt>
                <dd className="tabular">
                  {formatNumber(data.subscription.active_device_count)} dari{" "}
                  {data.subscription.device_limit_unlimited
                    ? "tanpa batas"
                    : formatNumber(data.subscription.device_limit ?? 0)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Berakhir</dt>
                <dd>
                  <Timestamp value={data.subscription.current_period_end} fallback="Tanpa batas waktu" />
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              Pelanggan ini belum punya langganan. Setiap pelanggan seharusnya otomatis mendapat
              paket Gratis saat mendaftar, jadi keadaan ini perlu diperiksa.
            </p>
          )}
        </section>
      </div>

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-base font-semibold">Perangkat</h2>
          <span className="text-muted-foreground text-[13px]">
            {data.suspend_impact.active_devices} perangkat terpasang
          </span>
        </div>
        {data.devices.length === 0 ? (
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Belum ada perangkat yang terhubung ke akun ini. Perangkat ditugaskan dari halaman
            daftar perangkat, atau diklaim pelanggan sendiri di aplikasi memakai kode claim.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.devices.map((device) => (
              <li key={device.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                <Link
                  href={`/devices/${device.id}`}
                  className="tabular text-[13px] font-medium underline-offset-4 hover:underline"
                >
                  {device.device_uid}
                </Link>
                <Identifier value={device.serial_number} className="max-w-[16ch]" />
                <span className="text-[13px]">
                  {device.name ?? (
                    <span className="text-muted-foreground">Belum diberi nama</span>
                  )}
                </span>
                <span className="ml-auto flex items-center gap-3">
                  <StatusLabel kind="device" value={device.status} />
                  <span className="text-muted-foreground text-[12px]">
                    Terpasang: <Timestamp value={device.claimed_at} fallback="Belum" />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-base font-semibold">Tagihan terakhir</h2>
          {data.invoices.length > 0 ? (
            <Link
              href={`/invoices?customer_id=${customer.id}`}
              className="text-[13px] underline-offset-4 hover:underline"
            >
              Lihat semua tagihan
            </Link>
          ) : null}
        </div>
        {data.invoices.length === 0 ? (
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Belum ada tagihan untuk pelanggan ini. Paket Gratis tidak menerbitkan tagihan, jadi
            daftar ini akan tetap kosong selama pelanggan memakai paket tersebut.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.invoices.map((invoice) => (
              <li key={invoice.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                <Link
                  href={`/invoices/${invoice.id}`}
                  className="tabular text-[13px] font-medium underline-offset-4 hover:underline"
                >
                  {invoice.invoice_number ?? invoice.id.slice(0, 8)}
                </Link>
                <StatusLabel kind="invoice" value={invoice.status} />
                <span className="tabular ml-auto text-[13px]">
                  <Money value={Number(invoice.total_amount)} />
                </span>
                <span className="text-muted-foreground text-[12px]">
                  Jatuh tempo: <Timestamp value={invoice.due_at} fallback="Tanpa jatuh tempo" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Tindakan akun</h2>
        {suspended ? (
          <>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              Akun ini sedang ditangguhkan. Perangkatnya berhenti melayani sampai akunnya
              diaktifkan kembali. Mengaktifkan akun tidak menghidupkan sesi aplikasi yang lama,
              jadi pelanggan perlu masuk ulang.
            </p>
            <Button className="w-fit" onClick={() => setAction("activate")}>
              Aktifkan kembali akun
            </Button>
          </>
        ) : (
          <>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              Menangguhkan akun menghentikan layanan seluruh perangkat pelanggan dan mencabut sesi
              aplikasinya. Akun pelanggan tidak dapat dihapus dari konsol ini, karena histori
              tagihannya harus tetap utuh.
            </p>
            <Button variant="destructive" className="w-fit" onClick={() => setAction("suspend")}>
              Tangguhkan akun
            </Button>
          </>
        )}
      </section>

      <ActionDialog
        action={action}
        customerId={customer.id}
        customerName={customer.full_name}
        activeDevices={data.suspend_impact.active_devices}
        onClose={() => setAction(null)}
        onDone={() => {
          setAction(null);
          query.reload();
          /* Daftar pelanggan menampilkan status, jadi ia perlu disegarkan saat dikunjungi lagi. */
          router.refresh();
        }}
      />

      <EditNameDialog
        open={editOpen}
        customerId={customer.id}
        currentName={customer.full_name}
        onClose={() => setEditOpen(false)}
        onDone={() => {
          setEditOpen(false);
          query.reload();
        }}
      />
    </div>
  );
}

/*
  Harga dari database berbentuk teks desimal, misalnya "50000.00". Pemformatan rupiah menerima
  angka, jadi konversinya dilakukan di satu tempat agar tidak ada halaman yang lupa dan
  menampilkan "50000.00" apa adanya.
*/
function formatRupiahFromDecimal(value: string): string {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return value;
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(parsed);
}

function ActionDialog({
  action,
  customerId,
  customerName,
  activeDevices,
  onClose,
  onDone,
}: {
  action: "suspend" | "activate" | null;
  customerId: string;
  customerName: string;
  activeDevices: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const suspending = action === "suspend";
  const [acknowledged, setAcknowledged] = useState(false);

  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<ReasonValues>({
    resolver: zodResolver(reasonForm),
    defaultValues: { reason: "" },
  });

  async function submit(values: ReasonValues) {
    try {
      const path = suspending ? "suspend" : "activate";
      const result = await mutate<{
        effect?: { note?: string; devices_stopped?: number };
      }>(`/api/v1/admin/customers/${customerId}/${path}`, {
        method: "POST",
        body: suspending
          ? { reason: values.reason, acknowledge_devices: acknowledged }
          : { reason: values.reason },
      });

      notifySuccess(
        suspending ? "Akun ditangguhkan" : "Akun diaktifkan kembali",
        result.effect?.note ?? `${customerName} sudah diperbarui.`,
      );
      reset();
      setAcknowledged(false);
      onDone();
    } catch (error) {
      notifyError(
        suspending ? "Akun gagal ditangguhkan" : "Akun gagal diaktifkan",
        toErrorMessage(error),
      );
    }
  }

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          setAcknowledged(false);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {suspending ? `Tangguhkan ${customerName}?` : `Aktifkan kembali ${customerName}?`}
          </DialogTitle>
          <DialogDescription>
            {suspending
              ? "Seluruh perangkat pelanggan berhenti melayani, dan sesi aplikasinya dicabut sehingga ia perlu masuk ulang setelah akunnya diaktifkan kembali."
              : "Perangkat pelanggan dapat melayani kembali, tetapi sesi aplikasi yang lama tidak dihidupkan. Pelanggan perlu masuk ulang di aplikasinya."}
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          {suspending && activeDevices > 0 ? (
            /*
              Konfirmasi ini bukan basa-basi. Menangguhkan pelanggan yang punya kamera berjalan
              punya akibat yang jauh berbeda daripada menangguhkan akun kosong, dan angka
              perangkatnya disebutkan supaya operator tahu besarnya.
            */
            <label className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-surface/60 p-3 text-[13px] leading-relaxed">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5 size-4 accent-[var(--warning)]"
              />
              <span>
                Saya mengerti {activeDevices} perangkat milik pelanggan ini akan berhenti melayani.
              </span>
            </label>
          ) : null}

          <TextField<ReasonValues>
            control={control}
            name="reason"
            label="Alasan"
            placeholder={
              suspending
                ? "Contoh: menunggak pembayaran lebih dari tiga puluh hari"
                : "Contoh: pembayaran sudah diselesaikan pelanggan"
            }
            hint="Tersimpan pada jejak audit, jadi sebutkan dasar keputusannya."
            required
          />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button
              type="submit"
              variant={suspending ? "destructive" : "default"}
              disabled={isSubmitting || (suspending && activeDevices > 0 && !acknowledged)}
            >
              {isSubmitting ? <Spinner label="Memproses" /> : null}
              {suspending ? "Tangguhkan akun" : "Aktifkan akun"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditNameDialog({
  open,
  customerId,
  currentName,
  onClose,
  onDone,
}: {
  open: boolean;
  customerId: string;
  currentName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<NameValues>({
    resolver: zodResolver(nameForm),
    defaultValues: { full_name: currentName },
  });

  async function submit(values: NameValues) {
    try {
      await mutate(`/api/v1/admin/customers/${customerId}`, {
        method: "PATCH",
        body: values,
      });
      notifySuccess("Nama diperbarui", `Nama pelanggan kini ${values.full_name}.`);
      onDone();
    } catch (error) {
      notifyError("Nama gagal diperbarui", toErrorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset({ full_name: currentName });
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Perbaiki nama pelanggan</DialogTitle>
          <DialogDescription>
            Hanya nama yang dapat diubah di sini. Alamat email dan nomor WhatsApp hanya dapat
            diubah pelanggan sendiri lewat aplikasi, karena perubahannya memerlukan verifikasi.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <TextField<NameValues>
            control={control}
            name="full_name"
            label="Nama lengkap"
            placeholder="Nama sesuai catatan pelanggan"
            required
          />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Menyimpan" /> : null}
              Simpan nama
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

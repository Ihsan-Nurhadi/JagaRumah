"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, Money, Spinner, Timestamp } from "@/components/atoms";
import {
  EmptyState,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notifyError, notifySuccess } from "@/lib/alert";
import { formatNumber } from "@/lib/format";
import { toErrorMessage } from "@/lib/http";
import { mutate, useApiQuery } from "@/lib/use-api";

/*
  Detail langganan.

  Bagian yang paling menentukan bentuk halaman ini adalah pilihan cara pembatalan. Operator yang
  menekan "Batalkan" hampir selalu bermaksud berhenti memperpanjang, bukan memutus layanan hari
  itu. Dua pilihan itu karena itu ditampilkan berdampingan dengan akibatnya masing-masing,
  bukan disembunyikan di balik satu tombol dengan perilaku yang harus ditebak.

  Riwayat perubahan ikut ditampilkan karena tabel langganan hanya menyimpan keadaan terakhir.
  Pertanyaan "kapan paketnya naik dan atas dasar apa" hanya bisa dijawab dari riwayat itu.
*/

type Detail = {
  subscription: {
    id: string;
    status: string;
    customer: { id: string; full_name: string | null; status: string | null };
    plan: {
      id: string | null;
      name: string | null;
      code: string | null;
      device_limit: number | null;
      device_limit_unlimited: boolean;
    };
    active_device_count: number;
    price_amount: string | null;
    price_interval: string | null;
    started_at: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    canceled_at: string | null;
    created_at: string;
  };
  events: {
    id: string;
    event_type: string;
    actor_type: string;
    from_plan_name: string | null;
    to_plan_name: string | null;
    metadata: unknown;
    created_at: string;
  }[];
};

/*
  Nama peristiwa diterjemahkan. Kode seperti `past_due` tidak berarti apa pun bagi operator yang
  membaca riwayat untuk menjawab keluhan pelanggan.
*/
const EVENT_LABELS: Record<string, string> = {
  activated: "Langganan diaktifkan",
  renewed: "Langganan diperpanjang",
  upgraded: "Paket dinaikkan",
  expired: "Langganan berakhir",
  canceled: "Langganan dibatalkan",
  past_due: "Pembayaran menunggak",
  manual_change: "Diubah manual",
};

const ACTOR_LABELS: Record<string, string> = {
  customer: "Pelanggan",
  admin: "Admin",
  system: "Sistem",
};

const INTERVALS: Record<string, string> = {
  monthly: "per bulan",
  yearly: "per tahun",
};

const cancelForm = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

type CancelValues = z.infer<typeof cancelForm>;

export function SubscriptionDetail({ subscriptionId }: { subscriptionId: string }) {
  const query = useApiQuery<Detail>(`/api/v1/admin/subscriptions/${subscriptionId}`);
  const [cancelOpen, setCancelOpen] = useState(false);

  if (query.status === "memuat") return <LoadingState label="Memuat data langganan" />;

  if (query.status === "galat" || !query.data) {
    return (
      <ErrorState
        title="Data langganan gagal dimuat"
        description={query.error ?? "Server tidak mengirim keterangan galat."}
        onRetry={query.reload}
      />
    );
  }

  const { subscription, events } = query.data;
  const finished = subscription.status === "canceled" || subscription.status === "expired";
  const scheduled = subscription.cancel_at_period_end;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link
          href="/subscriptions"
          className="text-muted-foreground inline-flex w-fit items-center gap-1.5 text-[13px] underline-offset-4 hover:underline"
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Daftar langganan
        </Link>

        <PageHeader
          title={subscription.customer.full_name ?? "Pelanggan tidak diketahui"}
          description={`Paket ${subscription.plan.name ?? "tidak diketahui"} sejak ${new Date(subscription.created_at).toLocaleDateString("id-ID", { dateStyle: "long", timeZone: "Asia/Jakarta" })}`}
          actions={
            <div className="flex items-center gap-3">
              <StatusLabel kind="subscription" value={subscription.status} />
              <Button
                variant="destructive"
                disabled={finished || scheduled}
                onClick={() => setCancelOpen(true)}
              >
                Batalkan langganan
              </Button>
            </div>
          }
        />
      </div>

      {scheduled ? (
        <p className="border-warning/40 bg-warning-surface/60 rounded-xl border p-4 text-[13px] leading-relaxed">
          Langganan ini sudah dijadwalkan berhenti pada{" "}
          <Timestamp value={subscription.current_period_end} />. Layanan tetap berjalan sampai
          tanggal itu, karena masa tersebut sudah dibayar pelanggan.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Langganan</h2>
          <dl className="flex flex-col gap-2 text-[13px]">
            <Row
              label="Pelanggan"
              value={
                <Link
                  href={`/customers/${subscription.customer.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {subscription.customer.full_name}
                </Link>
              }
            />
            <Row
              label="Status akun"
              value={<StatusLabel kind="customer" value={subscription.customer.status} />}
            />
            <Row label="Paket" value={subscription.plan.name ?? "Tidak diketahui"} />
            <Row
              label="Harga"
              value={
                subscription.price_amount ? (
                  <span className="flex items-baseline justify-end gap-1.5">
                    <Money value={Number(subscription.price_amount)} />
                    <span className="text-muted-foreground text-[12px]">
                      {subscription.price_interval
                        ? (INTERVALS[subscription.price_interval] ?? subscription.price_interval)
                        : ""}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Tanpa biaya</span>
                )
              }
            />
            <Row
              label="Kuota perangkat"
              value={
                <span className="tabular">
                  {formatNumber(subscription.active_device_count)} dari{" "}
                  {subscription.plan.device_limit_unlimited
                    ? "tanpa batas"
                    : formatNumber(subscription.plan.device_limit ?? 0)}
                </span>
              }
            />
          </dl>
        </section>

        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Masa berlaku</h2>
          <dl className="flex flex-col gap-2 text-[13px]">
            <Row label="Mulai" value={<Timestamp value={subscription.started_at} />} />
            <Row
              label="Awal periode berjalan"
              value={<Timestamp value={subscription.current_period_start} />}
            />
            <Row
              label="Akhir periode berjalan"
              value={
                subscription.current_period_end ? (
                  <Timestamp value={subscription.current_period_end} />
                ) : (
                  /*
                    Paket gratis tidak punya akhir periode. Dinyatakan sebagai sifat paketnya,
                    bukan sebagai tanggal yang kosong, supaya tidak terlihat seperti data hilang.
                  */
                  <span className="text-muted-foreground">Tidak berakhir</span>
                )
              }
            />
            <Row label="Dibatalkan pada" value={<Timestamp value={subscription.canceled_at} fallback="Belum dibatalkan" />} />
          </dl>
        </section>
      </div>

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Riwayat perubahan</h2>
        {events.length === 0 ? (
          <EmptyState
            title="Belum ada perubahan yang tercatat"
            description="Riwayat ini terisi saat langganan diaktifkan, diperpanjang, dinaikkan paketnya, atau dibatalkan. Langganan yang belum pernah berubah tidak akan memiliki catatan di sini."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {events.map((event) => (
              <li key={event.id} className="flex flex-col gap-1 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[13px] font-medium">
                    {EVENT_LABELS[event.event_type] ?? event.event_type}
                  </span>
                  <span className="text-muted-foreground text-[12px]">
                    oleh {ACTOR_LABELS[event.actor_type] ?? event.actor_type}
                  </span>
                  {event.from_plan_name && event.to_plan_name ? (
                    <span className="text-muted-foreground text-[12px]">
                      {event.from_plan_name} ke {event.to_plan_name}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground ml-auto text-[12px]">
                    <Timestamp value={event.created_at} />
                  </span>
                </div>
                {/*
                  Metadata ditampilkan apa adanya sebagai pasangan kunci dan nilai, bukan
                  sebagai JSON mentah, supaya alasan pembatalan bisa dibaca langsung dari riwayat
                  tanpa perlu membuka alat lain.
                */}
                {event.metadata ? <MetadataLine metadata={event.metadata} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <CancelDialog
        open={cancelOpen}
        subscriptionId={subscription.id}
        customerName={subscription.customer.full_name ?? "pelanggan ini"}
        periodEnd={subscription.current_period_end}
        onClose={() => setCancelOpen(false)}
        onDone={() => {
          setCancelOpen(false);
          query.reload();
        }}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

/*
  Metadata peristiwa dirender sebagai daftar kunci dan nilai.

  Nilai yang berupa objek bersarang tetap ditampilkan, tetapi tidak dipaksa masuk ke dalam
  kalimat, karena bentuk metadata berbeda-beda per jenis peristiwa dan memaksakan satu bentuk
  akan menyembunyikan isi yang tidak terduga.
*/
function MetadataLine({ metadata }: { metadata: unknown }) {
  if (typeof metadata !== "object" || metadata === null) return null;

  const entries = Object.entries(metadata as Record<string, unknown>).filter(
    ([, value]) => value !== null && value !== undefined,
  );

  if (entries.length === 0) return null;

  return (
    <p className="text-muted-foreground text-[12px] leading-relaxed">
      {entries.map(([key, value]) => (
        <span key={key} className="mr-3 inline-block">
          <span className="font-medium">{key.replace(/_/g, " ")}</span>:{" "}
          {typeof value === "object" ? JSON.stringify(value) : String(value)}
        </span>
      ))}
    </p>
  );
}

function CancelDialog({
  open,
  subscriptionId,
  customerName,
  periodEnd,
  onClose,
  onDone,
}: {
  open: boolean;
  subscriptionId: string;
  customerName: string;
  periodEnd: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  /*
    Cara pembatalan disimpan di state sendiri, bukan di dalam form, karena ia bukan kolom yang
    divalidasi melainkan pilihan yang mengubah teks penjelasan di layar.
  */
  const [mode, setMode] = useState<"at_period_end" | "immediate">(
    periodEnd ? "at_period_end" : "immediate",
  );

  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<CancelValues>({
    resolver: zodResolver(cancelForm),
    defaultValues: { reason: "" },
  });

  async function submit(values: CancelValues) {
    try {
      const result = await mutate<{ effect?: { note?: string } }>(
        `/api/v1/admin/subscriptions/${subscriptionId}/cancel`,
        { method: "POST", body: { reason: values.reason, mode } },
      );
      notifySuccess("Langganan dibatalkan", result.effect?.note);
      reset();
      onDone();
    } catch (error) {
      notifyError("Langganan gagal dibatalkan", toErrorMessage(error));
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
          <DialogTitle>Batalkan langganan {customerName}?</DialogTitle>
          <DialogDescription>
            Pilih kapan layanan berhenti. Masa berlangganan yang sudah dibayar pelanggan tetap
            menjadi haknya, jadi penghentian lebih awal perlu dipilih secara sadar.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cara-pembatalan" className="text-[13px] font-medium">
              Cara pembatalan
            </label>
            {periodEnd ? null : (
              <p className="text-muted-foreground text-[13px] leading-relaxed">
                Langganan ini tidak punya akhir periode, jadi pembatalannya berlaku langsung.
              </p>
            )}
            <Select
              value={mode}
              onValueChange={(next) => setMode(next as "at_period_end" | "immediate")}
              disabled={!periodEnd}
            >
              <SelectTrigger id="cara-pembatalan" className="rounded-md data-[size=default]:h-11 w-full sm:data-[size=default]:h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {periodEnd ? (
                  <SelectItem value="at_period_end">
                    Berhenti di akhir masa berlaku
                  </SelectItem>
                ) : null}
                <SelectItem value="immediate">Berhenti langsung sekarang</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              {mode === "at_period_end" && periodEnd
                ? `Layanan tetap berjalan sampai ${new Date(periodEnd).toLocaleDateString("id-ID", { dateStyle: "long", timeZone: "Asia/Jakarta" })}, lalu berhenti sendiri. Pelanggan tidak ditagih lagi.`
                : "Layanan berhenti sekarang dan perangkat pelanggan tidak lagi tercakup langganan. Pilih ini hanya bila pelanggan memang memintanya."}
            </p>
          </div>

          <TextField<CancelValues>
            control={control}
            name="reason"
            label="Alasan"
            placeholder="Contoh: pelanggan meminta tidak diperpanjang lagi"
            hint="Tersimpan pada jejak audit dan riwayat langganan."
            required
          />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" variant="destructive" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Memproses" /> : null}
              Batalkan langganan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

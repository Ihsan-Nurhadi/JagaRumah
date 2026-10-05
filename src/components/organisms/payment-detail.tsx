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
  SelectField,
  StatusLabel,
  TextAreaField,
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
import { toErrorMessage } from "@/lib/http";
import { mutate, useApiQuery } from "@/lib/use-api";

/*
  Detail pembayaran.

  Susunan halaman ini mengikuti pertanyaan yang biasanya datang, berurutan:

  1. Berapa yang dibayar pelanggan dan berapa yang menjadi pendapatan kita. Dua angka itu
     berbeda karena penyedia menambahkan biaya layanan.
  2. Pembayaran ini sudah dikonfirmasi penyedia atau belum, dan lewat cara apa.
  3. Notifikasi apa yang masuk dari penyedia, dan apakah sudah diproses.
  4. Panggilan apa yang kita kirim ke penyedia, dan mana yang gagal.

  Refund ada di bagian bawah karena hanya berlaku untuk pembayaran yang sudah lunas.
*/

type Detail = {
  payment: {
    id: string;
    attempt_sequence: number;
    provider: string;
    payment_method: string | null;
    provider_order_id: string | null;
    amount: string;
    provider_fee: string | null;
    provider_total_payment: string | null;
    status: string;
    expires_at: string | null;
    paid_at: string | null;
    verified_at: string | null;
    verified_via: string | null;
    created_at: string;
  };
  invoice: {
    id: string;
    invoice_number: string | null;
    status: string;
    total_amount: string;
    amount_paid: string;
    currency: string;
    due_at: string | null;
    paid_at: string | null;
  } | null;
  customer: { id: string; full_name: string | null };
  webhook_events: {
    id: string;
    provider_event_id: string | null;
    provider_order_id: string | null;
    provider_status: string | null;
    event_type: string;
    ip_address: string | null;
    processed_at: string | null;
    processing_error: string | null;
    payload: unknown;
    created_at: string;
  }[];
  provider_calls: {
    id: string;
    operation: string;
    order_id: string | null;
    http_status: number | null;
    duration_ms: number;
    outcome: string;
    error_message: string | null;
    attempt_number: number;
    request_body: unknown;
    response_body: unknown;
    created_at: string;
  }[];
  refunds: {
    id: string;
    amount: string;
    reason: string;
    status: string;
    provider_refund_id: string | null;
    completed_at: string | null;
    created_at: string;
    requested_by: string | null;
  }[];
};

const METHOD_LABELS: Record<string, string> = {
  qris: "QRIS",
  cimb_niaga_va: "Virtual account CIMB Niaga",
  bni_va: "Virtual account BNI",
  sampoerna_va: "Virtual account Sampoerna",
  bnc_va: "Virtual account BNC",
  maybank_va: "Virtual account Maybank",
  permata_va: "Virtual account Permata",
  atm_bersama_va: "Virtual account ATM Bersama",
  artha_graha_va: "Virtual account Artha Graha",
  bri_va: "Virtual account BRI",
};

const OPERATION_LABELS: Record<string, string> = {
  transactioncreate: "Membuat transaksi",
  transactioncancel: "Membatalkan transaksi",
  transactiondetail: "Memeriksa status transaksi",
  paymentsimulation: "Simulasi pembayaran",
};

const VERIFIED_VIA_LABELS: Record<string, string> = {
  webhook: "notifikasi penyedia",
  reconciliation: "rekonsiliasi berkala",
  sync: "pemeriksaan manual",
};

const REFUND_STATUS_LABELS: Record<string, string> = {
  pending: "Belum selesai",
  completed: "Selesai",
  failed: "Gagal",
};

const refundForm = z.object({
  amount: z
    .string()
    .trim()
    .min(1, "Nominal refund wajib diisi.")
    .refine((value) => !Number.isNaN(Number(value)), "Nominal refund harus berupa angka.")
    .refine((value) => Number(value) > 0, "Nominal refund harus lebih besar dari nol."),
  provider_refund_id: z
    .string()
    .trim()
    .min(3, "Nomor rujukan refund dari penyedia minimal 3 karakter.")
    .max(120, "Nomor rujukan refund maksimal 120 karakter."),
  status: z.enum(["pending", "completed", "failed"]),
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

type RefundValues = z.infer<typeof refundForm>;

export function PaymentDetail({ paymentId }: { paymentId: string }) {
  const query = useApiQuery<Detail>(`/api/v1/admin/payments/${paymentId}`);
  const [refundOpen, setRefundOpen] = useState(false);

  if (query.status === "memuat") return <LoadingState label="Memuat data pembayaran" />;

  if (query.status === "galat" || !query.data) {
    return (
      <ErrorState
        title="Data pembayaran gagal dimuat"
        description={query.error ?? "Server tidak mengirim keterangan galat."}
        onRetry={query.reload}
      />
    );
  }

  const { payment, invoice, customer, webhook_events: webhooks, provider_calls: calls } = query.data;
  const refunds = query.data.refunds;
  /* Refund hanya masuk akal untuk pembayaran yang sudah lunas. */
  const canRefund = payment.status === "paid";
  const netAmount = Number(payment.amount);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link
          href="/payments"
          className="text-muted-foreground inline-flex w-fit items-center gap-1.5 text-[13px] underline-offset-4 hover:underline"
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Daftar pembayaran
        </Link>

        <PageHeader
          title={payment.provider_order_id ?? "Pembayaran tanpa nomor pesanan"}
          description={`Percobaan ke ${payment.attempt_sequence} untuk tagihan ${invoice?.invoice_number ?? "yang tidak ditemukan"}`}
          actions={
            <div className="flex items-center gap-3">
              <StatusLabel kind="payment" value={payment.status} />
              {canRefund ? (
                <Button variant="secondary" onClick={() => setRefundOpen(true)}>
                  Catat refund
                </Button>
              ) : null}
            </div>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Uang</h2>
          <dl className="flex flex-col gap-2 text-[13px]">
            <Row label="Nominal tagihan" value={<Money value={netAmount} />} />
            <Row
              label="Biaya layanan penyedia"
              value={
                payment.provider_fee ? (
                  <Money value={Number(payment.provider_fee)} />
                ) : (
                  <span className="text-muted-foreground">Tidak dicatat</span>
                )
              }
            />
            <Row
              label="Dibayar pelanggan"
              value={
                payment.provider_total_payment ? (
                  <Money value={Number(payment.provider_total_payment)} />
                ) : (
                  <span className="text-muted-foreground">Belum diketahui</span>
                )
              }
            />
          </dl>
          <p className="text-muted-foreground text-[12px] leading-relaxed">
            Hanya nominal tagihan yang dihitung sebagai pendapatan langganan. Biaya layanan
            diteruskan ke penyedia pembayaran dan tidak pernah menjadi pendapatan.
          </p>
        </section>

        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Keterangan</h2>
          <dl className="flex flex-col gap-2 text-[13px]">
            <Row
              label="Pelanggan"
              value={
                <Link
                  href={`/customers/${customer.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {customer.full_name}
                </Link>
              }
            />
            <Row
              label="Tagihan"
              value={
                invoice ? (
                  <Link
                    href={`/invoices/${invoice.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {invoice.invoice_number ?? "Tagihan tanpa nomor"}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Tidak ditemukan</span>
                )
              }
            />
            <Row
              label="Cara bayar"
              value={
                payment.payment_method
                  ? (METHOD_LABELS[payment.payment_method] ?? payment.payment_method)
                  : "Tidak dicatat"
              }
            />
            <Row label="Dibuat" value={<Timestamp value={payment.created_at} />} />
            <Row
              label="Kedaluwarsa"
              value={<Timestamp value={payment.expires_at} fallback="Tanpa batas waktu" />}
            />
            <Row
              label="Dibayar"
              value={<Timestamp value={payment.paid_at} fallback="Belum dibayar" />}
            />
            <Row
              label="Dikonfirmasi penyedia"
              value={
                payment.verified_at ? (
                  <span>
                    <Timestamp value={payment.verified_at} />
                    {payment.verified_via ? (
                      <span className="text-muted-foreground">
                        {", lewat "}
                        {VERIFIED_VIA_LABELS[payment.verified_via] ?? payment.verified_via}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  /*
                    Belum dikonfirmasi bukan berarti gagal, dan itu disebutkan supaya tidak
                    disimpulkan sebagai lunas yang sudah dipastikan.
                  */
                  <span className="text-muted-foreground">Belum dikonfirmasi</span>
                )
              }
            />
          </dl>
        </section>
      </div>

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Notifikasi dari penyedia</h2>
        {webhooks.length === 0 ? (
          <EmptyState
            title="Belum ada notifikasi dari penyedia"
            description="Penyedia pembayaran belum mengirim pemberitahuan apa pun untuk transaksi ini. Kalau pelanggan mengaku sudah membayar, minta bukti transfernya lalu periksa transaksinya langsung di dasbor penyedia."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {webhooks.map((event) => (
              <li key={event.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[13px] font-medium">{event.event_type}</span>
                  {event.provider_status ? (
                    <span className="text-muted-foreground text-[13px]">
                      status {event.provider_status}
                    </span>
                  ) : null}
                  {event.processed_at ? (
                    <span className="text-success text-[13px]">Sudah diproses</span>
                  ) : (
                    /*
                      Notifikasi yang belum diproses adalah keadaan yang perlu ditindaklanjuti,
                      bukan sekadar keterangan. Pelanggan bisa saja sudah membayar sementara
                      layanannya belum aktif.
                    */
                    <span className="text-warning text-[13px] font-medium">
                      Belum diproses
                    </span>
                  )}
                  <span className="text-muted-foreground ml-auto text-[12px]">
                    <Timestamp value={event.created_at} />
                  </span>
                </div>

                <dl className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
                  <Row
                    label="Nomor peristiwa"
                    value={<span className="tabular">{event.provider_event_id ?? "Tidak ada"}</span>}
                  />
                  <Row
                    label="Asal"
                    value={<span className="tabular">{event.ip_address ?? "Tidak tercatat"}</span>}
                  />
                </dl>

                {event.processing_error ? (
                  <p className="text-destructive text-[12px] leading-relaxed">
                    Gagal diproses: {event.processing_error}
                  </p>
                ) : null}

                <details className="text-[12px]">
                  <summary className="text-muted-foreground cursor-pointer underline-offset-4 hover:underline">
                    Isi notifikasi
                  </summary>
                  <pre className="bg-muted mt-2 overflow-x-auto rounded-md p-3 text-[12px] leading-relaxed">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Panggilan ke penyedia</h2>
        {calls.length === 0 ? (
          <EmptyState
            title="Belum ada panggilan ke penyedia"
            description="Transaksi ini belum pernah membuat atau memeriksa transaksi di sisi penyedia pembayaran. Pembayaran yang tidak punya catatan panggilan berarti pelanggan tidak pernah sampai ke halaman bayar."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {calls.map((call) => (
              <li key={call.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[13px] font-medium">
                    {OPERATION_LABELS[call.operation] ?? call.operation}
                  </span>
                  <span
                    className={
                      call.outcome === "failed"
                        ? "text-destructive text-[13px] font-medium"
                        : "text-success text-[13px]"
                    }
                  >
                    {call.outcome === "failed" ? "Gagal" : "Berhasil"}
                  </span>
                  <span className="text-muted-foreground text-[13px]">
                    {call.http_status !== null ? `HTTP ${call.http_status}` : "Tanpa balasan"} dalam{" "}
                    <span className="tabular">{call.duration_ms.toLocaleString("id-ID")} milidetik</span>
                  </span>
                  <span className="text-muted-foreground ml-auto text-[12px]">
                    <Timestamp value={call.created_at} />
                  </span>
                </div>

                {call.error_message ? (
                  <p className="text-destructive text-[12px] leading-relaxed">
                    {call.error_message}
                  </p>
                ) : null}

                <details className="text-[12px]">
                  <summary className="text-muted-foreground cursor-pointer underline-offset-4 hover:underline">
                    Isi permintaan dan balasan
                  </summary>
                  {/*
                    Kunci API tidak pernah tersimpan; nilainya sudah diganti "[disaring]" saat
                    penulisan. Yang ditampilkan di sini adalah isi yang sudah aman.
                  */}
                  <div className="mt-2 flex flex-col gap-2">
                    <div>
                      <p className="text-muted-foreground mb-1">Permintaan</p>
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 leading-relaxed">
                        {JSON.stringify(call.request_body, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-muted-foreground mb-1">Balasan</p>
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 leading-relaxed">
                        {JSON.stringify(call.response_body, null, 2)}
                      </pre>
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Refund</h2>
        {refunds.length === 0 ? (
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Pembayaran ini belum punya catatan refund.
            {canRefund
              ? " Kalau dananya memang dikembalikan, jalankan pengembaliannya di dasbor penyedia pembayaran lalu catat di sini supaya laporan pengembalian dana dan alasan keputusannya tersimpan."
              : " Refund hanya dapat dicatat untuk pembayaran yang sudah lunas."}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {refunds.map((refund) => (
              <li key={refund.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Money value={Number(refund.amount)} />
                  <span className="text-[13px] font-medium">
                    {REFUND_STATUS_LABELS[refund.status] ?? refund.status}
                  </span>
                  <span className="text-muted-foreground ml-auto text-[12px]">
                    Dicatat <Timestamp value={refund.created_at} />
                  </span>
                </div>
                <dl className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
                  <Row
                    label="Nomor rujukan penyedia"
                    value={<span className="tabular">{refund.provider_refund_id ?? "Tidak ada"}</span>}
                  />
                  <Row
                    label="Selesai pada"
                    value={
                      <Timestamp
                        value={refund.completed_at}
                        fallback="Belum selesai, belum masuk laporan"
                      />
                    }
                  />
                  <Row
                    label="Dicatat oleh"
                    value={refund.requested_by ?? "Tidak tercatat"}
                  />
                </dl>
                <p className="text-[12px] leading-relaxed">
                  <span className="text-muted-foreground">Alasan: </span>
                  {refund.reason}
                </p>
                {/* Refund yang belum selesai tidak muncul di laporan, dan itu disebutkan. */}
                {refund.status !== "completed" ? (
                  <p className="text-muted-foreground text-[12px] leading-relaxed">
                    Refund ini belum dihitung pada laporan pengembalian dana. Laporan memakai
                    dasar kas dan mengakui refund pada tanggal selesainya.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <RefundDialog
        open={refundOpen}
        paymentId={payment.id}
        maxAmount={netAmount}
        onClose={() => setRefundOpen(false)}
        onDone={() => {
          setRefundOpen(false);
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

function RefundDialog({
  open,
  paymentId,
  maxAmount,
  onClose,
  onDone,
}: {
  open: boolean;
  paymentId: string;
  maxAmount: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<RefundValues>({
    resolver: zodResolver(refundForm),
    defaultValues: {
      amount: String(maxAmount),
      provider_refund_id: "",
      status: "completed",
      reason: "",
    },
  });

  async function submit(values: RefundValues) {
    try {
      const result = await mutate<{ note?: string }>(
        `/api/v1/admin/payments/${paymentId}/refund`,
        {
          method: "POST",
          body: { ...values, amount: Number(values.amount) },
        },
      );
      notifySuccess("Refund tercatat", result.note);
      reset();
      onDone();
    } catch (error) {
      notifyError("Refund gagal dicatat", toErrorMessage(error));
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
          <DialogTitle>Catat refund</DialogTitle>
          <DialogDescription>
            Konsol ini mencatat refund, tidak memindahkan dana. Jalankan pengembaliannya lebih
            dulu di dasbor penyedia pembayaran, lalu isi catatannya di sini.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <TextField<RefundValues>
            control={control}
            name="amount"
            label="Nominal refund"
            inputMode="numeric"
            hint={`Maksimal ${maxAmount.toLocaleString("id-ID")}, yaitu nominal tagihan yang benar-benar dibayar. Biaya layanan penyedia tidak termasuk, karena dana itu tidak pernah diterima sebagai pendapatan.`}
            required
          />

          <TextField<RefundValues>
            control={control}
            name="provider_refund_id"
            label="Nomor rujukan refund dari penyedia"
            placeholder="Contoh: nomor refund yang tertera di dasbor Pakasir"
            hint="Dipakai untuk mencocokkan catatan ini dengan mutasi di dasbor penyedia saat diperiksa."
            required
          />

          <SelectField<RefundValues>
            control={control}
            name="status"
            label="Status di penyedia"
            placeholder="Pilih status refund"
            options={[
              { value: "completed", label: "Selesai, dana sudah kembali" },
              { value: "pending", label: "Belum selesai, masih diproses penyedia" },
              { value: "failed", label: "Gagal" },
            ]}
            hint="Refund berstatus belum selesai tidak dihitung pada laporan sampai statusnya diperbarui."
            required
          />

          <TextAreaField<RefundValues>
            control={control}
            name="reason"
            label="Alasan refund"
            placeholder="Contoh: pelanggan membatalkan langganan dan meminta uangnya kembali"
            hint="Tersimpan pada jejak audit dan ikut tampil di laporan pengembalian dana."
            required
          />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Menyimpan" /> : null}
              Simpan catatan refund
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

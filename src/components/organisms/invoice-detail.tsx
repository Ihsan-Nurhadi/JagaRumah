"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, FieldMessage, Money, Spinner, Timestamp } from "@/components/atoms";
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
import { notifyError, notifySuccess } from "@/lib/alert";
import { toErrorMessage } from "@/lib/http";
import { mutate, useApiQuery } from "@/lib/use-api";

/*
  Detail tagihan.

  Bagian yang paling berguna di halaman ini adalah daftar percobaan pembayaran. Satu tagihan
  biasanya melewati beberapa percobaan, karena pelanggan membuka halaman bayar, menutupnya, lalu
  kembali lagi. Pertanyaan "pelanggan mengaku sudah bayar, kenapa tagihannya masih terbuka"
  hampir selalu terjawab di daftar itu.

  Biaya layanan ditampilkan terpisah dari nominal tagihan, tidak dijumlahkan. Yang benar-benar
  dibayar pelanggan lebih besar daripada nominal tagihan, dan menampilkan satu angka gabungan
  akan membuat tagihan tidak pernah cocok dengan mutasi bank pelanggan.
*/

type Detail = {
  invoice: {
    id: string;
    invoice_number: string | null;
    status: string;
    currency: string;
    total_amount: string;
    amount_paid: string;
    due_at: string | null;
    period_start: string | null;
    period_end: string | null;
    paid_at: string | null;
    voided_at: string | null;
    created_at: string;
  };
  customer: { id: string; full_name: string | null };
  subscription: { id: string; plan_name: string | null } | null;
  items: {
    id: string;
    description: string;
    quantity: number;
    unit_amount: string;
    total_amount: string;
    metadata: unknown;
  }[];
  payment_attempts: {
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
  }[];
};

/*
  Cara pembayaran memakai kode Pakasir apa adanya, lalu diterjemahkan ke nama yang dikenali
  operator. Kode yang tidak dikenali ditampilkan apa adanya, bukan ditebak.
*/
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

/*
  Pemicu verifikasi diterjemahkan karena ini yang menentukan seberapa kuat keyakinan bahwa
  pembayaran benar-benar sah. Konfirmasi lewat pemeriksaan ulang ke penyedia lebih kuat daripada
  yang hanya mengandalkan notifikasi masuk.
*/
const VERIFIED_VIA_LABELS: Record<string, string> = {
  webhook: "notifikasi penyedia",
  reconciliation: "rekonsiliasi berkala",
  sync: "pemeriksaan manual",
};

const voidForm = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

type VoidValues = z.infer<typeof voidForm>;

export function InvoiceDetail({ invoiceId }: { invoiceId: string }) {
  const query = useApiQuery<Detail>(`/api/v1/admin/invoices/${invoiceId}`);
  const [voidOpen, setVoidOpen] = useState(false);

  if (query.status === "memuat") return <LoadingState label="Memuat data tagihan" />;

  if (query.status === "galat" || !query.data) {
    return (
      <ErrorState
        title="Data tagihan gagal dimuat"
        description={query.error ?? "Server tidak mengirim keterangan galat."}
        onRetry={query.reload}
      />
    );
  }

  const { invoice, customer, items, payment_attempts: attempts } = query.data;
  const paidAmount = Number(invoice.amount_paid);
  const outstanding = Number(invoice.total_amount) - paidAmount;

  /*
    Pembatalan hanya masuk akal untuk tagihan yang masih menuntut pembayaran. Tombol untuk
    tagihan yang sudah lunas atau sudah dibatalkan tidak ditampilkan sama sekali, karena server
    akan menolaknya, dan tombol yang pasti gagal adalah kontrol mati.
  */
  const canVoid = invoice.status === "open" || invoice.status === "past_due";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link
          href="/invoices"
          className="text-muted-foreground inline-flex w-fit items-center gap-1.5 text-[13px] underline-offset-4 hover:underline"
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Daftar tagihan
        </Link>

        <PageHeader
          title={invoice.invoice_number ?? "Tagihan tanpa nomor"}
          description={`Diterbitkan ${new Date(invoice.created_at).toLocaleDateString("id-ID", { dateStyle: "long", timeZone: "Asia/Jakarta" })}`}
          actions={
            <div className="flex items-center gap-3">
              <StatusLabel kind="invoice" value={invoice.status} />
              {canVoid ? (
                <Button variant="destructive" onClick={() => setVoidOpen(true)}>
                  Batalkan tagihan
                </Button>
              ) : null}
            </div>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Ringkasan</h2>
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
              label="Langganan"
              value={
                query.data.subscription ? (
                  <Link
                    href={`/subscriptions/${query.data.subscription.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {query.data.subscription.plan_name ?? "Langganan"}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Tidak terhubung langganan</span>
                )
              }
            />
            <Row label="Jumlah tagihan" value={<Money value={Number(invoice.total_amount)} />} />
            <Row
              label="Sudah dibayar"
              value={
                paidAmount > 0 ? (
                  <Money value={paidAmount} />
                ) : (
                  <span className="text-muted-foreground">Belum ada pembayaran</span>
                )
              }
            />
            <Row
              label="Sisa tagihan"
              value={
                outstanding > 0 ? (
                  <Money value={outstanding} />
                ) : (
                  <span className="text-success">Tidak ada sisa</span>
                )
              }
            />
            <Row label="Jatuh tempo" value={<Timestamp value={invoice.due_at} fallback="Tanpa jatuh tempo" />} />
            <Row label="Dibayar pada" value={<Timestamp value={invoice.paid_at} fallback="Belum dibayar" />} />
            {invoice.voided_at ? (
              <Row label="Dibatalkan pada" value={<Timestamp value={invoice.voided_at} />} />
            ) : null}
            <Row label="Periode" value={<Period start={invoice.period_start} end={invoice.period_end} />} />
          </dl>
        </section>

        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Rincian tagihan</h2>
          {items.length === 0 ? (
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              Tagihan ini tidak memiliki rincian butir. Jumlahnya diambil dari kolom jumlah
              tagihan, bukan dari penjumlahan butir.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {items.map((item) => (
                <li key={item.id} className="flex flex-col gap-1 py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="text-[13px] font-medium">{item.description}</span>
                    <Money value={Number(item.total_amount)} />
                  </div>
                  <span className="text-muted-foreground tabular text-[12px]">
                    {item.quantity} kali <Money value={Number(item.unit_amount)} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-base font-semibold">Percobaan pembayaran</h2>
          {attempts.length > 0 ? (
            <span className="text-muted-foreground text-[13px]">
              {attempts.length} percobaan
            </span>
          ) : null}
        </div>

        {attempts.length === 0 ? (
          <EmptyState
            title="Belum ada percobaan pembayaran"
            description="Pelanggan belum membuka halaman pembayaran untuk tagihan ini. Kalau pelanggan mengaku sudah membayar, pastikan ia memakai tagihan yang benar."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {attempts.map((attempt) => (
              <li key={attempt.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[13px] font-medium">
                    Percobaan ke {attempt.attempt_sequence}
                  </span>
                  <StatusLabel kind="payment" value={attempt.status} />
                  <span className="text-muted-foreground text-[13px]">
                    {attempt.payment_method
                      ? (METHOD_LABELS[attempt.payment_method] ?? attempt.payment_method)
                      : "Cara bayar tidak dicatat"}
                  </span>
                  <span className="text-muted-foreground ml-auto text-[12px]">
                    Dibuat <Timestamp value={attempt.created_at} />
                  </span>
                </div>

                <dl className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
                  <Row label="Nomor pesanan" value={<span className="tabular">{attempt.provider_order_id ?? "Tidak ada"}</span>} />
                  <Row label="Nominal tagihan" value={<Money value={Number(attempt.amount)} />} />
                  <Row
                    label="Biaya layanan"
                    value={
                      attempt.provider_fee ? (
                        <Money value={Number(attempt.provider_fee)} />
                      ) : (
                        <span className="text-muted-foreground">Tidak dicatat</span>
                      )
                    }
                  />
                  <Row
                    label="Total dibayar pelanggan"
                    value={
                      attempt.provider_total_payment ? (
                        <Money value={Number(attempt.provider_total_payment)} />
                      ) : (
                        <span className="text-muted-foreground">Belum diketahui</span>
                      )
                    }
                  />
                  <Row label="Kedaluwarsa" value={<Timestamp value={attempt.expires_at} fallback="Tanpa batas waktu" />} />
                  <Row label="Dibayar" value={<Timestamp value={attempt.paid_at} fallback="Belum dibayar" />} />
                  <Row
                    label="Terverifikasi"
                    value={
                      attempt.verified_at ? (
                        <span>
                          <Timestamp value={attempt.verified_at} />
                          {attempt.verified_via ? (
                            <span className="text-muted-foreground">
                              {", lewat "}
                              {VERIFIED_VIA_LABELS[attempt.verified_via] ?? attempt.verified_via}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        /*
                          Belum terverifikasi berbeda dari gagal. Pembayaran yang belum
                          dikonfirmasi penyedia tidak boleh dianggap lunas, dan perbedaan itu
                          disampaikan supaya operator tidak menyimpulkan yang keliru.
                        */
                        <span className="text-muted-foreground">Belum dikonfirmasi penyedia</span>
                      )
                    }
                  />
                </dl>

                {attempt.status === "pending" ? (
                  <p className="text-muted-foreground text-[12px] leading-relaxed">
                    Pelanggan mungkin masih menyelesaikan pembayaran ini. Tagihan baru menjadi
                    lunas setelah penyedia pembayaran mengonfirmasinya.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Total yang dibayar pelanggan lebih besar daripada nominal tagihan, karena penyedia
          pembayaran menambahkan biaya layanan. Yang dihitung sebagai pendapatan langganan hanya
          nominal tagihan.
        </p>
      </section>

      <VoidDialog
        open={voidOpen}
        invoiceId={invoice.id}
        invoiceNumber={invoice.invoice_number}
        onClose={() => setVoidOpen(false)}
        onDone={() => {
          setVoidOpen(false);
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
  Periode penagihan bisa hanya punya salah satu ujungnya terisi, tergantung cara tagihan
  diterbitkan. Menampilkan tanda hubung untuk ujung yang ada akan menyembunyikan informasi,
  jadi tiap ujung diperiksa sendiri.
*/
function Period({ start, end }: { start: string | null; end: string | null }) {
  if (!start && !end) {
    return <span className="text-muted-foreground">Tidak terikat periode</span>;
  }
  return (
    <span className="flex flex-wrap items-baseline justify-end gap-1">
      {start ? <Timestamp value={start} /> : <span className="text-muted-foreground">Tanpa awal</span>}
      <span className="text-muted-foreground">sampai</span>
      {end ? <Timestamp value={end} /> : <span className="text-muted-foreground">tanpa akhir</span>}
    </span>
  );
}

function VoidDialog({
  open,
  invoiceId,
  invoiceNumber,
  onClose,
  onDone,
}: {
  open: boolean;
  invoiceId: string;
  invoiceNumber: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<VoidValues>({
    resolver: zodResolver(voidForm),
    defaultValues: { reason: "" },
  });

  async function submit(values: VoidValues) {
    try {
      const result = await mutate<{ effect?: { note?: string } }>(
        `/api/v1/admin/invoices/${invoiceId}/void`,
        { method: "POST", body: values },
      );
      notifySuccess("Tagihan dibatalkan", result.effect?.note);
      reset();
      onDone();
    } catch (error) {
      notifyError("Tagihan gagal dibatalkan", toErrorMessage(error));
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
          <DialogTitle>Batalkan tagihan {invoiceNumber ?? "ini"}?</DialogTitle>
          <DialogDescription>
            Tagihan yang dibatalkan tidak akan ditagih lagi dan tidak dapat dihidupkan kembali
            dari konsol ini. Pelanggan tidak lagi berkewajiban membayarnya.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <FieldMessage>
            Pembatalan tidak mengembalikan uang. Kalau dana memang sudah diterima dan akan
            dikembalikan, jalurnya adalah refund pada pembayarannya, bukan pembatalan tagihan.
          </FieldMessage>

          <TextField<VoidValues>
            control={control}
            name="reason"
            label="Alasan pembatalan"
            placeholder="Contoh: pelanggan batal berlangganan sebelum melakukan pembayaran"
            hint="Tersimpan pada jejak audit."
            required
          />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" variant="destructive" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Memproses" /> : null}
              Batalkan tagihan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

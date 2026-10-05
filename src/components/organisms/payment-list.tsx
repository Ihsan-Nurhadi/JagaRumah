"use client";

import Link from "next/link";

import { Money, Timestamp } from "@/components/atoms";
import {
  type Column,
  DataTable,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  StatCard,
  StatusLabel,
  statusTone,
  type FilterDefinition,
} from "@/components/molecules";
import { formatNumber } from "@/lib/format";
import { tableStatus, usePagedQuery } from "@/lib/use-api";

/*
  Daftar pembayaran.

  Dua kolom uang ditampilkan berdampingan dan itu memang disengaja: nominal tagihan dan total
  yang dibayar pelanggan. Penyedia pembayaran menambahkan biaya layanan di atas nominal tagihan,
  sehingga pelanggan mentransfer angka yang lebih besar daripada nilai tagihannya. Kalau hanya
  satu angka yang ditampilkan, operator akan mengira ada kelebihan bayar setiap kali pelanggan
  mengirim bukti transfer.

  Kolom "dikonfirmasi penyedia" memisahkan pembayaran yang keyakinannya kuat dari yang lemah.
  Notifikasi penyedia tidak bertanda tangan, sehingga pembayaran yang baru masuk lewat notifikasi
  belum benar-benar dipastikan.
*/

type Row = {
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
  invoice: { id: string; invoice_number: string | null; status: string };
  customer: { id: string; full_name: string | null };
};

type Response = {
  payments: Row[];
  summary: {
    total: number;
    pending: number;
    paid: number;
    expired: number;
    failed: number;
    canceled: number;
    unverified_paid: number;
  };
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

export function PaymentList() {
  const query = usePagedQuery<Response>("/api/v1/admin/payments");

  const filters: FilterDefinition[] = [
    {
      kind: "search",
      key: "q",
      label: "Cari pembayaran",
      placeholder: "Nomor pesanan, nomor tagihan, atau nama pelanggan",
    },
    {
      kind: "select",
      key: "status",
      label: "Status",
      anyLabel: "Semua status",
      options: [
        { value: "paid", label: "Lunas" },
        { value: "pending", label: "Menunggu pembayaran" },
        { value: "expired", label: "Kedaluwarsa" },
        { value: "failed", label: "Gagal" },
        { value: "canceled", label: "Dibatalkan" },
      ],
    },
    {
      kind: "select",
      key: "verified_via",
      label: "Cara dikonfirmasi",
      anyLabel: "Semua cara",
      options: [
        { value: "webhook", label: "Notifikasi penyedia" },
        { value: "reconciliation", label: "Rekonsiliasi berkala" },
        { value: "sync", label: "Pemeriksaan manual" },
      ],
    },
  ];

  const rows = query.data?.payments ?? [];
  const summary = query.data?.summary;

  const columns: Column<Row>[] = [
    {
      key: "order",
      header: "Nomor pesanan",
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <Link
            href={`/payments/${row.id}`}
            className="tabular font-medium underline-offset-4 hover:underline"
          >
            {row.provider_order_id ?? "Tanpa nomor"}
          </Link>
          <span className="text-muted-foreground text-[12px]">
            Percobaan ke {row.attempt_sequence} untuk{" "}
            <Link
              href={`/invoices/${row.invoice.id}`}
              className="underline-offset-4 hover:underline"
            >
              {row.invoice.invoice_number ?? "tagihan tanpa nomor"}
            </Link>
          </span>
        </div>
      ),
    },
    {
      key: "customer",
      header: "Pelanggan",
      cell: (row) => (
        <Link
          href={`/customers/${row.customer.id}`}
          className="underline-offset-4 hover:underline"
        >
          {row.customer.full_name}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => <StatusLabel kind="payment" value={row.status} />,
    },
    {
      key: "amount",
      header: "Nominal tagihan",
      cell: (row) => <Money value={Number(row.amount)} />,
    },
    {
      key: "total_paid",
      header: "Dibayar pelanggan",
      cell: (row) =>
        row.provider_total_payment ? (
          <div className="flex flex-col gap-0.5">
            <Money value={Number(row.provider_total_payment)} />
            {row.provider_fee ? (
              <span className="text-muted-foreground text-[12px]">
                termasuk biaya layanan <Money value={Number(row.provider_fee)} />
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground text-[13px]">Belum diketahui</span>
        ),
    },
    {
      key: "payment_method",
      header: "Cara bayar",
      cell: (row) =>
        row.payment_method ? (
          METHOD_LABELS[row.payment_method] ?? row.payment_method
        ) : (
          <span className="text-muted-foreground text-[13px]">Tidak dicatat</span>
        ),
    },
    {
      key: "verified",
      header: "Dikonfirmasi penyedia",
      cell: (row) =>
        row.verified_at ? (
          <Timestamp value={row.verified_at} />
        ) : (
          /*
            Belum dikonfirmasi bukan berarti gagal. Pembayaran yang belum diperiksa ulang ke
            penyedia tidak boleh disimpulkan sebagai lunas, dan itu disampaikan apa adanya
            supaya operator tidak menarik kesimpulan yang keliru.
          */
          <span className="text-muted-foreground text-[13px]">Belum dikonfirmasi</span>
        ),
    },
    {
      key: "paid_at",
      header: "Dibayar pada",
      cell: (row) => <Timestamp value={row.paid_at} fallback="Belum dibayar" />,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pembayaran"
        description="Percobaan pembayaran pelanggan. Satu tagihan biasanya melewati beberapa percobaan, karena pelanggan bisa membuka halaman bayar lalu menutupnya dan kembali lagi."
        actions={
          <Link
            href="/provider-logs"
            className="text-[13px] underline-offset-4 hover:underline"
          >
            Lihat log komunikasi dengan penyedia
          </Link>
        }
      />

      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Lunas belum dikonfirmasi"
            value={summary ? formatNumber(summary.unverified_paid) : null}
            hint="Pembayaran yang belum pernah diperiksa ulang ke penyedia"
            tone={summary && summary.unverified_paid > 0 ? "warning" : "neutral"}
          />
          <StatCard
            label="Menunggu pembayaran"
            value={summary ? formatNumber(summary.pending) : null}
            hint="Pelanggan mungkin masih menyelesaikan pembayarannya"
          />
          <StatCard
            label="Kedaluwarsa"
            value={summary ? formatNumber(summary.expired) : null}
            hint="Batas waktu bayar terlewat tanpa pembayaran"
          />
          <StatCard
            label="Gagal"
            value={summary ? formatNumber(summary.failed) : null}
            hint="Percobaan yang ditolak penyedia pembayaran"
            tone={summary && summary.failed > 0 ? "danger" : "neutral"}
          />
        </div>
      )}

      <FilterBar
        filters={filters}
        values={{
          q: query.params.q as string | undefined,
          status: query.params.status as string | undefined,
          verified_via: query.params.verified_via as string | undefined,
        }}
        onChange={(next) => query.setParams(next)}
        onReset={() => query.setParams({})}
      />

      <DataTable
        label="Daftar pembayaran"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat daftar pembayaran"
        errorTitle="Daftar pembayaran gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) => statusTone("payment", row.status)}
        emptyState={
          query.params.q || query.params.status || query.params.verified_via ? (
            <EmptyState
              title="Tidak ada pembayaran yang cocok"
              description="Tidak ada pembayaran yang sesuai dengan filter yang dipasang. Pencarian memakai nomor pesanan, nomor tagihan, atau nama pelanggan. Bersihkan filter untuk melihat semuanya."
            />
          ) : (
            <EmptyState
              title="Belum ada pembayaran"
              description="Percobaan pembayaran dibuat ketika pelanggan membuka halaman bayar untuk sebuah tagihan. Paket Gratis tidak menerbitkan tagihan, jadi tidak ada yang perlu dibayar selama seluruh pelanggan memakai paket tersebut."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="pembayaran"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />
    </div>
  );
}

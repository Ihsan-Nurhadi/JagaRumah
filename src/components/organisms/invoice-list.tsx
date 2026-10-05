"use client";

import Link from "next/link";

import { Money, Timestamp } from "@/components/atoms";
import {
  Column,
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
  Daftar tagihan.

  Dua kolom uang ditampilkan berdampingan: jumlah tagihan dan jumlah yang sudah dibayar. Karena
  tagihan bisa dibayar sebagian, satu angka saja tidak cukup untuk menjawab "masih kurang berapa",
  dan operator perlu bisa menghitungnya sendiri dari layar tanpa membuka detail.

  Kolom percobaan pembayaran ada karena pelanggan yang mengaku sudah membayar hampir selalu
  berarti percobaannya kedaluwarsa. Melihat jumlah percobaan dan status terakhirnya langsung di
  daftar memangkas satu langkah penelusuran yang paling sering dilakukan.
*/

type Row = {
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
  customer: { id: string; full_name: string | null };
  subscription_id: string | null;
  plan_name: string | null;
  attempt_count: number;
  last_attempt_status: string | null;
};

type Response = {
  invoices: Row[];
  summary: {
    total: number;
    open: number;
    paid: number;
    past_due: number;
    void: number;
    uncollectible: number;
    outstanding_amount: string;
    paid_this_month_amount: string;
  };
};

const ATTEMPT_LABELS: Record<string, string> = {
  pending: "menunggu",
  paid: "berhasil",
  expired: "kedaluwarsa",
  failed: "gagal",
  canceled: "dibatalkan",
};

export function InvoiceList() {
  const query = usePagedQuery<Response>("/api/v1/admin/invoices");

  const filters: FilterDefinition[] = [
    {
      kind: "search",
      key: "q",
      label: "Cari tagihan",
      placeholder: "Nomor tagihan, atau nama pelanggan",
    },
    {
      kind: "select",
      key: "status",
      label: "Status",
      anyLabel: "Semua status",
      options: [
        { value: "open", label: "Belum dibayar" },
        { value: "past_due", label: "Lewat jatuh tempo" },
        { value: "paid", label: "Lunas" },
        { value: "void", label: "Dibatalkan" },
        { value: "uncollectible", label: "Tidak tertagih" },
        { value: "draft", label: "Draf" },
      ],
    },
  ];

  const rows = query.data?.invoices ?? [];
  const summary = query.data?.summary;

  const columns: Column<Row>[] = [
    {
      key: "invoice_number",
      header: "Nomor tagihan",
      cell: (row) =>
        row.invoice_number ? (
          <Link
            href={`/invoices/${row.id}`}
            className="tabular font-medium underline-offset-4 hover:underline"
          >
            {row.invoice_number}
          </Link>
        ) : (
          <Link href={`/invoices/${row.id}`} className="underline-offset-4 hover:underline">
            Buka tagihan
          </Link>
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
      cell: (row) => <StatusLabel kind="invoice" value={row.status} />,
    },
    {
      key: "total_amount",
      header: "Jumlah tagihan",
      cell: (row) => <Money value={Number(row.total_amount)} />,
    },
    {
      key: "amount_paid",
      header: "Sudah dibayar",
      cell: (row) =>
        Number(row.amount_paid) > 0 ? (
          <Money value={Number(row.amount_paid)} />
        ) : (
          <span className="text-muted-foreground text-[13px]">Belum ada</span>
        ),
    },
    {
      key: "attempts",
      header: "Percobaan bayar",
      cell: (row) =>
        row.attempt_count > 0 ? (
          <span className="text-[13px]">
            <span className="tabular">{formatNumber(row.attempt_count)} kali</span>
            {row.last_attempt_status ? (
              <span className="text-muted-foreground">
                {", terakhir "}
                {ATTEMPT_LABELS[row.last_attempt_status] ?? row.last_attempt_status}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground text-[13px]">Belum ada</span>
        ),
    },
    {
      key: "due_at",
      header: "Jatuh tempo",
      cell: (row) => <Timestamp value={row.due_at} fallback="Tanpa jatuh tempo" />,
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
        title="Tagihan"
        description="Tagihan pelanggan dan pembayarannya. Tagihan menjadi lunas hanya setelah pembayaran dikonfirmasi penyedia pembayaran, bukan ketika pelanggan menekan tombol bayar."
      />

      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Belum tertagih"
            value={summary ? formatNumber(Number(summary.outstanding_amount)) : null}
            hint="Total sisa tagihan yang masih menuntut pembayaran"
            tone={summary && Number(summary.outstanding_amount) > 0 ? "warning" : "neutral"}
          />
          <StatCard
            label="Lewat jatuh tempo"
            value={summary ? formatNumber(summary.past_due) : null}
            hint="Tagihan yang melewati tanggal jatuh tempo"
            tone={summary && summary.past_due > 0 ? "danger" : "neutral"}
          />
          <StatCard
            label="Lunas bulan ini"
            value={summary ? formatNumber(Number(summary.paid_this_month_amount)) : null}
            hint="Dihitung dari jumlah yang benar-benar dibayar pelanggan"
          />
          <StatCard
            label="Belum dibayar"
            value={summary ? formatNumber(summary.open) : null}
            hint="Tagihan yang masih dalam masa jatuh tempo"
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
        label="Daftar tagihan"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat daftar tagihan"
        errorTitle="Daftar tagihan gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) => statusTone("invoice", row.status)}
        emptyState={
          query.params.q || query.params.status ? (
            <EmptyState
              title="Tidak ada tagihan yang cocok"
              description="Tidak ada tagihan yang sesuai dengan filter yang dipasang. Pencarian memakai nomor tagihan atau nama pelanggan. Bersihkan filter untuk melihat seluruh tagihan."
            />
          ) : (
            <EmptyState
              title="Belum ada tagihan"
              description="Tagihan diterbitkan saat pelanggan berlangganan paket berbayar. Paket Gratis tidak menerbitkan tagihan, jadi daftar ini akan tetap kosong selama seluruh pelanggan memakai paket tersebut."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="tagihan"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />

      <p className="text-muted-foreground text-[13px] leading-relaxed">
        Biaya layanan penyedia pembayaran tidak dihitung sebagai pendapatan langganan. Yang
        dihitung adalah nominal tagihan yang benar-benar dibayar, tanpa biaya layanan di atasnya.
      </p>
    </div>
  );
}

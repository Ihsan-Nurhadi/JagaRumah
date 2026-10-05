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
  Daftar langganan.

  Kolom "masa berlaku" menampilkan tanggal berakhir, dan untuk paket gratis menampilkan bahwa
  langganan itu tidak berakhir. Perbedaan ini penting: paket gratis tidak punya masa berlaku,
  jadi menampilkan tanda hubung atau tanggal kosong akan membuatnya tampak bermasalah.

  Kolom "kuota perangkat" menampilkan terpakai dibanding batas dalam satu sel. Dua angka itu
  tidak berguna bila dipisah, karena "2 perangkat" berarti apa pun tergantung batasnya.
*/

type Row = {
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
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  created_at: string;
};

type Response = {
  subscriptions: Row[];
  summary: {
    total: number;
    active: number;
    past_due: number;
    canceled: number;
    expired: number;
    ending_soon: number;
  };
};

const INTERVALS: Record<string, string> = {
  monthly: "per bulan",
  yearly: "per tahun",
};

export function SubscriptionList() {
  const query = usePagedQuery<Response>("/api/v1/admin/subscriptions");

  const filters: FilterDefinition[] = [
    {
      kind: "search",
      key: "q",
      label: "Cari pelanggan",
      placeholder: "Nama pelanggan",
    },
    {
      kind: "select",
      key: "status",
      label: "Status langganan",
      anyLabel: "Semua status",
      options: [
        { value: "active", label: "Berjalan" },
        { value: "trialing", label: "Masa uji" },
        { value: "past_due", label: "Menunggak" },
        { value: "canceled", label: "Dibatalkan" },
        { value: "expired", label: "Berakhir" },
      ],
    },
  ];

  const rows = query.data?.subscriptions ?? [];
  const summary = query.data?.summary;

  const columns: Column<Row>[] = [
    {
      key: "customer",
      header: "Pelanggan",
      cell: (row) => (
        <Link
          href={`/customers/${row.customer.id}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {row.customer.full_name}
        </Link>
      ),
    },
    {
      key: "plan",
      header: "Paket",
      cell: (row) =>
        row.plan.name ? (
          <Link
            href={`/subscriptions/${row.id}`}
            className="underline-offset-4 hover:underline"
          >
            {row.plan.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">Paket tidak diketahui</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <div className="flex flex-col items-start gap-1">
          <StatusLabel kind="subscription" value={row.status} />
          {/*
            Langganan yang sudah dijadwalkan berhenti tetap berstatus berjalan sampai masa
            berakhirnya. Tanpa keterangan tambahan ini, operator akan mengira pembatalannya gagal.
          */}
          {row.cancel_at_period_end ? (
            <span className="text-muted-foreground text-[12px]">
              Berhenti di akhir masa berlaku
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: "devices",
      header: "Kuota perangkat",
      cell: (row) => (
        <span className="tabular">
          {formatNumber(row.active_device_count)} dari{" "}
          {row.plan.device_limit_unlimited
            ? "tanpa batas"
            : formatNumber(row.plan.device_limit ?? 0)}
        </span>
      ),
    },
    {
      key: "price",
      header: "Harga",
      cell: (row) =>
        row.price_amount ? (
          <span className="flex flex-col">
            <Money value={Number(row.price_amount)} />
            <span className="text-muted-foreground text-[12px]">
              {row.price_interval ? (INTERVALS[row.price_interval] ?? row.price_interval) : ""}
            </span>
          </span>
        ) : (
          /*
            Paket gratis tidak punya harga. Dikatakan apa adanya, bukan ditampilkan sebagai
            Rp0 supaya tidak terlihat seperti harga yang belum diisi.
          */
          <span className="text-muted-foreground text-[13px]">Tanpa biaya</span>
        ),
    },
    {
      key: "period",
      header: "Masa berlaku",
      cell: (row) =>
        row.current_period_end ? (
          <Timestamp value={row.current_period_end} />
        ) : (
          <span className="text-muted-foreground text-[13px]">Tidak berakhir</span>
        ),
    },
    {
      key: "started_at",
      header: "Mulai",
      cell: (row) => <Timestamp value={row.started_at} />,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Langganan"
        description="Langganan pelanggan, termasuk paket Gratis yang otomatis diberikan saat pendaftaran. Batas perangkat mengikuti paket, bukan langganan."
      />

      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Berjalan"
            value={summary ? formatNumber(summary.active) : null}
            hint="Langganan yang sedang aktif"
          />
          <StatCard
            label="Akan berakhir"
            value={summary ? formatNumber(summary.ending_soon) : null}
            hint="Berakhir dalam tujuh hari ke depan, perlu ditagih ulang"
            tone={summary && summary.ending_soon > 0 ? "warning" : "neutral"}
          />
          <StatCard
            label="Menunggak"
            value={summary ? formatNumber(summary.past_due) : null}
            hint="Pembayaran belum diterima sampai jatuh tempo"
            tone={summary && summary.past_due > 0 ? "danger" : "neutral"}
          />
          <StatCard
            label="Total langganan"
            value={summary ? formatNumber(summary.total) : null}
            hint="Termasuk yang sudah berakhir dan dibatalkan"
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
        label="Daftar langganan"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat daftar langganan"
        errorTitle="Daftar langganan gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) => statusTone("subscription", row.status)}
        emptyState={
          query.params.q || query.params.status ? (
            <EmptyState
              title="Tidak ada langganan yang cocok"
              description="Tidak ada langganan yang sesuai dengan filter yang dipasang. Pencarian memakai nama pelanggan. Bersihkan filter untuk melihat seluruh langganan."
            />
          ) : (
            <EmptyState
              title="Belum ada langganan"
              description="Langganan dibuat otomatis saat pelanggan mendaftar lewat aplikasi, dengan paket Gratis. Daftar ini akan terisi setelah pelanggan pertama mendaftar atau setelah langganan berbayar dibuat."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="langganan"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />
    </div>
  );
}

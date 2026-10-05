"use client";

import Link from "next/link";
import { PlusIcon } from "@phosphor-icons/react";

import { Button, Identifier, Timestamp } from "@/components/atoms";
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
import { tableStatus, usePagedQuery } from "@/lib/use-api";
import { formatNumber } from "@/lib/format";

/*
  Daftar perangkat.

  Halaman ini menjawab tiga pertanyaan yang muncul berurutan saat operator bekerja:

  1. Berapa perangkat yang siap dikirim? Itu angka "siap diklaim" di kartu ringkasan.
  2. Perangkat mana yang sedang terpasang, dan pada siapa?
  3. Kenapa satu perangkat tertentu tidak bisa diklaim? Jawabannya ada di tab log percobaan.

  Angka ringkasan dibaca server dari seluruh hasil filter, bukan dari halaman yang sedang
  terbuka. Tanpa itu, angka di atas tabel akan berubah setiap kali operator menekan "berikutnya",
  dan itu membuatnya tidak bisa dipercaya.
*/

type DeviceRow = {
  id: string;
  device_uid: string;
  serial_number: string;
  name: string | null;
  model: string | null;
  batch_number: string | null;
  status: string;
  claim_method: string | null;
  claimed_at: string | null;
  customer: { id: string; full_name: string | null } | null;
  created_at: string;
};

type DevicesResponse = {
  devices: DeviceRow[];
  summary: {
    total: number;
    in_stock: number;
    claimed: number;
    suspended: number;
    retired: number;
    unclaimed_with_active_code: number;
  };
};

/*
  Label cara perangkat sampai ke pelanggan.

  `null` berarti perangkat ditugaskan admin, bukan diklaim sendiri oleh pelanggan. Dua hal ini
  berbeda: yang pertama berarti perangkat tidak pernah melewati aplikasi customer, dan itu
  berguna diketahui saat menelusuri keluhan.
*/
function claimMethodLabel(row: DeviceRow): string {
  if (row.claim_method === "qr") return "Pindai QR";
  if (row.claim_method === "serial") return "Nomor seri";
  if (row.status === "claimed") return "Ditugaskan admin";
  return "Belum diklaim";
}

export function DeviceList() {
  const query = usePagedQuery<DevicesResponse>("/api/v1/admin/devices");

  const filters: FilterDefinition[] = [
    {
      kind: "search",
      key: "q",
      label: "Cari perangkat",
      placeholder: "Nomor seri atau nomor perangkat, contoh NYK-000001",
    },
    {
      kind: "select",
      key: "status",
      label: "Status",
      anyLabel: "Semua status",
      options: [
        { value: "in_stock", label: "Di gudang" },
        { value: "claimed", label: "Terpasang" },
        { value: "suspended", label: "Dinonaktifkan" },
        { value: "retired", label: "Tidak dipakai lagi" },
      ],
    },
  ];

  const rows = query.data?.devices ?? [];
  const summary = query.data?.summary;

  const columns: Column<DeviceRow>[] = [
    {
      key: "device_uid",
      header: "Nomor perangkat",
      cell: (row) => (
        <Link
          href={`/devices/${row.id}`}
          className="tabular font-medium underline-offset-4 hover:underline"
        >
          {row.device_uid}
        </Link>
      ),
    },
    {
      key: "serial_number",
      header: "Nomor seri",
      cell: (row) => <Identifier value={row.serial_number} />,
    },
    {
      key: "name",
      header: "Nama",
      cell: (row) =>
        row.name ?? <span className="text-muted-foreground">Belum diberi nama</span>,
    },
    {
      key: "model",
      header: "Model",
      cell: (row) => row.model ?? <span className="text-muted-foreground">Tidak dicatat</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => <StatusLabel kind="device" value={row.status} />,
    },
    {
      key: "customer",
      header: "Pelanggan",
      cell: (row) =>
        row.customer ? (
          <Link
            href={`/customers/${row.customer.id}`}
            className="underline-offset-4 hover:underline"
          >
            {row.customer.full_name}
          </Link>
        ) : (
          <span className="text-muted-foreground">Belum ada</span>
        ),
    },
    {
      key: "claim_method",
      header: "Cara masuk",
      cell: (row) => (
        <span className="text-muted-foreground text-[13px]">{claimMethodLabel(row)}</span>
      ),
    },
    {
      key: "claimed_at",
      header: "Terpasang sejak",
      cell: (row) => <Timestamp value={row.claimed_at} fallback="Belum terpasang" />,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Perangkat"
        description="Inventory perangkat CCTV. Perangkat didaftarkan di sini sebelum dapat diklaim pelanggan lewat aplikasi."
        actions={
          <Button asChild>
            <Link href="/devices/baru">
              <PlusIcon aria-hidden className="size-4" />
              Daftarkan perangkat
            </Link>
          </Button>
        }
      />

      {/*
        Kartu ringkasan disembunyikan saat galat, karena menampilkan "Belum diketahui" untuk
        semuanya hanya menambah kebisingan di layar yang sudah menjelaskan masalahnya.
      */}
      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Siap diklaim"
            value={summary ? formatNumber(summary.unclaimed_with_active_code) : null}
            hint="Perangkat di gudang yang kode claimnya masih berlaku"
          />
          <StatCard
            label="Terpasang"
            value={summary ? formatNumber(summary.claimed) : null}
            hint="Sudah dimiliki pelanggan"
          />
          <StatCard
            label="Dinonaktifkan"
            value={summary ? formatNumber(summary.suspended) : null}
            hint="Tidak dihitung dalam batas paket pelanggan"
          />
          <StatCard
            label="Total terdaftar"
            value={summary ? formatNumber(summary.total) : null}
            hint="Seluruh perangkat yang belum dihapus"
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
        label="Daftar perangkat"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat daftar perangkat"
        errorTitle="Daftar perangkat gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) => statusTone("device", row.status)}
        emptyState={
          /*
            Keadaan kosong dibedakan: belum ada perangkat sama sekali, atau filter yang tidak
            menemukan apa pun. Keduanya menuntut tindakan yang berbeda.
          */
          query.params.q || query.params.status ? (
            <EmptyState
              title="Tidak ada perangkat yang cocok"
              description="Tidak ada perangkat yang sesuai dengan filter yang dipasang. Bersihkan filter untuk melihat seluruh inventory."
            />
          ) : (
            <EmptyState
              title="Inventory masih kosong"
              description="Belum ada perangkat yang terdaftar. Daftarkan perangkat pertama, lalu cetak kode claimnya untuk ditempel pada label atau dus."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="perangkat"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />

      <p className="text-muted-foreground text-[13px] leading-relaxed">
        Kode claim hanya dapat ditampilkan sekali, yaitu saat perangkat didaftarkan atau saat
        kodenya dirotasi. Yang disimpan di server hanya sidik jarinya, jadi kode yang tidak sempat
        dicatat harus diganti dengan kode baru lewat halaman detail perangkat.
      </p>
    </div>
  );
}

"use client";

import Link from "next/link";

import { Timestamp } from "@/components/atoms";
import {
  type Column,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  PageHeader,
  Pagination,
  StatCard,
  type FilterDefinition,
} from "@/components/molecules";
import { formatNumber } from "@/lib/format";
import { tableStatus, useApiQuery, useClientPage } from "@/lib/use-api";

/*
  Log provider pembayaran.

  Halaman ini ada karena integrasi pembayaran punya dua arah komunikasi, dan keduanya perlu
  terlihat bersamaan untuk bisa disimpulkan:

  - Notifikasi yang dikirim penyedia ke kita, yaitu arah masuk.
  - Panggilan yang kita kirim ke penyedia, yaitu arah keluar.

  Keduanya digabung dalam satu daftar berurut waktu, bukan dipisah menjadi dua tabel. Urutan
  waktu itulah yang menunjukkan hubungan sebab akibat: notifikasi yang datang sebelum atau
  sesudah panggilan kita menentukan dari mana penelusurannya dimulai.

  Kolom yang paling penting adalah hasilnya, bukan isi payloadnya. Notifikasi penyedia tidak
  bertanda tangan, sehingga yang menentukan keyakinan adalah apakah notifikasi itu cocok dengan
  percobaan pembayaran yang benar-benar ada, atau justru tidak dikenal sama sekali.

  Batas jumlah baris dipatok di server. Halaman ini alat penelusuran, bukan penjelajah arsip:
  yang berguna adalah kejadian terakhir.
*/

type LogRow = {
  id: string;
  direction: "inbound" | "outbound";
  operation: string;
  order_id: string | null;
  provider_status: string | null;
  outcome: string;
  http_status: number | null;
  duration_ms: number | null;
  ip_address: string | null;
  error_message: string | null;
  occurred_at: string;
};

type Payload = {
  logs: LogRow[];
  meta: {
    shown: number;
    limit_per_direction: number;
    count_by_direction: { inbound: number; outbound: number };
    count_by_outcome: {
      verified: number;
      pending: number;
      rejected: number;
      unknown_order: number;
      success: number;
      failed: number;
    };
    note: string;
  };
  provider_health: {
    window_hours: number;
    by_operation: {
      operation: string;
      total: number;
      success: number;
      failed: number;
      avg_duration_ms: number | null;
      max_duration_ms: number | null;
      last_call_at: string | null;
      last_failure_at: string | null;
    }[];
  };
};

const OPERATION_LABELS: Record<string, string> = {
  webhook: "Notifikasi masuk",
  transactioncreate: "Membuat transaksi",
  transactioncancel: "Membatalkan transaksi",
  transactiondetail: "Memeriksa status transaksi",
  paymentsimulation: "Simulasi pembayaran",
};

/*
  Hasil ditampilkan dengan kata yang menyatakan apa artinya bagi operator, bukan kode mentahnya.
  "Ditolak" dan "nomor tidak dikenal" disebut terpisah karena keduanya menunjuk pada hal yang
  berbeda: yang pertama notifikasinya tidak cocok, yang kedua nomor pesanannya tidak pernah ada
  di sistem kita sama sekali.
*/
const OUTCOME_LABELS: Record<string, { label: string; tone: string }> = {
  verified: { label: "Cocok dan lolos pemeriksaan", tone: "text-success" },
  pending: { label: "Belum diproses", tone: "text-warning" },
  rejected: { label: "Ditolak saat pemeriksaan", tone: "text-destructive" },
  unknown_order: { label: "Nomor pesanan tidak dikenal", tone: "text-destructive" },
  success: { label: "Berhasil", tone: "text-success" },
  failed: { label: "Gagal", tone: "text-destructive" },
};

/*
  Ambang ini dipakai job rekonsiliasi sebagai batas panggilan yang dianggap menggantung. Angka
  yang sama dipakai di sini supaya yang dilihat operator sama dengan yang dipakai sistem untuk
  memutuskan ada yang tidak wajar.
*/
const SLOW_CALL_MS = 5000;

export function ProviderLogList() {
  const query = useApiQuery<Payload>("/api/v1/admin/provider-logs");

  const filters: FilterDefinition[] = [
    {
      kind: "search",
      key: "order_id",
      label: "Nomor pesanan",
      placeholder: "Contoh: INV-2026-0001-1",
    },
    {
      kind: "select",
      key: "direction",
      label: "Arah",
      anyLabel: "Kedua arah",
      options: [
        { value: "inbound", label: "Masuk dari penyedia" },
        { value: "outbound", label: "Keluar ke penyedia" },
      ],
    },
    {
      kind: "date",
      key: "from",
      label: "Dari tanggal",
    },
    {
      kind: "date",
      key: "to",
      label: "Sampai tanggal",
    },
  ];

  const rows = query.data?.logs ?? [];
  /*
    Server mematok 50 baris per arah, dan jumlah itu bisa berarti 100 baris di layar. Daftar
    yang sudah lengkap di memori dipotong di sini supaya penelusuran tidak berubah menjadi
    menggulir panjang.
  */
  const halaman = useClientPage(rows, 20);
  const meta = query.data?.meta;
  const health = query.data?.provider_health;

  const columns: Column<LogRow>[] = [
    {
      key: "occurred_at",
      header: "Waktu",
      cell: (row) => <Timestamp value={row.occurred_at} />,
    },
    {
      key: "direction",
      header: "Arah",
      cell: (row) =>
        row.direction === "inbound" ? "Masuk dari penyedia" : "Keluar ke penyedia",
    },
    {
      key: "operation",
      header: "Operasi",
      cell: (row) => OPERATION_LABELS[row.operation] ?? row.operation,
    },
    {
      key: "order_id",
      header: "Nomor pesanan",
      cell: (row) =>
        row.order_id ? (
          <span className="tabular">{row.order_id}</span>
        ) : (
          <span className="text-muted-foreground">Tidak ada</span>
        ),
    },
    {
      key: "outcome",
      header: "Hasil",
      cell: (row) => {
        const info = OUTCOME_LABELS[row.outcome];
        return (
          <span className={info ? info.tone : undefined}>
            {info?.label ?? row.outcome}
          </span>
        );
      },
    },
    {
      key: "duration",
      header: "Durasi",
      cell: (row) =>
        row.duration_ms === null ? (
          /* Notifikasi yang masuk tidak punya durasi, karena bukan kita yang memanggil. */
          <span className="text-muted-foreground">Tidak berlaku</span>
        ) : (
          <span
            className={
              row.duration_ms >= SLOW_CALL_MS
                ? "tabular text-warning font-medium"
                : "tabular"
            }
          >
            {row.duration_ms.toLocaleString("id-ID")} ms
          </span>
        ),
    },
    {
      key: "detail",
      header: "Keterangan",
      cell: (row) => {
        if (row.error_message) {
          return <span className="text-destructive">{row.error_message}</span>;
        }
        if (row.direction === "inbound") {
          return row.ip_address ? (
            <span className="tabular text-muted-foreground">{row.ip_address}</span>
          ) : (
            <span className="text-muted-foreground">Asal tidak tercatat</span>
          );
        }
        return row.http_status !== null ? (
          <span className="tabular">HTTP {row.http_status}</span>
        ) : (
          <span className="text-muted-foreground">Tanpa balasan</span>
        );
      },
    },
  ];

  if (query.status === "memuat") return <LoadingState label="Memuat log provider pembayaran" />;

  if (query.status === "galat" || !query.data) {
    return (
      <ErrorState
        title="Log provider pembayaran gagal dimuat"
        description={query.error ?? "Server tidak mengirim keterangan galat."}
        onRetry={query.reload}
      />
    );
  }

  const hasFilter = Boolean(query.params.order_id || query.params.direction || query.params.from || query.params.to);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Log provider pembayaran"
        description="Dua arah komunikasi dengan penyedia pembayaran: notifikasi yang masuk dari penyedia, dan panggilan yang keluar ke penyedia. Digabung berurut waktu supaya hubungan sebab akibatnya terlihat."
        actions={
          <Link href="/payments" className="text-[13px] underline-offset-4 hover:underline">
            Daftar pembayaran
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Belum diproses"
          value={meta ? formatNumber(meta.count_by_outcome.pending) : null}
          hint="Notifikasi yang sudah masuk tetapi belum tercermin di data"
          tone={meta && meta.count_by_outcome.pending > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="Ditolak saat pemeriksaan"
          value={meta ? formatNumber(meta.count_by_outcome.rejected) : null}
          hint="Notifikasi yang tidak cocok dengan percobaan pembayaran mana pun"
          tone={meta && meta.count_by_outcome.rejected > 0 ? "danger" : "neutral"}
        />
        <StatCard
          label="Nomor pesanan tidak dikenal"
          value={meta ? formatNumber(meta.count_by_outcome.unknown_order) : null}
          hint="Notifikasi untuk pesanan yang tidak pernah dibuat sistem"
          tone={meta && meta.count_by_outcome.unknown_order > 0 ? "danger" : "neutral"}
        />
        <StatCard
          label="Panggilan keluar gagal"
          value={meta ? formatNumber(meta.count_by_outcome.failed) : null}
          hint="Panggilan ke penyedia yang ditolak, gagal, atau kehabisan waktu"
          tone={meta && meta.count_by_outcome.failed > 0 ? "danger" : "neutral"}
        />
      </div>

      <FilterBar
        filters={filters}
        values={{
          order_id: query.params.order_id as string | undefined,
          direction: query.params.direction as string | undefined,
          from: query.params.from as string | undefined,
          to: query.params.to as string | undefined,
        }}
        onChange={(next) => query.setParams(next)}
        onReset={() => query.setParams({})}
      />

      <DataTable
        label="Log komunikasi dengan penyedia pembayaran"
        columns={columns}
        rows={halaman.rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat log provider pembayaran"
        errorTitle="Log provider pembayaran gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) =>
          row.outcome === "verified" || row.outcome === "success"
            ? "success"
            : row.outcome === "pending"
              ? "warning"
              : "danger"
        }
        emptyState={
          hasFilter ? (
            <EmptyState
              title="Tidak ada catatan yang cocok"
              description="Tidak ada komunikasi dengan penyedia pembayaran yang sesuai dengan filter yang dipasang. Pencarian nomor pesanan harus sama persis, karena nomor itu yang dipakai penyedia. Bersihkan filter untuk melihat catatan terakhir."
            />
          ) : (
            <EmptyState
              title="Belum ada komunikasi dengan penyedia"
              description="Belum ada notifikasi yang masuk maupun panggilan yang keluar. Keadaan ini wajar bila memang belum ada pelanggan yang mencoba membayar."
            />
          )
        }
      />

      <Pagination
        page={halaman.page}
        limit={halaman.limit}
        shown={halaman.rows.length}
        unit="baris log"
        hasMore={halaman.hasMore}
        onPrev={halaman.prevPage}
        onNext={halaman.nextPage}
        onLimitChange={halaman.setLimit}
      />

      {meta ? (
        <p className="text-muted-foreground text-[13px] leading-relaxed">{meta.note}</p>
      ) : null}

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">
            Kesehatan panggilan keluar, {health?.window_hours ?? 24} jam terakhir
          </h2>
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Panggilan terlama ditampilkan karena satu panggilan yang menggantung membuat
            pelanggan menutup halaman pembayarannya, dan itu tidak terlihat pada rata-rata.
          </p>
        </div>

        {!health || health.by_operation.length === 0 ? (
          <EmptyState
            title={`Belum ada panggilan dalam ${health?.window_hours ?? 24} jam terakhir`}
            description="Tidak ada panggilan keluar ke penyedia pembayaran pada periode ini. Keadaan ini wajar bila memang belum ada pelanggan yang membuka halaman bayar."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-[13px]">
              <caption className="sr-only">Kesehatan panggilan keluar ke penyedia pembayaran</caption>
              <thead>
                <tr className="text-muted-foreground border-b border-border text-left">
                  <th scope="col" className="py-2 pr-3 font-medium">Operasi</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Jumlah</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Gagal</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Rata-rata</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Terlama</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Gagal terakhir</th>
                </tr>
              </thead>
              <tbody>
                {health.by_operation.map((row) => (
                  <tr key={row.operation} className="border-b border-border last:border-0">
                    <td className="py-2.5 pr-3">
                      {OPERATION_LABELS[row.operation] ?? row.operation}
                    </td>
                    <td className="tabular py-2.5 pr-3">{formatNumber(row.total)}</td>
                    <td className="tabular py-2.5 pr-3">
                      {row.failed > 0 ? (
                        <span className="text-destructive font-medium">
                          {formatNumber(row.failed)}
                        </span>
                      ) : (
                        formatNumber(row.failed)
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      {row.avg_duration_ms === null ? (
                        <span className="text-muted-foreground">Belum ada data</span>
                      ) : (
                        <span className="tabular">
                          {row.avg_duration_ms.toLocaleString("id-ID")} ms
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      {row.max_duration_ms === null ? (
                        <span className="text-muted-foreground">Belum ada data</span>
                      ) : (
                        <span
                          className={
                            row.max_duration_ms >= SLOW_CALL_MS
                              ? "tabular text-warning font-medium"
                              : "tabular"
                          }
                        >
                          {row.max_duration_ms.toLocaleString("id-ID")} ms
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      {row.last_failure_at ? (
                        <Timestamp value={row.last_failure_at} />
                      ) : (
                        <span className="text-muted-foreground">Belum pernah gagal</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-muted-foreground text-[13px] leading-relaxed">
        Isi permintaan dan balasan lengkap ada di halaman detail tiap pembayaran. Kunci API tidak
        pernah tersimpan di database, jadi tidak ada yang perlu disamarkan saat ditampilkan.
      </p>
    </div>
  );
}

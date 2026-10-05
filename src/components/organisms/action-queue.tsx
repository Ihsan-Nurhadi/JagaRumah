"use client";

import Link from "next/link";

import { ErrorState, LoadingState, PageHeader, StatCard } from "@/components/molecules";
import { Timestamp } from "@/components/atoms";
import { formatNumber } from "@/lib/format";
import { useApiQuery } from "@/lib/use-api";

/*
  Antrian tindakan.

  Isinya hal-hal yang menunggu keputusan manusia, bukan sekadar hal yang tidak normal. Urutannya
  disengaja: yang paling atas adalah pelanggan yang sudah membayar dan belum menerima apa yang
  dibayarnya, lalu indikasi upaya pemalsuan, lalu hal-hal yang masih ada waktu.

  Setiap baris menautkan langsung ke objeknya. Antrian yang menautkan ke halaman kosong lebih
  buruk daripada antrian yang tidak ada, karena membuat operator percaya sudah menindaklanjuti
  padahal belum.
*/

type Item = {
  kind: string;
  severity: "high" | "medium" | "low";
  reference_id: string;
  reference_label: string | null;
  summary: string;
  occurred_at: string;
  action_label: string;
  action_href: string;
};

type Payload = {
  items: Item[];
  counts_by_kind: Record<string, number>;
  severity_meaning: Record<string, string>;
};

/*
  Nama jenis diterjemahkan supaya terbaca sebagai pekerjaan, bukan sebagai kode. Kode aslinya
  tetap dipakai untuk mengelompokkan.
*/
const KIND_LABELS: Record<string, string> = {
  unverified_payment: "Pembayaran belum dikonfirmasi penyedia",
  unknown_order_webhook: "Notifikasi mencurigakan",
  claim_anomaly: "Percobaan klaim mencurigakan",
  past_due_invoice: "Tagihan lewat jatuh tempo",
  expiring_subscription: "Langganan akan berakhir",
};

const SEVERITY_LABELS: Record<string, string> = {
  high: "Mendesak",
  medium: "Hari ini",
  low: "Masih ada waktu",
};

/*
  Warna severity hanya dipakai sebagai penanda tambahan, karena teks tingkatnya selalu
  ditampilkan di sebelahnya. Status yang hanya dibedakan warna tidak terbaca oleh sebagian
  orang, dan antrian tindakan adalah tempat yang paling tidak boleh ambigu.
*/
const SEVERITY_CLASSES: Record<string, string> = {
  high: "text-destructive",
  medium: "text-warning",
  low: "text-muted-foreground",
};

export function ActionQueue() {
  const query = useApiQuery<Payload>("/api/v1/admin/action-queue");

  if (query.status === "memuat") return <LoadingState label="Memuat daftar tindakan" />;

  if (query.status === "galat" || !query.data) {
    return (
      <ErrorState
        title="Daftar tindakan gagal dimuat"
        description={query.error ?? "Server tidak mengirim keterangan galat."}
        onRetry={query.reload}
      />
    );
  }

  const { items, counts_by_kind: counts, severity_meaning: meaning } = query.data;
  const mendesak = items.filter((item) => item.severity === "high").length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Perlu tindakan"
        description="Hal-hal yang menunggu keputusan manusia, terurut dari yang paling perlu ditangani lebih dulu. Setiap baris menyebut apa yang terjadi dan ke mana harus pergi untuk menanganinya."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Mendesak"
          value={formatNumber(mendesak)}
          hint={meaning.high ?? "Perlu ditangani lebih dulu"}
          tone={mendesak > 0 ? "danger" : "neutral"}
        />
        <StatCard
          label="Pembayaran belum dikonfirmasi"
          value={formatNumber(counts.unverified_payment ?? 0)}
          hint="Pelanggan sudah membayar dan belum menerima layanannya"
          tone={(counts.unverified_payment ?? 0) > 0 ? "danger" : "neutral"}
        />
        <StatCard
          label="Notifikasi mencurigakan"
          value={formatNumber(counts.unknown_order_webhook ?? 0)}
          hint="Notifikasi dengan nomor pesanan yang tidak dikenal sistem"
          tone={(counts.unknown_order_webhook ?? 0) > 0 ? "danger" : "neutral"}
        />
        <StatCard
          label="Tagihan lewat jatuh tempo"
          value={formatNumber(counts.past_due_invoice ?? 0)}
          hint="Tagihan yang melewati tanggal jatuh tempo dan belum dibayar"
          tone={(counts.past_due_invoice ?? 0) > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="Percobaan klaim mencurigakan"
          value={formatNumber(counts.claim_anomaly ?? 0)}
          hint="Percobaan klaim perangkat yang berulang atau dari luar kebiasaan"
          tone={(counts.claim_anomaly ?? 0) > 0 ? "danger" : "neutral"}
        />
        <StatCard
          label="Langganan akan berakhir"
          value={formatNumber(counts.expiring_subscription ?? 0)}
          hint="Langganan yang masa berlakunya habis dalam waktu dekat"
          tone={(counts.expiring_subscription ?? 0) > 0 ? "warning" : "neutral"}
        />
      </div>

      {items.length === 0 ? (
        <section className="bg-card flex flex-col gap-2 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Tidak ada yang menunggu tindakan</h2>
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Tidak ada pembayaran yang menggantung, notifikasi mencurigakan, tagihan lewat jatuh
            tempo, klaim yang melewati batas, maupun langganan yang hampir berakhir. Keadaan ini
            berarti semua yang perlu diputuskan sudah diputuskan.
          </p>
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Antrian ini diperiksa ulang setiap kali halaman dibuka, jadi tidak ada tombol muat
            ulang tersendiri. Buka ulang halamannya bila ingin melihat keadaan terbaru.
          </p>
        </section>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={`${item.kind}-${item.reference_id}`}
              className="bg-card flex flex-col gap-2 rounded-xl border border-border p-4"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span
                  className={`text-[12px] font-medium ${SEVERITY_CLASSES[item.severity] ?? ""}`}
                >
                  {SEVERITY_LABELS[item.severity] ?? item.severity}
                </span>
                <span className="text-[13px] font-medium">
                  {KIND_LABELS[item.kind] ?? item.kind}
                </span>
                {item.reference_label ? (
                  <span className="text-muted-foreground tabular text-[13px]">
                    {item.reference_label}
                  </span>
                ) : null}
                <span className="text-muted-foreground ml-auto text-[12px]">
                  <Timestamp value={item.occurred_at} />
                </span>
              </div>

              <p className="text-[13px] leading-relaxed">{item.summary}</p>

              <Link
                href={item.action_href}
                className="text-[13px] w-fit underline-offset-4 hover:underline"
              >
                {item.action_label}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="bg-card flex flex-col gap-2 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Arti tingkat urgensi</h2>
        <dl className="flex flex-col gap-1.5 text-[13px]">
          {(["high", "medium", "low"] as const).map((level) => (
            <div key={level} className="flex flex-wrap items-baseline gap-2">
              <dt className={`font-medium ${SEVERITY_CLASSES[level]}`}>
                {SEVERITY_LABELS[level]}
              </dt>
              <dd className="text-muted-foreground">{meaning[level]}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

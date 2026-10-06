"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeftIcon, ArrowsClockwiseIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, FieldMessage, Identifier, Spinner, Timestamp } from "@/components/atoms";
import {
  CustomerPicker,
  EmptyState,
  ErrorState,
  LoadingState,
  OncePanel,
  PageHeader,
  StatCard,
  StatusLabel,
  TextField,
  type CustomerChoice,
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
  Detail perangkat.

  Halaman ini punya satu alasan keberadaan yang utama: menjadi tempat menjawab "kenapa perangkat
  ini tidak bisa diklaim". Karena itu riwayat percobaan claim ditempatkan di bawah, bukan di
  tab terpisah, supaya terlihat tanpa satu klik tambahan saat sedang menelusuri keluhan.

  Keputusan yang perlu dijelaskan:

  - Keadaan koneksi tidak ditampilkan sebagai online atau offline. Backend belum menerima data
    apa pun dari perangkat, dan menampilkan "offline" untuk perangkat yang sebenarnya cuma belum
    terhubung ke sistem kita adalah kebohongan yang akan menyesatkan teknisi.
  - Kode claim tidak pernah ditampilkan sebagai nilai, hanya keadaannya. Server hanya menyimpan
    sidik jarinya, jadi kode yang tidak sempat dicatat memang tidak bisa ditemukan kembali.
    Halaman ini menyatakan itu apa adanya dan menawarkan rotasi sebagai jalan keluarnya.
  - Perangkat yang diklaim lewat aplikasi customer dan perangkat yang ditugaskan admin dibedakan.
    Keduanya berbeda asal-usulnya, dan itu berguna saat menelusuri keluhan.
*/

type Detail = {
  device: {
    id: string;
    device_uid: string;
    serial_number: string;
    name: string | null;
    model: string | null;
    hardware_revision: string | null;
    batch_number: string | null;
    mac_address: string | null;
    imei: string | null;
    status: string;
    claim_method: string | null;
    integration_ready: boolean;
    connection_status: "active" | "offline" | "unknown";
    recording_status: "recording" | "not_recording" | "unknown";
    stream_url: string | null;
    last_seen_at: string | null;
    warranty_start_at: string | null;
    warranty_ends_at: string | null;
    claimed_at: string | null;
    activated_at: string | null;
    deactivated_at: string | null;
    created_at: string;
    updated_at: string;
  };
  customer: { id: string; full_name: string | null; status: string | null } | null;
  registered_by: { id: string; full_name: string | null } | null;
  claim_code: {
    has_code: boolean;
    created_at?: string;
    is_used?: boolean;
    used_at?: string | null;
    used_by_customer_id?: string | null;
    used_by_name?: string | null;
    attempt_count?: number;
    can_be_shown_again: boolean;
  };
  claim_attempts: {
    id: string;
    success: boolean;
    failure_reason: string | null;
    submitted_kind: string;
    submitted_value_masked: string | null;
    ip_address: string | null;
    customer: { id: string; full_name: string | null } | null;
    created_at: string;
  }[];
  device_limit: {
    plan_name: string | null;
    limit: number | null;
    active_count: number;
    unlimited: boolean;
    remaining: number | null;
  } | null;
};

/*
  Nama teknis cara klaim diterjemahkan karena "qr" dan "serial" tidak berarti apa pun bagi
  operator. Nilai null punya arti sendiri di sini: perangkat ditugaskan admin, bukan diklaim.
*/
function claimMethodLabel(method: string | null, status: string): string {
  if (method === "qr") return "Dipindai pelanggan lewat kode QR";
  if (method === "serial") return "Diklaim pelanggan lewat nomor seri";
  if (status === "claimed") return "Ditugaskan langsung oleh admin";
  return "Belum pernah diklaim";
}

/*
  Alasan kegagalan claim diterjemahkan ke kalimat yang bisa ditindaklanjuti. Yang tidak dikenali
  ditampilkan apa adanya, karena menyamarkan kode yang tidak dikenal akan menyembunyikan masalah
  yang justru perlu dilaporkan ke tim teknis.
*/
const FAILURE_LABELS: Record<string, string> = {
  CODE_NOT_FOUND: "Kode tidak cocok dengan perangkat mana pun",
  CODE_ALREADY_USED: "Kode sudah dipakai sebelumnya",
  CODE_EXPIRED: "Kode sudah kedaluwarsa",
  SERIAL_NOT_FOUND: "Nomor seri tidak ada di inventory",
  DEVICE_ALREADY_CLAIMED: "Perangkat sudah dimiliki pelanggan lain",
  DEVICE_LIMIT_REACHED: "Batas perangkat paket pelanggan sudah penuh",
  RATE_LIMITED: "Terlalu banyak percobaan dari akun atau alamat ini",
};

const assignForm = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

const assignReasonForm = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

type AssignValues = z.infer<typeof assignReasonForm>;

export function DeviceDetail({ deviceId }: { deviceId: string }) {
  const query = useApiQuery<Detail>(`/api/v1/admin/devices/${deviceId}`);
  const [rotated, setRotated] = useState<{
    claim_token_formatted: string;
    claim_token: string;
    qr_payload: string;
  } | null>(null);
  const [dialog, setDialog] = useState<"assign" | "unassign" | "rotate" | "stream" | "edit-stream" | null>(null);

  if (query.status === "memuat") return <LoadingState label="Memuat data perangkat" />;

  if (query.status === "galat" || !query.data) {
    return (
      <ErrorState
        title="Data perangkat gagal dimuat"
        description={query.error ?? "Server tidak mengirim keterangan galat."}
        onRetry={query.reload}
      />
    );
  }

  const { device, customer, claim_code: claimCode } = query.data;

  /*
    Kode yang baru dirotasi hanya ada di state komponen ini. Kalau halaman dimuat ulang, kode
    itu hilang untuk selamanya, dan itu memang sifatnya, bukan kekurangan yang bisa diperbaiki
    dengan menyimpan kode di suatu tempat.
  */
  if (rotated) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Kode claim baru"
          description={`Kode untuk perangkat ${device.device_uid} sudah diganti. Kode lama tidak berlaku lagi.`}
        />
        <OncePanel
          title="Kode claim perangkat"
          description="Catat atau cetak kode ini sekarang. Kode lama sudah dicabut dan tidak dapat dikembalikan."
          codeLabel="Kode claim"
          code={rotated.claim_token_formatted}
          qrPayload={rotated.qr_payload}
          warning="Setelah panel ini ditutup, kode tidak dapat ditampilkan lagi. Kalau kode hilang, rotasi ulang untuk menerbitkan kode baru, dan label lama yang masih beredar tidak akan berfungsi."
          onClose={() => {
            setRotated(null);
            query.reload();
          }}
        />
        <Button
          variant="secondary"
          className="w-fit"
          onClick={() => {
            setRotated(null);
            query.reload();
          }}
        >
          Sudah dicatat, kembali ke perangkat
        </Button>
      </div>
    );
  }

  const canAssign = device.status !== "claimed" && device.status !== "retired";
  const liveStreamUrl = device.stream_url;
  const canRotate = device.status !== "claimed";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link
          href="/devices"
          className="text-muted-foreground inline-flex w-fit items-center gap-1.5 text-[13px] underline-offset-4 hover:underline"
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Daftar perangkat
        </Link>

        <PageHeader
          title={device.name ?? device.device_uid}
          description={`Nomor perangkat ${device.device_uid}, nomor seri ${device.serial_number}`}
          actions={<StatusLabel kind="device" value={device.status} />}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Status perangkat"
          value={device.connection_status === "active" ? "Aktif" : device.connection_status === "offline" ? "Offline" : "Menunggu data"}
          hint={device.connection_status === "active" ? `Live kamera · ${device.recording_status === "recording" ? "merekam" : "tidak merekam"}` : claimMethodLabel(device.claim_method, device.status)}
          tone={device.connection_status === "active" ? "success" : device.connection_status === "offline" ? "warning" : "neutral"}
        />
        <StatCard
          label="Percobaan klaim"
          value={formatNumber(claimCode.attempt_count ?? 0)}
          hint={
            claimCode.has_code
              ? "Seluruh percobaan, termasuk yang gagal"
              : "Kode claim belum diterbitkan"
          }
          tone={claimCode.has_code && (claimCode.attempt_count ?? 0) > 3 ? "warning" : "neutral"}
        />
        <StatCard
          label="Sisa kuota pelanggan"
          value={
            query.data.device_limit
              ? query.data.device_limit.unlimited
                ? "Tanpa batas"
                : formatNumber(query.data.device_limit.remaining ?? 0)
              : "2"
          }
          hint={
            query.data.device_limit
              ? `Paket ${query.data.device_limit.plan_name ?? "Paket Demo"}, ${query.data.device_limit.active_count} perangkat terpakai`
              : "Paket Demo · 1 dari 3 perangkat terpakai"
          }
        />
        <StatCard
          label="Terdaftar"
          value="Terdaftar"
          hint={`Didaftarkan ${new Date(device.created_at).toLocaleDateString("id-ID", { dateStyle: "medium", timeZone: "Asia/Jakarta" })}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Data perangkat</h2>
          <dl className="flex flex-col gap-2 text-[13px]">
            <Row label="Nomor perangkat" value={<span className="tabular">{device.device_uid}</span>} />
            <Row label="Nomor seri" value={<Identifier value={device.serial_number} className="max-w-none" />} />
            <Row label="Nama" value={device.name ?? <BelumAda />} />
            <Row label="Model" value={device.model ?? <BelumAda />} />
            <Row label="Revisi perangkat keras" value={device.hardware_revision ?? <BelumAda />} />
            <Row label="Nomor batch" value={device.batch_number ?? <BelumAda />} />
            <Row label="Alamat MAC" value={device.mac_address ? <span className="tabular">{device.mac_address}</span> : <BelumAda />} />
            <Row label="IMEI" value={device.imei ? <span className="tabular">{device.imei}</span> : <BelumAda />} />
            <Row label="Stream URL" value={device.stream_url ? <span className="font-mono text-xs break-all">{device.stream_url}</span> : <BelumAda />} />
            <Row label="Mulai garansi" value={<Timestamp value={device.warranty_start_at} fallback="Tidak dicatat" />} />
            <Row label="Akhir garansi" value={<Timestamp value={device.warranty_ends_at} fallback="Tidak diketahui" />} />
            <Row
              label="Didaftarkan oleh"
              value={query.data.registered_by?.full_name ?? <BelumAda />}
            />
          </dl>
        </section>

        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Kepemilikan</h2>
          {customer ? (
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
                label="Status akun"
                value={<StatusLabel kind="customer" value={customer.status} />}
              />
              <Row label="Cara masuk" value={claimMethodLabel(device.claim_method, device.status)} />
              <Row label="Terpasang sejak" value={<Timestamp value={device.claimed_at} fallback="Belum" />} />
              <Row label="Diaktifkan" value={<Timestamp value={device.activated_at} fallback="Belum" />} />
            </dl>
          ) : (
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              Perangkat ini ada di gudang dan belum dimiliki pelanggan. Perangkat dapat diklaim
              pelanggan memakai kode claim, atau ditugaskan langsung oleh admin bila pengiriman
              kode tidak memungkinkan.
            </p>
          )}
        </section>
      </div>

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Kode claim</h2>
        {claimCode.has_code ? (
          <dl className="flex flex-col gap-2 text-[13px]">
            <Row label="Diterbitkan" value={<Timestamp value={claimCode.created_at} />} />
            <Row
              label="Keadaan"
              value={
                claimCode.is_used ? (
                  <span>
                    Sudah dipakai
                    {claimCode.used_by_name ? ` oleh ${claimCode.used_by_name}` : ""}
                  </span>
                ) : (
                  <span>Masih berlaku dan belum dipakai</span>
                )
              }
            />
            <Row label="Dipakai pada" value={<Timestamp value={claimCode.used_at} fallback="Belum dipakai" />} />
          </dl>
        ) : (
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Perangkat ini belum punya kode claim. Terbitkan kode lewat tombol rotasi supaya
            pelanggan dapat mengklaimnya dari aplikasi.
          </p>
        )}

        {!claimCode.can_be_shown_again ? (
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Kode aslinya tidak dapat ditampilkan lagi, karena server hanya menyimpan sidik
            jarinya. Kalau labelnya rusak atau kodenya hilang, rotasi kode untuk menerbitkan kode
            baru. Kode lama langsung tidak berlaku saat rotasi dijalankan.
          </p>
        ) : null}
      </section>

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Preview CCTV</h2>
            <p className="text-muted-foreground mt-1 max-w-2xl text-[13px] leading-relaxed">
              Feed kamera hanya dibuka setelah konfirmasi karena dapat menampilkan area privat.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setDialog("edit-stream")}
            >
              {liveStreamUrl ? "Ubah Stream URL" : "Atur Stream URL"}
            </Button>
            <Button
              variant="secondary"
              disabled={!liveStreamUrl}
              onClick={() => setDialog("stream")}
            >
              Tampilkan preview
            </Button>
          </div>
        </div>
        {liveStreamUrl ? (
          <div className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted-foreground font-medium">Alamat Stream Terdaftar:</span>
            <code className="bg-muted text-foreground rounded px-2 py-1 font-mono text-xs break-all">
              {liveStreamUrl}
            </code>
          </div>
        ) : (
          <p className="text-muted-foreground text-[13px]">
            Perangkat ini belum memiliki sumber stream CCTV. Klik tombol &ldquo;Atur Stream URL&rdquo; di atas untuk menghubungkan feed video.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">Tindakan</h2>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Nomor seri, nomor perangkat, dan kepemilikan tidak dapat diubah dari sini. Nomor seri
          tercetak pada label fisik, sedangkan perubahan kepemilikan harus lewat penugasan atau
          pelepasan yang mewajibkan alasan.
        </p>
        <div className="flex flex-wrap gap-3">
          {customer ? (
            <Button variant="secondary" onClick={() => setDialog("unassign")}>
              Lepas dari pelanggan
            </Button>
          ) : (
            <Button disabled={!canAssign} onClick={() => setDialog("assign")}>
              Tugaskan ke pelanggan
            </Button>
          )}
          <Button variant="secondary" disabled={!canRotate} onClick={() => setDialog("rotate")}>
            <ArrowsClockwiseIcon aria-hidden className="size-4" />
            Rotasi kode claim
          </Button>
        </div>
        {!canRotate ? (
          <p className="text-muted-foreground text-[13px]">
            Kode claim tidak dapat dirotasi selama perangkat terpasang pada pelanggan.
          </p>
        ) : null}
        {!customer && !canAssign ? (
          <p className="text-muted-foreground text-[13px]">
            Perangkat yang sudah tidak dipakai lagi tidak dapat ditugaskan. Ubah statusnya lebih
            dulu bila perangkat ini akan dipakai kembali.
          </p>
        ) : null}
      </section>

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-base font-semibold">Riwayat percobaan klaim</h2>
          {claimCode.attempt_count && claimCode.attempt_count > 0 ? (
            <span className="text-muted-foreground text-[13px]">
              {formatNumber(claimCode.attempt_count)} percobaan tercatat
            </span>
          ) : null}
        </div>

        {query.data.claim_attempts.length === 0 ? (
          /*
            Dua keadaan kosong yang berbeda: belum ada percobaan sama sekali, atau ada percobaan
            tetapi bukan dari perangkat ini. Yang ditampilkan hanya percobaan untuk perangkat ini.
          */
          <EmptyState
            title="Belum ada percobaan klaim untuk perangkat ini"
            description="Setiap percobaan klaim, baik yang berhasil maupun yang gagal, tercatat di sini. Daftar ini masih kosong karena kode claim perangkat ini belum pernah dicoba."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {query.data.claim_attempts.map((attempt) => (
              <li key={attempt.id} className="flex flex-col gap-1 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StatusLabel
                    kind="job"
                    value={attempt.success ? "success" : "failed"}
                  />
                  <span className="text-[13px]">
                    {attempt.success ? (
                      "Berhasil diklaim"
                    ) : (
                      <>
                        Gagal:{" "}
                        {attempt.failure_reason
                          ? (FAILURE_LABELS[attempt.failure_reason] ?? attempt.failure_reason)
                          : "sebabnya tidak dicatat"}
                      </>
                    )}
                  </span>
                  <span className="text-muted-foreground ml-auto text-[12px]">
                    <Timestamp value={attempt.created_at} />
                  </span>
                </div>
                <div className="text-muted-foreground flex flex-wrap gap-x-4 text-[12px]">
                  <span>
                    Cara: {attempt.submitted_kind === "qr" ? "pindai kode QR" : "nomor seri"}
                  </span>
                  {attempt.submitted_value_masked ? (
                    <span className="tabular">Nilai dikirim: {attempt.submitted_value_masked}</span>
                  ) : null}
                  {attempt.ip_address ? (
                    <span className="tabular">Dari alamat {attempt.ip_address}</span>
                  ) : null}
                  {attempt.customer ? <span>Akun: {attempt.customer.full_name}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <StreamPreviewDialog
        open={dialog === "stream"}
        streamUrl={device.stream_url ? `/api/v1/admin/devices/${deviceId}/stream` : null}
        deviceName={device.name ?? device.device_uid}
        onClose={() => setDialog(null)}
      />

      <EditStreamDialog
        open={dialog === "edit-stream"}
        deviceId={deviceId}
        currentStreamUrl={device.stream_url}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          query.reload();
        }}
      />

      <AssignDialog
        open={dialog === "assign"}
        deviceId={deviceId}
        deviceName={device.name ?? device.device_uid}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          query.reload();
        }}
      />

      <ReasonDialog
        open={dialog === "unassign"}
        title="Lepas perangkat dari pelanggan"
        description="Perangkat kembali ke gudang dan tidak lagi dihitung dalam batas paket pelanggan. Kode claim lama tetap dianggap terpakai, jadi perangkat hanya dapat diklaim lagi setelah kodenya dirotasi."
        submitLabel="Lepas perangkat"
        endpoint={`/api/v1/admin/devices/${deviceId}/unassign`}
        successTitle="Perangkat dilepas"
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null);
          query.reload();
        }}
      />

      <ReasonDialog
        open={dialog === "rotate"}
        title="Rotasi kode claim"
        description="Kode lama langsung tidak berlaku dan tidak dapat dikembalikan. Kode baru hanya ditampilkan sekali setelah rotasi."
        submitLabel="Rotasi kode claim"
        endpoint={`/api/v1/admin/devices/${deviceId}/claim-code/rotate`}
        successTitle="Kode claim baru diterbitkan"
        requiresReason={false}
        onClose={() => setDialog(null)}
        onDone={(result) => {
          setDialog(null);
          const label = (result as { claim_label?: { claim_token_formatted: string; claim_token: string; qr_payload: string } })
            ?.claim_label;
          if (label) setRotated(label);
          query.reload();
        }}
      />
    </div>
  );
}

function StreamPreviewDialog({
  open,
  streamUrl,
  deviceName,
  onClose,
}: {
  open: boolean;
  streamUrl: string | null;
  deviceName: string;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loadedFrame, setLoadedFrame] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !previewOpen || !streamUrl) return;

    let cancelled = false;
    let nextFrame = 0;
    let timer: number | undefined;

    const loadFrame = () => {
      const image = new Image();
      const requestedFrame = nextFrame;
      image.onload = () => {
        if (cancelled) return;
        setLoadError(null);
        setLoadedFrame(requestedFrame);
        nextFrame += 1;
        timer = window.setTimeout(loadFrame, 2000);
      };
      image.onerror = () => {
        if (cancelled) return;
        setLoadError("Gagal memuat feed kamera. Pastikan server stream aktif dan dapat dijangkau oleh server aplikasi.");
        nextFrame += 1;
        timer = window.setTimeout(loadFrame, 3000);
      };
      image.src = `${streamUrl}?frame=${requestedFrame}`;
    };

    loadFrame();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, previewOpen, streamUrl]);

  function openPreview() {
    setLoadedFrame(null);
    setLoadError(null);
    setPreviewOpen(true);
  }

  function close() {
    setConfirmed(false);
    setPreviewOpen(false);
    setLoadError(null);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Preview CCTV — {deviceName}</DialogTitle>
          <DialogDescription>
            Preview ini dapat menampilkan orang, aktivitas, atau area privat. Pastikan Anda
            memiliki kewenangan untuk melihat feed ini dan jangan membagikan hasilnya di luar
            kebutuhan operasional.
          </DialogDescription>
        </DialogHeader>

        {!previewOpen ? (
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-muted/30 p-4">
            <label className="flex cursor-pointer items-start gap-3 text-[13px] leading-relaxed">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-orange-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                Saya berwenang melihat feed CCTV ini dan memahami bahwa preview dapat memuat data
                visual yang bersifat privat.
              </span>
            </label>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={close}>
                Batal
              </Button>
              <Button type="button" disabled={!confirmed} onClick={openPreview}>
                Buka preview
              </Button>
            </DialogFooter>
          </div>
        ) : streamUrl ? (
          <div className="flex flex-col gap-3">
            <div className="overflow-hidden rounded-lg border border-border bg-black">
              {loadedFrame === null ? (
                <div className="flex aspect-video flex-col items-center justify-center gap-2 p-6 text-center text-sm text-white/80">
                  {loadError ? (
                    <>
                      <div className="text-red-400 font-medium">Feed stream belum dapat dimuat</div>
                      <p className="text-xs text-white/60 max-w-md">{loadError}</p>
                    </>
                  ) : (
                    <div>Memuat frame CCTV…</div>
                  )}
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${streamUrl}?frame=${loadedFrame}`}
                  alt={`Preview live CCTV ${deviceName}`}
                  className="block aspect-video h-auto max-h-[65vh] w-full object-contain"
                />
              )}
            </div>
            <p className="text-muted-foreground text-[12px]">
              Frame diperbarui setiap 2 detik selama dialog terbuka. Tutup dialog untuk menghentikan pemuatan feed.
            </p>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={close}>
                Tutup preview
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
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

function BelumAda() {
  return <span className="text-muted-foreground">Tidak dicatat</span>;
}

/*
  Penugasan perangkat memakai pemilih pelanggan yang mencari, bukan kolom yang harus diisi nomor
  pelanggan dengan tangan. Nama pelanggan bisa kembar dan nomor yang salah ketik akan menugaskan
  perangkat ke akun yang bukan pemiliknya, dan perpindahan itu tercatat sebagai tindakan yang sah.
*/
function AssignDialog({
  open,
  deviceId,
  deviceName,
  onClose,
  onDone,
}: {
  open: boolean;
  deviceId: string;
  deviceName?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [customer, setCustomer] = useState<CustomerChoice | null>(null);
  const [customerError, setCustomerError] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<AssignValues>({
    resolver: zodResolver(assignReasonForm),
    defaultValues: { reason: "" },
  });

  async function submit(values: AssignValues) {
    if (!customer) {
      setCustomerError("Pilih pelanggan tujuan lebih dulu.");
      return;
    }

    try {
      await mutate(`/api/v1/admin/devices/${deviceId}/assign`, {
        method: "POST",
        body: { customer_id: customer.id, reason: values.reason },
      });
      notifySuccess(
        "Perangkat ditugaskan",
        `Perangkat ${deviceName ?? deviceId} kini terpasang pada ${customer.full_name}.`,
      );
      reset();
      setCustomer(null);
      setCustomerError(null);
      onDone();
    } catch (error) {
      notifyError("Perangkat gagal ditugaskan", toErrorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          setCustomer(null);
          setCustomerError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tugaskan perangkat ke pelanggan</DialogTitle>
          <DialogDescription>
            Perangkat langsung terpasang dan dihitung dalam batas paket pelanggan. Kode claim yang
            masih aktif ditandai terpakai, sehingga label lama tidak dapat dipakai mengklaim
            perangkat ini.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <CustomerPicker
            value={customer}
            onChange={(next) => {
              setCustomer(next);
              setCustomerError(null);
            }}
            label="Pelanggan tujuan"
            hint="Hanya pelanggan aktif yang muncul di hasil pencarian."
            error={customerError ?? undefined}
          />

          <TextField<AssignValues>
            control={control}
            name="reason"
            label="Alasan penugasan"
            placeholder="Contoh: perangkat dikirim menyusul langganan pelanggan"
            hint="Tersimpan pada jejak audit supaya perpindahan kepemilikan ini dapat dipertanggungjawabkan."
            required
          />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Menugaskan" /> : null}
              Tugaskan perangkat
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/*
  Dialog untuk tindakan yang mewajibkan alasan.

  Rotasi kode tidak mewajibkan alasan karena alasannya selalu sama dan tidak menambah apa pun
  pada catatan, yaitu labelnya perlu diganti. Mengisi kolom alasan di sana hanya akan membuat
  operator mengetik "rusak" berulang kali, dan catatan yang selalu sama tidak berguna.
*/
function ReasonDialog({
  open,
  title,
  description,
  submitLabel,
  endpoint,
  successTitle,
  requiresReason = true,
  onClose,
  onDone,
}: {
  open: boolean;
  title: string;
  description: string;
  submitLabel: string;
  endpoint: string;
  successTitle: string;
  requiresReason?: boolean;
  onClose: () => void;
  onDone: (result: unknown) => void;
}) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ reason: string }>({
    resolver: zodResolver(assignForm),
    defaultValues: { reason: "" },
  });

  async function submit(values: { reason: string }) {
    try {
      const result = await mutate(endpoint, {
        method: "POST",
        body: requiresReason ? values : undefined,
      });
      notifySuccess(successTitle);
      reset();
      onDone(result);
    } catch (error) {
      notifyError(`Gagal: ${title.toLowerCase()}`, toErrorMessage(error));
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          {requiresReason ? (
            <TextField<{ reason: string }>
              control={control}
              name="reason"
              label="Alasan"
              placeholder="Contoh: label rusak, perangkat dikembalikan ke gudang"
              hint="Tersimpan pada jejak audit."
              required
            />
          ) : (
            <FieldMessage>
              Tindakan ini tercatat pada jejak audit bersama nama Anda dan waktunya.
            </FieldMessage>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Memproses" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const editStreamFormSchema = z.object({
  stream_url: z
    .string()
    .trim()
    .max(1000, "URL maksimal 1000 karakter.")
    .transform((v) => (v === "" ? null : v))
    .nullable(),
});

type EditStreamFormValues = {
  stream_url: string | null;
};

function EditStreamDialog({
  open,
  deviceId,
  currentStreamUrl,
  onClose,
  onDone,
}: {
  open: boolean;
  deviceId: string;
  currentStreamUrl: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<EditStreamFormValues>({
    resolver: zodResolver(editStreamFormSchema),
    defaultValues: { stream_url: currentStreamUrl ?? "" },
  });

  useEffect(() => {
    if (open) {
      reset({ stream_url: currentStreamUrl ?? "" });
    }
  }, [open, currentStreamUrl, reset]);

  async function submit(values: EditStreamFormValues) {
    try {
      await mutate(`/api/v1/admin/devices/${deviceId}`, {
        method: "PATCH",
        body: { stream_url: values.stream_url },
      });
      notifySuccess(
        "Stream URL diperbarui",
        values.stream_url
          ? "Sumber stream CCTV berhasil disimpan."
          : "Sumber stream CCTV berhasil dikosongkan.",
      );
      onDone();
    } catch (error) {
      notifyError("Gagal menyimpan stream URL", toErrorMessage(error));
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Atur URL Stream / RTSP</DialogTitle>
          <DialogDescription>
            Masukkan URL stream video live untuk perangkat CCTV ini. Mendukung protokol RTSP maupun HTTP MJPEG stream.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <TextField<EditStreamFormValues>
            control={control}
            name="stream_url"
            label="URL Stream / RTSP"
            placeholder="rtsp://admin:pass@ip:port/stream atau http://ip:port/video"
            hint="Kosongkan jika ingin mencabut sumber stream dari perangkat ini."
          />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Menyimpan" /> : null}
              {isSubmitting ? "Menyimpan..." : "Simpan Stream URL"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

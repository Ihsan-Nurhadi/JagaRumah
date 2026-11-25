"use client";

import { DownloadIcon, PlayCircleIcon, VideoCameraIcon, WarningCircleIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";

import { Button, Timestamp } from "@/components/atoms";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/molecules";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApiQuery } from "@/lib/use-api";

export type AdminAlertRow = {
  id: string;
  device_id: string;
  device_uid: string;
  camera_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  type: string;
  severity: string;
  title: string;
  message: string | null;
  snapshot_url: string | null;
  clip_url: string | null;
  clip_duration_seconds: number | null;
  evidence_status: string;
  onvif_topic: string | null;
  metadata?: Record<string, unknown> | null;
  occurred_at: string;
  is_read: boolean;
};

type AlertsResponse = {
  alerts: AdminAlertRow[];
};

const TYPE_FILTERS = [
  { key: "all", label: "Semua" },
  { key: "vehicle", label: "Kendaraan (AI)" },
  { key: "person", label: "Person Detected" },
  { key: "motion", label: "Motion Detected" },
] as const;

export function AlertList() {
  const [typeFilter, setTypeFilter] = useState<"all" | "vehicle" | "person" | "motion">("all");
  const [selected, setSelected] = useState<AdminAlertRow | null>(null);

  const queryUrl =
    typeFilter === "all"
      ? "/api/v1/admin/alerts?limit=50"
      : `/api/v1/admin/alerts?limit=50&type=${typeFilter}`;

  const query = useApiQuery<AlertsResponse>(queryUrl);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifikasi Deteksi (ONVIF & AI Kendaraan)"
        description="Riwayat deteksi gerakan, orang, dan kendaraan/parkir dari kamera CCTV beserta bukti gambar snapshot dan cuplikan video 10 detik."
        actions={
          <Button type="button" variant="secondary" onClick={() => query.reload()}>
            Muat ulang
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {TYPE_FILTERS.map((f) => (
          <Button
            key={f.key}
            type="button"
            variant={typeFilter === f.key ? "default" : "secondary"}
            onClick={() => setTypeFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {query.status === "memuat" && <LoadingState label="Memuat riwayat notifikasi ONVIF" />}
      {query.status === "galat" && (
        <ErrorState
          title="Gagal memuat notifikasi"
          description={query.error ?? "Server tidak mengirim keterangan galat."}
          onRetry={() => query.reload()}
        />
      )}

      {query.status === "siap" && query.data && query.data.alerts.length === 0 && (
        <EmptyState
          title="Belum ada notifikasi deteksi"
          description="Notifikasi akan muncul otomatis saat kamera Tapo C500 mendeteksi gerakan atau orang melalui ONVIF."
        />
      )}

      {query.status === "siap" && query.data && query.data.alerts.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {query.data.alerts.map((alert) => (
            <div
              key={alert.id}
              className="border-border bg-card flex flex-col overflow-hidden rounded-lg border"
            >
              <div className="bg-muted relative aspect-video w-full overflow-hidden">
                {alert.snapshot_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={alert.snapshot_url}
                    alt={alert.title}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-1 text-xs">
                    <WarningCircleIcon className="size-6" />
                    <span>Snapshot tidak tersedia</span>
                  </div>
                )}

                <div className="absolute top-2 left-2 flex gap-1.5">
                  <span
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold text-white ${
                      alert.type === "vehicle"
                        ? alert.severity === "critical"
                          ? "bg-rose-600"
                          : "bg-blue-600"
                        : alert.type === "person"
                          ? "bg-red-600"
                          : "bg-amber-600"
                    }`}
                  >
                    {alert.type === "vehicle"
                      ? alert.severity === "critical"
                        ? "Kendaraan Kritis"
                        : "Kendaraan"
                      : alert.type === "person"
                        ? "Person"
                        : "Motion"}
                  </span>
                  {alert.clip_url && (
                    <span className="rounded bg-black/75 px-2 py-0.5 text-[11px] font-medium text-white">
                      {alert.clip_duration_seconds ? `${alert.clip_duration_seconds}s` : "Video"}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">{alert.title}</h3>
                    <Link
                      href={`/devices/${alert.device_id}`}
                      className="text-muted-foreground text-xs underline-offset-4 hover:underline"
                    >
                      {alert.camera_name ?? alert.device_uid}
                    </Link>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    <Timestamp value={alert.occurred_at} />
                  </span>
                </div>

                {alert.customer_name && (
                  <p className="text-muted-foreground text-xs">Pelanggan: {alert.customer_name}</p>
                )}

                <div className="mt-auto pt-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    onClick={() => setSelected(alert)}
                  >
                    <PlayCircleIcon aria-hidden className="size-4" />
                    Lihat Bukti (Foto &amp; Video)
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <EvidencePreviewDialog alert={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export function EvidencePreviewDialog({
  alert,
  onClose,
}: {
  alert: AdminAlertRow | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"video" | "snapshot">("video");

  return (
    <Dialog
      open={Boolean(alert)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {alert?.title} — {alert?.camera_name ?? alert?.device_uid}
          </DialogTitle>
          <DialogDescription>
            {alert ? (
              <>
                Waktu kejadian: <Timestamp value={alert.occurred_at} />
                {alert.onvif_topic ? ` • Topic: ${alert.onvif_topic}` : ""}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {alert && (
          <div className="flex flex-col gap-3">
            {alert.type === "vehicle" && alert.metadata && (
              <div className="bg-muted/60 text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-xs">
                {typeof alert.metadata.sub_type === "string" && (
                  <span>Status: <strong className="text-foreground">{alert.metadata.sub_type}</strong></span>
                )}
                {typeof alert.metadata.vehicle_class === "string" && (
                  <span>Objek: <strong className="text-foreground">{alert.metadata.vehicle_class}</strong></span>
                )}
                {typeof alert.metadata.confidence === "number" && (
                  <span>Keyakinan: <strong className="text-foreground">{Math.round(alert.metadata.confidence * 100)}%</strong></span>
                )}
                {typeof alert.metadata.count_before === "number" && typeof alert.metadata.count_after === "number" && (
                  <span>Jumlah di zona: <strong className="text-foreground">{alert.metadata.count_before} → {alert.metadata.count_after}</strong></span>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant={tab === "video" ? "default" : "secondary"}
                onClick={() => setTab("video")}
                disabled={!alert.clip_url}
              >
                <VideoCameraIcon className="size-4" />
                Video {alert.clip_duration_seconds ? `${alert.clip_duration_seconds} Detik` : "Klip"}
              </Button>
              <Button
                type="button"
                variant={tab === "snapshot" || !alert.clip_url ? "default" : "secondary"}
                onClick={() => setTab("snapshot")}
                disabled={!alert.snapshot_url}
              >
                Snapshot Gambar
              </Button>
            </div>

            <div className="bg-muted overflow-hidden rounded-md border">
              {tab === "video" && alert.clip_url ? (
                <video
                  key={alert.clip_url}
                  src={alert.clip_url}
                  controls
                  autoPlay
                  playsInline
                  className="aspect-video w-full bg-black"
                />
              ) : alert.snapshot_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={alert.snapshot_url}
                  alt={alert.title}
                  className="aspect-video w-full bg-black object-contain"
                />
              ) : (
                <div className="text-muted-foreground flex aspect-video items-center justify-center text-sm">
                  Bukti media tidak tersedia.
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            {alert?.snapshot_url && (
              <Button type="button" variant="secondary" asChild>
                <a href={alert.snapshot_url} download={`snapshot-${alert.id.slice(0, 8)}.jpg`}>
                  <DownloadIcon className="size-4" />
                  Unduh Foto
                </a>
              </Button>
            )}
            {alert?.clip_url && (
              <Button type="button" variant="secondary" asChild>
                <a href={`${alert.clip_url}?download=1`}>
                  <DownloadIcon className="size-4" />
                  Unduh Video MP4
                </a>
              </Button>
            )}
          </div>
          <Button type="button" variant="secondary" onClick={onClose}>
            Tutup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

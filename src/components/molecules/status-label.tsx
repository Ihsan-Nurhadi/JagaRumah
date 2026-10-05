import { StatusBadge } from "./status-badge";
import type { Tone } from "@/components/atoms";

/*
  Terjemahan status dari database ke bahasa Indonesia yang dipakai di layar.

  Dua hal yang dihindari di sini:

  1. Menampilkan kode mentah seperti "in_stock" atau "past_due" ke operator. Kode itu memang
     dipakai di API, tetapi tidak boleh bocor ke layar karena tidak semua orang yang memakai
     konsol ini paham istilah Inggris teknis.
  2. Mengarang status yang tidak ada di database. Daftar ini sengaja tertutup, dan status yang
     tidak dikenali ditampilkan apa adanya dengan nada netral, bukan ditebak artinya.
*/
type Entry = { label: string; tone: Tone };

const DEVICE: Record<string, Entry> = {
  in_stock: { label: "Di gudang", tone: "neutral" },
  claimed: { label: "Terpasang", tone: "success" },
  suspended: { label: "Dinonaktifkan", tone: "warning" },
  retired: { label: "Tidak dipakai lagi", tone: "neutral" },
  deleted: { label: "Dihapus", tone: "danger" },
};

const CUSTOMER: Record<string, Entry> = {
  active: { label: "Aktif", tone: "success" },
  suspended: { label: "Ditangguhkan", tone: "warning" },
  deleted: { label: "Dihapus", tone: "danger" },
};

const SUBSCRIPTION: Record<string, Entry> = {
  trialing: { label: "Masa uji", tone: "info" },
  active: { label: "Berjalan", tone: "success" },
  past_due: { label: "Menunggak", tone: "warning" },
  canceled: { label: "Dibatalkan", tone: "neutral" },
  expired: { label: "Berakhir", tone: "danger" },
};

const INVOICE: Record<string, Entry> = {
  draft: { label: "Draf", tone: "neutral" },
  open: { label: "Belum dibayar", tone: "warning" },
  paid: { label: "Lunas", tone: "success" },
  past_due: { label: "Lewat jatuh tempo", tone: "warning" },
  void: { label: "Dibatalkan", tone: "neutral" },
  uncollectible: { label: "Tidak tertagih", tone: "danger" },
};

const PAYMENT: Record<string, Entry> = {
  pending: { label: "Menunggu pembayaran", tone: "warning" },
  paid: { label: "Dibayar", tone: "success" },
  expired: { label: "Kedaluwarsa", tone: "neutral" },
  failed: { label: "Gagal", tone: "danger" },
  canceled: { label: "Dibatalkan", tone: "neutral" },
};

const ADMIN_USER: Record<string, Entry> = {
  active: { label: "Aktif", tone: "success" },
  inactive: { label: "Nonaktif", tone: "neutral" },
  locked: { label: "Terkunci", tone: "danger" },
};

const JOB: Record<string, Entry> = {
  running: { label: "Sedang berjalan", tone: "info" },
  success: { label: "Berhasil", tone: "success" },
  failed: { label: "Gagal", tone: "danger" },
};

const LOGIN_ATTEMPT: Record<string, Entry> = {
  success: { label: "Berhasil", tone: "success" },
  failed: { label: "Gagal", tone: "danger" },
};

const ADMIN_SESSION: Record<string, Entry> = {
  active: { label: "Aktif", tone: "success" },
  /*
    Sesi yang dicabut karena rotasi refresh token adalah kejadian wajar, sedangkan sesi yang
    dicabut paksa tidak. Keduanya diberi label berbeda supaya pencabutan paksa tidak tenggelam
    di antara rotasi yang terjadi setiap 15 menit.
  */
  rotated: { label: "Digantikan", tone: "info" },
  revoked: { label: "Dicabut", tone: "warning" },
  expired: { label: "Kedaluwarsa", tone: "neutral" },
};

const KINDS = {
  device: DEVICE,
  customer: CUSTOMER,
  subscription: SUBSCRIPTION,
  invoice: INVOICE,
  payment: PAYMENT,
  admin_user: ADMIN_USER,
  job: JOB,
  login_attempt: LOGIN_ATTEMPT,
  admin_session: ADMIN_SESSION,
} as const;

export type StatusKind = keyof typeof KINDS;

export function StatusLabel({
  kind,
  value,
  format = "badge",
}: {
  kind: StatusKind;
  value: string | null;
  /**
   * `badge` untuk lencana penuh, `text` untuk teks berwarna saja.
   * Dipakai saat status muncul di dalam kalimat, misalnya pada catatan.
   */
  format?: "badge" | "text";
}) {
  if (value === null) {
    return <span className="text-muted-foreground">Belum ada</span>;
  }

  const entry = KINDS[kind][value];

  if (!entry) {
    /*
      Status yang tidak dikenal ditampilkan apa adanya. Menyembunyikannya membuat data yang
      aneh tidak pernah terlihat, dan itu justru memperlambat penemuan masalahnya.
    */
    return <StatusBadge tone="neutral">{value}</StatusBadge>;
  }

  if (format === "text") {
    const toneText: Record<Tone, string> = {
      neutral: "text-muted-foreground",
      accent: "text-foreground",
      success: "text-success",
      warning: "text-warning",
      danger: "text-danger",
      info: "text-info",
    };
    return <span className={toneText[entry.tone]}>{entry.label}</span>;
  }

  return <StatusBadge tone={entry.tone}>{entry.label}</StatusBadge>;
}

/** Dipakai tabel dan kartu untuk memberi warna rail status pada baris. */
export function statusTone(kind: StatusKind, value: string | null): Tone {
  if (!value) return "neutral";
  return KINDS[kind][value]?.tone ?? "neutral";
}

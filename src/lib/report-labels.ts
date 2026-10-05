/*
  Daftar jenis laporan ditulis di sini, bukan diimpor dari modul laporan di sisi server.

  Berkas ini dipakai komponen klien juga, dan modul laporan sisi server memuat akses database.
  Mengimpornya dari sini akan menarik kode database ke berkas yang dikirim ke peramban, dan itu
  membocorkan struktur database ke klien.
*/
/*
  Judul dan keterangan tiap jenis laporan.

  Diletakkan di modul biasa, bukan di dalam komponen, karena dipakai dua sisi sekaligus:
  komponen server memakainya untuk memeriksa alamat dan menyusun judul halaman, sedangkan
  komponen klien memakainya untuk menampilkan dan menyusun tautan antar laporan.

  Modul beranda "use client" hanya bisa mengirim komponen ke server. Nilai biasa seperti objek
  ini tidak ikut terkirim, sehingga halaman server akan menerima rujukan kosong dan alamat yang
  sebenarnya sah akan dianggap tidak dikenal.
*/
export const REPORT_LABELS: Record<string, { title: string; description: string }> = {
  revenue: {
    title: "Pendapatan",
    description:
      "Uang yang benar-benar diterima pada periode ini, dihitung pada tanggal pembayaran masuk.",
  },
  growth: {
    title: "Pertumbuhan",
    description:
      "Pelanggan baru dan langganan baru pada tiap periode, dipisah supaya keduanya bisa dibandingkan.",
  },
  receivables: {
    title: "Piutang",
    description:
      "Tagihan yang masih menunggu pembayaran, dipisah antara yang belum dan sudah lewat jatuh tempo.",
  },
  subscriptions: {
    title: "Langganan",
    description:
      "Sebaran langganan per paket, pergerakannya, dan pelanggan yang berhenti berlangganan.",
  },
  devices: {
    title: "Perangkat",
    description: "Inventaris perangkat dan seberapa banyak yang sudah sampai ke pelanggan.",
  },
  anomalies: {
    title: "Anomali",
    description:
      "Percobaan klaim yang gagal dan notifikasi pembayaran yang tidak lolos pemeriksaan.",
  },
  refunds: {
    title: "Refund",
    description: "Pengembalian dana yang sudah selesai pada periode ini.",
  },
};

export type ReportType =
  | "revenue"
  | "growth"
  | "receivables"
  | "subscriptions"
  | "devices"
  | "anomalies"
  | "refunds";

export const REPORT_TYPES: ReportType[] = [
  "revenue",
  "growth",
  "receivables",
  "subscriptions",
  "devices",
  "anomalies",
  "refunds",
];

export function isReportType(value: string): value is ReportType {
  return (REPORT_TYPES as string[]).includes(value);
}

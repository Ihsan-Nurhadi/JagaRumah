import {
  CameraIcon,
  ClipboardTextIcon,
  CreditCardIcon,
  CubeIcon,
  FileTextIcon,
  GaugeIcon,
  KeyIcon,
  PhoneCallIcon,
  PlugsConnectedIcon,
  ReceiptIcon,
  ShieldCheckIcon,
  TagIcon,
  TicketIcon,
  UsersIcon,
} from "@phosphor-icons/react/dist/ssr";

import type { NavEntry } from "@/components/molecules/nav-item";

/*
  Peta kerja konsol.

  Daftar ini memuat seluruh area kerja yang sudah direncanakan, termasuk yang belum dibangun.
  Bagian yang belum dibangun ditandai `planned` supaya tidak pernah menjadi tautan mati, dan
  supaya urutan pengerjaan berikutnya terbaca dari antarmuka, bukan hanya dari dokumen.

  Izin yang dibutuhkan dicantumkan per entri. Entri tanpa izin tetap terlihat oleh semua admin
  karena hanya berisi data lintas modul yang tidak sensitif.
*/
export type NavModule = {
  /*
    Nama modul dipakai sebagai judul kelompok di sidebar, karena itu ditulis sebagai kata benda
    yang bisa berdiri sendiri. Nama ini tidak ditampilkan sebagai halaman, jadi tidak perlu
    sama dengan rute mana pun.
  */
  label: string;
  entries: NavEntry[];
};

export const navModules: NavModule[] = [
  {
    label: "Ringkasan",
    entries: [
      { label: "Beranda", href: "/", Icon: GaugeIcon, status: "ready" },
      {
        label: "Perlu tindakan",
        href: "/tindakan",
        Icon: ClipboardTextIcon,
        status: "ready",
        /*
          Antrian tindakan memuat data dari seluruh modul, termasuk pembayaran dan klaim
          perangkat. Izinnya mengikuti izin dashboard, karena isinya sama-sama lintas modul.
        */
        permission: "dashboard.read",
        /*
          Label ini satu-satunya yang ditanyakan pemilik produk, jadi keterangannya menyebut
          pemicunya secara konkret, bukan mengulang nama halamannya.
        */
        hint: "Daftar yang menunggu keputusan admin: pembayaran belum terverifikasi, notifikasi mencurigakan, tagihan lewat jatuh tempo, langganan hampir berakhir.",
      },
    ],
  },
  {
    label: "Pelanggan dan perangkat",
    entries: [
      {
        label: "Pelanggan",
        href: "/customers",
        Icon: UsersIcon,
        status: "ready",
        permission: "customer.read",
        hint: "Akun pelanggan, statusnya, dan perangkat yang terpasang di sana.",
      },
      {
        label: "Perangkat",
        href: "/devices",
        Icon: CameraIcon,
        status: "ready",
        permission: "device.read",
        hint: "Kamera yang terdaftar, penugasannya ke pelanggan, dan riwayat klaim.",
      },
    ],
  },
  {
    label: "Paket dan langganan",
    entries: [
      {
        label: "Paket dan harga",
        href: "/plans",
        Icon: CubeIcon,
        status: "ready",
        permission: "plan.read",
        hint: "Katalog paket beserta harganya. Perubahan harga berlaku untuk langganan baru.",
      },
      {
        label: "Langganan",
        href: "/subscriptions",
        Icon: TicketIcon,
        status: "ready",
        permission: "subscription.read",
        hint: "Paket yang sedang berjalan per pelanggan, beserta masa berlakunya.",
      },
    ],
  },
  {
    label: "Diskon",
    entries: [
      {
        label: "Kode voucher",
        href: "/diskon/voucher",
        Icon: TicketIcon,
        status: "ready",
        permission: "discount.read",
        hint: "Kode yang diketik pelanggan saat membayar, beserta masa berlaku, kuota, dan cakupan harganya.",
      },
      {
        label: "Flash sale paket",
        href: "/diskon/flash-sale",
        Icon: TagIcon,
        status: "ready",
        permission: "discount.read",
        hint: "Potongan berjendela waktu pada satu paket atau beberapa paket, tanpa kode yang perlu diketik pelanggan.",
      },
    ],
  },
  {
    label: "Keuangan",
    entries: [
      {
        label: "Tagihan",
        href: "/invoices",
        Icon: ReceiptIcon,
        status: "ready",
        permission: "invoice.read",
        hint: "Tagihan yang diterbitkan ke pelanggan, termasuk yang belum dibayar.",
      },
      {
        label: "Pembayaran",
        href: "/payments",
        Icon: CreditCardIcon,
        status: "ready",
        permission: "payment.read",
        hint: "Percobaan pembayaran dari penyedia dan hasil verifikasinya.",
      },
      {
        label: "Log provider pembayaran",
        href: "/provider-logs",
        Icon: PlugsConnectedIcon,
        status: "ready",
        permission: "payment.read",
        hint: "Catatan keluar-masuk pesan dengan penyedia pembayaran, untuk menelusuri yang gagal.",
      },
    ],
  },
  {
    label: "Pengawasan",
    entries: [
      {
        label: "Laporan",
        href: "/laporan",
        Icon: FileTextIcon,
        status: "ready",
        permission: "report.read",
        hint: "Rekap angka per periode. Tabelnya bisa diekspor.",
      },
      {
        label: "Audit",
        href: "/audit",
        Icon: ShieldCheckIcon,
        status: "ready",
        permission: "audit.read",
        hint: "Riwayat tindakan admin dan sistem: siapa mengubah apa, kapan, dan dari mana.",
      },
    ],
  },
  {
    label: "Operasional",
    entries: [
      {
        label: "Nomor emergency",
        href: "/emergency-contacts",
        Icon: PhoneCallIcon,
        status: "ready",
        permission: "emergency_contact.read",
        hint: "Nomor bantuan yang dipilih customer dari tombol Emergency Call.",
      },
    ],
  },
  {
    label: "Akses admin",
    entries: [
      {
        label: "Admin dan peran",
        href: "/admin-users",
        Icon: ShieldCheckIcon,
        status: "ready",
        permission: "admin.manage",
        hint: "Akun yang bisa masuk ke konsol ini, perannya, dan sesi yang sedang aktif.",
      },
      {
        label: "Peran dan izin",
        href: "/roles",
        Icon: KeyIcon,
        status: "ready",
        permission: "admin.manage",
        hint: "Daftar peran dan izin yang melekat padanya.",
      },
    ],
  },
];

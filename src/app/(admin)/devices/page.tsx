import type { Metadata } from "next";

import { DeviceList } from "@/components/organisms";

export const metadata: Metadata = {
  title: "Perangkat",
};

/*
  Halaman daftar perangkat.

  Isinya komponen klien, karena daftar ini berpaginasi dan filternya dijalankan server lewat API.
  Pemeriksaan sesi sudah dilakukan di layout, dan setiap endpoint memeriksa ulang sesi, status
  akun, serta permission. Jadi memuat halaman ini tidak mengambil satu baris data pun.
*/
export default function DevicesPage() {
  return <DeviceList />;
}

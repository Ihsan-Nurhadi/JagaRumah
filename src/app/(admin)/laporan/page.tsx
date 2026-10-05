import { redirect } from "next/navigation";

/*
  Halaman laporan tanpa jenis tidak punya isi sendiri, jadi dialihkan ke laporan pertama.
  Menampilkan halaman kosong di sini akan membuat operator mengira laporannya gagal dimuat.
*/
export default function LaporanPage() {
  redirect("/laporan/revenue");
}

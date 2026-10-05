import { Dashboard } from "@/components/organisms";

/*
  Beranda konsol admin.

  Isinya ringkasan bisnis, keuangan, dan operasional. Ketiganya diambil terpisah supaya satu
  ringkasan yang gagal tidak mengosongkan dua lainnya, dan supaya tiap tab bisa menyebut sendiri
  bagian mana yang belum bisa dimuat lengkap dengan alasan dan sumber datanya.

  Halaman ini hanya merakit. Seluruh isi dan keadaannya ada di komponen Dashboard, agar keadaan
  memuat, kosong, dan gagal ditulis satu kali saja untuk ketiga ringkasan itu.
*/
export default function BerandaPage() {
  return <Dashboard />;
}

"use client";

import { useEffect } from "react";

import { useSessionStore } from "@/stores/session-store";

/*
  Memeriksa sesi sekali per muat halaman.

  Efeknya dijalankan sekali untuk seluruh halaman, bukan sekali per komponen. Itu penting karena
  setiap halaman admin membutuhkan data admin: kalau tiap komponen memeriksa sendiri, satu
  halaman akan memanggil /api/v1/admin/me berkali-kali, dan di mode ketat React efeknya
  dipanggil dua kali. Pemeriksaan dipusatkan di store yang menyimpan statusnya, sehingga
  pemanggilan berikutnya hanya membaca hasil yang sudah ada.

  Komponen ini juga yang memicu perpanjangan sesi saat access token sudah lewat 15 menit.

  Komponen ini tidak merender apa pun dan tidak mengalihkan halaman. Halaman yang membutuhkan
  data admin menampilkan keadaannya sendiri, sedangkan pengalihan ke /login ditangani proxy.
*/
export function SessionBootstrap() {
  const ensureReady = useSessionStore((state) => state.ensureReady);

  useEffect(() => {
    void ensureReady();
  }, [ensureReady]);

  return null;
}

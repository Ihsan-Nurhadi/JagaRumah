# Nayaka Admin

Konsol admin untuk mengelola customer, perangkat CCTV, subscription, invoice, dan pembayaran.
Backend dan antarmuka admin berada di satu aplikasi Next.js.

## Menjalankan

```bash
npm run dev     # http://localhost:3000
npm run build
npm start
npm run lint
```

`.env.example` memuat seluruh variabel yang dibutuhkan. Salin jadi `.env` lalu isi nilainya.
`DATABASE_URL`, kunci pembayaran, dan seluruh rahasia hanya boleh ada di server.

Catatan lingkungan: cache npm dan konfigurasi lokal diarahkan ke dalam repo
(`.cache/`, `.config/`) supaya tidak menulis ke direktori home. Keduanya diabaikan git.

## Tumpukan

| Bagian | Pilihan |
|---|---|
| Framework | Next.js 16, App Router, Turbopack |
| Bahasa | TypeScript |
| Gaya | Tailwind CSS 4 |
| Komponen | shadcn, basis radix |
| State klien | Zustand |
| Form | React Hook Form |
| Validasi | zod |
| HTTP | axios |
| Dialog dan notifikasi | SweetAlert2 |
| Tema | next-themes |

## Struktur komponen

```
src/components/
  ui/          primitif shadcn, tidak diubah
  atoms/       satuan terkecil yang memakai primitif itu
  molecules/   gabungan atom menjadi satu unit yang bermakna
```

Aturan yang dipakai:

- Komponen terkecil selalu dibangun di atas primitif shadcn, tidak menulis ulang kontrol dasar.
- Atom tidak pernah memanggil API dan tidak menyimpan state aplikasi.
- Molekul merangkai atom, dan boleh menyimpan state lokal.
- Setiap tampilan data wajib punya keadaan kosong, memuat, dan gagal.

## Batas yang diketahui

Kerangka ini belum terhubung ke database. Endpoint yang ada baru `GET /api/v1/health`.
Halaman fitur (customer, perangkat, paket, subscription, invoice, pembayaran, audit)
belum dibangun, dan di navigasi ditandai `Segera` supaya tidak menjadi tautan mati.

## Dokumen

| Berkas | Isi |
|---|---|
| `API_Contract.md` | Kontrak API lengkap, termasuk integrasi Pakasir |
| `DB_Plan.md` | Rancangan 27 tabel PostgreSQL |
| `DESIGN.md` | Arah desain, palet, tipografi, dan rasio kontras yang sudah diverifikasi |

`DESIGN.md` dibaca lebih dulu sebelum mengerjakan urusan antarmuka.

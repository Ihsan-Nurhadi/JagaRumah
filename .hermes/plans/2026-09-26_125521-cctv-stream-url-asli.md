# Stream CCTV kembali memakai URL sumber asli

Tanggal: 26 September 2026, 12:55 WIB
Status: selesai, sudah diverifikasi lokal (belum dijalankan di runtime)

## Alasan

Permintaan mas bos: stream CCTV jangan diproxy lagi, client memakai `stream_url` asli
langsung dari `camera_telemetry`. Karena seluruh lapisan proxy masuk lewat tiga commit
teratas `main`, jalur yang dipilih adalah `git revert` ketiganya, bukan menulis ulang kode.

## Commit yang di-revert

| Commit | Isi yang dibatalkan |
|---|---|
| `8e0262a` | stream dan thumbnail mobile pakai JWT akun di header |
| `127ce04` | proxy stream dan thumbnail mobile dengan token JWT short-lived |
| `4e4f235` | endpoint proxy admin + `stream_url` di detail device + panel preview CCTV |

Ketiganya berturut-turut di puncak `main` saat revert dijalankan, jadi revert bersih tanpa konflik.
`git revert` dipakai, bukan `reset`, karena `main` sudah sama dengan `origin/main`.

## Keadaan sesudah revert

- `GET /api/v1/admin/devices/{device_id}/stream` dihapus.
- `GET /api/v1/mobile/stream/{device_id}` dan `/thumbnail` dihapus.
- `cameraList` dan `cameraDetail` mengembalikan `stream_url` dan `thumbnail_url` asli dari
  `camera_telemetry`, tanpa token dan tanpa proxy same-origin.
- `findDevice` tidak lagi membaca `camera_telemetry`; `GET /api/v1/admin/devices/{device_id}`
  tidak lagi mengembalikan `stream_url`.
- Panel "Preview CCTV" dan dialog konfirmasi privasi di `src/components/organisms/device-detail.tsx`
  dihapus. Halaman `/devices/[id]` kembali ke identitas, garansi, penugasan, dan percobaan klaim.
- `signStreamToken`, `signThumbnailToken`, `requireStreamToken`, dan `streamTokenSchema` di
  `src/lib/server/mobile.ts` dihapus.
- `API_Contract.md`, `MOBILE_API_Contract.md`, dan `CHECKPOINT.md` dikembalikan ke bentuk sebelum
  ketiga commit itu.

## Konsekuensi yang disadari

- URL sumber CCTV tampil di response API yang diterima klien. Sebelumnya URL itu dijaga di server.
  Ini keputusan yang diminta, bukan kelalaian.
- Thumbnail mobile memakai `thumbnail_url` apa adanya. Untuk kamera demo yang `thumbnail_url`-nya
  menunjuk MJPEG (`/api/stream`), hasilnya bukan satu JPEG, melainkan stream.
- Protokol sumber tidak diseragamkan. Kamera `Teras Utama` MJPEG, sedangkan kamera lain HLS atau
  URL mati. Client harus memilih renderer berdasarkan protokol sumber.

## Verifikasi

```text
pnpm exec tsc --noEmit   PASS — 0 error (setelah .next/dev/types lama dihapus)
pnpm lint                PASS — 0 error, 1 warning lama di admin-users activate
git diff --check         PASS
grep sisa rujukan        PASS — tidak ada sisa /mobile/stream, StreamPreview, atau signStreamToken
```

Uji endpoint live belum dijalankan: proses `nayaka` tidak sedang berjalan di pm2 saat revert
dilakukan, jadi proxy yang dihapus belum pernah dipanggil dan endpoint baru (URL asli) belum
di-smoke-test.

## Sisa pending

1. `camera_telemetry` masih menyimpan URL placeholder `https://dr.public/...` pada lima kamera
   (Ruang Rapat, Parkir Timur, Lobby Bawah, Gudang B, Pos Satpam). Domainnya tidak resolve, jadi
   client akan menerima URL mati. Perlu diganti URL asli atau dikosongkan.
2. `thumbnail_url` kamera `Teras Utama` masih sama dengan `stream_url`-nya (`/api/stream`).
3. Kamera `Gudang A` masih memakai HLS test publik Akamai, bukan CCTV nyata.
4. Uji live endpoint kamera mobile dan halaman `/devices/[id]` setelah runtime dijalankan.

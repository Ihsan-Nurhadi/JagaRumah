# Perbaikan live camera dan ringkasan perangkat

Tanggal: 29 September 2026
Status: implementasi selesai; smoke UI terautentikasi belum terverifikasi

## Temuan

- Commit `27a2978` memang menghapus panel Preview CCTV, endpoint proxy admin, dan `stream_url` dari detail admin.
- Data device `78e12a4c-c0cb-4b78-86e0-5193859f4159` masih punya telemetry aktif, recording aktif, dan URL sumber `http://110.232.92.134:3001/api/stream`.
- Customer demo belum memiliki subscription aktif, sehingga kartu kuota jatuh ke keadaan kosong.

## Perubahan

- Mengembalikan panel Preview CCTV dengan konfirmasi kewenangan dan renderer MJPEG dari implementasi `4e4f235`.
- Mengembalikan `stream_url` pada query detail admin, sekaligus menambahkan telemetry status, status rekaman, dan waktu terakhir terlihat.
- Kartu ringkasan memakai nilai nyata dari telemetry/claim/subscription; fallback fixture demo diberi label Paket Demo dan tidak lagi menampilkan `Belum diketahui` untuk perangkat contoh.
- Menambahkan fixture subscription `Paket Demo` batas 3 perangkat untuk customer `Mobile Demo` dan menyegarkan `last_seen_at` telemetry target.

## Verifikasi

- Query DB target sesudah perubahan: `connection_status=active`, `recording_status=recording`, URL stream tersedia, `Paket Demo`, batas 3, perangkat aktif 1.
- `pnpm exec tsc --noEmit`: PASS.
- `pnpm lint`: PASS dengan 1 warning lama di `admin-users/[admin_user_id]/activate/route.ts` (`result` tidak dipakai).
- `git diff --check`: PASS.
- PM2 `nayaka` dijalankan pada `127.0.0.1:3101`; request tanpa sesi ke `/devices/<id>` terverifikasi redirect login (guard bekerja).

## Pending / batasan

- Smoke test browser sampai panel preview dan endpoint admin dengan sesi admin nyata belum dijalankan karena tidak ada sesi login yang diberikan/tersedia.
- URL sumber adalah HTTP dan dapat diblokir mixed content bila halaman dibuka melalui HTTPS; ini sifat keputusan URL sumber asli, bukan proxy.
- `thumbnail_url` target masih sama dengan URL MJPEG stream sehingga bukan thumbnail satu frame.

## Follow-up blank preview

Vercel menerima upstream MJPEG dan frame JPEG valid, tetapi browser tetap menampilkan area hitam saat endpoint admin meneruskan multipart stream langsung. Perbaikan mengubah endpoint admin menjadi pengambil satu frame JPEG (`image/jpeg`), lalu UI meminta frame baru setiap 2 detik dengan cache-busting query. PM2 tidak digunakan.

Verifikasi lokal lanjutan: `pnpm exec tsc --noEmit`, `pnpm lint` (1 warning lama), dan `git diff --check` lulus. Smoke authenticated Vercel tetap memerlukan sesi admin nyata.

- Tidak commit atau push otomatis.

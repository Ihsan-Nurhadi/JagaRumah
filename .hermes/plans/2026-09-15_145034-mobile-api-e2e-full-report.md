# Laporan E2E Mobile API Nayaka

Tanggal: 2026-09-15
Target: `http://127.0.0.1:3101`
Repository: `/home/unity008/Projekan/Nayaka`
Rencana acuan: `.hermes/plans/2026-09-15_145034-mobile-api-e2e.md`

## Ringkasan

Pengujian E2E dijalankan terhadap endpoint mobile menggunakan HTTP nyata ke server Next.js/PM2.
Pengujian negative/public berhasil dijalankan. Pengujian authenticated positive belum dapat
menyelesaikan flow karena environment PM2 belum memiliki `JWT_CUSTOMER_ACCESS_SECRET`.

```text
PASS       10
FAIL        0
UNVERIFIED  7 utama + endpoint authenticated lain
BLOCKED    12
SKIPPED     0
```

Tidak ada credential, password, token, atau reset code yang ditulis ke laporan ini.

## Environment dan prerequisite

### Target

```text
http://127.0.0.1:3101
```

### Database

Migration demo camera sudah diterapkan:

```text
0015_camera_stream_url.sql
```

Status migration sebelum test:

```text
15 migration terpasang
0 migration menunggu
```

### Blocker yang ditemukan

Register valid mengembalikan `500 INTERNAL_ERROR`. Log server menunjukkan:

```text
Konfigurasi JWT_CUSTOMER_ACCESS_SECRET belum diisi.
```

Dampak:

- Register valid tidak bisa menerbitkan access JWT.
- Tidak dapat membuat fixture customer baru lewat API.
- Semua test yang membutuhkan bearer token valid tidak dapat diklaim PASS.
- Login/refresh/profile/dashboard/camera authenticated belum tervalidasi happy path.

Perbaikan environment yang diperlukan:

```env
JWT_CUSTOMER_ACCESS_SECRET=<secret random panjang>
JWT_CUSTOMER_REFRESH_SECRET=<secret random panjang berbeda>
```

Setelah env diisi, proses perlu direstart:

```bash
pm2 restart nayaka --update-env
```

## Hasil per test case

### T01 — Register payload valid

Status: `BLOCKED`

Request:

```http
POST /api/v1/mobile/auth/register
```

Expected: HTTP `201` dengan access token, refresh token, dan customer.

Actual: HTTP `500 INTERNAL_ERROR` karena `JWT_CUSTOMER_ACCESS_SECRET` belum tersedia pada
environment PM2.

Catatan: database/auth insert tidak boleh dianggap berhasil hanya karena route dipanggil.

### T02 — Register malformed payload

Status: `PASS`

Request body:

```json
{}
```

Actual:

```text
HTTP 400
error.code = VALIDATION_ERROR
error.request_id tersedia
```

Tidak ada response secret atau error SQL mentah.

### T03 — Register email duplikat

Status: `BLOCKED`

Membutuhkan customer fixture valid. Tidak dijalankan karena T01 gagal menerbitkan token dan fixture
baru tidak boleh dibuat dengan credential sembarang.

### T04 — Login credential valid

Status: `BLOCKED`

Membutuhkan customer email/password fixture yang aman. Belum ada fixture email auth yang dapat
dipakai dan T01 terblokir oleh JWT customer secret.

### T05 — Login password salah

Status: `PASS`

Request memakai email non-existent dengan password format valid.

Actual:

```text
HTTP 401
error.code = INVALID_CREDENTIALS
error.request_id tersedia
```

Pesan generik, tidak membedakan keberadaan account.

### T06 — Login email tidak terdaftar

Status: `PASS`

Actual:

```text
HTTP 401
error.code = INVALID_CREDENTIALS
error.request_id tersedia
```

Bentuk error dibandingkan dengan T05 dan tidak membocorkan account existence.

### T07 — Refresh token rotation

Status: `BLOCKED`

Membutuhkan refresh token hasil login valid. Belum bisa dibuat karena T01/T04 terblokir.

### T08 — Refresh token reuse

Status: `BLOCKED`

Membutuhkan token lama setelah rotation. Belum bisa dijalankan tanpa authenticated session fixture.

### T09 — Protected endpoint tanpa bearer

Status: `PASS`

Request:

```http
GET /api/v1/mobile/me
```

Tanpa header Authorization.

Actual:

```text
HTTP 401
error.code = INVALID_CREDENTIALS
error.request_id tersedia
```

### T10 — Protected endpoint dengan bearer invalid

Status: `PASS`

Request memakai bearer token invalid.

Actual:

```text
HTTP 401
error.code = TOKEN_EXPIRED
error.request_id tersedia
```

Tidak ada profile/data customer yang bocor.

### T11 — Get profile dengan token valid

Status: `BLOCKED`

Membutuhkan bearer token valid.

### T12 — Patch profile field yang diizinkan

Status: `BLOCKED`

Membutuhkan bearer token valid dan fixture customer.

### T13 — Patch profile payload invalid/sensitive

Status: `BLOCKED`

Belum dijalankan karena tidak ada authenticated fixture aman.

### T14 — Forgot password malformed

Status: `PASS`

Request body:

```json
{}
```

Actual:

```text
HTTP 400
error.code = VALIDATION_ERROR
error.request_id tersedia
```

### T15 — Forgot password email tidak terdaftar

Status: `PASS`

Request memakai email syntactically valid yang tidak terdaftar.

Actual:

```text
HTTP 200
data.sent = true
data.expires_in = 900
meta.request_id tersedia
```

Response generik sesuai tujuan anti-enumeration. Tidak ada bukti email dikirim untuk account yang
tidak ada.

### T16 — Forgot password email valid + Mailtrap

Status: `UNVERIFIED`

Belum dijalankan karena:

- Belum ada customer fixture email/password valid.
- Credential Mailtrap tidak dikonfirmasi tersedia pada environment target.
- Delivery hanya boleh diklaim setelah pesan terlihat di Inbox Mailtrap.

### T17 — Reset password code invalid

Status: `PASS`

Request memakai email valid-format, code 6 digit yang tidak memiliki reset record.

Actual:

```text
HTTP 422
error.code = VERIFICATION_EXPIRED
error.request_id tersedia
```

Tidak ada password/session yang diubah.

### T18 — Reset password code valid

Status: `BLOCKED`

Membutuhkan customer fixture, reset email nyata, dan code asli dari Mailtrap. Code tidak boleh
dipalsukan atau ditulis ke log.

### T19 — Reset code reuse

Status: `BLOCKED`

Membutuhkan reset flow sukses pada T18.

### T20 — Emergency contacts tanpa auth

Status: `PASS`

Request:

```http
GET /api/v1/mobile/emergency-contacts
```

Tanpa bearer token.

Actual:

```text
HTTP 401
error.code = INVALID_CREDENTIALS
error.request_id tersedia
```

### T21 — Emergency contacts aktif dan terurut

Status: `BLOCKED`

Membutuhkan bearer token customer valid. Data admin/database sudah tersedia melalui API, tetapi
happy path mobile tidak boleh diklaim tanpa auth nyata.

### T22 — Mobile dashboard envelope

Status: `BLOCKED`

Membutuhkan bearer token customer valid.

### T23 — Camera ownership

Status: `BLOCKED`

Membutuhkan token customer dan fixture kamera customer. Ownership SQL belum dapat dibuktikan lewat
happy path tanpa authenticated fixture.

### T24 — Alert list/detail/read/read-all

Status: `BLOCKED`

Membutuhkan token customer dan fixture alert. Belum ada fixture aman untuk flow authenticated.

### T25 — Recording list/detail/signed fields

Status: `UNVERIFIED`

Recording memang sengaja dilewati sesuai arahan user. Tidak ada recording demo yang dibuat.
Endpoint belum diuji happy path maupun signed playback URL.

### T26 — Settings dan push token ownership

Status: `BLOCKED`

Membutuhkan token customer valid dan installation fixture.

### T27 — Help dan terms visibility

Status: `UNVERIFIED`

Help public berhasil memberi response, tetapi matrix lengkap published/unpublished/current/not
found belum diuji dengan fixture content terkontrol.

### T28 — Content type/request ID contract

Status: `PASS`

Smoke request public help menghasilkan:

```text
HTTP 200
success envelope data + meta
meta.request_id tersedia
```

Negative request juga konsisten mengirim `error.request_id` pada T02, T05, T06, T09, T10, T14, T17,
dan T20.

### T29 — Authentication rate limit

Status: `UNVERIFIED`

Tidak dijalankan secara agresif agar tidak membebani environment. Implementasi rate limiting pada
route mobile perlu dikonfirmasi terpisah sebelum test threshold.

## Demo CCTV customer fixture

Recording dilewati. Satu kamera diberi sample public HLS untuk demo player.

Customer existing non-production:

```text
Budi Santoso Wijaya
customer_id: fba93667-e452-4e78-9175-088ecb5808a7
```

Kamera aktif:

```text
name: Kamera Gudang A
id: f1b3bc5e-4276-4642-b360-482ecec87db8
connection_status: active
recording_status: not_recording
stream_url: https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8
```

Kamera kedua:

```text
id: 32acd351-eacc-4b81-856f-74abba50f3de
connection_status: offline
recording_status: unknown
stream_url: null
```

URL stream sudah dicek dapat diakses dan mengembalikan HLS manifest HTTP `200`. Stream ini adalah
public test stream, bukan CCTV nyata. Jangan digunakan sebagai source production atau dianggap
sebagai bukti kamera fisik online.

## Verifikasi teknis

```text
pnpm db:migrate       PASS — migration 0015 applied
bash /tmp/nayaka-typecheck.sh  PASS — TSC_EXIT=0
pnpm lint             PASS
 git diff --check      PASS
```

## Kesimpulan

Negative/public API behavior yang diuji berjalan sesuai kontrak. Full E2E authenticated belum selesai
karena environment runtime tidak memiliki `JWT_CUSTOMER_ACCESS_SECRET`. Tidak ada test authenticated
yang ditandai PASS berdasarkan asumsi atau response `401` saja.

Urutan tindak lanjut:

1. Isi `JWT_CUSTOMER_ACCESS_SECRET` dan `JWT_CUSTOMER_REFRESH_SECRET` pada environment yang dipakai PM2/Vercel.
2. Restart runtime dengan `pm2 restart nayaka --update-env` untuk lokal.
3. Siapkan Mailtrap credential jika ingin menyelesaikan reset-mail delivery.
4. Ulangi T01, T03-T04, T07-T08, T11-T13, T16, T18-T19, T21-T24, T26.
5. Jalankan T27 dengan fixture published/unpublished/current yang terkontrol.
6. Jalankan T29 hanya setelah threshold rate limit dikonfirmasi.
7. Bersihkan fixture E2E setelah semua test selesai.

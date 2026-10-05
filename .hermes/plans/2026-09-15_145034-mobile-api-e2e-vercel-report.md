# Laporan E2E Mobile API — Vercel

Tanggal: 2026-09-15
Target: `https://nayaka-admin.vercel.app/api/v1/mobile`
Runtime: Vercel Function region `sin1`

## Ringkasan

Pengujian ini benar-benar diarahkan ke deployment Vercel, bukan server lokal `127.0.0.1`.

```text
PASS       12
FAIL        0
BLOCKED     1 utama
UNVERIFIED  authenticated happy path dan Mailtrap delivery
```

## Hasil test

| Test | Status | Hasil |
|---|---|---|
| T02 Register malformed | PASS | HTTP 400 `VALIDATION_ERROR` |
| T05 Login wrong password | PASS | HTTP 401 `INVALID_CREDENTIALS` |
| T06 Login unknown email | PASS | HTTP 401 `INVALID_CREDENTIALS` |
| T09 Profile tanpa bearer | PASS | HTTP 401 `INVALID_CREDENTIALS` |
| T10 Profile bearer invalid | PASS | HTTP 401 `TOKEN_EXPIRED` |
| T14 Forgot password malformed | PASS | HTTP 400 `VALIDATION_ERROR` |
| T15 Forgot unknown email | PASS | HTTP 200 generik, `sent=true`, `expires_in=900` |
| T17 Reset invalid code | PASS | HTTP 422 `VERIFICATION_EXPIRED` |
| T20 Emergency contacts tanpa auth | PASS | HTTP 401 `INVALID_CREDENTIALS` |
| T22 Dashboard tanpa auth | PASS | HTTP 401 `INVALID_CREDENTIALS` |
| T27 Help public | PASS | HTTP 200 envelope valid, request ID tersedia |
| T27 Terms tanpa dokumen current | PASS | HTTP 404 `RESOURCE_NOT_FOUND` |
| T01 Register valid | BLOCKED | HTTP 500 `INTERNAL_ERROR` |

## Detail Vercel responses

### Public help

```text
HTTP 200
x-vercel-id: sin1::sin1::...
content-type: application/json
```

Response shape:

```json
{
  "data": {
    "articles": [],
    "pagination": {
      "next_cursor": null,
      "has_more": false,
      "limit": 20
    }
  },
  "meta": {
    "request_id": "present"
  }
}
```

### Register malformed

```text
HTTP 400
error.code = VALIDATION_ERROR
error.details.fields = present
error.request_id = present
```

### Login enumeration safety

Password salah dan email tidak terdaftar sama-sama mengembalikan:

```text
HTTP 401
error.code = INVALID_CREDENTIALS
```

### Forgot unknown email

```text
HTTP 200
data.sent = true
data.expires_in = 900
meta.request_id = present
```

Response tidak membedakan email ada/tidak ada.

### Emergency contacts without authentication

```text
HTTP 401
error.code = INVALID_CREDENTIALS
```

### Terms

Karena database deployment belum memiliki dokumen terms current:

```text
HTTP 404
error.code = RESOURCE_NOT_FOUND
```

Ini sesuai kontrak untuk resource terms yang belum tersedia.

## Blocker authenticated flow

Register valid ke Vercel mengembalikan:

```text
HTTP 500
error.code = INTERNAL_ERROR
```

Karena response production tidak mengeluarkan detail konfigurasi, akar masalah belum dapat dipastikan hanya dari response publik. Kemungkinan yang perlu dicek di Vercel Project Settings → Environment Variables:

```env
DATABASE_URL
JWT_CUSTOMER_ACCESS_SECRET
JWT_CUSTOMER_REFRESH_SECRET
CSRF_SECRET
ENCRYPTION_KEY
APP_ENV=production
```

Saya tidak mencetak atau membaca nilai secret. Setelah env dikonfigurasi di Vercel, ulangi:

```text
T01 Register valid
T03 Duplicate email
T04 Login valid
T07 Refresh rotation
T08 Refresh reuse
T11 Profile
T12 Patch profile
T21 Emergency contacts authenticated
T22 Mobile dashboard authenticated
T23 Camera ownership
T24 Alerts ownership
T26 Settings/push token
```

### Mailtrap

Belum diklaim terkirim. T16/T18 membutuhkan:

- Customer fixture valid di database deployment.
- Mailtrap SMTP env Vercel.
- Verifikasi pesan nyata di Mailtrap Inbox.
- Code reset asli dari email.

## Catatan demo CCTV

Testing ini tidak mengubah atau mengklaim recording. Public CCTV/HLS demo yang sebelumnya disiapkan adalah fixture lokal/database dan belum dibuktikan tersedia pada response authenticated Vercel karena register/authenticated flow terblokir.

## Kesimpulan

Deployment Vercel dapat dijangkau dan public/negative API behavior berjalan sesuai kontrak. Full authenticated E2E belum selesai karena register valid di Vercel mengembalikan HTTP 500. Ini bukan bukti bahwa flow authenticated gagal secara domain; deployment environment perlu diperbaiki/dikonfirmasi terlebih dahulu.

# Mobile API Contract

Kontrak API khusus aplikasi mobile Nayaka.

Dokumen ini memisahkan kontrak aplikasi mobile dari API web admin. Semua endpoint mobile wajib berada
di namespace `/mobile`.

## 1. Namespace dan base URL

Logical path:

```text
/mobile/<endpoint>
```

Full API path:

```text
/api/v1/mobile/<endpoint>
```

Contoh:

```http
GET https://api.example.com/api/v1/mobile/dashboard
```

Endpoint di bawah `/api/v1/admin` bukan endpoint mobile. Endpoint lama di bawah
`/api/v1/customer` tidak menjadi kontrak baru untuk aplikasi mobile dan tidak boleh dipakai oleh
client mobile baru.

## 2. Konvensi umum

### 2.1 Transport

- HTTPS wajib.
- JSON request dan response memakai `Content-Type: application/json`.
- Semua timestamp memakai ISO 8601 UTC, contoh `2026-09-14T10:00:00Z`.
- Semua ID memakai UUID string.
- Nominal uang dikirim sebagai integer rupiah, bukan floating point.
- URL thumbnail dan playback adalah signed URL berumur pendek, bukan URL storage permanen.
- Response tidak boleh mengirim password, reset code, refresh token hash, secret kamera, credential
  perangkat, atau raw response provider.

### 2.2 Authorization

Endpoint publik:

```http
GET /api/v1/mobile/help
GET /api/v1/mobile/help/{article_id}
GET /api/v1/mobile/terms
POST /api/v1/mobile/auth/register
POST /api/v1/mobile/auth/login
POST /api/v1/mobile/auth/forgot-password
POST /api/v1/mobile/auth/reset-password
```

Endpoint lain memerlukan:

```http
Authorization: Bearer <access_token>
```

Access token JWT berumur 15 menit. Refresh token berumur 30 hari, disimpan sebagai hash, dirotasi
setiap kali digunakan, dan dicabut saat reuse.

### 2.3 Envelope response

Response sukses:

```json
{
  "data": {},
  "meta": {"request_id": "request-uuid"}
}
```

Response list memakai pagination cursor di dalam `meta.pagination`.

Error:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Parameter tidak valid.",
    "details": {},
    "request_id": "request-uuid"
  }
}
```

## 3. Authentication mobile

### 3.1 Register email dan password

```http
POST /api/v1/mobile/auth/register
```

Request:

```json
{
  "full_name": "Budi Santoso",
  "email": "budi@example.com",
  "password": "Password123",
  "installation_id": "mobile-installation-uuid",
  "platform": "android",
  "app_version": "1.0.0"
}
```

Password wajib minimal 8 karakter dan memiliki huruf kecil, huruf besar, serta angka. Backend
menyimpan bcrypt hash, bukan password plaintext.

Response `201`:

```json
{
  "data": {
    "access_token": "access-jwt",
    "refresh_token": "refresh-token",
    "token_type": "Bearer",
    "expires_in": 900,
    "onboarding_required": false,
    "customer": {
      "id": "customer-uuid",
      "full_name": "Budi Santoso",
      "email": "budi@example.com",
      "avatar_url": null,
      "status": "active"
    }
  },
  "meta": {"request_id": "request-uuid"}
}
```

Email dideduplikasi oleh constraint database. Email yang sudah ada menghasilkan `409
EMAIL_ALREADY_REGISTERED`.

### 3.2 Login email dan password

```http
POST /api/v1/mobile/auth/login
```

Request sama seperti register, tanpa `full_name`:

```json
{
  "email": "budi@example.com",
  "password": "Password123",
  "installation_id": "mobile-installation-uuid",
  "platform": "android",
  "app_version": "1.0.0"
}
```

Response `200` memakai bentuk token dan customer yang sama seperti register.

Email tidak terdaftar, password salah, dan account tidak aktif tidak boleh dibedakan secara
berlebihan oleh client. Kode normalnya `INVALID_CREDENTIALS`.

### 3.3 Lupa password melalui Mailtrap

```http
POST /api/v1/mobile/auth/forgot-password
```

Request:

```json
{"email": "budi@example.com"}
```

Backend mengirim kode 6 digit ke email melalui SMTP Mailtrap. Masa berlaku kode 15 menit.
Response sengaja seragam walaupun email belum terdaftar untuk mencegah enumerasi email:

```json
{
  "data": {
    "sent": true,
    "expires_in": 900
  },
  "meta": {"request_id": "request-uuid"}
}
```

Konfigurasi environment:

```env
MAILTRAP_SMTP_HOST=sandbox.smtp.mailtrap.io
MAILTRAP_SMTP_PORT=2525
MAILTRAP_SMTP_USERNAME=
MAILTRAP_SMTP_PASSWORD=
MAILTRAP_FROM_EMAIL=no-reply@nayaka.test
MAILTRAP_FROM_NAME=Nayaka
```

Isi `MAILTRAP_SMTP_USERNAME` dan `MAILTRAP_SMTP_PASSWORD` dari Mailtrap Inbox → SMTP/API
Tokens. Jangan commit nilai tersebut.

### 3.4 Reset password

```http
POST /api/v1/mobile/auth/reset-password
```

Request:

```json
{
  "email": "budi@example.com",
  "code": "123456",
  "new_password": "NewPassword123"
}
```

Kode hanya dapat digunakan satu kali. Maksimal 5 percobaan kode. Setelah reset berhasil, seluruh
session customer dicabut sehingga semua instalasi perlu login kembali.

Response:

```http
204 No Content
```

### 3.5 Refresh, logout

```http
POST /api/v1/mobile/auth/refresh
POST /api/v1/mobile/auth/logout
POST /api/v1/mobile/auth/logout-all
```

Request refresh:

```json
{
  "refresh_token": "refresh-token",
  "installation_id": "mobile-installation-uuid"
}
```

## 4. Emergency contacts

```http
GET /api/v1/mobile/emergency-contacts
```

Daftar nomor aktif untuk halaman Emergency Call. Endpoint wajib bearer token.

Admin mengelola daftar melalui `GET/POST /api/v1/admin/emergency-contacts` dan
`GET/PATCH/DELETE /api/v1/admin/emergency-contacts/{contact_id}`. `DELETE` menonaktifkan nomor,
bukan menghapus histori. Permission: `emergency_contact.read` dan `emergency_contact.manage`.

## 5. Dashboard

```http
GET /api/v1/mobile/dashboard
```

Mengembalikan jumlah kamera total, active, recording, offline, unknown, alert unread, kamera aktif
terbaru, dan alert terbaru.

## 5. Camera API

```http
GET /api/v1/mobile/cameras
GET /api/v1/mobile/cameras/{camera_id}
```

List mendukung filter `status`, `recording_status`, `q`, `limit`, dan `cursor`. Status koneksi dan
status recording berasal dari `camera_telemetry`; status lifecycle pada `devices` tidak dipetakan
menjadi online.

## 6. Alert API

```http
GET  /api/v1/mobile/alerts
GET  /api/v1/mobile/alerts/{alert_id}
POST /api/v1/mobile/alerts/{alert_id}/read
POST /api/v1/mobile/alerts/read-all
```

Filter tersedia: `camera_id`, `is_read`, `severity`, `type`, `from`, `to`, `limit`, dan `cursor`.

## 7. Recording API

```http
GET /api/v1/mobile/recordings
GET /api/v1/mobile/recordings/{recording_id}
```

Default hanya mengembalikan recording `available`. Playback URL dan thumbnail URL harus signed dan
memiliki expiry. Recording customer lain selalu menghasilkan `404 RESOURCE_NOT_FOUND`.

## 8. Profile API

```http
GET   /api/v1/mobile/me
PATCH /api/v1/mobile/me
```

`GET` mengembalikan profile dan subscription terakhir. `PATCH` hanya boleh mengubah `full_name`
dan `avatar_url`; email, status, dan subscription tidak dapat diubah dari endpoint ini.

## 9. Settings API

```http
GET   /api/v1/mobile/me/settings
PATCH /api/v1/mobile/me/settings
POST  /api/v1/mobile/me/push-tokens
DELETE /api/v1/mobile/me/push-tokens/{installation_id}
POST  /api/v1/mobile/me/biometric
DELETE /api/v1/mobile/me/biometric
```

Biometric adalah konfigurasi lokal Keychain/Keystore. Backend tidak menerima fingerprint, Face ID,
atau face template.

## 10. Help dan Terms & Conditions

```http
GET /api/v1/mobile/help
GET /api/v1/mobile/help/{article_id}
GET /api/v1/mobile/terms
```

Help mendukung `q`, `category`, `locale`, `limit`, dan `cursor`. Terms mendukung `locale` dan
`version`. Dokumen harus berstatus published/current agar dapat dikirim ke mobile.

## 11. Error contract

| Code | Status | Arti |
|---|---:|---|
| `VALIDATION_ERROR` | 400 | Request tidak valid |
| `INVALID_CREDENTIALS` | 401 | Email/password salah atau account tidak aktif |
| `TOKEN_EXPIRED` | 401 | Access token kedaluwarsa |
| `TOKEN_REVOKED` | 401 | Session dicabut atau refresh token tidak berlaku |
| `CUSTOMER_SUSPENDED` | 403 | Customer ditangguhkan |
| `RESOURCE_NOT_FOUND` | 404 | Resource tidak ada atau bukan milik customer |
| `EMAIL_ALREADY_REGISTERED` | 409 | Email sudah terdaftar |
| `WEAK_PASSWORD` | 422 | Password tidak memenuhi aturan |
| `VERIFICATION_EXPIRED` | 422 | Kode reset kedaluwarsa |
| `INVALID_VERIFICATION_CODE` | 422 | Kode reset salah |
| `VERIFICATION_ATTEMPTS_EXCEEDED` | 429 | Percobaan kode terlalu banyak |
| `RATE_LIMITED` | 429 | Terlalu banyak request |
| `INTERNAL_ERROR` | 500 | Kesalahan internal |

## 12. Environment

```env
JWT_CUSTOMER_ACCESS_SECRET=
JWT_CUSTOMER_REFRESH_SECRET=

MAILTRAP_SMTP_HOST=sandbox.smtp.mailtrap.io
MAILTRAP_SMTP_PORT=2525
MAILTRAP_SMTP_USERNAME=
MAILTRAP_SMTP_PASSWORD=
MAILTRAP_FROM_EMAIL=no-reply@nayaka.test
MAILTRAP_FROM_NAME=Nayaka
```

`GOOGLE_MOBILE_CLIENT_ID` tidak lagi diperlukan untuk flow authentication mobile ini.

## 13. Database dependency

Password reset menggunakan tabel `auth_verification_codes` yang sudah ada. Migration tambahan
menyediakan index khusus reset password:

```text
auth_verification_codes_reset_target_idx
```

Data camera, alert, recording, settings, push token, help, dan legal document memakai tabel pada
migration mobile CCTV.

## 14. Security rules

- Jangan log password, reset code, access token, atau refresh token.
- Reset password response tidak membocorkan apakah email terdaftar.
- Refresh token hanya dikirim melalui HTTPS dan dirotasi.
- Setelah reset password, semua session customer dicabut.
- Resource customer lain menghasilkan 404, bukan 403.
- SMTP credential hanya berada di environment server.
- Rate limit produksi perlu diterapkan pada register, login, forgot password, dan reset password.

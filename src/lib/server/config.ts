/*
  Pembacaan konfigurasi.

  Prinsipnya: rahasia tidak punya nilai cadangan. Kalau `JWT_ADMIN_ACCESS_SECRET` kosong,
  proses harus berhenti dengan pesan yang jelas, bukan diam-diam memakai nilai contoh. Nilai
  contoh yang terpakai di produksi berarti siapa pun yang membaca repo ini bisa membuat token
  admin yang sah.

  Modul ini hanya boleh diimpor dari kode server. Jangan pernah mengimpornya dari komponen
  klien, karena nilainya akan ikut terkirim ke browser.
*/

export type AppEnv = "development" | "test" | "production";

function read(key: string): string | undefined {
  const value = process.env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function appEnv(): AppEnv {
  const value = read("APP_ENV") ?? process.env.NODE_ENV ?? "development";
  if (value === "production" || value === "test") return value;
  return "development";
}

export function isProduction(): boolean {
  return appEnv() === "production";
}

/*
  Dipanggil dari kode yang butuh nilai pasti. Pesannya menyebut variabel mana yang kosong dan
  dari mana nilainya diharapkan datang, supaya tidak perlu menebak.
*/
function required(key: string, hint: string): string {
  const value = read(key);
  if (!value) {
    throw new Error(
      `Konfigurasi ${key} belum diisi. ${hint} Salin .env.example menjadi .env lalu isi nilainya.`,
    );
  }
  return value;
}

export function databaseUrl(): string {
  return required(
    "DATABASE_URL",
    "Isi dengan connection string PostgreSQL dari Supabase.",
  );
}

/*
  kunci HMAC untuk access token admin.
*/
export function jwtAdminAccessSecret(): string {
  return required(
    "JWT_ADMIN_ACCESS_SECRET",
    "Isi dengan string acak panjang, misalnya hasil `openssl rand -base64 48`.",
  );
}

/* Kunci HMAC terpisah untuk access token aplikasi mobile customer. */
export function jwtCustomerAccessSecret(): string {
  return required(
    "JWT_CUSTOMER_ACCESS_SECRET",
    "Isi dengan string acak panjang yang berbeda dari JWT admin.",
  );
}

export function csrfSecret(): string {
  return required(
    "CSRF_SECRET",
    "Isi dengan string acak panjang, berbeda dari kunci JWT.",
  );
}

// Umur token mengikuti tabel di API_Contract.md bagian JWT, cookie, dan security.
export const ADMIN_ACCESS_TTL_SECONDS = 15 * 60;
export const ADMIN_REFRESH_TTL_SECONDS = 8 * 60 * 60;
export const ADMIN_REFRESH_ABSOLUTE_TTL_SECONDS = 12 * 60 * 60;

export const COOKIE_ADMIN_ACCESS = "admin_access_token";
export const COOKIE_ADMIN_REFRESH = "admin_refresh_token";
export const COOKIE_ADMIN_CSRF = "admin_csrf_token";

export const HEADER_CSRF = "x-csrf-token";

export const ADMIN_REFRESH_PATH = "/api/v1/admin/auth";

/*
  Di mode http (development), cookie Secure tidak akan pernah dikirim browser, jadi login akan
  terlihat berhasil tetapi sesi selalu kosong. Karena itu Secure diikat ke produksi.
*/
export function cookieSecure(): boolean {
  return isProduction();
}

/*
  Percobaan login dibatasi per akun dan per IP:
  - 5 kegagalan berturut-turut pada akun yang sama dalam 15 menit membuat akun terkunci sementara.
  - 20 kegagalan dari IP yang sama dalam 15 menit membuat IP ditolak sementara.
*/
export const LOGIN_ACCOUNT_MAX_FAILURES = 5;
export const LOGIN_IP_MAX_FAILURES = 20;
export const LOGIN_WINDOW_MINUTES = 15;

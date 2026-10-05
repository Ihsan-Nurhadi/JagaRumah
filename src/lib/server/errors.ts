/*
  Bentuk galat API.

  Satu tempat yang menentukan kode, status HTTP, dan pesan. Tabel di API_Contract.md bagian
  "Pemetaan error ke HTTP status" adalah rujukannya. Kode yang tidak ada di sini tidak boleh
  dikarang di tempat lain, karena kode yang tidak dikenal akan membingungkan klien.

  Yang tidak pernah keluar dari sini: stack trace, potongan SQL, kata sandi, token, dan
  respons mentah provider. Kegagalan provider diterjemahkan lebih dulu.
*/

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REVOKED: 401,
  GOOGLE_TOKEN_INVALID: 401,
  GOOGLE_TOKEN_EXPIRED: 401,
  INVALID_GOOGLE_TOKEN: 401,
  PAYMENT_WEBHOOK_INVALID: 401,
  PERMISSION_DENIED: 403,
  CSRF_TOKEN_INVALID: 403,
  CUSTOMER_SUSPENDED: 403,
  RESOURCE_NOT_FOUND: 404,
  VERIFICATION_NOT_FOUND: 404,
  SERIAL_NUMBER_NOT_FOUND: 404,
  EMAIL_ALREADY_REGISTERED: 409,
  PHONE_ALREADY_LINKED: 409,
  GOOGLE_ACCOUNT_LINK_REQUIRED: 409,
  DEVICE_ALREADY_CLAIMED: 409,
  SERIAL_NUMBER_ALREADY_REGISTERED: 409,
  /*
    Dipakai saat membuat akun admin. Dibedakan dari EMAIL_ALREADY_REGISTERED karena kode itu
    menunjuk pada pendaftaran pelanggan melalui aplikasi, jalur yang berbeda sama sekali.
  */
  ADMIN_USERNAME_TAKEN: 409,
  ADMIN_EMAIL_TAKEN: 409,
  SUBSCRIPTION_ALREADY_ACTIVE: 409,
  UPGRADE_ALREADY_PENDING: 409,
  INVOICE_NOT_PAYABLE: 409,
  PAYMENT_ALREADY_PENDING: 409,
  PAYMENT_ALREADY_PAID: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  SIMULTANEOUS_CONFLICT: 409,
  WEAK_PASSWORD: 422,
  VERIFICATION_EXPIRED: 422,
  INVALID_VERIFICATION_CODE: 422,
  CLAIM_TOKEN_INVALID: 422,
  DEVICE_SUSPENDED: 422,
  DEVICE_LIMIT_REACHED: 422,
  ACTIVE_SUBSCRIPTION_REQUIRED: 422,
  PLAN_PRICE_INVALID: 422,
  PAYMENT_METHOD_INVALID: 422,
  DOWNGRADE_NOT_ALLOWED: 422,
  UPGRADE_INTERVAL_MISMATCH: 422,
  RATE_LIMITED: 429,
  AUTH_RATE_LIMITED: 429,
  DEVICE_CLAIM_RATE_LIMITED: 429,
  VERIFICATION_ATTEMPTS_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
  PAYMENT_PROVIDER_ERROR: 502,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  // Header tambahan, dipakai `429` untuk mengirim Retry-After.
  readonly headers?: Record<string, string>;

  constructor(input: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    headers?: Record<string, string>;
  }) {
    super(input.message);
    this.name = "AppError";
    this.code = input.code;
    this.status = ERROR_STATUS[input.code];
    this.details = input.details;
    this.headers = input.headers;
  }
}

export function errorResponse(error: AppError, requestId: string): Response {
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        request_id: requestId,
      },
    },
    { status: error.status, headers: error.headers },
  );
}

/*
  Dipakai di blok catch route handler.

  Galat yang tidak dikenali tidak pernah diteruskan apa adanya ke klien. Yang tercatat di log
  server adalah galat aslinya, sedangkan klien hanya menerima pesan umum. Tanpa pemisahan ini,
  pesan driver database yang memuat nama tabel dan kolom akan bocor ke browser.
*/
export function toAppError(error: unknown, context: string): AppError {
  if (error instanceof AppError) return error;

  console.error(`[${context}] galat tak terduga:`, error);

  return new AppError({
    code: "INTERNAL_ERROR",
    message:
      "Server gagal memproses permintaan ini. Coba lagi sebentar lagi. " +
      "Jika tetap gagal, laporkan waktu kejadiannya ke tim teknis.",
  });
}

export function validationError(details: Record<string, unknown>): AppError {
  return new AppError({
    code: "VALIDATION_ERROR",
    message: "Data yang dikirim tidak valid. Periksa kolom yang ditandai lalu kirim ulang.",
    details,
  });
}

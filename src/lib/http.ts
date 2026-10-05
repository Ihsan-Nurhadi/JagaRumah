import axios, { AxiosError, type AxiosInstance } from "axios";

/*
  Bentuk envelope mengikuti API_Contract.md.
  Sukses: { data, meta: { request_id } }
  Gagal:  { error: { code, message, details, request_id } }
*/
export type ApiEnvelope<T> = {
  data: T;
  meta?: {
    request_id?: string;
    pagination?: {
      next_cursor: string | null;
      has_more: boolean;
      limit: number;
    };
  };
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    request_id?: string;
  };
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    details?: Record<string, unknown>;
    requestId?: string;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code;
    this.status = input.status;
    this.details = input.details;
    this.requestId = input.requestId;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const candidate = (value as { error?: unknown }).error;
  return typeof candidate === "object" && candidate !== null;
}

export const http: AxiosInstance = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api/v1",
  headers: { "Content-Type": "application/json" },
  // Cookie admin HttpOnly dikirim otomatis oleh browser karena satu origin.
  withCredentials: true,
});

/*
  Menyeragamkan kegagalan jadi ApiError, supaya pemanggil hanya menangani satu bentuk.
  Pesan dari server dipakai apa adanya, dan tidak pernah menampilkan stack trace provider.
*/
http.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response) {
      const body = error.response.data;
      if (isApiErrorBody(body)) {
        return Promise.reject(
          new ApiError({
            code: body.error.code,
            message: body.error.message,
            status: error.response.status,
            details: body.error.details,
            requestId: body.error.request_id,
          }),
        );
      }
      return Promise.reject(
        new ApiError({
          code: "UNEXPECTED_RESPONSE",
          message: "Server membalas dengan bentuk yang tidak dikenali.",
          status: error.response.status,
        }),
      );
    }

    return Promise.reject(
      new ApiError({
        code: "NETWORK_ERROR",
        message: "Tidak dapat menghubungi server. Periksa koneksi lalu coba lagi.",
        status: 0,
      }),
    );
  },
);

export async function apiGet<T>(url: string, params?: Record<string, unknown>) {
  const response = await http.get<ApiEnvelope<T>>(url, { params });
  return response.data;
}

export async function apiPost<T>(
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const response = await http.post<ApiEnvelope<T>>(url, body, { headers });
  return response.data;
}

export async function apiPatch<T>(
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const response = await http.patch<ApiEnvelope<T>>(url, body, { headers });
  return response.data;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

// Dipakai di UI supaya pesan galat tidak pernah kosong.
export function toErrorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Terjadi kesalahan yang tidak dikenali.";
}

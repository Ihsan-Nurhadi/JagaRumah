import { cookies, headers } from "next/headers";
import { ZodError } from "zod";

import { AppError } from "./errors";

/*
  Alat bantu request untuk route handler.

  Semua route admin memakai bentuk yang sama: envelope sukses `{ data, meta.request_id }`,
  envelope gagal `{ error }`, dan setiap permintaan punya request_id yang ikut tercatat di log
  maupun di response. Tanpa request_id, keluhan pengguna tidak bisa dicocokkan dengan baris log
  mana pun.
*/

export function requestIdFrom(request: Request): string {
  const headerValue = request.headers.get("x-request-id");
  return headerValue && headerValue.length <= 200 ? headerValue : crypto.randomUUID();
}

export function ok<T>(data: T, requestId: string, init?: ResponseInit): Response {
  return Response.json({ data, meta: { request_id: requestId } }, init);
}

export function created<T>(data: T, requestId: string): Response {
  return ok(data, requestId, { status: 201 });
}

/*
  Response daftar. Bentuk meta-nya berbeda dari response tunggal karena memuat pagination, dan
  API_Contract.md menetapkannya tepat pada satu tempat: di dalam meta, bukan di dalam data.
*/
export function listed<T>(
  data: T,
  pagination: { next_cursor: string | null; has_more: boolean; limit: number },
  requestId: string,
): Response {
  return Response.json({ data, meta: { request_id: requestId, pagination } });
}

export function noContent(requestId: string): Response {
  return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
}

/*
  ID dari URL diperiksa bentuknya sebelum dipakai. Tanpa pemeriksaan ini, uuid yang salah bentuk
  akan sampai ke PostgreSQL dan menghasilkan galat driver, bukan 404 yang seharusnya.
*/
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireUuid(value: string | undefined, field: string): string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message: `Data yang diminta tidak ditemukan. Parameter ${field} pada alamat tidak sah.`,
    });
  }
  return value;
}

/*
  Ubah ZodError menjadi daftar kolom yang bermasalah. Kuncinya adalah nama kolom, sehingga
  antarmuka bisa menempelkan pesan tepat di kolom yang salah, bukan menumpuknya di satu tempat.
*/
export function zodDetails(error: ZodError): Record<string, unknown> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    if (!fields[path]) fields[path] = issue.message;
  }
  return { fields };
}

// ------------------------------------------------------------------ IP dan user agent

/*
  IP diambil dari header yang diset proxy di depannya. Di Supabase, permintaan masuk lewat CDN,
  sehingga alamat soket selalu alamat CDN dan tidak berguna untuk pembatasan per IP.
*/
export async function clientIp(): Promise<string | null> {
  const store = await headers();
  const forwarded = store.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(store.get("x-real-ip") ?? "");
}

function normalizeIp(value: string): string | null {
  const candidate = value.startsWith("::ffff:") ? value.slice(7) : value;
  if (!candidate) return null;
  /*
    Kolomnya bertipe inet, jadi nilai yang bukan IP akan ditolak database. Lebih baik menyimpan
    null daripada menggagalkan seluruh permintaan hanya karena header yang aneh.
  */
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(candidate);
  const isIpv6 = /^[0-9a-f:]+$/i.test(candidate) && candidate.includes(":");
  return isIpv4 || isIpv6 ? candidate : null;
}

export async function userAgent(): Promise<string | null> {
  const store = await headers();
  const value = store.get("user-agent");
  if (!value) return null;
  // Dipotong supaya satu header raksasa tidak memenuhi kolom.
  return value.slice(0, 500);
}

// ------------------------------------------------------------------ cookie

export async function readCookie(name: string): Promise<string | undefined> {
  return (await cookies()).get(name)?.value;
}

/*
  Opsi cookie disusun di satu tempat supaya tidak ada penulisan cookie yang lupa HttpOnly.
*/
export function cookieOptions(input: {
  path: string;
  maxAgeSeconds: number;
  secure: boolean;
  httpOnly: boolean;
}) {
  return {
    path: input.path,
    maxAge: input.maxAgeSeconds,
    secure: input.secure,
    httpOnly: input.httpOnly,
    sameSite: "lax" as const,
  };
}

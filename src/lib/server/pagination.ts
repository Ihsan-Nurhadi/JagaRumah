/*
  Paginasi cursor untuk endpoint daftar.

  API_Contract.md menetapkan `limit` default 20 maksimum 100, `cursor` opaque, dan `sort` dengan
  allowlist per endpoint. Berkas ini menegakkan ketiga hal itu di satu tempat, supaya tidak ada
  endpoint yang lupa memeriksa batas atau menerima nama kolom sembarang.

  Kenapa cursor, bukan nomor halaman: daftar perangkat, invoice, dan audit terus bertambah di
  ujung depan. Dengan nomor halaman, satu baris baru yang masuk saat pengguna membuka halaman 2
  membuat baris yang sama muncul dua kali di halaman 3, atau terlewat sama sekali. Cursor
  menempel pada posisi baris, bukan pada nomor urutnya.

  Cursor berisi nilai kolom sortir dan id baris terakhir. Id ikut dibawa karena nilai kolom
  sortir tidak unik: dua perangkat yang didaftarkan pada detik yang sama akan punya created_at
  identik, dan tanpa tie-breaker urutannya tidak stabil sehingga ada baris yang bisa terlewat.
*/
import { AppError } from "./errors";

export type SortDirection = "asc" | "desc";

export type SortAllowlist = Record<string, { column: string; defaultDirection: SortDirection }>;

export type CursorPayload = { value: string; id: string };

export type PageRequest = {
  limit: number;
  sortField: string;
  sortColumn: string;
  sortDirection: SortDirection;
  cursor: CursorPayload | null;
};

export type PageMeta = {
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
};

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

function invalid(message: string, details?: Record<string, unknown>): AppError {
  return new AppError({ code: "VALIDATION_ERROR", message, details });
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === "") return DEFAULT_LIMIT;

  // Number() dipakai, bukan parseInt(), supaya "20abc" ditolak alih-alih diam-diam menjadi 20.
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw invalid("Parameter limit harus berupa angka bulat minimal 1.", { limit: raw });
  }
  if (value > MAX_LIMIT) {
    throw invalid(`Parameter limit maksimal ${MAX_LIMIT}.`, { limit: raw, max: MAX_LIMIT });
  }
  return value;
}

function parseSort(
  raw: string | null,
  allowlist: SortAllowlist,
  fallback: string,
): { field: string; column: string; direction: SortDirection } {
  const requested = raw && raw.trim() !== "" ? raw.trim() : fallback;
  const explicitDirection: SortDirection | null = requested.startsWith("-")
    ? "desc"
    : requested.startsWith("+")
      ? "asc"
      : null;
  const field = explicitDirection ? requested.slice(1) : requested;

  const allowed = allowlist[field];
  if (!allowed) {
    /*
      Field di luar allowlist ditolak, bukan diabaikan. Mengabaikannya diam-diam membuat klien
      mengira urutannya sudah berubah padahal tidak.
    */
    throw invalid(
      `Parameter sort "${field}" tidak dikenal untuk daftar ini. Pilihan yang tersedia: ` +
        `${Object.keys(allowlist).join(", ")}.`,
      { sort: field, allowed: Object.keys(allowlist) },
    );
  }

  return {
    field,
    column: allowed.column,
    direction: explicitDirection ?? allowed.defaultDirection,
  };
}

export function encodeCursor(value: string, id: string): string {
  return Buffer.from(JSON.stringify({ value, id }), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): CursorPayload | null {
  if (raw === null || raw === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid(
      "Parameter cursor tidak dapat dibaca. Muat ulang daftar ini dari awal, bukan dari alamat " +
        "yang disimpan sebelumnya.",
    );
  }

  const candidate = parsed as { value?: unknown; id?: unknown };
  if (typeof candidate?.value !== "string" || typeof candidate?.id !== "string") {
    throw invalid("Parameter cursor tidak berisi posisi yang dikenali.");
  }

  return { value: candidate.value, id: candidate.id };
}

export function parsePageRequest(
  searchParams: URLSearchParams,
  allowlist: SortAllowlist,
  defaultSort: string,
): PageRequest {
  const sort = parseSort(searchParams.get("sort"), allowlist, defaultSort);

  return {
    limit: parseLimit(searchParams.get("limit")),
    sortField: sort.field,
    sortColumn: sort.column,
    sortDirection: sort.direction,
    cursor: decodeCursor(searchParams.get("cursor")),
  };
}

/*
  Syarat tambahan untuk halaman berikutnya.

  Perbandingan baris `(kolom, id) < (nilai, id)` dipakai, bukan perbandingan kolom saja, supaya
  urutannya konsisten dengan ORDER BY termasuk saat nilai kolomnya sama. Nilai cursor dikirim
  sebagai parameter; PostgreSQL menyimpulkan tipenya dari kolom di sisi kiri, jadi tidak ada
  nama tipe yang perlu ditulis di sini dan tidak ada nilai yang disambung ke dalam SQL.
*/
export function keysetCondition(
  page: PageRequest,
  params: unknown[],
): string {
  if (!page.cursor) return "";

  const valueIndex = params.push(page.cursor.value);
  const idIndex = params.push(page.cursor.id);
  const operator = page.sortDirection === "desc" ? "<" : ">";

  return `AND (${page.sortColumn}, id) ${operator} ($${valueIndex}, $${idIndex}::uuid)`;
}

export function orderBy(page: PageRequest): string {
  const direction = page.sortDirection === "desc" ? "DESC" : "ASC";
  // id selalu ikut sebagai tie-breaker, supaya urutannya total dan tidak ada baris yang terlewat.
  return `ORDER BY ${page.sortColumn} ${direction}, id ${direction}`;
}

/*
  Mengambil satu baris lebih banyak dari yang diminta.

  Cara ini menentukan has_more tanpa kueri COUNT terpisah, yang pada tabel besar justru lebih
  mahal daripada kueri halamannya sendiri. Baris berlebih itu dibuang sebelum dikirim.
*/
export function buildPage<T extends { id: string; cursor_value: string }>(
  rows: T[],
  page: PageRequest,
): { items: T[]; pagination: PageMeta } {
  const hasMore = rows.length > page.limit;
  const items = hasMore ? rows.slice(0, page.limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    pagination: {
      next_cursor: hasMore && last ? encodeCursor(last.cursor_value, last.id) : null,
      has_more: hasMore,
      limit: page.limit,
    },
  };
}

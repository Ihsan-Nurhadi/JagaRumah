"use client";

import { useCallback, useEffect, useState } from "react";

import { toErrorMessage } from "@/lib/http";
import { csrfHeader, ensureCsrfToken } from "@/stores/session-store";

/*
  Pengambil data untuk halaman admin.

  Tiga keadaan yang harus dibedakan dengan jelas, karena ketiganya menuntut tindakan yang
  berbeda dari operator:

  - `memuat`  : permintaan sedang berjalan
  - `siap`    : data ada dan bisa dipakai
  - `galat`   : permintaan gagal, dan pesannya menyebut langkah berikutnya

  Yang tidak dilakukan: menampilkan angka nol saat data gagal dimuat. Nol dan "gagal dimuat"
  terlihat sama di layar tetapi artinya jauh berbeda, dan operator bisa mengambil keputusan
  berdasarkan angka nol yang sebenarnya tidak pernah diketahui.
*/

/*
  Ukuran halaman yang boleh dipilih operator.

  Batas atasnya 100, mengikuti API_Contract.md. Angka di luar daftar ini ditolak server, jadi
  pilihannya sengaja ditutup supaya tidak ada nilai yang ditawarkan tetapi ditolak.
*/
export const PAGE_SIZES = [20, 50, 100] as const;

export type DataState<T> = {
  status: "memuat" | "siap" | "galat";
  data: T | null;
  error: string | null;
  /** Kode galat dari server, dipakai membedakan izin kurang dari kegagalan lain. */
  errorCode: string | null;
  requestId: string | null;
  /**
   * Meta dari envelope response: request_id dan, untuk endpoint daftar, pagination.
   *
   * Sebelumnya bagian ini dibuang begitu saja, sehingga halaman daftar kehilangan satu-satunya
   * keterangan tentang apakah masih ada baris berikutnya di server.
   */
  meta: ApiMeta | null;
};

/*
  Bentuk pagination yang ditetapkan API_Contract.md: cursor buram, bukan nomor halaman.
*/
export type PageMeta = {
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
};

export type ApiMeta = {
  request_id?: string;
  pagination?: PageMeta;
};

export type DataQuery<T> = DataState<T> & {
  /** Mengambil ulang data yang sama. Dipakai tombol "Coba lagi". */
  reload: () => void;
  /** Mengganti parameter dan mengambil ulang, misalnya saat filter berubah. */
  setParams: (params: Record<string, string | number | undefined>) => void;
  params: Record<string, string | number | undefined>;
};

function buildUrl(url: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${url}?${query}` : url;
}

/*
  Mengambil data dari endpoint admin.

  Parameter sengaja dipisahkan dari URL supaya perubahan filter memicu pengambilan ulang secara
  otomatis, tanpa setiap halaman perlu menulis efek sendiri dan berisiko lupa membatalkan
  permintaan lama saat filter diganti cepat berturut-turut.
*/
export function useApiQuery<T>(
  url: string,
  initialParams: Record<string, string | number | undefined> = {},
): DataQuery<T> {
  const [params, setParamsState] = useState(initialParams);
  const [reloadToken, setReloadToken] = useState(0);

  /*
    Parameter awal diperlakukan sebagai nilai terkendali, bukan sekadar nilai pertama.

    Sebelumnya `initialParams` hanya dibaca sekali pada render pertama, sehingga pemanggil yang
    menurunkan parameternya dari state (misalnya rentang tanggal di halaman laporan) mengubah
    tampilan tanpa memicu permintaan baru: tanggal di layar berubah, isinya tetap periode lama.

    Perbandingan memakai bentuk serialnya, bukan identitas objek, karena setiap pemanggil
    menuliskan literal objek baru di setiap render. Tanpa itu, penulisan state akan berulang
    tanpa henti.
  */
  const initialKey = buildUrl("", initialParams);
  const [appliedInitialKey, setAppliedInitialKey] = useState(initialKey);
  if (initialKey !== appliedInitialKey) {
    setAppliedInitialKey(initialKey);
    setParamsState(initialParams);
  }

  /*
    Hasil disimpan bersama kunci permintaannya, bukan sekadar nilainya.

    Alasannya: keadaan "sedang memuat" tidak perlu disetel, ia disimpulkan. Selama hasil yang
    tersimpan belum berasal dari kunci yang sedang diminta, tampilannya adalah memuat. Cara ini
    menghindari penyetelan keadaan di dalam efek, yang memicu render berantai: satu render untuk
    menandai memuat, lalu satu lagi saat datanya tiba.
  */
  const [result, setResult] = useState<{
    key: string;
    data: T | null;
    error: string | null;
    errorCode: string | null;
    requestId: string | null;
    meta: ApiMeta | null;
  } | null>(null);

  const key = `${url}?${buildUrl("", params)}#${reloadToken}`;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      let next: {
        key: string;
        data: T | null;
        error: string | null;
        errorCode: string | null;
        requestId: string | null;
        meta: ApiMeta | null;
      };

      try {
        const response = await fetch(buildUrl(url, params), {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });

        const body = (await response.json().catch(() => null)) as
          | {
              data?: T;
              meta?: ApiMeta;
              error?: { code: string; message: string; request_id?: string };
            }
          | null;

        if (!response.ok || !body || body.error) {
          next = {
            key,
            data: null,
            error: body?.error?.message ?? "Server tidak mengirim keterangan galat.",
            errorCode: body?.error?.code ?? null,
            requestId: body?.error?.request_id ?? null,
            meta: null,
          };
        } else {
          next = {
            key,
            data: (body.data ?? null) as T,
            error: null,
            errorCode: null,
            requestId: null,
            meta: body.meta ?? null,
          };
        }
      } catch (error) {
        /*
          Permintaan yang dibatalkan bukan kegagalan, jadi hasilnya tidak ditulis sama sekali.
          Menuliskannya akan membuat daftar berkedip menjadi galat setiap kali filter diganti.
        */
        if (controller.signal.aborted) return;
        next = {
          key,
          data: null,
          error: toErrorMessage(error),
          errorCode: "NETWORK_ERROR",
          requestId: null,
          meta: null,
        };
      }

      if (!cancelled) setResult(next);
    }

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, params, key]);

  const fresh = result?.key === key ? result : null;

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  const setParams = useCallback(
    (next: Record<string, string | number | undefined>) =>
      setParamsState((current) =>
        buildUrl("", current) === buildUrl("", next) ? current : next,
      ),
    [],
  );

  return {
    status: fresh ? (fresh.error ? "galat" : "siap") : "memuat",
    data: fresh?.data ?? null,
    error: fresh?.error ?? null,
    errorCode: fresh?.errorCode ?? null,
    requestId: fresh?.requestId ?? null,
    meta: fresh?.meta ?? null,
    reload,
    setParams,
    params,
  };
}

/*
  Hook daftar ber-paginasi cursor.

  Server sudah mengirim `meta.pagination` sejak awal, tetapi dulu dibuang di klien sehingga halaman
  daftar hanya bisa menampilkan baris pertama tanpa cara mengambil sisanya.

  Bentuknya cursor, bukan nomor halaman, jadi "kembali" tidak bisa dihitung dari nomor: tumpukan
  cursor disimpan di sini. Setiap halaman berikutnya menyimpan cursor yang dipakai untuk
  mencapainya, sehingga mundur memakai posisi yang benar-benar pernah dibuka.

  Filter yang datang dari FilterBar tidak boleh menghapus `limit` dan `cursor`. Karena itu
  filter disimpan terpisah dari parameter yang dikirim ke server, lalu digabung saat meminta.
  Tanpa pemisahan ini, satu perubahan filter akan mengembalikan ukuran halaman ke nilai awal dan
  membuat daftar melompat kembali ke halaman pertama tanpa penjelasan.
*/
export function usePagedQuery<T>(
  url: string,
  options: {
    limit?: number;
    params?: Record<string, string | number | undefined>;
    /**
     * Menerjemahkan nilai filter mentah dari FilterBar menjadi parameter yang dikenali server,
     * misalnya tanggal polos menjadi waktu lengkap. Bila tidak diisi, nilai diteruskan apa adanya.
     */
    mapParams?: (
      values: Record<string, string | number | undefined>,
    ) => Record<string, string | number | undefined>;
  } = {},
): DataQuery<T> & {
  page: number;
  limit: number;
  setLimit: (limit: number) => void;
  hasMore: boolean;
  nextPage: () => void;
  prevPage: () => void;
  resetPage: () => void;
} {
  const [limit, setLimitState] = useState(options.limit ?? PAGE_SIZES[0]);
  const [filters, setFilters] = useState<Record<string, string | number | undefined>>(
    options.params ?? {},
  );
  const [cursor, setCursor] = useState<string | null>(null);
  /* trail[n] adalah cursor yang dipakai untuk mencapai halaman n+1. Halaman 1 selalu null. */
  const [trail, setTrail] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(1);

  const mapParams = options.mapParams;
  const queryParams = mapParams ? mapParams(filters) : filters;

  const query = useApiQuery<T>(url, {
    ...queryParams,
    limit,
    ...(cursor ? { cursor } : {}),
  });

  /*
    Mengganti filter berarti kumpulan barisnya berubah, sehingga posisi cursor yang lama tidak lagi
    menunjuk ke tempat yang sama. Penyetelan cursor dan filter terjadi dalam satu handler yang sama
    supaya React menggabungkannya menjadi satu render: kalau terpisah, akan ada satu permintaan
    yang berangkat membawa filter baru bersama cursor lama.
  */
  const setParams = useCallback((next: Record<string, string | number | undefined>) => {
    setFilters(next);
    setCursor(null);
    setTrail([null]);
    setPage(1);
  }, []);

  const resetPage = useCallback(() => {
    setCursor(null);
    setTrail([null]);
    setPage(1);
  }, []);

  const setLimit = useCallback(
    (next: number) => {
      setLimitState(next);
      resetPage();
    },
    [resetPage],
  );

  const pagination = query.meta?.pagination;

  const nextPage = useCallback(() => {
    const nextCursor = pagination?.next_cursor;
    if (!nextCursor) return;
    setCursor(nextCursor);
    setTrail((history) => [...history, nextCursor]);
    setPage((value) => value + 1);
  }, [pagination?.next_cursor]);

  const prevPage = useCallback(() => {
    if (page <= 1) return;
    setCursor(trail[page - 2] ?? null);
    setPage((value) => value - 1);
  }, [page, trail]);

  return {
    ...query,
    setParams,
    page,
    limit,
    setLimit,
    hasMore: Boolean(pagination?.has_more),
    nextPage,
    prevPage,
    resetPage,
  };
}

/*
  Paginasi sisi klien untuk tabel yang datanya sudah dimuat seluruhnya.

  Sebagian endpoint mengirim seluruh barisnya sekaligus dan bukan ber-paginasi cursor: log
  provider dipatok 50 baris per arah di server, baris laporan mengikuti rentang tanggal yang
  dipilih, dan daftar izin adalah katalog tertutup. Untuk daftar seperti itu, memotong barisnya di
  klien lebih tepat daripada menambah paginasi cursor di server: datanya sudah ada di memori, dan
  yang dibutuhkan hanya cara menyusurinya tanpa menggulir ratusan baris.
*/
export function useClientPage<T>(
  rows: T[],
  initialLimit: number = PAGE_SIZES[0],
): {
  rows: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  setLimit: (limit: number) => void;
  nextPage: () => void;
  prevPage: () => void;
} {
  const [limit, setLimitState] = useState(initialLimit);
  const [page, setPage] = useState(1);

  const total = rows.length;
  const lastPage = Math.max(1, Math.ceil(total / limit));
  /* Halaman yang melewati ujung terjadi saat data menyusut, misalnya setelah filter diganti. */
  const safePage = Math.min(page, lastPage);

  const start = (safePage - 1) * limit;

  const setLimit = useCallback((next: number) => {
    setLimitState(next);
    setPage(1);
  }, []);

  const nextPage = useCallback(() => {
    setPage((value) => Math.min(value + 1, Math.ceil(total / limit) || 1));
  }, [total, limit]);

  const prevPage = useCallback(() => setPage((value) => Math.max(1, value - 1)), []);

  return {
    rows: rows.slice(start, start + limit),
    page: safePage,
    limit,
    total,
    hasMore: start + limit < total,
    setLimit,
    nextPage,
    prevPage,
  };
}

/*
  Menerjemahkan keadaan pengambilan data ke prop `status` milik DataTable.

  Dipisahkan di satu tempat karena setiap halaman daftar membutuhkannya, dan pemetaan yang
  ditulis ulang di tiap halaman adalah tempat yang mudah salah: satu halaman akan lupa
  memetakan `galat` dan menampilkan tabel kosong sebagai ganti pesan kegagalan.
*/
export function tableStatus(state: DataState<unknown>["status"]): "ready" | "loading" | "error" {
  if (state === "memuat") return "loading";
  if (state === "galat") return "error";
  return "ready";
}

/*
  Pemanggil mutasi dengan CSRF.

  Token CSRF dibaca dari cookie pada saat pemanggilan, bukan disimpan di localStorage. Kalau
  token itu disimpan, ia bertahan lebih lama daripada sesinya dan halaman yang dibuka esok hari
  akan mengirim token basi, yang hasilnya adalah 403 yang sulit dijelaskan.
*/
export async function mutate<T>(
  url: string,
  options: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  /*
    Token diambil lewat ensureCsrfToken(), yang meminta token baru kalau cookie-nya belum ada.
    Tanpa itu, mutasi pertama setelah cookie dibersihkan selalu gagal dengan 403 yang
    membingungkan, padahal pengguna hanya perlu memuat halaman sekali.
  */
  const token = await ensureCsrfToken();

  const response = await fetch(url, {
    method: options.method ?? "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...csrfHeader(token),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code: string; message: string } }
    | null;

  if (!response.ok || payload?.error) {
    const error = new Error(
      payload?.error?.message ?? "Server tidak mengirim keterangan galat.",
    ) as Error & { code?: string; status?: number };
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }

  return (payload?.data ?? null) as T;
}

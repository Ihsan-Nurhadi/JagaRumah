import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { databaseUrl, isProduction } from "./config";
import { buildConnectionConfig } from "./tls";

/*
  Satu pool untuk seluruh proses.

  Di development, Next.js memuat ulang modul setiap kali berkas berubah. Tanpa disimpan di
  globalThis, setiap muat ulang akan membuat pool baru dan koneksi lama menumpuk sampai database
  menolak koneksi baru.

  Di produksi, jumlah koneksi dijaga tetap kecil karena Supabase pooler sudah menyatukan koneksi
  di sisinya.
*/
const globalForPg = globalThis as unknown as { nayakaPool?: Pool };

export function pool(): Pool {
  if (!globalForPg.nayakaPool) {
    const target = buildConnectionConfig(databaseUrl());
    globalForPg.nayakaPool = new Pool({
      ...target,
      max: isProduction() ? 10 : 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Kueri yang menggantung menahan koneksi dan membuat halaman lain ikut lambat.
      statement_timeout: 15_000,
    });
  }
  return globalForPg.nayakaPool;
}

/*
  Sumber kueri, bukan koneksi tertentu.

  Tipe ini yang membuat satu fungsi baca bisa dipakai di dalam maupun di luar transaksi. Tanpa
  pemisahan ini, fungsi baca yang memanggil pool secara langsung akan mengambil koneksi lain,
  dan baris yang baru saja ditulis di dalam transaksi belum terlihat olehnya. Pada kasus login,
  akibatnya adalah sesi yang baru dibuat tidak ditemukan, padahal barisnya ada di koneksi
  transaksi yang belum di-commit.
*/
export type Queryable = Pick<PoolClient, "query">;

export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  executor: Queryable = pool(),
): Promise<T[]> {
  const result = await executor.query<T>(text, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  executor: Queryable = pool(),
): Promise<T | null> {
  const rows = await query<T>(text, params, executor);
  return rows[0] ?? null;
}

/*
  Satu transaksi untuk satu tindakan.

  Seluruh pekerjaan harus memakai `client` yang diberikan, bukan `pool()`. Kesalahan yang paling
  mudah terjadi adalah memanggil fungsi baca yang di dalamnya memakai pool: hasilnya kueri
  berjalan di koneksi lain, sehingga tidak melihat perubahan yang belum di-commit dan bisa
  menghabiskan koneksi pool saat transaksi menahan satu koneksi. Karena itu setiap fungsi baca
  di lapisan ini menerima `Queryable` sebagai parameter terakhir.
*/
export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

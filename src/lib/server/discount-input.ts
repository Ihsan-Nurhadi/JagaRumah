/*
  Alat bantu bersama untuk endpoint voucher dan flash sale.

  Diletakkan di `lib/server`, bukan di dalam berkas `route.ts`, karena Next.js hanya mengizinkan
  route handler mengekspor fungsi HTTP. Menaruh fungsi lain di sana membuat build gagal.

  Isinya hanya hal yang sama-sama dibutuhkan kedua modul: menerjemahkan waktu dari formulir, dan
  menyimpan daftar harga yang dipilih. Khususnya waktu, yang paling mudah salah karena formulir HTML
  mengirim waktu setempat tanpa keterangan zona.
*/
import { AppError } from "./errors";

/*
  Mengubah satu waktu dari formulir menjadi ISO.

  Teks tanpa keterangan zona dibaca sebagai waktu setempat Jakarta (UTC+7), karena itu yang dimaksud
  formulir HTML saat mengirim "2026-09-14T09:30". Bila dibaca sebagai UTC, promo yang dijadwalkan
  pukul 09.30 akan mulai pukul 16.30 dan operator tidak akan tahu sebabnya.

  Teks yang sudah membawa keterangan zona sendiri (mengakhiri Z atau +07:00) dipakai apa adanya,
  supaya pemanggil dari luar formulir tidak dipaksa memakai waktu Jakarta.
*/
export function toJakartaIso(value: string, field: string): string {
  const tanpaZona = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value);
  const calon = tanpaZona ? `${value.length === 16 ? `${value}:00` : value}+07:00` : value;
  const tanggal = new Date(calon);

  if (Number.isNaN(tanggal.getTime())) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: `Waktu pada ${field} tidak dapat dibaca.`,
      details: { fields: { [field]: "Format waktu tidak dikenali." } },
    });
  }

  return tanggal.toISOString();
}

/*
  Waktu mulai dan berakhir.

  Untuk voucher keduanya boleh kosong: `starts_at` kosong berarti berlaku sejak dibuat, `ends_at`
  kosong berarti tidak kedaluwarsa. Untuk flash sale keduanya wajib, dan kewajiban itu ditegakkan
  sebelum sampai ke database supaya pesannya menunjuk kolom yang harus diisi.
*/
export function resolveWindow(
  body: {
    starts_at?: string | null;
    ends_at?: string | null;
    starts_at_input?: string | null;
    ends_at_input?: string | null;
  },
  options: { requireEndsAt: boolean },
): { startsAt: string | null; endsAt: string | null } {
  const mulai = body.starts_at ?? body.starts_at_input ?? null;
  const selesai = body.ends_at ?? body.ends_at_input ?? null;

  if (mulai === null && body.starts_at !== null && options.requireEndsAt) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: "Data yang dikirim tidak valid. Periksa kolom yang ditandai lalu kirim ulang.",
      details: { fields: { starts_at_input: "Waktu mulai wajib diisi." } },
    });
  }

  return {
    startsAt: mulai === null ? null : toJakartaIso(mulai, "starts_at"),
    endsAt: selesai === null ? null : toJakartaIso(selesai, "ends_at"),
  };
}

/*
  Menyimpan daftar harga yang dipilih.

  Daftar lama dihapus lebih dulu, lalu yang baru dimasukkan. Pola ini yang membuat penyuntingan
  cakupan dapat menghapus harga tanpa perintah hapus tersendiri, dan mencegah sisa baris lama ikut
  berlaku setelah cakupan diganti.

  Perlu diperhatikan: trigger database menolak baris harga pada aturan bercakupan `all_prices`.
  Karena itu pemanggil wajib mengirim daftar kosong untuk cakupan itu, bukan daftar sisa dari
  cakupan sebelumnya.
*/
export type QueryExecutor = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

export async function replaceVoucherPrices(
  client: QueryExecutor,
  voucherId: string,
  priceIds: string[],
): Promise<void> {
  await client.query("DELETE FROM discount_voucher_prices WHERE voucher_id = $1", [voucherId]);
  if (priceIds.length === 0) return;

  await client.query(
    `INSERT INTO discount_voucher_prices (voucher_id, plan_price_id)
     SELECT $1, unnest($2::uuid[])`,
    [voucherId, priceIds],
  );
}

export async function replaceFlashSalePrices(
  client: QueryExecutor,
  flashSaleId: string,
  priceIds: string[],
): Promise<void> {
  await client.query("DELETE FROM plan_flash_sale_prices WHERE flash_sale_id = $1", [flashSaleId]);
  if (priceIds.length === 0) return;

  await client.query(
    `INSERT INTO plan_flash_sale_prices (flash_sale_id, plan_price_id)
     SELECT $1, unnest($2::uuid[])`,
    [flashSaleId, priceIds],
  );
}

/*
  Galat dari database yang sebenarnya pesan untuk operator.

  Dua trigger di modul ini melempar pesan yang sudah ditulis dalam bahasa Indonesia dan memuat nama
  flash sale yang bentrok. Pesan itu lebih berguna daripada "data tidak valid", jadi diteruskan apa
  adanya. Yang tidak diteruskan adalah pesan batasan bawaan PostgreSQL, karena selalu menyebut nama
  constraint dan itu tidak boleh sampai ke browser.
*/
export function operatorFacingError(error: unknown): AppError | null {
  const kode = (error as { code?: string } | null)?.code;
  const pesan = (error as { message?: string } | null)?.message;

  if (!pesan || !kode) return null;
  /* 23514 = check_violation, 23P01 = exclusion_violation. Keduanya dipakai trigger modul ini. */
  if (kode !== "23514" && kode !== "23P01") return null;
  if (pesan.includes("constraint") || pesan.includes("violates")) return null;

  return new AppError({ code: "VALIDATION_ERROR", message: pesan });
}

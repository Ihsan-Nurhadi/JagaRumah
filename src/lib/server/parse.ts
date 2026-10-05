import { ZodError, type ZodType } from "zod";

import { AppError, validationError } from "./errors";
import { zodDetails } from "./request";

/*
  Pembacaan body request.

  Dipisahkan dari berkas request karena berkas itu memakai `next/headers`, dan `next/headers`
  tidak bisa dimuat dari skrip CLI maupun dari pengujian tanpa konteks request Next.js. Dengan
  dipisah, fungsi ini bisa dipanggil dari mana saja yang punya objek Request biasa.
*/
export async function parseJson<S extends ZodType>(
  request: Request,
  schema: S,
): Promise<ReturnType<S["parse"]>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: "Body permintaan bukan JSON yang sah.",
    });
  }

  try {
    return schema.parse(raw) as ReturnType<S["parse"]>;
  } catch (error) {
    if (error instanceof ZodError) {
      throw validationError(zodDetails(error));
    }
    throw error;
  }
}

/*
  Pembacaan query string.

  Dipisahkan dari parseJson karena sumbernya berbeda, tetapi hasil galatnya sengaja dibuat sama
  bentuknya. Operator yang salah mengisi filter di alamat harus menerima keterangan per kolom,
  sama seperti ketika salah mengisi formulir.

  searchParams diubah menjadi objek biasa lebih dulu. Mengoper searchParams apa adanya tidak
  bekerja untuk parameter yang diulang, karena nilainya menjadi larik dan setiap skema akan
  menolaknya dengan pesan yang membingungkan.
*/
export function parseSearchParams<S extends ZodType>(
  searchParams: URLSearchParams,
  schema: S,
): ReturnType<S["parse"]> {
  const raw: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    /* Nilai kosong diperlakukan sebagai tidak diisi, sehingga nilai bawaan skema yang dipakai. */
    if (value !== "") raw[key] = value;
  }

  try {
    return schema.parse(raw) as ReturnType<S["parse"]>;
  } catch (error) {
    if (error instanceof ZodError) {
      throw validationError(zodDetails(error));
    }
    throw error;
  }
}

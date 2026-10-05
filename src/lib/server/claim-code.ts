/*
  Pembangkitan dan pencocokan kode claim perangkat.

  Kode claim dicetak pada label atau dus perangkat, lalu dipindai customer. Artinya kode ini
  dipegang orang yang belum tentu pemiliknya, dan label yang rusak atau difoto akan tetap
  beredar. Karena itu:

  1. Kode dibuat acak dengan panjang yang cukup supaya tidak bisa ditebak.
  2. Yang disimpan di database hanya hash-nya. Kode asli ditampilkan sekali lalu tidak dapat
     diambil kembali, sehingga bocornya isi tabel tidak langsung memberi kode yang bisa dipakai.
  3. Perbandingan dilakukan dengan waktu tetap, supaya lama pemeriksaan tidak membocorkan
     berapa digit awal yang sudah benar.

  Yang tidak dipakai: bcrypt. Kode claim bukan kata sandi yang dipilih manusia, dan verifikasi
  claim harus cepat karena terjadi di jalur permintaan pengguna. Untuk nilai acak berentropi
  tinggi, SHA-256 sudah memadai; bcrypt justru membuka peluang serangan yang memaksa server
  melakukan kerja mahal berulang kali.
*/
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { AppError } from "./errors";

/*
  Crockford base32: tanpa huruf I, L, O, dan U.

  Huruf-huruf itu dibuang karena pada label tercetak, I terbaca sebagai 1, O sebagai 0, dan U
  mudah tertukar dengan V saat difoto. Alfabet 32 huruf juga membuat pemetaan bit ke karakter
  tidak bias, tidak seperti base64 yang memaksa penanganan karakter khusus.
*/
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;
const GROUP_SIZE = 4;

/*
  16 karakter base32 berarti 80 bit. Untuk kode yang masa pakainya panjang dan melindungi satu
  perangkat, angka itu jauh di atas batas yang bisa ditebak dengan percobaan berulang.
*/
export function generateClaimToken(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    out += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return out;
}

/*
  Bentuk yang ditampilkan ke operator: dikelompokkan supaya mudah dibacakan lewat telepon atau
  dibandingkan dengan label tercetak. Pengelompokan hanya untuk tampilan; yang di-hash adalah
  bentuk tanpa pemisah, sehingga kode yang dipindai dengan atau tanpa tanda hubung sama-sama sah.
*/
export function formatClaimToken(token: string): string {
  const groups: string[] = [];
  for (let index = 0; index < token.length; index += GROUP_SIZE) {
    groups.push(token.slice(index, index + GROUP_SIZE));
  }
  return groups.join("-");
}

/*
  Membuang apa pun yang bukan karakter alfabet, lalu menyeragamkan huruf.

  Pemindaian QR dan pengetikan manual sama-sama rawan menghasilkan spasi, tanda hubung, atau
  huruf kecil. Menolak masukan seperti itu hanya akan membuat operator mengulang tanpa tahu
  apa yang salah, jadi bentuknya dinormalkan lebih dulu.
*/
export function normalizeClaimToken(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    // Karakter yang sering tertukar saat dibaca manusia dipetakan ke bentuk aslinya.
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(normalizeClaimToken(token)).digest("hex");
}

export function claimTokenMatches(candidate: string, storedHash: string): boolean {
  const candidateHash = Buffer.from(hashClaimToken(candidate), "utf8");
  const stored = Buffer.from(storedHash, "utf8");

  // Panjang berbeda membuat timingSafeEqual melempar, jadi diperiksa lebih dulu.
  if (candidateHash.length !== stored.length) return false;
  return timingSafeEqual(candidateHash, stored);
}

/*
  Payload QR.

  Memakai skema `nayaka://` supaya pemindai generik tidak memperlakukannya sebagai alamat web,
  dan supaya aplikasi customer bisa mengenali bahwa kode ini milik Nayaka sebelum mengirim
  apa pun ke server.
*/
export function claimQrPayload(token: string): string {
  return `nayaka://claim?t=${token}`;
}

/*
  Menyamarkan nilai yang dikirim customer sebelum dicatat.

  Nomor seri perangkat CCTV umumnya tercetak di bodi dan berurutan. Kalau nilai yang gagal
  disimpan apa adanya, tabel percobaan claim berubah menjadi daftar nomor seri yang bisa dibaca
  siapa pun yang punya akses database. Yang disimpan hanya empat karakter terakhir, yang cukup
  untuk mencocokkan laporan pengguna dengan catatan tanpa membuka nilai lengkapnya.
*/
export function maskSubmittedValue(kind: "qr" | "serial", value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return `(${kind}: kosong)`;

  const tail = trimmed.slice(-4);
  return `${kind}: ***${tail} (${trimmed.length} karakter)`;
}

export function requireClaimTokenShape(token: string): string {
  const normalized = normalizeClaimToken(token);
  if (normalized.length !== CODE_LENGTH) {
    throw new AppError({
      code: "CLAIM_TOKEN_INVALID",
      message:
        `Kode claim harus ${CODE_LENGTH} karakter. Yang terbaca ${normalized.length} karakter. ` +
        `Periksa label perangkat atau pindai ulang kodenya.`,
    });
  }
  return normalized;
}

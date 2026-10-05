import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { csrfSecret } from "./config";

/*
  Token CSRF.

  Pola yang dipakai adalah double-submit dengan tanda tangan. Nilai acak dikirim ke browser
  lewat cookie yang bisa dibaca JavaScript, lalu dikirim balik oleh klien pada header
  `X-CSRF-Token`. Server memastikan keduanya sama dan tanda tangannya sah.

  Tanda tangan HMAC dipakai supaya penyerang tidak bisa membuat pasangan cookie dan header
  sendiri. Tanpa tanda tangan, siapa pun yang bisa menulis cookie pada domain ini (misalnya
  lewat subdomain yang diretas) bisa membuat pasangan yang cocok dan melewati pemeriksaan.

  Token tidak diikat ke sesi, karena login pun butuh token ini dan pada saat itu belum ada
  sesi. Untuk login, risikonya bukan pembajakan sesi melainkan login-CSRF, dan itu sudah
  tertutup selama penyerang tidak bisa membaca token dari cookie korban.
*/

const NONCE_BYTES = 32;

function sign(nonce: string): string {
  return createHmac("sha256", csrfSecret()).update(nonce).digest("base64url");
}

export function issueCsrfToken(): string {
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  return `${nonce}.${sign(nonce)}`;
}

export function isCsrfTokenValid(cookieValue: string | undefined, headerValue: string | null): boolean {
  if (!cookieValue || !headerValue) return false;

  // Perbandingan header dan cookie memakai perbandingan waktu tetap, supaya panjang dan posisi
  // karakter yang cocok tidak bocor lewat waktu eksekusi.
  if (!safeEqual(cookieValue, headerValue)) return false;

  const separator = cookieValue.lastIndexOf(".");
  if (separator <= 0) return false;

  const nonce = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  if (!nonce || !signature) return false;

  return safeEqual(sign(nonce), signature);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

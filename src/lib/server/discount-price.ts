/*
  Perhitungan potongan harga.

  Satu tempat yang memutuskan berapa yang dipotong, dipakai bersama oleh modul diskon, tagihan, dan
  nanti endpoint checkout. Kalau hitungan ini ditulis ulang di tempat lain, dua layar akan
  menampilkan harga akhir yang berbeda untuk promo yang sama, dan yang paling parah: yang dihitung
  klien tidak sama dengan yang ditagih server.

  Aturan yang berlaku di sini:

  1. Potongan tidak menumpuk. Kalau voucher dan flash sale sama-sama berlaku untuk harga yang sama,
     pelanggan mendapat yang paling menguntungkan, bukan jumlah keduanya. Aturan ini juga tertulis
     di COMMENT tabel discount_vouchers, jadi kode dan database menyebut hal yang sama.

  2. Potongan tidak pernah melewati harga. Voucher Rp50.000 untuk paket Rp25.000 memotong Rp25.000.
     Sisa yang tidak terpakai hangus, bukan menjadi saldo.

  3. Uang dihitung sebagai bilangan bulat rupiah.

     Kolom database bertipe numeric dan kolom uang di API_Contract.md juga bilangan bulat rupiah,
     karena itu perhitungan di sini tidak boleh lewat bilangan pecahan biner. Persen dari bilangan
     bulat memang bisa menghasilkan pecahan (17% dari 99.001 adalah 16.830,17), jadi hasilnya
     dibulatkan di akhir, bukan dikerjakan dengan angka pecahan sejak awal.

     Pembulatan potongan memakai Math.ceil. Arah pembulatan ini dipilih sadar: Rp0,17 yang
     dibulatkan ke atas berarti pelanggan mendapat potongan Rp0,17 lebih besar, sedangkan bila
     dibulatkan ke bawah selisihnya menambah kewajiban pelanggan. Pada potongan, selisih satu
     rupiah lebih baik jatuh ke sisi pelanggan.
*/

export type DiscountType = "percent" | "fixed";

export type DiscountScope = "all_prices" | "selected_prices";

export type DiscountValue = {
  discount_type: DiscountType;
  percent_value: number | null;
  fixed_amount: number | null;
};

/*
  Calon aturan potongan yang siap dihitung: nilainya, dari mana asalnya, dan nama yang akan
  ditampilkan ke operator. Bentuk ini sengaja tidak memuat kolom database, supaya berkas ini tetap
  dapat dipakai tanpa menyentuh database sama sekali.
*/
export type DiscountCandidate = DiscountValue & {
  source: "voucher" | "flash_sale";
  id: string;
  name: string;
  /* Hanya voucher yang punya kode. Flash sale berlaku tanpa kode. */
  code: string | null;
};

export type AppliedDiscount = {
  source: "voucher" | "flash_sale";
  id: string;
  name: string;
  code: string | null;
  discount_type: DiscountType;
  percent_value: number | null;
  fixed_amount: number | null;
  /* Nilai potongan yang benar-benar dikurangkan, sudah dibatasi harga dan dibulatkan. */
  discount_amount: number;
  amount_before: number;
  amount_after: number;
};

/* Batas atas nominal, mengikuti lebar kolom numeric(14, 2) di database. */
export const MAX_AMOUNT = 999_999_999_999.99;

/*
  Membaca nominal dari database.

  Kolom numeric dikirim driver sebagai teks supaya tidak kehilangan presisi. Teks itu harus
  ditafsirkan dengan bilangan bulat, bukan parseFloat, karena parseFloat pada "999999999999.99"
  kehilangan dua rupiah terakhir dan itu cukup untuk membuat perhitungan diskon tidak cocok dengan
  nominal yang tersimpan.
*/
export function parseAmount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;

  const text = typeof value === "number" ? String(value) : value.trim();
  if (text === "") return 0;

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new Error(`Nominal "${text}" tidak dapat dibaca sebagai rupiah.`);
  }

  const rupiah = Number(match[1]);
  const sen = match[2] ? Number(match[2].padEnd(2, "0")) : 0;

  return rupiah + sen / 100;
}

/* Bentuk uang untuk kolom numeric: dua angka di belakang koma, tanpa pemisah ribuan. */
export function toAmountString(amount: number): string {
  return (Math.round(amount * 100) / 100).toFixed(2);
}

/*
  Besar potongan dari satu aturan, sebelum dibatasi harga.

  Mengembalikan 0 bila aturannya tidak lengkap. Baris seperti itu tidak seharusnya ada karena
  batasan di database menolaknya, tetapi mengembalikan 0 lebih baik daripada melemparkan galat saat
  halaman konsol dibuka: satu baris rusak tidak boleh membuat seluruh halaman gagal tampil.
*/
export function rawDiscountAmount(value: DiscountValue, amountBefore: number): number {
  if (amountBefore <= 0) return 0;

  if (value.discount_type === "percent") {
    const percent = value.percent_value;
    if (percent === null || percent <= 0) return 0;
    const bounded = Math.min(percent, 100);
    return Math.ceil((amountBefore * bounded) / 100);
  }

  const fixed = value.fixed_amount;
  if (fixed === null || fixed <= 0) return 0;
  return fixed;
}

/*
  Potongan akhir untuk satu aturan pada satu harga: tidak pernah melewati harganya, dan tidak
  pernah negatif.
*/
export function discountAmountFor(value: DiscountValue, amountBefore: number): number {
  return Math.max(0, Math.min(rawDiscountAmount(value, amountBefore), amountBefore));
}

/*
  Memilih aturan yang dipakai dari beberapa kandidat.

  Yang menang adalah yang menghasilkan potongan terbesar. Bila dua aturan memberi potongan yang
  sama besarnya, yang dipilih adalah voucher, karena pelanggan yang mengetik kode berhak atas hasil
  dari kodenya dan itu yang paling mudah dijelaskan saat ditanya. Kandidat `voucher` karena itu
  diperiksa lebih dulu dan hanya digantikan bila potongannya benar-benar lebih kecil.

  Mengembalikan null bila tidak ada kandidat, atau bila semua potongannya nol. Aturan yang tidak
  memotong apa pun tidak boleh tercatat sebagai pemakaian voucher, karena satu kuota akan terpakai
  tanpa memberi keuntungan apa pun.
*/
export function pickBestDiscount(
  candidates: DiscountCandidate[],
  amountBefore: number,
): { rule: DiscountCandidate; amount: number } | null {
  let best: { rule: DiscountCandidate; amount: number } | null = null;

  for (const rule of candidates) {
    const amount = discountAmountFor(rule, amountBefore);

    if (amount <= 0) continue;
    if (!best || amount > best.amount) {
      best = { rule, amount };
    }
  }

  return best;
}

/*
  Hasil akhir potongan untuk satu harga.

  Mengembalikan `discount` beserta jumlah sebelum dan sesudah, dan null bila tidak ada yang berlaku.
  Pemanggil tidak perlu mengulang pemeriksaan "apakah potongannya nol", karena pemeriksaan itu
  sudah dilakukan di sini.
*/
export function applyDiscount(
  candidates: DiscountCandidate[],
  amountBefore: number,
): AppliedDiscount | null {
  const picked = pickBestDiscount(candidates, amountBefore);
  if (!picked) return null;

  const { rule, amount } = picked;
  return {
    source: rule.source,
    id: rule.id,
    name: rule.name,
    code: rule.code,
    discount_type: rule.discount_type,
    percent_value: rule.percent_value,
    fixed_amount: rule.fixed_amount,
    discount_amount: amount,
    amount_before: amountBefore,
    amount_after: Math.max(0, amountBefore - amount),
  };
}

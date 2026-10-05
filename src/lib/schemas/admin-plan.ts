import { z } from "zod";

/*
  Skema paket dan harga.

  Dipakai bersama oleh route handler dan formulir di konsol, supaya aturan yang terlihat di layar
  sama dengan aturan yang ditegakkan server.

  Yang sengaja tidak ada di sini:

  - `currency`. Kolom `plan_prices.currency` ada, tetapi seluruh konsol memformat uang sebagai
    rupiah. Menerima mata uang lain dari klien akan menghasilkan layar yang menampilkan nominal
    dengan tanda mata uang yang salah, dan itu lebih buruk daripada tidak menyediakan pilihannya.
  - `plan_id` dan `id`. Keduanya datang dari alamat atau dibangkitkan database.

  Dua nilai di modul ini adalah keputusan pemilik produk yang belum diambil: batas perangkat
  paket Gratis dan nominal paket berbayar. Skema ini karena itu menerima keduanya apa adanya dan
  tidak mengisi nilai bawaan yang masuk akal, karena nilai bawaan yang dikarang akan tersimpan
  sebagai keputusan yang tidak pernah diambil siapa pun.
*/

const planCodePattern = /^[a-z0-9][a-z0-9._-]*$/;

/*
  Kode paket dipakai klien untuk mengenali paket, jadi bentuknya dibatasi dan hurufnya
  diturunkan ke huruf kecil alih-alih ditolak. Operator yang mengetik "Pro" bermaksud sama
  dengan "pro", dan menolaknya hanya menambah pekerjaan tanpa menambah keamanan.
*/
const planCode = z
  .string()
  .trim()
  .min(2, "Kode paket minimal 2 karakter.")
  .max(32, "Kode paket maksimal 32 karakter.")
  .transform((value) => value.toLowerCase())
  .refine((value) => planCodePattern.test(value), {
    message:
      "Kode paket hanya boleh memuat huruf kecil, angka, titik, garis bawah, dan tanda hubung, " +
      "serta harus diawali huruf atau angka.",
  });

/*
  Kolom teks opsional: string kosong dari formulir diterjemahkan menjadi null, bukan disimpan
  sebagai string kosong. Tanpa itu, kolom yang dikosongkan operator tersimpan sebagai "" dan
  pemeriksaan "sudah diisi atau belum" di tempat lain jadi salah.
*/
function optionalText(label: string, max: number) {
  return z
    .string()
    .trim()
    .max(max, `${label} maksimal ${max} karakter.`)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();
}

/*
  Batas perangkat.

  Nilainya diterima sebagai teks maupun angka, karena formulir mengirim apa yang diketik
  operator. Kosong berarti tanpa batas, dan itu berbeda arti dari 0 yang berarti tidak boleh ada
  perangkat sama sekali. Dua nilai itu tidak boleh disamakan, karena menyamakannya membuat paket
  tanpa batas berubah menjadi paket yang menolak semua perangkat.
*/
const deviceLimit = z
  .union([z.string(), z.number(), z.null()], {
    message: "Batas perangkat harus berupa angka.",
  })
  .transform((value) => (typeof value === "string" ? value.trim() : value))
  .refine((value) => value === null || value === "" || /^\d+$/.test(String(value)), {
    message: "Batas perangkat harus berupa angka bulat, atau dikosongkan untuk tanpa batas.",
  })
  .refine((value) => value === null || value === "" || Number(value) <= 10_000, {
    message: "Batas perangkat maksimal 10000.",
  });

/*
  Urutan paket menentukan mana yang dianggap naik paket, jadi kolomnya wajib dan berbentuk
  angka bulat. Kolom kosong tidak diterjemahkan menjadi 0, karena 0 adalah urutan yang sah dan
  berarti paket paling rendah.
*/
const sortOrder = z
  .union([z.string(), z.number()], { message: "Urutan paket harus berupa angka." })
  .transform((value) => (typeof value === "string" ? value.trim() : value))
  .refine((value) => value !== "", { message: "Urutan paket wajib diisi." })
  .refine((value) => /^\d+$/.test(String(value)), {
    message: "Urutan paket harus berupa angka bulat tanpa tanda pemisah, contoh 1.",
  })
  .refine((value) => Number(value) <= 10_000, { message: "Urutan paket maksimal 10000." });

/*
  Nominal harga.

  Bentuknya diperiksa dengan pola, bukan dengan Number(). Alasannya ada satu kasus yang berbahaya:
  "51.000" adalah bilangan yang sah bagi JavaScript, yaitu lima puluh satu, padahal yang dimaksud
  penulisnya lima puluh satu ribu. Menagih pelanggan seribu kali lebih kecil tidak menimbulkan
  keluhan, tetapi tetap salah, dan tidak ada cara mengetahui maksud itu dari nilainya. Karena itu
  pemisah ribuan ditolak dan hanya bentuk polos yang diterima. Koma desimal tetap diterima dan
  diubah menjadi titik, karena itu yang biasa diketik di sini.
*/
export const priceAmount = z
  .union([z.string(), z.number()], { message: "Nominal harus berupa angka." })
  .transform((value) => (typeof value === "string" ? value.trim().replace(",", ".") : value))
  .refine((value) => /^\d+(\.\d{1,2})?$/.test(String(value)), {
    message:
      "Nominal harus berupa angka tanpa pemisah ribuan, dengan paling banyak dua angka di " +
      "belakang koma. Contoh: 99000 atau 99000.50.",
  })
  .refine((value) => Number(value) <= 999_999_999_999.99, {
    message: "Nominal melebihi batas yang dapat disimpan.",
  });

/*
  Kolom angka di atas sengaja tidak mengubah tipenya menjadi angka.

  Formulir di konsol memakai skema yang sama dengan server, dan react-hook-form menuntut tipe
  masukan dan tipe keluaran skema sama persis. Skema yang mengubah teks menjadi angka membuat
  keduanya berbeda, dan formulirnya berhenti dikompilasi. Karena itu pemeriksaan bentuknya
  dikerjakan skema, sedangkan perubahannya menjadi nilai siap simpan dikerjakan fungsi di bawah
  ini, supaya aturannya tetap hanya ada di satu berkas.
*/
export function normalizeDeviceLimit(value: string | number | null): number | null {
  if (value === null || value === "") return null;
  return Number(value);
}

export function normalizeSortOrder(value: string | number): number {
  return Number(value);
}

/*
  Nominal disimpan sebagai teks desimal dua angka di belakang koma. pg menerima string apa adanya
  untuk kolom numeric, sehingga tidak ada pembulatan bilangan pecahan biner yang ikut tersimpan.
*/
export function normalizeAmount(value: string | number): string {
  return Number(value).toFixed(2);
}

export const BILLING_INTERVALS = ["monthly", "yearly"] as const;

export const createPlanSchema = z.object({
  code: planCode,
  name: z
    .string()
    .trim()
    .min(2, "Nama paket minimal 2 karakter.")
    .max(60, "Nama paket maksimal 60 karakter."),
  description: optionalText("Keterangan", 300),
  device_limit: deviceLimit,
  is_free: z.boolean({ message: "Penanda paket gratis harus berupa ya atau tidak." }),
  is_active: z.boolean({ message: "Status paket harus berupa ya atau tidak." }),
  sort_order: sortOrder,
});

export type CreatePlanInput = z.infer<typeof createPlanSchema>;

/*
  Kode paket tidak dapat diubah setelah dibuat, jadi tidak ada di skema ini. Kode itulah yang
  dipakai klien untuk mengenali paket, dan mengubahnya diam-diam akan membuat klien yang belum
  diperbarui memilih paket yang salah.
*/
export const updatePlanSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Nama paket minimal 2 karakter.")
      .max(60, "Nama paket maksimal 60 karakter.")
      .optional(),
    description: optionalText("Keterangan", 300),
    device_limit: deviceLimit.optional(),
    is_free: z.boolean({ message: "Penanda paket gratis harus berupa ya atau tidak." }).optional(),
    is_active: z.boolean({ message: "Status paket harus berupa ya atau tidak." }).optional(),
    sort_order: sortOrder.optional(),
  })
  /*
    Body kosong ditolak. Tanpa pemeriksaan ini, PATCH tanpa isi mengembalikan sukses tanpa
    mengubah apa pun, dan operator mengira perubahannya tersimpan.
  */
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Tidak ada perubahan yang dikirim. Isi minimal satu kolom.",
  });


export const createPriceSchema = z.object({
  plan_id: z.string().uuid("Paket tidak dikenali."),
  billing_interval: z.enum(BILLING_INTERVALS, {
    message: 'Interval tagihan harus "monthly" atau "yearly".',
  }),
  amount: priceAmount,
});


/*
  Harga yang sudah dipakai langganan tidak boleh diubah nominalnya, dan pemeriksaan itu dilakukan
  server karena hanya server yang tahu apakah harganya sudah dipakai. Skema ini tetap menerima
  `amount` supaya formulir dapat mengirimnya untuk harga yang belum pernah dipakai, yaitu saat
  nominalnya salah ketik dan belum ada langganan yang memakainya.
*/
export const updatePriceSchema = z
  .object({
    amount: priceAmount.optional(),
    is_active: z.boolean({ message: "Status harga harus berupa ya atau tidak." }).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Tidak ada perubahan yang dikirim. Isi minimal satu kolom.",
  });


import { z } from "zod";

/*
  Skema registrasi perangkat, mengikuti API_Contract.md bagian admin device.

  Dipakai bersama oleh route handler dan form di klien, supaya aturan yang terlihat di layar
  sama persis dengan aturan yang ditegakkan server.

  Yang sengaja tidak ada di sini: `device_uid` dan `id`. Keduanya dibangkitkan server, dan
  menerimanya dari klien berarti klien bisa menentukan nomor yang tercetak pada label.
*/

const macPattern = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const imeiPattern = /^\d{15}$/;

/*
  Nomor seri tidak dibatasi polanya karena setiap pemasok memakai format sendiri. Yang dibatasi
  hanya panjang dan karakternya, supaya nilai yang tidak bisa dicetak pada label tidak lolos.
*/
const serialNumber = z
  .string()
  .trim()
  .min(3, "Nomor seri minimal 3 karakter.")
  .max(64, "Nomor seri maksimal 64 karakter.")
  .regex(
    /^[A-Za-z0-9._/-]+$/,
    "Nomor seri hanya boleh memuat huruf, angka, titik, garis miring, garis bawah, dan tanda hubung.",
  );

/*
  Kolom teks opsional memakai pola yang sama: string kosong dari form diterjemahkan menjadi
  null, bukan disimpan sebagai string kosong. Tanpa itu, kolom yang dikosongkan operator akan
  tersimpan sebagai "" dan pemeriksaan "sudah diisi atau belum" di tempat lain jadi salah.
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

export const createDeviceSchema = z.object({
  serial_number: serialNumber,
  /*
    Nama perangkat ikut saat pendaftaran, bukan hanya saat penyuntingan. Operator yang sedang
    memegang label biasanya juga tahu perangkat ini akan dipasang di mana, dan kolom nama yang
    harus diisi belakangan lewat halaman lain cenderung dibiarkan kosong.
  */
  name: optionalText("Nama perangkat", 80),
  model: optionalText("Model", 64),
  hardware_revision: optionalText("Revisi perangkat keras", 32),
  batch_number: optionalText("Nomor batch", 64),
  mac_address: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value.toUpperCase()))
    .nullable()
    .optional()
    .refine((value) => value === null || value === undefined || macPattern.test(value), {
      message: "Format MAC harus AA:BB:CC:DD:EE:FF.",
    }),
  imei: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional()
    .refine((value) => value === null || value === undefined || imeiPattern.test(value), {
      message: "IMEI harus 15 angka.",
    }),
  /*
    Masa garansi dikirim sebagai tanggal, bukan sebagai penanda "mulai hari ini". Operator yang
    mendaftarkan perangkat lama perlu mencantumkan tanggal pembelian yang sebenarnya, dan
    perangkat yang sudah lewat masa garansinya tetap perlu bisa didaftarkan.
  */
  warranty_start_at: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional()
    .refine((value) => value === null || value === undefined || !Number.isNaN(Date.parse(value)), {
      message: "Tanggal mulai garansi tidak dikenali.",
    }),
  stream_url: z
    .string()
    .trim()
    .max(1000, "URL stream maksimal 1000 karakter.")
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional(),
});

export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;

export const updateDeviceSchema = z
  .object({
    name: z
      .string()
      .trim()
      .max(80, "Nama perangkat maksimal 80 karakter.")
      .transform((value) => (value === "" ? null : value))
      .nullable()
      .optional(),
    model: optionalText("Model", 64),
    hardware_revision: optionalText("Revisi perangkat keras", 32),
    batch_number: optionalText("Nomor batch", 64),
    mac_address: z
      .string()
      .trim()
      .transform((value) => (value === "" ? null : value.toUpperCase()))
      .nullable()
      .optional()
      .refine((value) => value === null || value === undefined || macPattern.test(value), {
        message: "Format MAC harus AA:BB:CC:DD:EE:FF.",
      }),
    imei: z
      .string()
      .trim()
      .transform((value) => (value === "" ? null : value))
      .nullable()
      .optional()
      .refine((value) => value === null || value === undefined || imeiPattern.test(value), {
        message: "IMEI harus 15 angka.",
      }),
    warranty_start_at: z
      .string()
      .trim()
      .transform((value) => (value === "" ? null : value))
      .nullable()
      .optional()
      .refine((value) => value === null || value === undefined || !Number.isNaN(Date.parse(value)), {
        message: "Tanggal mulai garansi tidak dikenali.",
      }),
    stream_url: z
      .string()
      .trim()
      .max(1000, "URL stream maksimal 1000 karakter.")
      .transform((value) => (value === "" ? null : value))
      .nullable()
      .optional(),
  })
  /*
    Body kosong ditolak. Tanpa pemeriksaan ini, PATCH tanpa isi akan mengembalikan sukses
    tanpa mengubah apa pun, dan operator mengira perubahannya tersimpan.
  */
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Tidak ada perubahan yang dikirim. Isi minimal satu kolom.",
  });

export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;

/*
  Alasan wajib untuk assign dan unassign.

  Keduanya mengubah kepemilikan perangkat, dan keduanya ditulis ke audit_logs. Tanpa alasan,
  catatan audit hanya berisi "perangkat dipindahkan" tanpa keterangan mengapa, sehingga tidak
  bisa dipakai menjawab keluhan pelanggan enam bulan kemudian.
*/
export const assignDeviceSchema = z.object({
  customer_id: z.string().uuid("Customer tidak dikenali."),
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

export type AssignDeviceInput = z.infer<typeof assignDeviceSchema>;

export const unassignDeviceSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

export type UnassignDeviceInput = z.infer<typeof unassignDeviceSchema>;

/*
  Nilai awal form. Didefinisikan sekali di sini supaya form kosong selalu berbentuk sama dengan
  tipe yang diharapkan, bukan objek yang dirakit ulang di komponen.
*/
export const createDeviceDefaults: CreateDeviceInput = {
  serial_number: "",
  name: null,
  model: null,
  hardware_revision: null,
  batch_number: null,
  mac_address: null,
  imei: null,
  warranty_start_at: null,
  stream_url: null,
};

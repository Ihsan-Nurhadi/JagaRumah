/*
  Lapisan data untuk modul diskon.

  Modul ini menyimpan dua cara memotong harga langganan:

  1. Voucher, yaitu kode yang diketik pelanggan saat checkout. Kode punya masa berlaku, kuota, dan
     batas pemakaian per pelanggan.
  2. Flash sale paket, yaitu potongan yang berlaku sendiri selama jendela waktunya terbuka.
     Cakupannya boleh seluruh harga satu paket, atau hanya harga tertentu dari paket itu.

  Empat hal yang mudah salah kalau ditulis langsung di route handler:

  1. Potongan tidak menumpuk. Kalau voucher dan flash sale sama-sama berlaku untuk satu harga, yang
     dipakai adalah yang paling menguntungkan pelanggan. Karena itu pencarian promo aktif selalu
     mengembalikan dua-duanya, dan pemilihan dilakukan sekali di `discount-price.ts`.

  2. Masa berlaku bersifat setengah terbuka: `starts_at <= sekarang < ends_at`. `ends_at` NULL
     berarti tidak kedaluwarsa, dan `starts_at` NULL berarti berlaku sejak dibuat.

  3. Kuota dibaca dari jumlah baris `discount_voucher_redemptions`, bukan dari penghitung di tabel
     vouchernya. Tabel voucher tidak punya kolom penghitung sama sekali, dan itu disengaja: satu
     angka yang disimpan terpisah dari catatan pemakaiannya adalah angka yang bisa melenceng, dan
     kuota yang melenceng berarti voucher terjual lebih banyak daripada yang disediakan.

  4. Flash sale terikat pada satu paket (`plan_id NOT NULL`). "Semua paket kena flash sale" berarti
     beberapa baris, satu per paket, dibuat dalam satu transaksi. Membuatnya begitu bukan sekadar
     mengikuti skema: aturan bentrok jendela waktu di database bekerja per paket, jadi satu baris
     yang mengaku berlaku untuk semua paket justru tidak dapat diperiksa bentroknya.

  Ringkasan di halaman daftar dihitung dari seluruh tabel, bukan dari halaman yang sedang terbuka,
  supaya angkanya tidak berubah setiap kali pengguna menekan "berikutnya".
*/
import { query, queryOne, type Queryable } from "./db";
import { AppError } from "./errors";
import {
  applyDiscount,
  parseAmount,
  type DiscountCandidate,
} from "./discount-price";

/* Nilai kolom numeric dikirim driver sebagai teks supaya presisinya tidak hilang. */
export type AmountText = string;

export type DiscountType = "percent" | "fixed";
export type DiscountScope = "all_prices" | "selected_prices";

export type VoucherRow = {
  id: string;
  created_at: Date;
  updated_at: Date;
  code: string;
  name: string;
  description: string | null;
  discount_type: DiscountType;
  percent_value: number | null;
  fixed_amount: AmountText | null;
  currency: string;
  scope: DiscountScope;
  starts_at: Date | null;
  ends_at: Date | null;
  max_redemptions: number | null;
  max_redemptions_per_customer: number;
  min_amount: AmountText | null;
  applies_to: string;
  is_active: boolean;
};

export type VoucherListRow = VoucherRow & {
  cursor_value: string;
  /* Jumlah harga yang dipilih, hanya berarti saat cakupannya `selected_prices`. */
  price_count: number;
  /* Pemakaian yang tercatat, dipakai untuk menunjukkan kuota yang sudah terpakai. */
  redemption_count: number;
};

export type FlashSaleRow = {
  id: string;
  created_at: Date;
  updated_at: Date;
  plan_id: string;
  plan_name: string;
  code: string;
  name: string;
  description: string | null;
  discount_type: DiscountType;
  percent_value: number | null;
  fixed_amount: AmountText | null;
  currency: string;
  scope: DiscountScope;
  starts_at: Date;
  ends_at: Date;
  is_active: boolean;
};

export type FlashSaleListRow = FlashSaleRow & {
  cursor_value: string;
  price_count: number;
};

/* Harga paket ringkas, dipakai pemilih harga dan layar detail. */
export type PriceOptionRow = {
  id: string;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  plan_is_active: boolean;
  billing_interval: string;
  amount: AmountText;
  currency: string;
  price_is_active: boolean;
};

/* Harga yang ikut dihitung: id, paketnya, dan nominalnya. */
export type PriceRef = {
  id: string;
  plan_id: string;
  amount: AmountText;
  currency: string;
};

/*
  Satu harga beserta potongan yang berlaku untuknya.

  Bentuknya sudah dipilih dan dihitung: tinggal dibaca klien. `discount` null berarti tidak ada
  promo yang berlaku, yang berbeda artinya dari "ada promo tapi potongannya nol".
*/
export type MatchedPriceRule = {
  price_id: string;
  plan_id: string;
  amount: AmountText;
  currency: string;
  amount_after: number;
  discount_amount: number;
  discount: {
    source: "voucher" | "flash_sale";
    name: string;
    code: string | null;
    discount_type: DiscountType;
    percent_value: number | null;
    fixed_amount: number | null;
  } | null;
  /*
    Seluruh promo yang berlaku untuk harga ini, termasuk yang kalah. Dikirim supaya layar dapat
    mengatakan "kode Anda sah, tetapi flash sale sedang memberi potongan lebih besar" alih-alih
    diam-diam mengabaikan kode yang pelanggan sudah repot-repot mengetik.
  */
  vouchers: { id: string; code: string; name: string }[];
  flash_sales: { id: string; name: string }[];
};

export type VoucherFilter = {
  /** Pencarian pada kode atau nama voucher. */
  q?: string;
  isActive?: boolean;
  /** Keadaan yang dihitung dari waktu: berjalan, menunggu waktu, kedaluwarsa, atau dimatikan. */
  state?: DiscountState;
  scope?: DiscountScope;
};

export type FlashSaleFilter = {
  q?: string;
  isActive?: boolean;
  state?: DiscountState;
  scope?: DiscountScope;
  planId?: string;
};

/*
  Keadaan voucher dihitung dari waktu, bukan disimpan sebagai kolom.

  Menyimpannya sebagai kolom berarti harus ada tugas berkala yang memperbaruinya, dan di antara dua
  jadwal, keadaan yang tersimpan akan berbohong. Menghitungnya saat dibaca selalu benar.

  "Menunggu waktu" berbeda dari "kedaluwarsa": yang satu belum mulai, yang satu tidak akan berlaku
  lagi. Operator perlu membedakan keduanya, karena yang pertama masih bisa dibatalkan sebelum
  jalan.
*/
export type DiscountState = "running" | "scheduled" | "ended" | "inactive";

export const DISCOUNT_STATE_LABELS: Record<DiscountState, string> = {
  running: "Berjalan",
  scheduled: "Menunggu waktu",
  ended: "Kedaluwarsa",
  inactive: "Dimatikan",
};

/*
  Keadaan potongan.

  Rumusnya satu tempat untuk voucher dan flash sale, karena keduanya hanya berbeda pada kolom mana
  yang boleh kosong. Perbedaan itu ditangani dengan menerima null pada `starts_at`, bukan dengan
  menulis dua rumus yang bisa berbeda diam-diam.
*/
export function discountState(row: {
  is_active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
}): DiscountState {
  if (!row.is_active) return "inactive";

  const now = Date.now();
  if (row.starts_at !== null && row.starts_at.getTime() > now) return "scheduled";
  if (row.ends_at !== null && row.ends_at.getTime() <= now) return "ended";
  return "running";
}

/* Pencarian memakai ILIKE, jadi karakter pola yang diketik operator harus di-escape lebih dulu. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/*
  Syarat filter voucher.

  Keadaan disaring di database, bukan di TypeScript. Kalau disaring setelah halaman diambil, halaman
  akan berisi lebih sedikit baris daripada yang diminta sambil tetap mengirim cursor lanjutan, dan
  baris di antara dua halaman itu tidak pernah terlihat oleh siapa pun.
*/
export function voucherFilterConditions(filter: VoucherFilter, params: unknown[]): string {
  return stateConditions(filter, params, { alias: "v" });
}

export function flashSaleFilterConditions(filter: FlashSaleFilter, params: unknown[]): string {
  const conditions: string[] = [];

  if (filter.planId) {
    conditions.push(`AND f.plan_id = $${params.push(filter.planId)}::uuid`);
  }

  return [conditions.join("\n         "), stateConditions(filter, params, { alias: "f" })]
    .filter((bagian) => bagian !== "")
    .join("\n         ");
}

function stateConditions(
  filter: VoucherFilter,
  params: unknown[],
  options: { alias: string },
): string {
  const a = options.alias;
  const conditions: string[] = [];

  if (filter.isActive !== undefined) {
    conditions.push(`AND ${a}.is_active = $${params.push(filter.isActive)}`);
  }
  if (filter.scope) {
    conditions.push(`AND ${a}.scope = $${params.push(filter.scope)}`);
  }

  switch (filter.state) {
    case "inactive":
      conditions.push(`AND NOT ${a}.is_active`);
      break;
    case "scheduled":
      conditions.push(`AND ${a}.is_active AND ${a}.starts_at > now()`);
      break;
    case "ended":
      conditions.push(`AND ${a}.is_active AND ${a}.ends_at IS NOT NULL AND ${a}.ends_at <= now()`);
      break;
    case "running":
      conditions.push(`AND ${a}.is_active
           AND (${a}.starts_at IS NULL OR ${a}.starts_at <= now())
           AND (${a}.ends_at IS NULL OR ${a}.ends_at > now())`);
      break;
    case undefined:
      break;
  }

  if (filter.q) {
    const pattern = `%${escapeLike(filter.q)}%`;
    const index = params.push(pattern);
    conditions.push(
      options.alias === "v"
        ? `AND (${a}.code ILIKE $${index} OR ${a}.name ILIKE $${index})`
        : `AND ${a}.name ILIKE $${index}`,
    );
  }

  return conditions.join("\n         ");
}

/* Daftar kolom ditulis sekali supaya daftar dan detail tidak berbeda diam-diam. */
export const VOUCHER_SELECT = `v.id,
            v.created_at,
            v.updated_at,
            v.code,
            v.name,
            v.description,
            v.discount_type,
            v.percent_value,
            v.fixed_amount::text AS fixed_amount,
            v.currency,
            v.scope,
            v.starts_at,
            v.ends_at,
            v.max_redemptions,
            v.max_redemptions_per_customer,
            v.min_amount::text AS min_amount,
            v.applies_to,
            v.is_active`;

export const FLASH_SALE_SELECT = `f.id,
            f.created_at,
            f.updated_at,
            f.plan_id,
            p.name AS plan_name,
            p.code AS code,
            f.name,
            f.description,
            f.discount_type,
            f.percent_value,
            f.fixed_amount::text AS fixed_amount,
            f.currency,
            f.scope,
            f.starts_at,
            f.ends_at,
            f.is_active`;

export async function findVoucher(voucherId: string, executor?: Queryable) {
  return queryOne<VoucherRow>(
    `SELECT ${VOUCHER_SELECT} FROM discount_vouchers v WHERE v.id = $1`,
    [voucherId],
    executor,
  );
}

/*
  Mencari voucher berdasarkan kode.

  Kode disimpan dalam huruf besar dan dibandingkan setelah dirapikan, supaya pelanggan yang mengetik
  "  nayaka10 " tetap menemukan kodenya.
*/
export async function findVoucherByCode(code: string, executor?: Queryable) {
  return queryOne<VoucherRow>(
    `SELECT ${VOUCHER_SELECT} FROM discount_vouchers v WHERE v.code = upper(btrim($1))`,
    [code],
    executor,
  );
}

export async function findFlashSale(flashSaleId: string, executor?: Queryable) {
  return queryOne<FlashSaleRow>(
    `SELECT ${FLASH_SALE_SELECT}
     FROM plan_flash_sales f
     JOIN subscription_plans p ON p.id = f.plan_id
     WHERE f.id = $1`,
    [flashSaleId],
    executor,
  );
}

/*
  Jumlah harga terpilih per aturan.

  Dibaca terpisah dari baris utamanya karena jumlah ini hanya berarti pada cakupan `selected_prices`,
  dan halaman daftar perlu menampilkan "3 harga" tanpa mengambil seluruh daftar harganya.
*/
export async function voucherPriceCounts(
  voucherIds: string[],
  executor?: Queryable,
): Promise<Map<string, number>> {
  if (voucherIds.length === 0) return new Map();

  const rows = await query<{ voucher_id: string; price_count: number }>(
    `SELECT voucher_id, count(*)::int AS price_count
     FROM discount_voucher_prices
     WHERE voucher_id = ANY($1::uuid[])
     GROUP BY voucher_id`,
    [voucherIds],
    executor,
  );

  return new Map(rows.map((row) => [row.voucher_id, row.price_count]));
}

export async function flashSalePriceCounts(
  flashSaleIds: string[],
  executor?: Queryable,
): Promise<Map<string, number>> {
  if (flashSaleIds.length === 0) return new Map();

  const rows = await query<{ flash_sale_id: string; price_count: number }>(
    `SELECT flash_sale_id, count(*)::int AS price_count
     FROM plan_flash_sale_prices
     WHERE flash_sale_id = ANY($1::uuid[])
     GROUP BY flash_sale_id`,
    [flashSaleIds],
    executor,
  );

  return new Map(rows.map((row) => [row.flash_sale_id, row.price_count]));
}

/*
  Jumlah pemakaian per voucher.

  Dihitung dari catatan pemakaian, bukan dari penghitung di tabel voucher, karena tabel voucher
  memang tidak menyimpan penghitung. Angka kuota yang tersisa selalu berasal dari sumber yang sama
  dengan riwayat pemakaiannya, sehingga tidak mungkin berbeda.
*/
export async function voucherRedemptionCounts(
  voucherIds: string[],
  executor?: Queryable,
): Promise<Map<string, number>> {
  if (voucherIds.length === 0) return new Map();

  const rows = await query<{ voucher_id: string; redemption_count: number }>(
    `SELECT voucher_id, count(*)::int AS redemption_count
     FROM discount_voucher_redemptions
     WHERE voucher_id = ANY($1::uuid[])
     GROUP BY voucher_id`,
    [voucherIds],
    executor,
  );

  return new Map(rows.map((row) => [row.voucher_id, row.redemption_count]));
}

/*
  Daftar harga yang dapat dipilih sebagai sasaran aturan.

  Seluruh harga paket dikirim, termasuk harga paket yang tidak aktif, karena operator perlu melihat
  bahwa sebuah harga ada untuk dapat memutuskan apakah promo yang menempel padanya masih masuk akal.
  Penandanya (`plan_is_active`, `price_is_active`) yang membedakan, bukan penyembunyian baris.
*/
export async function priceOptions(executor?: Queryable): Promise<PriceOptionRow[]> {
  return query<PriceOptionRow>(
    `SELECT pr.id,
            pr.plan_id,
            p.code AS plan_code,
            p.name AS plan_name,
            p.is_active AS plan_is_active,
            pr.billing_interval,
            pr.amount::text AS amount,
            pr.currency,
            pr.is_active AS price_is_active
     FROM plan_prices pr
     JOIN subscription_plans p ON p.id = pr.plan_id
     ORDER BY p.sort_order, p.name, pr.billing_interval`,
    [],
    executor,
  );
}

/* Paket yang punya harga, dipakai pemilih paket pada formulir flash sale. */
export async function planOptions(executor?: Queryable) {
  return query<{
    id: string;
    code: string;
    name: string;
    is_active: boolean;
    is_free: boolean;
    price_count: number;
  }>(
    `SELECT p.id,
            p.code,
            p.name,
            p.is_active,
            p.is_free,
            (SELECT count(*)::int FROM plan_prices pr WHERE pr.plan_id = p.id) AS price_count
     FROM subscription_plans p
     ORDER BY p.sort_order, p.name`,
    [],
    executor,
  );
}

/*
  Ringkasan untuk kartu di atas tabel voucher.

  Angka yang dipilih adalah yang menuntut keputusan operator: berapa yang sedang berjalan, berapa
  yang menunggu waktu, berapa yang kuotanya sudah habis, dan berapa yang dimatikan.
*/
export async function voucherSummary(executor?: Queryable) {
  return queryOne<{
    total: number;
    running: number;
    scheduled: number;
    ended: number;
    exhausted: number;
    inactive: number;
    redemptions: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (
              WHERE is_active
                AND (starts_at IS NULL OR starts_at <= now())
                AND (ends_at IS NULL OR ends_at > now())
            )::int AS running,
            count(*) FILTER (WHERE is_active AND starts_at > now())::int AS scheduled,
            count(*) FILTER (
              WHERE is_active AND ends_at IS NOT NULL AND ends_at <= now()
            )::int AS ended,
            count(*) FILTER (
              WHERE is_active
                AND max_redemptions IS NOT NULL
                AND (SELECT count(*) FROM discount_voucher_redemptions r
                      WHERE r.voucher_id = discount_vouchers.id) >= max_redemptions
            )::int AS exhausted,
            count(*) FILTER (WHERE NOT is_active)::int AS inactive,
            (SELECT count(*)::int FROM discount_voucher_redemptions) AS redemptions
     FROM discount_vouchers`,
    [],
    executor,
  );
}

export async function flashSaleSummary(executor?: Queryable) {
  return queryOne<{
    total: number;
    running: number;
    scheduled: number;
    ended: number;
    inactive: number;
    selected_prices: number;
    plan_count: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE is_active AND starts_at <= now() AND ends_at > now())::int
              AS running,
            count(*) FILTER (WHERE is_active AND starts_at > now())::int AS scheduled,
            count(*) FILTER (WHERE is_active AND ends_at <= now())::int AS ended,
            count(*) FILTER (WHERE NOT is_active)::int AS inactive,
            count(*) FILTER (WHERE scope = 'selected_prices')::int AS selected_prices,
            count(DISTINCT plan_id)::int AS plan_count
     FROM plan_flash_sales`,
    [],
    executor,
  );
}

/*
  Bentuk voucher yang dikirim ke klien.

  Dipakai endpoint daftar dan endpoint detail sekaligus. Kalau bentuknya dirakit di dua tempat,
  keduanya akan berbeda diam-diam, dan halaman daftar serta halaman detail akan menampilkan angka
  yang tidak sama untuk voucher yang sama.

  `state` dan `state_label` ikut dikirim supaya klien tidak menghitung ulang keadaan dari waktu,
  karena jam di browser operator belum tentu sama dengan jam server.
*/
export function voucherPayload(
  row: VoucherRow,
  extras: { price_count?: number; redemption_count?: number } = {},
) {
  const state = discountState(row);
  const terpakai = extras.redemption_count ?? 0;
  const sisaKuota =
    row.max_redemptions === null ? null : Math.max(0, row.max_redemptions - terpakai);

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    discount_type: row.discount_type,
    percent_value: row.percent_value,
    fixed_amount: row.fixed_amount,
    currency: row.currency,
    scope: row.scope,
    starts_at: row.starts_at?.toISOString() ?? null,
    ends_at: row.ends_at?.toISOString() ?? null,
    max_redemptions: row.max_redemptions,
    max_redemptions_per_customer: row.max_redemptions_per_customer,
    min_amount: row.min_amount,
    applies_to: row.applies_to,
    is_active: row.is_active,
    state,
    state_label: DISCOUNT_STATE_LABELS[state],
    price_count: extras.price_count ?? 0,
    redemption_count: terpakai,
    remaining_redemptions: sisaKuota,
    /* Kuota habis bukan keadaan yang sama dengan kedaluwarsa; keduanya ditampilkan terpisah. */
    quota_exhausted: row.max_redemptions !== null && terpakai >= row.max_redemptions,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function flashSalePayload(row: FlashSaleRow, extras: { price_count?: number } = {}) {
  const state = discountState(row);

  return {
    id: row.id,
    plan_id: row.plan_id,
    plan_name: row.plan_name,
    name: row.name,
    description: row.description,
    discount_type: row.discount_type,
    percent_value: row.percent_value,
    fixed_amount: row.fixed_amount,
    currency: row.currency,
    scope: row.scope,
    starts_at: row.starts_at.toISOString(),
    ends_at: row.ends_at.toISOString(),
    is_active: row.is_active,
    state,
    state_label: DISCOUNT_STATE_LABELS[state],
    price_count: extras.price_count ?? 0,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/*
  Membaca kembali satu voucher beserta jumlah harga terpilih dan jumlah pemakaiannya.

  Dipakai setelah pembuatan dan penyuntingan, supaya klien menerima bentuk yang sama dengan yang
  dikirim endpoint detail. Tanpa ini, layar yang baru menyimpan akan menampilkan angka 0 untuk
  pemakaian sampai halaman dimuat ulang.
*/
export async function readVoucher(voucherId: string, executor?: Queryable) {
  const row = await queryOne<VoucherRow>(
    `SELECT ${VOUCHER_SELECT} FROM discount_vouchers v WHERE v.id = $1`,
    [voucherId],
    executor,
  );

  if (!row) {
    throw new AppError({
      code: "INTERNAL_ERROR",
      message: "Voucher tersimpan tetapi tidak dapat dibaca kembali.",
    });
  }

  const [priceCounts, redemptionCounts] = await Promise.all([
    voucherPriceCounts([voucherId], executor),
    voucherRedemptionCounts([voucherId], executor),
  ]);

  return voucherPayload(row, {
    price_count: priceCounts.get(voucherId) ?? 0,
    redemption_count: redemptionCounts.get(voucherId) ?? 0,
  });
}

/*
  Membaca kembali satu flash sale beserta jumlah harga terpilihnya.

  Bentuknya sama dengan `readVoucher`, termasuk alasan keberadaannya: jawaban setelah menyimpan harus
  sama dengan jawaban endpoint detail.
*/
export async function readFlashSale(flashSaleId: string, executor?: Queryable) {
  const row = await findFlashSale(flashSaleId, executor);

  if (!row) {
    throw new AppError({
      code: "INTERNAL_ERROR",
      message: "Flash sale tersimpan tetapi tidak dapat dibaca kembali.",
    });
  }

  const priceCounts = await flashSalePriceCounts([flashSaleId], executor);
  return flashSalePayload(row, { price_count: priceCounts.get(flashSaleId) ?? 0 });
}

/* ------------------------------------------------------------------------------------------------
  Pencocokan promo dengan harga, dan pemakaian voucher.
------------------------------------------------------------------------------------------------ */

/*
  Voucher yang boleh dipakai sekarang.

  Syaratnya dikumpulkan di satu kueri supaya daftar promosi yang dilihat pelanggan, kueri yang
  dipakai saat menagih, dan angka kuota yang ditampilkan operator berasal dari keadaan yang sama.
  Kalau salah satu syarat hanya diperiksa di sisi aplikasi, akan ada celah waktu di mana voucher
  yang kuotanya baru habis masih dianggap sah.

  Syarat yang diperiksa:
  - aktif, dan jendela waktunya sudah terbuka,
  - kuota total belum habis (dihitung dari catatan pemakaian),
  - dan, bila `customerId` diisi, pelanggan itu belum pernah memakainya.

  Batas per pelanggan diperlakukan sebagai "sekali per pelanggan", bukan angka bebas, karena
  database menyimpan batasan UNIQUE (voucher_id, customer_id). Kolomnya memang boleh berisi lebih
  dari satu, tetapi pemakaian kedua oleh orang yang sama tidak akan pernah dapat disimpan, jadi
  memeriksa angka lain daripada 1 hanya akan menjanjikan sesuatu yang tidak bisa ditepati.

  `voucherCode` membatasi hasil ke satu kode. Dipakai saat pelanggan mengetik kode di checkout:
  kode yang tidak lolos syarat di atas tidak akan muncul, sehingga hasilnya "kode tidak berlaku",
  bukan "kode tidak ditemukan".
*/
export async function eligibleVouchers(
  input: { customerId?: string | null; voucherCode?: string | null } = {},
  executor?: Queryable,
) {
  const params: unknown[] = [];
  let conditions = `v.is_active
       AND (v.starts_at IS NULL OR v.starts_at <= now())
       AND (v.ends_at IS NULL OR v.ends_at > now())
       AND (v.max_redemptions IS NULL
            OR (SELECT count(*) FROM discount_voucher_redemptions r
                 WHERE r.voucher_id = v.id) < v.max_redemptions)`;

  if (input.voucherCode) {
    conditions += ` AND v.code = upper(btrim($${params.push(input.voucherCode)}))`;
  }
  if (input.customerId) {
    const customerIndex = params.push(input.customerId);
    conditions += ` AND NOT EXISTS (
           SELECT 1 FROM discount_voucher_redemptions r
           WHERE r.voucher_id = v.id
             AND r.customer_id = $${customerIndex}::uuid
         )`;
  }

  return query<VoucherRow & { price_ids: string[] | null }>(
    `SELECT ${VOUCHER_SELECT},
            (SELECT array_agg(vp.plan_price_id) FROM discount_voucher_prices vp
              WHERE vp.voucher_id = v.id) AS price_ids
     FROM discount_vouchers v
     WHERE ${conditions}`,
    params,
    executor,
  );
}

/*
  Flash sale yang jendela waktunya sedang terbuka.

  Flash sale tidak butuh kode, jadi syaratnya hanya aktif dan waktunya berjalan. Kuota tidak berlaku
  di sini: yang membatasi flash sale adalah jam, bukan jumlah pemakaian.
*/
export async function eligibleFlashSales(executor?: Queryable) {
  return query<FlashSaleRow & { price_ids: string[] | null }>(
    `SELECT ${FLASH_SALE_SELECT},
            (SELECT array_agg(fp.plan_price_id) FROM plan_flash_sale_prices fp
              WHERE fp.flash_sale_id = f.id) AS price_ids
     FROM plan_flash_sales f
     JOIN subscription_plans p ON p.id = f.plan_id
     WHERE f.is_active
       AND f.starts_at <= now()
       AND f.ends_at > now()`,
    [],
    executor,
  );
}

/*
  Menerapkan cakupan satu aturan pada satu harga.

  Aturan cakupannya berbeda antara voucher dan flash sale, dan itulah satu-satunya alasan fungsi ini
  ada:

  - Voucher `all_prices` berlaku untuk harga paket mana pun.
  - Flash sale `all_prices` berlaku untuk seluruh harga dari paket yang ditunjuk baris itu, bukan
    untuk semua paket. Karena itu `plan_id` harga ikut diperiksa.
  - Cakupan `selected_prices` selalu berarti harga harus terdaftar.
*/
function scopeMatches(
  rule: { scope: DiscountScope; plan_id?: string; price_ids: string[] | null },
  price: PriceRef,
): boolean {
  if (rule.scope === "selected_prices") {
    return (rule.price_ids ?? []).includes(price.id);
  }
  if (rule.plan_id === undefined) return true;
  return rule.plan_id === price.plan_id;
}

/* Bentuk calon aturan dari baris voucher dan flash sale, untuk diserahkan ke mesin hitung. */
export function voucherCandidate(row: VoucherRow): DiscountCandidate {
  return {
    source: "voucher",
    id: row.id,
    name: row.name,
    code: row.code,
    discount_type: row.discount_type,
    percent_value: row.percent_value,
    fixed_amount: row.fixed_amount === null ? null : parseAmount(row.fixed_amount),
  };
}

export function flashSaleCandidate(row: FlashSaleRow): DiscountCandidate {
  return {
    source: "flash_sale",
    id: row.id,
    name: row.name,
    code: null,
    discount_type: row.discount_type,
    percent_value: row.percent_value,
    fixed_amount: row.fixed_amount === null ? null : parseAmount(row.fixed_amount),
  };
}

/*
  Seluruh promo yang berlaku untuk sekumpulan harga, sudah dipilih dan dihitung.

  Aturan pemilihan, yaitu tidak menumpuk dan ambil yang paling menguntungkan, hidup di
  `discount-price.ts`, bukan di sini, supaya dapat diuji tanpa database.

  Harga diminta sebagai daftar harga beserta paketnya, bukan sekadar daftar id, karena dua hal:
  perbandingan "persen atau nominal, mana yang lebih untung" hanya bisa dijawab dengan mengetahui
  harga awalnya, dan cakupan `all_prices` milik flash sale hanya bisa diputuskan dengan mengetahui
  paketnya.
*/
export async function matchedRulesForPrices(
  prices: PriceRef[],
  input: { customerId?: string | null; voucherCode?: string | null } = {},
  executor?: Queryable,
): Promise<MatchedPriceRule[]> {
  if (prices.length === 0) return [];

  const [vouchers, flashSales] = await Promise.all([
    eligibleVouchers(input, executor),
    eligibleFlashSales(executor),
  ]);

  return prices.map((price) => {
    const priceAmount = parseAmount(price.amount);

    const appliedVouchers = vouchers.filter((voucher) => scopeMatches(voucher, price));
    const appliedFlashSales = flashSales.filter((sale) => scopeMatches(sale, price));

    const applied = applyDiscount(
      [
        ...appliedVouchers.map((voucher) => voucherCandidate(voucher)),
        ...appliedFlashSales.map((sale) => flashSaleCandidate(sale)),
      ],
      priceAmount,
    );

    return {
      price_id: price.id,
      plan_id: price.plan_id,
      amount: price.amount,
      currency: price.currency,
      amount_after: applied?.amount_after ?? priceAmount,
      discount_amount: applied?.discount_amount ?? 0,
      discount: applied
        ? {
            source: applied.source,
            name: applied.name,
            code: applied.code,
            discount_type: applied.discount_type,
            percent_value: applied.percent_value,
            fixed_amount: applied.fixed_amount,
          }
        : null,
      vouchers: appliedVouchers.map((voucher) => ({
        id: voucher.id,
        code: voucher.code,
        name: voucher.name,
      })),
      flash_sales: appliedFlashSales.map((sale) => ({ id: sale.id, name: sale.name })),
    };
  });
}

/*
  Mencatat pemakaian voucher.

  Seluruh pemeriksaan dilakukan di dalam transaksi, dengan baris vouchernya dikunci lebih dulu:
  kuota dibaca dari catatan pemakaian, dan tanpa kunci itu dua permintaan checkout yang datang
  bersamaan dapat sama-sama membaca "masih ada sisa" lalu sama-sama menyimpan pemakaiannya, sehingga
  kuota terlampaui.

  Mengembalikan null bila voucher tidak dapat dipakai, bukan melempar galat, karena "kuota habis"
  dan "sudah pernah dipakai pelanggan ini" adalah jawaban yang sah untuk sebuah percobaan checkout,
  bukan kegagalan server. Pemanggil yang menerjemahkannya menjadi pesan.

  Fungsi ini dipanggil endpoint checkout saat tagihan dibuat. Endpoint itu belum ada di repo ini,
  jadi belum ada pemanggilnya.
*/
export async function recordVoucherRedemption(
  input: {
    voucherId: string;
    customerId: string;
    subscriptionId?: string | null;
    invoiceId?: string | null;
    amountBefore: AmountText;
    discountAmount: AmountText;
  },
  executor?: Queryable,
) {
  /*
    Baris voucher dikunci, lalu kuota dan pemakaian pelanggan ini dihitung dari catatan pemakaian.
    Keduanya dibaca dalam satu transaksi dengan kunci yang sama, sehingga keputusan "masih boleh"
    tidak dapat berubah di antara pemeriksaan dan penyimpanan.
  */
  const voucher = await queryOne<{
    code: string;
    max_redemptions: number | null;
    terpakai: number;
    pemakaian_pelanggan: number;
  }>(
    `SELECT v.code,
            v.max_redemptions,
            (SELECT count(*)::int FROM discount_voucher_redemptions r
              WHERE r.voucher_id = v.id) AS terpakai,
            (SELECT count(*)::int FROM discount_voucher_redemptions r
              WHERE r.voucher_id = v.id AND r.customer_id = $2::uuid) AS pemakaian_pelanggan
     FROM discount_vouchers v
     WHERE v.id = $1
     FOR UPDATE`,
    [input.voucherId, input.customerId],
    executor,
  );

  if (!voucher) return null;
  if (voucher.pemakaian_pelanggan > 0) return null;
  if (voucher.max_redemptions !== null && voucher.terpakai >= voucher.max_redemptions) return null;

  const amountBefore = parseAmount(input.amountBefore);
  const discountAmount = Math.min(parseAmount(input.discountAmount), amountBefore);

  /* Nominal disimpan apa adanya. Selisihnya adalah potongan yang benar-benar diberikan. */
  return queryOne<{ id: string }>(
    `INSERT INTO discount_voucher_redemptions
       (voucher_id, customer_id, subscription_id, invoice_id, code,
        amount_before, discount_amount, amount_after)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric)
     RETURNING id`,
    [
      input.voucherId,
      input.customerId,
      input.subscriptionId ?? null,
      input.invoiceId ?? null,
      voucher.code,
      amountBefore.toFixed(2),
      discountAmount.toFixed(2),
      Math.max(0, amountBefore - discountAmount).toFixed(2),
    ],
    executor,
  );
}

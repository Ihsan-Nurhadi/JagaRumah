/*
  Lapisan data untuk paket dan harga.

  Aturan modul ini yang mudah salah kalau ditulis di route handler:

  1. Satu paket hanya boleh punya satu baris harga per interval tagihan. Batasan itu ditegakkan
     database lewat UNIQUE (plan_id, billing_interval), dan akibatnya harga tidak dapat diganti
     dengan menambah baris baru selama baris lama untuk interval yang sama masih ada.
  2. Harga yang sudah dipakai langganan tidak boleh diubah nominalnya. Nominal itu yang tercatat
     sebagai harga langganan lama, dan catatan itulah yang dipakai saat menagih ulang. Karena itu
     nominal hanya dapat diubah selama belum ada satu pun langganan yang memakainya.
  3. `device_limit` NULL berarti tanpa batas, dan itu berbeda arti dari 0 yang berarti tidak boleh
     ada perangkat sama sekali.

  Ringkasan di halaman daftar dihitung dari seluruh tabel, bukan dari halaman yang sedang
  terbuka, supaya angkanya tidak berubah setiap kali pengguna menekan "berikutnya".
*/
import { query, queryOne, type Queryable } from "./db";

export const BILLING_INTERVALS = ["monthly", "yearly"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/* Bentuk kata untuk dipakai di tengah kalimat pesan galat. Label di layar memakai huruf besar. */
export const INTERVAL_LABELS: Record<BillingInterval, string> = {
  monthly: "bulanan",
  yearly: "tahunan",
};

export type PlanListRow = {
  id: string;
  cursor_value: string;
  code: string;
  name: string;
  description: string | null;
  device_limit: number | null;
  is_free: boolean;
  is_active: boolean;
  sort_order: number;
  subscription_count: number;
  created_at: Date;
  updated_at: Date;
};

export type PlanPriceRow = {
  id: string;
  plan_id: string;
  billing_interval: string;
  amount: string;
  currency: string;
  is_active: boolean;
  subscription_count: number;
  created_at: Date;
  updated_at: Date;
};

export type PriceListRow = PlanPriceRow & {
  cursor_value: string;
  plan_code: string;
  plan_name: string;
};

export type PlanFilter = {
  /** Pencarian pada kode atau nama paket. */
  q?: string;
  isActive?: boolean;
};

export type PriceFilter = {
  planId?: string;
  billingInterval?: string;
  isActive?: boolean;
};

/*
  Menyusun syarat filter dan mengumpulkan parameternya.

  Nilai selalu dikirim sebagai parameter, tidak pernah disambung ke SQL. Pencarian memakai ILIKE
  dengan pola yang di-escape lebih dulu, supaya karakter % dan _ yang diketik operator dicari apa
  adanya alih-alih berlaku sebagai wildcard.
*/
export function planFilterConditions(filter: PlanFilter, params: unknown[]): string {
  const conditions: string[] = [];

  if (filter.isActive !== undefined) {
    conditions.push(`AND p.is_active = $${params.push(filter.isActive)}`);
  }
  if (filter.q) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const index = params.push(pattern);
    conditions.push(`AND (p.code ILIKE $${index} OR p.name ILIKE $${index})`);
  }

  return conditions.join("\n         ");
}

export function priceFilterConditions(filter: PriceFilter, params: unknown[]): string {
  const conditions: string[] = [];

  if (filter.planId) {
    conditions.push(`AND pr.plan_id = $${params.push(filter.planId)}::uuid`);
  }
  if (filter.billingInterval) {
    conditions.push(`AND pr.billing_interval = $${params.push(filter.billingInterval)}`);
  }
  if (filter.isActive !== undefined) {
    conditions.push(`AND pr.is_active = $${params.push(filter.isActive)}`);
  }

  return conditions.join("\n         ");
}

export async function findPlan(planId: string, executor?: Queryable) {
  return queryOne<PlanListRow>(
    `SELECT p.id,
            p.created_at::text AS cursor_value,
            p.code,
            p.name,
            p.description,
            p.device_limit,
            p.is_free,
            p.is_active,
            p.sort_order,
            (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id) AS subscription_count,
            p.created_at,
            p.updated_at
     FROM subscription_plans p
     WHERE p.id = $1`,
    [planId],
    executor,
  );
}

/*
  Harga milik sekumpulan paket, dibaca sekali untuk satu halaman daftar.

  Yang dikembalikan adalah seluruh baris harga paket itu, termasuk yang tidak aktif. Kalau hanya
  baris aktif yang dikirim, halaman tidak dapat membedakan "interval ini belum pernah diisi" dari
  "interval ini dinonaktifkan", dan dua keadaan itu menuntut tindakan yang berbeda.
*/
export async function planPrices(planIds: string[], executor?: Queryable): Promise<PlanPriceRow[]> {
  if (planIds.length === 0) return [];

  return query<PlanPriceRow>(
    `SELECT pr.id,
            pr.plan_id,
            pr.billing_interval,
            pr.amount::text AS amount,
            pr.currency,
            pr.is_active,
            (SELECT count(*)::int FROM subscriptions s WHERE s.plan_price_id = pr.id)
              AS subscription_count,
            pr.created_at,
            pr.updated_at
     FROM plan_prices pr
     WHERE pr.plan_id = ANY($1::uuid[])
     ORDER BY pr.billing_interval`,
    [planIds],
    executor,
  );
}

/*
  Ringkasan untuk kartu di atas tabel.

  Dua angka terakhir sengaja ada. "Paket tanpa harga aktif" adalah keadaan yang membuat paket
  tidak dapat dipilih pelanggan, dan "harga yang sudah dipakai langganan" adalah harga yang
  nominalnya sudah terkunci.
*/
export async function planSummary(executor?: Queryable) {
  return queryOne<{
    total: number;
    active: number;
    inactive: number;
    unlimited_device_limit: number;
    without_active_price: number;
    price_total: number;
    price_in_use: number;
  }>(
    `SELECT (SELECT count(*)::int FROM subscription_plans) AS total,
            (SELECT count(*)::int FROM subscription_plans WHERE is_active) AS active,
            (SELECT count(*)::int FROM subscription_plans WHERE NOT is_active) AS inactive,
            (SELECT count(*)::int FROM subscription_plans WHERE device_limit IS NULL)
              AS unlimited_device_limit,
            (SELECT count(*)::int FROM subscription_plans p
              WHERE NOT EXISTS (
                SELECT 1 FROM plan_prices pr WHERE pr.plan_id = p.id AND pr.is_active
              )) AS without_active_price,
            (SELECT count(*)::int FROM plan_prices) AS price_total,
            (SELECT count(*)::int FROM plan_prices pr
              WHERE EXISTS (
                SELECT 1 FROM subscriptions s WHERE s.plan_price_id = pr.id
              )) AS price_in_use`,
    [],
    executor,
  );
}

export async function priceSummary(executor?: Queryable) {
  return queryOne<{ total: number; active: number; inactive: number; in_use: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE is_active)::int AS active,
            count(*) FILTER (WHERE NOT is_active)::int AS inactive,
            count(*) FILTER (
              WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.plan_price_id = plan_prices.id)
            )::int AS in_use
     FROM plan_prices`,
    [],
    executor,
  );
}

/*
  Urutan paket berikutnya, dipakai sebagai nilai awal formulir paket baru.

  Diambil dari data, bukan ditetapkan sebagai konstanta, karena paket yang dibuat belakangan
  harus berada di atas paket yang sudah ada. Kalau nilainya dipatok, dua paket akan berbagi
  urutan yang sama dan arti "naik paket" menjadi tidak tentu.
*/
export async function nextSortOrder(executor?: Queryable): Promise<number> {
  const row = await queryOne<{ next_sort_order: number }>(
    "SELECT coalesce(max(sort_order) + 1, 0)::int AS next_sort_order FROM subscription_plans",
    [],
    executor,
  );
  return row?.next_sort_order ?? 0;
}

/*
  Jumlah langganan yang memakai sebuah paket.

  Dibaca terpisah dari harga karena halaman detail perlu membedakan "paket ini dipakai berapa
  langganan" dari "harga ini dipakai berapa langganan".
*/
export async function planUsage(planId: string, executor?: Queryable) {
  const row = await queryOne<{ total: number; active: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status IN ('trialing', 'active', 'past_due'))::int AS active
     FROM subscriptions
     WHERE plan_id = $1`,
    [planId],
    executor,
  );
  return { total: row?.total ?? 0, active: row?.active ?? 0 };
}

/*
  Bentuk paket yang dikirim ke klien.

  Dipakai endpoint daftar dan endpoint detail sekaligus. Kalau bentuknya dirakit di dua tempat,
  keduanya akan berbeda diam-diam, dan halaman daftar serta halaman detail akan menampilkan angka
  yang tidak sama untuk paket yang sama.

  `amount_editable` ikut dikirim supaya formulir dapat mematikan kolom nominal untuk harga yang
  sudah dipakai langganan, alih-alih menyediakan kolom yang pasti ditolak server.
*/
export function planPayload(row: PlanListRow, prices: PlanPriceRow[]) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    device_limit: row.device_limit,
    device_limit_unlimited: row.device_limit === null,
    is_free: row.is_free,
    is_active: row.is_active,
    sort_order: row.sort_order,
    subscription_count: row.subscription_count,
    has_active_price: prices.some((price) => price.is_active),
    prices: prices.map((price) => ({
      id: price.id,
      billing_interval: price.billing_interval,
      amount: price.amount,
      currency: price.currency,
      is_active: price.is_active,
      amount_editable: price.subscription_count === 0,
      subscription_count: price.subscription_count,
      created_at: price.created_at.toISOString(),
      updated_at: price.updated_at.toISOString(),
    })),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

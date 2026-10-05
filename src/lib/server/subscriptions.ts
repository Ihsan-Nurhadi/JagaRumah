import type { PoolClient } from "pg";

import { query, queryOne, type Queryable } from "./db";
import { AppError } from "./errors";

/*
  Data langganan untuk konsol admin.

  Satu hal yang harus dipahami sebelum membaca berkas ini: paket gratis pun disimpan sebagai
  langganan sungguhan, bukan sebagai ketiadaan langganan. Karena itu "pelanggan tanpa langganan"
  adalah keadaan yang tidak seharusnya terjadi, dan pemeriksaan batas perangkat selalu punya
  baris langganan untuk dibaca.

  Batas perangkat berasal dari paket, bukan dari langganan. Jadi mengubah batas paket langsung
  berlaku untuk seluruh pelanggan yang memakainya. Itu disengaja: batas adalah sifat paket,
  bukan sifat perjanjian satu pelanggan.
*/

export type SubscriptionListRow = {
  id: string;
  cursor_value: string;
  status: string;
  started_at: Date | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  created_at: Date;
  customer_id: string;
  customer_name: string | null;
  customer_status: string | null;
  plan_id: string | null;
  plan_name: string | null;
  plan_code: string | null;
  device_limit: number | null;
  sort_order: number | null;
  active_device_count: number;
  price_amount: string | null;
  price_interval: string | null;
};

export type SubscriptionFilter = {
  status?: string;
  planId?: string;
  customerId?: string;
  q?: string;
};

/*
  Pencarian langganan memakai nama pelanggan, karena itulah yang dipegang operator saat
  menerima telepon. Mencari berdasarkan nomor langganan jarang berguna: nomor itu tidak pernah
  disebutkan pelanggan.
*/
export function subscriptionFilterConditions(
  filter: SubscriptionFilter,
  params: unknown[],
): string {
  const conditions: string[] = [];

  if (filter.status) {
    conditions.push(`AND s.status = $${params.push(filter.status)}`);
  }

  if (filter.planId) {
    conditions.push(`AND s.plan_id = $${params.push(filter.planId)}::uuid`);
  }

  if (filter.customerId) {
    conditions.push(`AND s.customer_id = $${params.push(filter.customerId)}::uuid`);
  }

  if (filter.q) {
    /* Tanda persen dan garis bawah di-escape, kalau tidak pencarian "50%" cocok dengan semua. */
    const pattern = `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    conditions.push(`AND c.full_name ILIKE $${params.push(pattern)}`);
  }

  return conditions.join("\n          ");
}

/*
  Proyeksi bersama untuk daftar dan detail.

  Ditulis sekali di sini supaya daftar dan detail tidak bisa menampilkan angka perangkat yang
  berbeda untuk langganan yang sama. Dua tempat yang menghitung sendiri-sendiri adalah cara
  paling mudah membuat selisih yang tidak bisa dijelaskan.
*/
const SELECT_COLUMNS = `
  s.id,
  s.created_at::text AS cursor_value,
  s.status,
  s.started_at,
  s.current_period_start,
  s.current_period_end,
  s.cancel_at_period_end,
  s.canceled_at,
  s.created_at,
  s.customer_id,
  c.full_name AS customer_name,
  c.status AS customer_status,
  s.plan_id,
  p.name AS plan_name,
  p.code AS plan_code,
  p.device_limit,
  p.sort_order,
  (
    SELECT count(*)::int FROM devices d
    WHERE d.customer_id = s.customer_id AND d.status = 'claimed'
  ) AS active_device_count,
  pr.amount::text AS price_amount,
  pr.billing_interval AS price_interval
`;

const SELECT_JOINS = `
  FROM subscriptions s
  LEFT JOIN customers c ON c.id = s.customer_id
  LEFT JOIN subscription_plans p ON p.id = s.plan_id
  LEFT JOIN plan_prices pr ON pr.id = s.plan_price_id
`;

export async function findSubscription(
  subscriptionId: string,
  executor?: Queryable,
): Promise<SubscriptionListRow | null> {
  return queryOne<SubscriptionListRow>(
    `SELECT ${SELECT_COLUMNS} ${SELECT_JOINS} WHERE s.id = $1`,
    [subscriptionId],
    executor,
  );
}

export type SubscriptionSummary = {
  total: number;
  active: number;
  past_due: number;
  canceled: number;
  expired: number;
  ending_soon: number;
};

/*
  "Berakhir dalam tujuh hari" dimasukkan karena itu daftar kerja yang paling berguna bagi
  tim penagihan: langganan yang perlu ditagih ulang sebelum pelanggan kehilangan layanan.

  Langganan tanpa tanggal berakhir, yaitu paket gratis, tidak pernah dihitung di sana. Tanpa
  syarat itu, seluruh pelanggan gratis akan muncul sebagai akan berakhir, dan angkanya berhenti
  bermakna.
*/
export async function subscriptionSummary(
  executor?: Queryable,
): Promise<SubscriptionSummary | null> {
  return queryOne<SubscriptionSummary>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'past_due')::int AS past_due,
            count(*) FILTER (WHERE status = 'canceled')::int AS canceled,
            count(*) FILTER (WHERE status = 'expired')::int AS expired,
            count(*) FILTER (
              WHERE status IN ('active', 'past_due')
                AND current_period_end IS NOT NULL
                AND current_period_end <= now() + interval '7 days'
            )::int AS ending_soon
     FROM subscriptions`,
    [],
    executor,
  );
}

/*
  Histori perubahan langganan.

  Tanpa tabel ini, pertanyaan "kapan paket pelanggan ini naik dan atas dasar apa" tidak bisa
  dijawab dari mana pun, karena tabel subscriptions hanya menyimpan keadaan terakhir.
*/
export async function subscriptionEvents(
  subscriptionId: string,
  executor?: Queryable,
): Promise<
  {
    id: string;
    event_type: string;
    actor_type: string;
    created_at: Date;
    from_plan_name: string | null;
    to_plan_name: string | null;
    metadata: unknown;
  }[]
> {
  return query(
    `SELECT e.id, e.event_type, e.actor_type, e.created_at,
            pf.name AS from_plan_name,
            pt.name AS to_plan_name,
            e.metadata
     FROM subscription_events e
     LEFT JOIN subscription_plans pf ON pf.id = e.from_plan_id
     LEFT JOIN subscription_plans pt ON pt.id = e.to_plan_id
     WHERE e.subscription_id = $1
     ORDER BY e.created_at DESC`,
    [subscriptionId],
    executor,
  );
}

/*
  Mengunci langganan sebelum diubah.

  Tanpa kunci ini, pembatalan yang ditekan dua kali beruntun oleh dua operator bisa menulis dua
  catatan pembatalan, dan yang kedua mengubah data yang sudah tidak berlaku.
*/
export async function lockSubscription(
  client: PoolClient,
  subscriptionId: string,
): Promise<{
  id: string;
  customer_id: string;
  status: string;
  cancel_at_period_end: boolean;
  customer_name: string | null;
}> {
  const subscription = await queryOne<{
    id: string;
    customer_id: string;
    status: string;
    cancel_at_period_end: boolean;
    customer_name: string | null;
  }>(
    `SELECT s.id, s.customer_id, s.status, s.cancel_at_period_end, c.full_name AS customer_name
     FROM subscriptions s
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.id = $1
     FOR UPDATE OF s`,
    [subscriptionId],
    client,
  );

  if (!subscription) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message:
        "Langganan itu tidak ditemukan. Kembali ke daftar langganan untuk memilih langganan " +
        "yang benar.",
    });
  }

  return subscription;
}

/*
  Pilihan paket untuk pemilih di halaman lain.

  Hanya paket aktif yang ditawarkan. Menawarkan paket nonaktif berarti menyiapkan kesalahan
  yang baru ketahuan setelah pelanggan dikenai harga paket yang sudah tidak dijual.
*/
export async function planOptions(
  executor?: Queryable,
): Promise<
  {
    id: string;
    code: string;
    name: string;
    device_limit: number | null;
    is_free: boolean;
    sort_order: number;
    monthly_amount: string | null;
  }[]
> {
  return query(
    `SELECT p.id, p.code, p.name, p.device_limit, p.is_free, p.sort_order,
            (SELECT pr.amount::text FROM plan_prices pr
             WHERE pr.plan_id = p.id AND pr.is_active
               AND pr.billing_interval = 'monthly'
             LIMIT 1) AS monthly_amount
     FROM subscription_plans p
     WHERE p.is_active
     ORDER BY p.sort_order, p.name`,
    [],
    executor,
  );
}

/*
  Banyaknya langganan yang memakai satu paket.

  Dipakai sebelum paket dinonaktifkan atau batasnya diubah, karena perubahan itu langsung
  menyentuh seluruh pelanggan yang memakainya. Operator perlu tahu jumlahnya lebih dulu.
*/
export async function subscribersOfPlan(
  planId: string,
  executor?: Queryable,
): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total FROM subscriptions
     WHERE plan_id = $1 AND status IN ('trialing', 'active', 'past_due')`,
    [planId],
    executor,
  );
  return row?.total ?? 0;
}

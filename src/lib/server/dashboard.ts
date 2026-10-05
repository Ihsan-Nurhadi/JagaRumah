import { query, queryOne, type Queryable } from "./db";

/*
  Angka dashboard.

  Seluruh berkas ini mengikuti empat definisi metrik yang mengikat, dan definisi itu bukan
  pilihan gaya melainkan yang menentukan apakah angkanya bisa dipercaya:

  1. Pendapatan memakai dasar kas: diakui pada `invoices.paid_at`, nilainya `amount_paid`.
     `provider_total_payment` tidak pernah dipakai, karena di dalamnya ada biaya layanan
     penyedia yang bukan pendapatan kita. Memakainya akan melebihkan angka dan tidak akan
     pernah cocok dengan mutasi rekening setelah dipotong biaya.

  2. Semua pengelompokan per hari, minggu, dan bulan memakai WIB, yaitu UTC+7. Pembayaran
     pukul 06.00 WIB tanggal 1 jatuh pada pukul 23.00 UTC tanggal terakhir bulan sebelumnya,
     sehingga pengelompokan UTC akan memindahkan transaksi itu ke bulan yang salah.

  3. `change_percent` bernilai null bila periode pembandingnya nol, bukan seratus persen.
     Pertumbuhan dari nol tidak punya persentase yang bermakna, dan menampilkan angka apa pun
     di situ akan terbaca sebagai fakta.

  4. Penyebut yang kosong menghasilkan null, bukan nol. Tingkat klaim perangkat saat belum ada
     perangkat sama sekali bukan nol persen, melainkan belum dapat dihitung.
*/

export type DashboardPeriod = {
  from: string;
  to: string;
  granularity: "day" | "week" | "month";
};

/*
  Batas periode diterjemahkan menjadi dua timestamp yang sudah pasti zona waktunya:
  awal hari pertama dan awal hari setelah hari terakhir. Batas atas memakai "kurang dari"
  ketimbang "sampai dengan", supaya tidak ada mikrodetik di ujung hari yang terlewat karena
  pembulatan.
*/
function periodBounds(period: DashboardPeriod): { start: string; endExclusive: string } {
  return { start: period.from, endExclusive: period.to };
}

export type BusinessMetrics = {
  customers: { total: number; active: number; suspended: number; new_in_period: number };
  subscriptions: {
    active: number;
    expired: number;
    canceled: number;
    by_plan: { plan_id: string; plan_name: string; active_count: number }[];
  };
  devices: {
    in_stock: number;
    claimed: number;
    suspended: number;
    claim_rate_percent: number | null;
  };
  mrr: { amount: string; currency: string; as_of: Date };
};

type BusinessRow = {
  total: number;
  active: number;
  suspended: number;
  new_in_period: number;
  sub_active: number;
  sub_expired: number;
  sub_canceled: number;
  in_stock: number;
  claimed: number;
  device_suspended: number;
  mrr_amount: string;
  mrr_currency: string;
};

export async function businessMetrics(
  period: DashboardPeriod,
  executor?: Queryable,
): Promise<BusinessMetrics | null> {
  const { start, endExclusive } = periodBounds(period);

  /*
    Seluruh angka dihitung dalam satu query supaya semuanya berasal dari satu potret data yang
    sama. Menjalankannya sebagai beberapa query terpisah membuka kemungkinan angka-angka di satu
    layar saling bertentangan, karena ada perubahan data di antara query.
  */
  const row = await queryOne<BusinessRow>(
    `WITH customer_counts AS (
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
              count(*) FILTER (
                WHERE created_at >= $1::date::timestamp AT TIME ZONE 'Asia/Jakarta'
                  AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'
              )::int AS new_in_period
       FROM customers
     ),
     subscription_counts AS (
       SELECT count(*) FILTER (WHERE status = 'active')::int AS sub_active,
              count(*) FILTER (WHERE status = 'expired')::int AS sub_expired,
              count(*) FILTER (WHERE status = 'canceled')::int AS sub_canceled
       FROM subscriptions
     ),
     device_counts AS (
       SELECT count(*) FILTER (WHERE status = 'in_stock')::int AS in_stock,
              count(*) FILTER (WHERE status = 'claimed')::int AS claimed,
              count(*) FILTER (WHERE status = 'suspended')::int AS device_suspended
       FROM devices
     ),
     mrr AS (
       /*
         MRR adalah jumlah harga paket dibagi jumlah bulannya. Harga bulanan dibagi satu, harga
         tahunan dibagi dua belas, sehingga keduanya bisa dijumlahkan. Yang dihitung hanya
         langganan aktif pada paket berbayar, karena paket gratis tidak menyumbang pendapatan.
       */
       SELECT COALESCE(sum(
                pp.amount / CASE pp.billing_interval
                  WHEN 'monthly' THEN 1
                  WHEN 'yearly' THEN 12
                  ELSE 1
                END
              ), 0)::text AS mrr_amount,
              COALESCE(max(pp.currency), 'IDR') AS mrr_currency
       FROM subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
       JOIN plan_prices pp ON pp.plan_id = p.id AND pp.is_active
       WHERE s.status = 'active' AND p.is_free = false
     )
     SELECT customer_counts.total, customer_counts.active, customer_counts.suspended,
            customer_counts.new_in_period,
            subscription_counts.sub_active, subscription_counts.sub_expired,
            subscription_counts.sub_canceled,
            device_counts.in_stock, device_counts.claimed, device_counts.device_suspended,
            mrr.mrr_amount, mrr.mrr_currency
     FROM customer_counts, subscription_counts, device_counts, mrr`,
    [start, endExclusive],
    executor,
  );

  if (!row) return null;

  /*
    Tingkat klaim adalah pembagian dengan penyebut yang bisa kosong. Saat belum ada perangkat
    sama sekali, angkanya belum dapat dihitung, bukan nol persen. Perbedaan itu penting: nol
    persen berarti ada perangkat yang tidak terklaim, sedangkan belum dapat dihitung berarti
    belum ada apa pun untuk dihitung.
  */
  const totalDevices = row.in_stock + row.claimed + row.device_suspended;

  return {
    customers: {
      total: row.total,
      active: row.active,
      suspended: row.suspended,
      new_in_period: row.new_in_period,
    },
    subscriptions: {
      active: row.sub_active,
      expired: row.sub_expired,
      canceled: row.sub_canceled,
      by_plan: [],
    },
    devices: {
      in_stock: row.in_stock,
      claimed: row.claimed,
      suspended: row.device_suspended,
      claim_rate_percent:
        totalDevices === 0 ? null : Math.round((row.claimed / totalDevices) * 1000) / 10,
    },
    mrr: { amount: row.mrr_amount, currency: row.mrr_currency, as_of: new Date() },
  };
}

export async function subscriptionsByPlan(
  executor?: Queryable,
): Promise<{ plan_id: string; plan_name: string; active_count: number }[]> {
  return query(
    `SELECT p.id AS plan_id, p.name AS plan_name,
            count(s.id) FILTER (WHERE s.status = 'active')::int AS active_count
     FROM subscription_plans p
     LEFT JOIN subscriptions s ON s.plan_id = p.id
     GROUP BY p.id, p.name, p.sort_order
     ORDER BY p.sort_order`,
    [],
    executor,
  );
}

export type BusinessSeriesRow = {
  bucket: string;
  new_customers: number;
  new_subscriptions: number;
  revenue: string;
};

/*
  Deret waktu untuk dashboard bisnis.

  Ketiga deret dihitung dari satu query yang sama supaya ember waktunya pasti sejajar. Kalau
  masing-masing deret dihitung terpisah, ada kemungkinan satu ember muncul di satu deret tetapi
  tidak di deret lain, dan grafiknya jadi sulit dibaca.

  `date_trunc` dijalankan setelah konversi ke waktu Jakarta, bukan sebelumnya. Urutan itu yang
  membuat batas minggu dan bulan mengikuti kalender setempat.
*/
export async function businessSeries(
  period: DashboardPeriod,
  executor?: Queryable,
): Promise<BusinessSeriesRow[]> {
  const { start, endExclusive } = periodBounds(period);

  return query<BusinessSeriesRow>(
    `WITH buckets AS (
       SELECT generate_series(
         date_trunc($3, $1::date::timestamp),
         date_trunc($3, $2::date::timestamp),
         ('1 ' || $3)::interval
       ) AS bucket
     ),
     customer_series AS (
       SELECT date_trunc($3, created_at AT TIME ZONE 'Asia/Jakarta') AS bucket,
              count(*)::int AS n
       FROM customers
       WHERE created_at >= $1::date::timestamp AT TIME ZONE 'Asia/Jakarta'
         AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'
       GROUP BY 1
     ),
     subscription_series AS (
       SELECT date_trunc($3, created_at AT TIME ZONE 'Asia/Jakarta') AS bucket,
              count(*)::int AS n
       FROM subscriptions
       WHERE created_at >= $1::date::timestamp AT TIME ZONE 'Asia/Jakarta'
         AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'
       GROUP BY 1
     ),
     revenue_series AS (
       SELECT date_trunc($3, paid_at AT TIME ZONE 'Asia/Jakarta') AS bucket,
              sum(amount_paid)::text AS amount
       FROM invoices
       WHERE status = 'paid'
         AND paid_at >= $1::date::timestamp AT TIME ZONE 'Asia/Jakarta'
         AND paid_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'
       GROUP BY 1
     )
     SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket,
            COALESCE(c.n, 0)::int AS new_customers,
            COALESCE(s.n, 0)::int AS new_subscriptions,
            COALESCE(r.amount, '0') AS revenue
     FROM buckets b
     LEFT JOIN customer_series c ON c.bucket = b.bucket
     LEFT JOIN subscription_series s ON s.bucket = b.bucket
     LEFT JOIN revenue_series r ON r.bucket = b.bucket
     ORDER BY b.bucket`,
    [start, endExclusive, period.granularity],
    executor,
  );
}

export type FinanceMetrics = {
  revenue: { in_period: string; previous_period: string };
  receivables: {
    open_count: number;
    open_amount: string;
    past_due_count: number;
    past_due_amount: string;
  };
  refunds: { count: number; amount: string };
  payments: {
    settled_count: number;
    pending_count: number;
    failed_count: number;
    unverified_count: number;
  };
};

export async function financeMetrics(
  period: { from: string; to: string },
  executor?: Queryable,
): Promise<FinanceMetrics | null> {
  /*
    Periode pembanding dihitung dari panjang periode berjalan, bukan dari bulan kalender
    sebelumnya. Dengan begitu perbandingannya tetap adil meski rentangnya bukan satu bulan
    penuh, misalnya tujuh hari terakhir.
  */
  return queryOne<FinanceMetrics>(
    `WITH bounds AS (
       SELECT $1::date AS from_date,
              $2::date AS to_date,
              ($2::date - $1::date + 1) AS day_count
     ),
     revenue AS (
       SELECT
         COALESCE(sum(i.amount_paid) FILTER (
           WHERE i.paid_at >= b.from_date::timestamp AT TIME ZONE 'Asia/Jakarta'
             AND i.paid_at < (b.to_date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'
         ), 0)::text AS in_period,
         COALESCE(sum(i.amount_paid) FILTER (
           WHERE i.paid_at >= (b.from_date - b.day_count)::timestamp AT TIME ZONE 'Asia/Jakarta'
             AND i.paid_at < b.from_date::timestamp AT TIME ZONE 'Asia/Jakarta'
         ), 0)::text AS previous_period
       FROM bounds b
       LEFT JOIN invoices i ON i.status = 'paid'
     ),
     receivables AS (
       SELECT count(*) FILTER (WHERE status = 'open')::int AS open_count,
              COALESCE(sum(total_amount - amount_paid) FILTER (WHERE status = 'open'), 0)::text
                AS open_amount,
              count(*) FILTER (WHERE status = 'past_due')::int AS past_due_count,
              COALESCE(sum(total_amount - amount_paid) FILTER (WHERE status = 'past_due'), 0)::text
                AS past_due_amount
       FROM invoices
     ),
     refunds AS (
       SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::text AS amount
       FROM payment_refunds
       WHERE status = 'completed'
         AND completed_at >= $1::date::timestamp AT TIME ZONE 'Asia/Jakarta'
         AND completed_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'
     ),
     payments AS (
       SELECT count(*) FILTER (WHERE status = 'paid')::int AS settled_count,
              count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
              count(*) FILTER (WHERE status = 'failed')::int AS failed_count,
              /*
                Belum terverifikasi adalah ukuran sisa ketergantungan pada job rekonsiliasi.
                Angka ini yang menunjukkan berapa banyak pembayaran yang keyakinannya masih
                bersandar pada notifikasi yang tidak bertanda tangan.
              */
              count(*) FILTER (WHERE status = 'paid' AND verified_at IS NULL)::int
                AS unverified_count
       FROM payment_attempts
     )
     SELECT revenue.in_period AS revenue_in_period,
            revenue.previous_period AS revenue_previous_period,
            receivables.open_count, receivables.open_amount,
            receivables.past_due_count, receivables.past_due_amount,
            refunds.n AS refund_count, refunds.amount AS refund_amount,
            payments.settled_count, payments.pending_count, payments.failed_count,
            payments.unverified_count
     FROM revenue, receivables, refunds, payments`,
    [period.from, period.to],
    executor,
  ).then((row) => {
    if (!row) return null;
    const raw = row as unknown as Record<string, number | string>;
    return {
      revenue: {
        in_period: String(raw.revenue_in_period),
        previous_period: String(raw.revenue_previous_period),
      },
      receivables: {
        open_count: Number(raw.open_count),
        open_amount: String(raw.open_amount),
        past_due_count: Number(raw.past_due_count),
        past_due_amount: String(raw.past_due_amount),
      },
      refunds: { count: Number(raw.refund_count), amount: String(raw.refund_amount) },
      payments: {
        settled_count: Number(raw.settled_count),
        pending_count: Number(raw.pending_count),
        failed_count: Number(raw.failed_count),
        unverified_count: Number(raw.unverified_count),
      },
    };
  });
}

/*
  Perubahan pendapatan antar periode.

  Mengembalikan null bila periode pembandingnya nol. Pertumbuhan dari nol tidak punya
  persentase yang bermakna: tanpa aturan ini, kenaikan dari nol ke seratus rupiah akan terbaca
  sebagai pertumbuhan tak terhingga, dan itu bukan informasi melainkan gangguan.
*/
export function revenueChangePercent(
  inPeriod: string,
  previousPeriod: string,
): number | null {
  const current = Number(inPeriod);
  const previous = Number(previousPeriod);
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export type OperationsMetrics = {
  provider: {
    inbound_webhook_count: number;
    inbound_verified_count: number;
    inbound_rejected_count: number;
    inbound_unknown_order_count: number;
    inbound_pending_count: number;
    outbound_call_count: number;
    outbound_failed_count: number;
    outbound_p95_duration_ms: number | null;
  };
  jobs: {
    job_name: string;
    last_started_at: Date | null;
    last_finished_at: Date | null;
    last_outcome: string | null;
    expected_interval_minutes: number;
    is_stale: boolean;
    stuck_running: boolean;
  }[];
  claim_anomalies: { flagged_customers: number; flagged_ips: number; failed_attempts: number };
  admin_sessions: { active: number };
  period: { from: Date; to: Date };
};

/*
  Perkiraan selang antar jalan tiap job, dalam menit. Dipakai untuk menilai apakah sebuah job
  sudah tertinggal. Angka ini perkiraan operasional, bukan kontrak, sehingga yang penting bukan
  angkanya presisi melainkan ada pembanding yang membuat job berhenti terlihat.

  `reconcile_payments` adalah yang paling perlu diawasi karena ia pengaman utama pembayaran:
  notifikasi penyedia tidak bertanda tangan dan kebijakan ulangnya tidak terdokumentasi, jadi
  job inilah yang memastikan pembayaran tidak menggantung tanpa batas.
*/
const EXPECTED_INTERVAL_MINUTES: Record<string, number> = {
  reconcile_payments: 5,
  reprocess_webhooks: 10,
  expire_payment_attempts: 15,
  expire_invoices: 60,
  expire_subscriptions: 60,
  cleanup_idempotency_keys: 1440,
  cleanup_verification_codes: 1440,
};

export async function operationsMetrics(
  executor?: Queryable,
): Promise<OperationsMetrics | null> {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const [provider, jobs, anomalies, sessions] = await Promise.all([
    queryOne<Record<string, number>>(
      `SELECT
         (SELECT count(*) FROM payment_webhook_events WHERE created_at >= $1)::int
           AS inbound_webhook_count,
         (SELECT count(*) FROM payment_webhook_events
          WHERE created_at >= $1 AND processing_error IS NULL AND processed_at IS NOT NULL)::int
           AS inbound_verified_count,
         (SELECT count(*) FROM payment_webhook_events
          WHERE created_at >= $1 AND processing_error IS NOT NULL
            AND payment_attempt_id IS NOT NULL)::int AS inbound_rejected_count,
         (SELECT count(*) FROM payment_webhook_events
          WHERE created_at >= $1 AND processing_error IS NOT NULL
            AND payment_attempt_id IS NULL)::int AS inbound_unknown_order_count,
         (SELECT count(*) FROM payment_webhook_events
          WHERE created_at >= $1 AND processing_error IS NULL AND processed_at IS NULL)::int
           AS inbound_pending_count,
         (SELECT count(*) FROM payment_provider_calls WHERE created_at >= $1)::int
           AS outbound_call_count,
         (SELECT count(*) FROM payment_provider_calls
          WHERE created_at >= $1 AND outcome = 'failed')::int AS outbound_failed_count,
         /*
           Persentil 95, bukan rata-rata. Rata-rata menyembunyikan satu panggilan yang
           menggantung lama, dan justru panggilan seperti itulah yang membuat pelanggan menutup
           halaman pembayarannya.
         */
         (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)
          FROM payment_provider_calls WHERE created_at >= $1)::int AS outbound_p95_duration_ms`,
      [startOfDay],
      executor,
    ),
    query<{
      job_name: string;
      last_started_at: Date | null;
      last_finished_at: Date | null;
      last_outcome: string | null;
      stuck_running: boolean;
    }>(
      `SELECT DISTINCT ON (job_name)
              job_name, started_at AS last_started_at, finished_at AS last_finished_at,
              outcome AS last_outcome,
              (outcome = 'running' AND started_at < now() - interval '1 hour') AS stuck_running
       FROM scheduled_job_runs
       ORDER BY job_name, started_at DESC`,
      [],
      executor,
    ),
    queryOne<{ flagged_customers: number; flagged_ips: number; failed_attempts: number }>(
      /*
        Ambang anomali klaim: lima percobaan gagal per pelanggan per jam, atau sepuluh per alamat
        IP per jam. Ambang ini sama dengan yang dipakai pembatasan percobaan klaim, sehingga
        yang terlihat di sini adalah pelanggaran batas yang benar-benar terjadi.
      */
      `WITH per_customer AS (
         SELECT customer_id
         FROM device_claim_attempts
         WHERE NOT success AND created_at >= now() - interval '1 hour'
           AND customer_id IS NOT NULL
         GROUP BY customer_id HAVING count(*) >= 5
       ),
       per_ip AS (
         SELECT ip_address
         FROM device_claim_attempts
         WHERE NOT success AND created_at >= now() - interval '1 hour'
           AND ip_address IS NOT NULL
         GROUP BY ip_address HAVING count(*) >= 10
       )
       SELECT (SELECT count(*) FROM per_customer)::int AS flagged_customers,
              (SELECT count(*) FROM per_ip)::int AS flagged_ips,
              (SELECT count(*) FROM device_claim_attempts
               WHERE NOT success AND created_at >= now() - interval '24 hours')::int
                AS failed_attempts`,
      [],
      executor,
    ),
    queryOne<{ active: number }>(
      `SELECT count(*)::int AS active FROM admin_sessions
       WHERE revoked_at IS NULL AND expires_at > now()`,
      [],
      executor,
    ),
  ]);

  if (!provider || !anomalies || !sessions) return null;

  const endOfDay = new Date(startOfDay);
  endOfDay.setHours(23, 59, 59, 999);

  return {
    provider: {
      inbound_webhook_count: Number(provider.inbound_webhook_count),
      inbound_verified_count: Number(provider.inbound_verified_count),
      inbound_rejected_count: Number(provider.inbound_rejected_count),
      inbound_unknown_order_count: Number(provider.inbound_unknown_order_count),
      inbound_pending_count: Number(provider.inbound_pending_count),
      outbound_call_count: Number(provider.outbound_call_count),
      outbound_failed_count: Number(provider.outbound_failed_count),
      outbound_p95_duration_ms:
        provider.outbound_p95_duration_ms === null
          ? null
          : Number(provider.outbound_p95_duration_ms),
    },
    jobs: jobs.map((job) => {
      const expected = EXPECTED_INTERVAL_MINUTES[job.job_name] ?? 60;
      /*
        Job dianggap tertinggal bila selesai terakhirnya sudah melewati dua kali selang yang
        diharapkan. Job yang belum pernah berjalan sama sekali juga tertinggal, karena tidak ada
        bukti ia pernah bekerja.
      */
      const isStale =
        job.last_finished_at === null ||
        Date.now() - job.last_finished_at.getTime() > expected * 2 * 60 * 1000;
      return {
        job_name: job.job_name,
        last_started_at: job.last_started_at,
        last_finished_at: job.last_finished_at,
        last_outcome: job.last_outcome,
        expected_interval_minutes: expected,
        is_stale: isStale,
        stuck_running: job.stuck_running,
      };
    }),
    claim_anomalies: {
      flagged_customers: Number(anomalies.flagged_customers),
      flagged_ips: Number(anomalies.flagged_ips),
      failed_attempts: Number(anomalies.failed_attempts),
    },
    admin_sessions: { active: Number(sessions.active) },
    period: { from: startOfDay, to: endOfDay },
  };
}

export type ActionQueueItem = {
  kind: string;
  severity: "high" | "medium" | "low";
  reference_id: string;
  reference_label: string | null;
  summary: string;
  occurred_at: Date;
  action_label: string;
  action_href: string;
};

/*
  Antrian tindakan.

  Isinya hal-hal yang menunggu keputusan manusia, bukan sekadar hal yang tidak normal. Setiap
  baris memuat alamat yang menuju langsung ke objeknya, sehingga bisa ditindaklanjuti tanpa
  pencarian tambahan.

  Urutan angkanya disengaja: pembayaran yang belum lolos verifikasi lebih dari lima belas menit
  ada di paling atas karena pelanggan sudah membayar dan belum menerima apa yang dibayarnya.
  Langganan yang akan berakhir ada di paling bawah karena masih ada waktu tiga hari.
*/
export async function actionQueue(
  limit = 50,
  executor?: Queryable,
): Promise<ActionQueueItem[]> {
  return query<ActionQueueItem>(
    `WITH unverified AS (
       SELECT 'unverified_payment' AS kind, 'high' AS severity,
              pa.id AS reference_id,
              COALESCE(i.invoice_number, pa.provider_order_id) AS reference_label,
              'Pembayaran belum lolos verifikasi selama ' ||
                floor(extract(epoch FROM now() - COALESCE(pa.paid_at, pa.created_at)) / 60)::text ||
                ' menit' AS summary,
              COALESCE(pa.paid_at, pa.created_at) AS occurred_at,
              'Periksa pembayaran' AS action_label,
              '/payments/' || pa.id::text AS action_href
       FROM payment_attempts pa
       JOIN invoices i ON i.id = pa.invoice_id
       WHERE pa.status = 'paid' AND pa.verified_at IS NULL
         AND pa.created_at < now() - interval '15 minutes'
     ),
     unknown_order AS (
       SELECT 'unknown_order_webhook' AS kind, 'high' AS severity,
              w.id AS reference_id,
              w.provider_order_id AS reference_label,
              'Notifikasi masuk untuk nomor pesanan yang tidak dikenal sistem' AS summary,
              w.created_at AS occurred_at,
              'Periksa log provider' AS action_label,
              '/provider-logs?order_id=' || COALESCE(w.provider_order_id, '') AS action_href
       FROM payment_webhook_events w
       WHERE w.processing_error IS NOT NULL AND w.payment_attempt_id IS NULL
     ),
     claim_anomaly AS (
       SELECT 'claim_anomaly' AS kind, 'medium' AS severity,
              a.customer_id AS reference_id,
              c.full_name AS reference_label,
              'Percobaan klaim gagal ' || count(*)::text || ' kali dalam satu jam' AS summary,
              max(a.created_at) AS occurred_at,
              'Periksa pelanggan' AS action_label,
              '/customers/' || a.customer_id::text AS action_href
       FROM device_claim_attempts a
       JOIN customers c ON c.id = a.customer_id
       WHERE NOT a.success AND a.customer_id IS NOT NULL
         AND a.created_at >= now() - interval '1 hour'
       GROUP BY a.customer_id, c.full_name
       HAVING count(*) >= 5
     ),
     past_due AS (
       SELECT 'past_due_invoice' AS kind, 'medium' AS severity,
              i.id AS reference_id,
              i.invoice_number AS reference_label,
              'Tagihan lewat jatuh tempo ' ||
                floor(extract(epoch FROM now() - i.due_at) / 86400)::text || ' hari' AS summary,
              i.due_at AS occurred_at,
              'Periksa tagihan' AS action_label,
              '/invoices/' || i.id::text AS action_href
       FROM invoices i
       WHERE i.status IN ('open', 'past_due') AND i.due_at IS NOT NULL AND i.due_at < now()
     ),
     expiring AS (
       SELECT 'expiring_subscription' AS kind, 'low' AS severity,
              s.id AS reference_id,
              c.full_name AS reference_label,
              'Langganan berakhir dalam ' ||
                ceil(extract(epoch FROM s.current_period_end - now()) / 86400)::text ||
                ' hari' AS summary,
              s.current_period_end AS occurred_at,
              'Periksa langganan' AS action_label,
              '/subscriptions/' || s.id::text AS action_href
       FROM subscriptions s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.status = 'active'
         AND s.current_period_end IS NOT NULL
         AND s.current_period_end > now()
         AND s.current_period_end <= now() + interval '3 days'
     )
     SELECT kind, severity, reference_id, reference_label, summary, occurred_at,
            action_label, action_href
     FROM (
       SELECT * FROM unverified
       UNION ALL SELECT * FROM unknown_order
       UNION ALL SELECT * FROM claim_anomaly
       UNION ALL SELECT * FROM past_due
       UNION ALL SELECT * FROM expiring
     ) semua
     ORDER BY
       CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       occurred_at
     LIMIT $1`,
    [limit],
    executor,
  );
}

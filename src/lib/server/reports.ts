import { query, type Queryable } from "./db";

/*
  Laporan.

  Setiap laporan mengirim `definition` berupa kalimat yang menyatakan bagaimana angkanya
  dihitung, dan kalimat itu wajib ditampilkan di layar. Angka pendapatan tanpa keterangan dasar
  perhitungan mudah disalahartikan: pembaca akan mengira itu uang yang masuk ke rekening,
  padahal di dalamnya belum diperhitungkan biaya layanan penyedia dan refund.

  Dua aturan yang mengikat seluruh berkas ini:

  - Semua pengelompokan memakai WIB, yaitu UTC+7. Pembayaran pukul 06.00 WIB tanggal 1 jatuh
    pada pukul 23.00 UTC tanggal terakhir bulan sebelumnya, sehingga pengelompokan UTC akan
    memindahkan transaksi itu ke bulan yang salah.
  - Penyebut yang kosong menghasilkan null, bukan nol. Tingkat klaim saat belum ada perangkat
    bukan nol persen, melainkan belum dapat dihitung.
*/

export { REPORT_TYPES, type ReportType } from "@/lib/report-labels";

import type { ReportType } from "@/lib/report-labels";
/*
  Deret pertumbuhan diambil dari modul dashboard, bukan dihitung ulang di sini. Angka pelanggan
  dan langganan baru pada laporan harus sama persis dengan grafik di dashboard, dan dua query
  terpisah untuk angka yang sama cepat atau lambat akan berbeda.
*/
import { businessSeries } from "./dashboard";

export type ReportColumn = { key: string; label: string; format?: "number" | "currency" | "text" };

export type ReportSummaryLine = {
  label: string;
  value: number | null;
  format: "number" | "currency" | "text";
};

export type ReportPayload = {
  type: ReportType;
  definition: string;
  period: { from: string; to: string };
  summary: ReportSummaryLine[];
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, unknown>;
  /*
    Catatan tambahan yang menerangkan keadaan yang tidak terbaca dari angka, misalnya bahwa
    penyebutnya kosong. Dikirim terpisah supaya halaman tidak perlu menebak dari angka nol.
  */
  notes: string[];
};

const BOUNDS = `
  $1::date::timestamp AT TIME ZONE 'Asia/Jakarta' AS start_at,
  ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta' AS end_at
`;

type Ctx = { from: string; to: string; granularity: "day" | "week" | "month" };

/*
  Pendapatan.

  Dasar kas: diakui pada `invoices.paid_at`, bukan `created_at` dan bukan `issued_at`. Nilainya
  `invoices.amount_paid`, yaitu jumlah tagihan tanpa biaya layanan penyedia. Memakai
  `provider_total_payment` akan melebihkan angka dan tidak akan pernah cocok dengan mutasi
  rekening setelah dipotong biaya.
*/
async function revenue(ctx: Ctx, executor?: Queryable): Promise<Omit<ReportPayload, "type" | "period">> {
  const rows = await query<{
    bucket: string;
    invoice_count: number;
    amount: string;
    average_amount: string;
  }>(
    `WITH bounds AS (SELECT ${BOUNDS}),
     paid AS (
       SELECT date_trunc($3, i.paid_at AT TIME ZONE 'Asia/Jakarta') AS bucket,
              i.amount_paid
       FROM invoices i
       CROSS JOIN bounds
       WHERE i.status = 'paid'
         AND i.paid_at >= bounds.start_at AND i.paid_at < bounds.end_at
     )
     SELECT to_char(bucket, 'YYYY-MM-DD') AS bucket,
            count(*)::int AS invoice_count,
            sum(amount_paid)::text AS amount,
            (sum(amount_paid) / NULLIF(count(*), 0))::numeric(14,2)::text AS average_amount
     FROM paid GROUP BY bucket ORDER BY bucket`,
    [ctx.from, ctx.to, ctx.granularity],
    executor,
  );

  const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
  const count = rows.reduce((sum, row) => sum + row.invoice_count, 0);

  return {
    definition:
      "Pendapatan diakui pada tanggal pembayaran diterima (invoices.paid_at), bukan tanggal " +
      "tagihan diterbitkan. Nilainya invoices.amount_paid, yaitu jumlah tagihan tanpa biaya " +
      "layanan penyedia pembayaran. Semua pengelompokan memakai waktu Jakarta.",
    summary: [
      { label: "Total pendapatan", value: total, format: "currency" },
      { label: "Jumlah tagihan lunas", value: count, format: "number" },
      {
        label: "Rata-rata per tagihan",
        /* Penyebut kosong berarti belum dapat dihitung, bukan nol. */
        value: count === 0 ? null : Math.round((total / count) * 100) / 100,
        format: "currency",
      },
    ],
    columns: [
      { key: "bucket", label: "Periode", format: "text" },
      { key: "invoice_count", label: "Jumlah tagihan", format: "number" },
      { key: "amount", label: "Pendapatan", format: "currency" },
      { key: "average_amount", label: "Rata-rata per tagihan", format: "currency" },
    ],
    rows: rows.map((row) => ({
      bucket: row.bucket,
      invoice_count: row.invoice_count,
      amount: row.amount,
      average_amount: row.average_amount,
    })),
    totals: { invoice_count: count, amount: String(total) },
    notes:
      count === 0
        ? ["Belum ada pembayaran yang diterima pada periode ini, sehingga pendapatannya nol."]
        : [],
  };
}

/*
  Piutang.

  Dua kelompok dipisah karena penanganannya berbeda: tagihan yang belum jatuh tempo masih dalam
  masa tunggu, sedangkan yang lewat jatuh tempo sudah menuntut penagihan. Menggabungkannya
  menjadi satu angka "belum tertagih" akan menyembunyikan mana yang perlu ditindaklanjuti hari
  ini.
*/
async function receivables(
  ctx: Ctx,
  executor?: Queryable,
): Promise<Omit<ReportPayload, "type" | "period">> {
  const rows = await query<{
    id: string;
    invoice_number: string | null;
    customer_name: string | null;
    status: string;
    total_amount: string;
    amount_paid: string;
    outstanding: string;
    due_at: Date | null;
    days_past_due: number | null;
  }>(
    `WITH bounds AS (SELECT ${BOUNDS})
     SELECT i.id, i.invoice_number, c.full_name AS customer_name, i.status,
            i.total_amount::text, i.amount_paid::text,
            (i.total_amount - i.amount_paid)::text AS outstanding,
            i.due_at,
            CASE WHEN i.due_at < now()
                 THEN floor(extract(epoch FROM now() - i.due_at) / 86400)::int
                 ELSE NULL END AS days_past_due
     FROM invoices i
     CROSS JOIN bounds
     LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.status IN ('open', 'past_due')
       AND i.created_at >= bounds.start_at AND i.created_at < bounds.end_at
     ORDER BY i.due_at NULLS LAST, i.created_at`,
    [ctx.from, ctx.to],
    executor,
  );

  const openRows = rows.filter((row) => row.status === "open");
  const pastDueRows = rows.filter((row) => row.status === "past_due");
  const sum = (list: typeof rows) =>
    list.reduce((total, row) => total + Number(row.outstanding), 0);

  return {
    definition:
      "Piutang dihitung dari sisa tagihan, yaitu jumlah tagihan dikurangi yang sudah dibayar. " +
      "Hanya tagihan berstatus belum dibayar dan lewat jatuh tempo yang masuk. Tagihan yang " +
      "sudah dibatalkan atau dinyatakan tidak tertagih tidak lagi menuntut pembayaran.",
    summary: [
      { label: "Tagihan belum jatuh tempo", value: openRows.length, format: "number" },
      { label: "Nilai belum jatuh tempo", value: sum(openRows), format: "currency" },
      { label: "Tagihan lewat jatuh tempo", value: pastDueRows.length, format: "number" },
      { label: "Nilai lewat jatuh tempo", value: sum(pastDueRows), format: "currency" },
      { label: "Total piutang", value: sum(rows), format: "currency" },
    ],
    columns: [
      { key: "invoice_number", label: "Nomor tagihan", format: "text" },
      { key: "customer_name", label: "Pelanggan", format: "text" },
      { key: "status", label: "Status", format: "text" },
      { key: "total_amount", label: "Jumlah tagihan", format: "currency" },
      { key: "amount_paid", label: "Sudah dibayar", format: "currency" },
      { key: "outstanding", label: "Sisa tagihan", format: "currency" },
      { key: "due_at", label: "Jatuh tempo", format: "text" },
      { key: "days_past_due", label: "Hari terlambat", format: "number" },
    ],
    rows: rows.map((row) => ({
      invoice_number: row.invoice_number,
      customer_name: row.customer_name,
      status: row.status,
      total_amount: row.total_amount,
      amount_paid: row.amount_paid,
      outstanding: row.outstanding,
      due_at: row.due_at?.toISOString() ?? null,
      days_past_due: row.days_past_due,
    })),
    totals: {
      open_count: openRows.length,
      open_amount: String(sum(openRows)),
      past_due_count: pastDueRows.length,
      past_due_amount: String(sum(pastDueRows)),
      outstanding_amount: String(sum(rows)),
    },
    notes:
      rows.length === 0
        ? ["Tidak ada tagihan yang menunggu pembayaran pada periode ini."]
        : [],
  };
}

/*
  Langganan.

  Churn dihitung dari langganan berbayar yang berakhir sebagai kedaluwarsa lebih dari tujuh
  hari lalu. Ambang tujuh hari memisahkan pelanggan yang benar-benar pergi dari yang hanya
  terlambat membayar; tanpa ambang itu setiap pelanggan yang membayar sehari lewat tenggat akan
  terhitung berhenti.
*/
async function subscriptionsReport(
  ctx: Ctx,
  executor?: Queryable,
): Promise<Omit<ReportPayload, "type" | "period">> {
  const [byPlan, movements, churn] = await Promise.all([
    query<{
      plan_name: string;
      is_free: boolean;
      active_count: number;
      cancelled_in_period: number;
      expired_in_period: number;
    }>(
      `WITH bounds AS (SELECT ${BOUNDS})
       SELECT p.name AS plan_name, p.is_free,
              count(s.id) FILTER (WHERE s.status = 'active')::int AS active_count,
              count(s.id) FILTER (
                WHERE s.status = 'canceled'
                  AND s.canceled_at >= bounds.start_at AND s.canceled_at < bounds.end_at
              )::int AS cancelled_in_period,
              count(s.id) FILTER (
                WHERE s.status = 'expired'
                  AND s.current_period_end >= bounds.start_at
                  AND s.current_period_end < bounds.end_at
              )::int AS expired_in_period
       FROM subscription_plans p
       LEFT JOIN subscriptions s ON s.plan_id = p.id
       CROSS JOIN bounds
       GROUP BY p.id, p.name, p.is_free, p.sort_order
       ORDER BY p.sort_order`,
      [ctx.from, ctx.to],
      executor,
    ),
    query<{
      event_type: string;
      jumlah: number;
    }>(
      `WITH bounds AS (SELECT ${BOUNDS})
       SELECT e.event_type, count(*)::int AS jumlah
       FROM subscription_events e, bounds
       WHERE e.created_at >= bounds.start_at AND e.created_at < bounds.end_at
       GROUP BY e.event_type ORDER BY e.event_type`,
      [ctx.from, ctx.to],
      executor,
    ),
    query<{ jumlah: number }>(
      `WITH bounds AS (SELECT ${BOUNDS})
       SELECT count(*)::int AS jumlah
       FROM subscriptions s, bounds
       CROSS JOIN subscription_plans p
       WHERE s.plan_id = p.id AND p.is_free = false
         AND s.status = 'expired'
         AND s.current_period_end >= bounds.start_at
         AND s.current_period_end < bounds.end_at
         AND s.current_period_end < now() - interval '7 days'`,
      [ctx.from, ctx.to],
      executor,
    ),
  ]);

  const activeTotal = byPlan.reduce((total, row) => total + row.active_count, 0);
  const cancelled = byPlan.reduce((total, row) => total + row.cancelled_in_period, 0);
  const churnCount = churn[0]?.jumlah ?? 0;
  /*
    Tingkat churn adalah pembagian dengan penyebut yang bisa kosong. Saat belum ada langganan
    berbayar aktif, angkanya belum dapat dihitung, bukan nol persen.
  */
  const churnBase = byPlan
    .filter((row) => !row.is_free)
    .reduce((total, row) => total + row.active_count, 0);

  return {
    definition:
      "Jumlah langganan dihitung menurut statusnya saat laporan dibuat. Berhenti berlangganan " +
      "dihitung dari langganan berbayar yang berakhir sebagai kedaluwarsa lebih dari tujuh hari " +
      "lalu, supaya pelanggan yang hanya terlambat membayar tidak ikut terhitung.",
    summary: [
      { label: "Langganan aktif", value: activeTotal, format: "number" },
      { label: "Langganan aktif berbayar", value: churnBase, format: "number" },
      { label: "Dibatalkan pada periode ini", value: cancelled, format: "number" },
      { label: "Berhenti berlangganan", value: churnCount, format: "number" },
      {
        label: "Tingkat berhenti",
        /* Belum dapat dihitung bila belum ada langganan berbayar, bukan nol persen. */
        value:
          churnBase === 0 ? null : Math.round((churnCount / churnBase) * 1000) / 10,
        format: "number",
      },
    ],
    columns: [
      { key: "plan_name", label: "Paket", format: "text" },
      { key: "active_count", label: "Aktif", format: "number" },
      { key: "cancelled_in_period", label: "Dibatalkan", format: "number" },
      { key: "expired_in_period", label: "Berakhir", format: "number" },
    ],
    rows: byPlan.map((row) => ({
      plan_name: row.plan_name,
      active_count: row.active_count,
      cancelled_in_period: row.cancelled_in_period,
      expired_in_period: row.expired_in_period,
    })),
    totals: {
      active_count: activeTotal,
      cancelled_in_period: cancelled,
      expired_in_period: byPlan.reduce((total, row) => total + row.expired_in_period, 0),
    },
    notes: [
      churnBase === 0
        ? "Tingkat berhenti belum dapat dihitung karena belum ada langganan berbayar aktif."
        : "Tingkat berhenti dihitung terhadap jumlah langganan berbayar aktif.",
      `Pergerakan langganan pada periode ini: ${
        movements.length === 0
          ? "belum ada"
          : movements.map((row) => `${row.event_type} ${row.jumlah}`).join(", ")
      }.`,
    ],
  };
}

/*
  Perangkat.

  Tingkat klaim memakai seluruh perangkat yang pernah didaftarkan sebagai penyebut, bukan hanya
  yang masih tersedia. Tingkat klaim yang dihitung dari stok tersisa akan selalu terlihat tinggi
  ketika stok hampir habis, dan itu menyesatkan: yang ingin diketahui adalah berapa bagian dari
  perangkat yang dibeli yang sudah terpasang di pelanggan.
*/
async function devicesReport(
  ctx: Ctx,
  executor?: Queryable,
): Promise<Omit<ReportPayload, "type" | "period">> {
  const [byModel, totals] = await Promise.all([
    query<{
      model: string;
      registered_in_period: number;
      in_stock: number;
      claimed: number;
      suspended: number;
      total: number;
      claim_rate_percent: number | null;
    }>(
      `WITH bounds AS (SELECT ${BOUNDS})
       SELECT COALESCE(d.model, 'Model tidak dicatat') AS model,
              count(*) FILTER (
                WHERE d.created_at >= bounds.start_at AND d.created_at < bounds.end_at
              )::int AS registered_in_period,
              count(*) FILTER (WHERE d.status = 'in_stock')::int AS in_stock,
              count(*) FILTER (WHERE d.status = 'claimed')::int AS claimed,
              count(*) FILTER (WHERE d.status = 'suspended')::int AS suspended,
              count(*)::int AS total,
              /*
                Tingkat klaim dihitung di SQL dengan pembagi yang dijaga NULLIF, sehingga
                penyebut kosong menghasilkan NULL dan bukan galat pembagian nol.
              */
              round(100.0 * count(*) FILTER (WHERE d.status = 'claimed')
                    / NULLIF(count(*), 0), 1)::float8 AS claim_rate_percent
       FROM devices d CROSS JOIN bounds
       GROUP BY COALESCE(d.model, 'Model tidak dicatat')
       ORDER BY count(*) DESC, model`,
      [ctx.from, ctx.to],
      executor,
    ),
    query<{
      registered_in_period: number;
      in_stock: number;
      claimed: number;
      suspended: number;
      total: number;
    }>(
      `WITH bounds AS (SELECT ${BOUNDS})
       SELECT count(*) FILTER (
                WHERE d.created_at >= bounds.start_at AND d.created_at < bounds.end_at
              )::int AS registered_in_period,
              count(*) FILTER (WHERE d.status = 'in_stock')::int AS in_stock,
              count(*) FILTER (WHERE d.status = 'claimed')::int AS claimed,
              count(*) FILTER (WHERE d.status = 'suspended')::int AS suspended,
              count(*)::int AS total
       FROM devices d CROSS JOIN bounds`,
      [ctx.from, ctx.to],
      executor,
    ),
  ]);

  const total = totals[0] ?? {
    registered_in_period: 0,
    in_stock: 0,
    claimed: 0,
    suspended: 0,
    total: 0,
  };

  return {
    definition:
      "Tingkat klaim adalah bagian perangkat yang sudah terpasang di pelanggan dibandingkan " +
      "seluruh perangkat yang pernah didaftarkan. Perangkat yang sudah tidak dipakai pelanggan " +
      "tetap dihitung sebagai pernah diklaim, karena yang diukur adalah seberapa banyak " +
      "perangkat yang dibeli berhasil sampai ke pelanggan.",
    summary: [
      { label: "Perangkat terdaftar", value: total.total, format: "number" },
      { label: "Terpasang di pelanggan", value: total.claimed, format: "number" },
      { label: "Masih tersedia", value: total.in_stock, format: "number" },
      { label: "Ditangguhkan", value: total.suspended, format: "number" },
      {
        label: "Tingkat klaim",
        /* Belum ada perangkat berarti belum dapat dihitung, bukan nol persen. */
        value:
          total.total === 0
            ? null
            : Math.round((total.claimed / total.total) * 1000) / 10,
        format: "number",
      },
    ],
    columns: [
      { key: "model", label: "Model", format: "text" },
      { key: "registered_in_period", label: "Terdaftar pada periode", format: "number" },
      { key: "total", label: "Total", format: "number" },
      { key: "claimed", label: "Terpasang", format: "number" },
      { key: "in_stock", label: "Tersedia", format: "number" },
      { key: "suspended", label: "Ditangguhkan", format: "number" },
      { key: "claim_rate_percent", label: "Tingkat klaim", format: "number" },
    ],
    rows: byModel.map((row) => ({
      model: row.model,
      registered_in_period: row.registered_in_period,
      total: row.total,
      claimed: row.claimed,
      in_stock: row.in_stock,
      suspended: row.suspended,
      claim_rate_percent: row.claim_rate_percent,
    })),
    totals: {
      registered_in_period: total.registered_in_period,
      total: total.total,
      claimed: total.claimed,
      in_stock: total.in_stock,
      suspended: total.suspended,
    },
    notes:
      total.total === 0
        ? ["Belum ada perangkat yang terdaftar, sehingga tingkat klaim belum dapat dihitung."]
        : [
            "Tingkat klaim memakai seluruh perangkat terdaftar sebagai penyebut, bukan hanya " +
              "yang masih tersedia.",
          ],
  };
}

/*
  Anomali.

  Isinya percobaan klaim yang gagal dan notifikasi pembayaran yang tidak lolos pemeriksaan. Ini
  laporan yang paling perlu dibaca saat mencurigai ada penyalahgunaan, karena keduanya adalah
  jalur masuk yang paling lemah pengawasannya: nomor seri perangkat bisa ditebak, dan notifikasi
  penyedia pembayaran tidak bertanda tangan.
*/
async function anomalies(
  ctx: Ctx,
  executor?: Queryable,
): Promise<Omit<ReportPayload, "type" | "period">> {
  const [claims, webhooks] = await Promise.all([
    query<{
      id: string;
      created_at: Date;
      submitted_kind: string;
      submitted_value_masked: string | null;
      failure_reason: string | null;
      customer_name: string | null;
      ip_address: string | null;
    }>(
      `WITH bounds AS (SELECT ${BOUNDS})
       SELECT a.id, a.created_at, a.submitted_kind, a.submitted_value_masked,
              a.failure_reason, c.full_name AS customer_name, host(a.ip_address) AS ip_address
       FROM device_claim_attempts a
       CROSS JOIN bounds
       LEFT JOIN customers c ON c.id = a.customer_id
       WHERE NOT a.success
         AND a.created_at >= bounds.start_at AND a.created_at < bounds.end_at
       ORDER BY a.created_at DESC
       LIMIT 5000`,
      [ctx.from, ctx.to],
      executor,
    ),
    query<{
      id: string;
      created_at: Date;
      provider_order_id: string | null;
      provider_status: string | null;
      processing_error: string | null;
      ip_address: string | null;
    }>(
      `WITH bounds AS (SELECT ${BOUNDS})
       SELECT w.id, w.created_at, w.provider_order_id, w.provider_status, w.processing_error,
              host(w.ip_address) AS ip_address
       FROM payment_webhook_events w
       CROSS JOIN bounds
       WHERE w.processing_error IS NOT NULL
         AND w.created_at >= bounds.start_at AND w.created_at < bounds.end_at
       ORDER BY w.created_at DESC
       LIMIT 5000`,
      [ctx.from, ctx.to],
      executor,
    ),
  ]);

  const unknownOrder = webhooks.filter((row) => row.processing_error?.includes("tidak dikenal"));

  return {
    definition:
      "Anomali adalah percobaan klaim perangkat yang gagal dan notifikasi pembayaran yang tidak " +
      "lolos pemeriksaan. Keduanya adalah jalur masuk yang paling lemah pengawasannya: nomor " +
      "seri perangkat bisa ditebak, dan notifikasi penyedia pembayaran tidak bertanda tangan " +
      "sehingga isinya tidak dapat dipercaya begitu saja.",
    summary: [
      { label: "Percobaan klaim gagal", value: claims.length, format: "number" },
      {
        label: "Pelanggan terdampak",
        value: new Set(claims.map((row) => row.customer_name).filter(Boolean)).size,
        format: "number",
      },
      {
        label: "Alamat IP berbeda",
        value: new Set(claims.map((row) => row.ip_address).filter(Boolean)).size,
        format: "number",
      },
      { label: "Notifikasi tidak lolos", value: webhooks.length, format: "number" },
      { label: "Nomor pesanan tidak dikenal", value: unknownOrder.length, format: "number" },
    ],
    columns: [
      { key: "occurred_at", label: "Waktu", format: "text" },
      { key: "source", label: "Sumber", format: "text" },
      { key: "detail", label: "Keterangan", format: "text" },
      { key: "account", label: "Pelanggan", format: "text" },
      { key: "ip_address", label: "Alamat IP", format: "text" },
      { key: "reason", label: "Alasan", format: "text" },
    ],
    rows: [
      ...claims.map((row) => ({
        occurred_at: row.created_at.toISOString(),
        source: "Klaim perangkat",
        detail: `${row.submitted_kind === "qr" ? "Kode QR" : "Nomor seri"} ${
          row.submitted_value_masked ?? "tidak tercatat"
        }`,
        account: row.customer_name,
        ip_address: row.ip_address,
        reason: row.failure_reason,
      })),
      ...webhooks.map((row) => ({
        occurred_at: row.created_at.toISOString(),
        source: "Notifikasi pembayaran",
        detail: row.provider_order_id ?? "Nomor pesanan tidak dicatat",
        account: null,
        ip_address: row.ip_address,
        reason: row.processing_error,
      })),
    ].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))),
    totals: {
      failed_claims: claims.length,
      rejected_webhooks: webhooks.length,
      unknown_order_webhooks: unknownOrder.length,
    },
    notes: [
      "Catatan anomali dibatasi 5.000 baris per sumber. Bila ada lebih banyak, perpendek " +
        "rentang tanggalnya.",
      "Nilai yang dikirim pelanggan disimpan tersamarkan, sehingga nomor seri atau kode klaim " +
        "yang dicoba tidak pernah muncul apa adanya di laporan ini.",
    ],
  };
}

/*
  Refund.

  Dasar kas, sama seperti pendapatan: refund diakui pada tanggal penyedia menyelesaikannya
  (`payment_refunds.completed_at`), bukan mundur ke periode tagihan asalnya. Karena itu laporan
  periode lampau tidak pernah berubah angkanya setelah dilaporkan.

  Refund yang belum selesai tidak dihitung. Dana itu belum berpindah, dan mengakuinya lebih awal
  akan membuat laporan pengembalian dana terlihat lebih besar daripada kenyataannya.
*/
async function refundsReport(
  ctx: Ctx,
  executor?: Queryable,
): Promise<Omit<ReportPayload, "type" | "period">> {
  const rows = await query<{
    bucket: string;
    refund_count: number;
    amount: string;
    reason: string;
    customer_name: string | null;
    invoice_number: string | null;
  }>(
    `WITH bounds AS (SELECT ${BOUNDS})
     SELECT to_char(date_trunc($3, r.completed_at AT TIME ZONE 'Asia/Jakarta'), 'YYYY-MM-DD')
              AS bucket,
            count(*)::int AS refund_count,
            sum(r.amount)::text AS amount,
            min(r.reason) AS reason,
            min(c.full_name) AS customer_name,
            min(i.invoice_number) AS invoice_number
     FROM payment_refunds r
     CROSS JOIN bounds
     JOIN payment_attempts pa ON pa.id = r.payment_attempt_id
     JOIN invoices i ON i.id = pa.invoice_id
     LEFT JOIN customers c ON c.id = i.customer_id
     WHERE r.status = 'completed'
       AND r.completed_at >= bounds.start_at AND r.completed_at < bounds.end_at
     GROUP BY date_trunc($3, r.completed_at AT TIME ZONE 'Asia/Jakarta')
     ORDER BY 1`,
    [ctx.from, ctx.to, ctx.granularity],
    executor,
  );

  const [pending] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment_refunds WHERE status = 'pending'`,
    [],
    executor,
  );

  const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
  const count = rows.reduce((sum, row) => sum + row.refund_count, 0);

  return {
    definition:
      "Refund diakui pada tanggal penyedia menyelesaikannya (payment_refunds.completed_at), " +
      "bukan pada tanggal tagihan asalnya diterbitkan. Karena dasar kas, laporan periode yang " +
      "sudah lewat tidak berubah angkanya. Refund yang belum selesai belum dihitung.",
    summary: [
      { label: "Total refund", value: total, format: "currency" },
      { label: "Jumlah refund", value: count, format: "number" },
      { label: "Refund belum selesai", value: pending?.n ?? 0, format: "number" },
    ],
    columns: [
      { key: "bucket", label: "Periode", format: "text" },
      { key: "refund_count", label: "Jumlah refund", format: "number" },
      { key: "amount", label: "Nilai refund", format: "currency" },
    ],
    rows: rows.map((row) => ({
      bucket: row.bucket,
      refund_count: row.refund_count,
      amount: row.amount,
    })),
    totals: { refund_count: count, amount: String(total) },
    notes: [
      ...(pending && pending.n > 0
        ? [
            `Ada ${pending.n} catatan refund yang belum ditandai selesai dan karenanya belum ` +
              `dihitung di sini. Perbarui statusnya di halaman pembayaran agar masuk laporan.`,
          ]
        : []),
      "Alasan tiap refund tidak ditampilkan per periode karena satu periode bisa memuat " +
        "beberapa alasan berbeda. Alasan lengkapnya ada di halaman detail tiap pembayaran.",
    ],
  };
}

/*
  Pertumbuhan.

  Berisi rincian per periode dari grafik pelanggan dan langganan baru di dashboard. Dashboard
  hanya menampilkan bentuk grafiknya; yang membutuhkan angka tiap periode ada di sini.

  Deretnya diambil dari fungsi yang sama dengan yang mengisi dashboard (`businessSeries`), bukan
  query baru. Dua query terpisah untuk angka yang sama cepat atau lambat akan berbeda, dan
  pembaca yang menemukan selisih antara dashboard dan laporan berhenti mempercayai keduanya.
*/
async function growth(
  ctx: Ctx,
  executor?: Queryable,
): Promise<Omit<ReportPayload, "type" | "period">> {
  const rows = await businessSeries(
    { from: ctx.from, to: ctx.to, granularity: ctx.granularity },
    executor,
  );

  const totalPelanggan = rows.reduce((jumlah, row) => jumlah + row.new_customers, 0);
  const totalLangganan = rows.reduce((jumlah, row) => jumlah + row.new_subscriptions, 0);
  const periodeAda = rows.filter(
    (row) => row.new_customers > 0 || row.new_subscriptions > 0,
  ).length;

  return {
    definition:
      "Pelanggan baru dihitung dari tanggal pelanggan mendaftar (customers.created_at), dan " +
      "langganan baru dari tanggal langganannya mulai (subscriptions.created_at). Keduanya " +
      "dikelompokkan memakai batas hari waktu Jakarta, sehingga pendaftaran tengah malam tidak " +
      "berpindah ke tanggal yang salah. Pelanggan yang berhenti tidak dikurangkan di sini; yang " +
      "diukur adalah berapa yang masuk pada tiap periode.",
    summary: [
      { label: "Pelanggan baru", value: totalPelanggan, format: "number" },
      { label: "Langganan baru", value: totalLangganan, format: "number" },
      {
        label: "Periode yang ada isinya",
        value: periodeAda,
        format: "number",
      },
      {
        label: "Rata-rata pelanggan baru per periode",
        /*
          Penyebut kosong berarti belum dapat dihitung, bukan nol. Rentang tanpa satu pun
          periode akan menghasilkan pembagian dengan nol.

          Dua angka di belakang koma, bukan satu. Pada laporan harian, satu pelanggan baru dalam
          tiga puluh hari menghasilkan 0,03; pembulatan ke satu angka desimal mengubahnya menjadi
          nol, dan nol terbaca sebagai "tidak ada pelanggan baru" padahal ada satu.
        */
        value:
          rows.length === 0 ? null : Math.round((totalPelanggan / rows.length) * 100) / 100,
        format: "number",
      },
    ],
    columns: [
      { key: "bucket", label: "Periode", format: "text" },
      { key: "new_customers", label: "Pelanggan baru", format: "number" },
      { key: "new_subscriptions", label: "Langganan baru", format: "number" },
      {
        key: "conversion_percent",
        label: "Rasio langganan per pelanggan",
        format: "number",
      },
    ],
    rows: rows.map((row) => ({
      bucket: row.bucket,
      new_customers: row.new_customers,
      new_subscriptions: row.new_subscriptions,
      /*
        Rasio dihitung per periode. Periode tanpa pelanggan baru menghasilkan null, bukan nol,
        karena tidak ada yang bisa dibagi. Nol di situ akan terbaca sebagai "tidak ada yang
        berlangganan", padahal artinya "tidak ada pelanggan baru untuk dibagi".
      */
      conversion_percent:
        row.new_customers === 0
          ? null
          : Math.round((row.new_subscriptions / row.new_customers) * 1000) / 10,
    })),
    totals: {
      new_customers: totalPelanggan,
      new_subscriptions: totalLangganan,
    },
    notes: [
      totalPelanggan === 0 && totalLangganan === 0
        ? "Belum ada pelanggan maupun langganan baru pada rentang ini, sehingga seluruh periode bernilai nol."
        : "Rasio langganan per pelanggan dihitung dari pelanggan baru pada periode yang sama, bukan dari seluruh pelanggan yang pernah terdaftar.",
      "Pelanggan yang mendaftar tanpa langsung berlangganan tetap dihitung sebagai pelanggan baru, sehingga rasio ini bisa lebih kecil dari seratus persen.",
    ],
  };
}

const BUILDERS: Record<
  ReportType,
  (ctx: Ctx, executor?: Queryable) => Promise<Omit<ReportPayload, "type" | "period">>
> = {
  revenue,
  growth,
  receivables,
  subscriptions: subscriptionsReport,
  devices: devicesReport,
  anomalies,
  refunds: refundsReport,
};

export function reportNeedsGranularity(type: ReportType): boolean {
  return type === "revenue" || type === "refunds" || type === "growth";
}

export async function buildReport(
  type: ReportType,
  ctx: Ctx,
  executor?: Queryable,
): Promise<ReportPayload> {
  const body = await BUILDERS[type](ctx, executor);
  return { type, period: { from: ctx.from, to: ctx.to }, ...body };
}

/*
  Batas baris untuk ekspor. Isi CSV dan isi layar dihitung dari fungsi yang sama, sehingga
  angkanya tidak pernah berbeda. Yang membedakan hanya batas barisnya, karena berkas CSV bisa
  dibuka di luar dan ukurannya perlu terkendali.
*/
export const MAX_EXPORT_ROWS = 50_000;

export async function countReportRows(
  type: ReportType,
  ctx: Ctx,
  executor?: Queryable,
): Promise<number> {
  const report = await buildReport(type, ctx, executor);
  return report.rows.length;
}

import { query, queryOne, type Queryable } from "./db";

/*
  Data pembayaran untuk konsol admin.

  Halaman pembayaran menampilkan dua arah komunikasi dengan penyedia pembayaran, dan keduanya
  dibutuhkan untuk menjawab pertanyaan yang berbeda:

  1. `payment_attempts` menjawab "apa yang pelanggan lihat dan lakukan".
  2. `payment_webhook_events` menjawab "apa yang penyedia beritahukan kepada kita". Ini arah
     masuk.
  3. `payment_provider_calls` menjawab "apa yang kita tanyakan ke penyedia, dan apa jawabannya".
     Ini arah keluar.

  Tanpa ketiganya, integrasi yang bermasalah hanya bisa ditebak. Dengan ketiganya, pertanyaan
  "pelanggan bilang sudah bayar, kenapa tidak aktif" bisa dijawab sampai ke panggilan mana yang
  gagal dan pada detik berapa.

  Satu hal yang menjadi aturan tetap di seluruh berkas ini: `provider_total_payment` adalah yang
  dibayar pelanggan, tetapi yang dihitung sebagai pendapatan langganan hanya `amount`. Biaya
  layanan penyedia bukan pendapatan.
*/

export type PaymentListRow = {
  id: string;
  cursor_value: string;
  attempt_sequence: number;
  provider: string;
  payment_method: string | null;
  provider_order_id: string | null;
  amount: string;
  provider_fee: string | null;
  provider_total_payment: string | null;
  status: string;
  expires_at: Date | null;
  paid_at: Date | null;
  verified_at: Date | null;
  verified_via: string | null;
  created_at: Date;
  invoice_id: string;
  invoice_number: string | null;
  invoice_status: string;
  customer_id: string;
  customer_name: string | null;
};

export type PaymentFilter = {
  status?: string;
  invoiceId?: string;
  customerId?: string;
  q?: string;
  verifiedVia?: string;
  paidFrom?: string;
  paidTo?: string;
};

export function paymentFilterConditions(filter: PaymentFilter, params: unknown[]): string {
  const conditions: string[] = [];

  if (filter.status) {
    conditions.push(`AND pa.status = $${params.push(filter.status)}`);
  }

  if (filter.invoiceId) {
    conditions.push(`AND pa.invoice_id = $${params.push(filter.invoiceId)}::uuid`);
  }

  if (filter.customerId) {
    conditions.push(`AND i.customer_id = $${params.push(filter.customerId)}::uuid`);
  }

  if (filter.verifiedVia) {
    conditions.push(`AND pa.verified_via = $${params.push(filter.verifiedVia)}`);
  }

  /*
    Pencarian mencakup nomor pesanan karena itulah satu-satunya penanda yang ada di sisi
    penyedia pembayaran. Saat menelusuri masalah dengan penyedia, nomor inilah yang disebutkan,
    bukan nomor tagihan kita.
  */
  if (filter.q) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    conditions.push(
      `AND (pa.provider_order_id ILIKE $${params.push(pattern)}
            OR i.invoice_number ILIKE $${params.length}
            OR c.full_name ILIKE $${params.length})`,
    );
  }

  if (filter.paidFrom) {
    conditions.push(`AND pa.paid_at >= $${params.push(filter.paidFrom)}::timestamptz`);
  }

  if (filter.paidTo) {
    conditions.push(`AND pa.paid_at <= $${params.push(filter.paidTo)}::timestamptz`);
  }

  return conditions.join("\n          ");
}

export async function findPayment(
  paymentId: string,
  executor?: Queryable,
): Promise<PaymentListRow | null> {
  return queryOne<PaymentListRow>(
    `SELECT pa.id,
            pa.created_at::text AS cursor_value,
            pa.attempt_sequence,
            pa.provider,
            pa.payment_method,
            pa.provider_order_id,
            pa.amount::text,
            pa.provider_fee::text,
            pa.provider_total_payment::text,
            pa.status,
            pa.expires_at,
            pa.paid_at,
            pa.verified_at,
            pa.verified_via,
            pa.created_at,
            pa.invoice_id,
            i.invoice_number,
            i.status AS invoice_status,
            i.customer_id,
            c.full_name AS customer_name
     FROM payment_attempts pa
     JOIN invoices i ON i.id = pa.invoice_id
     LEFT JOIN customers c ON c.id = i.customer_id
     WHERE pa.id = $1`,
    [paymentId],
    executor,
  );
}

export type PaymentSummary = {
  total: number;
  pending: number;
  paid: number;
  expired: number;
  failed: number;
  canceled: number;
  unverified_paid: number;
};

/*
  `unverified_paid` adalah angka yang paling perlu diperhatikan di halaman ini: pembayaran yang
  berstatus lunas tetapi belum pernah dikonfirmasi ulang ke penyedia.

  Penyedia pembayaran dapat mengirim notifikasi berulang, dan notifikasi itu tidak bertanda
  tangan sehingga isinya tidak dapat dipercaya begitu saja. Pembayaran yang hanya bersandar pada
  notifikasi, tanpa pernah diperiksa ulang, adalah pembayaran yang keyakinannya lebih lemah
  daripada yang terlihat di daftar.
*/
export async function paymentSummary(executor?: Queryable): Promise<PaymentSummary | null> {
  return queryOne<PaymentSummary>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status = 'paid')::int AS paid,
            count(*) FILTER (WHERE status = 'expired')::int AS expired,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'canceled')::int AS canceled,
            count(*) FILTER (WHERE status = 'paid' AND verified_at IS NULL)::int AS unverified_paid
     FROM payment_attempts`,
    [],
    executor,
  );
}

/*
  Webhook yang masuk.

  Isinya ditampilkan apa adanya, termasuk payload mentahnya, karena payload itulah bukti satu-
  satunya tentang apa yang dikirim penyedia. Tidak ada kredensial di dalamnya, jadi tidak ada
  yang perlu disamarkan.

  Baris yang belum diproses adalah yang paling penting di sini. Baris seperti itu berarti ada
  pemberitahuan pembayaran yang belum tercermin di data kita, dan pelanggan bisa saja sudah
  membayar tanpa layanannya aktif.
*/
export async function webhookEvents(
  filter: {
    processed?: boolean;
    providerOrderId?: string;
    limit?: number;
    from?: string;
    to?: string;
    outcome?: "verified" | "rejected" | "unknown_order" | "pending";
  },
  executor?: Queryable,
): Promise<
  {
    id: string;
    provider: string;
    provider_event_id: string | null;
    provider_order_id: string | null;
    provider_status: string | null;
    event_type: string;
    payment_attempt_id: string | null;
    ip_address: string | null;
    user_agent: string | null;
    processed_at: Date | null;
    processing_error: string | null;
    payload: unknown;
    created_at: Date;
  }[]
> {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filter.processed === true) {
    conditions.push("AND w.processed_at IS NOT NULL");
  } else if (filter.processed === false) {
    conditions.push("AND w.processed_at IS NULL");
  }

  if (filter.providerOrderId) {
    conditions.push(`AND w.provider_order_id = $${params.push(filter.providerOrderId)}`);
  }

  /*
    Batas waktu memakai waktu Jakarta, sama seperti seluruh laporan lain. Batas yang memakai UTC
    akan memindahkan notifikasi tengah malam ke hari yang salah, dan penelusuran yang mencari
    kejadian "kemarin" akan kehilangan barisnya.
  */
  if (filter.from) {
    conditions.push(
      `AND w.created_at >= $${params.push(filter.from)}::date::timestamp AT TIME ZONE 'Asia/Jakarta'`,
    );
  }
  if (filter.to) {
    conditions.push(
      `AND w.created_at < ($${params.push(filter.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'`,
    );
  }

  /*
    Hasil disimpulkan di sini dengan aturan yang sama seperti di endpoint, karena tabelnya
    menyimpan fakta mentah: apakah barisnya pernah diproses, dan apakah pemrosesannya gagal.
    Aturannya harus sama persis, kalau tidak hasil saringannya akan berbeda dari label yang
    ditampilkan di layar.
  */
  if (filter.outcome === "verified") {
    conditions.push("AND w.processing_error IS NULL AND w.processed_at IS NOT NULL");
  } else if (filter.outcome === "pending") {
    conditions.push("AND w.processing_error IS NULL AND w.processed_at IS NULL");
  } else if (filter.outcome === "unknown_order") {
    conditions.push("AND w.processing_error IS NOT NULL AND w.payment_attempt_id IS NULL");
  } else if (filter.outcome === "rejected") {
    conditions.push("AND w.processing_error IS NOT NULL AND w.payment_attempt_id IS NOT NULL");
  }

  return query(
    `SELECT w.id, w.provider, w.provider_event_id, w.provider_order_id, w.provider_status,
            w.event_type, w.payment_attempt_id, host(w.ip_address) AS ip_address, w.user_agent,
            w.processed_at, w.processing_error, w.payload, w.created_at
     FROM payment_webhook_events w
     WHERE true
          ${conditions.join("\n          ")}
     ORDER BY w.created_at DESC
     LIMIT $${params.push(filter.limit ?? 50)}`,
    params,
    executor,
  );
}

/*
  Panggilan keluar ke penyedia pembayaran.

  `request_body` sudah disaring saat penulisan, sehingga kunci API tidak pernah tersimpan.
  Penyaringan itu dilakukan di sisi penulisan, bukan di sini, karena nilai aslinya tidak boleh
  pernah sampai ke database sama sekali.
*/
export async function providerCalls(
  filter: {
    operation?: string;
    outcome?: string;
    orderId?: string;
    paymentAttemptId?: string;
    httpStatus?: number;
    limit?: number;
    from?: string;
    to?: string;
  },
  executor?: Queryable,
): Promise<
  {
    id: string;
    provider: string;
    operation: string;
    payment_attempt_id: string | null;
    order_id: string | null;
    http_status: number | null;
    duration_ms: number;
    outcome: string;
    error_message: string | null;
    attempt_number: number;
    request_body: unknown;
    response_body: unknown;
    created_at: Date;
  }[]
> {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (filter.operation) {
    conditions.push(`AND operation = $${params.push(filter.operation)}`);
  }
  if (filter.outcome) {
    conditions.push(`AND outcome = $${params.push(filter.outcome)}`);
  }
  if (filter.orderId) {
    conditions.push(`AND order_id = $${params.push(filter.orderId)}`);
  }
  if (filter.paymentAttemptId) {
    conditions.push(`AND payment_attempt_id = $${params.push(filter.paymentAttemptId)}::uuid`);
  }
  if (filter.httpStatus !== undefined) {
    conditions.push(`AND http_status = $${params.push(filter.httpStatus)}`);
  }
  if (filter.from) {
    conditions.push(
      `AND created_at >= $${params.push(filter.from)}::date::timestamp AT TIME ZONE 'Asia/Jakarta'`,
    );
  }
  if (filter.to) {
    conditions.push(
      `AND created_at < ($${params.push(filter.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'`,
    );
  }

  return query(
    `SELECT id, provider, operation, payment_attempt_id, order_id, http_status, duration_ms,
            outcome, error_message, attempt_number, request_body, response_body, created_at
     FROM payment_provider_calls
     WHERE true
          ${conditions.join("\n          ")}
     ORDER BY created_at DESC
     LIMIT $${params.push(filter.limit ?? 50)}`,
    params,
    executor,
  );
}

export type ProviderHealth = {
  operation: string;
  total: number;
  failed: number;
  success: number;
  avg_duration_ms: number | null;
  max_duration_ms: number | null;
  last_call_at: Date | null;
  last_failure_at: Date | null;
};

/*
  Ringkasan kesehatan integrasi pembayaran.

  Yang dicari di sini bukan rata-rata, melainkan dua hal yang menunjukkan masalah yang sedang
  berlangsung: berapa panggilan yang gagal, dan berapa lama panggilan terlama berlangsung.
  Rata-rata durasi menyembunyikan satu panggilan yang menggantung dua puluh detik, dan justru
  panggilan seperti itulah yang membuat pelanggan menutup halaman pembayarannya.

  Periode dibatasi 24 jam terakhir karena yang dicari adalah keadaan sekarang, bukan catatan
  sepanjang masa.
*/
export async function providerHealth(executor?: Queryable): Promise<ProviderHealth[]> {
  return query<ProviderHealth>(
    `SELECT operation,
            count(*)::int AS total,
            count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
            count(*) FILTER (WHERE outcome = 'success')::int AS success,
            avg(duration_ms)::numeric(10,0)::text::int AS avg_duration_ms,
            max(duration_ms)::int AS max_duration_ms,
            max(created_at) AS last_call_at,
            max(created_at) FILTER (WHERE outcome = 'failed') AS last_failure_at
     FROM payment_provider_calls
     WHERE created_at >= now() - interval '24 hours'
     GROUP BY operation
     ORDER BY failed DESC, operation`,
    [],
    executor,
  );
}

/*
  Tagihan yang pembayarannya sudah masuk tetapi layanannya belum aktif.

  Ini daftar kerja yang paling mendesak di halaman pembayaran. Setiap baris di sini berarti
  pelanggan sudah membayar dan belum menerima apa yang dibayarnya, dan itu keluhan yang akan
  datang sendiri kalau tidak ditindaklanjuti lebih dulu.
*/
export async function paidButNotActivated(
  limit = 20,
  executor?: Queryable,
): Promise<
  {
    payment_id: string;
    invoice_id: string;
    invoice_number: string | null;
    invoice_status: string;
    customer_id: string;
    customer_name: string | null;
    amount: string;
    paid_at: Date | null;
    verified_at: Date | null;
    verified_via: string | null;
  }[]
> {
  return query(
    `SELECT pa.id AS payment_id, i.id AS invoice_id, i.invoice_number, i.status AS invoice_status,
            i.customer_id, c.full_name AS customer_name, pa.amount::text, pa.paid_at,
            pa.verified_at, pa.verified_via
     FROM payment_attempts pa
     JOIN invoices i ON i.id = pa.invoice_id
     LEFT JOIN customers c ON c.id = i.customer_id
     WHERE pa.status = 'paid' AND i.status <> 'paid'
     ORDER BY pa.paid_at NULLS LAST, pa.created_at
     LIMIT $1`,
    [limit],
    executor,
  );
}

import { query, queryOne, type Queryable } from "./db";

/*
  Data tagihan untuk konsol admin.

  Satu aturan yang menentukan seluruh bentuk berkas ini: pendapatan dihitung dari
  `invoices.amount_paid` pada saat `paid_at`, bukan dari `provider_total_payment`. Pakasir
  menambahkan biaya layanan di atas nominal tagihan, dan biaya itu bukan pendapatan langganan.
  Kalau angka itu ikut dihitung, laporan pendapatan akan lebih besar daripada yang sebenarnya
  diterima, dan selisihnya tumbuh seiring jumlah transaksi.

  Karena itu seluruh proyeksi di sini memakai `amount_paid` dan tidak pernah menyentuh kolom
  provider untuk keperluan pendapatan. Kolom provider hanya ditampilkan sebagai keterangan
  transaksi, bukan sebagai angka pendapatan.
*/

export type InvoiceListRow = {
  id: string;
  cursor_value: string;
  invoice_number: string | null;
  status: string;
  currency: string;
  total_amount: string;
  amount_paid: string;
  due_at: Date | null;
  period_start: Date | null;
  period_end: Date | null;
  paid_at: Date | null;
  voided_at: Date | null;
  created_at: Date;
  customer_id: string;
  customer_name: string | null;
  subscription_id: string | null;
  plan_name: string | null;
  attempt_count: number;
  last_attempt_status: string | null;
};

export type InvoiceFilter = {
  status?: string;
  customerId?: string;
  subscriptionId?: string;
  q?: string;
  dueFrom?: string;
  dueTo?: string;
};

export function invoiceFilterConditions(filter: InvoiceFilter, params: unknown[]): string {
  const conditions: string[] = [];

  if (filter.status) {
    conditions.push(`AND i.status = $${params.push(filter.status)}`);
  }

  if (filter.customerId) {
    conditions.push(`AND i.customer_id = $${params.push(filter.customerId)}::uuid`);
  }

  if (filter.subscriptionId) {
    conditions.push(`AND i.subscription_id = $${params.push(filter.subscriptionId)}::uuid`);
  }

  if (filter.q) {
    /* Tanda persen dan garis bawah di-escape, kalau tidak pencarian "INV%" cocok dengan semua. */
    const pattern = `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    conditions.push(
      `AND (i.invoice_number ILIKE $${params.push(pattern)} OR c.full_name ILIKE $${params.length})`,
    );
  }

  if (filter.dueFrom) {
    conditions.push(`AND i.due_at >= $${params.push(filter.dueFrom)}::timestamptz`);
  }

  if (filter.dueTo) {
    conditions.push(`AND i.due_at <= $${params.push(filter.dueTo)}::timestamptz`);
  }

  return conditions.join("\n          ");
}

const SELECT_COLUMNS = `
  i.id,
  i.created_at::text AS cursor_value,
  i.invoice_number,
  i.status,
  i.currency,
  i.total_amount::text,
  i.amount_paid::text,
  i.due_at,
  i.period_start,
  i.period_end,
  i.paid_at,
  i.voided_at,
  i.created_at,
  i.customer_id,
  c.full_name AS customer_name,
  i.subscription_id,
  p.name AS plan_name,
  (
    SELECT count(*)::int FROM payment_attempts pa WHERE pa.invoice_id = i.id
  ) AS attempt_count,
  (
    SELECT pa.status FROM payment_attempts pa
    WHERE pa.invoice_id = i.id
    ORDER BY pa.attempt_sequence DESC LIMIT 1
  ) AS last_attempt_status
`;

const SELECT_JOINS = `
  FROM invoices i
  LEFT JOIN customers c ON c.id = i.customer_id
  LEFT JOIN subscriptions s ON s.id = i.subscription_id
  LEFT JOIN subscription_plans p ON p.id = s.plan_id
`;

export async function findInvoice(
  invoiceId: string,
  executor?: Queryable,
): Promise<InvoiceListRow | null> {
  return queryOne<InvoiceListRow>(
    `SELECT ${SELECT_COLUMNS} ${SELECT_JOINS} WHERE i.id = $1`,
    [invoiceId],
    executor,
  );
}

/*
  Butir tagihan.

  Harga disalin ke baris butir saat tagihan dibuat, jadi butir inilah yang menjadi catatan
  sebenarnya tentang apa yang ditagihkan. Membacanya dari harga paket yang berlaku sekarang akan
  membuat tagihan lama berubah nilainya setiap kali harga paket diperbarui.
*/
export async function invoiceItems(
  invoiceId: string,
  executor?: Queryable,
): Promise<
  {
    id: string;
    description: string;
    quantity: number;
    unit_amount: string;
    total_amount: string;
    metadata: unknown;
  }[]
> {
  return query(
    `SELECT id, description, quantity, unit_amount::text, total_amount::text, metadata
     FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at`,
    [invoiceId],
    executor,
  );
}

/*
  Percobaan pembayaran pada satu tagihan.

  Ditampilkan karena satu tagihan biasanya punya beberapa percobaan, dan pertanyaan "pelanggan
  bilang sudah bayar, kenapa tagihannya masih terbuka" hanya bisa dijawab dengan melihat
  percobaan mana yang berhasil dan mana yang kedaluwarsa.
*/
export async function invoicePaymentAttempts(
  invoiceId: string,
  executor?: Queryable,
): Promise<
  {
    id: string;
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
  }[]
> {
  return query(
    `SELECT id, attempt_sequence, provider, payment_method, provider_order_id,
            amount::text, provider_fee::text, provider_total_payment::text, status,
            expires_at, paid_at, verified_at, verified_via, created_at
     FROM payment_attempts WHERE invoice_id = $1 ORDER BY attempt_sequence`,
    [invoiceId],
    executor,
  );
}

export type InvoiceSummary = {
  total: number;
  open: number;
  paid: number;
  past_due: number;
  void: number;
  uncollectible: number;
  outstanding_amount: string | null;
  paid_this_month_amount: string | null;
};

/*
  Ringkasan tagihan.

  `outstanding_amount` hanya menjumlahkan tagihan yang masih menuntut pembayaran, yaitu yang
  berstatus terbuka atau lewat jatuh tempo. Tagihan draf belum ditagihkan, dan tagihan batal
  atau tidak tertagih tidak akan pernah dibayar, jadi keduanya tidak boleh masuk ke angka ini.

  `paid_this_month_amount` memakai `amount_paid` dan dibatasi pada bulan berjalan menurut waktu
  Jakarta, bukan menurut UTC. Batas bulan yang memakai UTC akan memindahkan transaksi akhir
  bulan ke bulan berikutnya, dan laporan bulanan jadi tidak cocok dengan catatan keuangan.
*/
export async function invoiceSummary(
  executor?: Queryable,
): Promise<InvoiceSummary | null> {
  return queryOne<InvoiceSummary>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE status = 'paid')::int AS paid,
            count(*) FILTER (WHERE status = 'past_due')::int AS past_due,
            count(*) FILTER (WHERE status = 'void')::int AS void,
            count(*) FILTER (WHERE status = 'uncollectible')::int AS uncollectible,
            COALESCE(sum(total_amount - amount_paid) FILTER (
              WHERE status IN ('open', 'past_due')
            ), 0)::text AS outstanding_amount,
            COALESCE(sum(amount_paid) FILTER (
              WHERE status = 'paid'
                AND paid_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta')
                             AT TIME ZONE 'Asia/Jakarta'
            ), 0)::text AS paid_this_month_amount
     FROM invoices`,
    [],
    executor,
  );
}

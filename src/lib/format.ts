const rupiah = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const dateTime = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Jakarta",
});

const dateOnly = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeZone: "Asia/Jakarta",
});

// API mengirim uang sebagai integer rupiah, jadi tidak ada pecahan yang perlu dibulatkan di sini.
export function formatRupiah(amount: number): string {
  return rupiah.format(amount);
}

export function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateTime.format(parsed);
}

export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateOnly.format(parsed);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("id-ID").format(value);
}

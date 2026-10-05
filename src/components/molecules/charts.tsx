"use client";

import { useId } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { EmptyState } from "./data-states";
import { formatNumber, formatRupiah } from "@/lib/format";
import { cn } from "@/lib/utils";

/*
  Grafik dashboard dan laporan.

  Empat aturan yang menentukan bentuk berkas ini:

  1. Warna diambil dari token tema lewat `var(--chart-n)`, bukan nilai heksadesimal yang ditulis
     di sini. Atribut presentasi SVG menerima `var()`, sehingga tema terang dan tema gelap tidak
     perlu dua set warna yang harus dijaga tetap sinkron.

  2. Warna deret tetap sepanjang panel: pendapatan oranye, pelanggan biru, langganan hijau,
     perangkat ungu, piutang teal. Pembaca yang berpindah grafik tidak perlu membaca ulang
     keterangannya. Warna tidak pernah menjadi satu-satunya penanda, karena setiap deret selalu
     disertai namanya di legenda atau di label sumbu.

  3. Grafik yang seluruh nilainya nol menampilkan keadaan kosong, bukan sumbu rata di dasar.
     Sumbu rata terbaca sebagai "usahanya nol", padahal artinya "belum ada datanya".

  4. Angka selalu bisa dibaca tanpa kursor. Deret tunggal memakai grafik garis dengan nilai di
     ujungnya; perbandingan kategori memakai batang mendatar dengan angkanya tertulis di ujung
     batang, karena panjang batang saja tidak cukup untuk nilai yang berbeda tipis.
*/

/* Warna deret. Nilainya token, bukan heksadesimal, supaya ikut tema. */
export const SERIES_COLORS = {
  revenue: "var(--chart-1)",
  customers: "var(--chart-2)",
  subscriptions: "var(--chart-3)",
  devices: "var(--chart-4)",
  receivables: "var(--chart-5)",
} as const;

export type SeriesTone = keyof typeof SERIES_COLORS;

/*
  Sumbu, kisi, dan garis bantu memakai token yang sudah dipakai tabel, bukan warna baru.
  Dengan begitu grafik tidak memperkenalkan bahasa warna ketiga di halaman yang sama.
*/
const AXIS = "var(--muted-foreground)";
const GRID = "var(--border)";

/* Angka pada sumbu dipendekkan. Sumbu bukan tempat menulis nominal penuh. */
const ringkas = new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 });

export type Titik = { label: string; value: number };
export type TitikGrup = { label: string; values: number[] };

type FormatNilai = (value: number) => string;

/*
  Label sumbu ditulis pendek: "01 Sep" untuk harian, "Sep 2026" untuk bulanan. Bentuk panjang
  tidak muat di sumbu, dan yang dibutuhkan pembaca di situ hanya penanda posisi.
*/
function labelSumbu(bucket: string, granularity?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return bucket;

  const tanggal = new Date(`${bucket}T00:00:00+07:00`);
  if (Number.isNaN(tanggal.getTime())) return bucket;

  const opsi: Intl.DateTimeFormatOptions =
    granularity === "month"
      ? { month: "short", year: "numeric", timeZone: "Asia/Jakarta" }
      : { day: "2-digit", month: "short", timeZone: "Asia/Jakarta" };

  return tanggal.toLocaleDateString("id-ID", opsi);
}

/* Keterangan lengkap untuk tooltip, memakai tanggal yang bisa dibaca. */
function labelTooltip(bucket: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return bucket;
  const tanggal = new Date(`${bucket}T00:00:00+07:00`);
  if (Number.isNaN(tanggal.getTime())) return bucket;
  return tanggal.toLocaleDateString("id-ID", { dateStyle: "long", timeZone: "Asia/Jakarta" });
}

/*
  Animasi masuk grafik dimatikan.

  DESIGN.md menetapkan dial MOTION 1: hanya transisi hover, focus, dan buka tutup, tanpa animasi
  yang berjalan sendiri. Grafik yang menggambar dirinya sedikit demi sedikit setiap kali halaman
  dibuka adalah animasi yang berjalan tanpa diminta, dan pada halaman yang dibuka berpuluh kali
  sehari ia berubah dari hal yang menarik menjadi hal yang menghalangi.
*/
const TANPA_ANIMASI = { isAnimationActive: false } as const;

function KotakTooltip({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-popover text-popover-foreground rounded-md border border-border px-2.5 py-2 text-[13px] shadow-md">
      {children}
    </div>
  );
}

function TooltipTunggal({
  active,
  payload,
  satuan,
  formatNilai,
}: {
  active?: boolean;
  payload?: { payload: Titik }[];
  satuan: string;
  formatNilai: FormatNilai;
}) {
  if (!active || !payload?.length) return null;
  const titik = payload[0].payload;

  return (
    <KotakTooltip>
      <p className="font-medium">{labelTooltip(titik.label)}</p>
      <p className="text-muted-foreground mt-0.5">
        <span className="tabular text-foreground font-medium">{formatNilai(titik.value)}</span>{" "}
        {satuan}
      </p>
    </KotakTooltip>
  );
}

function TooltipGrup({
  active,
  payload,
  seri,
  satuan,
  formatNilai,
}: {
  active?: boolean;
  payload?: { payload: Record<string, number | string> }[];
  seri: { label: string; tone: SeriesTone }[];
  satuan: string;
  formatNilai: FormatNilai;
}) {
  if (!active || !payload?.length) return null;
  const baris = payload[0].payload;

  return (
    <KotakTooltip>
      <p className="font-medium">{labelTooltip(String(baris.label))}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {seri.map((s, index) => (
          <li key={s.label} className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2.5 rounded-sm"
                style={{ background: SERIES_COLORS[s.tone] }}
              />
              {s.label}
            </span>
            <span className="tabular font-medium">
              {formatNilai(Number(baris[`s${index}`] ?? 0))}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-1 text-[12px]">Dalam {satuan}</p>
    </KotakTooltip>
  );
}

function SumbuY({ formatNilai }: { formatNilai: FormatNilai }) {
  return (
    <YAxis
      tick={{ fill: AXIS, fontSize: 12 }}
      tickLine={false}
      axisLine={false}
      width={56}
      tickFormatter={(value: number) => formatNilai(value)}
    />
  );
}

function SumbuX({ granularity }: { granularity?: string }) {
  return (
    <XAxis
      dataKey="label"
      tick={{ fill: AXIS, fontSize: 12 }}
      tickLine={false}
      axisLine={{ stroke: GRID }}
      tickFormatter={(value: string) => labelSumbu(value, granularity)}
      minTickGap={16}
    />
  );
}

function Kisi() {
  return <CartesianGrid stroke={GRID} strokeDasharray="4 4" vertical={false} />;
}

/*
  Bingkai grafik.

  Setiap grafik berdiri di dalam kartu yang judulnya menyebut pertanyaan yang dijawab grafik itu,
  bukan nama bagian. "Pendapatan per hari" dapat dipakai; "Ringkasan" tidak, karena tidak
  memberitahu apa yang sedang dibaca.

  Keterangan di bawah judul menyebut satuan dan dasar perhitungannya, karena angka pendapatan
  tanpa keterangan mudah disalahartikan sebagai uang yang masuk ke rekening.
*/
export function ChartCard({
  judul,
  keterangan,
  children,
  aksi,
  className,
}: {
  judul: string;
  keterangan?: string;
  children: React.ReactNode;
  aksi?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("bg-card flex flex-col gap-3 rounded-xl border border-border p-4", className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">{judul}</h2>
          {keterangan ? (
            <p className="text-muted-foreground text-[13px] leading-relaxed">{keterangan}</p>
          ) : null}
        </div>
        {aksi}
      </div>
      {children}
    </section>
  );
}

/*
  Baris legenda untuk grafik yang punya lebih dari satu deret. Warna tidak pernah menjadi
  satu-satunya penanda, jadi setiap warna selalu disertai namanya.
*/
export function LegendSeri({ items }: { items: { label: string; tone: SeriesTone }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {items.map((item) => (
        <li key={item.label} className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
          <span
            aria-hidden="true"
            className="size-2.5 rounded-sm"
            style={{ background: SERIES_COLORS[item.tone] }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function Kosong({ title, description }: { title: string; description: string }) {
  return <EmptyState title={title} description={description} />;
}

/*
  Grafik bidang untuk deret tunggal yang dibaca sebagai gerak sepanjang waktu.
  Dipakai untuk pendapatan, karena yang dibaca adalah naik turunnya, bukan besar tiap batang.
*/
export function AreaSeries({
  data,
  tone,
  satuan,
  formatNilai = (value) => formatNumber(value),
  granularity,
  tinggi = 260,
  rujukan,
  pesanKosong,
  labelAkses,
  className,
}: {
  data: Titik[];
  tone: SeriesTone;
  satuan: string;
  formatNilai?: FormatNilai;
  granularity?: string;
  tinggi?: number;
  /** Garis bantu mendatar, misalnya rata-rata periode. */
  rujukan?: { nilai: number; label: string };
  /** Keterangan keadaan kosong saat seluruh periode bernilai nol. */
  pesanKosong?: { title: string; description: string };
  /** Kalimat yang dibacakan pembaca layar sebagai pengganti gambar. */
  labelAkses: string;
  className?: string;
}) {
  const warna = SERIES_COLORS[tone];
  const gradien = `gradien-${useId().replace(/:/g, "")}`;
  const semuaNol = data.length > 0 && data.every((titik) => titik.value === 0);

  if (data.length === 0 || (semuaNol && pesanKosong)) {
    return (
      <Kosong
        title={pesanKosong?.title ?? "Belum ada titik yang bisa digambarkan"}
        description={
          pesanKosong?.description ??
          "Rentang yang dipilih tidak menghasilkan satu titik pun. Periksa kembali tanggalnya."
        }
      />
    );
  }

  return (
    <div className={cn("w-full", className)} style={{ height: tinggi }} role="img" aria-label={labelAkses}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            {/*
              Isian memakai opasitas dari token yang sama, bukan warna campuran yang ditulis
              terpisah. Dengan begitu tema gelap tidak perlu gradiennya sendiri.
            */}
            <linearGradient id={gradien} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={warna} stopOpacity={0.3} />
              <stop offset="100%" stopColor={warna} stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <Kisi />
          <SumbuX granularity={granularity} />
          <SumbuY formatNilai={formatNilai} />
          <Tooltip content={<TooltipTunggal satuan={satuan} formatNilai={formatNilai} />} />
          {rujukan ? (
            <ReferenceLine
              y={rujukan.nilai}
              stroke={AXIS}
              strokeDasharray="4 4"
              label={{
                value: rujukan.label,
                position: "insideTopRight",
                fill: AXIS,
                fontSize: 11,
              }}
            />
          ) : null}
          <Area
            type="monotone"
            dataKey="value"
            stroke={warna}
            strokeWidth={2}
            fill={`url(#${gradien})`}
            /*
              Titik data disembunyikan sampai kursor mendekat. Pada rentang 30 hari, titik di
              setiap hari membuat garisnya terlihat seperti untaian manik, bukan tren.
            */
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0, fill: warna }}
            {...TANPA_ANIMASI}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/*
  Grafik batang untuk satu deret jumlah per periode.
  Dipakai saat yang dibaca adalah besar masing-masing periode, bukan arah trennya.
*/
export function BarSeries({
  data,
  tone,
  satuan,
  formatNilai = (value) => formatNumber(value),
  granularity,
  tinggi = 260,
  pesanKosong,
  labelAkses,
  className,
}: {
  data: Titik[];
  tone: SeriesTone;
  satuan: string;
  formatNilai?: FormatNilai;
  granularity?: string;
  tinggi?: number;
  pesanKosong?: { title: string; description: string };
  labelAkses: string;
  className?: string;
}) {
  const warna = SERIES_COLORS[tone];
  const semuaNol = data.length > 0 && data.every((titik) => titik.value === 0);

  if (data.length === 0 || (semuaNol && pesanKosong)) {
    return (
      <Kosong
        title={pesanKosong?.title ?? "Belum ada angka pada periode ini"}
        description={
          pesanKosong?.description ??
          "Seluruh periode pada rentang yang dipilih bernilai nol, jadi tidak ada yang bisa digambarkan."
        }
      />
    );
  }

  return (
    <div className={cn("w-full", className)} style={{ height: tinggi }} role="img" aria-label={labelAkses}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="18%">
          <Kisi />
          <SumbuX granularity={granularity} />
          <SumbuY formatNilai={formatNilai} />
          <Tooltip
            cursor={{ fill: GRID, fillOpacity: 0.4 }}
            content={<TooltipTunggal satuan={satuan} formatNilai={formatNilai} />}
          />
          <Bar dataKey="value" fill={warna} radius={[4, 4, 0, 0]} maxBarSize={48} {...TANPA_ANIMASI} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/*
  Grafik batang berkelompok untuk dua deret yang satuannya sama, misalnya pelanggan baru dan
  langganan baru per periode. Digabung dalam satu grafik karena keduanya dihitung dari rentang
  yang sama, dan memisahkannya membuat dua grafik yang sumbunya harus dibandingkan sendiri-sendiri.
*/
export function BarGrup({
  data,
  seri,
  satuan,
  formatNilai = (value) => formatNumber(value),
  granularity,
  tinggi = 260,
  pesanKosong,
  labelAkses,
  className,
}: {
  data: TitikGrup[];
  seri: { label: string; tone: SeriesTone }[];
  satuan: string;
  formatNilai?: FormatNilai;
  granularity?: string;
  tinggi?: number;
  pesanKosong?: { title: string; description: string };
  labelAkses: string;
  className?: string;
}) {
  /* Recharts membaca satu dataKey per batang, jadi nilai tiap deret diberi kunci tetap. */
  const datar = data.map((titik) => ({
    label: titik.label,
    ...Object.fromEntries(titik.values.map((value, index) => [`s${index}`, value])),
  }));
  const semuaNol = data.length > 0 && data.every((titik) => titik.values.every((v) => v === 0));

  if (data.length === 0 || (semuaNol && pesanKosong)) {
    return (
      <Kosong
        title={pesanKosong?.title ?? "Belum ada angka pada periode ini"}
        description={
          pesanKosong?.description ??
          "Seluruh periode pada rentang yang dipilih bernilai nol, jadi tidak ada yang bisa digambarkan."
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <LegendSeri items={seri} />
      <div className={cn("w-full", className)} style={{ height: tinggi }} role="img" aria-label={labelAkses}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={datar} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="18%">
            <Kisi />
            <SumbuX granularity={granularity} />
            <SumbuY formatNilai={formatNilai} />
            <Tooltip
              cursor={{ fill: GRID, fillOpacity: 0.4 }}
              content={
                <TooltipGrup seri={seri} satuan={satuan} formatNilai={formatNilai} />
              }
            />
            {seri.map((s, index) => (
              <Bar
                key={s.label}
                dataKey={`s${index}`}
                fill={SERIES_COLORS[s.tone]}
                radius={[3, 3, 0, 0]}
                maxBarSize={28}
                {...TANPA_ANIMASI}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/*
  Grafik batang mendatar untuk perbandingan antar kategori, misalnya jumlah langganan aktif per
  paket. Nama kategori muat penuh di sisi kiri, sementara pada sumbu mendatar nama itu akan
  terpotong atau dimiringkan.
*/
export function BarKategori({
  data,
  tone,
  satuan,
  formatNilai = (value) => formatNumber(value),
  labelLebar = 148,
  pesanKosong,
  labelAkses,
  className,
}: {
  data: Titik[];
  tone: SeriesTone;
  satuan: string;
  formatNilai?: FormatNilai;
  labelLebar?: number;
  pesanKosong?: { title: string; description: string };
  labelAkses: string;
  className?: string;
}) {
  const warna = SERIES_COLORS[tone];
  const semuaNol = data.length > 0 && data.every((titik) => titik.value === 0);
  const tinggi = Math.max(160, data.length * 44 + 24);

  if (data.length === 0 || semuaNol) {
    return (
      <Kosong
        title={pesanKosong?.title ?? "Belum ada angka per kategori"}
        description={
          pesanKosong?.description ??
          "Semua kategori bernilai nol pada periode ini, jadi tidak ada yang bisa dibandingkan."
        }
      />
    );
  }

  return (
    <div className={cn("w-full", className)} style={{ height: tinggi }} role="img" aria-label={labelAkses}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 64, bottom: 4, left: 0 }}
          barCategoryGap="24%"
        >
          <CartesianGrid stroke={GRID} strokeDasharray="4 4" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: AXIS, fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            tickFormatter={(value: number) => ringkas.format(value)}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fill: AXIS, fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={labelLebar}
          />
          <Tooltip
            cursor={{ fill: GRID, fillOpacity: 0.4 }}
            content={<TooltipTunggal satuan={satuan} formatNilai={formatNilai} />}
          />
          <Bar dataKey="value" fill={warna} radius={[0, 4, 4, 0]} maxBarSize={22} {...TANPA_ANIMASI}>
            {/*
              Angka ditulis di ujung batang karena pada perbandingan kategori, panjang batangnya
              saja tidak cukup untuk nilai yang berbeda tipis. Label ini juga membuat angkanya
              terbaca tanpa perlu mengarahkan kursor ke setiap batang.
            */}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(value: unknown) => formatNilai(Number(value))}
              style={{
                fill: "var(--foreground)",
                fontSize: 12,
                fontVariantNumeric: "tabular-nums",
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* Dipakai laporan yang menampilkan nominal rupiah di grafiknya. */
export const formatRupiahGrafik: FormatNilai = (value) => formatRupiah(value);

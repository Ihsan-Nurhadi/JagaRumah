"use client";

import {
  ClockCounterClockwiseIcon,
  KeyIcon,
  ListChecksIcon,
  SignInIcon,
} from "@phosphor-icons/react";
import { useCallback, useState } from "react";

import { Button, Identifier, Spinner, Timestamp, type Tone } from "@/components/atoms";
import {
  Column,
  DataTable,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  StatCard,
  StatusBadge,
  StatusLabel,
  statusTone,
  type FilterDefinition,
} from "@/components/molecules";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { notifyError, notifySuccess } from "@/lib/alert";
import { formatNumber } from "@/lib/format";
import { toErrorMessage } from "@/lib/http";
import { mutate, tableStatus, usePagedQuery } from "@/lib/use-api";
import { useSessionStore } from "@/stores/session-store";

/*
  Konsol audit.

  Halaman ini menjawab satu rangkaian pertanyaan dengan urutan yang selalu sama: siapa yang
  melakukannya, kapan, dan dari mana. Empat tab di bawah adalah empat sumber jawaban yang
  berbeda, dan masing-masing dibuka terpisah.

  Isi tiap tab diambil saat tab itu dibuka, bukan sekaligus di awal. Tabel jejak perubahan jauh
  lebih besar daripada tabel sesi, jadi memuat keempatnya bersamaan berarti membayar kueri
  terberat untuk tab yang belum tentu dibuka.

  Satu tindakan menulis di halaman ini: mencabut sesi admin lain. Ini bukan pelanggaran sifat
  hanya-baca, karena yang ditulis adalah keadaan sesi, bukan catatannya: catatan audit tetap
  utuh, dan pencabutan itu sendiri justru menambah satu baris di jejak audit. Yang tidak ada di
  sini adalah tombol hapus atau bersihkan, karena catatan audit yang bisa dihapus dari konsol
  yang sama tidak dapat dipakai sebagai bukti.
*/

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/*
  Nilai filter diterjemahkan ke parameter API.

  Tanggal dari pemilih tanggal dikirim sebagai tanggal polos, sedangkan endpoint menerima waktu
  lengkap. Batas harinya dihitung menurut WIB, bukan zona waktu server: tanpa penambahan offset
  ini, "13 September" pada filter akhir berarti pukul 07:00 WIB, dan catatan pagi hari ikut
  terbuang dari hasil.
*/
function toApiParams(
  values: Record<string, string | undefined>,
): Record<string, string | number | undefined> {
  /*
    Ukuran halaman tidak ditulis di sini. Nilainya milik usePagedQuery, dan menyalinnya ke params
    membuat pilihan "baris per halaman" diabaikan: server selalu menerima angka dari sini, sehingga
    mengganti ukuran halaman tampak tidak berpengaruh.
  */
  const params: Record<string, string | number | undefined> = {};

  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    if (PLAIN_DATE.test(value)) {
      params[key] = key.endsWith("_to")
        ? `${value}T23:59:59.999+07:00`
        : `${value}T00:00:00+07:00`;
      continue;
    }
    params[key] = value;
  }

  return params;
}

function hasFilter(values: Record<string, string | undefined>): boolean {
  return Object.values(values).some((value) => Boolean(value));
}

/*
  Nilai filter disimpan apa adanya untuk kotak input, sementara versi yang sudah diterjemahkan
  dikirim ke server. Dua keadaan ini dipisah karena pemilih tanggal menampilkan tanggal polos,
  sedangkan endpoint meminta waktu lengkap.

  `limit` tidak lagi ikut ditulis di sini karena ukuran halaman dikelola usePagedQuery, yang juga
  menjaga agar mengganti ukuran halaman tidak menghapus filter yang sedang dipasang.
*/
function useAuditQuery<T>(url: string) {
  const [values, setValues] = useState<Record<string, string | undefined>>({});

  const mapParams = useCallback(
    (raw: Record<string, string | number | undefined>) =>
      toApiParams(raw as Record<string, string | undefined>),
    [],
  );

    /*
    Ukuran halaman diserahkan ke usePagedQuery. Sebelumnya di sini ukuran halaman dipatok lebih dulu,
    yang membuat pilihan "baris per halaman" tidak berpengaruh: nilainya sudah ditentukan lebih
    dulu, dan tabel selalu menampilkan 50 baris seolah tidak ada halaman berikutnya.
  */
  const query = usePagedQuery<T>(url, { mapParams });
  const { setParams } = query;

  const apply = useCallback(
    (next: Record<string, string | undefined>) => {
      setValues(next);
      setParams(next);
    },
    [setParams],
  );

  return { query, values, apply };
}

// ------------------------------------------------------------------ label bahasa Indonesia

/*
  Nama tindakan diterjemahkan karena kode seperti `device.claim_code.rotate` tidak berarti apa
  pun bagi operator. Daftar ini memuat tindakan yang sudah ditulis kode dan nama yang sudah
  ditetapkan di DB_Plan.md untuk modul yang belum dibangun, supaya labelnya sudah siap saat modul
  itu menyusul. Tindakan yang tetap tidak dikenal ditampilkan apa adanya, bukan disembunyikan.
*/
const ACTION_LABELS: Record<string, string> = {
  "device.create": "Perangkat didaftarkan",
  "device.update": "Perangkat diubah",
  "device.assign": "Perangkat ditugaskan",
  "device.unassign": "Perangkat dilepas",
  "device.claim_code.rotate": "Kode claim dirotasi",
  "customer.update": "Pelanggan diubah",
  "customer.suspend": "Pelanggan ditangguhkan",
  "customer.activate": "Pelanggan diaktifkan",
  "subscription.cancel": "Langganan dibatalkan",
  "subscription.change": "Langganan diubah",
  "subscription.expired_by_scheduler": "Langganan berakhir otomatis",
  "invoice.void": "Tagihan dibatalkan",
  "payment.refund": "Dana dikembalikan",
  "payment.verified_by_reconciliation": "Pembayaran diverifikasi otomatis",
  "admin.create": "Akun admin dibuat",
  "admin.role_update": "Peran admin diubah",
};

const ENTITY_LABELS: Record<string, string> = {
  device: "Perangkat",
  customer: "Pelanggan",
  subscription: "Langganan",
  invoice: "Tagihan",
  payment: "Pembayaran",
  admin_user: "Admin",
};

const FAILURE_REASON_LABELS: Record<string, string> = {
  unknown_user: "Email tidak terdaftar",
  wrong_password: "Kata sandi salah",
  inactive: "Akun dinonaktifkan",
  locked: "Akun terkunci",
  rate_limited: "Ditolak karena batas percobaan",
};

const EVENT_LABELS: Record<string, string> = {
  login: "Masuk",
  refresh: "Token sesi diperbarui",
  logout: "Keluar sendiri",
  revoked: "Sesi dicabut",
  expired: "Sesi kedaluwarsa",
  password_changed: "Kata sandi diubah",
};

const EVENT_TONES: Record<string, Tone> = {
  login: "success",
  refresh: "info",
  logout: "neutral",
  revoked: "warning",
  expired: "neutral",
  password_changed: "warning",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function entityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType;
}

function failureReasonLabel(reason: string | null): string {
  if (!reason) return "Alasan tidak dicatat";
  return FAILURE_REASON_LABELS[reason] ?? reason;
}

function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType;
}

// ------------------------------------------------------------------ nilai json

/*
  Isi old_data, new_data, dan metadata tidak punya skema tetap, jadi nilainya ditampilkan apa
  adanya. Yang penting di sini bukan bentuk tampilannya, melainkan bahwa sebelum dan sesudah
  sama-sama terbaca.
*/
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function describeValue(value: unknown): string {
  if (value === undefined || value === null) return "kosong";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "kosong";
}

const MAX_CHANGE_LINES = 4;

function changeSummary(
  oldData: unknown,
  newData: unknown,
): { headline: string | null; lines: string[] } {
  const before = asRecord(oldData);
  const after = asRecord(newData);
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);

  if (beforeKeys.length === 0 && afterKeys.length === 0) {
    return { headline: null, lines: [] };
  }

  /*
    Satu sisi kosong berarti catatan baru dibuat atau dihapus, bukan sekumpulan kolom yang
    berubah. Menampilkannya sebagai "kosong menjadi nilai" akan menyamarkan bedanya.
  */
  if (beforeKeys.length === 0 || afterKeys.length === 0) {
    const created = beforeKeys.length === 0;
    const source = created ? after : before;
    return {
      headline: created ? "Catatan dibuat" : "Catatan dihapus",
      lines: Object.entries(source).map(([key, value]) => `${key}: ${describeValue(value)}`),
    };
  }

  const lines: string[] = [];
  for (const key of [...new Set([...beforeKeys, ...afterKeys])]) {
    const from = describeValue(before[key]);
    const to = describeValue(after[key]);
    if (from !== to) lines.push(`${key}: ${from} → ${to}`);
  }

  return { headline: null, lines };
}

/*
  Perubahan dirender sebagai baris teks, bukan sebagai blok JSON mentah. Nilai yang panjang
  dibungkus di dalam lebar kolom, sehingga tabel tidak melebar mengikuti panjang datanya.
*/
function ChangeCell({ oldData, newData }: { oldData: unknown; newData: unknown }) {
  const summary = changeSummary(oldData, newData);

  if (summary.headline === null && summary.lines.length === 0) {
    return <span className="text-muted-foreground text-[13px]">Tidak ada rincian</span>;
  }

  const shown = summary.lines.slice(0, MAX_CHANGE_LINES);

  return (
    <div className="flex max-w-[22rem] flex-col gap-0.5 whitespace-normal">
      {summary.headline ? (
        <span className="text-muted-foreground text-[13px]">{summary.headline}</span>
      ) : null}
      {shown.map((line) => (
        <span key={line} className="text-[13px] break-words">
          {line}
        </span>
      ))}
      {summary.lines.length > shown.length ? (
        <span className="text-muted-foreground text-[13px]">
          +{summary.lines.length - shown.length} kolom lain
        </span>
      ) : null}
    </div>
  );
}

function MetadataLines({ metadata }: { metadata: unknown }) {
  const entries = Object.entries(asRecord(metadata));
  if (entries.length === 0) return null;

  return (
    <span className="flex flex-col gap-0.5">
      {entries.map(([key, value]) => (
        <span key={key} className="text-muted-foreground text-[13px] break-words">
          {key}: {describeValue(value)}
        </span>
      ))}
    </span>
  );
}

// ------------------------------------------------------------------ sel bersama

/*
  Pelaku baris audit. Tindakan sistem ditandai sebagai "Sistem", bukan dibiarkan kosong: baris
  itu memang tidak punya admin, dan kekosongan yang tidak dijelaskan akan terbaca sebagai data
  yang hilang.
*/
function ActorCell({
  actorType,
  actor,
}: {
  actorType: string;
  actor: { full_name: string | null; email: string | null } | null;
}) {
  if (actorType === "system") {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <StatusBadge tone="info">Sistem</StatusBadge>
        <span className="text-muted-foreground text-[13px]">Dijalankan otomatis</span>
      </div>
    );
  }

  if (!actor) {
    return <span className="text-muted-foreground text-[13px]">Admin tidak dikenal</span>;
  }

  return (
    <div className="flex flex-col">
      <span className="text-[13px] font-medium">{actor.full_name ?? "Nama tidak tercatat"}</span>
      {actor.email ? (
        <span className="text-muted-foreground text-[13px]">{actor.email}</span>
      ) : null}
    </div>
  );
}

/*
  Sumber tindakan: alamat dan perangkat yang dipakai. User agent dipotong secara visual dengan
  nilai utuhnya tetap ada di atribut title, mengikuti pola komponen Identifier.
*/
function SourceCell({
  ipAddress,
  userAgent,
}: {
  ipAddress: string | null;
  userAgent: string | null;
}) {
  return (
    <div className="flex max-w-[18rem] flex-col">
      <span className="tabular text-[13px]">{ipAddress ?? "Tidak dicatat"}</span>
      {userAgent ? (
        <span className="text-muted-foreground block truncate text-[13px]" title={userAgent}>
          {userAgent}
        </span>
      ) : (
        <span className="text-muted-foreground text-[13px]">Tanpa keterangan perangkat</span>
      )}
    </div>
  );
}

function AdminCell({
  admin,
}: {
  admin: { full_name: string | null; email: string | null } | null;
}) {
  if (!admin) {
    return <span className="text-muted-foreground text-[13px]">Admin tidak dikenal</span>;
  }

  return (
    <div className="flex flex-col">
      <span className="text-[13px] font-medium">{admin.full_name ?? "Nama tidak tercatat"}</span>
      {admin.email ? (
        <span className="text-muted-foreground text-[13px]">{admin.email}</span>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ tab 1: jejak perubahan

type LogRow = {
  id: string;
  actor_type: string;
  actor: { id: string; full_name: string | null; email: string | null } | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_data: unknown;
  new_data: unknown;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

type LogsResponse = {
  logs: LogRow[];
  summary: {
    total: number;
    last_24h: number;
    by_admin: number;
    by_system: number;
    actions: { action: string; total: number }[];
    entity_types: { entity_type: string; total: number }[];
  };
};

function ChangeLogTab() {
  const { query, values, apply } = useAuditQuery<LogsResponse>("/api/v1/admin/audit-logs");
  const summary = query.data?.summary;
  const rows = query.data?.logs ?? [];

  const filters: FilterDefinition[] = [
    {
      kind: "search",
      key: "q",
      label: "Cari",
      placeholder: "Tindakan, jenis data, nama admin, atau alamat IP",
    },
    {
      kind: "select",
      key: "actor_type",
      label: "Pelaku",
      anyLabel: "Semua pelaku",
      options: [
        { value: "admin", label: "Admin" },
        { value: "system", label: "Sistem" },
      ],
    },
    {
      kind: "select",
      key: "action",
      label: "Tindakan",
      anyLabel: "Semua tindakan",
      /*
        Pilihan diambil dari tindakan yang benar-benar ada di catatan, bukan dari daftar tetap di
        kode. Filter yang menawarkan tindakan yang belum pernah terjadi hanya menghasilkan daftar
        kosong, dan itu membuat operator menduga datanya hilang.
      */
      options: (summary?.actions ?? []).map((item) => ({
        value: item.action,
        label: `${actionLabel(item.action)} (${formatNumber(item.total)})`,
      })),
    },
    {
      kind: "select",
      key: "entity_type",
      label: "Jenis data",
      anyLabel: "Semua jenis",
      options: (summary?.entity_types ?? []).map((item) => ({
        value: item.entity_type,
        label: `${entityLabel(item.entity_type)} (${formatNumber(item.total)})`,
      })),
    },
    { kind: "date", key: "created_from", label: "Dari tanggal" },
    { kind: "date", key: "created_to", label: "Sampai tanggal" },
  ];

  const columns: Column<LogRow>[] = [
    {
      key: "created_at",
      header: "Waktu",
      cell: (row) => <Timestamp value={row.created_at} />,
    },
    {
      key: "actor",
      header: "Pelaku",
      cell: (row) => <ActorCell actorType={row.actor_type} actor={row.actor} />,
    },
    {
      key: "action",
      header: "Tindakan",
      cell: (row) => (
        <div className="flex flex-col">
          <span className="text-[13px]">{actionLabel(row.action)}</span>
          {ACTION_LABELS[row.action] ? (
            <span className="text-muted-foreground text-[13px]">{row.action}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "entity",
      header: "Jenis data",
      cell: (row) => (
        <div className="flex flex-col">
          <span className="text-[13px]">{entityLabel(row.entity_type)}</span>
          {row.entity_id ? (
            <Identifier value={row.entity_id} />
          ) : (
            <span className="text-muted-foreground text-[13px]">Tanpa nomor data</span>
          )}
        </div>
      ),
    },
    {
      key: "change",
      header: "Perubahan",
      cell: (row) => <ChangeCell oldData={row.old_data} newData={row.new_data} />,
    },
    {
      key: "source",
      header: "Sumber",
      cell: (row) => <SourceCell ipAddress={row.ip_address} userAgent={row.user_agent} />,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Tercatat"
            value={summary ? formatNumber(summary.total) : null}
            hint="Seluruh jejak perubahan, dari awal pencatatan"
          />
          <StatCard
            label="Oleh admin"
            value={summary ? formatNumber(summary.by_admin) : null}
            hint="Dilakukan orang, lengkap dengan nama pelakunya"
          />
          <StatCard
            label="Oleh sistem"
            value={summary ? formatNumber(summary.by_system) : null}
            hint="Dijalankan otomatis oleh job, tanpa admin"
          />
          <StatCard
            label="24 jam terakhir"
            value={summary ? formatNumber(summary.last_24h) : null}
            hint="Tindakan admin dan sistem digabung"
          />
        </div>
      )}

      <FilterBar filters={filters} values={values} onChange={apply} onReset={() => apply({})} />

      <DataTable
        label="Jejak perubahan"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat jejak perubahan"
        errorTitle="Jejak perubahan gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) => (row.actor_type === "system" ? "info" : "neutral")}
        emptyState={
          hasFilter(values) ? (
            <EmptyState
              title="Tidak ada catatan yang cocok"
              description="Tidak ada tindakan yang sesuai dengan filter yang dipasang. Bersihkan filter, atau lebarkan rentang tanggalnya."
            />
          ) : (
            <EmptyState
              icon={<ClockCounterClockwiseIcon aria-hidden weight="regular" className="size-6" />}
              title="Belum ada jejak perubahan"
              description="Catatan ini terisi sendiri setiap kali data pelanggan, perangkat, atau langganan diubah dari konsol. Selama belum ada perubahan, daftarnya memang kosong."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="jejak perubahan"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />
    </div>
  );
}

// ------------------------------------------------------------------ tab 2: percobaan masuk

type LoginAttemptRow = {
  id: string;
  email: string;
  admin: { id: string; full_name: string | null } | null;
  ip_address: string | null;
  success: boolean;
  failure_reason: string | null;
  created_at: string;
};

type LoginAttemptsResponse = {
  attempts: LoginAttemptRow[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    failed_last_24h: number;
    succeeded_last_24h: number;
    limits: { failures_per_account: number; failures_per_ip: number; window_minutes: number };
    top_ips_24h: { ip_address: string | null; failures: number; emails: number }[];
    top_emails_24h: { email: string; failures: number; ips: number }[];
  };
};

/*
  Daftar pengelompokan kegagalan. Angka pendampingnya menyebut luas sebarannya, karena satu IP
  dengan 5 kegagalan ke 5 email berbeda adalah pola penebakan, sedangkan 5 kegagalan ke satu
  email yang sama adalah orang salah mengingat kata sandinya.
*/
function FailureList({
  title,
  hint,
  entries,
  emptyText,
}: {
  title: string;
  hint: string;
  entries: { label: string; detail: string; failures: number }[];
  emptyText: string;
}) {
  return (
    <div className="bg-card flex flex-col gap-2 rounded-xl border border-border p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-muted-foreground text-[13px] leading-snug">{hint}</p>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <li key={entry.label} className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="tabular block truncate text-[13px]" title={entry.label}>
                  {entry.label}
                </span>
                <span className="text-muted-foreground text-[13px]">{entry.detail}</span>
              </span>
              <span className="tabular text-[13px] font-semibold">
                {formatNumber(entry.failures)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LoginAttemptsTab() {
  const { query, values, apply } = useAuditQuery<LoginAttemptsResponse>(
    "/api/v1/admin/login-attempts",
  );
  const summary = query.data?.summary;
  const rows = query.data?.attempts ?? [];

  const filters: FilterDefinition[] = [
    {
      kind: "search",
      key: "email",
      label: "Email yang dicoba",
      placeholder: "Sebagian atau seluruh alamat email",
    },
    {
      kind: "search",
      key: "ip_address",
      label: "Alamat IP",
      placeholder: "Contoh 127.0.0.1",
    },
    {
      kind: "select",
      key: "outcome",
      label: "Hasil",
      anyLabel: "Semua hasil",
      options: [
        { value: "failed", label: "Gagal" },
        { value: "success", label: "Berhasil" },
      ],
    },
    { kind: "date", key: "created_from", label: "Dari tanggal" },
    { kind: "date", key: "created_to", label: "Sampai tanggal" },
  ];

  const columns: Column<LoginAttemptRow>[] = [
    {
      key: "created_at",
      header: "Waktu",
      cell: (row) => <Timestamp value={row.created_at} />,
    },
    {
      key: "email",
      header: "Email yang dicoba",
      cell: (row) => (
        <div className="flex flex-col">
          <span className="text-[13px]">{row.email}</span>
          <span className="text-muted-foreground text-[13px]">
            {row.admin
              ? `Akun: ${row.admin.full_name ?? "nama tidak tercatat"}`
              : "Tidak cocok dengan akun mana pun"}
          </span>
        </div>
      ),
    },
    {
      key: "outcome",
      header: "Hasil",
      cell: (row) => (
        <div className="flex flex-col items-start gap-0.5">
          <StatusLabel kind="login_attempt" value={row.success ? "success" : "failed"} />
          {row.success ? null : (
            <span className="text-muted-foreground text-[13px]">
              {failureReasonLabel(row.failure_reason)}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "ip_address",
      header: "Alamat IP",
      cell: (row) => (
        <span className="tabular text-[13px]">{row.ip_address ?? "Tidak dicatat"}</span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {query.status === "galat" ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Percobaan tercatat"
              value={summary ? formatNumber(summary.total) : null}
              hint="Seluruh percobaan, berhasil maupun gagal"
            />
            <StatCard
              label="Berhasil"
              value={summary ? formatNumber(summary.succeeded) : null}
              hint="Percobaan dengan kata sandi yang benar"
            />
            <StatCard
              label="Gagal 24 jam terakhir"
              value={summary ? formatNumber(summary.failed_last_24h) : null}
              hint="Angka yang perlu diperiksa lebih dulu"
              tone={summary && summary.failed_last_24h > 0 ? "danger" : "neutral"}
            />
            <StatCard
              label="Berhasil 24 jam terakhir"
              value={summary ? formatNumber(summary.succeeded_last_24h) : null}
              hint="Termasuk sesi yang dibuat oleh tim sendiri"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <FailureList
              title="Alamat IP dengan kegagalan terbanyak"
              hint="24 jam terakhir. Satu alamat dengan banyak email berbeda menandakan penebakan email."
              entries={(summary?.top_ips_24h ?? []).map((entry) => ({
                label: entry.ip_address ?? "Tidak tercatat",
                detail: `${formatNumber(entry.emails)} email dicoba`,
                failures: entry.failures,
              }))}
              emptyText="Tidak ada percobaan gagal dari alamat mana pun dalam 24 jam terakhir."
            />
            <FailureList
              title="Email dengan kegagalan terbanyak"
              hint="24 jam terakhir. Satu email dengan banyak alamat berbeda menandakan kata sandi yang digempur."
              entries={(summary?.top_emails_24h ?? []).map((entry) => ({
                label: entry.email,
                detail: `${formatNumber(entry.ips)} alamat IP dipakai`,
                failures: entry.failures,
              }))}
              emptyText="Tidak ada email yang gagal masuk dalam 24 jam terakhir."
            />
          </div>

          {summary ? (
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              Batas yang berlaku: {formatNumber(summary.limits.failures_per_account)} kegagalan per
              akun dan {formatNumber(summary.limits.failures_per_ip)} kegagalan per alamat IP dalam{" "}
              {formatNumber(summary.limits.window_minutes)} menit. Setelah batas itu tercapai,
              percobaan berikutnya ditolak tanpa memeriksa kata sandi.
            </p>
          ) : null}
        </>
      )}

      <FilterBar filters={filters} values={values} onChange={apply} onReset={() => apply({})} />

      <DataTable
        label="Percobaan masuk"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat percobaan masuk"
        errorTitle="Percobaan masuk gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) => (row.success ? "success" : "danger")}
        emptyState={
          hasFilter(values) ? (
            <EmptyState
              title="Tidak ada percobaan yang cocok"
              description="Tidak ada percobaan masuk yang sesuai dengan filter yang dipasang. Bersihkan filter untuk melihat seluruh percobaan."
            />
          ) : (
            <EmptyState
              icon={<SignInIcon aria-hidden weight="regular" className="size-6" />}
              title="Belum ada percobaan masuk"
              description="Setiap percobaan masuk ke konsol ini dicatat, termasuk yang gagal. Catatan pertama muncul setelah ada yang mencoba masuk."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="percobaan masuk"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />
    </div>
  );
}

// ------------------------------------------------------------------ tab 3: sesi aktif

type AdminSessionRow = {
  id: string;
  admin: { id: string; full_name: string | null; email: string | null };
  status: string;
  replaced_by_session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  event_count: number;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
};

type SessionsResponse = {
  sessions: AdminSessionRow[];
  summary: { total: number; active: number; revoked: number; expired: number };
};

function SessionsTab() {
  const { query, values, apply } = useAuditQuery<SessionsResponse>("/api/v1/admin/admin-sessions");
  const summary = query.data?.summary;
  const rows = query.data?.sessions ?? [];

  /* Sesi yang sedang dicabut, supaya tombolnya menampilkan keadaan dan tidak diklik dua kali. */
  const [mencabut, setMencabut] = useState<string | null>(null);
  /*
    Sesi milik admin yang sedang masuk tidak ditawarkan untuk dicabut. Server juga menolaknya,
    tetapi menyembunyikan tombolnya lebih baik daripada membiarkan orang menemukan penolakan itu
    setelah mengklik. Yang dibandingkan adalah pemilik sesi, bukan id sesinya, karena id sesi
    tidak disimpan di state: menyimpannya berarti menambah keadaan yang hanya dipakai di sini.
  */
  const adminSendiri = useSessionStore((state) => state.admin?.id);

  async function cabut(sessionId: string) {
    setMencabut(sessionId);
    try {
      const hasil = await mutate<{ note?: string }>(
        `/api/v1/admin/admin-sessions/${sessionId}/revoke`,
        { method: "POST" },
      );
      notifySuccess("Sesi dicabut", hasil.note);
      query.reload();
    } catch (error) {
      notifyError("Sesi gagal dicabut", toErrorMessage(error));
    } finally {
      setMencabut(null);
    }
  }

  const filters: FilterDefinition[] = [
    {
      kind: "select",
      key: "status",
      label: "Keadaan sesi",
      anyLabel: "Semua keadaan",
      options: [
        { value: "active", label: "Masih aktif" },
        { value: "revoked", label: "Sudah dicabut" },
        { value: "expired", label: "Lewat masa berlaku" },
      ],
    },
  ];

  /*
    Sesi yang dicabut karena rotasi token ditandai "Digantikan". Rotasi terjadi setiap kali token
    diperbarui, jadi tanpa pembedaan ini pencabutan paksa akan tenggelam di antara kejadian yang
    sepenuhnya wajar.
  */
  const stateOf = (row: AdminSessionRow) =>
    row.replaced_by_session_id ? "rotated" : row.status;

  const columns: Column<AdminSessionRow>[] = [
    {
      key: "created_at",
      header: "Masuk",
      cell: (row) => <Timestamp value={row.created_at} />,
    },
    {
      key: "admin",
      header: "Admin",
      cell: (row) => <AdminCell admin={row.admin} />,
    },
    {
      key: "status",
      header: "Keadaan",
      cell: (row) => <StatusLabel kind="admin_session" value={stateOf(row)} />,
    },
    {
      key: "expires_at",
      header: "Berlaku sampai",
      cell: (row) => <Timestamp value={row.expires_at} />,
    },
    {
      key: "last_used_at",
      header: "Terakhir dipakai",
      cell: (row) => <Timestamp value={row.last_used_at} fallback="Belum dipakai lagi" />,
    },
    {
      key: "event_count",
      header: "Peristiwa",
      cell: (row) =>
        row.event_count > 0 ? (
          <span className="tabular text-[13px]">{formatNumber(row.event_count)} tercatat</span>
        ) : (
          <span className="text-muted-foreground text-[13px]">Belum ada</span>
        ),
    },
    {
      key: "source",
      header: "Sumber",
      cell: (row) => <SourceCell ipAddress={row.ip_address} userAgent={row.user_agent} />,
    },
    {
      key: "action",
      header: "Tindakan",
      cell: (row) => {
        const masihAktif = row.status === "active" && !row.revoked_at;
        if (!masihAktif) {
          return <span className="text-muted-foreground text-[13px]">Tidak dapat dicabut</span>;
        }
        if (row.admin.id === adminSendiri) {
          return (
            <span className="text-muted-foreground text-[13px]">
              Sesi Anda sendiri
            </span>
          );
        }
        return (
          <Button
            variant="secondary"
            className="h-9 px-3 text-[13px]"
            disabled={mencabut === row.id}
            onClick={() => cabut(row.id)}
          >
            {mencabut === row.id ? <Spinner label="Mencabut" /> : null}
            Cabut sesi
          </Button>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Sesi aktif"
            value={summary ? formatNumber(summary.active) : null}
            hint="Belum dicabut dan belum lewat masa berlakunya"
          />
          <StatCard
            label="Sudah dicabut"
            value={summary ? formatNumber(summary.revoked) : null}
            hint="Termasuk yang digantikan rotasi token"
          />
          <StatCard
            label="Lewat masa berlaku"
            value={summary ? formatNumber(summary.expired) : null}
            hint="Berakhir sendiri tanpa dicabut siapa pun"
          />
          <StatCard
            label="Total sesi"
            value={summary ? formatNumber(summary.total) : null}
            hint="Seluruh sesi yang pernah dibuat"
          />
        </div>
      )}

      <FilterBar filters={filters} values={values} onChange={apply} onReset={() => apply({})} />

      <DataTable
        label="Sesi admin"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat sesi admin"
        errorTitle="Sesi admin gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) => statusTone("admin_session", stateOf(row))}
        emptyState={
          hasFilter(values) ? (
            <EmptyState
              title="Tidak ada sesi yang cocok"
              description="Tidak ada sesi dengan keadaan yang dipilih. Pilih keadaan lain, atau bersihkan filter untuk melihat seluruh sesi."
            />
          ) : (
            <EmptyState
              icon={<KeyIcon aria-hidden weight="regular" className="size-6" />}
              title="Belum ada sesi admin"
              description="Sesi tercatat sejak admin pertama masuk ke konsol ini. Selama belum ada yang masuk, daftarnya memang kosong."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="sesi aktif"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />
    </div>
  );
}

// ------------------------------------------------------------------ tab 4: peristiwa sesi

type SessionEventRow = {
  id: string;
  event_type: string;
  admin: { id: string; full_name: string | null; email: string | null };
  admin_session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: unknown;
  created_at: string;
};

type SessionEventsResponse = {
  events: SessionEventRow[];
  summary: { total: number; last_24h: number; login_24h: number; ended_24h: number };
};

function SessionEventsTab() {
  const { query, values, apply } = useAuditQuery<SessionEventsResponse>(
    "/api/v1/admin/session-events",
  );
  const summary = query.data?.summary;
  const rows = query.data?.events ?? [];

  const filters: FilterDefinition[] = [
    {
      kind: "select",
      key: "event_type",
      label: "Jenis peristiwa",
      anyLabel: "Semua peristiwa",
      /*
        Pilihan ini daftar tertutup dari batasan kolomnya di database, bukan dari data yang ada.
        Menampilkan jenis peristiwa yang belum pernah terjadi tetap berguna di sini, karena
        jawabannya "belum pernah terjadi" juga sebuah jawaban.
      */
      options: [
        { value: "login", label: "Masuk" },
        { value: "refresh", label: "Token diperbarui" },
        { value: "logout", label: "Keluar sendiri" },
        { value: "revoked", label: "Sesi dicabut" },
        { value: "expired", label: "Sesi kedaluwarsa" },
        { value: "password_changed", label: "Kata sandi diubah" },
      ],
    },
    { kind: "date", key: "created_from", label: "Dari tanggal" },
    { kind: "date", key: "created_to", label: "Sampai tanggal" },
  ];

  const columns: Column<SessionEventRow>[] = [
    {
      key: "created_at",
      header: "Waktu",
      cell: (row) => <Timestamp value={row.created_at} />,
    },
    {
      key: "admin",
      header: "Admin",
      cell: (row) => <AdminCell admin={row.admin} />,
    },
    {
      key: "event",
      header: "Peristiwa",
      cell: (row) => (
        <div className="flex flex-col items-start gap-0.5">
          <span className="text-[13px]">{eventLabel(row.event_type)}</span>
          <MetadataLines metadata={row.metadata} />
        </div>
      ),
    },
    {
      key: "session",
      header: "Nomor sesi",
      cell: (row) =>
        row.admin_session_id ? (
          <Identifier value={row.admin_session_id} />
        ) : (
          <span className="text-muted-foreground text-[13px]">Belum tertaut ke sesi</span>
        ),
    },
    {
      key: "source",
      header: "Sumber",
      cell: (row) => <SourceCell ipAddress={row.ip_address} userAgent={row.user_agent} />,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Peristiwa 24 jam terakhir"
            value={summary ? formatNumber(summary.last_24h) : null}
            hint="Seluruh kejadian pada sesi admin"
          />
          <StatCard
            label="Masuk 24 jam terakhir"
            value={summary ? formatNumber(summary.login_24h) : null}
            hint="Sesi baru yang dibuat"
          />
          <StatCard
            label="Berakhir 24 jam terakhir"
            value={summary ? formatNumber(summary.ended_24h) : null}
            hint="Keluar, dicabut, kedaluwarsa, atau kata sandi diganti"
          />
          <StatCard
            label="Total peristiwa"
            value={summary ? formatNumber(summary.total) : null}
            hint="Seluruh catatan siklus hidup sesi"
          />
        </div>
      )}

      <FilterBar filters={filters} values={values} onChange={apply} onReset={() => apply({})} />

      <DataTable
        label="Peristiwa sesi"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat peristiwa sesi"
        errorTitle="Peristiwa sesi gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) => EVENT_TONES[row.event_type] ?? "neutral"}
        emptyState={
          hasFilter(values) ? (
            <EmptyState
              title="Tidak ada peristiwa yang cocok"
              description="Tidak ada peristiwa sesi pada rentang dan jenis yang dipilih. Lebarkan rentang tanggalnya, atau bersihkan filter."
            />
          ) : (
            <EmptyState
              icon={<ListChecksIcon aria-hidden weight="regular" className="size-6" />}
              title="Belum ada peristiwa sesi"
              description="Masuk, keluar, dan pencabutan sesi dicatat di sini. Catatan pertama muncul setelah admin pertama masuk."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="kejadian sesi"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />
    </div>
  );
}

// ------------------------------------------------------------------ kerangka halaman

export function AuditConsole() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit"
        description="Catatan siapa melakukan apa, kapan, dan dari mana. Isinya hanya bisa dibaca, karena catatan yang bisa diubah dari konsol yang sama tidak dapat dipakai sebagai bukti."
      />

      <Tabs defaultValue="jejak-perubahan" className="gap-4">
        {/* TabsList digulir di dalam wadahnya sendiri supaya empat tab tidak memaksa halaman
            melebar di layar sempit. */}
        <div className="overflow-x-auto">
          <TabsList aria-label="Jenis catatan audit">
            <TabsTrigger value="jejak-perubahan">Jejak perubahan</TabsTrigger>
            <TabsTrigger value="percobaan-masuk">Percobaan masuk</TabsTrigger>
            <TabsTrigger value="sesi-aktif">Sesi aktif</TabsTrigger>
            <TabsTrigger value="peristiwa-sesi">Peristiwa sesi</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="jejak-perubahan">
          <ChangeLogTab />
        </TabsContent>
        <TabsContent value="percobaan-masuk">
          <LoginAttemptsTab />
        </TabsContent>
        <TabsContent value="sesi-aktif">
          <SessionsTab />
        </TabsContent>
        <TabsContent value="peristiwa-sesi">
          <SessionEventsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

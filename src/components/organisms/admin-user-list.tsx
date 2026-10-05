"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, Spinner, Timestamp } from "@/components/atoms";
import {
  type Column,
  DataTable,
  EmptyState,
  FilterBar,
  PageHeader,
  Pagination,
  StatCard,
  StatusLabel,
  statusTone,
  TextAreaField,
  TextField,
  type FilterDefinition,
} from "@/components/molecules";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { notifyError, notifySuccess } from "@/lib/alert";
import { toErrorMessage } from "@/lib/http";
import { formatNumber } from "@/lib/format";
import { PASSWORD_HINT, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/password-rules";
import { mutate, tableStatus, useApiQuery, usePagedQuery } from "@/lib/use-api";

/*
  Daftar akun admin.

  Kolom peran dan jumlah peran ditampilkan berdampingan karena akun tanpa peran adalah masalah
  yang mudah terlewat: akun biasa tanpa peran tidak dapat melakukan apa pun, dan di daftar biasa
  ia akan terlihat sama dengan akun lain.

  Satu pengecualian yang penting dan mudah salah: super admin memperoleh seluruh izin tanpa perlu
  peran. Karena itu akun super admin tanpa peran bukanlah masalah, dan menandainya sebagai
  masalah akan membuat peringatan di halaman ini diabaikan.

  Pembuatan akun admin memerlukan peran. Konsol ini tidak menyediakan jalur membuat akun tanpa
  peran, karena akun seperti itu tidak berguna dan hanya membingungkan pemiliknya.
*/

type Row = {
  id: string;
  username: string;
  email: string;
  full_name: string;
  status: string;
  is_super_admin: boolean;
  last_login_at: string | null;
  created_at: string;
  role_count: number;
  roles: string[];
  active_sessions: number;
};

type Response = {
  admin_users: Row[];
  summary: {
    total: number;
    active: number;
    inactive: number;
    locked: number;
    without_role: number;
    super_admins: number;
  };
};

type RoleOption = { id: string; code: string; name: string };

const formAkun = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Nama pengguna minimal 3 karakter.")
    .max(40, "Nama pengguna maksimal 40 karakter.")
    .regex(
      /^[A-Za-z0-9._-]+$/,
      "Nama pengguna hanya boleh berisi huruf, angka, titik, garis bawah, dan tanda hubung.",
    ),
  email: z.email("Alamat email tidak sah."),
  full_name: z
    .string()
    .trim()
    .min(2, "Nama lengkap minimal 2 karakter.")
    .max(120, "Nama lengkap maksimal 120 karakter."),
  /*
    Pemeriksaan kata sandi di layar ini hanya untuk memberi tahu lebih cepat. Yang menentukan
    tetap pemeriksaan di server, dan keduanya membaca batas yang sama dari `@/lib/password-rules`
    supaya tidak pernah berbeda.
  */
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Kata sandi minimal ${PASSWORD_MIN_LENGTH} karakter.`)
    .max(PASSWORD_MAX_LENGTH, "Kata sandi terlalu panjang.")
    .refine((v) => /[a-z]/.test(v), "Tambahkan minimal satu huruf kecil.")
    .refine((v) => /[A-Z]/.test(v), "Tambahkan minimal satu huruf besar.")
    .refine((v) => /[0-9]/.test(v), "Tambahkan minimal satu angka."),
  role_id: z.string().min(1, "Pilih satu peran untuk akun ini."),
});

type FormAkunValues = z.infer<typeof formAkun>;

export function AdminUserList() {
  const query = usePagedQuery<Response>("/api/v1/admin/admin-users");
  const [createOpen, setCreateOpen] = useState(false);

  const filters: FilterDefinition[] = [
    {
      kind: "search",
      key: "q",
      label: "Cari admin",
      placeholder: "Nama pengguna, email, atau nama lengkap",
    },
    {
      kind: "select",
      key: "status",
      label: "Status",
      anyLabel: "Semua status",
      options: [
        { value: "active", label: "Aktif" },
        { value: "inactive", label: "Tidak aktif" },
        { value: "locked", label: "Terkunci" },
      ],
    },
  ];

  const rows = query.data?.admin_users ?? [];
  const summary = query.data?.summary;

  const columns: Column<Row>[] = [
    {
      key: "full_name",
      header: "Nama",
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <Link
            href={`/admin-users/${row.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {row.full_name}
          </Link>
          <span className="text-muted-foreground text-[12px]">
            <span className="tabular">{row.username}</span> · {row.email}
          </span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => <StatusLabel kind="admin_user" value={row.status} />,
    },
    {
      key: "roles",
      header: "Peran",
      cell: (row) =>
        row.role_count === 0 ? (
          /*
            Akun biasa tanpa peran tidak dapat melakukan apa pun, jadi ditulis terang-terangan
            dan bukan dibiarkan tampak seperti kolom kosong biasa. Super admin dikecualikan
            karena ia memperoleh seluruh izin tanpa perlu peran.
          */
          row.is_super_admin ? (
            <span className="text-muted-foreground text-[13px]">
              Tanpa peran, tetapi super admin
            </span>
          ) : (
            <span className="text-warning font-medium text-[13px]">Tidak punya peran</span>
          )
        ) : (
          <span className="tabular text-[13px]">{row.roles.join(", ")}</span>
        ),
    },
    {
      key: "active_sessions",
      header: "Sesi aktif",
      cell: (row) =>
        row.active_sessions > 0 ? (
          <span className="tabular">{formatNumber(row.active_sessions)}</span>
        ) : (
          <span className="text-muted-foreground text-[13px]">Tidak ada</span>
        ),
    },
    {
      key: "last_login_at",
      header: "Terakhir masuk",
      cell: (row) => <Timestamp value={row.last_login_at} fallback="Belum pernah masuk" />,
    },
    {
      key: "created_at",
      header: "Dibuat",
      cell: (row) => <Timestamp value={row.created_at} />,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Admin dan peran"
        description="Akun yang dapat membuka konsol ini, beserta peran yang menentukan apa yang boleh mereka lakukan."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/roles" className="text-[13px] underline-offset-4 hover:underline">
              Kelola peran
            </Link>
            <Button onClick={() => setCreateOpen(true)}>Tambah admin</Button>
          </div>
        }
      />

      {query.status === "galat" ? null : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Admin aktif"
            value={summary ? formatNumber(summary.active) : null}
            hint={`${formatNumber(summary?.total ?? 0)} akun terdaftar seluruhnya`}
          />
          <StatCard
            label="Tanpa peran"
            value={summary ? formatNumber(summary.without_role) : null}
            hint="Akun biasa yang tidak dapat melakukan apa pun di konsol"
            tone={summary && summary.without_role > 0 ? "warning" : "neutral"}
          />
          <StatCard
            label="Tidak aktif"
            value={summary ? formatNumber(summary.inactive) : null}
            hint="Akun yang aksesnya sudah dihentikan"
          />
          <StatCard
            label="Terkunci"
            value={summary ? formatNumber(summary.locked) : null}
            hint="Akun yang dikunci karena percobaan masuk berulang"
            tone={summary && summary.locked > 0 ? "warning" : "neutral"}
          />
        </div>
      )}

      <FilterBar
        filters={filters}
        values={{
          q: query.params.q as string | undefined,
          status: query.params.status as string | undefined,
        }}
        onChange={(next) => query.setParams(next)}
        onReset={() => query.setParams({})}
      />

      <DataTable
        label="Daftar akun admin"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat daftar admin"
        errorTitle="Daftar admin gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        rail={(row) => statusTone("admin_user", row.status)}
        emptyState={
          query.params.q || query.params.status ? (
            <EmptyState
              title="Tidak ada admin yang cocok"
              description="Tidak ada akun yang sesuai dengan filter yang dipasang. Pencarian memakai nama pengguna, email, atau nama lengkap. Bersihkan filter untuk melihat seluruh akun."
            />
          ) : (
            <EmptyState
              title="Belum ada akun admin"
              description="Akun admin pertama dibuat lewat perintah npm run db:create-admin di server, bukan dari halaman ini. Setelah itu, akun berikutnya dapat ditambahkan dari sini."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={rows.length}
        unit="akun admin"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />

      <p className="text-muted-foreground text-[13px] leading-relaxed">
        Izin diberikan lewat peran, tidak langsung ke akun. Untuk mengetahui apa yang sebenarnya
        boleh dilakukan seseorang, buka detail akunnya: di sana terlihat izin efektif gabungan
        dari seluruh perannya.
      </p>

      <CreateAdminDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false);
          query.reload();
        }}
      />
    </div>
  );
}

function CreateAdminDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  /*
    Daftar peran dibaca saat dialog dibuka. Tanpa ini, admin harus tahu kode peran di luar
    kepala, dan salah ketik kode peran hanya akan ketahuan setelah formulir dikirim.
  */
  /*
    Pilihan peran untuk formulir, bukan daftar bertabel: seluruh peran perlu tersedia sekaligus di
    dalam dropdown, jadi tidak ada yang dipaginasi di sini.
  */
  const roles = useApiQuery<{ roles: RoleOption[] }>("/api/v1/admin/roles", { limit: "100" });
  const [selectedRole, setSelectedRole] = useState<string>("");

  const {
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { isSubmitting },
  } = useForm<FormAkunValues>({
    resolver: zodResolver(formAkun),
    defaultValues: { username: "", email: "", full_name: "", password: "", role_id: "" },
  });

  async function submit(values: FormAkunValues) {
    try {
      await mutate("/api/v1/admin/admin-users", {
        method: "POST",
        body: {
          username: values.username,
          email: values.email,
          full_name: values.full_name,
          password: values.password,
          role_ids: [values.role_id],
        },
      });
      notifySuccess(
        "Akun admin dibuat",
        "Kata sandinya tidak ditampilkan lagi, jadi sampaikan kepada pemiliknya lewat jalur yang aman.",
      );
      reset();
      setSelectedRole("");
      onDone();
    } catch (error) {
      notifyError("Akun admin gagal dibuat", toErrorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          setSelectedRole("");
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tambah admin</DialogTitle>
          <DialogDescription>
            Akun baru langsung aktif dan dapat masuk memakai kata sandi yang Anda isi di sini.
            Akun tanpa peran tidak dapat melakukan apa pun, jadi peran wajib dipilih.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <TextField<FormAkunValues>
            control={control}
            name="full_name"
            label="Nama lengkap"
            placeholder="Contoh: Siti Nurhaliza"
            required
          />

          <TextField<FormAkunValues>
            control={control}
            name="username"
            label="Nama pengguna"
            placeholder="Contoh: siti.nurhaliza"
            hint="Dipakai untuk masuk. Hanya huruf, angka, titik, garis bawah, dan tanda hubung."
            autoComplete="off"
            required
          />

          <TextField<FormAkunValues>
            control={control}
            name="email"
            label="Alamat email"
            type="email"
            placeholder="Contoh: siti@nayaka.id"
            autoComplete="off"
            required
          />

          <TextField<FormAkunValues>
            control={control}
            name="password"
            label="Kata sandi awal"
            type="password"
            hint={PASSWORD_HINT}
            autoComplete="new-password"
            required
          />

          {roles.status === "galat" ? (
            <p className="text-destructive text-[13px]">
              Daftar peran gagal dimuat, sehingga akun tidak dapat dibuat dari sini. Muat ulang
              halamannya lalu coba lagi.
            </p>
          ) : roles.data && roles.data.roles.length === 0 ? (
            <p className="text-destructive text-[13px]">
              Belum ada peran yang tersedia. Buat peran lebih dulu di halaman Peran, karena akun
              tanpa peran tidak dapat melakukan apa pun.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor="peran-awal" className="text-[13px] font-medium">
                Peran awal
              </label>
              {/*
                Daftar peran dirender sebagai tombol pilihan, bukan menu tarik, karena jumlahnya
                sedikit dan isinya perlu terbaca sekaligus. Memilih peran berarti memilih cakupan
                kerja, dan itu keputusan yang lebih baik diambil setelah melihat semua pilihan.
              */}
              <div className="flex flex-col gap-2">
                {(roles.data?.roles ?? []).map((role) => {
                  const aktif = selectedRole === role.id;
                  return (
                    <button
                      key={role.id}
                      type="button"
                      aria-pressed={aktif}
                      onClick={() => {
                        setSelectedRole(role.id);
                        setValue("role_id", role.id, { shouldValidate: true });
                      }}
                      className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-[13px] ${
                        aktif
                          ? "border-accent bg-accent/5"
                          : "border-border hover:bg-muted/60"
                      }`}
                    >
                      <span className="font-medium">{role.name}</span>
                      <span className="text-muted-foreground tabular text-[12px]">
                        {role.code}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || !selectedRole}
            >
              {isSubmitting ? <Spinner label="Menyimpan" /> : null}
              Buat akun
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/*
  Dialog untuk menonaktifkan akun diletakkan di komponen terpisah supaya halaman detail bisa
  memakainya juga tanpa menyalin aturannya.
*/
const formNonaktif = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

export function DeactivateAdminDialog({
  open,
  adminUserId,
  fullName,
  onClose,
  onDone,
}: {
  open: boolean;
  adminUserId: string;
  fullName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<z.infer<typeof formNonaktif>>({
    resolver: zodResolver(formNonaktif),
    defaultValues: { reason: "" },
  });

  async function submit(values: { reason: string }) {
    try {
      const result = await mutate<{ effect?: { note?: string } }>(
        `/api/v1/admin/admin-users/${adminUserId}/deactivate`,
        { method: "POST", body: values },
      );
      notifySuccess("Akun dinonaktifkan", result.effect?.note);
      reset();
      onDone();
    } catch (error) {
      notifyError("Akun gagal dinonaktifkan", toErrorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nonaktifkan {fullName}?</DialogTitle>
          <DialogDescription>
            Akun ini tidak dapat masuk lagi, dan seluruh sesinya dicabut saat itu juga. Datanya
            tidak dihapus, dan akun ini masih dapat diaktifkan kembali.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <TextAreaField<z.infer<typeof formNonaktif>>
            control={control}
            name="reason"
            label="Alasan penonaktifan"
            placeholder="Contoh: yang bersangkutan sudah tidak bekerja di perusahaan"
            hint="Tersimpan pada jejak audit."
            required
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" variant="destructive" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Memproses" /> : null}
              Nonaktifkan akun
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

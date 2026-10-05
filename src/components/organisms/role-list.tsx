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
import { mutate, tableStatus, useClientPage, usePagedQuery } from "@/lib/use-api";

/*
  Daftar peran dan izin.

  Halaman ini adalah tempat satu-satunya di mana cakupan kerja seseorang ditentukan, karena izin
  diberikan lewat peran dan bukan langsung ke akun.

  Kolom jumlah pemegang ditampilkan karena perubahan izin sebuah peran berlaku untuk semua
  pemegangnya sekaligus. Mengubah peran yang dipakai lima orang adalah perubahan pada lima orang,
  dan itu perlu terlihat sebelum tombol simpan ditekan.
*/

type Role = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  created_at: string;
  permission_count: number;
  user_count: number;
  permissions: string[];
};

type Permission = {
  code: string;
  name: string;
  description: string | null;
  role_count: number;
};

type Response = { roles: Role[]; permissions: Permission[] };

const formPeran = z.object({
  code: z
    .string()
    .trim()
    .min(2, "Kode peran minimal 2 karakter.")
    .max(40, "Kode peran maksimal 40 karakter.")
    .regex(
      /^[A-Za-z0-9._-]+$/,
      "Kode peran hanya boleh berisi huruf, angka, titik, garis bawah, dan tanda hubung.",
    ),
  name: z
    .string()
    .trim()
    .min(2, "Nama peran minimal 2 karakter.")
    .max(80, "Nama peran maksimal 80 karakter."),
  description: z.string().trim().max(300, "Keterangan maksimal 300 karakter.").optional(),
});

type FormPeranValues = z.infer<typeof formPeran>;

export function RoleList() {
  const query = usePagedQuery<Response>("/api/v1/admin/roles");
  const [createOpen, setCreateOpen] = useState(false);

  const filters: FilterDefinition[] = [
    { kind: "search", key: "q", label: "Cari peran", placeholder: "Kode atau nama peran" },
  ];

  const roles = query.data?.roles ?? [];
  const permissions = query.data?.permissions ?? [];
  /*
    Daftar izin adalah katalog tertutup yang ikut terkirim bersama daftar peran, jadi
    pemotongan barisnya dilakukan di klien: tidak ada permintaan tambahan yang dibutuhkan.
  */
  const halamanIzin = useClientPage(permissions, 20);

  const columns: Column<Role>[] = [
    {
      key: "name",
      header: "Peran",
      cell: (row) => (
        <div className="flex flex-col gap-0.5">
          <Link
            href={`/roles/${row.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {row.name}
          </Link>
          <span className="text-muted-foreground tabular text-[12px]">{row.code}</span>
        </div>
      ),
    },
    {
      key: "description",
      header: "Keterangan",
      cell: (row) =>
        row.description ? (
          <span className="text-[13px]">{row.description}</span>
        ) : (
          <span className="text-muted-foreground text-[13px]">Belum ada keterangan</span>
        ),
    },
    {
      key: "permission_count",
      header: "Jumlah izin",
      align: "right",
      cell: (row) => <span className="tabular">{formatNumber(row.permission_count)}</span>,
    },
    {
      key: "user_count",
      header: "Pemegang",
      align: "right",
      cell: (row) =>
        row.user_count > 0 ? (
          <span className="tabular">{formatNumber(row.user_count)}</span>
        ) : (
          /*
            Peran tanpa pemegang tidak berbahaya, tetapi menandainya membantu membedakan peran
            yang benar-benar dipakai dari peran yang dibuat lalu terlupakan.
          */
          <span className="text-muted-foreground text-[13px]">Belum dipakai</span>
        ),
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
        title="Peran dan izin"
        description="Peran menentukan apa yang boleh dilakukan setiap admin. Izin diberikan lewat peran, tidak langsung ke akun."
        actions={<Button onClick={() => setCreateOpen(true)}>Tambah peran</Button>}
      />

      <FilterBar
        filters={filters}
        values={{ q: query.params.q as string | undefined }}
        onChange={(next) => query.setParams(next)}
        onReset={() => query.setParams({})}
      />

      <DataTable
        label="Daftar peran"
        columns={columns}
        rows={roles}
        getRowId={(row) => row.id}
        status={tableStatus(query.status)}
        loadingLabel="Memuat daftar peran"
        errorTitle="Daftar peran gagal dimuat"
        errorDescription={query.error ?? undefined}
        onRetry={query.reload}
        emptyState={
          query.params.q ? (
            <EmptyState
              title="Tidak ada peran yang cocok"
              description="Tidak ada peran yang sesuai dengan pencarian itu. Bersihkan pencarian untuk melihat seluruh peran."
            />
          ) : (
            <EmptyState
              title="Belum ada peran"
              description="Peran bawaan biasanya sudah terisi oleh proses penyiapan awal. Kalau kosong, jalankan npm run db:seed di server untuk mengisi peran dan izin bawaan."
            />
          )
        }
      />

      <Pagination
        page={query.page}
        limit={query.limit}
        shown={roles.length}
        unit="peran"
        hasMore={query.hasMore}
        onPrev={query.prevPage}
        onNext={query.nextPage}
        onLimitChange={query.setLimit}
      />

      <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Daftar izin</h2>
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Izin tidak dibuat dari halaman ini. Setiap kode izin harus sepadan dengan pemeriksaan
            yang benar-benar ada di server, sehingga izin yang dibuat dari layar saja hanya akan
            menjadi kotak centang yang tidak mengubah apa pun. Kolom pemakai menunjukkan berapa
            peran memegang izin itu.
          </p>
        </div>
        {permissions.length === 0 ? (
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            Daftar izin kosong. Jalankan npm run db:seed di server untuk mengisi izin bawaan.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-[13px]">
              <caption className="sr-only">Seluruh izin yang dikenali server</caption>
              <thead>
                <tr className="text-muted-foreground border-b border-border text-left">
                  <th scope="col" className="py-2 pr-3 font-medium">Kode</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Nama</th>
                  <th scope="col" className="py-2 text-right font-medium">Jumlah peran</th>
                </tr>
              </thead>
              <tbody>
                {halamanIzin.rows.map((permission) => (
                  <tr key={permission.code} className="border-b border-border last:border-0">
                    <td className="tabular py-2.5 pr-3 font-medium">{permission.code}</td>
                    <td className="py-2.5 pr-3">{permission.name}</td>
                    <td className="tabular py-2.5 text-right">
                      {permission.role_count === 0 ? (
                        <span className="text-muted-foreground">Belum dipakai</span>
                      ) : (
                        formatNumber(permission.role_count)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pagination
          page={halamanIzin.page}
          limit={halamanIzin.limit}
          shown={halamanIzin.rows.length}
          unit="izin"
          hasMore={halamanIzin.hasMore}
          onPrev={halamanIzin.prevPage}
          onNext={halamanIzin.nextPage}
          onLimitChange={halamanIzin.setLimit}
        />
      </section>

      <CreateRoleDialog
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

function CreateRoleDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<FormPeranValues>({
    resolver: zodResolver(formPeran),
    defaultValues: { code: "", name: "", description: "" },
  });

  async function submit(values: FormPeranValues) {
    try {
      await mutate("/api/v1/admin/roles", {
        method: "POST",
        body: {
          code: values.code,
          name: values.name,
          description: values.description ?? "",
          /*
            Peran dibuat tanpa izin. Memberi izin dilakukan di halaman detail peran, tempat
            seluruh izin terlihat sekaligus dan akibat perubahan pada pemegangnya juga terlihat.
          */
          permission_codes: [],
        },
      });
      notifySuccess(
        "Peran dibuat",
        "Peran ini belum punya izin dan belum dipegang siapa pun. Buka detailnya untuk memilih izin, lalu berikan perannya ke akun admin.",
      );
      reset();
      onDone();
    } catch (error) {
      notifyError("Peran gagal dibuat", toErrorMessage(error));
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
          <DialogTitle>Tambah peran</DialogTitle>
          <DialogDescription>
            Peran baru dibuat tanpa izin. Setelah tersimpan, buka detailnya untuk memilih izin
            yang diberikan.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
          <TextField<FormPeranValues>
            control={control}
            name="name"
            label="Nama peran"
            placeholder="Contoh: Operator perangkat"
            required
          />
          <TextField<FormPeranValues>
            control={control}
            name="code"
            label="Kode peran"
            placeholder="Contoh: device_operator"
            hint="Dipakai di API dan log. Huruf kecil, angka, titik, garis bawah, dan tanda hubung."
            autoComplete="off"
            required
          />
          <TextAreaField<FormPeranValues>
            control={control}
            name="description"
            label="Keterangan"
            placeholder="Contoh: Menangani pendaftaran dan pemasangan perangkat"
            hint="Membantu admin lain memahami untuk apa peran ini."
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Menyimpan" /> : null}
              Buat peran
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

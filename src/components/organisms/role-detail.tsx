"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, Spinner, Timestamp } from "@/components/atoms";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  StatusLabel,
  TextAreaField,
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
import { mutate, useApiQuery } from "@/lib/use-api";

/*
  Detail peran: memilih izin dan melihat siapa saja yang terpengaruh.

  Satu hal yang menentukan bentuk halaman ini: izin sebuah peran berlaku untuk semua pemegangnya
  sekaligus. Karena itu daftar pemegang ditampilkan tepat di bawah daftar izin, bukan di tab
  terpisah. Mengubah izin tanpa melihat pemegangnya berarti tidak tahu berapa orang yang
  cakupan kerjanya berubah.

  Pencabutan izin mengelola admin dari peran terakhir yang memilikinya ditolak oleh server.
  Pesan penolakan dari server ditampilkan apa adanya, karena pesannya sudah menerangkan siapa
  yang akan kehilangan akses dan apa yang perlu dilakukan lebih dulu.
*/

type Detail = {
  role: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    created_at: string;
    permissions: string[];
    permission_count: number;
  };
  holders: { id: string; full_name: string; username: string; status: string }[];
};

type Permission = { code: string; name: string; description: string | null; role_count: number };

export function RoleDetail({ roleId }: { roleId: string }) {
  const query = useApiQuery<Detail>(`/api/v1/admin/roles/${roleId}`);
  const semuaIzin = useApiQuery<{ permissions: Permission[] }>("/api/v1/admin/permissions");

  const [terpilih, setTerpilih] = useState<string[] | null>(null);
  const [alasanOpen, setAlasanOpen] = useState(false);

  if (query.status === "memuat") return <LoadingState label="Memuat data peran" />;

  if (query.status === "galat" || !query.data) {
    return (
      <ErrorState
        title="Data peran gagal dimuat"
        description={query.error ?? "Server tidak mengirim keterangan galat."}
        onRetry={query.reload}
      />
    );
  }

  const { role, holders } = query.data;
  /* Perubahan lokal dipakai selama ada; sebelum disentuh, yang ditampilkan adalah keadaan server. */
  const izinSaatIni = terpilih ?? role.permissions;
  const berubah =
    terpilih !== null &&
    [...izinSaatIni].sort().join(",") !== [...role.permissions].sort().join(",");

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/roles"
        className="text-muted-foreground w-fit text-[13px] underline-offset-4 hover:underline"
      >
        Daftar peran
      </Link>

      <PageHeader
        title={role.name}
        description={`${role.code}${role.description ? ` · ${role.description}` : ""}`}
        actions={
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-[13px]">
              Dibuat <Timestamp value={role.created_at} />
            </span>
            <Button disabled={!berubah} onClick={() => setAlasanOpen(true)}>
              Simpan izin
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <section className="bg-card flex flex-col gap-3 rounded-xl border border-border p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Izin yang diberikan</h2>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              {terpilih === null
                ? `${formatNumber(role.permission_count)} izin berlaku untuk peran ini.`
                : berubah
                  ? `Perubahan belum disimpan. Setelah disimpan, ${formatNumber(holders.length)} pemegang peran ini akan memakai izin baru, dan seluruh sesinya dicabut agar izin lama tidak tetap berlaku.`
                  : `${formatNumber(role.permission_count)} izin berlaku untuk peran ini.`}
            </p>
          </div>

          {semuaIzin.status === "memuat" ? (
            <LoadingState label="Memuat daftar izin" />
          ) : semuaIzin.status === "galat" || !semuaIzin.data ? (
            <ErrorState
              title="Daftar izin gagal dimuat"
              description={semuaIzin.error ?? "Server tidak mengirim keterangan galat."}
              onRetry={semuaIzin.reload}
            />
          ) : (
            <fieldset className="flex flex-col gap-4">
              <legend className="sr-only">Pilih izin untuk peran ini</legend>
              {Object.entries(kelompokkan(semuaIzin.data.permissions)).map(([modul, daftar]) => (
                <div key={modul} className="flex flex-col gap-1.5">
                  <p className="text-muted-foreground text-[12px] font-medium tracking-wide uppercase">
                    {modul}
                  </p>
                  {daftar.map((permission) => {
                    const dicentang = izinSaatIni.includes(permission.code);
                    return (
                      <label
                        key={permission.code}
                        className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60"
                      >
                        <input
                          type="checkbox"
                          checked={dicentang}
                          onChange={() => {
                            setTerpilih(
                              dicentang
                                ? izinSaatIni.filter((code) => code !== permission.code)
                                : [...izinSaatIni, permission.code],
                            );
                          }}
                          className="accent-accent mt-0.5 size-4"
                        />
                        <span className="flex flex-col gap-0.5">
                          <span className="tabular text-[13px] font-medium">
                            {permission.code}
                          </span>
                          <span className="text-muted-foreground text-[12px]">
                            {permission.name}
                            {permission.role_count > 0
                              ? ` · dipakai ${formatNumber(permission.role_count)} peran lain`
                              : " · belum dipakai peran lain"}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </fieldset>
          )}

          {terpilih !== null && berubah ? (
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setTerpilih(null)}
                className="text-[13px] underline-offset-4 hover:underline"
              >
                Batalkan perubahan
              </button>
              <span className="text-muted-foreground text-[12px]">
                {formatNumber(izinSaatIni.length)} izin terpilih
              </span>
            </div>
          ) : null}
        </section>

        <section className="bg-card flex h-fit flex-col gap-3 rounded-xl border border-border p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Pemegang peran</h2>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              {holders.length === 0
                ? "Belum ada admin yang memegang peran ini, sehingga perubahannya belum berdampak ke siapa pun."
                : `Perubahan izin berlaku untuk ${formatNumber(holders.length)} admin berikut sekaligus.`}
            </p>
          </div>
          {holders.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border">
              {holders.map((user) => (
                <li key={user.id} className="flex items-center justify-between gap-2 py-2.5">
                  <Link
                    href={`/admin-users/${user.id}`}
                    className="text-[13px] underline-offset-4 hover:underline"
                  >
                    {user.full_name}
                  </Link>
                  <StatusLabel kind="admin_user" value={user.status} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      <ReasonDialog
        open={alasanOpen}
        title="Simpan perubahan izin"
        description="Alasan ini tersimpan di jejak audit supaya perubahan izin dapat ditelusuri."
        onClose={() => setAlasanOpen(false)}
        onSubmit={async (reason) => {
          const hasil = await mutate<{ effect?: { note?: string } }>(
            `/api/v1/admin/roles/${roleId}`,
            { method: "PATCH", body: { permission_codes: izinSaatIni, reason } },
          );
          notifySuccess("Izin peran diperbarui", hasil.effect?.note);
          setTerpilih(null);
          setAlasanOpen(false);
          query.reload();
        }}
      />
    </div>
  );
}

/*
  Izin dikelompokkan menurut awalan kodenya. Awalan itulah yang menentukan halaman mana yang
  terbuka, jadi mengelompokkannya membuat seluruh izin satu modul dapat dinilai sekaligus.
*/
function kelompokkan(permissions: Permission[]): Record<string, Permission[]> {
  const hasil: Record<string, Permission[]> = {};
  for (const permission of permissions) {
    const modul = permission.code.split(".")[0] ?? "lain";
    (hasil[modul] ??= []).push(permission);
  }
  return hasil;
}

/*
  Dialog alasan.

  Alasan wajib diisi karena perubahan izin menyentuh cakupan kerja orang lain, dan tanpa alasan
  yang tercatat, perubahan itu tidak dapat ditelusuri beberapa bulan kemudian.
*/
const formAlasan = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Alasan minimal 10 karakter supaya cukup menjelaskan keputusannya.")
    .max(500, "Alasan maksimal 500 karakter."),
});

function ReasonDialog({
  open,
  title,
  description,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const {
    control,
    handleSubmit,
    reset,
    setError,
    formState: { isSubmitting },
  } = useForm<z.infer<typeof formAlasan>>({
    resolver: zodResolver(formAlasan),
    defaultValues: { reason: "" },
  });

  async function kirim(values: { reason: string }) {
    try {
      await onSubmit(values.reason);
      reset();
    } catch (error) {
      /*
        Pesan dari server ditempelkan ke kolom alasannya, bukan hanya muncul sebagai notifikasi.
        Untuk penolakan pencabutan izin mengelola admin, pesannya menyebut siapa yang akan
        kehilangan akses, dan keterangan itu perlu tetap terlihat saat admin memperbaiki isiannya.
      */
      setError("reason", { message: toErrorMessage(error) });
      notifyError("Perubahan gagal disimpan", toErrorMessage(error));
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={handleSubmit(kirim)} className="flex flex-col gap-4">
          <TextAreaField<z.infer<typeof formAlasan>>
            control={control}
            name="reason"
            label="Alasan"
            placeholder="Contoh: operator perangkat perlu dapat menandai perangkat terpasang"
            hint="Tersimpan pada jejak audit."
            required
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Batal
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? <Spinner label="Menyimpan" /> : null}
              Simpan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

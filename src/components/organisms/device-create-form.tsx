"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Button, FieldMessage, Spinner, TextInput } from "@/components/atoms";
import { OncePanel, PageHeader, TextField } from "@/components/molecules";
import { notifyError, notifySuccess } from "@/lib/alert";
import { toErrorMessage } from "@/lib/http";
import { createDeviceDefaults, createDeviceSchema, type CreateDeviceInput } from "@/lib/schemas/admin-device";
import { mutate } from "@/lib/use-api";

/*
  Formulir pendaftaran perangkat.

  Dua hal yang membentuk seluruh bentuk formulir ini:

  1. Kode claim hanya muncul sekali. Server menyimpan sidik jarinya, bukan kodenya, jadi kode
     yang hilang sebelum dicatat tidak dapat ditampilkan lagi. Setelah pendaftaran berhasil,
     formulir diganti panel yang menahan kode itu di layar sampai operator menutupnya sendiri,
     dan panel itu menyebutkan bahwa kode tersebut sudah tidak dapat dilihat lagi.
  2. Nomor seri ketiga (serial, MAC, IMEI) sulit dibaca dari label fisik dan mudah tertukar
     antar perangkat dalam satu batch. Karena itu pemeriksaannya dilakukan sebelum dikirim, dan
     nomor seri yang sudah terdaftar ditolak server dengan pesan yang menyebutkan nomor
     perangkat yang memakainya, bukan sekadar "duplikat".
*/

type CreatedLabel = {
  device: { id: string; device_uid: string; serial_number: string };
  claim_label: { claim_token: string; claim_token_formatted: string; qr_payload: string };
};

export function DeviceCreateForm() {
  const router = useRouter();
  const [created, setCreated] = useState<CreatedLabel | null>(null);

  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateDeviceInput>({
    resolver: zodResolver(createDeviceSchema),
    defaultValues: createDeviceDefaults,
  });

  async function onSubmit(input: CreateDeviceInput) {
    try {
      const result = await mutate<CreatedLabel>("/api/v1/admin/devices", {
        method: "POST",
        body: input,
      });
      setCreated(result);
      notifySuccess(
        "Perangkat terdaftar",
        `Perangkat ${result.device.device_uid} siap dipasang.`,
      );
    } catch (error) {
      /*
        Galat yang menunjuk satu kolom dikembalikan ke kolom itu, supaya pesannya muncul tepat
        di bawah isian yang salah. Sisanya menjadi pesan umum di atas tombol simpan.
      */
      const message = toErrorMessage(error);
      setError("root", { message });
      notifyError("Perangkat tidak dapat didaftarkan", message);
    }
  }

  /*
    Setelah perangkat dibuat, formulir tidak ditampilkan lagi. Mengisi formulir kedua sesudah
    kode pertama muncul adalah cara paling mudah kehilangan kode itu.
  */
  if (created) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Perangkat terdaftar"
          description={`Perangkat ${created.device.device_uid} dengan nomor seri ${created.device.serial_number} sudah masuk inventory.`}
        />

        <OncePanel
          title="Kode claim perangkat"
          description="Catat atau cetak kode ini sekarang. Setelah halaman ini ditutup, kode tidak dapat ditampilkan lagi, karena server hanya menyimpan sidik jarinya."
          codeLabel="Kode claim"
          code={created.claim_label.claim_token_formatted}
          qrPayload={created.claim_label.qr_payload}
          warning="Kode ini adalah satu-satunya jalan bagi pelanggan untuk mengklaim perangkat melalui aplikasi. Kalau kode hilang, buka halaman detail perangkat dan rotasi kodenya untuk menerbitkan kode baru."
          onClose={() => router.push(`/devices/${created.device.id}`)}
        />

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button onClick={() => router.push(`/devices/${created.device.id}`)}>
            Buka halaman perangkat
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setCreated(null);
              router.push("/devices");
            }}
          >
            Kembali ke daftar perangkat
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Daftarkan perangkat"
        description="Isi data perangkat sesuai label dan kemasannya. Nomor seri dan nomor perangkat yang tercetak nanti ditentukan sistem, bukan diketik di sini."
      />

      <form
        noValidate
        onSubmit={handleSubmit(onSubmit)}
        className="bg-card flex flex-col gap-6 rounded-xl border border-border p-5"
      >
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Identitas perangkat</h2>
            <p className="text-muted-foreground text-[13px]">
              Nomor seri wajib diisi dan tidak dapat diubah setelah perangkat terdaftar, karena
              nilai ini tercetak pada label fisik.
            </p>
          </div>

          <TextField<CreateDeviceInput>
            control={control}
            name="serial_number"
            label="Nomor seri"
            placeholder="Contoh SN-2026-000123"
            hint="Tersimpan apa adanya seperti tercetak di label. Huruf besar dan kecil dianggap berbeda."
            required
          />

          <TextField<CreateDeviceInput>
            control={control}
            name="name"
            label="Nama perangkat"
            placeholder="Contoh Kamera Lobby Lantai 1"
            hint="Nama yang dikenali pelanggan atau teknisi. Boleh dikosongkan dan diisi nanti."
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField<CreateDeviceInput>
              control={control}
              name="model"
              label="Model"
              placeholder="Contoh NYK-C200"
            />
            <TextField<CreateDeviceInput>
              control={control}
              name="hardware_revision"
              label="Revisi perangkat keras"
              placeholder="Contoh Rev B"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField<CreateDeviceInput>
              control={control}
              name="batch_number"
              label="Nomor batch"
              placeholder="Contoh BATCH-2026-01"
              hint="Berguna saat satu batch perlu ditelusuri karena masalah produksi."
            />
            <TextField<CreateDeviceInput>
              control={control}
              name="mac_address"
              label="Alamat MAC"
              placeholder="AA:BB:CC:DD:EE:FF"
              hint="Enam pasang angka heksadesimal. Huruf besar dan kecil sama saja."
            />
          </div>

          <TextField<CreateDeviceInput>
            control={control}
            name="imei"
            label="IMEI"
            placeholder="15 angka"
            hint="Hanya bila perangkat memilikinya. Kamera yang tidak memakai kartu seluler biasanya tidak punya IMEI."
          />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="warranty_start_at" className="text-[13px] font-medium">
              Tanggal mulai garansi
            </label>
            <TextInput
              id="warranty_start_at"
              type="date"
              {...register("warranty_start_at")}
              aria-invalid={Boolean(errors.warranty_start_at)}
              aria-describedby={
                errors.warranty_start_at ? "warranty_start_at-error" : "warranty_start_at-hint"
              }
            />
            {errors.warranty_start_at ? (
              <FieldMessage id="warranty_start_at-error" tone="error">
                {errors.warranty_start_at.message}
              </FieldMessage>
            ) : (
              <FieldMessage id="warranty_start_at-hint">
                Garansi dihitung satu tahun sejak tanggal ini. Kosongkan bila belum diketahui.
              </FieldMessage>
            )}
          </div>
        </section>

        {errors.root ? <FieldMessage tone="error">{errors.root.message}</FieldMessage> : null}

        <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={() => router.push("/devices")}
            disabled={isSubmitting}
          >
            Batal
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? <Spinner label="Menyimpan" /> : null}
            {isSubmitting ? "Menyimpan..." : "Daftarkan dan terbitkan kode claim"}
          </Button>
        </div>
      </form>
    </div>
  );
}

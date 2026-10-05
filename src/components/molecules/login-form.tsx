"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useForm } from "react-hook-form";

import { Button, FieldMessage, Spinner } from "@/components/atoms";
import { TextField } from "@/components/molecules";
import { toErrorMessage } from "@/lib/http";
import { adminLoginSchema, type AdminLoginInput } from "@/lib/schemas/admin-auth";
import { useSessionStore } from "@/stores/session-store";

/*
  Formulir masuk.

  Pesan galat dari server sengaja tidak dibedakan antara email yang tidak terdaftar dan kata
  sandi yang salah. Memisahkan keduanya akan memberi tahu penyerang email mana yang punya akun
  admin di sistem ini, dan daftar email admin adalah langkah pertama yang berguna bagi mereka.
*/
export function LoginForm({ lanjut, alasan }: { lanjut: string; alasan?: string }) {
  const router = useRouter();
  const signIn = useSessionStore((state) => state.signIn);
  const load = useSessionStore((state) => state.load);
  const status = useSessionStore((state) => state.status);

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<AdminLoginInput>({
    resolver: zodResolver(adminLoginSchema),
    defaultValues: { email: "", password: "" },
  });

  /*
    Admin yang sudah punya sesi tidak perlu melihat formulir ini. Pemeriksaannya lewat
    /api/v1/admin/me, bukan sekadar melihat ada tidaknya cookie, supaya sesi yang sudah dicabut
    dari halaman /admin-users tetap dianggap tamu di sini.
  */
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (status === "masuk") router.replace(lanjut);
  }, [status, router, lanjut]);

  async function onSubmit(input: AdminLoginInput) {
    try {
      await signIn(input);
      router.replace(lanjut);
    } catch (error) {
      setError("root", { message: toErrorMessage(error) });
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
      {alasan === "sesi-berakhir" ? (
        <FieldMessage>
          Sesi sebelumnya sudah berakhir. Masuk kembali untuk melanjutkan pekerjaan Anda.
        </FieldMessage>
      ) : null}

      <TextField<AdminLoginInput>
        control={control}
        name="email"
        label="Email"
        type="email"
        autoComplete="username"
        placeholder="nama@perusahaan.com"
        required
      />

      <TextField<AdminLoginInput>
        control={control}
        name="password"
        label="Kata sandi"
        type="password"
        autoComplete="current-password"
        required
      />

      {/* Kesalahan yang bukan milik satu kolom, misalnya akun terkunci sementara. */}
      {errors.root ? <FieldMessage tone="error">{errors.root.message}</FieldMessage> : null}

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? <Spinner label="Memeriksa" /> : null}
        {isSubmitting ? "Memeriksa..." : "Masuk"}
      </Button>
    </form>
  );
}

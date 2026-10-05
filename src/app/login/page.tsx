import Image from "next/image";

import { LoginForm } from "@/components/molecules/login-form";

/*
  Halaman masuk.
*/
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;

  /*
    Tujuan setelah masuk diteruskan dari proxy lewat parameter `lanjut`. Nilainya diperiksa
    supaya hanya path internal yang diterima. Tanpa pemeriksaan ini,
    /login?lanjut=https://situs-lain bisa dipakai mengarahkan admin ke halaman tiruan tepat
    setelah ia mengetik kata sandinya.
  */
  const lanjutParam = typeof params.lanjut === "string" ? params.lanjut : "/";
  const lanjut =
    lanjutParam.startsWith("/") && !lanjutParam.startsWith("//") ? lanjutParam : "/";

  const alasan = typeof params.alasan === "string" ? params.alasan : undefined;

  return (
    <>
      <section className="login-identity relative flex min-h-[164px] flex-col justify-between overflow-hidden px-5 py-5 text-white sm:min-h-[190px] sm:px-8 sm:py-7 lg:min-h-full lg:p-8 xl:p-12">
        <div className="relative z-10 flex items-center justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Image
              src="/logos/nayaka-logo-white.png"
              alt="Nayaka"
              width={140}
              height={42}
              preload
              className="h-7 w-auto self-start lg:h-8"
            />
            <div>
              <p className="text-sm font-semibold tracking-tight">PT Nayaka Pratama</p>
              <p className="text-xs text-white/70">Operasional CCTV rumah</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-white/75 lg:hidden">
            <span aria-hidden className="size-2 rounded-full bg-[#06D6A0]" />
            Siap
          </div>
        </div>

        <div className="relative z-10 max-w-md lg:block">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-[#FFD166]">Ruang kerja internal</p>
          <h2 className="max-w-sm text-2xl font-semibold leading-tight tracking-tight sm:text-3xl xl:text-4xl">
            Pantau perangkat. Bantu pelanggan.
          </h2>
          <p className="mt-4 hidden max-w-sm text-sm leading-6 text-white/75 lg:block">
            Satu tempat untuk staf yang mengelola customer, perangkat CCTV, subscription, dan pembayaran.
          </p>
          <div className="mt-6 hidden items-center gap-2 text-xs text-white/75 lg:flex">
            <span aria-hidden className="size-2 rounded-full bg-[#06D6A0]" />
            Sistem siap menerima akses staf
          </div>
        </div>

        <div aria-hidden className="login-lens login-lens-large" />
        <div aria-hidden className="login-lens login-lens-small" />
        <span aria-hidden className="login-crosshair login-crosshair-one" />
        <span aria-hidden className="login-crosshair login-crosshair-two" />
        <span aria-hidden className="login-scanline" />
      </section>

      <section className="login-form-panel flex items-center justify-center px-5 py-9 sm:px-10 lg:px-12 xl:px-16">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col gap-1.5">
            <Image
              src="/logos/nayaka-logo-badge.png"
              alt="Nayaka"
              width={36}
              height={36}
              className="mb-3 size-9 rounded-md lg:hidden"
            />
            <p className="text-muted-foreground text-xs font-medium uppercase tracking-[0.16em]">
              Akses staf · PT Nayaka Pratama
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Masuk ke Nayaka Admin</h1>
            <p className="text-muted-foreground mt-1 text-[13px] leading-5">
              Gunakan akun internal yang diberikan oleh super admin.
            </p>
          </div>

          <LoginForm lanjut={lanjut} alasan={alasan} />
        </div>
      </section>
    </>
  );
}


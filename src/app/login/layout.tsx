import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Masuk",
};

/*
  Layout terpisah untuk halaman login.

  Halaman ini sengaja tidak memakai kerangka admin. Menampilkan sidebar dan topbar kepada orang
  yang belum masuk akan memperlihatkan seluruh peta area kerja, termasuk bagian yang belum jadi,
  tanpa alasan yang berguna.
*/
export default function LoginLayout({ children }: LayoutProps<"/login">) {
  return (
    <div className="login-page min-h-dvh px-3 py-3 sm:px-6 sm:py-8 lg:p-8">
      <div className="login-frame mx-auto grid min-h-[calc(100dvh-1.5rem)] max-w-6xl overflow-hidden rounded-[10px] border border-border sm:min-h-[calc(100dvh-4rem)] lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
        {children}
      </div>
    </div>
  );
}

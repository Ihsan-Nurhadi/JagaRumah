"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { SignOutIcon } from "@phosphor-icons/react/dist/ssr";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmAction, notifyError } from "@/lib/alert";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session-store";

/*
  Menu profil di header.

  Identitas diambil dari state sesi, bukan dari props, supaya header tidak perlu ikut
  diperbarui setiap kali profil berubah.

  Keluar selalu lewat konfirmasi. Tanpa itu, satu klik yang tidak sengaja pada menu
  langsung mengakhiri sesi, dan token CSRF yang jadi tidak valid membuat admin harus
  masuk ulang dari awal.
*/

function initials(name: string): string {
  const parts = name
    .split(/\s+/)
    .filter((part) => /[a-z0-9]/i.test(part))
    .slice(0, 2);
  if (parts.length === 0) return "?";
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

export function ProfileMenu() {
  const router = useRouter();
  const admin = useSessionStore((state) => state.admin);
  const signOut = useSessionStore((state) => state.signOut);
  const [isSigningOut, setIsSigningOut] = useState(false);

  if (!admin) return null;

  const name = admin.full_name?.trim() || admin.email;
  const avatar = admin.avatar_url;

  async function handleSignOut() {
    const confirmed = await confirmAction({
      title: "Keluar dari Nayaka Admin?",
      text: "Sesi Anda di perangkat ini akan diakhiri dan Anda kembali ke halaman masuk.",
      confirmLabel: "Ya, keluar",
      cancelLabel: "Tetap di sini",
      destructive: true,
    });
    if (!confirmed) return;

    setIsSigningOut(true);
    try {
      await signOut();
      router.replace("/login");
    } catch {
      notifyError("Gagal keluar", "Koneksi ke server terputus. Coba lagi.");
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Profil ${name}`}
          className={cn(
            "hover:bg-accent focus-visible:ring-ring flex items-center gap-2 rounded-full py-1 pr-2 pl-1 transition-colors focus-visible:ring-2 focus-visible:outline-none",
            isSigningOut && "pointer-events-none opacity-60",
          )}
        >
          {avatar ? (
            <Image
              src={avatar}
              alt=""
              width={32}
              height={32}
              className="size-8 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="bg-foreground text-background grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold"
            >
              {initials(name)}
            </span>
          )}
          <span className="max-w-32 truncate text-sm font-medium max-sm:hidden">{name}</span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <div className="flex items-center gap-3 px-2 py-2">
          {avatar ? (
            <Image
              src={avatar}
              alt=""
              width={40}
              height={40}
              className="size-10 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="bg-foreground text-background grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold"
            >
              {initials(name)}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="text-muted-foreground truncate text-xs">{admin.email}</p>
          </div>
        </div>

        <DropdownMenuSeparator />

        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="text-muted-foreground text-xs">Peran</span>
          <span className="text-xs font-medium">
            {admin.is_super_admin ? "Super admin" : "Staf"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
          <span className="text-muted-foreground text-xs">Nama pengguna</span>
          <span className="truncate text-xs font-medium">{admin.username}</span>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          variant="destructive"
          disabled={isSigningOut}
          onSelect={() => void handleSignOut()}
        >
          <SignOutIcon aria-hidden weight="regular" className="size-4" />
          {isSigningOut ? "Keluar..." : "Keluar"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

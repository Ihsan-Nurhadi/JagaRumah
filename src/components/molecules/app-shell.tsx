"use client";

import Image from "next/image";
import { CaretDoubleLeftIcon, CaretDoubleRightIcon, ListIcon } from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/atoms";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { navModules } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { useShellStore } from "@/stores/ui-store";

import { NavItem } from "./nav-item";
import { ProfileMenu } from "./profile-menu";
import { ThemeToggle } from "./theme-toggle";

/*
  Nama produk ditampilkan sebagai logo asli pemilik produk dari public/logos.
  Varian dipilih menurut latar tempat logo diletakkan, bukan menurut tema halaman.
*/
function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 px-2.5", collapsed && "justify-center px-0")}>
      {collapsed ? (
        /* Saat sidebar menyempit hanya muat lambangnya, jadi lambang oranye yang dipakai, bukan
           logo lengkap dengan tulisan yang akan terbaca sebagai bercak. */
        <Image
          src="/logos/nayaka-logo-badge.png"
          alt="Nayaka Admin"
          width={28}
          height={28}
          className="size-7 shrink-0 rounded-md"
        />
      ) : (
        <>
          <Image
            src="/logos/nayaka-logo.png"
            alt="Nayaka Admin"
            width={132}
            height={39}
            className="h-7 w-auto dark:hidden"
          />
          <Image
            src="/logos/nayaka-logo-white.png"
            alt="Nayaka Admin"
            width={132}
            height={39}
            className="hidden h-7 w-auto dark:block"
          />
        </>
      )}
    </div>
  );
}

function NavList({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Navigasi utama" className="flex flex-col gap-5">
      {navModules.map((modul) => (
        <div key={modul.label} className="flex flex-col gap-0.5">
          {/*
            Judul kelompok disembunyikan saat sidebar diciutkan, karena ruangnya tidak cukup
            dan labelnya akan terpotong menjadi bercak. Yang tersisa adalah pengelompokan
            jarak antar ikon, dan judulnya tetap ada untuk pembaca layar.
          */}
          <p
            className={cn(
              "text-muted-foreground px-2.5 pb-1 text-[11px] font-medium uppercase tracking-[0.12em]",
              collapsed && "sr-only",
            )}
          >
            {modul.label}
          </p>
          {modul.entries.map((entry) => (
            <NavItem
              key={entry.href}
              entry={entry}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

/*
  Sidebar dipakai karena admin berpindah antar banyak area kerja secara acak,
  dan daftar menetap menjaga orientasi tanpa memakan tinggi tabel.
*/
export function AppShell({ children }: { children: React.ReactNode }) {
  const collapsed = useShellStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useShellStore((state) => state.toggleSidebar);
  const mobileNavOpen = useShellStore((state) => state.mobileNavOpen);
  const setMobileNavOpen = useShellStore((state) => state.setMobileNavOpen);

  return (
    <div className="admin-shell relative flex h-dvh flex-col overflow-hidden md:flex-row">
      <aside
        className={cn(
          "bg-sidebar border-sidebar-border hidden min-h-0 shrink-0 border-r md:flex md:flex-col",
          collapsed ? "md:w-16" : "md:w-64",
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-4">
          <Brand collapsed={collapsed} />
        </div>
        <div className="admin-sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <NavList collapsed={collapsed} />
        </div>
        <div className={cn("shrink-0 border-t border-sidebar-border p-3", collapsed && "px-2")}>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSidebar}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Lebarkan sidebar" : "Ciutkan sidebar"}
            className="ml-auto"
          >
            {collapsed ? (
              <CaretDoubleRightIcon aria-hidden className="size-4" />
            ) : (
              <CaretDoubleLeftIcon aria-hidden className="size-4" />
            )}
          </Button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="admin-header bg-background/95 supports-[backdrop-filter]:bg-background/80 relative z-10 flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-border px-4 backdrop-blur md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="md:hidden">
              <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="Buka navigasi">
                    <ListIcon aria-hidden className="size-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="bg-sidebar w-[min(18rem,calc(100vw-2rem))] p-0">
                  <SheetHeader className="shrink-0 border-b border-sidebar-border p-4">
                    <SheetTitle className="sr-only">Navigasi utama</SheetTitle>
                    <Brand />
                  </SheetHeader>
                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <NavList onNavigate={() => setMobileNavOpen(false)} />
                  </div>
                </SheetContent>
              </Sheet>
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground hidden text-[11px] font-medium uppercase tracking-[0.12em] sm:block">
                Konsol operasional
              </p>
              <p className="truncate text-sm font-semibold md:text-base">Nayaka Admin</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <ThemeToggle />
            <ProfileMenu />
          </div>
        </header>

        <main className="admin-content-scroll relative min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

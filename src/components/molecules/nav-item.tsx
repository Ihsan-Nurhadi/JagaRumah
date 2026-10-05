"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type NavEntry = {
  label: string;
  href: string;
  Icon: React.ComponentType<{
    className?: string;
    weight?: "regular" | "bold";
  }>;
  /* Bagian yang belum dibangun tidak pernah jadi tautan mati. */
  status: "ready" | "planned";
  /*
    Izin yang dibutuhkan untuk membuka halaman ini. Dipakai menyembunyikan entri yang tidak
    bisa dibuka, supaya admin tidak menekan menu yang pasti ditolak server.
  */
  permission?: string;
  /*
    Satu kalimat yang menjawab "menu ini untuk apa". Dipakai sebagai keterangan saat penunjuk
    diarahkan ke entri. Label sidebar harus pendek supaya muat, jadi keterangan inilah tempat
    menjelaskan isinya tanpa memanjangkan label.
  */
  hint?: string;
};

const base =
  "flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors md:min-h-9";

/*
  Keterangan menu muncul saat penunjuk diarahkan ke entri.

  Saat sidebar diciutkan, label hilang dan keterangan inilah satu-satunya cara entri dikenali,
  jadi tooltip wajib ada. Saat sidebar terbuka, tooltip hanya dipasang untuk entri yang punya
  keterangan tambahan, supaya entri yang sudah jelas tidak memunculkan gelembung tanpa isi baru.
*/
function NavHint({
  enabled,
  label,
  hint,
  children,
}: {
  enabled: boolean;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  if (!enabled) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        <span className="block font-medium">{label}</span>
        {hint ? <span className="text-muted-foreground block">{hint}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function NavItem({
  entry,
  collapsed = false,
  onNavigate,
}: {
  entry: NavEntry;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { label, href, Icon, status, hint } = entry;

  /* Entri yang punya keterangan selalu memunculkan tooltip; entri tanpa keterangan hanya perlu
     tooltip saat labelnya tidak terlihat. */
  const hintVisible = collapsed || Boolean(hint);

  if (status === "planned") {
    // TODO: ubah jadi tautan begitu halamannya dibangun.
    return (
      <NavHint enabled label={`${label}, segera`} hint={hint}>
        <span
          aria-disabled="true"
          className={cn(
            base,
            "text-muted-foreground/70 cursor-not-allowed",
            collapsed && "justify-center px-0",
          )}
        >
          <Icon aria-hidden weight="regular" className="size-4 shrink-0" />
          {collapsed ? (
            <span className="sr-only">{label}, segera hadir</span>
          ) : (
            <>
              <span className="flex-1 truncate">{label}</span>
              <span className="text-muted-foreground text-[11px]">Segera</span>
            </>
          )}
        </span>
      </NavHint>
    );
  }

  const active = pathname === href;

  return (
    <NavHint enabled={hintVisible} label={label} hint={hint}>
      <Link
        href={href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          base,
          "hover:bg-muted",
          active && "bg-accent text-accent-foreground hover:bg-accent font-medium",
          collapsed && "justify-center px-0",
        )}
      >
        <Icon aria-hidden weight={active ? "bold" : "regular"} className="size-4 shrink-0" />
        {collapsed ? (
          <span className="sr-only">{label}</span>
        ) : (
          <span className="flex-1 truncate">{label}</span>
        )}
      </Link>
    </NavHint>
  );
}

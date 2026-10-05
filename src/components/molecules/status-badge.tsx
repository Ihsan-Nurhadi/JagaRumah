import { Badge } from "@/components/ui/badge";
import { type Tone } from "@/components/atoms";
import { cn } from "@/lib/utils";

/*
  Status selalu disampaikan sebagai teks di dalam lencana.
  Warnanya hanya menguatkan, tidak menggantikan makna.
  Tanpa border, tanpa glow, tanpa huruf kapital semua, tanpa titik hiasan.
*/
const toneSurface: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  accent: "bg-accent text-accent-foreground",
  success: "bg-success-surface text-success",
  warning: "bg-warning-surface text-warning",
  danger: "bg-danger-surface text-danger",
  info: "bg-info-surface text-info",
};

export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Badge
      className={cn(
        "rounded-sm h-6 px-2 text-[12px] font-medium",
        toneSurface[tone],
        className,
      )}
    >
      {children}
    </Badge>
  );
}

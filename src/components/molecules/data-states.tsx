import { WarningCircleIcon } from "@phosphor-icons/react/dist/ssr";

import { Button, Spinner } from "@/components/atoms";
import { cn } from "@/lib/utils";

/*
  Tiga keadaan wajib untuk setiap tampilan data.
  Masing-masing menyebut sebab dan langkah berikutnya, bukan hanya
  mengatakan bahwa tidak ada data.
*/

function Frame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <Frame>
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground max-w-sm text-[13px]">{description}</p>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </Frame>
  );
}

export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel = "Coba lagi",
}: {
  title: string;
  description: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <Frame className="border-danger/40 bg-danger-surface/40">
      <WarningCircleIcon aria-hidden="true" weight="fill" className="text-danger size-6" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground max-w-sm text-[13px]">{description}</p>
      </div>
      {onRetry ? (
        <div className="mt-1">
          <Button variant="outline" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </Frame>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="text-muted-foreground flex items-center justify-center gap-2 px-6 py-12 text-[13px]"
    >
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

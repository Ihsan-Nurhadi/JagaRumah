"use client";

import { type Tone, StatusRail } from "@/components/atoms";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { ErrorState, LoadingState } from "./data-states";

export type Column<T> = {
  key: string;
  header: string;
  align?: "left" | "right";
  width?: string;
  cell: (row: T) => React.ReactNode;
};

type DataTableProps<T> = {
  label: string;
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  status?: "ready" | "loading" | "error";
  loadingLabel?: string;
  errorTitle?: string;
  errorDescription?: string;
  onRetry?: () => void;
  emptyState: React.ReactNode;
  /* Rail status dipakai untuk menandai keadaan baris, misalnya device disuspend. */
  rail?: (row: T) => Tone;
  className?: string;
};

/*
  Tabel selalu menangani keempat keadaannya sendiri, supaya tidak ada halaman
  yang lupa menyiapkan keadaan kosong, memuat, atau gagal.
*/
export function DataTable<T>({
  label,
  columns,
  rows,
  getRowId,
  status = "ready",
  loadingLabel = "Memuat data",
  errorTitle = "Data gagal dimuat",
  errorDescription = "Server tidak merespons. Coba muat ulang, dan hubungi tim teknis kalau tetap gagal.",
  onRetry,
  emptyState,
  rail,
  className,
}: DataTableProps<T>) {
  if (status === "loading") {
    return <LoadingState label={loadingLabel} />;
  }

  if (status === "error") {
    return (
      <ErrorState title={errorTitle} description={errorDescription} onRetry={onRetry} />
    );
  }

  if (rows.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    /*
      Tabel lebar digulir di dalam wadahnya sendiri supaya halaman tidak
      pernah meluber ke samping di layar kecil. Wadahnya bisa difokus
      keyboard agar bisa digulir tanpa mouse.
    */
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        "focus-visible:ring-ring/50 overflow-x-auto rounded-xl border border-border bg-card focus-visible:ring-3",
        className,
      )}
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {rail ? <TableHead className="w-[3px] p-0" aria-hidden="true" /> : null}
            {columns.map((column) => (
              <TableHead
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={cn(
                  "text-muted-foreground text-[13px] font-medium",
                  column.align === "right" && "text-right",
                )}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={getRowId(row)}>
              {rail ? (
                <TableCell className="relative w-[3px] p-0">
                  <StatusRail
                    tone={rail(row)}
                    className="absolute inset-y-0 left-0 w-[3px]"
                  />
                </TableCell>
              ) : null}
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={cn(column.align === "right" && "text-right")}
                >
                  {column.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

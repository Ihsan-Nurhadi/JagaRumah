"use client";

import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";

import { Button } from "@/components/atoms";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatNumber } from "@/lib/format";
import { PAGE_SIZES } from "@/lib/use-api";

/*
  Kontrol halaman untuk tabel daftar.

  Yang ditampilkan adalah rentang baris pada halaman ini, bukan nomor halaman saja. Server memakai
  cursor, jadi jumlah total tidak diketahui tanpa kueri COUNT terpisah yang mahal untuk tabel
  besar. Karena itu angkanya ditulis "baris 21–40", dan kalimat "masih ada baris berikutnya"
  ditambahkan selama server menyatakan masih ada sisa. Bentuk ini jujur: yang belum diketahui
  tidak ditulis seolah sudah diketahui.

  Tombol "sebelumnya" tetap ada meskipun cursor hanya bisa maju. Cursor halaman yang sudah
  dilewati disimpan pemanggil, jadi mundur memakai posisi yang benar-benar pernah dibuka, bukan
  hasil menebak.
*/
type PaginationProps = {
  page: number;
  limit: number;
  /** Jumlah baris yang benar-benar diterima pada halaman ini. */
  shown: number;
  hasMore: boolean;
  /** Nama isi daftar, dipakai di tengah kalimat: "50 pelanggan". */
  unit: string;
  onPrev: () => void;
  onNext: () => void;
  onLimitChange: (limit: number) => void;
};

export function Pagination({
  page,
  limit,
  shown,
  hasMore,
  unit,
  onPrev,
  onNext,
  onLimitChange,
}: PaginationProps) {
  /*
    Satu halaman tanpa sisa tetap menampilkan ringkasannya. Menyembunyikan seluruh kontrol saat
    hasilnya sedikit membuat tinggi halaman melompat setiap kali filter diganti, dan operator
    kehilangan penanda bahwa daftarnya memang habis sampai di situ.
  */
  const first = (page - 1) * limit + 1;
  const last = first + shown - 1;

  return (
    <nav
      aria-label="Navigasi halaman"
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-muted-foreground text-[13px]" role="status">
        Menampilkan <span className="tabular text-foreground">{formatNumber(shown)}</span> {unit}
        {/*
          Rentang baris hanya ditulis kalau ada baris yang ditampilkan. Daftar kosong tidak punya
          rentang, dan "baris 1–0" terbaca seperti salah hitung.
        */}
        {shown > 0 ? (
          <>
            {" · "}
            <span className="tabular">
              baris {formatNumber(first)}–{formatNumber(last)}
            </span>
          </>
        ) : null}
        {hasMore ? " · masih ada baris berikutnya" : ""}
      </p>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="baris-per-halaman" className="text-muted-foreground text-[13px]">
            Baris per halaman
          </label>
          <Select value={String(limit)} onValueChange={(next) => onLimitChange(Number(next))}>
            <SelectTrigger
              id="baris-per-halaman"
              className="h-9 w-[4.5rem] rounded-md sm:h-8"
              aria-label="Jumlah baris per halaman"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onPrev}
            disabled={page <= 1}
            aria-label="Halaman sebelumnya"
          >
            <CaretLeftIcon aria-hidden />
          </Button>
          <span className="text-muted-foreground text-[13px]">
            Halaman <span className="tabular text-foreground">{formatNumber(page)}</span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onNext}
            disabled={!hasMore}
            aria-label="Halaman berikutnya"
          >
            <CaretRightIcon aria-hidden />
          </Button>
        </div>
      </div>
    </nav>
  );
}

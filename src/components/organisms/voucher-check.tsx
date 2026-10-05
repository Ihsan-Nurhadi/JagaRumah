"use client";

import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Button, Money, Spinner, TextInput } from "@/components/atoms";
import { StatusBadge } from "@/components/molecules";
import { toErrorMessage } from "@/lib/http";
import { mutate } from "@/lib/use-api";

import { formatNominal, type PriceChoice } from "./discount-form";

/*
  Panel uji kode voucher.

  Ini alat operator, dan sekaligus bukti bahwa mesin harga bekerja: hasilnya dihitung dengan fungsi
  yang sama yang dipakai saat menagih, bukan dengan salinan aturan yang ditulis ulang untuk layar
  ini. Kalau dihitung ulang di sini, layar ini akan menjanjikan harga yang berbeda dari yang
  ditagih — persis jenis kesalahan yang paling mahal di modul diskon.

  Dua bagian jawabannya dipisahkan dengan sengaja:

  1. Alasan kode tidak dapat dipakai, semuanya sekaligus. Operator yang memperbaiki satu syarat lalu
     menemukan syarat berikutnya akan menebak-nebak, dan itulah yang membuat promo terasa rumit.

  2. Akibatnya pada tiap harga. Bagian ini yang menunjukkan aturan "potongan tidak menumpuk": bila
     flash sale sedang memberi potongan lebih besar, yang dipakai flash sale, dan kode yang kalah
     tetap ditampilkan sebagai berlaku supaya tidak terlihat seperti kode yang salah.

  Hasil perhitungan sengaja tidak disimpan, karena pemakaian voucher dicatat saat tagihan dibuat,
  bukan saat kode diperiksa. Panel ini karena itu tidak pernah mengubah kuota siapa pun.
*/

type Hasil = {
  code: string;
  applicable: boolean;
  voucher: { code: string; name: string; state_label: string; state: string } | null;
  blockers: { code: string; message: string }[];
  prices: {
    price_id: string;
    plan_id: string;
    amount: string;
    amount_after: number;
    discount_amount: number;
    discount: {
      source: "voucher" | "flash_sale";
      name: string;
      code: string | null;
    } | null;
    vouchers: { id: string; code: string; name: string }[];
    flash_sales: { id: string; name: string }[];
  }[];
  voucher_price_count: number;
  voucher_redemption_count: number;
  total_before: number;
  total_after: number;
  total_discount: number;
};

export function VoucherCheckPanel({ prices }: { prices: PriceChoice[] }) {
  const [code, setCode] = useState("");
  /*
    Harga yang diuji. Kosong berarti seluruh harga paket dihitung sekaligus — dan itu memang
    berguna, karena operator dapat melihat sendiri paket mana yang terdampak tanpa mencoba satu
    per satu.
  */
  const [priceId, setPriceId] = useState("");
  const [hasil, setHasil] = useState<Hasil | null>(null);
  const [galat, setGalat] = useState<string | null>(null);
  const [memuat, setMemuat] = useState(false);

  /* Paket yang punya harga, bukan daftar paket penuh: harga adalah yang dipotong, bukan paketnya. */
  const paketDenganHarga = [...new Map(prices.map((price) => [price.plan_id, price.plan_name])).entries()];

  async function periksa() {
    const kode = code.trim();
    if (kode === "") {
      setGalat("Isi kode voucher yang ingin diperiksa.");
      return;
    }

    setMemuat(true);
    setGalat(null);
    try {
      const jawaban = await mutate<Hasil>("/api/v1/admin/vouchers/check", {
        method: "POST",
        body: {
          code: kode,
          plan_price_id: priceId === "" ? null : priceId,
        },
      });
      setHasil(jawaban);
    } catch (error) {
      /*
        Galat di sini adalah kegagalan menjalankan pemeriksaan, bukan jawaban "kode tidak berlaku".
        Jawaban itu datang sebagai hasil biasa dengan daftar alasan yang terisi.
      */
      setGalat(toErrorMessage(error));
      setHasil(null);
    } finally {
      setMemuat(false);
    }
  }

  return (
    <section className="bg-card flex flex-col gap-4 rounded-xl border border-border p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Uji kode voucher</h2>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Periksa apakah sebuah kode masih berlaku, dan berapa harganya setelah dipotong. Angkanya
          dihitung dengan aturan yang sama yang dipakai saat menagih, termasuk saat kode dan flash
          sale sama-sama berlaku. Pemeriksaan di sini tidak menyimpan apa pun dan tidak mengurangi
          kuota.
        </p>
      </div>

      <form
        className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void periksa();
        }}
      >
        <div className="flex flex-1 flex-col gap-1.5 lg:min-w-56">
          <label htmlFor="uji-kode" className="text-[13px] font-medium">
            Kode voucher
          </label>
          <TextInput
            id="uji-kode"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Contoh: NAYAKA10"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-col gap-1.5 lg:w-72">
          <label htmlFor="uji-harga" className="text-[13px] font-medium">
            Harga yang diuji
          </label>
          <select
            id="uji-harga"
            value={priceId}
            onChange={(event) => setPriceId(event.target.value)}
            className="border-input bg-background focus-visible:ring-ring h-11 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none sm:h-9"
          >
            <option value="">Seluruh harga paket</option>
            {paketDenganHarga.map(([planId, planName]) => (
              <optgroup key={planId} label={planName}>
                {prices
                  .filter((price) => price.plan_id === planId)
                  .map((price) => (
                    <option key={price.id} value={price.id}>
                      {price.billing_interval_label} · {formatNominal(price.amount)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>

        <Button type="submit" disabled={memuat}>
          {memuat ? <Spinner label="Memeriksa" /> : null}
          Periksa kode
        </Button>
      </form>

      {galat ? (
        <p className="text-danger text-[13px]" role="alert">
          {galat}
        </p>
      ) : null}

      {hasil ? <HasilPemeriksaan hasil={hasil} /> : null}
    </section>
  );
}

function HasilPemeriksaan({ hasil }: { hasil: Hasil }) {
  return (
    <div className="flex flex-col gap-4">
      <div
        className={
          hasil.applicable
            ? "border-success/40 bg-success-surface/40 flex flex-col gap-1 rounded-lg border p-3"
            : "border-warning/40 bg-warning-surface/60 flex flex-col gap-1 rounded-lg border p-3"
        }
        role="status"
      >
        <div className="flex items-center gap-2">
          {hasil.applicable ? (
            <CheckCircleIcon aria-hidden weight="fill" className="text-success size-5" />
          ) : (
            <WarningCircleIcon aria-hidden weight="fill" className="text-warning size-5" />
          )}
          <span className="text-sm font-medium">
            {hasil.applicable
              ? `Kode ${hasil.code} masih berlaku`
              : `Kode ${hasil.code} tidak dapat dipakai sekarang`}
          </span>
        </div>

        {hasil.voucher ? (
          <p className="text-muted-foreground text-[13px]">
            {hasil.voucher.name} · {hasil.voucher.state_label}
          </p>
        ) : null}
      </div>

      {hasil.blockers.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[13px] font-medium">Yang menghalangi</h3>
          <ul className="text-muted-foreground flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-relaxed">
            {hasil.blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {hasil.prices.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">
          Belum ada harga paket yang dapat dihitung. Isi harga pada halaman Paket dan harga lebih
          dulu, karena potongan hanya dapat menempel pada harga yang sudah ada.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-[13px] font-medium">Akibatnya pada tiap harga</h3>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              Angka di bawah dihitung atas seluruh harga yang dikirim, termasuk yang tidak dapat
              potongan. Jumlahnya bukan harga yang dibayar siapa pun: satu pelanggan berlangganan
              satu paket, bukan seluruh paket sekaligus.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            {hasil.prices.map((price) => (
              <HargaHasil key={price.price_id} price={price} />
            ))}
          </div>

          <dl className="grid gap-3 border-t border-border pt-3 sm:grid-cols-3">
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground text-[13px]">Sebelum potongan</dt>
              <dd className="tabular text-sm">
                <Money value={hasil.total_before} />
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground text-[13px]">Setelah potongan</dt>
              <dd className="tabular text-sm">
                <Money value={hasil.total_after} />
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground text-[13px]">Total potongan</dt>
              <dd className="tabular text-sm">
                <Money value={hasil.total_discount} />
              </dd>
            </div>
          </dl>

          <p className="text-muted-foreground text-[13px]">
            Cakupan kode ini mencakup {hasil.voucher_price_count} harga, dan sudah dipakai{" "}
            {hasil.voucher_redemption_count} kali.
          </p>
        </div>
      )}
    </div>
  );
}

/*
  Satu harga beserta potongan yang berlaku padanya.

  Aturan yang menang ditulis namanya, dan aturan yang kalah tetap ditampilkan. Kode yang sah tetapi
  kalah oleh flash sale bukan kode yang salah, dan menghilangkannya dari layar akan membuat operator
  mencari-cari kesalahan yang tidak ada.
*/
function HargaHasil({ price }: { price: Hasil["prices"][number] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px]">
          <Money value={Number(price.amount)} /> → <Money value={price.amount_after} />
        </span>
        {price.discount_amount > 0 ? (
          <StatusBadge tone="success">
            <span className="tabular">− {formatNominal(price.discount_amount)}</span>
          </StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Tidak dapat potongan</StatusBadge>
        )}
      </div>

      {price.discount ? (
        <p className="text-muted-foreground text-[13px]">
          Yang dipakai:{" "}
          <span className="text-foreground">
            {price.discount.source === "voucher" ? "Voucher" : "Flash sale"} {price.discount.name}
            {price.discount.code ? ` (${price.discount.code})` : ""}
          </span>
        </p>
      ) : null}

      {price.vouchers.length > 0 || price.flash_sales.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {price.vouchers.map((voucher) => (
            <StatusBadge key={voucher.id} tone="info">
              Voucher {voucher.code}
            </StatusBadge>
          ))}
          {price.flash_sales.map((flashSale) => (
            <StatusBadge key={flashSale.id} tone="info">
              Flash sale {flashSale.name}
            </StatusBadge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

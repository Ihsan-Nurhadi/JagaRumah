/*
  Pilihan yang dibutuhkan formulir diskon.

  Endpoint terpisah, bukan disatukan ke dalam daftar voucher, dengan alasan yang sama seperti endpoint
  `customer-options` yang sudah ada: daftar paket dan harga tidak berubah setiap kali halaman dibuka,
  sedangkan daftar voucher berubah terus. Menggabungkannya berarti mengirim ulang seluruh daftar paket
  pada setiap penekanan "berikutnya".

  Seluruh paket dan harga dikirim apa adanya, termasuk yang tidak aktif, karena operator perlu melihat
  bahwa sebuah harga ada untuk dapat memutuskan apakah promo yang menempel padanya masih masuk akal.
  Penandanya yang membedakan, bukan penyembunyian baris. Menyembunyikan harga tidak aktif akan membuat
  promo yang menempel padanya tampak seperti promo tanpa sasaran.
*/
import {
  flashSaleSummary,
  planOptions,
  priceOptions,
  voucherSummary,
} from "@/lib/server/discounts";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { INTERVAL_LABELS, type BillingInterval } from "@/lib/server/plans";

export const GET = routeHandler("admin.discounts.options", async (request, requestId) => {
  const admin = await requireAdmin();
  /*
    Izin yang diminta hanya `discount.read`, bukan `plan.read`.

    Endpoint ini menerbitkan penjelasan yang menempel pada modul diskon, dan peran yang boleh menyusun
    promo sudah memegang izin itu. Menuntut izin modul paket di sini akan membuat peran keuangan tidak
    bisa membuka halaman diskon, padahal itu justru pekerjaannya.
  */
  requirePermission(admin, "discount.read");

  const [prices, plans, voucher, flashSale] = await Promise.all([
    priceOptions(),
    planOptions(),
    voucherSummary(),
    flashSaleSummary(),
  ]);

  return ok(
    {
      /*
        Harga dikirim rata, lengkap dengan nama paketnya.

        Bentuk rata ini yang dipakai formulir: satu daftar harga yang bisa disaring menurut paket tanpa
        perlu menelusuri struktur bersarang. Nama intervalnya juga sudah diterjemahkan di sini, supaya
        layar tidak perlu menyimpan peta terjemahan yang sama.
      */
      prices: prices.map((price) => ({
        id: price.id,
        plan_id: price.plan_id,
        plan_code: price.plan_code,
        plan_name: price.plan_name,
        plan_is_active: price.plan_is_active,
        billing_interval: price.billing_interval,
        billing_interval_label:
          INTERVAL_LABELS[price.billing_interval as BillingInterval] ?? price.billing_interval,
        amount: price.amount,
        currency: price.currency,
        is_active: price.price_is_active,
      })),
      plans: plans.map((plan) => ({
        id: plan.id,
        code: plan.code,
        name: plan.name,
        is_active: plan.is_active,
        is_free: plan.is_free,
        price_count: plan.price_count,
      })),
      summary: {
        vouchers: {
          total: voucher?.total ?? 0,
          running: voucher?.running ?? 0,
          scheduled: voucher?.scheduled ?? 0,
          ended: voucher?.ended ?? 0,
          exhausted: voucher?.exhausted ?? 0,
          inactive: voucher?.inactive ?? 0,
          redemptions: voucher?.redemptions ?? 0,
        },
        flash_sales: {
          total: flashSale?.total ?? 0,
          running: flashSale?.running ?? 0,
          scheduled: flashSale?.scheduled ?? 0,
          ended: flashSale?.ended ?? 0,
          inactive: flashSale?.inactive ?? 0,
          selected_prices: flashSale?.selected_prices ?? 0,
          plan_count: flashSale?.plan_count ?? 0,
        },
      },
    },
    requestId,
  );
});

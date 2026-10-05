/*
  Satu flash sale: baca, ubah, dan nonaktifkan.

  Yang sengaja tidak diizinkan di sini adalah memindahkan flash sale ke paket lain. Baris flash sale
  terikat pada satu paket, dan aturan bentrok jendela waktu di database bekerja per paket. Memindahkan
  paketnya sama dengan membuat aturan baru yang belum pernah diperiksa bentroknya terhadap flash sale
  lain pada paket tujuan. Bila promo salah paket, yang benar adalah menonaktifkannya lalu membuat yang
  baru untuk paket yang dimaksud.

  Mengubah jendela waktunya tetap diizinkan, dan justru itu yang membuat aturan bentrok di database
  berguna: penyuntingan yang menabrak flash sale lain pada paket yang sama akan ditolak dengan pesan
  yang menyebut nama flash sale yang bentrok.
*/
import { writeAudit } from "@/lib/server/audit";
import { query, queryOne, withTransaction } from "@/lib/server/db";
import {
  operatorFacingError,
  replaceFlashSalePrices,
  resolveWindow,
} from "@/lib/server/discount-input";
import {
  FLASH_SALE_SELECT,
  findFlashSale,
  readFlashSale,
  type FlashSaleRow,
} from "@/lib/server/discounts";
import { AppError, validationError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { flashSaleUpdateSchema } from "@/lib/schemas/admin-discount";

type Params = { params: Promise<{ flash_sale_id?: string }> };

/* Harga terpilih milik flash sale, dipakai layar detail untuk menampilkan harga mana yang terkena. */
async function selectedPrices(flashSaleId: string) {
  return query<{ id: string; plan_name: string; billing_interval: string; amount: string }>(
    `SELECT pr.id,
            p.name AS plan_name,
            pr.billing_interval,
            pr.amount::text AS amount
     FROM plan_flash_sale_prices fp
     JOIN plan_prices pr ON pr.id = fp.plan_price_id
     JOIN subscription_plans p ON p.id = pr.plan_id
     WHERE fp.flash_sale_id = $1
     ORDER BY pr.billing_interval`,
    [flashSaleId],
  );
}

export const GET = routeHandler("admin.flash_sales.detail", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.read");

  const { flash_sale_id: rawId } = await (context as Params).params;
  const flashSaleId = requireUuid(rawId, "flash_sale_id");

  const row = await findFlashSale(flashSaleId);
  if (!row) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message:
        "Flash sale itu tidak ada. Kembali ke daftar flash sale untuk memeriksa yang dimaksud.",
    });
  }

  const prices = await selectedPrices(flashSaleId);

  return ok(
    {
      flash_sale: await readFlashSale(flashSaleId),
      prices: prices.map((price) => ({
        id: price.id,
        plan_name: price.plan_name,
        billing_interval: price.billing_interval,
        amount: price.amount,
      })),
    },
    requestId,
  );
});

export const PATCH = routeHandler("admin.flash_sales.update", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.manage");
  await requireCsrf(request);

  const { flash_sale_id: rawId } = await (context as Params).params;
  const flashSaleId = requireUuid(rawId, "flash_sale_id");

  const input = await parseJson(request, flashSaleUpdateSchema);
  const { startsAt, endsAt } = resolveWindow(input, { requireEndsAt: false });

  await withTransaction(async (client) => {
    /* Baris flash sale dikunci supaya dua penyuntingan bersamaan tidak saling menimpa. */
    const before = await queryOne<FlashSaleRow>(
      `SELECT ${FLASH_SALE_SELECT}
       FROM plan_flash_sales f
       JOIN subscription_plans p ON p.id = f.plan_id
       WHERE f.id = $1
       FOR UPDATE OF f`,
      [flashSaleId],
      client,
    );

    if (!before) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message:
          "Flash sale itu tidak ada. Kembali ke daftar flash sale untuk memeriksa yang dimaksud.",
      });
    }

    const assignments: string[] = [];
    const params: unknown[] = [];
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (input.name !== undefined) {
      assignments.push(`name = $${params.push(input.name)}`);
      changes.name = { from: before.name, to: input.name };
    }
    if (input.description !== undefined) {
      const nilai = input.description?.length ? input.description : null;
      assignments.push(`description = $${params.push(nilai)}`);
      changes.description = { from: before.description, to: nilai };
    }
    if (input.discount_type !== undefined) {
      const percentValue = input.discount_type === "percent" ? (input.percent_value ?? null) : null;
      const fixedAmount = input.discount_type === "fixed" ? (input.fixed_amount ?? null) : null;

      assignments.push(
        `discount_type = $${params.push(input.discount_type)}`,
        `percent_value = $${params.push(percentValue)}`,
        `fixed_amount = $${params.push(fixedAmount)}::numeric`,
      );
      changes.discount_type = { from: before.discount_type, to: input.discount_type };
      changes.percent_value = { from: before.percent_value, to: percentValue };
      changes.fixed_amount = { from: before.fixed_amount, to: fixedAmount };
    }
    if (input.scope !== undefined) {
      assignments.push(`scope = $${params.push(input.scope)}`);
      changes.scope = { from: before.scope, to: input.scope };
    }
    if (input.starts_at !== undefined || input.starts_at_input !== undefined) {
      /*
        Flash sale wajib punya kedua ujung jendela, jadi waktu mulai tidak boleh dikosongkan di sini
        meski skemanya mengizinkan null untuk keperluan voucher.
      */
      if (startsAt === null) {
        throw validationError({ starts_at_input: "Waktu mulai wajib diisi untuk flash sale." });
      }
      assignments.push(`starts_at = $${params.push(startsAt)}`);
      changes.starts_at = { from: before.starts_at.toISOString(), to: startsAt };
    }
    if (input.ends_at !== undefined || input.ends_at_input !== undefined) {
      if (endsAt === null) {
        throw validationError({ ends_at_input: "Waktu berakhir wajib diisi untuk flash sale." });
      }
      assignments.push(`ends_at = $${params.push(endsAt)}`);
      changes.ends_at = { from: before.ends_at.toISOString(), to: endsAt };
    }
    if (input.is_active !== undefined) {
      assignments.push(`is_active = $${params.push(input.is_active)}`);
      changes.is_active = { from: before.is_active, to: input.is_active };
    }

    if (assignments.length === 0 && input.price_ids === undefined && input.scope === undefined) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message: "Tidak ada perubahan yang dikirim. Isi minimal satu kolom lalu simpan.",
      });
    }

    /*
      Daftar harga diganti lebih dulu, sebelum kolom cakupannya berubah.

      Urutan ini penting karena trigger: baris harga ditolak bila cakupannya `all_prices`, dan cakupan
      yang berubah menjadi `all_prices` membuat baris harga yang tersisa menjadi tidak sah. Dengan
      mengosongkan daftarnya lebih dulu, tidak ada saat di mana baris harga lama masih ada sementara
      cakupannya sudah bukan `selected_prices` lagi.

      Harga yang dipilih disaring agar hanya berisi harga dari paket flash sale ini. Tanpa penyaringan
      itu, harga paket lain dapat tersimpan dan cakupan `selected_prices` kehilangan artinya.
    */
    const cakupanAkhir = input.scope ?? before.scope;
    if (input.price_ids !== undefined || input.scope !== undefined) {
      const diminta = cakupanAkhir === "selected_prices" ? (input.price_ids ?? []) : [];
      const sah = diminta.length
        ? await query<{ id: string }>(
            `SELECT id FROM plan_prices
             WHERE id = ANY($1::uuid[]) AND plan_id = $2`,
            [diminta, before.plan_id],
            client,
          ).then((rows) => rows.map((row) => row.id))
        : [];

      await replaceFlashSalePrices(client, flashSaleId, sah);
    }

    if (assignments.length > 0) {
      await query(
        `UPDATE plan_flash_sales SET ${assignments.join(", ")}, updated_at = now()
         WHERE id = $${params.push(flashSaleId)}`,
        params,
        client,
      );
    }

    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "flash_sale.update",
      entityType: "flash_sale",
      entityId: flashSaleId,
      oldData: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.from])),
      newData: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.to])),
    });
  }).catch((error: unknown) => {
    throw operatorFacingError(error) ?? error;
  });

  return ok({ flash_sale: await readFlashSale(flashSaleId) }, requestId);
});

/*
  Menonaktifkan flash sale.

  Dipisahkan dari PATCH supaya tindakan ini punya nama sendiri di jejak audit. Barisnya tidak dihapus,
  karena flash sale yang sudah berjalan pernah memotong harga yang tercatat pada tagihan pelanggan,
  dan catatan itu harus tetap dapat dijelaskan.
*/
export const DELETE = routeHandler("admin.flash_sales.deactivate", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.manage");
  await requireCsrf(request);

  const { flash_sale_id: rawId } = await (context as Params).params;
  const flashSaleId = requireUuid(rawId, "flash_sale_id");

  await withTransaction(async (client) => {
    const before = await queryOne<{ is_active: boolean; name: string }>(
      "SELECT is_active, name FROM plan_flash_sales WHERE id = $1 FOR UPDATE",
      [flashSaleId],
      client,
    );

    if (!before) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message:
          "Flash sale itu tidak ada. Kembali ke daftar flash sale untuk memeriksa yang dimaksud.",
      });
    }

    /* Sudah dimatikan bukan kegagalan: hasil yang diminta memang sudah tercapai. */
    if (before.is_active) {
      await query(
        "UPDATE plan_flash_sales SET is_active = false, updated_at = now() WHERE id = $1",
        [flashSaleId],
        client,
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "flash_sale.deactivate",
        entityType: "flash_sale",
        entityId: flashSaleId,
        oldData: { is_active: true, name: before.name },
        newData: { is_active: false, name: before.name },
      });
    }
  });

  return ok({ flash_sale: await readFlashSale(flashSaleId) }, requestId);
});

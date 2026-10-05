/*
  Satu voucher: baca, ubah, dan nonaktifkan.

  Yang perlu diperhatikan di sini bukan penyuntingannya, melainkan apa yang sengaja TIDAK diizinkan:

  1. Kode tidak dapat diubah setelah voucher dibuat.

     Kode adalah yang diketik pelanggan dan yang tercatat pada riwayat pemakaian. Mengubahnya berarti
     kode lama berhenti bekerja sementara catatan pemakaian lama menunjuk pada kode yang tidak lagi
     ada. Bila operator salah mengetik kode, yang benar adalah mematikan voucher itu dan membuat yang
     baru, sehingga jejaknya tetap terbaca.

  2. Kuota tidak boleh diturunkan di bawah jumlah yang sudah terpakai.

     Kuota 10 yang sudah terpakai 8 berarti tersisa 2. Menurunkannya menjadi 5 membuat sisa kuotanya
     menjadi negatif di layar, dan voucher yang masih tampak berlaku tidak akan pernah bisa dipakai.
     Permintaan seperti itu ditolak dengan menyebut angka yang sudah terpakai.

  3. Voucher tidak dihapus, hanya dinonaktifkan.

     Riwayat pemakaian menunjuk ke baris voucher ini. Menghapusnya memutus catatan siapa memakai kode
     apa, dan itu termasuk data yang harus dapat ditelusuri saat ada sengketa pembayaran.
*/
import { writeAudit } from "@/lib/server/audit";
import { query, queryOne, withTransaction } from "@/lib/server/db";
import { operatorFacingError, replaceVoucherPrices, resolveWindow } from "@/lib/server/discount-input";
import {
  VOUCHER_SELECT,
  findVoucher,
  readVoucher,
  voucherPriceCounts,
  voucherRedemptionCounts,
  type VoucherRow,
} from "@/lib/server/discounts";
import { AppError, validationError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { voucherUpdateSchema } from "@/lib/schemas/admin-discount";

type Params = { params: Promise<{ voucher_id?: string }> };

/*
  Harga terpilih milik voucher.

  Dipakai layar detail untuk menampilkan paket mana yang terkena serta nominal aslinya, sehingga
  operator dapat menilai sendiri apakah potongannya masih masuk akal.
*/
async function selectedPrices(voucherId: string) {
  return query<{
    id: string;
    plan_id: string;
    plan_name: string;
    billing_interval: string;
    amount: string;
  }>(
    `SELECT pr.id,
            pr.plan_id,
            p.name AS plan_name,
            pr.billing_interval,
            pr.amount::text AS amount
     FROM discount_voucher_prices vp
     JOIN plan_prices pr ON pr.id = vp.plan_price_id
     JOIN subscription_plans p ON p.id = pr.plan_id
     WHERE vp.voucher_id = $1
     ORDER BY p.sort_order, p.name, pr.billing_interval`,
    [voucherId],
  );
}

export const GET = routeHandler("admin.vouchers.detail", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.read");

  const { voucher_id: rawId } = await (context as Params).params;
  const voucherId = requireUuid(rawId, "voucher_id");

  const row = await findVoucher(voucherId);
  if (!row) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message: "Voucher itu tidak ada. Kembali ke daftar voucher untuk memeriksa yang dimaksud.",
    });
  }

  const [priceCounts, redemptionCounts, prices] = await Promise.all([
    voucherPriceCounts([voucherId]),
    voucherRedemptionCounts([voucherId]),
    selectedPrices(voucherId),
  ]);

  return ok(
    {
      voucher: await readVoucher(voucherId),
      /*
        Jumlah baris harga dikirim bersama daftarnya supaya layar tidak perlu memutuskan sendiri
        apakah cakupannya `all_prices` hanya dari panjang daftar, yang akan salah ketika aturan
        bercakupan terpilih sedang tidak punya harga sama sekali.
      */
      selected_price_count: priceCounts.get(voucherId) ?? 0,
      redemption_count: redemptionCounts.get(voucherId) ?? 0,
      prices: prices.map((price) => ({
        id: price.id,
        plan_id: price.plan_id,
        plan_name: price.plan_name,
        billing_interval: price.billing_interval,
        amount: price.amount,
      })),
    },
    requestId,
  );
});

export const PATCH = routeHandler("admin.vouchers.update", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.manage");
  await requireCsrf(request);

  const { voucher_id: rawId } = await (context as Params).params;
  const voucherId = requireUuid(rawId, "voucher_id");

  const input = await parseJson(request, voucherUpdateSchema);
  const { startsAt, endsAt } = resolveWindow(input, { requireEndsAt: false });

  const updated = await withTransaction(async (client) => {
    /* Baris voucher dikunci supaya dua penyuntingan bersamaan tidak saling menimpa. */
    const before = await queryOne<VoucherRow>(
      `SELECT ${VOUCHER_SELECT} FROM discount_vouchers v WHERE v.id = $1 FOR UPDATE`,
      [voucherId],
      client,
    );

    if (!before) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message: "Voucher itu tidak ada. Kembali ke daftar voucher untuk memeriksa yang dimaksud.",
      });
    }

    const terpakai = await voucherRedemptionCounts([voucherId], client);
    const jumlahTerpakai = terpakai.get(voucherId) ?? 0;

    /*
      Kuota baru tidak boleh lebih kecil daripada yang sudah terpakai. Bila dibiarkan, sisa kuotanya
      menjadi negatif dan voucher yang masih tampak berlaku tidak akan pernah bisa dipakai.
    */
    if (
      input.max_redemptions !== undefined &&
      input.max_redemptions !== null &&
      input.max_redemptions < jumlahTerpakai
    ) {
      throw validationError({
        max_redemptions:
          `Kuota tidak boleh dikurangi menjadi ${input.max_redemptions}, karena kode ini sudah ` +
          `dipakai ${jumlahTerpakai} kali. Kuota terendah yang masih masuk akal adalah ` +
          `${jumlahTerpakai}.`,
      });
    }

    /*
      Batas per pelanggan dan kuota total diperiksa bersama nilai yang tersimpan, karena salah satu
      di antaranya mungkin tidak dikirim dalam permintaan ini.
    */
    const perPelanggan =
      input.max_redemptions_per_customer !== undefined
        ? input.max_redemptions_per_customer
        : before.max_redemptions_per_customer;
    const totalKuota =
      input.max_redemptions !== undefined ? input.max_redemptions : before.max_redemptions;

    if (perPelanggan !== null && totalKuota !== null && perPelanggan > totalKuota) {
      throw validationError({
        max_redemptions_per_customer:
          `Batas per pelanggan (${perPelanggan}) tidak boleh melebihi kuota total (${totalKuota}).`,
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
      assignments.push(`starts_at = $${params.push(startsAt)}`);
      changes.starts_at = { from: before.starts_at?.toISOString() ?? null, to: startsAt };
    }
    if (input.ends_at !== undefined || input.ends_at_input !== undefined) {
      assignments.push(`ends_at = $${params.push(endsAt)}`);
      changes.ends_at = { from: before.ends_at?.toISOString() ?? null, to: endsAt };
    }
    if (input.max_redemptions !== undefined) {
      assignments.push(`max_redemptions = $${params.push(input.max_redemptions)}`);
      changes.max_redemptions = { from: before.max_redemptions, to: input.max_redemptions };
    }
    if (input.max_redemptions_per_customer !== undefined) {
      assignments.push(
        `max_redemptions_per_customer = $${params.push(input.max_redemptions_per_customer)}`,
      );
      changes.max_redemptions_per_customer = {
        from: before.max_redemptions_per_customer,
        to: input.max_redemptions_per_customer,
      };
    }
    if (input.min_amount !== undefined) {
      assignments.push(`min_amount = $${params.push(input.min_amount)}::numeric`);
      changes.min_amount = { from: before.min_amount, to: input.min_amount };
    }
    if (input.is_active !== undefined) {
      assignments.push(`is_active = $${params.push(input.is_active)}`);
      changes.is_active = { from: before.is_active, to: input.is_active };
    }

    if (assignments.length === 0 && input.price_ids === undefined) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message: "Tidak ada perubahan yang dikirim. Isi minimal satu kolom lalu simpan.",
      });
    }

    /*
      Daftar harga diganti lebih dulu, sebelum kolom cakupannya berubah.

      Urutan ini penting karena dua trigger: baris harga ditolak bila cakupannya `all_prices`, dan
      cakupan yang berubah menjadi `all_prices` membuat baris harga yang tersisa menjadi tidak sah.
      Dengan mengosongkan daftarnya lebih dulu, tidak ada saat di mana baris harga yang lama masih ada
      sementara cakupannya sudah bukan `selected_prices` lagi.
    */
    const cakupanAkhir = input.scope ?? before.scope;
    if (input.price_ids !== undefined || input.scope !== undefined) {
      const daftar = cakupanAkhir === "selected_prices" ? (input.price_ids ?? []) : [];
      await replaceVoucherPrices(client, voucherId, daftar);
    }

    if (assignments.length > 0) {
      await query(
        `UPDATE discount_vouchers SET ${assignments.join(", ")}, updated_at = now()
         WHERE id = $${params.push(voucherId)}`,
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
      action: "voucher.update",
      entityType: "voucher",
      entityId: voucherId,
      oldData: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.from])),
      newData: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.to])),
    });

    return before.code;
  }).catch((error: unknown) => {
    throw operatorFacingError(error) ?? error;
  });

  return ok({ voucher: await readVoucher(voucherId), code: updated }, requestId);
});

/*
  Menonaktifkan voucher.

  Dipisahkan dari PATCH supaya tindakan ini punya nama sendiri di jejak audit, dan supaya tidak
  tercampur dengan penyuntingan biasa. Voucher yang dimatikan tetap tersimpan, lengkap dengan riwayat
  pemakaiannya.
*/
export const DELETE = routeHandler("admin.vouchers.deactivate", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "discount.manage");
  await requireCsrf(request);

  const { voucher_id: rawId } = await (context as Params).params;
  const voucherId = requireUuid(rawId, "voucher_id");

  const code = await withTransaction(async (client) => {
    const before = await queryOne<{ code: string; is_active: boolean }>(
      "SELECT code, is_active FROM discount_vouchers WHERE id = $1 FOR UPDATE",
      [voucherId],
      client,
    );

    if (!before) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message: "Voucher itu tidak ada. Kembali ke daftar voucher untuk memeriksa yang dimaksud.",
      });
    }

    /* Sudah dimatikan bukan kegagalan: hasil yang diminta memang sudah tercapai. */
    if (before.is_active) {
      await query(
        "UPDATE discount_vouchers SET is_active = false, updated_at = now() WHERE id = $1",
        [voucherId],
        client,
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "voucher.deactivate",
        entityType: "voucher",
        entityId: voucherId,
        oldData: { is_active: true, code: before.code },
        newData: { is_active: false, code: before.code },
      });
    }

    return before.code;
  });

  return ok({ voucher: await readVoucher(voucherId), code }, requestId);
});

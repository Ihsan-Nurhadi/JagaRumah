/*
  Perubahan satu baris harga.

  Yang boleh diubah di sini hanya dua: nominal, dan status aktifnya.

  Nominal hanya boleh diubah selama belum ada satu pun langganan yang memakai harga itu. Alasannya
  bukan kehati-hatian berlebihan: harga yang sudah dipakai tercatat sebagai harga langganan, dan
  menimpa nominalnya berarti mengubah apa yang tertulis pada catatan langganan lama. Saat tagihan
  berikutnya diperiksa, tidak ada lagi yang bisa membuktikan berapa harga yang sebenarnya
  disepakati. Karena itu harga yang sudah dipakai dikunci, dan permintaan yang mencoba
  mengubahnya ditolak dengan keterangan sebabnya, bukan diterima diam-diam.

  Harga pengganti tidak dapat dibuat sebagai baris baru untuk interval yang sama, karena database
  hanya menyimpan satu baris harga per paket per interval. Konsekuensinya disebutkan di pesan
  galat supaya operator tidak mencari tombol yang tidak ada.
*/
import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { INTERVAL_LABELS, type BillingInterval } from "@/lib/server/plans";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { normalizeAmount, updatePriceSchema } from "@/lib/schemas/admin-plan";

type Params = { params: Promise<{ price_id?: string }> };

export const PATCH = routeHandler("admin.plan_prices.update", async (request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "plan.manage");
  await requireCsrf(request);

  const { price_id: rawId } = await (context as Params).params;
  const priceId = requireUuid(rawId, "price_id");

  const input = await parseJson(request, updatePriceSchema);

  const result = await withTransaction(async (client) => {
    /*
      Baris harga dikunci bersama jumlah pemakainya. Keduanya dibaca dalam satu kueri karena
      keputusan "nominal boleh diubah atau tidak" bergantung pada angka itu: kalau dibaca
      terpisah, langganan baru bisa dibuat di antara kedua kueri dan nominal yang seharusnya
      terkunci tetap tertimpa.

      `FOR UPDATE OF pr` mengunci baris harganya saja, bukan baris paket yang ikut di-join.
    */
    const before = await queryOne<{
      plan_id: string;
      plan_name: string;
      billing_interval: string;
      amount: string;
      is_active: boolean;
      subscription_count: number;
    }>(
      `SELECT pr.plan_id,
              p.name AS plan_name,
              pr.billing_interval,
              pr.amount::text AS amount,
              pr.is_active,
              (SELECT count(*)::int FROM subscriptions s WHERE s.plan_price_id = pr.id)
                AS subscription_count
       FROM plan_prices pr
       JOIN subscription_plans p ON p.id = pr.plan_id
       WHERE pr.id = $1
       FOR UPDATE OF pr`,
      [priceId],
      client,
    );

    if (!before) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message:
          "Harga itu tidak ada. Kembali ke daftar paket untuk memeriksa harga yang dimaksud.",
      });
    }

    if (input.amount !== undefined && before.subscription_count > 0) {
      const interval =
        INTERVAL_LABELS[before.billing_interval as BillingInterval] ?? before.billing_interval;

      throw new AppError({
        code: "PLAN_PRICE_INVALID",
        message:
          `Nominal harga ${interval} paket ${before.plan_name} tidak diubah karena harga itu ` +
          `sudah dipakai ${before.subscription_count} langganan. Menimpa nominalnya akan ` +
          `mengubah harga yang tercatat pada langganan lama. Satu paket juga hanya menyimpan ` +
          `satu harga per interval, jadi harga pengganti tidak dapat dibuat untuk interval yang ` +
          `sama. Buat paket baru dengan nominal yang baru, lalu pindahkan langganannya.`,
        details: {
          price_id: priceId,
          subscription_count: before.subscription_count,
          current_amount: before.amount,
        },
      });
    }

    const assignments: string[] = [];
    const params: unknown[] = [];
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (input.amount !== undefined) {
      const amount = normalizeAmount(input.amount);
      assignments.push(`amount = $${params.push(amount)}`);
      changes.amount = { from: before.amount, to: amount };
    }
    if (input.is_active !== undefined) {
      assignments.push(`is_active = $${params.push(input.is_active)}`);
      changes.is_active = { from: before.is_active, to: input.is_active };
    }

    if (assignments.length === 0) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message: "Tidak ada perubahan yang dikirim. Isi minimal satu kolom lalu simpan.",
      });
    }

    const updated = await queryOne<{ amount: string; is_active: boolean; updated_at: Date }>(
      `UPDATE plan_prices SET ${assignments.join(", ")} WHERE id = $${params.push(priceId)}
       RETURNING amount::text AS amount, is_active, updated_at`,
      params,
      client,
    );

    await writeAudit(client, {
      actor: {
        adminUserId: admin.identity.id,
        ipAddress: admin.ipAddress,
        userAgent: admin.userAgent,
      },
      action: "plan_price.update",
      entityType: "plan_price",
      entityId: priceId,
      oldData: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.from])),
      newData: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.to])),
    });

    return {
      amount: updated?.amount ?? before.amount,
      isActive: updated?.is_active ?? before.is_active,
      updatedAt: updated?.updated_at ?? new Date(),
    };
  });

  return ok(
    {
      price: {
        id: priceId,
        amount: result.amount,
        is_active: result.isActive,
        updated_at: result.updatedAt.toISOString(),
      },
    },
    requestId,
  );
});

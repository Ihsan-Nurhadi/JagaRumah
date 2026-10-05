/*
  Detail pelanggan.

  Isi halaman detail dipilih berdasarkan pertanyaan yang benar-benar muncul saat support
  menangani keluhan:

  - Perangkat apa saja yang terpasang? Ini pertanyaan pertama, karena paling sering jadi sumber
    keluhan.
  - Langganannya bagaimana? Paket apa, masih berjalan atau tidak.
  - Tagihannya bagaimana? Apakah menunggak.
  - Kapan terakhir masuk? Kalau pelanggan mengaku tidak bisa masuk aplikasi, ini jawabannya.

  Data ini dikirim dalam satu response supaya halaman detail tidak perlu memanggil empat endpoint
  terpisah, yang berarti empat kesempatan gagal dan empat keadaan memuat yang harus ditangani.
*/
import { writeAudit } from "@/lib/server/audit";
import { query, queryOne, withTransaction } from "@/lib/server/db";
import { findCustomer, lockCustomer } from "@/lib/server/customers";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { activateCustomerSchema, updateCustomerSchema } from "@/lib/schemas/admin-customer";

type Params = { params: Promise<{ customer_id?: string }> };

export const GET = routeHandler("admin.customers.detail", async (_request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "customer.read");

  const { customer_id: rawId } = await (context as Params).params;
  const customerId = requireUuid(rawId, "customer_id");

  const customer = await findCustomer(customerId);
  if (!customer) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message:
        "Pelanggan itu tidak ditemukan. Periksa kembali tautannya, atau cari pelanggannya lewat " +
        "halaman daftar pelanggan.",
    });
  }

  const [authAccounts, devices, subscription, invoices] = await Promise.all([
    query<{
      id: string;
      provider: string;
      email: string | null;
      phone_e164: string | null;
      is_verified: boolean;
      last_login_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, provider, email::text AS email, phone_e164, is_verified, last_login_at, created_at
       FROM customer_auth_accounts WHERE customer_id = $1 ORDER BY created_at`,
      [customerId],
    ),
    query<{
      id: string;
      device_uid: string;
      serial_number: string;
      name: string | null;
      model: string | null;
      status: string;
      claim_method: string | null;
      claimed_at: Date | null;
    }>(
      `SELECT id, device_uid, serial_number, name, model, status, claim_method, claimed_at
       FROM devices
       WHERE customer_id = $1 AND status <> 'deleted'
       ORDER BY claimed_at NULLS LAST, created_at`,
      [customerId],
    ),
    queryOne<{
      id: string;
      status: string;
      plan_name: string | null;
      plan_code: string | null;
      device_limit: number | null;
      started_at: Date | null;
      current_period_end: Date | null;
      canceled_at: Date | null;
      price_amount: string | null;
      price_interval: string | null;
    }>(
      `SELECT s.id, s.status, p.name AS plan_name, p.code AS plan_code, p.device_limit,
              s.started_at, s.current_period_end, s.canceled_at,
              pr.amount::text AS price_amount, pr.billing_interval AS price_interval
       FROM subscriptions s
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       LEFT JOIN plan_prices pr ON pr.plan_id = p.id AND pr.is_active
       WHERE s.customer_id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [customerId],
    ),
    query<{
      id: string;
      invoice_number: string | null;
      status: string;
      total_amount: string;
      amount_paid: string;
      currency: string;
      due_at: Date | null;
      paid_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, invoice_number, status, total_amount::text, amount_paid::text, currency,
              due_at, paid_at, created_at
       FROM invoices WHERE customer_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [customerId],
    ),
  ]);

  const activeDevices = devices.filter((device) => device.status === "claimed").length;

  return ok(
    {
      customer: {
        id: customer.id,
        full_name: customer.full_name,
        status: customer.status,
        email: customer.email,
        phone_e164: customer.phone_e164,
        providers: customer.providers ?? [],
        created_at: customer.created_at.toISOString(),
      },
      auth_accounts: authAccounts.map((account) => ({
        id: account.id,
        provider: account.provider,
        email: account.email,
        phone_e164: account.phone_e164,
        is_verified: account.is_verified,
        last_login_at: account.last_login_at?.toISOString() ?? null,
        created_at: account.created_at.toISOString(),
      })),
      devices: devices.map((device) => ({
        id: device.id,
        device_uid: device.device_uid,
        serial_number: device.serial_number,
        name: device.name,
        model: device.model,
        status: device.status,
        claim_method: device.claim_method,
        claimed_at: device.claimed_at?.toISOString() ?? null,
      })),
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            plan_name: subscription.plan_name,
            plan_code: subscription.plan_code,
            /*
              Batas paket dikirim bersama jumlah perangkat aktif, karena satu angka tanpa yang
              lain tidak bisa ditafsirkan: "3 perangkat" berarti apa pun tergantung batasnya.
            */
            device_limit: subscription.device_limit,
            device_limit_unlimited: subscription.device_limit === null,
            active_device_count: activeDevices,
            price_amount: subscription.price_amount,
            price_interval: subscription.price_interval,
            started_at: subscription.started_at?.toISOString() ?? null,
            current_period_end: subscription.current_period_end?.toISOString() ?? null,
            canceled_at: subscription.canceled_at?.toISOString() ?? null,
          }
        : null,
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        invoice_number: invoice.invoice_number,
        status: invoice.status,
        total_amount: invoice.total_amount,
        amount_paid: invoice.amount_paid,
        currency: invoice.currency,
        due_at: invoice.due_at?.toISOString() ?? null,
        paid_at: invoice.paid_at?.toISOString() ?? null,
        created_at: invoice.created_at.toISOString(),
      })),
      /*
        Pelanggan dengan perangkat terpasang tidak boleh ditangguhkan tanpa disadari. Angka ini
        dipakai antarmuka untuk meminta persetujuan tambahan sebelum menangguhkan.
      */
      suspend_impact: {
        active_devices: activeDevices,
        has_devices: activeDevices > 0,
      },
    },
    requestId,
  );
});

/*
  Perbaikan nama pelanggan.

  Hanya nama yang dapat diubah di sini. Status punya endpoint sendiri yang mewajibkan alasan,
  dan cara masuk (email, WhatsApp, Google) adalah milik pelanggan: mengubahnya dari sisi admin
  akan melewati verifikasi, dan itu berarti admin bisa mengalihkan akun ke alamat yang tidak
  pernah dikonfirmasi pemiliknya.
*/
export const PATCH = routeHandler(
  "admin.customers.update",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "customer.update");
    await requireCsrf(request);

    const { customer_id: rawId } = await (context as Params).params;
    const customerId = requireUuid(rawId, "customer_id");
    const input = await parseJson(request, updateCustomerSchema);

    const result = await withTransaction(async (client) => {
      const before = await lockCustomer(client, customerId);

      if (before.status === "deleted") {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message:
            `Akun ${before.full_name} sudah dihapus dan tidak dapat diubah. Histori tagihannya ` +
            `tetap tersimpan, tetapi datanya tidak lagi menjadi bagian dari pekerjaan harian.`,
        });
      }

      await client.query("UPDATE customers SET full_name = $2 WHERE id = $1", [
        customerId,
        input.full_name,
      ]);

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "customer.update",
        entityType: "customer",
        entityId: customerId,
        oldData: { full_name: before.full_name },
        newData: { full_name: input.full_name },
      });

      return { fullName: input.full_name };
    });

    return ok({ customer: { id: customerId, full_name: result.fullName } }, requestId);
  },
);

/*
  Menghapus pelanggan dari konsol.

  Penghapusan di sini bukan DELETE baris: status pelanggan berubah menjadi `deleted`, seluruh
  sesi aplikasinya dicabut, dan histori tagihan serta auditnya tetap tersimpan. Ini pola yang
  sama dengan penghapusan oleh pelanggan sendiri dari aplikasi, supaya "akun dihapus" punya
  satu arti saja di seluruh sistem.

  Alasan wajib, sama seperti penangguhan: akun yang dihapus menghilang dari daftar, dan
  pertanyaan "kemana akun ini" harus bisa dijawab dari catatan, bukan dari ingatan.
*/
export const DELETE = routeHandler(
  "admin.customers.delete",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "customer.delete");
    await requireCsrf(request);

    const { customer_id: rawId } = await (context as Params).params;
    const customerId = requireUuid(rawId, "customer_id");
    const input = await parseJson(request, activateCustomerSchema);

    const result = await withTransaction(async (client) => {
      const customer = await lockCustomer(client, customerId);

      if (customer.status === "deleted") {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message: `Akun ${customer.full_name} sudah dihapus sebelumnya. Histori tagihannya tetap tersimpan.`,
        });
      }

      /*
        Perangkat yang masih terpasang pada akun yang dihapus dilepas lebih dulu mengikuti pola
        unassign resmi: kembali ke gudang, metode klaim dibersihkan, supaya perangkat itu bisa
        diklaim lagi oleh akun lain. Tanpa ini, perangkat pelanggan yang dihapus tersangkut
        selamanya pada akun yang tidak bisa masuk.
      */
      const devices = await client.query(
        `UPDATE devices
         SET customer_id = NULL, status = 'in_stock', claim_method = NULL,
             claimed_at = NULL, activated_at = NULL, deactivated_at = now()
         WHERE customer_id = $1 AND status = 'claimed'`,
        [customerId],
      );

      await client.query("UPDATE customers SET status = 'deleted' WHERE id = $1", [customerId]);

      const sessions = await client.query(
        `UPDATE customer_sessions SET revoked_at = now()
         WHERE customer_id = $1 AND revoked_at IS NULL`,
        [customerId],
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "customer.delete",
        entityType: "customer",
        entityId: customerId,
        oldData: { status: customer.status, full_name: customer.full_name },
        newData: {
          status: "deleted",
          reason: input.reason,
          devices_released: devices.rowCount ?? 0,
          sessions_revoked: sessions.rowCount ?? 0,
        },
      });

      return {
        name: customer.full_name,
        devicesReleased: devices.rowCount ?? 0,
        sessionsRevoked: sessions.rowCount ?? 0,
      };
    });

    return ok(
      {
        customer: { id: customerId, status: "deleted" },
        effect: {
          devices_released: result.devicesReleased,
          sessions_revoked: result.sessionsRevoked,
          note:
            result.devicesReleased > 0
              ? `${result.devicesReleased} perangkat dilepas dan dapat diklaim akun lain. Histori tagihan tetap tersimpan.`
              : "Histori tagihan pelanggan tetap tersimpan.",
        },
      },
      requestId,
    );
  },
);

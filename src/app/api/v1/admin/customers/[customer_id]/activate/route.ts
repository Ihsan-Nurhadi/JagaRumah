/*
  Mengaktifkan kembali pelanggan yang ditangguhkan.

  Alasan tetap wajib meski tindakan ini terasa seperti "mengembalikan ke keadaan semula".
  Pertanyaan yang perlu bisa dijawab adalah "atas dasar apa akun ini dinyalakan lagi", dan itu
  sama pentingnya dengan alasan penangguhannya.

  Yang perlu diketahui operator: mengaktifkan akun tidak menghidupkan kembali sesi pelanggan.
  Sesi lama sudah dicabut saat penangguhan, jadi pelanggan perlu masuk kembali di aplikasinya.
  Hal itu dinyatakan di response supaya operator tidak menjanjikan hal yang keliru.
*/
import { writeAudit } from "@/lib/server/audit";
import { withTransaction } from "@/lib/server/db";
import { lockCustomer } from "@/lib/server/customers";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { activateCustomerSchema } from "@/lib/schemas/admin-customer";

type Params = { params: Promise<{ customer_id?: string }> };

export const POST = routeHandler(
  "admin.customers.activate",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "customer.suspend");
    await requireCsrf(request);

    const { customer_id: rawId } = await (context as Params).params;
    const customerId = requireUuid(rawId, "customer_id");
    const input = await parseJson(request, activateCustomerSchema);

    await withTransaction(async (client) => {
      const customer = await lockCustomer(client, customerId);

      if (customer.status === "deleted") {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message:
            `Akun ${customer.full_name} sudah dihapus dan tidak dapat diaktifkan lagi. Kalau ` +
            `pelanggan ini ingin berlangganan kembali, ia perlu mendaftar sebagai akun baru.`,
        });
      }

      if (customer.status === "active") {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            `Akun ${customer.full_name} sudah aktif, jadi tidak ada yang perlu diaktifkan. ` +
            `Muat ulang halaman ini untuk melihat keadaan terbarunya.`,
          details: { customer_status: customer.status },
        });
      }

      await client.query("UPDATE customers SET status = 'active' WHERE id = $1", [customerId]);

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "customer.activate",
        entityType: "customer",
        entityId: customerId,
        oldData: { status: customer.status },
        newData: { status: "active", reason: input.reason },
      });

      return { name: customer.full_name };
    });

    return ok(
      {
        customer: { id: customerId, status: "active" },
        effect: {
          sessions_revoked_earlier: true,
          note:
            "Sesi pelanggan yang lama tidak dihidupkan kembali. Pelanggan perlu masuk ulang di " +
            "aplikasinya sebelum perangkatnya bisa dipakai lagi.",
        },
      },
      requestId,
    );
  },
);

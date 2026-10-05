/*
  Menangguhkan pelanggan.

  Menangguhkan akun adalah tindakan yang punya akibat nyata: perangkat pelanggan berhenti
  melayani, dan kalau pelanggan sedang menonton rekaman, aksesnya terputus. Karena itu:

  - Alasan wajib, dan ditulis ke audit_logs. Pertanyaan "kenapa akun pelanggan ini dimatikan"
    harus bisa dijawab berbulan-bulan kemudian.
  - Kalau pelanggan masih punya perangkat terpasang, permintaan tanpa `acknowledge_devices`
    ditolak dengan menyebut jumlah perangkatnya. Ini bukan basa-basi: menangguhkan pelanggan
    yang punya tiga kamera berjalan punya akibat yang jauh berbeda daripada menangguhkan akun
    yang belum pernah memasang apa pun.
  - Sesi aktif pelanggan dicabut. Kalau tidak, aplikasi di ponsel pelanggan tetap memegang token
    yang masih berlaku sampai kedaluwarsa, dan pelanggan yang ditangguhkan masih bisa membuka
    aplikasinya untuk sementara. Itu membuat penangguhan terlihat tidak bekerja.
*/
import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import { lockCustomer } from "@/lib/server/customers";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { suspendCustomerSchema } from "@/lib/schemas/admin-customer";

type Params = { params: Promise<{ customer_id?: string }> };

const alreadySuspended = (name: string, status: string) =>
  new AppError({
    code: "VALIDATION_ERROR",
    message:
      `Akun ${name} berstatus "${status}", jadi tidak ada yang perlu ditangguhkan. ` +
      `Muat ulang halaman ini untuk melihat keadaan terbarunya.`,
    details: { customer_status: status },
  });

export const POST = routeHandler(
  "admin.customers.suspend",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "customer.suspend");
    await requireCsrf(request);

    const { customer_id: rawId } = await (context as Params).params;
    const customerId = requireUuid(rawId, "customer_id");
    const input = await parseJson(request, suspendCustomerSchema);

    const result = await withTransaction(async (client) => {
      const customer = await lockCustomer(client, customerId);

      if (customer.status === "deleted") {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message: `Akun ${customer.full_name} sudah dihapus dan tidak dapat ditangguhkan lagi.`,
        });
      }

      if (customer.status === "suspended") {
        throw alreadySuspended(customer.full_name, customer.status);
      }

      /*
        Jumlah perangkat dibaca di dalam transaksi yang sama dengan penguncian baris pelanggan,
        sehingga angkanya tidak berubah antara saat diperiksa dan saat penangguhan dijalankan.
      */
      const devices = await queryOne<{ active_devices: number }>(
        `SELECT count(*)::int AS active_devices FROM devices
         WHERE customer_id = $1 AND status = 'claimed'`,
        [customerId],
        client,
      );
      const activeDevices = devices?.active_devices ?? 0;

      if (activeDevices > 0 && !input.acknowledge_devices) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            `${customer.full_name} masih punya ${activeDevices} perangkat terpasang. Konfirmasi ` +
            `bahwa perangkat tersebut ikut berhenti melayani sebelum menangguhkan akunnya.`,
          details: { active_devices: activeDevices, needs_acknowledgement: true },
        });
      }

      await client.query("UPDATE customers SET status = 'suspended' WHERE id = $1", [customerId]);

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
        action: "customer.suspend",
        entityType: "customer",
        entityId: customerId,
        oldData: { status: customer.status },
        newData: {
          status: "suspended",
          reason: input.reason,
          active_devices: activeDevices,
          sessions_revoked: sessions.rowCount ?? 0,
        },
      });

      return {
        name: customer.full_name,
        activeDevices,
        revoked: sessions.rowCount ?? 0,
      };
    });

    return ok(
      {
        customer: { id: customerId, status: "suspended" },
        /*
          Akibatnya dinyatakan apa adanya supaya operator bisa langsung menjelaskannya kalau
          pelanggan menelepon: perangkat berhenti melayani, dan aplikasinya ikut keluar.
        */
        effect: {
          devices_stopped: result.activeDevices,
          sessions_revoked: result.revoked,
          note:
            result.activeDevices > 0
              ? `${result.activeDevices} perangkat berhenti melayani sampai akunnya diaktifkan kembali.`
              : "Pelanggan ini tidak punya perangkat terpasang, jadi tidak ada perangkat yang berhenti.",
        },
      },
      requestId,
    );
  },
);

/*
  Rute ini sengaja tidak menyediakan DELETE. Akun pelanggan tidak dihapus permanen dari konsol
  admin, karena histori tagihannya harus tetap utuh. Penghapusan hanya tersedia dari sisi
  pelanggan sendiri lewat aplikasi, dan itupun berubah menjadi status `deleted`.
*/

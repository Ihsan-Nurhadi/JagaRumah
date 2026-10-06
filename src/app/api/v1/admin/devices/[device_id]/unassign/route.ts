/*
  Pelepasan perangkat dari customer.

  Ini tindakan korektif, bukan cara rutin memindahkan kepemilikan. Karena itu alasan wajib, dan
  akibatnya dijelaskan apa adanya kepada operator sebelum mereka menekan tombolnya:

  - Perangkat kembali berstatus `in_stock` dan tidak lagi dihitung dalam batas paket.
  - Kode claim lama tetap dianggap terpakai dan TIDAK diterbitkan ulang otomatis. Perangkat
    hanya bisa diklaim lagi setelah admin merotasi kode baru. Ini disengaja: kode lama mungkin
    sudah difoto atau tercetak di dus yang masih beredar, jadi menghidupkannya kembali berarti
    membuka jalur klaim yang tidak terkendali.
  - Riwayat kepemilikan sebelumnya tidak dihapus. Jejaknya ada di audit_logs.
*/
import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { unassignDeviceSchema } from "@/lib/schemas/admin-device";

type Params = { params: Promise<{ device_id?: string }> };

export const POST = routeHandler(
  "admin.devices.unassign",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "device.update");
    await requireCsrf(request);

    const { device_id: rawId } = await (context as Params).params;
    let targetId = rawId;
    if (rawId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawId)) {
      const found = await queryOne<{ id: string }>(
        "SELECT id FROM devices WHERE device_uid = $1",
        [rawId],
      );
      if (found) targetId = found.id;
    }
    const deviceId = requireUuid(targetId, "device_id");
    const input = await parseJson(request, unassignDeviceSchema);

    const result = await withTransaction(async (client) => {
      const device = await queryOne<{
        id: string;
        device_uid: string;
        status: string;
        customer_id: string | null;
        customer_name: string | null;
      }>(
        `SELECT d.id, d.device_uid, d.status, d.customer_id, c.full_name AS customer_name
         FROM devices d
         LEFT JOIN customers c ON c.id = d.customer_id
         WHERE d.id = $1 FOR UPDATE OF d`,
        [deviceId],
        client,
      );

      if (!device) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message:
            "Perangkat itu tidak ada di inventory. Kembali ke daftar perangkat untuk memilih " +
            "perangkat yang benar.",
        });
      }

      if (!device.customer_id) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            `Perangkat ${device.device_uid} sedang tidak terpasang pada pelanggan mana pun, ` +
            `jadi tidak ada yang perlu dilepas.`,
          details: { device_uid: device.device_uid, status: device.status },
        });
      }

      const previousCustomerId = device.customer_id;

      /*
        Kode claim lama ditandai terpakai kalau ternyata masih aktif. Perangkat yang ditugaskan
        admin seharusnya sudah punya kode terpakai, tetapi perangkat yang dilepas di sini bisa
        berasal dari jalur mana pun, dan kode yang tertinggal aktif akan jadi celah.
      */
      const closedCodes = await client.query(
        `UPDATE device_claim_codes
         SET used_at = COALESCE(used_at, now())
         WHERE device_id = $1 AND used_at IS NULL`,
        [deviceId],
      );

      await client.query(
        `UPDATE devices
         SET customer_id = NULL, status = 'in_stock', claim_method = NULL,
             claimed_at = NULL, activated_at = NULL, deactivated_at = now()
         WHERE id = $1`,
        [deviceId],
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "device.unassign",
        entityType: "device",
        entityId: deviceId,
        oldData: {
          customer_id: previousCustomerId,
          customer_name: device.customer_name,
          status: device.status,
        },
        newData: {
          customer_id: null,
          status: "in_stock",
          reason: input.reason,
          claim_codes_closed: closedCodes.rowCount ?? 0,
        },
      });

      return {
        deviceUid: device.device_uid,
        previousCustomerName: device.customer_name,
        closedCodes: closedCodes.rowCount ?? 0,
      };
    });

    return ok(
      {
        device: {
          id: deviceId,
          device_uid: result.deviceUid,
          status: "in_stock",
          customer: null,
        },
        released_from: { full_name: result.previousCustomerName },
        /*
          Dinyatakan terang-terangan supaya antarmuka tidak menyediakan tombol "kirim ulang
          label" yang seolah bisa memakai kode lama. Kode baru hanya lahir dari rotasi.
        */
        claim_code: {
          is_used: true,
          can_be_reused: false,
          next_step:
            "Rotasi kode claim kalau perangkat ini akan diklaim lagi oleh pelanggan, karena " +
            "kode lama sudah tidak berlaku.",
        },
      },
      requestId,
    );
  },
);

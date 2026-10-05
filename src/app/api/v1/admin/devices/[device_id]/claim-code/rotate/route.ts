/*
  Rotasi kode claim.

  Dipakai kalau label rusak, kode tidak sempat dicetak, atau perangkat perlu diterbitkan ulang
  setelah unassign.

  Sifatnya yang perlu disadari: rotasi mencabut kode lama tanpa bisa dikembalikan. Kalau kode
  baru juga tidak sempat dicatat, operator bisa merotasi lagi, tetapi setiap rotasi membuat
  label yang sudah tercetak sebelumnya tidak berlaku. Karena itu response memuat kode dalam
  bentuk asli dan terformat, dan halaman menampilkannya sekali.
*/
import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import { claimLabel, claimCodeState, issueClaimCode } from "@/lib/server/devices";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { created, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Params = { params: Promise<{ device_id?: string }> };

export const POST = routeHandler(
  "admin.devices.claim_code.rotate",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "device.claim_code");
    await requireCsrf(request);

    const { device_id: rawId } = await (context as Params).params;
    const deviceId = requireUuid(rawId, "device_id");

    /*
      Rotasi adalah mutasi, jadi tetap memerlukan CSRF meski tidak memuat body. Tanpa
      pemeriksaan ini, halaman lain bisa memicu rotasi lewat permintaan lintas situs, dan
      akibatnya label yang sudah dicetak mendadak tidak berlaku.
    */

    const result = await withTransaction(async (client) => {
      const device = await queryOne<{
        id: string;
        device_uid: string;
        status: string;
      }>(
        `SELECT id, device_uid, status FROM devices
         WHERE id = $1 AND status <> 'deleted' FOR UPDATE`,
        [deviceId],
        client,
      );

      if (!device) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message:
            "Perangkat itu tidak ada atau sudah dihapus dari inventory. Kembali ke daftar " +
            "perangkat untuk memilih perangkat yang benar.",
        });
      }

      /*
        Perangkat yang sudah dimiliki pelanggan tidak boleh dirotasi kodenya. Kode claim adalah
        jalan masuk menuju kepemilikan, dan menerbitkan kode baru untuk perangkat yang sudah
        bertuan berarti membuka jalan kedua menuju perangkat yang sama.
      */
      if (device.status === "claimed") {
        throw new AppError({
          code: "DEVICE_ALREADY_CLAIMED",
          message:
            `Perangkat ${device.device_uid} sedang terpasang pada pelanggan, jadi kode ` +
            `claimnya tidak perlu dirotasi. Lepaskan dulu kalau perangkat ini akan dipindahkan.`,
          details: { device_uid: device.device_uid, status: device.status },
        });
      }

      const previous = await claimCodeState(deviceId, client);
      const token = await issueClaimCode(client, deviceId);

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "device.claim_code.rotate",
        entityType: "device",
        entityId: deviceId,
        /*
          Kode lama tidak ikut dicatat, dan itu disengaja: menuliskan kode claim ke tabel audit
          akan memindahkannya ke tempat yang bisa dibaca lebih banyak orang daripada hash di
          tabel asalnya. Yang dicatat hanya bahwa ada kode lama yang dicabut.
        */
        oldData: {
          had_active_code: previous.has_code,
          previous_code_was_used: previous.has_code ? previous.is_used : null,
        },
        newData: { rotated: true, device_uid: device.device_uid },
      });

      return { deviceUid: device.device_uid, token, hadPreviousCode: previous.has_code };
    });

    return created(
      {
        device: { id: deviceId, device_uid: result.deviceUid },
        claim_label: {
          ...claimLabel(result.token),
          shown_once: true,
        },
        previous_code_revoked: result.hadPreviousCode,
      },
      requestId,
    );
  },
);

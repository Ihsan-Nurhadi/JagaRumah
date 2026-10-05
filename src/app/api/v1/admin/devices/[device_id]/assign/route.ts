/*
  Penugasan perangkat ke customer oleh admin.

  Ini jalur kedua menuju kepemilikan, di samping claim oleh customer. Dipakai untuk kasus yang
  tidak bisa diselesaikan lewat aplikasi customer, misalnya label rusak atau perangkat dikirim
  setelah pelanggan sudah berlangganan.

  Aturan yang ditegakkan di sini:

  - Hanya perangkat berstatus `in_stock` yang bisa ditugaskan. Perangkat yang sudah terklaim
    harus di-unassign lebih dulu, supaya perpindahan kepemilikan selalu punya dua catatan:
    satu untuk pelepasan, satu untuk penugasan baru.
  - Batas perangkat paket tetap diperiksa. Tanpa pemeriksaan ini, jalur admin menjadi celah
    untuk melewati batas paket.
  - Alasan wajib. Tindakan ini mengubah kepemilikan, dan pertanyaan "kenapa perangkat ini
    berpindah" harus bisa dijawab dari catatan, bukan dari ingatan operator.
*/
import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import { assertWithinDeviceLimit, deviceLimitFor } from "@/lib/server/devices";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { created, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { assignDeviceSchema } from "@/lib/schemas/admin-device";

type Params = { params: Promise<{ device_id?: string }> };

export const POST = routeHandler(
  "admin.devices.assign",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "device.update");
    await requireCsrf(request);

    const { device_id: rawId } = await (context as Params).params;
    const deviceId = requireUuid(rawId, "device_id");
    const input = await parseJson(request, assignDeviceSchema);

    const result = await withTransaction(async (client) => {
      /*
        Perangkat dikunci lebih dulu, lalu customer. Urutan penguncian dibuat tetap seperti ini
        di seluruh modul supaya dua transaksi yang menyentuh pasangan baris yang sama tidak
        saling menunggu dalam urutan terbalik, yang berakhir pada deadlock.
      */
      const device = await queryOne<{
        id: string;
        device_uid: string;
        status: string;
        customer_id: string | null;
        claimed_at: Date | null;
      }>(
        `SELECT id, device_uid, status, customer_id, claimed_at
         FROM devices WHERE id = $1 FOR UPDATE`,
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

      if (device.status === "claimed") {
        throw new AppError({
          code: "DEVICE_ALREADY_CLAIMED",
          message:
            `Perangkat ${device.device_uid} sudah terpasang pada seorang pelanggan. Lepaskan ` +
            `dulu lewat tindakan "Lepas dari pelanggan", baru tugaskan ke pelanggan lain.`,
          details: { device_uid: device.device_uid, status: device.status },
        });
      }

      if (device.status === "retired" || device.status === "deleted") {
        throw new AppError({
          code: "DEVICE_SUSPENDED",
          message:
            `Perangkat ${device.device_uid} berstatus "${device.status}" dan tidak dapat ` +
            `ditugaskan. Ubah statusnya lebih dulu kalau perangkat ini akan dipakai lagi.`,
          details: { device_uid: device.device_uid, status: device.status },
        });
      }

      const customer = await queryOne<{ id: string; full_name: string; status: string }>(
        "SELECT id, full_name, status FROM customers WHERE id = $1 FOR UPDATE",
        [input.customer_id],
        client,
      );

      if (!customer) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message:
            "Pelanggan tujuan tidak ditemukan. Pilih pelanggan lewat daftar pelanggan, bukan dari " +
            "tautan yang disimpan sebelumnya.",
        });
      }

      if (customer.status !== "active") {
        throw new AppError({
          code: "CUSTOMER_SUSPENDED",
          message:
            `Akun ${customer.full_name} berstatus "${customer.status}". Aktifkan kembali akunnya ` +
            `sebelum menugaskan perangkat, karena perangkat pada akun nonaktif tidak terpakai.`,
          details: { customer_status: customer.status },
        });
      }

      /*
        Batas paket diperiksa setelah barisnya dikunci, sehingga dua penugasan serentak untuk
        pelanggan yang sama tidak bisa sama-sama lolos hanya karena keduanya membaca jumlah
        perangkat sebelum salah satunya menulis.
      */
      const limit = await deviceLimitFor(customer.id, client);
      if (!limit) {
        throw new AppError({
          code: "ACTIVE_SUBSCRIPTION_REQUIRED",
          message:
            `${customer.full_name} belum punya langganan yang berjalan. Setiap pelanggan ` +
            `seharusnya otomatis mendapat paket gratis saat mendaftar, jadi keadaan ini berarti ` +
            `langganannya berakhir atau dibatalkan.`,
          details: { customer_id: customer.id },
        });
      }
      assertWithinDeviceLimit(limit);

      /*
        claim_method sengaja dibiarkan NULL, bukan diisi "admin".

        Kolom itu berarti cara customer mengklaim perangkat, dan nilainya hanya "qr" atau
        "serial". Penugasan oleh admin bukan klaim oleh customer, jadi menulis "admin" di sana
        akan mengubah arti kolom itu dan membuat laporan cara masuk perangkat mencampur dua hal
        yang berbeda. Fakta bahwa perangkat ini ditugaskan admin tercatat di audit_logs, tempat
        keterangan seperti ini memang seharusnya berada.
      */
      await client.query(
        `UPDATE devices
         SET customer_id = $2, status = 'claimed', claim_method = NULL,
             claimed_at = now(), activated_at = now(), deactivated_at = NULL
         WHERE id = $1`,
        [deviceId, customer.id],
      );

      /*
        Kode claim perangkat yang sudah dimiliki ditandai terpakai. Kalau dibiarkan aktif,
        label yang masih menempel di dus bisa dipakai orang lain untuk mengklaim perangkat yang
        sudah bertuan, dan hasilnya adalah perpindahan kepemilikan tanpa catatan.
      */
      await client.query(
        `UPDATE device_claim_codes
         SET used_at = now(), used_by_customer_id = $2
         WHERE device_id = $1 AND used_at IS NULL`,
        [deviceId, customer.id],
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "device.assign",
        entityType: "device",
        entityId: deviceId,
        oldData: { customer_id: null, status: device.status },
        newData: {
          customer_id: customer.id,
          customer_name: customer.full_name,
          status: "claimed",
          assigned_by: "admin",
          reason: input.reason,
        },
      });

      /*
        Jumlah perangkat dilaporkan dalam keadaan sesudah penugasan, karena itulah keadaan yang
        dibaca operator dari response ini. Angka yang dibaca sebelum penugasan akan menampilkan
        "0 dari 1 terpakai" tepat setelah perangkat berhasil ditugaskan, dan itu menyesatkan.
      */
      return {
        deviceUid: device.device_uid,
        customer,
        limit: { ...limit, activeCount: limit.activeCount + 1 },
      };
    });

    return created(
      {
        device: {
          id: deviceId,
          device_uid: result.deviceUid,
          status: "claimed",
          /*
            NULL berarti perangkat ini tidak pernah diklaim lewat aplikasi customer. Antarmuka
            menampilkannya sebagai "Ditugaskan admin", bukan sebagai cara klaim yang tidak
            dikenali.
          */
          claim_method: null,
          assigned_by_admin: true,
          claimed_at: new Date().toISOString(),
        },
        customer: {
          id: result.customer.id,
          full_name: result.customer.full_name,
        },
        device_limit: {
          plan_name: result.limit.planName,
          limit: result.limit.deviceLimit,
          active_count: result.limit.activeCount,
        },
        /*
          Dikatakan apa adanya: penugasan admin tidak membuat kode claim baru, dan kode lama
          sudah ditandai terpakai. Perangkat ini hanya bisa diklaim lagi lewat customer setelah
          admin merotasi kode baru.
        */
        claim_code_rotated: false,
      },
      requestId,
    );
  },
);

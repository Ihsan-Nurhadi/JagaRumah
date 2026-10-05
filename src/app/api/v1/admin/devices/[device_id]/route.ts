/*
  Detail dan perubahan perangkat.

  Endpoint ini memuat dua hal yang dibutuhkan halaman detail:

  1. Keadaan kode claim. Kode aslinya tidak dapat ditampilkan lagi karena yang tersimpan hanya
     hash-nya, dan response mengatakannya lewat `can_be_shown_again: false`.
  2. Riwayat percobaan claim. Pertanyaan "kenapa pelanggan ini tidak bisa mengklaim" hampir
     selalu jawabannya ada di percobaan yang gagal.

  Nomor seri, nomor perangkat, dan pemilik tidak dapat diubah lewat PATCH. Ketiganya punya
  jalurnya sendiri dan masing-masing perlu alasan yang tercatat: nomor seri dan nomor perangkat
  tercetak pada label fisik, sehingga mengubahnya diam-diam membuat label di bodi perangkat
  tidak lagi cocok dengan catatan. Pemilik berubah hanya lewat assign atau unassign.
*/
import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import {
  claimCodeState,
  deviceClaimAttempts,
  deviceLimitFor,
  findDevice,
} from "@/lib/server/devices";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { updateDeviceSchema } from "@/lib/schemas/admin-device";

type Params = { params: Promise<{ device_id?: string }> };

export const GET = routeHandler("admin.devices.detail", async (_request, requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "device.read");

  const { device_id: rawId } = await (context as Params).params;
  const deviceId = requireUuid(rawId, "device_id");

  const device = await findDevice(deviceId);
  if (!device) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message:
        "Perangkat itu tidak ada di inventory. Periksa kembali tautannya, atau cari perangkatnya " +
        "lewat halaman daftar perangkat.",
    });
  }

  const [claimCode, attempts, limit] = await Promise.all([
    claimCodeState(deviceId),
    deviceClaimAttempts(deviceId, 20),
    device.customer_id ? deviceLimitFor(device.customer_id) : Promise.resolve(null),
  ]);

  /*
    Masa garansi dihitung dari tanggal mulai. Yang dikirim adalah tanggal berakhirnya, bukan
    sisa hari, supaya angka yang ditampilkan tidak basi saat halaman dibiarkan terbuka lama.
  */
  const warrantyEndsAt = device.warranty_start_at
    ? new Date(device.warranty_start_at.getTime() + 365 * 24 * 60 * 60 * 1000)
    : null;

  return ok(
    {
      device: {
        id: device.id,
        device_uid: device.device_uid,
        serial_number: device.serial_number,
        name: device.name,
        model: device.model,
        hardware_revision: device.hardware_revision,
        batch_number: device.batch_number,
        mac_address: device.mac_address,
        imei: device.imei,
        status: device.status,
        claim_method: device.claim_method,
        /*
          Status koneksi dibaca dari telemetry kamera; status inventory tetap dikirim terpisah.
        */
        integration_ready: Boolean(device.stream_url),
        connection_status: device.connection_status,
        recording_status: device.recording_status,
        last_seen_at: device.last_seen_at?.toISOString() ?? null,
        stream_url: device.stream_url,
        warranty_start_at: device.warranty_start_at?.toISOString() ?? null,
        warranty_ends_at: warrantyEndsAt?.toISOString() ?? null,
        claimed_at: device.claimed_at?.toISOString() ?? null,
        activated_at: device.activated_at?.toISOString() ?? null,
        deactivated_at: device.deactivated_at?.toISOString() ?? null,
        created_at: device.created_at.toISOString(),
        updated_at: device.updated_at.toISOString(),
      },
      customer: device.customer_id
        ? {
            id: device.customer_id,
            full_name: device.customer_name,
            status: device.customer_status,
          }
        : null,
      registered_by: device.registered_by_admin_id
        ? { id: device.registered_by_admin_id, full_name: device.registered_by_name }
        : null,
      claim_code: claimCode,
      claim_attempts: attempts.map((row) => ({
        id: row.id,
        success: row.success,
        failure_reason: row.failure_reason,
        submitted_kind: row.submitted_kind,
        // Nilai yang dikirim customer tersimpan tersamarkan, bukan apa adanya.
        submitted_value_masked: row.submitted_value_masked,
        ip_address: row.ip_address,
        customer: row.customer_id ? { id: row.customer_id, full_name: row.customer_name } : null,
        created_at: row.created_at.toISOString(),
      })),
      device_limit: limit
        ? {
            plan_name: limit.planName,
            limit: limit.deviceLimit,
            active_count: limit.activeCount,
            // NULL berarti tanpa batas, dibedakan dari 0 yang berarti tidak boleh ada perangkat.
            unlimited: limit.deviceLimit === null,
            remaining:
              limit.deviceLimit === null
                ? null
                : Math.max(0, limit.deviceLimit - limit.activeCount),
          }
        : null,
    },
    requestId,
  );
});

export const PATCH = routeHandler(
  "admin.devices.update",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "device.update");
    await requireCsrf(request);

    const { device_id: rawId } = await (context as Params).params;
    const deviceId = requireUuid(rawId, "device_id");

    const input = await parseJson(request, updateDeviceSchema);

    const result = await withTransaction(async (client) => {
      /*
        Baris dikunci sebelum dibaca. Dua operator yang menyunting perangkat yang sama pada saat
        bersamaan berjalan berurutan, sehingga yang kedua melihat nilai yang sudah diubah yang
        pertama dan catatan auditnya benar-benar menggambarkan perubahan yang terjadi.
      */
      const before = await queryOne<{
        id: string;
        name: string | null;
        model: string | null;
        hardware_revision: string | null;
        batch_number: string | null;
        mac_address: string | null;
        imei: string | null;
        warranty_start_at: Date | null;
      }>(
        `SELECT id, name, model, hardware_revision, batch_number, mac_address, imei,
                warranty_start_at
         FROM devices WHERE id = $1 AND status <> 'deleted' FOR UPDATE`,
        [deviceId],
        client,
      );

      if (!before) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message:
            "Perangkat itu tidak ada atau sudah dihapus dari inventory. Kembali ke daftar " +
            "perangkat untuk memeriksa keadaannya.",
        });
      }

      /*
        Hanya kolom yang benar-benar dikirim yang diperbarui. Tanpa penyaringan ini, PATCH yang
        hanya bermaksud mengubah nama akan ikut mengosongkan model dan nomor batch, karena kolom
        yang tidak dikirim tampak sama dengan kolom yang dikirim bernilai null.
      */
      const assignments: string[] = [];
      const params: unknown[] = [];
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      const fields = [
        ["name", input.name],
        ["model", input.model],
        ["hardware_revision", input.hardware_revision],
        ["batch_number", input.batch_number],
        ["mac_address", input.mac_address],
        ["imei", input.imei],
        ["warranty_start_at", input.warranty_start_at],
      ] as const;

      for (const [column, value] of fields) {
        if (value === undefined) continue;

        const previous = before[column as keyof typeof before];
        const next =
          column === "warranty_start_at" && typeof value === "string" ? new Date(value) : value;

        assignments.push(`${column} = $${params.push(next)}`);
        changes[column] = {
          from: previous instanceof Date ? previous.toISOString() : (previous ?? null),
          to: next instanceof Date ? next.toISOString() : (next ?? null),
        };
      }

      if (assignments.length === 0) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message: "Tidak ada perubahan yang dikirim. Isi minimal satu kolom lalu simpan.",
        });
      }

      const updated = await queryOne<{ updated_at: Date }>(
        `UPDATE devices SET ${assignments.join(", ")} WHERE id = $${params.push(deviceId)}
         RETURNING updated_at`,
        params,
        client,
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "device.update",
        entityType: "device",
        entityId: deviceId,
        oldData: Object.fromEntries(Object.entries(changes).map(([key, v]) => [key, v.from])),
        newData: Object.fromEntries(Object.entries(changes).map(([key, v]) => [key, v.to])),
      });

      return { updatedAt: updated?.updated_at ?? new Date() };
    });

    return ok(
      { device: { id: deviceId, updated_at: result.updatedAt.toISOString() } },
      requestId,
    );
  },
);

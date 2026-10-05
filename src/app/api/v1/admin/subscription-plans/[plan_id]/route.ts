/*
  Detail dan perubahan paket.

  Response detail memuat seluruh harga paket beserta jumlah langganan yang memakai tiap harga.
  Angka itu yang menentukan apakah nominal sebuah harga masih boleh diubah, jadi ia dikirim
  bersama harganya, bukan disembunyikan di balik pesan galat saat penyimpanan ditolak.

  Kode paket tidak dapat diubah lewat PATCH. Kode itulah yang dipakai klien untuk mengenali paket,
  dan mengubahnya diam-diam akan membuat klien yang belum diperbarui memilih paket yang salah.
  Nama, keterangan, batas perangkat, penanda paket gratis, status, dan urutan tetap dapat diubah.
*/
import { writeAudit } from "@/lib/server/audit";
import { queryOne, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { findPlan, planPayload, planPrices, planUsage } from "@/lib/server/plans";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import {
  normalizeDeviceLimit,
  normalizeSortOrder,
  updatePlanSchema,
} from "@/lib/schemas/admin-plan";

type Params = { params: Promise<{ plan_id?: string }> };

export const GET = routeHandler(
  "admin.subscription_plans.detail",
  async (_request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "plan.read");

    const { plan_id: rawId } = await (context as Params).params;
    const planId = requireUuid(rawId, "plan_id");

    const plan = await findPlan(planId);
    if (!plan) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message:
          "Paket itu tidak ada. Periksa kembali tautannya, atau cari paketnya lewat halaman " +
          "paket dan harga.",
      });
    }

    const [prices, usage] = await Promise.all([planPrices([planId]), planUsage(planId)]);

    return ok(
      {
        plan: planPayload(plan, prices),
        usage: {
          subscriptions_total: usage.total,
          subscriptions_active: usage.active,
        },
      },
      requestId,
    );
  },
);

export const PATCH = routeHandler(
  "admin.subscription_plans.update",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "plan.manage");
    await requireCsrf(request);

    const { plan_id: rawId } = await (context as Params).params;
    const planId = requireUuid(rawId, "plan_id");

    const input = await parseJson(request, updatePlanSchema);

    const result = await withTransaction(async (client) => {
      /*
        Baris dikunci sebelum dibaca. Dua operator yang menyunting paket yang sama pada saat
        bersamaan berjalan berurutan, sehingga yang kedua melihat nilai yang sudah diubah yang
        pertama dan catatan auditnya benar-benar menggambarkan perubahan yang terjadi.
      */
      const before = await queryOne<{
        name: string;
        description: string | null;
        device_limit: number | null;
        is_free: boolean;
        is_active: boolean;
        sort_order: number;
      }>(
        `SELECT name, description, device_limit, is_free, is_active, sort_order
         FROM subscription_plans WHERE id = $1 FOR UPDATE`,
        [planId],
        client,
      );

      if (!before) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message:
            "Paket itu tidak ada. Kembali ke daftar paket untuk memeriksa keadaannya.",
        });
      }

      /*
        Hanya kolom yang benar-benar dikirim yang diperbarui. Pemeriksaannya memakai `undefined`,
        bukan nilai kosong, karena `device_limit` bernilai null adalah perubahan yang sah: null
        berarti tanpa batas, dan itu berbeda dari kolom yang tidak dikirim.

        Kolom angka masih berbentuk teks di sini, jadi perubahannya dilakukan sebelum dipakai.
        Nama kolomnya ditulis di kode ini, bukan diambil dari permintaan, sehingga tidak ada nama
        kolom yang datang dari klien.
      */
      const provided: Record<string, unknown> = {};
      if (input.name !== undefined) provided.name = input.name;
      if (input.description !== undefined) provided.description = input.description;
      if (input.device_limit !== undefined) {
        provided.device_limit = normalizeDeviceLimit(input.device_limit);
      }
      if (input.is_free !== undefined) provided.is_free = input.is_free;
      if (input.is_active !== undefined) provided.is_active = input.is_active;
      if (input.sort_order !== undefined) provided.sort_order = normalizeSortOrder(input.sort_order);

      const assignments: string[] = [];
      const params: unknown[] = [];
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      for (const [column, value] of Object.entries(provided)) {
        assignments.push(`${column} = $${params.push(value)}`);
        changes[column] = { from: before[column as keyof typeof before], to: value };
      }

      if (assignments.length === 0) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message: "Tidak ada perubahan yang dikirim. Isi minimal satu kolom lalu simpan.",
        });
      }

      const updated = await queryOne<{ updated_at: Date }>(
        `UPDATE subscription_plans SET ${assignments.join(", ")} WHERE id = $${params.push(planId)}
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
        action: "plan.update",
        entityType: "subscription_plan",
        entityId: planId,
        oldData: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.from])),
        newData: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.to])),
      });

      return { updatedAt: updated?.updated_at ?? new Date() };
    });

    return ok({ plan: { id: planId, updated_at: result.updatedAt.toISOString() } }, requestId);
  },
);

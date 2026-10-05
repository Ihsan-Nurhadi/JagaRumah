/*
  Mencabut sesi admin lain.

  Ini satu-satunya tindakan di konsol yang dapat menghentikan akses seseorang seketika, jadi
  dua hal ditegakkan di sini dan keduanya penting:

  1. Admin tidak dapat mencabut sesinya sendiri lewat endpoint ini. Kalau diizinkan, admin yang
     sedang bekerja bisa memutus dirinya sendiri karena salah klik, dan itu tidak dapat
     dibatalkan. Untuk keluar, jalur yang benar adalah keluar biasa.
  2. Percobaan mencabut sesi sendiri ditolak, bukan diabaikan diam-diam, supaya pemakainya tahu
     kenapa tidak terjadi apa-apa.

  Sesi yang sudah tidak aktif juga ditolak dengan pesan yang menerangkan keadaannya, karena
  mencabut sesi yang sudah dicabut tidak mengubah apa pun dan pemakainya perlu tahu itu.
*/
import { writeAudit } from "@/lib/server/audit";
import { query, withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { writeSessionEvent } from "@/lib/server/session";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Params = { params: Promise<{ session_id?: string }> };

export const POST = routeHandler(
  "admin.admin_sessions.revoke",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "admin.manage");
    await requireCsrf(request);

    const { session_id: rawId } = await (context as Params).params;
    const sessionId = requireUuid(rawId, "session_id");

    const hasil = await withTransaction(async (client) => {
      const sesi = await query<{
        id: string;
        admin_user_id: string;
        revoked_at: Date | null;
        expires_at: Date;
        ip_address: string | null;
        user_agent: string | null;
      }>(
        `SELECT id, admin_user_id, revoked_at, expires_at,
                host(ip_address) AS ip_address, user_agent
         FROM admin_sessions
         WHERE id = $1
         FOR UPDATE`,
        [sessionId],
        client,
      );

      if (sesi.length === 0) {
        throw new AppError({
          code: "RESOURCE_NOT_FOUND",
          message:
            "Sesi itu tidak ditemukan. Muat ulang halaman audit untuk melihat daftar sesi terbaru.",
        });
      }

      const target = sesi[0]!;

      if (target.admin_user_id === admin.identity.id) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            "Sesi sendiri tidak dapat dicabut dari halaman ini, karena Anda akan langsung " +
            "kehilangan akses dan tidak dapat membatalkannya. Untuk keluar, gunakan tombol keluar.",
        });
      }

      if (target.revoked_at) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            "Sesi ini sudah dicabut sebelumnya, jadi tidak ada yang berubah. Muat ulang halaman " +
            "audit untuk melihat keadaan terbarunya.",
          details: { revoked_at: target.revoked_at.toISOString() },
        });
      }

      await client.query(`UPDATE admin_sessions SET revoked_at = now() WHERE id = $1`, [
        sessionId,
      ]);

      /*
        Peristiwa sesi ditulis atas nama pemilik sesi, bukan atas nama pencabutnya. Yang terjadi
        pada sesi itu adalah "sesi ini dicabut", dan kolomnya menyimpan pemilik sesi. Pencabutnya
        tetap tercatat lengkap di jejak audit di bawah.
      */
      await writeSessionEvent(client, {
        sessionId,
        adminUserId: target.admin_user_id,
        eventType: "revoked",
        ipAddress: target.ip_address,
        userAgent: target.user_agent,
        metadata: {
          revoked_by_admin_id: admin.identity.id,
          revoked_by_name: admin.identity.fullName,
        },
      });

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "admin_session.revoke",
        entityType: "admin_session",
        entityId: sessionId,
        oldData: { revoked_at: null, expires_at: target.expires_at.toISOString() },
        newData: { revoked_at: new Date().toISOString(), revoked_by: admin.identity.id },
      });

      return { pemilik: target.admin_user_id };
    });

    return ok(
      {
        revoked: true,
        session_id: sessionId,
        admin_user_id: hasil.pemilik,
        note:
          "Sesi dicabut dan token aksesnya berhenti berlaku saat itu juga. Pemilik sesi perlu " +
          "masuk kembali untuk memakai konsol ini.",
      },
      requestId,
    );
  },
);

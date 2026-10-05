/*
  Membatalkan langganan.

  Yang perlu dipahami sebelum mengubah berkas ini: membatalkan langganan berbeda dari
  menghentikan akses pelanggan.

  - Membatalkan berarti pelanggan tidak diperpanjang lagi. Perangkatnya tetap melayani sampai
    masa yang sudah dibayar habis, karena pelanggan sudah membayarnya. Memutus layanan lebih
    awal berarti mengambil sesuatu yang sudah dibayar.
  - Penghentian akses adalah tindakan terpisah, yaitu menangguhkan akun pelanggan, dan itu
    punya endpoint sendiri yang mewajibkan konfirmasi perangkat.

  Karena itu pembatalan di sini mengisi `cancel_at_period_end` dan membiarkan langganan berjalan
  sampai masa berakhirnya. Pembatalan langsung hanya dilakukan kalau diminta secara eksplisit,
  dan itu perlu alasan.

  Paket gratis tidak dapat dibatalkan: pelanggan tidak membayar apa pun, dan menghapus
  langganannya membuat pemeriksaan batas perangkat kehilangan baris yang dibacanya.
*/
import { writeAudit } from "@/lib/server/audit";
import { withTransaction } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requireCsrf, requirePermission } from "@/lib/server/guard";
import { parseJson } from "@/lib/server/parse";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { lockSubscription } from "@/lib/server/subscriptions";
import { cancelSubscriptionSchema } from "@/lib/schemas/admin-subscription";

type Params = { params: Promise<{ subscription_id?: string }> };

export const POST = routeHandler(
  "admin.subscriptions.cancel",
  async (request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "subscription.manage");
    await requireCsrf(request);

    const { subscription_id: rawId } = await (context as Params).params;
    const subscriptionId = requireUuid(rawId, "subscription_id");
    const input = await parseJson(request, cancelSubscriptionSchema);

    const result = await withTransaction(async (client) => {
      const subscription = await lockSubscription(client, subscriptionId);

      /*
        Pembatalan yang berlaku sampai masa habis tidak mengubah status langganan: statusnya
        tetap berjalan sampai tanggal berakhirnya tiba. Karena itu pemeriksaan di sini harus
        melihat penjadwalan pembatalannya juga.

        Tanpa pemeriksaan `cancel_at_period_end`, menekan "Batalkan" dua kali akan berhasil dua
        kali, dan yang tercatat adalah dua peristiwa pembatalan untuk satu keputusan. Catatan
        seperti itu membuat riwayat langganan tidak lagi bisa dipercaya saat disengketakan.
      */
      if (subscription.status === "canceled" || subscription.status === "expired") {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            `Langganan ${subscription.customer_name ?? "pelanggan ini"} sudah berstatus ` +
            `"${subscription.status}", jadi tidak ada yang perlu dibatalkan. Muat ulang halaman ` +
            `ini untuk melihat keadaan terbarunya.`,
          details: { subscription_status: subscription.status },
        });
      }

      if (subscription.cancel_at_period_end) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            `Langganan ${subscription.customer_name ?? "pelanggan ini"} sudah dijadwalkan ` +
            `berhenti pada akhir masa berlangganannya, jadi tidak perlu dibatalkan lagi. Untuk ` +
            `menghentikannya sekarang, batalkan dengan cara yang berlaku langsung.`,
          details: { cancel_at_period_end: true },
        });
      }

      /*
        Paket gratis diperiksa lewat harga, bukan lewat nama paketnya. Nama paket bisa diubah
        admin, sedangkan harga nol adalah sifat yang menentukan bahwa tidak ada yang dibayar.
      */
      const plan = await client.query<{ is_free: boolean; current_period_end: Date | null }>(
        `SELECT p.is_free, s.current_period_end
         FROM subscriptions s
         JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.id = $1`,
        [subscriptionId],
      );
      const isFree = plan.rows[0]?.is_free ?? false;
      const hasPeriodEnd = plan.rows[0]?.current_period_end !== null;

      if (isFree) {
        throw new AppError({
          code: "VALIDATION_ERROR",
          message:
            "Paket Gratis tidak dapat dibatalkan, karena pelanggan tidak membayar apa pun dan " +
            "paket ini yang menjaga batas perangkat tetap bekerja. Untuk menghentikan akses " +
            "pelanggan, tangguhkan akunnya dari halaman detail pelanggan.",
          details: { is_free: true },
        });
      }

      /*
        Tiga kemungkinan, dan yang mana yang dipakai ditentukan data, bukan asumsi:

        - Ada tanggal berakhir dan pembatalan diminta berlaku sampai masa itu habis: langganan
          ditandai tidak diperpanjang, tetapi tetap berjalan. Ini jalur normalnya.
        - Tidak ada tanggal berakhir: tidak ada masa yang tersisa untuk dihormati, jadi
          pembatalannya langsung berlaku.
        - Operator meminta pembatalan langsung meski masih ada masa tersisa: diizinkan, tetapi
          akibatnya dinyatakan di response supaya jelas bahwa layanan berhenti lebih awal.
      */
      const immediate = input.mode === "immediate" || !hasPeriodEnd;

      if (immediate) {
        await client.query(
          `UPDATE subscriptions
           SET status = 'canceled', cancel_at_period_end = false,
               canceled_at = now(), ended_at = now()
           WHERE id = $1`,
          [subscriptionId],
        );
      } else {
        await client.query(
          `UPDATE subscriptions
           SET cancel_at_period_end = true, canceled_at = now()
           WHERE id = $1`,
          [subscriptionId],
        );
      }

      await client.query(
        `INSERT INTO subscription_events
           (subscription_id, customer_id, event_type, from_plan_id, actor_type, actor_id, metadata)
         VALUES ($1, $2, 'canceled', (SELECT plan_id FROM subscriptions WHERE id = $1),
                 'admin', $3, $4)`,
        [
          subscriptionId,
          subscription.customer_id,
          admin.identity.id,
          JSON.stringify({
            reason: input.reason,
            mode: immediate ? "immediate" : "at_period_end",
            honored_until: immediate ? null : "current_period_end",
          }),
        ],
      );

      await writeAudit(client, {
        actor: {
          adminUserId: admin.identity.id,
          ipAddress: admin.ipAddress,
          userAgent: admin.userAgent,
        },
        action: "subscription.cancel",
        entityType: "subscription",
        entityId: subscriptionId,
        oldData: { status: subscription.status },
        newData: {
          status: immediate ? "canceled" : subscription.status,
          cancel_at_period_end: !immediate,
          reason: input.reason,
          mode: immediate ? "immediate" : "at_period_end",
        },
      });

      return { immediate, customerName: subscription.customer_name };
    });

    return ok(
      {
        subscription: {
          id: subscriptionId,
          cancel_at_period_end: !result.immediate,
          status: result.immediate ? "canceled" : "active",
        },
        /*
          Akibatnya dinyatakan terus terang. Operator sering mengira pembatalan langsung memutus
          layanan, dan perbedaan itu yang paling sering membuat pelanggan menelepon kembali.
        */
        effect: {
          service_stops_now: result.immediate,
          note: result.immediate
            ? `Langganan ${result.customerName ?? "pelanggan"} berhenti sekarang. Perangkatnya tidak lagi tercakup langganan.`
            : `Langganan ${result.customerName ?? "pelanggan"} tidak diperpanjang, tetapi tetap berjalan sampai masa yang sudah dibayar habis.`,
        },
      },
      requestId,
    );
  },
);

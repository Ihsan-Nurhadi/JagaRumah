/*
  Detail langganan.

  Histori perubahan ikut dikirim karena tabel subscriptions hanya menyimpan keadaan terakhir.
  Pertanyaan "kapan paket pelanggan ini naik, dan atas dasar apa" hanya bisa dijawab dari
  subscription_events, dan pertanyaan itu muncul setiap kali ada sengketa tagihan.
*/
import { findSubscription, subscriptionEvents } from "@/lib/server/subscriptions";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Params = { params: Promise<{ subscription_id?: string }> };

export const GET = routeHandler(
  "admin.subscriptions.detail",
  async (_request, requestId, context) => {
    const admin = await requireAdmin();
    requirePermission(admin, "subscription.read");

    const { subscription_id: rawId } = await (context as Params).params;
    const subscriptionId = requireUuid(rawId, "subscription_id");

    const subscription = await findSubscription(subscriptionId);
    if (!subscription) {
      throw new AppError({
        code: "RESOURCE_NOT_FOUND",
        message:
          "Langganan itu tidak ditemukan. Periksa kembali tautannya, atau buka pelanggannya lewat " +
          "halaman daftar pelanggan.",
      });
    }

    const events = await subscriptionEvents(subscriptionId);

    return ok(
      {
        subscription: {
          id: subscription.id,
          status: subscription.status,
          customer: {
            id: subscription.customer_id,
            full_name: subscription.customer_name,
            status: subscription.customer_status,
          },
          plan: {
            id: subscription.plan_id,
            name: subscription.plan_name,
            code: subscription.plan_code,
            device_limit: subscription.device_limit,
            device_limit_unlimited: subscription.device_limit === null,
          },
          active_device_count: subscription.active_device_count,
          price_amount: subscription.price_amount,
          price_interval: subscription.price_interval,
          started_at: subscription.started_at?.toISOString() ?? null,
          current_period_start: subscription.current_period_start?.toISOString() ?? null,
          current_period_end: subscription.current_period_end?.toISOString() ?? null,
          cancel_at_period_end: subscription.cancel_at_period_end,
          canceled_at: subscription.canceled_at?.toISOString() ?? null,
          created_at: subscription.created_at.toISOString(),
        },
        events: events.map((event) => ({
          id: event.id,
          event_type: event.event_type,
          actor_type: event.actor_type,
          from_plan_name: event.from_plan_name,
          to_plan_name: event.to_plan_name,
          metadata: event.metadata,
          created_at: event.created_at.toISOString(),
        })),
      },
      requestId,
    );
  },
);

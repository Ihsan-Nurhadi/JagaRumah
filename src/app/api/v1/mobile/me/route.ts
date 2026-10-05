import { queryOne } from "@/lib/server/db";
import { requireMobile } from "@/lib/server/mobile";
import { updateProfile } from "@/lib/server/mobile-data";
import { ok } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

export const GET = routeHandler("mobile.me.get", async (request, requestId) => {
  const session = await requireMobile(request);
  const profile = await queryOne<{ id: string; full_name: string; avatar_url: string | null; status: string; created_at: Date; email: string | null }>("SELECT c.id,c.full_name,c.avatar_url,c.status,c.created_at,(SELECT email::text FROM customer_auth_accounts WHERE customer_id=c.id AND email IS NOT NULL ORDER BY created_at LIMIT 1) email FROM customers c WHERE c.id=$1", [session.customerId]);
  if (!profile) return ok({ profile: null, subscription: null }, requestId);
  const subscription = await queryOne<{ id: string; status: string; plan_code: string; plan_name: string; device_limit: number | null; current_period_start: Date; current_period_end: Date | null; cancel_at_period_end: boolean; active_camera_count: number }>("SELECT s.id,s.status,p.code plan_code,p.name plan_name,p.device_limit,s.current_period_start,s.current_period_end,s.cancel_at_period_end,(SELECT count(*)::int FROM devices d WHERE d.customer_id=s.customer_id AND d.status='claimed') active_camera_count FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.customer_id=$1 ORDER BY s.created_at DESC LIMIT 1", [session.customerId]);
  return ok({ profile: { ...profile, created_at: profile.created_at.toISOString() }, subscription: subscription ? { ...subscription, current_period_start: subscription.current_period_start.toISOString(), current_period_end: subscription.current_period_end?.toISOString() ?? null } : null }, requestId);
});

export const PATCH = routeHandler("mobile.me.patch", async (request, requestId) => {
  const session = await requireMobile(request);
  return ok(await updateProfile(request, session.customerId), requestId);
});
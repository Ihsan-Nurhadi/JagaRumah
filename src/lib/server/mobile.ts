import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { query, queryOne, withTransaction, type Queryable } from "./db";
import { AppError } from "./errors";
import { clientIp } from "./request";
import { jwtCustomerAccessSecret } from "./config";
import { hashPassword, verifyPassword } from "./password";
import { sendPasswordResetEmail } from "./mobile-mailer";
import { passwordProblem } from "@/lib/password-rules";

export const mobileRegisterSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
  installation_id: z.string().trim().min(1).max(200),
  platform: z.enum(["ios", "android"]),
  app_version: z.string().trim().min(1).max(50),
});
export const mobileLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
  installation_id: z.string().trim().min(1).max(200),
  platform: z.enum(["ios", "android"]),
  app_version: z.string().trim().min(1).max(50),
});
export const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
export const resetPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().regex(/^\d{6}$/),
  new_password: z.string().min(8).max(200),
});
export const mobileRefreshSchema = z.object({ refresh_token: z.string().min(20).max(500), installation_id: z.string().min(1).max(200) });
export const profileSchema = z.object({ full_name: z.string().trim().min(1).max(200).optional(), avatar_url: z.string().url().max(2000).nullable().optional() }).refine((v) => Object.keys(v).length > 0);
export const settingsSchema = z.object({ notifications_enabled: z.boolean().optional(), alerts_enabled: z.boolean().optional(), critical_alerts_only: z.boolean().optional(), installation_id: z.string().min(1).max(200), platform: z.enum(["ios", "android"]).optional(), app_version: z.string().max(50).optional() }).refine((v) => v.notifications_enabled !== undefined || v.alerts_enabled !== undefined || v.critical_alerts_only !== undefined);
export const pushSchema = z.object({ installation_id: z.string().min(1).max(200), platform: z.enum(["ios", "android"]), token: z.string().min(1).max(4096), permission: z.enum(["granted", "denied", "not_determined", "unknown"]), app_version: z.string().max(50).optional() });
export const biometricSchema = z.object({ installation_id: z.string().min(1).max(200), platform: z.enum(["ios", "android"]), app_version: z.string().max(50).optional() });

const ACCESS_TTL = 15 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
const RESET_TTL_MINUTES = 15;

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function newToken(): string { return randomBytes(32).toString("base64url"); }
function resetCode(): string { return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0"); }
function customerSecret(): Uint8Array { return new TextEncoder().encode(jwtCustomerAccessSecret()); }
function passwordError(password: string): void { const problem = passwordProblem(password); if (problem) throw new AppError({ code: "WEAK_PASSWORD", message: problem }); }

export type MobileContext = { customerId: string; sessionId: string; installationId: string };
export async function signMobileAccessToken(customerId: string, sessionId: string): Promise<string> {
  const { SignJWT } = await import("jose");
  return new SignJWT({ typ: "customer_access", sid: sessionId }).setProtectedHeader({ alg: "HS256" }).setSubject(customerId).setIssuedAt().setExpirationTime(`${ACCESS_TTL}s`).sign(customerSecret());
}
async function verifyAccess(token: string): Promise<{ customerId: string; sessionId: string }> {
  try {
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(token, customerSecret(), { algorithms: ["HS256"] });
    if (payload.typ !== "customer_access" || typeof payload.sub !== "string" || typeof payload.sid !== "string") throw new Error();
    return { customerId: payload.sub, sessionId: payload.sid };
  } catch { throw new AppError({ code: "TOKEN_EXPIRED", message: "Sesi mobile tidak berlaku. Login kembali." }); }
}
export async function requireMobile(request: Request): Promise<MobileContext> {
  const raw = request.headers.get("authorization");
  if (!raw?.startsWith("Bearer ")) throw new AppError({ code: "INVALID_CREDENTIALS", message: "Access token diperlukan." });
  const claims = await verifyAccess(raw.slice(7));
  const session = await queryOne<{ customer_id: string; device_id: string | null; expires_at: Date; revoked_at: Date | null }>("SELECT customer_id, device_id, expires_at, revoked_at FROM customer_sessions WHERE id=$1 AND customer_id=$2", [claims.sessionId, claims.customerId]);
  if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now()) throw new AppError({ code: "TOKEN_REVOKED", message: "Session mobile sudah dicabut atau kedaluwarsa." });
  const customer = await queryOne<{ status: string }>("SELECT status FROM customers WHERE id=$1", [claims.customerId]);
  if (!customer || customer.status === "deleted") throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Customer tidak ditemukan." });
  if (customer.status !== "active") throw new AppError({ code: "CUSTOMER_SUSPENDED", message: "Akun customer ditangguhkan." });
  return { customerId: claims.customerId, sessionId: claims.sessionId, installationId: session.device_id ?? "" };
}

async function issueSession(customerId: string, input: { installation_id: string; platform: string; app_version: string }) {
  const refresh = newToken();
  const ip = await clientIp();
  const session = await queryOne<{ id: string }>("INSERT INTO customer_sessions (customer_id,refresh_token_hash,device_id,platform,app_version,ip_address,expires_at,last_used_at) VALUES ($1,$2,$3,$4,$5,$6,now()+($7 * interval '1 second'),now()) RETURNING id", [customerId, hash(refresh), input.installation_id, input.platform, input.app_version, ip, REFRESH_TTL]);
  if (!session) throw new Error("session insert failed");
  return { access_token: await signMobileAccessToken(customerId, session.id), refresh_token: refresh, token_type: "Bearer", expires_in: ACCESS_TTL };
}
async function customerPayload(customerId: string, email: string) {
  const customer = await queryOne<{ id: string; full_name: string; avatar_url: string | null; status: string }>("SELECT id,full_name,avatar_url,status FROM customers WHERE id=$1", [customerId]);
  if (!customer) throw new Error("customer not found after auth");
  return { id: customer.id, full_name: customer.full_name, email, avatar_url: customer.avatar_url, status: customer.status };
}

export async function mobileRegister(input: z.infer<typeof mobileRegisterSchema>) {
  passwordError(input.password);
  const customerId = await withTransaction(async (client) => {
    const existing = await queryOne<{ id: string }>("SELECT id FROM customer_auth_accounts WHERE provider='email' AND email=$1 FOR UPDATE", [input.email], client);
    if (existing) throw new AppError({ code: "EMAIL_ALREADY_REGISTERED", message: "Email sudah terdaftar. Gunakan login atau lupa password." });
    const customer = await queryOne<{ id: string }>("INSERT INTO customers (full_name,status) VALUES ($1,'active') RETURNING id", [input.full_name], client);
    if (!customer) throw new Error("customer insert failed");
    await client.query("INSERT INTO customer_auth_accounts (customer_id,provider,email,password_hash,is_verified,verified_at) VALUES ($1,'email',$2,$3,true,now())", [customer.id, input.email, await hashPassword(input.password)]);
    return customer.id;
  });
  return { ...(await issueSession(customerId, input)), customer: await customerPayload(customerId, input.email), onboarding_required: false };
}

export async function mobileLogin(input: z.infer<typeof mobileLoginSchema>) {
  const account = await queryOne<{ customer_id: string; password_hash: string; is_verified: boolean; status: string; full_name: string; avatar_url: string | null }>("SELECT a.customer_id,a.password_hash,a.is_verified,c.status,c.full_name,c.avatar_url FROM customer_auth_accounts a JOIN customers c ON c.id=a.customer_id WHERE a.provider='email' AND a.email=$1", [input.email]);
  const valid = account ? await verifyPassword(input.password, account.password_hash ?? "") : false;
  if (!account || !valid) throw new AppError({ code: "INVALID_CREDENTIALS", message: "Email atau password salah." });
  if (account.status === "suspended") throw new AppError({ code: "CUSTOMER_SUSPENDED", message: "Akun customer ditangguhkan." });
  if (account.status !== "active") throw new AppError({ code: "INVALID_CREDENTIALS", message: "Akun customer tidak aktif." });
  await query("UPDATE customer_auth_accounts SET last_login_at=now() WHERE customer_id=$1 AND provider='email'", [account.customer_id]);
  return { ...(await issueSession(account.customer_id, input)), customer: { id: account.customer_id, full_name: account.full_name, email: input.email, avatar_url: account.avatar_url, status: account.status }, onboarding_required: false };
}

export async function forgotPassword(input: z.infer<typeof forgotPasswordSchema>) {
  const account = await queryOne<{ customer_id: string; full_name: string; status: string }>("SELECT a.customer_id,c.full_name,c.status FROM customer_auth_accounts a JOIN customers c ON c.id=a.customer_id WHERE a.provider='email' AND a.email=$1", [input.email]);
  if (account?.status === "active") {
    const code = resetCode();
    await query("INSERT INTO auth_verification_codes (customer_id,target,channel,purpose,code_hash,expires_at) VALUES ($1,$2,'email','reset_password',$3,now()+($4 * interval '1 minute'))", [account.customer_id, input.email, hash(code), RESET_TTL_MINUTES]);
    await sendPasswordResetEmail({ to: input.email, name: account.full_name, code });
  }
  return { sent: true, expires_in: RESET_TTL_MINUTES * 60 };
}

export async function resetPassword(input: z.infer<typeof resetPasswordSchema>) {
  passwordError(input.new_password);
  const result = await withTransaction(async (client) => {
    const verification = await queryOne<{ id: string; customer_id: string; expires_at: Date; attempt_count: number }>("SELECT id,customer_id,expires_at,attempt_count FROM auth_verification_codes WHERE target=$1 AND channel='email' AND purpose='reset_password' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [input.email], client);
    if (!verification || verification.expires_at.getTime() <= Date.now()) throw new AppError({ code: "VERIFICATION_EXPIRED", message: "Kode reset password sudah kedaluwarsa." });
    if (verification.attempt_count >= 5) throw new AppError({ code: "VERIFICATION_ATTEMPTS_EXCEEDED", message: "Terlalu banyak percobaan kode reset." });
    if (hash(input.code) !== (await queryOne<{ code_hash: string }>("SELECT code_hash FROM auth_verification_codes WHERE id=$1", [verification.id], client))?.code_hash) {
      await client.query("UPDATE auth_verification_codes SET attempt_count=attempt_count+1 WHERE id=$1", [verification.id]);
      throw new AppError({ code: "INVALID_VERIFICATION_CODE", message: "Kode reset password salah." });
    }
    await client.query("UPDATE customer_auth_accounts SET password_hash=$1,is_verified=true,verified_at=COALESCE(verified_at,now()),updated_at=now() WHERE customer_id=$2 AND provider='email'", [await hashPassword(input.new_password), verification.customer_id]);
    await client.query("UPDATE auth_verification_codes SET consumed_at=now() WHERE id=$1", [verification.id]);
    await client.query("UPDATE customer_sessions SET revoked_at=now() WHERE customer_id=$1 AND revoked_at IS NULL", [verification.customer_id]);
    return verification.customer_id;
  });
  return { reset: true, customer_id: result };
}

export async function refreshMobileSession(input: z.infer<typeof mobileRefreshSchema>) {
  return withTransaction(async (client) => {
    const old = await queryOne<{ id: string; customer_id: string; expires_at: Date; revoked_at: Date | null; device_id: string | null; platform: string | null; app_version: string | null }>("SELECT id,customer_id,expires_at,revoked_at,device_id,platform,app_version FROM customer_sessions WHERE refresh_token_hash=$1 AND device_id=$2 FOR UPDATE", [hash(input.refresh_token), input.installation_id], client);
    if (!old || old.revoked_at || old.expires_at.getTime() <= Date.now()) throw new AppError({ code: "TOKEN_REVOKED", message: "Refresh token tidak berlaku." });
    const refresh = newToken();
    const next = await queryOne<{ id: string }>("INSERT INTO customer_sessions (customer_id,refresh_token_hash,device_id,platform,app_version,expires_at,last_used_at) VALUES ($1,$2,$3,$4,$5,now()+($6 * interval '1 second'),now()) RETURNING id", [old.customer_id, hash(refresh), old.device_id, old.platform, old.app_version, REFRESH_TTL], client);
    if (!next) throw new Error("session insert failed");
    await client.query("UPDATE customer_sessions SET revoked_at=now(),replaced_by_session_id=$2,last_used_at=now() WHERE id=$1", [old.id, next.id]);
    return { access_token: await signMobileAccessToken(old.customer_id, next.id), refresh_token: refresh, token_type: "Bearer", expires_in: ACCESS_TTL };
  });
}

export async function mobileProfile(customerId: string, executor?: Queryable) {
  const profile = await queryOne<{ id: string; full_name: string; avatar_url: string | null; status: string; created_at: Date; email: string | null }>("SELECT c.id,c.full_name,c.avatar_url,c.status,c.created_at,(SELECT email::text FROM customer_auth_accounts WHERE customer_id=c.id AND email IS NOT NULL ORDER BY created_at LIMIT 1) AS email FROM customers c WHERE c.id=$1", [customerId], executor);
  if (!profile) throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Profile tidak ditemukan." });
  const subscription = await queryOne<{ id: string; status: string; plan_id: string; plan_code: string; plan_name: string; device_limit: number | null; billing_interval: string | null; current_period_start: Date; current_period_end: Date | null; cancel_at_period_end: boolean; active_camera_count: number }>("SELECT s.id,s.status,p.id AS plan_id,p.code AS plan_code,p.name AS plan_name,p.device_limit,pr.billing_interval,s.current_period_start,s.current_period_end,s.cancel_at_period_end,(SELECT count(*)::int FROM devices d WHERE d.customer_id=s.customer_id AND d.status='claimed') AS active_camera_count FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id LEFT JOIN plan_prices pr ON pr.id=s.plan_price_id WHERE s.customer_id=$1 ORDER BY s.created_at DESC LIMIT 1", [customerId], executor);
  return { profile: { id: profile.id, full_name: profile.full_name, email: profile.email, avatar_url: profile.avatar_url, status: profile.status, created_at: profile.created_at.toISOString() }, subscription: subscription ? { ...subscription, current_period_start: subscription.current_period_start.toISOString(), current_period_end: subscription.current_period_end?.toISOString() ?? null } : null };
}

export { query, queryOne, withTransaction, clientIp };

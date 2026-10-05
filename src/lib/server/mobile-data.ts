import { z } from "zod";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

import { query, queryOne, withTransaction, type Queryable } from "./db";
import { AppError } from "./errors";
import { requireMobile, profileSchema, settingsSchema, pushSchema, biometricSchema } from "./mobile";
import { listed, noContent, ok, requireUuid } from "./request";
import { parseJson, parseSearchParams } from "./parse";

export const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
  camera_id: z.string().optional(),
  status: z.string().max(40).optional(),
  recording_status: z.string().max(40).optional(),
  is_read: z.enum(["true", "false"]).optional(),
  severity: z.string().max(20).optional(),
  type: z.string().max(80).optional(),
  q: z.string().max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export function mobilePage(request: Request) { return parseSearchParams(new URL(request.url).searchParams, pageSchema); }
function date(value: Date | string | null): string | null { return value ? new Date(value).toISOString() : null; }
function cursor(value: string | undefined): Date | null { return value ? new Date(Buffer.from(value, "base64url").toString()) : null; }
function nextCursor(value: Date): string { return Buffer.from(value.toISOString()).toString("base64url"); }
function pageMeta(rows: any[], limit: number) { const hasMore = rows.length > limit; const items: any[] = hasMore ? rows.slice(0, limit) : rows; return { items, pagination: { next_cursor: hasMore ? nextCursor(items[items.length - 1].cursor_value) : null, has_more: hasMore, limit } }; }

export async function cameraList(customerId: string, params: z.infer<typeof pageSchema>) {
  const values: unknown[] = [customerId]; const where = ["d.customer_id=$1", "d.status IN ('claimed','suspended')"];
  if (params.status) { values.push(params.status); where.push(`COALESCE(t.connection_status,'unknown')=$${values.length}`); }
  if (params.recording_status) { values.push(params.recording_status); where.push(`COALESCE(t.recording_status,'unknown')=$${values.length}`); }
  if (params.q) { values.push(`%${params.q.replace(/[\\%_]/g, "\\$&")} %`.replace(" %", "%")); where.push(`(d.name ILIKE $${values.length} OR d.serial_number ILIKE $${values.length})`); }
  const at = cursor(params.cursor); if (at) { values.push(at); where.push(`d.created_at < $${values.length}`); }
  values.push(params.limit + 1);
  const rows = await query<any>(`SELECT d.id,d.name,d.serial_number,d.model,d.created_at AS cursor_value,COALESCE(t.connection_status,'unknown') status,COALESCE(t.recording_status,'unknown') recording_status,t.thumbnail_url,t.thumbnail_expires_at,t.stream_url,t.last_seen_at FROM devices d LEFT JOIN camera_telemetry t ON t.device_id=d.id WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC LIMIT $${values.length}`, values);
  const page = pageMeta(rows, params.limit);
  return { cameras: page.items.map((r) => ({ id:r.id,name:r.name,serial_number:r.serial_number,model:r.model,status:r.status,recording_status:r.recording_status,thumbnail_url:r.thumbnail_url,stream_url:r.stream_url,thumbnail_expires_at:date(r.thumbnail_expires_at),last_seen_at:date(r.last_seen_at),created_at:date(r.cursor_value) })), pagination: page.pagination };
}

export async function cameraDetail(customerId: string, cameraId: string) {
  const row = await queryOne<any>(`SELECT d.id,d.name,d.serial_number,d.model,COALESCE(t.connection_status,'unknown') status,COALESCE(t.recording_status,'unknown') recording_status,t.thumbnail_url,t.thumbnail_expires_at,t.stream_url,t.last_seen_at,(SELECT max(a.occurred_at) FROM camera_alerts a WHERE a.device_id=d.id) latest_alert_at,(SELECT max(r.started_at) FROM camera_recordings r WHERE r.device_id=d.id) latest_recording_at FROM devices d LEFT JOIN camera_telemetry t ON t.device_id=d.id WHERE d.id=$1 AND d.customer_id=$2 AND d.status IN ('claimed','suspended')`, [cameraId, customerId]);
  if (!row) throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Kamera tidak ditemukan." });
  return { camera: { ...row, thumbnail_expires_at:date(row.thumbnail_expires_at), stream_url: row.stream_url, last_seen_at:date(row.last_seen_at), latest_alert_at:date(row.latest_alert_at), latest_recording_at:date(row.latest_recording_at) } };
}

export async function alertList(customerId: string, params: z.infer<typeof pageSchema>) {
  const values: unknown[] = [customerId]; const where = ["d.customer_id=$1"];
  if (params.camera_id) { values.push(params.camera_id); where.push(`a.device_id=$${values.length}::uuid`); }
  if (params.is_read) { values.push(params.is_read === "true"); where.push(`a.is_read=$${values.length}`); }
  if (params.severity) { values.push(params.severity); where.push(`a.severity=$${values.length}`); }
  if (params.type) { values.push(params.type); where.push(`a.alert_type=$${values.length}`); }
  if (params.from) { values.push(params.from); where.push(`a.occurred_at >= $${values.length}`); }
  if (params.to) { values.push(params.to); where.push(`a.occurred_at <= $${values.length}`); }
  const at=cursor(params.cursor); if(at){values.push(at);where.push(`a.occurred_at < $${values.length}`);} values.push(params.limit+1);
  const rows=await query<any>(`SELECT a.id,a.device_id,d.name camera_name,a.alert_type type,a.severity,a.title,a.message,a.thumbnail_url,a.thumbnail_expires_at,a.occurred_at,a.is_read,a.recording_id,a.occurred_at cursor_value FROM camera_alerts a JOIN devices d ON d.id=a.device_id WHERE ${where.join(" AND ")} ORDER BY a.occurred_at DESC LIMIT $${values.length}`,values); const page=pageMeta(rows,params.limit);
  return { alerts: page.items.map((r)=>({id:r.id,camera_id:r.device_id,camera_name:r.camera_name,type:r.type,severity:r.severity,title:r.title,message:r.message,thumbnail_url:r.thumbnail_url,thumbnail_expires_at:date(r.thumbnail_expires_at),occurred_at:date(r.occurred_at),is_read:r.is_read,recording_id:r.recording_id})), pagination:page.pagination };
}

export async function recordingList(customerId: string, params: z.infer<typeof pageSchema>) {
  const values: unknown[]=[customerId];const where=["d.customer_id=$1","r.status='available'"];if(params.camera_id){values.push(params.camera_id);where.push(`r.device_id=$${values.length}::uuid`);}if(params.from){values.push(params.from);where.push(`r.started_at >= $${values.length}`);}if(params.to){values.push(params.to);where.push(`r.started_at <= $${values.length}`);}const at=cursor(params.cursor);if(at){values.push(at);where.push(`r.started_at < $${values.length}`);}values.push(params.limit+1);const rows=await query<any>(`SELECT r.*,d.name camera_name,r.started_at cursor_value FROM camera_recordings r JOIN devices d ON d.id=r.device_id WHERE ${where.join(" AND ")} ORDER BY r.started_at DESC LIMIT $${values.length}`,values);const page=pageMeta(rows,params.limit);return {recordings:page.items.map((r)=>({id:r.id,camera_id:r.device_id,camera_name:r.camera_name,status:r.status,started_at:date(r.started_at),ended_at:date(r.ended_at),duration_seconds:r.duration_seconds,thumbnail_url:r.thumbnail_url,thumbnail_expires_at:date(r.thumbnail_expires_at),playback_url:r.playback_url,playback_expires_at:date(r.playback_expires_at),expires_at:date(r.expires_at),created_at:date(r.created_at)})),pagination:page.pagination};
}

export async function updateProfile(request: Request, customerId: string) { const input=await parseJson(request,profileSchema); const row=await queryOne<any>("UPDATE customers SET full_name=COALESCE($2,full_name),avatar_url=CASE WHEN $3::boolean THEN $4 ELSE avatar_url END WHERE id=$1 RETURNING id,full_name,avatar_url,status,created_at",[customerId,input.full_name,input.avatar_url!==undefined,input.avatar_url]);if(!row)throw new AppError({code:"RESOURCE_NOT_FOUND",message:"Profile tidak ditemukan."});return {profile:{...row,created_at:date(row.created_at)}}; }
export async function settingsGet(customerId: string, installationId: string) { const row=await queryOne<any>("SELECT * FROM customer_mobile_settings WHERE customer_id=$1 AND installation_id=$2",[customerId,installationId]);return {notifications:{enabled:row?.notifications_enabled??true,permission:'unknown'},alerts:{enabled:row?.alerts_enabled??true,critical_only:row?.critical_alerts_only??false},biometric_login:{enabled:row?.biometric_enabled??false,mode:'local_device'},installation:{id:installationId,platform:row?.platform??null,app_version:row?.app_version??null}}; }
export async function settingsPatch(request: Request, customerId: string) { const input=await parseJson(request,settingsSchema); await query(`INSERT INTO customer_mobile_settings (customer_id,installation_id,platform,app_version,notifications_enabled,alerts_enabled,critical_alerts_only) VALUES ($1,$2,$3,$4,COALESCE($5,true),COALESCE($6,true),COALESCE($7,false)) ON CONFLICT (customer_id,installation_id) DO UPDATE SET platform=COALESCE($3,customer_mobile_settings.platform),app_version=COALESCE($4,customer_mobile_settings.app_version),notifications_enabled=COALESCE($5,customer_mobile_settings.notifications_enabled),alerts_enabled=COALESCE($6,customer_mobile_settings.alerts_enabled),critical_alerts_only=COALESCE($7,customer_mobile_settings.critical_alerts_only),updated_at=now()`,[customerId,input.installation_id,input.platform??'ios',input.app_version??null,input.notifications_enabled,input.alerts_enabled,input.critical_alerts_only]);return settingsGet(customerId,input.installation_id); }
export async function dashboard(customerId:string){const s=await queryOne<any>("SELECT count(*) FILTER(WHERE d.status IN ('claimed','suspended'))::int total_count,count(*) FILTER(WHERE t.connection_status='active')::int active_count,count(*) FILTER(WHERE t.recording_status='recording')::int recording_count,count(*) FILTER(WHERE t.connection_status='offline')::int offline_count,count(*) FILTER(WHERE COALESCE(t.connection_status,'unknown')='unknown')::int unknown_count FROM devices d LEFT JOIN camera_telemetry t ON t.device_id=d.id WHERE d.customer_id=$1 AND d.status IN ('claimed','suspended')",[customerId]);const a=await alertList(customerId,{limit:5});const c=await cameraList(customerId,{limit:5});return {camera_summary:s,alert_summary:{unread_count:(await queryOne<any>("SELECT count(*)::int n FROM camera_alerts a JOIN devices d ON d.id=a.device_id WHERE d.customer_id=$1 AND NOT a.is_read",[customerId]))?.n??0},active_cameras:c, recent_alerts:a.alerts};}

export async function alertDetail(customerId: string, alertId: string) {
  const row = await queryOne<any>("SELECT a.id,a.device_id,d.name camera_name,a.alert_type type,a.severity,a.title,a.message,a.thumbnail_url,a.thumbnail_expires_at,a.occurred_at,a.is_read,a.recording_id FROM camera_alerts a JOIN devices d ON d.id=a.device_id WHERE a.id=$1 AND d.customer_id=$2", [alertId, customerId]);
  if (!row) throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Alert tidak ditemukan." });
  return { alert: { ...row, thumbnail_expires_at: date(row.thumbnail_expires_at), occurred_at: date(row.occurred_at) } };
}
export async function markAlertRead(customerId: string, alertId?: string) {
  const result = alertId
    ? await queryOne<{ updated: number }>("WITH changed AS (UPDATE camera_alerts a SET is_read=true,read_at=COALESCE(read_at,now()) FROM devices d WHERE a.device_id=d.id AND a.id=$1 AND d.customer_id=$2 RETURNING 1) SELECT count(*)::int AS updated FROM changed", [alertId, customerId])
    : await queryOne<{ updated: number }>("WITH changed AS (UPDATE camera_alerts a SET is_read=true,read_at=COALESCE(read_at,now()) FROM devices d WHERE a.device_id=d.id AND d.customer_id=$1 AND NOT a.is_read RETURNING 1) SELECT count(*)::int AS updated FROM changed", [customerId]);
  if (alertId && !result?.updated) throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Alert tidak ditemukan." });
  return { updated_count: result?.updated ?? 0 };
}
export async function recordingDetail(customerId: string, recordingId: string) {
  const row = await queryOne<any>("SELECT r.*,d.name camera_name FROM camera_recordings r JOIN devices d ON d.id=r.device_id WHERE r.id=$1 AND d.customer_id=$2", [recordingId, customerId]);
  if (!row) throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Rekaman tidak ditemukan." });
  return { recording: { ...row, started_at:date(row.started_at), ended_at:date(row.ended_at), thumbnail_expires_at:date(row.thumbnail_expires_at), playback_expires_at:date(row.playback_expires_at), expires_at:date(row.expires_at), created_at:date(row.created_at) } };
}
export async function registerPush(customerId: string, request: Request) {
  const input = await parseJson(request, pushSchema);
  await query("INSERT INTO customer_push_tokens (customer_id,installation_id,platform,token,permission,app_version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (customer_id,installation_id) DO UPDATE SET platform=$3,token=$4,permission=$5,app_version=$6,updated_at=now()", [customerId,input.installation_id,input.platform,input.token,input.permission,input.app_version]);
  return { registered: true };
}
export async function deletePush(customerId: string, installationId: string) { await query("DELETE FROM customer_push_tokens WHERE customer_id=$1 AND installation_id=$2", [customerId, installationId]); }
export async function setBiometric(customerId: string, request: Request, enabled: boolean) {
  const input = await parseJson(request, biometricSchema);
  await query("INSERT INTO customer_mobile_settings (customer_id,installation_id,platform,biometric_enabled) VALUES ($1,$2,$3,$4) ON CONFLICT (customer_id,installation_id) DO UPDATE SET platform=$3,biometric_enabled=$4,updated_at=now()", [customerId,input.installation_id,input.platform,enabled]);
  return { enabled, mode: "local_device" };
}
export async function helpList(params: { limit: number; cursor?: string; q?: string; }) {
  const values: unknown[] = ["id-ID"]; const where = ["is_published=true", "locale=$1"];
  if (params.q) { values.push(`%${params.q}%`); where.push(`(title ILIKE $${values.length} OR content ILIKE $${values.length})`); }
  values.push(params.limit + 1);
  const rows = await query<any>(`SELECT id,slug,category,title,summary,updated_at AS cursor_value,updated_at FROM mobile_help_articles WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT $${values.length}`, values); const page = pageMeta(rows, params.limit);
  return { articles: page.items.map((r) => ({ id:r.id,slug:r.slug,category:r.category,title:r.title,summary:r.summary,updated_at:date(r.updated_at) })), pagination:page.pagination };
}
export async function helpDetail(articleId: string) { const row = await queryOne<any>("SELECT id,slug,category,title,content,locale,updated_at FROM mobile_help_articles WHERE id=$1 AND is_published=true", [articleId]); if (!row) throw new AppError({ code:"RESOURCE_NOT_FOUND", message:"Artikel bantuan tidak ditemukan." }); return { article:{...row,updated_at:date(row.updated_at)} }; }
export async function terms(locale = "id-ID", version?: string) { const row = await queryOne<any>(`SELECT document_type type,version,locale,title,content,effective_at,updated_at FROM legal_documents WHERE document_type='terms_and_conditions' AND locale=$1 AND ${version ? "version=$2" : "is_current=true"} ORDER BY effective_at DESC LIMIT 1`, version ? [locale,version] : [locale]); if (!row) throw new AppError({ code:"RESOURCE_NOT_FOUND", message:"Terms and Conditions tidak ditemukan." }); return { document:{...row,effective_at:date(row.effective_at),updated_at:date(row.updated_at)} }; }

export { query, queryOne, withTransaction, requireMobile, ok, noContent, listed, requireUuid };

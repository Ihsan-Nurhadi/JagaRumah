import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { query } from "./db";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let cachedAuth: { auth: GoogleAuth; projectId: string } | null = null;

function getFcmAuth(): { auth: GoogleAuth; projectId: string } | null {
  if (cachedAuth) return cachedAuth;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;

  try {
    const jsonStr = raw.startsWith("{") ? raw : readFileSync(raw, "utf8");
    const credentials = JSON.parse(jsonStr) as ServiceAccount;
    if (!credentials.project_id || !credentials.client_email || !credentials.private_key) {
      console.warn("[fcm] FIREBASE_SERVICE_ACCOUNT_JSON tidak lengkap.");
      return null;
    }
    const auth = new GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    });
    cachedAuth = { auth, projectId: credentials.project_id };
    return cachedAuth;
  } catch (err) {
    console.warn("[fcm] Gagal memuat konfigurasi Firebase Service Account:", err);
    return null;
  }
}

export interface AlertPushPayload {
  customerId: string;
  alertId: string;
  cameraId: string;
  cameraName: string;
  alertType: string;
  severity: string;
  title: string;
  body: string;
  occurredAt: string;
}

export async function sendAlertPushNotification(payload: AlertPushPayload): Promise<void> {
  const fcm = getFcmAuth();
  if (!fcm) return;

  const tokens = await query<{ token: string; platform: string }>(
    `SELECT token, platform
     FROM customer_push_tokens
     WHERE customer_id = $1 AND permission = 'granted'`,
    [payload.customerId],
  );
  if (tokens.length === 0) return;

  const client = await fcm.auth.getClient();
  const accessTokenRes = await client.getAccessToken();
  const accessToken = accessTokenRes.token;
  if (!accessToken) return;

  const endpoint = `https://fcm.googleapis.com/v1/projects/${fcm.projectId}/messages:send`;

  await Promise.allSettled(
    tokens.map(async ({ token }) => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token,
            notification: {
              title: `${payload.title} • ${payload.cameraName}`,
              body: payload.body,
            },
            data: {
              alert_id: payload.alertId,
              camera_id: payload.cameraId,
              camera_name: payload.cameraName,
              type: payload.alertType,
              severity: payload.severity,
              occurred_at: payload.occurredAt,
            },
            android: {
              priority: "high",
              notification: {
                channel_id: "cctv_alerts",
                sound: "default",
              },
            },
          },
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        if (res.status === 404 || errBody.includes("UNREGISTERED")) {
          await query("DELETE FROM customer_push_tokens WHERE token = $1", [token]).catch(() => {});
        } else {
          console.warn(`[fcm] Push gagal (${res.status}): ${errBody}`);
        }
      }
    }),
  );
}

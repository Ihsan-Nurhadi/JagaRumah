import { createHash, randomBytes } from "node:crypto";
import { AppError } from "./errors";

export type PtzDirection = "up" | "down" | "left" | "right" | "zoom_in" | "zoom_out" | "stop";

interface OnvifTarget {
  port: number;
  profileToken: string;
}

const profileCache = new Map<string, OnvifTarget>();

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildWsSecurityHeader(username: string, password: string): string {
  const nonceBytes = randomBytes(16);
  const created = new Date().toISOString();
  const digest = createHash("sha1")
    .update(Buffer.concat([nonceBytes, Buffer.from(created, "utf8"), Buffer.from(password, "utf8")]))
    .digest("base64");

  return `
    <wsse:Security s:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>${escapeXml(username)}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
        <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceBytes.toString("base64")}</wsse:Nonce>
        <wsu:Created>${created}</wsu:Created>
      </wsse:UsernameToken>
    </wsse:Security>
  `.trim();
}

function wrapSoapEnvelope(bodyXml: string, username: string, password: string): string {
  const securityHeader = username ? buildWsSecurityHeader(username, password) : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
  xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"
  xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Header>${securityHeader}</s:Header>
  <s:Body>${bodyXml}</s:Body>
</s:Envelope>`;
}

async function postSoap(url: string, soapXml: string, timeoutMs = 3000): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/soap+xml; charset=utf-8",
    },
    body: soapXml,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, text };
}

async function resolveOnvifTarget(host: string, rtspPort: number | null, username: string, password: string): Promise<OnvifTarget> {
  const cacheKey = `${host}:${rtspPort ?? ""}`;
  const cached = profileCache.get(cacheKey);
  if (cached) return cached;

  const envPort = process.env.ONVIF_PORT ? Number.parseInt(process.env.ONVIF_PORT, 10) : null;
  // Dukungan port-forwarding router (misal RTSP 554->ONVIF 2020, 555->2021, 556->2022)
  const mappedOnvifPort =
    rtspPort && rtspPort >= 554 && rtspPort <= 599 ? 2020 + (rtspPort - 554) : null;
  const candidatePorts = [
    ...new Set(
      [mappedOnvifPort, envPort, 2020, 2021, 2022, 80, 8000].filter((p): p is number => Boolean(p && p > 0)),
    ),
  ];
  const getProfilesBody = `<trt:GetProfiles/>`;

  for (const port of candidatePorts) {
    for (const servicePath of ["/onvif/media_service", "/onvif/service"]) {
      try {
        const soap = wrapSoapEnvelope(getProfilesBody, username, password);
        const res = await postSoap(`http://${host}:${port}${servicePath}`, soap, 2500);
        if (!res.ok) continue;

        const tokenMatch = /<[^:>]*:?Profiles[^>]*\btoken="([^"]+)"/i.exec(res.text);
        const profileToken = tokenMatch?.[1] ?? "profile_1";
        const target = { port, profileToken };
        profileCache.set(cacheKey, target);
        return target;
      } catch {
        // Coba port/path ONVIF berikutnya
      }
    }
  }

  throw new AppError({
    code: "INTERNAL_ERROR",
    message: `Kamera (${host}) tidak merespons protokol ONVIF PTZ (port ${candidatePorts.join("/")}). Pastikan fitur ONVIF/Account kamera aktif.`,
  });
}

async function sendPtzSoap(
  host: string,
  port: number,
  username: string,
  password: string,
  bodyXml: string,
): Promise<void> {
  const soap = wrapSoapEnvelope(bodyXml, username, password);
  let lastStatus = 0;

  for (const servicePath of ["/onvif/ptz_service", "/onvif/service"]) {
    try {
      const res = await postSoap(`http://${host}:${port}${servicePath}`, soap, 3000);
      if (res.ok) return;
      lastStatus = res.status;
    } catch {
      // Coba endpoint PTZ berikutnya
    }
  }

  profileCache.delete(host);
  throw new AppError({
    code: "INTERNAL_ERROR",
    message: `Perintah PTZ ditolak atau gagal terkirim ke kamera (HTTP ${lastStatus || "timeout"}).`,
  });
}

export async function sendOnvifPtzCommand(params: {
  streamUrl: string;
  direction: PtzDirection;
  speed: number;
  durationMs: number;
}): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(params.streamUrl);
  } catch {
    throw new AppError({ code: "VALIDATION_ERROR", message: "Format RTSP URL kamera tidak valid." });
  }

  const host = parsed.hostname;
  const rtspPort = parsed.port ? Number.parseInt(parsed.port, 10) : null;
  const username = decodeURIComponent(parsed.username || "");
  const password = decodeURIComponent(parsed.password || "");
  const target = await resolveOnvifTarget(host, rtspPort, username, password);

  const stopBody = `
    <tptz:Stop>
      <tptz:ProfileToken>${escapeXml(target.profileToken)}</tptz:ProfileToken>
      <tptz:PanTilt>true</tptz:PanTilt>
      <tptz:Zoom>true</tptz:Zoom>
    </tptz:Stop>
  `.trim();

  if (params.direction === "stop") {
    await sendPtzSoap(host, target.port, username, password, stopBody);
    return;
  }

  const s = Math.min(1, Math.max(0.1, params.speed));
  let panTiltXml = "";
  let zoomXml = "";

  switch (params.direction) {
    case "left":
      panTiltXml = `<tt:PanTilt x="${(-s).toFixed(2)}" y="0.00"/>`;
      break;
    case "right":
      panTiltXml = `<tt:PanTilt x="${s.toFixed(2)}" y="0.00"/>`;
      break;
    case "up":
      panTiltXml = `<tt:PanTilt x="0.00" y="${s.toFixed(2)}"/>`;
      break;
    case "down":
      panTiltXml = `<tt:PanTilt x="0.00" y="${(-s).toFixed(2)}"/>`;
      break;
    case "zoom_in":
      zoomXml = `<tt:Zoom x="${s.toFixed(2)}"/>`;
      break;
    case "zoom_out":
      zoomXml = `<tt:Zoom x="${(-s).toFixed(2)}"/>`;
      break;
  }

  const moveBody = `
    <tptz:ContinuousMove>
      <tptz:ProfileToken>${escapeXml(target.profileToken)}</tptz:ProfileToken>
      <tptz:Velocity>
        ${panTiltXml}
        ${zoomXml}
      </tptz:Velocity>
    </tptz:ContinuousMove>
  `.trim();

  await sendPtzSoap(host, target.port, username, password, moveBody);

  if (params.durationMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, params.durationMs));
    await sendPtzSoap(host, target.port, username, password, stopBody).catch(() => {});
  }
}

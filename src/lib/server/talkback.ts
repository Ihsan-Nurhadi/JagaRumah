import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors";

const TALK_TMP_DIR = process.env.TALK_TMP_DIR ?? "/talk-tmp";

function getWorkerCandidates(): string[] {
  return [
    process.env.TAPO_TALK_WORKER_URL,
    "http://host.docker.internal:8099",
    "http://172.17.0.1:8099",
    "http://172.18.0.1:8099",
  ].filter(Boolean) as string[];
}

function resolveControlPort(rtspPort: number | null): number {
  if (process.env.TAPO_CONTROL_PORT) {
    const parsed = Number.parseInt(process.env.TAPO_CONTROL_PORT, 10);
    if (parsed > 0) return parsed;
  }
  // Pemetaan port forwarding OpenWrt: RTSP 556 -> 8443, default -> 443
  if (rtspPort === 556) return 8443;
  return 443;
}

/**
 * Mengirim audio dari HP ke speaker Tapo C500 lewat worker Python `pytapo`.
 */
export async function sendAudioToCameraSpeaker(params: {
  streamKey: string;
  rtspUrl: string;
  audioBuffer: Buffer;
  inputExtension?: string;
}): Promise<void> {
  if (params.audioBuffer.length === 0) {
    throw new AppError({ code: "VALIDATION_ERROR", message: "File audio tidak boleh kosong." });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.rtspUrl);
  } catch {
    throw new AppError({ code: "VALIDATION_ERROR", message: "Format RTSP URL kamera tidak valid." });
  }

  const host = parsedUrl.hostname;
  const rtspPort = parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : null;
  const rtspUser = decodeURIComponent(parsedUrl.username || "");
  const rtspPassword = decodeURIComponent(parsedUrl.password || "");
  const cloudPassword = process.env.TAPO_CLOUD_PASSWORD || rtspPassword;
  const controlPort = resolveControlPort(rtspPort);

  await mkdir(TALK_TMP_DIR, { recursive: true });
  const id = randomUUID();
  const safeExt = (params.inputExtension ?? "m4a").replace(/[^a-z0-9]/gi, "") || "m4a";
  const rawInputPath = path.join(TALK_TMP_DIR, `in-${id}.${safeExt}`);

  try {
    await writeFile(rawInputPath, params.audioBuffer);

    const candidates = getWorkerCandidates();
    let res: Response | null = null;
    let lastErr: unknown = null;

    for (const base of candidates) {
      try {
        res = await fetch(`${base}/talk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            host,
            control_port: controlPort,
            rtsp_user: rtspUser,
            rtsp_password: rtspPassword,
            cloud_password: cloudPassword,
            audio_path: rawInputPath,
          }),
          signal: AbortSignal.timeout(30000),
        });
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!res) {
      console.error("[tapo-talk] gagal menjangkau worker pytapo:", lastErr);
      throw new AppError({
        code: "INTERNAL_ERROR",
        message: "Layanan speaker (tapo-talk worker) belum aktif atau tidak terjangkau.",
      });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new AppError({
        code: "INTERNAL_ERROR",
        message: `Gagal memutar audio di speaker kamera (HTTP ${res.status}): ${errBody}`,
      });
    }
  } finally {
    await unlink(rawInputPath).catch(() => {});
  }
}

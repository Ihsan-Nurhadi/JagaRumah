import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AppError } from "./errors";

const execFileAsync = promisify(execFile);
const TALK_TMP_DIR = process.env.TALK_TMP_DIR ?? "/talk-tmp";

function getGo2RtcCandidates(): string[] {
  return [
    process.env.GO2RTC_API_URL,
    "http://host.docker.internal:1984",
    "http://172.17.0.1:1984",
    "http://172.18.0.1:1984",
  ].filter(Boolean) as string[];
}

async function fetchGo2Rtc(pathname: string, init: RequestInit): Promise<Response> {
  const candidates = getGo2RtcCandidates();
  let lastErr: unknown = null;

  for (const base of candidates) {
    try {
      const res = await fetch(`${base}${pathname}`, {
        ...init,
        signal: AbortSignal.timeout(15000),
      });
      return res;
    } catch (err) {
      lastErr = err;
    }
  }

  console.error("[go2rtc] tidak dapat menjangkau server go2rtc:", lastErr);
  throw new AppError({
    code: "INTERNAL_ERROR",
    message: "Layanan speaker (go2rtc) belum aktif atau tidak terjangkau.",
  });
}

/**
 * Mengonversi audio dari HP ke WAV 8kHz mono lalu memutarnya ke speaker kamera via go2rtc backchannel.
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

  await mkdir(TALK_TMP_DIR, { recursive: true });
  const id = randomUUID();
  const safeExt = (params.inputExtension ?? "m4a").replace(/[^a-z0-9]/gi, "") || "m4a";
  const rawInputPath = path.join(TALK_TMP_DIR, `in-${id}.${safeExt}`);
  const wavFileName = `talk-${id}.wav`;
  const wavOutputPath = path.join(TALK_TMP_DIR, wavFileName);

  try {
    await writeFile(rawInputPath, params.audioBuffer);

    // Normalisasi audio ke 8kHz mono PCM WAV agar kompatibel dengan G.711 backchannel Tapo C500
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", rawInputPath, "-ar", "8000", "-ac", "1", "-c:a", "pcm_s16le", wavOutputPath],
      { timeout: 20000 },
    );

    // 1. Pastikan stream kamera terdaftar di go2rtc
    const registerRes = await fetchGo2Rtc(
      `/api/streams?name=${encodeURIComponent(params.streamKey)}&src=${encodeURIComponent(params.rtspUrl)}`,
      { method: "PUT" },
    );
    if (!registerRes.ok) {
      const errText = await registerRes.text().catch(() => "");
      throw new AppError({
        code: "INTERNAL_ERROR",
        message: `Gagal mendaftarkan stream speaker ke go2rtc (HTTP ${registerRes.status}): ${errText}`,
      });
    }

    // 2. Kirim audio ke speaker kamera lewat RTSP backchannel
    const ffmpegSrc = `ffmpeg:${path.posix.join("/talk-tmp", wavFileName)}#audio=pcma`;
    const talkRes = await fetchGo2Rtc(
      `/api/streams?dst=${encodeURIComponent(params.streamKey)}&src=${encodeURIComponent(ffmpegSrc)}`,
      { method: "POST" },
    );

    if (!talkRes.ok) {
      const errText = await talkRes.text().catch(() => "");
      throw new AppError({
        code: "INTERNAL_ERROR",
        message: `Kamera menolak atau gagal memutar audio speaker (HTTP ${talkRes.status}): ${errText}`,
      });
    }
  } finally {
    await unlink(rawInputPath).catch(() => {});
    // Tunggu sebentar agar go2rtc selesai membaca wavOutputPath sebelum dihapus
    setTimeout(() => {
      void unlink(wavOutputPath).catch(() => {});
    }, 15000);
  }
}

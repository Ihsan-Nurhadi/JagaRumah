import { spawn } from "node:child_process";
import { findDevice } from "@/lib/server/devices";
import { readFirstJpeg } from "@/lib/server/camera-stream";
import { AppError } from "@/lib/server/errors";
import { requireAdmin, requirePermission } from "@/lib/server/guard";
import { requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Params = { params: Promise<{ device_id?: string }> };

async function captureRtspFrame(rtspUrl: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(
        "ffmpeg",
        [
          "-rtsp_transport",
          "tcp",
          "-i",
          rtspUrl,
          "-vframes",
          "1",
          "-f",
          "image2",
          "-q:v",
          "3",
          "pipe:1",
        ],
        { timeout: 3500 },
      );

      const chunks: Buffer[] = [];
      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.on("error", () => resolve(null));
      proc.on("close", (code) => {
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

export const GET = routeHandler("admin.devices.stream", async (_request, _requestId, context) => {
  const admin = await requireAdmin();
  requirePermission(admin, "device.read");

  const { device_id: rawId } = await (context as Params).params;
  const deviceId = requireUuid(rawId, "device_id");
  const device = await findDevice(deviceId);

  if (!device || !device.stream_url) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Stream CCTV tidak ditemukan." });
  }

  // Jika stream URL adalah RTSP (misal Tapo C500 via OpenVPN), tangkap frame langsung via FFmpeg
  if (device.stream_url.startsWith("rtsp://")) {
    const frame = await captureRtspFrame(device.stream_url);
    if (!frame) {
      throw new AppError({
        code: "INTERNAL_ERROR",
        message: "Stream RTSP CCTV tidak dapat dijangkau dari server (koneksi timeout atau ditolak oleh kamera). Pastikan kredensial username/password kamera benar.",
      });
    }
    return new Response(new Uint8Array(frame), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      },
    });
  }

  const candidateUrls = [device.stream_url];
  try {
    const parsed = new URL(device.stream_url);
    if (parsed.hostname === "110.232.92.134" || parsed.hostname === "dev.nayakacloud.com") {
      const u1 = new URL(device.stream_url);
      u1.hostname = "127.0.0.1";
      candidateUrls.push(u1.toString());

      const u2 = new URL(device.stream_url);
      u2.hostname = "host.docker.internal";
      candidateUrls.push(u2.toString());

      const u3 = new URL(device.stream_url);
      u3.hostname = "172.17.0.1";
      candidateUrls.push(u3.toString());
    }
  } catch {
    // URL tidak dapat di-parse, gunakan URL asli saja
  }

  let upstream: Response | null = null;
  for (const targetUrl of candidateUrls) {
    try {
      const res = await fetch(targetUrl, {
        headers: { Accept: "multipart/x-mixed-replace" },
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok && res.body) {
        upstream = res;
        break;
      }
    } catch {
      // Coba kandidat URL berikutnya
    }
  }

  if (!upstream || !upstream.body) {
    throw new AppError({
      code: "INTERNAL_ERROR",
      message: "Stream CCTV tidak dapat dijangkau dari server (koneksi timeout atau ditolak).",
    });
  }

  const frame = await readFirstJpeg(upstream);
  if (!frame) {
    throw new AppError({
      code: "INTERNAL_ERROR",
      message: "Frame CCTV tidak dapat dibaca dari data stream.",
    });
  }

  return new Response(new Uint8Array(frame), {
    status: 200,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "Content-Type": "image/jpeg",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

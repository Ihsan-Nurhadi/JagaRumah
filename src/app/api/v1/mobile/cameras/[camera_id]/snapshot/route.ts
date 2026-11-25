import { spawn } from "node:child_process";
import { queryOne } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireMobile } from "@/lib/server/mobile";
import { requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

type Context = { params: Promise<{ camera_id?: string }> };

async function captureRtspJpeg(rtspUrl: string, timeoutMs = 8000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(
        "ffmpeg",
        [
          "-loglevel",
          "error",
          "-rtsp_transport",
          "tcp",
          "-timeout",
          "6000000",
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
        { timeout: timeoutMs },
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

/**
 * Mengambil 1 frame JPEG terbaru dari kamera milik customer.
 * Digunakan oleh aplikasi Mobile sebagai latar belakang saat menggambar Zona Parkir
 * agar koordinat ternormalisasi (0..1) presisi 100% dengan frame analisis AI.
 */
export const GET = routeHandler("mobile.cameras.snapshot", async (request, _requestId, context) => {
  const session = await requireMobile(request);
  const cameraId = requireUuid((await (context as Context).params).camera_id, "camera_id");

  const row = await queryOne<{ id: string; serial_number: string; stream_url: string | null }>(
    `SELECT d.id, d.serial_number, t.stream_url
     FROM devices d
     LEFT JOIN camera_telemetry t ON t.device_id = d.id
     WHERE d.id = $1 AND d.customer_id = $2 AND d.status IN ('claimed', 'suspended')`,
    [cameraId, session.customerId],
  );

  if (!row) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Kamera tidak ditemukan." });
  }
  if (!row.stream_url?.startsWith("rtsp://")) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message: "Kamera belum memiliki sumber stream RTSP untuk mengambil snapshot.",
    });
  }

  const streamKey = `cam-${row.serial_number.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  const mediamtxHosts = [
    process.env.MEDIAMTX_RTSP_HOST,
    "host.docker.internal",
    "172.17.0.1",
    "172.18.0.1",
    "127.0.0.1",
  ].filter(Boolean) as string[];

  const candidates = [
    ...mediamtxHosts.map((host) => `rtsp://${host}:8554/${streamKey}`),
    row.stream_url,
  ];

  let frame: Buffer | null = null;
  for (const url of candidates) {
    frame = await captureRtspJpeg(url, 7000);
    if (frame) break;
  }

  if (!frame) {
    throw new AppError({
      code: "INTERNAL_ERROR",
      message: "Gagal mengambil snapshot dari kamera. Pastikan kamera sedang online.",
    });
  }

  return new Response(new Uint8Array(frame), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(frame.length),
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
});

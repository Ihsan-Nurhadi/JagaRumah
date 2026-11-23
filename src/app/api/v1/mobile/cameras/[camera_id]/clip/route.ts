import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { query, queryOne } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireMobile } from "@/lib/server/mobile";
import { RECORDINGS_DIR } from "@/lib/server/recordings-sync";
import { requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";

const execFileAsync = promisify(execFile);
const MAX_CLIP_DURATION_MS = 30 * 60 * 1000;

type Context = { params: Promise<{ camera_id?: string }> };

export const GET = routeHandler("mobile.cameras.clip", async (request, _requestId, context) => {
  const session = await requireMobile(request);
  const cameraId = requireUuid((await (context as Context).params).camera_id, "camera_id");

  const device = await queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM devices
     WHERE id = $1 AND customer_id = $2 AND status IN ('claimed', 'suspended')`,
    [cameraId, session.customerId],
  );
  if (!device) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Kamera tidak ditemukan." });
  }

  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  if (!fromParam || !toParam) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: "Parameter query `from` dan `to` (ISO-8601) wajib diisi.",
    });
  }

  const fromDate = new Date(fromParam);
  const toDate = new Date(toParam);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || toDate <= fromDate) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: "Rentang waktu `from` dan `to` tidak valid.",
    });
  }

  const clipDurationMs = toDate.getTime() - fromDate.getTime();
  if (clipDurationMs > MAX_CLIP_DURATION_MS) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: "Durasi klip maksimal adalah 30 menit per permintaan.",
    });
  }

  const segments = await query<{ file_path: string; started_at: Date; ended_at: Date }>(
    `SELECT file_path, started_at, COALESCE(ended_at, started_at) AS ended_at
     FROM camera_recordings
     WHERE device_id = $1
       AND status = 'available'
       AND file_path IS NOT NULL
       AND started_at >= now() - interval '24 hours'
       AND started_at <= $3
       AND COALESCE(ended_at, started_at) >= $2
     ORDER BY started_at ASC`,
    [cameraId, fromDate.toISOString(), toDate.toISOString()],
  );

  if (segments.length === 0) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message: "Tidak ada rekaman tersedia pada rentang waktu tersebut (retensi maksimal 24 jam).",
    });
  }

  const rootDir = path.resolve(RECORDINGS_DIR);
  const resolvedPaths: string[] = [];
  for (const seg of segments) {
    const full = path.resolve(rootDir, seg.file_path);
    if (!full.startsWith(`${rootDir}${path.sep}`)) continue;
    try {
      const s = await stat(full);
      if (s.isFile() && s.size > 0) resolvedPaths.push(full);
    } catch {
      // Abaikan file yang sudah terhapus
    }
  }

  if (resolvedPaths.length === 0) {
    throw new AppError({
      code: "RESOURCE_NOT_FOUND",
      message: "File rekaman fisik sudah tidak tersedia di server.",
    });
  }

  const tempId = randomUUID();
  const listPath = path.join("/tmp", `nayaka-concat-${tempId}.txt`);
  const outPath = path.join("/tmp", `nayaka-clip-${tempId}.mp4`);

  const firstStartMs = new Date(segments[0].started_at).getTime();
  const offsetSec = Math.max(0, (fromDate.getTime() - firstStartMs) / 1000);
  const durationSec = Math.max(1, clipDurationMs / 1000);

  try {
    const concatContent = resolvedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(listPath, concatContent, "utf8");

    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-ss",
        offsetSec.toFixed(2),
        "-t",
        durationSec.toFixed(2),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outPath,
      ],
      { timeout: 60000 },
    );

    const outStat = await stat(outPath);
    const isDownload = url.searchParams.get("download") === "1";
    const safeName = device.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "camera";
    const filename = `${safeName}-${fromDate.toISOString().replace(/[:.]/g, "-")}.mp4`;

    const nodeStream = createReadStream(outPath);
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        nodeStream.on("data", (chunk) => {
          controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
        });
        nodeStream.on("end", () => {
          controller.close();
          void unlink(outPath).catch(() => {});
        });
        nodeStream.on("error", (err) => {
          controller.error(err);
          void unlink(outPath).catch(() => {});
        });
      },
      cancel() {
        nodeStream.destroy();
        void unlink(outPath).catch(() => {});
      },
    });

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(outStat.size),
        "Access-Control-Allow-Origin": "*",
        "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="${filename}"`,
      },
    });
  } catch (error) {
    await unlink(outPath).catch(() => {});
    throw error;
  } finally {
    await unlink(listPath).catch(() => {});
  }
});

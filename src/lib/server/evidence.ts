import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { queryOne } from "./db";
import { AppError } from "./errors";

export const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "/evidence";

function nodeStreamToWeb(nodeStream: ReturnType<typeof createReadStream>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => {
        controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

export async function resolveEvidenceFile(relPath: string | null): Promise<{ fullPath: string; size: number }> {
  if (!relPath) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "File bukti tidak tersedia." });
  }
  const rootDir = path.resolve(EVIDENCE_DIR);
  const fullPath = path.resolve(rootDir, relPath);
  if (!fullPath.startsWith(`${rootDir}${path.sep}`)) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Path file bukti tidak valid." });
  }
  try {
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile() || fileStat.size <= 0) {
      throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "File bukti kosong atau tidak ditemukan." });
    }
    return { fullPath, size: fileStat.size };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "File bukti sudah kedaluwarsa atau terhapus." });
  }
}

export async function streamSnapshotFile(relPath: string | null): Promise<Response> {
  const { fullPath, size } = await resolveEvidenceFile(relPath);
  const stream = createReadStream(fullPath);
  return new Response(nodeStreamToWeb(stream), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}

export async function streamClipFile(request: Request, relPath: string | null, downloadName?: string): Promise<Response> {
  const { fullPath, size } = await resolveEvidenceFile(relPath);
  const rangeHeader = request.headers.get("range");

  const baseHeaders: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  if (downloadName) {
    baseHeaders["Content-Disposition"] = `attachment; filename="${downloadName}"`;
  }

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (!match) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Math.min(Number.parseInt(match[2], 10), size - 1) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const chunkSize = end - start + 1;
    const stream = createReadStream(fullPath, { start, end });
    return new Response(nodeStreamToWeb(stream), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(chunkSize),
      },
    });
  }

  const stream = createReadStream(fullPath);
  return new Response(nodeStreamToWeb(stream), {
    status: 200,
    headers: {
      ...baseHeaders,
      "Content-Length": String(size),
    },
  });
}

const WEEKDAY_MAP: Record<number, string> = {
  0: "Min",
  1: "Sen",
  2: "Sel",
  3: "Rab",
  4: "Kam",
  5: "Jum",
  6: "Sab",
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((v) => Number.parseInt(v, 10));
  return (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m);
}

/**
 * Mengecek apakah push notification untuk kamera ini sedang di-mute oleh Sleep Mode customer.
 * Waktu dievaluasi dalam zona waktu Asia/Jakarta (WIB, UTC+7).
 */
export async function isCameraMutedBySleepSchedule(customerId: string, deviceId: string): Promise<boolean> {
  const schedule = await queryOne<{
    enabled: boolean;
    start_time: string;
    end_time: string;
    active_days: string[];
    camera_ids: string[];
  }>(
    `SELECT enabled, start_time, end_time, active_days, camera_ids
     FROM customer_sleep_schedules
     WHERE customer_id = $1`,
    [customerId],
  );

  if (!schedule || !schedule.enabled) return false;
  if (schedule.camera_ids.length > 0 && !schedule.camera_ids.includes(deviceId)) return false;

  const wibNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const dayLabel = WEEKDAY_MAP[wibNow.getUTCDay()];
  if (!schedule.active_days.includes(dayLabel)) return false;

  const nowMin = wibNow.getUTCHours() * 60 + wibNow.getUTCMinutes();
  const startMin = toMinutes(schedule.start_time);
  const endMin = toMinutes(schedule.end_time);

  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Rentang melewati tengah malam, mis. 22:00 -> 06:00
  return nowMin >= startMin || nowMin < endMin;
}

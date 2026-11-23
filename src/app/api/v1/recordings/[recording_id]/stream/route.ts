import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { query, queryOne } from "@/lib/server/db";
import { RECORDINGS_DIR } from "@/lib/server/recordings-sync";

const execFileAsync = promisify(execFile);

type Context = { params: Promise<{ recording_id?: string }> };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inFlightMerges = new Map<string, Promise<string>>();

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

async function ensureMergedBlockFile(recordingId: string, fullPaths: string[]): Promise<string> {
  const cachePath = path.join("/tmp", `nayaka-block-${recordingId}-${fullPaths.length}.mp4`);
  try {
    const s = await stat(cachePath);
    if (s.isFile() && s.size > 0) return cachePath;
  } catch {
    // Belum ada di cache /tmp
  }

  const existingJob = inFlightMerges.get(cachePath);
  if (existingJob) return existingJob;

  const job = (async () => {
    const listPath = path.join("/tmp", `nayaka-block-list-${randomUUID()}.txt`);
    const tmpOut = `${cachePath}.${randomUUID()}.tmp.mp4`;
    try {
      const concatContent = fullPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
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
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          tmpOut,
        ],
        { timeout: 60000 },
      );

      // Rename atomik tidak diperlukan jika kita langsung pakai atau rename ke cachePath
      const { rename } = await import("node:fs/promises");
      await rename(tmpOut, cachePath);
      return cachePath;
    } catch (err) {
      await unlink(tmpOut).catch(() => {});
      throw err;
    } finally {
      await unlink(listPath).catch(() => {});
      inFlightMerges.delete(cachePath);
    }
  })();

  inFlightMerges.set(cachePath, job);
  return job;
}

async function resolveRecordingFile(recordingId: string) {
  if (!UUID_REGEX.test(recordingId)) {
    return null;
  }

  const anchor = await queryOne<{ device_id: string; started_at: Date }>(
    `SELECT device_id, started_at
     FROM camera_recordings
     WHERE id = $1
       AND status = 'available'
       AND started_at >= now() - interval '24 hours'`,
    [recordingId],
  );
  if (!anchor) return null;

  const bucketStartMs = Math.floor(new Date(anchor.started_at).getTime() / 600_000) * 600_000;
  const bucketStartIso = new Date(bucketStartMs).toISOString();
  const bucketEndIso = new Date(bucketStartMs + 600_000).toISOString();

  const segments = await query<{ file_path: string }>(
    `SELECT file_path
     FROM camera_recordings
     WHERE device_id = $1
       AND status = 'available'
       AND file_path IS NOT NULL
       AND started_at >= $2
       AND started_at < $3
     ORDER BY started_at ASC`,
    [anchor.device_id, bucketStartIso, bucketEndIso],
  );

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

  if (resolvedPaths.length === 0) return null;

  const targetPath =
    resolvedPaths.length === 1
      ? resolvedPaths[0]
      : await ensureMergedBlockFile(recordingId, resolvedPaths);

  try {
    const fileStat = await stat(targetPath);
    if (!fileStat.isFile()) return null;
    const filename = `recording-${bucketStartIso.replace(/[:.]/g, "-")}.mp4`;
    return { fullPath: targetPath, size: fileStat.size, filename };
  } catch {
    return null;
  }
}

export async function HEAD(_request: Request, context: Context): Promise<Response> {
  const { recording_id } = await context.params;
  const resolved = recording_id ? await resolveRecordingFile(recording_id) : null;
  if (!resolved) {
    return new Response("Recording not found", { status: 404 });
  }

  return new Response(null, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(resolved.size),
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const { recording_id } = await context.params;
  const resolved = recording_id ? await resolveRecordingFile(recording_id) : null;
  if (!resolved) {
    return new Response("Recording not found or expired", {
      status: 404,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  const url = new URL(request.url);
  const isDownload = url.searchParams.get("download") === "1";
  const rangeHeader = request.headers.get("range");
  const baseHeaders: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "private, max-age=300",
    ...(isDownload
      ? { "Content-Disposition": `attachment; filename="${resolved.filename}"` }
      : {}),
  };

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      return new Response("Invalid range", {
        status: 416,
        headers: { "Content-Range": `bytes */${resolved.size}` },
      });
    }

    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Math.min(Number.parseInt(match[2], 10), resolved.size - 1) : resolved.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= resolved.size) {
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${resolved.size}` },
      });
    }

    const chunkSize = end - start + 1;
    const stream = createReadStream(resolved.fullPath, { start, end });
    return new Response(nodeStreamToWeb(stream), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${resolved.size}`,
        "Content-Length": String(chunkSize),
      },
    });
  }

  const stream = createReadStream(resolved.fullPath);
  return new Response(nodeStreamToWeb(stream), {
    status: 200,
    headers: {
      ...baseHeaders,
      "Content-Length": String(resolved.size),
    },
  });
}

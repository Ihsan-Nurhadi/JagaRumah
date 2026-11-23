import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { queryOne } from "@/lib/server/db";
import { RECORDINGS_DIR } from "@/lib/server/recordings-sync";

type Context = { params: Promise<{ recording_id?: string }> };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function resolveRecordingFile(recordingId: string) {
  if (!UUID_REGEX.test(recordingId)) {
    return null;
  }

  const row = await queryOne<{ file_path: string | null }>(
    `SELECT file_path
     FROM camera_recordings
     WHERE id = $1
       AND status = 'available'
       AND started_at >= now() - interval '24 hours'
       AND file_path IS NOT NULL`,
    [recordingId],
  );
  if (!row?.file_path) return null;

  const rootDir = path.resolve(RECORDINGS_DIR);
  const fullPath = path.resolve(rootDir, row.file_path);
  if (!fullPath.startsWith(`${rootDir}${path.sep}`)) {
    return null;
  }

  try {
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) return null;
    return { fullPath, size: fileStat.size, filename: path.basename(fullPath) };
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

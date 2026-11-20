import { queryOne } from "@/lib/server/db";
import { ensureMediamtxPath } from "@/lib/server/mobile-data";

type Context = { params: Promise<{ path?: string[] }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  if (!path || path.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  // Rekonstruksi subpath HLS beserta query string (misal: ?session=... atau ?_HLS_msn=...)
  const subPath = path.map((segment) => encodeURIComponent(segment)).join("/");
  const { search } = new URL(request.url);
  const upstreamPath = `${subPath}${search}`;
  const candidateBases = [
    process.env.MEDIAMTX_INTERNAL_HLS_URL,
    "http://host.docker.internal:8888",
    "http://172.17.0.1:8888",
    "http://172.18.0.1:8888",
  ].filter(Boolean) as string[];

  let upstream: Response | null = null;
  let activeBase = candidateBases[0];

  for (const base of candidateBases) {
    try {
      const res = await fetch(`${base}/${upstreamPath}`, {
        cache: "no-store",
        headers: { Accept: "*/*" },
        signal: AbortSignal.timeout(8000),
      });
      upstream = res;
      activeBase = base;
      break;
    } catch {
      // Coba kandidat bridge IP berikutnya
    }
  }

  if (!upstream) {
    return new Response("MediaMTX internal server unavailable", {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  try {

    // Jika path belum ada di MediaMTX (404), coba daftarkan otomatis dari database
    if (upstream.status === 404 && path.length >= 2 && path[1] === "index.m3u8") {
      const streamKey = path[0];
      const normalizedKey = streamKey.replace(/^cam-/, "").toLowerCase();

      const row = await queryOne<{ stream_url: string | null }>(
        `SELECT t.stream_url
         FROM devices d
         LEFT JOIN camera_telemetry t ON t.device_id = d.id
         WHERE LOWER(REGEXP_REPLACE(d.serial_number, '[^a-zA-Z0-9]', '-', 'g')) = $1
            OR LOWER(d.serial_number) = $1
         LIMIT 1`,
        [normalizedKey],
      );

      if (row?.stream_url?.startsWith("rtsp://")) {
        const registered = await ensureMediamtxPath(streamKey, row.stream_url);
        if (registered) {
          // Tunggu sebentar agar MediaMTX menginisiasi path, lalu fetch ulang
          await new Promise((resolve) => setTimeout(resolve, 1000));
          upstream = await fetch(`${activeBase}/${upstreamPath}`, {
            cache: "no-store",
            headers: { Accept: "*/*" },
            signal: AbortSignal.timeout(10000),
          });
        }
      }
    }

    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    headers.set("Cache-Control", "no-cache, no-store, must-revalidate");

    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    console.error(`[hls-proxy] gagal fetch dari MediaMTX (${activeBase}/${subPath}):`, error);
    return new Response("Upstream stream unavailable", {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

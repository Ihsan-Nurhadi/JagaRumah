type Context = { params: Promise<{ path?: string[] }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  if (!path || path.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  // Rekonstruksi subpath HLS (misal: cam-xxx/index.m3u8 atau cam-xxx/segment.m4s)
  const subPath = path.map((segment) => encodeURIComponent(segment)).join("/");
  const upstreamBase = process.env.MEDIAMTX_INTERNAL_HLS_URL ?? "http://host.docker.internal:8888";
  const upstreamUrl = `${upstreamBase}/${subPath}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      cache: "no-store",
      headers: {
        Accept: "*/*",
      },
      signal: AbortSignal.timeout(10000),
    });

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
    console.error(`[hls-proxy] gagal fetch dari MediaMTX (${upstreamUrl}):`, error);
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

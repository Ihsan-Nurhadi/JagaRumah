import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

interface RelayEntry {
  streamKey: string;
  rtspUrl: string;
  process: ChildProcess | null;
  lastStartAttemptMs: number;
  stopping: boolean;
}

const g = globalThis as typeof globalThis & {
  __nayakaAudioRelays?: Map<string, RelayEntry>;
  __nayakaRtspHost?: string;
};

function getRelayMap(): Map<string, RelayEntry> {
  if (!g.__nayakaAudioRelays) {
    g.__nayakaAudioRelays = new Map();
  }
  return g.__nayakaAudioRelays;
}

function canConnectTcp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function resolveMediamtxRtspHost(): Promise<string> {
  if (g.__nayakaRtspHost) return g.__nayakaRtspHost;

  const envUrl = process.env.MEDIAMTX_RTSP_HOST;
  const candidates = [envUrl, "host.docker.internal", "172.17.0.1", "172.18.0.1", "127.0.0.1"].filter(
    Boolean,
  ) as string[];

  for (const host of candidates) {
    if (await canConnectTcp(host, 8554)) {
      g.__nayakaRtspHost = host;
      return host;
    }
  }

  return "host.docker.internal";
}

function spawnRelayProcess(entry: RelayEntry, rtspHost: string): void {
  const targetUrl = `rtsp://${rtspHost}:8554/${entry.streamKey}`;
  entry.lastStartAttemptMs = Date.now();

  const child = spawn(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-fflags",
      "+genpts",
      "-rtsp_transport",
      "tcp",
      "-i",
      entry.rtspUrl,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "rtsp",
      "-rtsp_transport",
      "tcp",
      targetUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  entry.process = child;

  child.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString("utf8").trim();
    if (msg) {
      console.warn(`[audio-relay:${entry.streamKey}] ${msg}`);
    }
  });

  child.once("exit", (code) => {
    if (entry.process === child) {
      entry.process = null;
    }
    if (!entry.stopping) {
      console.warn(`[audio-relay:${entry.streamKey}] ffmpeg exited (code ${code}), akan dicoba ulang`);
      setTimeout(() => {
        if (!entry.stopping && !entry.process) {
          void ensureCameraRelay(entry.streamKey, entry.rtspUrl);
        }
      }, 10_000);
    }
  });
}

/**
 * Memastikan relay FFmpeg (Video copy + Audio G711->AAC) berjalan untuk kamera tertentu.
 */
export async function ensureCameraRelay(streamKey: string, rtspUrl: string): Promise<void> {
  if (!rtspUrl.startsWith("rtsp://")) return;

  const relays = getRelayMap();
  let entry = relays.get(streamKey);

  if (entry && entry.rtspUrl !== rtspUrl) {
    entry.stopping = true;
    entry.process?.kill("SIGTERM");
    relays.delete(streamKey);
    entry = undefined;
  }

  if (!entry) {
    entry = {
      streamKey,
      rtspUrl,
      process: null,
      lastStartAttemptMs: 0,
      stopping: false,
    };
    relays.set(streamKey, entry);
  }

  if (entry.process) return;
  if (Date.now() - entry.lastStartAttemptMs < 10_000) return;

  const rtspHost = await resolveMediamtxRtspHost();
  spawnRelayProcess(entry, rtspHost);
}

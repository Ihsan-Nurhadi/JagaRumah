import { queryOne } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { requireMobile } from "@/lib/server/mobile";
import { ok, requireUuid } from "@/lib/server/request";
import { routeHandler } from "@/lib/server/route";
import { sendAudioToCameraSpeaker } from "@/lib/server/talkback";

const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // Maksimal 5 MB per pesan suara

type Context = { params: Promise<{ camera_id?: string }> };

function inferExtension(mimeOrName: string | null | undefined): string {
  const lower = (mimeOrName ?? "").toLowerCase();
  if (lower.includes("wav")) return "wav";
  if (lower.includes("aac")) return "aac";
  if (lower.includes("ogg") || lower.includes("opus")) return "ogg";
  if (lower.includes("mp3") || lower.includes("mpeg")) return "mp3";
  if (lower.includes("3gp")) return "3gp";
  return "m4a";
}

export const POST = routeHandler("mobile.cameras.talk", async (request, requestId, context) => {
  const session = await requireMobile(request);
  const cameraId = requireUuid((await (context as Context).params).camera_id, "camera_id");

  const device = await queryOne<{ id: string; serial_number: string; stream_url: string | null }>(
    `SELECT d.id, d.serial_number, t.stream_url
     FROM devices d
     LEFT JOIN camera_telemetry t ON t.device_id = d.id
     WHERE d.id = $1 AND d.customer_id = $2 AND d.status IN ('claimed', 'suspended')`,
    [cameraId, session.customerId],
  );

  if (!device) {
    throw new AppError({ code: "RESOURCE_NOT_FOUND", message: "Kamera tidak ditemukan." });
  }
  if (!device.stream_url?.startsWith("rtsp://")) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: "Kamera belum memiliki konfigurasi RTSP untuk fitur speaker.",
    });
  }

  const contentType = request.headers.get("content-type") ?? "";
  let audioBuffer: Buffer;
  let ext = "m4a";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("audio") ?? form.get("file");
    if (!file || !(file instanceof Blob)) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message: "Field multipart `audio` wajib diisi dengan file suara.",
      });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message: "Ukuran pesan suara maksimal 5 MB.",
      });
    }
    const name = "name" in file && typeof file.name === "string" ? file.name : file.type;
    ext = inferExtension(name);
    audioBuffer = Buffer.from(await file.arrayBuffer());
  } else {
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > MAX_AUDIO_BYTES) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        message: "Ukuran pesan suara maksimal 5 MB.",
      });
    }
    ext = inferExtension(contentType);
    audioBuffer = raw;
  }

  const streamKey = `cam-${device.serial_number.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  await sendAudioToCameraSpeaker({
    streamKey,
    rtspUrl: device.stream_url,
    audioBuffer,
    inputExtension: ext,
  });

  return ok(
    {
      camera_id: cameraId,
      sent: true,
    },
    requestId,
  );
});

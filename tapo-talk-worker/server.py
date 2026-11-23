import asyncio
import json
import os
import subprocess
from aiohttp import web
from pytapo import Tapo
from pytapo.media_stream._utils import StreamType

PORT = int(os.environ.get("PORT", "8099"))


def transcode_to_alaw(audio_path: str) -> bytes:
    proc = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            audio_path,
            "-f",
            "alaw",
            "-ar",
            "8000",
            "-ac",
            "1",
            "pipe:1",
        ],
        capture_output=True,
        timeout=20,
    )
    if proc.returncode != 0 or not proc.stdout:
        stderr = proc.stderr.decode("utf-8", errors="ignore")
        raise RuntimeError(f"FFmpeg transcode gagal: {stderr[-300:]}")
    return proc.stdout


async def send_talk_audio_async(payload: dict) -> dict:
    host = payload["host"]
    control_port = int(payload.get("control_port") or 443)
    rtsp_password = payload.get("rtsp_password") or ""
    cloud_password = payload.get("cloud_password") or rtsp_password
    audio_path = payload["audio_path"]

    alaw_bytes = await asyncio.to_thread(transcode_to_alaw, audio_path)
    print(f"[tapo-talk] sending {len(alaw_bytes)} bytes PCMA to {host}:{control_port}", flush=True)

    tapo = await asyncio.to_thread(
        Tapo,
        host=host,
        user="admin",
        password=cloud_password,
        cloudPassword=cloud_password,
        controlPort=control_port,
    )

    basic_info = await asyncio.to_thread(tapo.getBasicInfo)
    device_id = (
        basic_info.get("device_info", {}).get("basic_info", {}).get("dev_id")
        or ""
    )

    session = tapo.getMediaSession(StreamType.Stream)

    talk_req = json.dumps(
        {
            "type": "request",
            "params": {
                "talk": {
                    "mode": "aec",
                    **({"deviceId": device_id} if device_id else {}),
                },
                "method": "get",
            },
        }
    )

    async with session:
        async def keep_talk_session():
            async for _resp in session.transceive(talk_req):
                pass

        talk_task = asyncio.create_task(keep_talk_session())
        try:
            # Tunggu hingga pytapo menginisialisasi session.talk_session
            for _ in range(100):
                if getattr(session, "talk_session", None) is not None:
                    break
                if talk_task.done():
                    talk_task.result()
                await asyncio.sleep(0.1)

            if getattr(session, "talk_session", None) is None:
                raise RuntimeError("Kamera tidak menginisialisasi talk_session dalam 10 detik.")

            chunk_size = 1600  # 200ms audio PCMA 8kHz per chunk
            for offset in range(0, len(alaw_bytes), chunk_size):
                chunk = alaw_bytes[offset : offset + chunk_size]
                await session.send_audio(chunk)
                await asyncio.sleep(len(chunk) / 8000.0)
        finally:
            talk_task.cancel()
            try:
                await talk_task
            except asyncio.CancelledError:
                pass

    return {"sent_bytes": len(alaw_bytes), "host": host, "control_port": control_port}


async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def handle_talk(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
        result = await send_talk_audio_async(payload)
        return web.json_response({"ok": True, **result})
    except Exception as exc:
        print(f"[tapo-talk] error: {exc}", flush=True)
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


app = web.Application()
app.router.add_get("/health", handle_health)
app.router.add_post("/talk", handle_talk)

if __name__ == "__main__":
    print(f"[tapo-talk] worker listening on :{PORT}", flush=True)
    web.run_app(app, host="0.0.0.0", port=PORT)

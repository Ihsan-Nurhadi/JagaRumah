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
        async for _resp in session.transceive(talk_req):
            break

        chunk_size = 320
        for offset in range(0, len(alaw_bytes), chunk_size):
            chunk = alaw_bytes[offset : offset + chunk_size]
            if hasattr(session, "send"):
                await session.send(chunk)
            else:
                async for _r in session.transceive(chunk):
                    break
            await asyncio.sleep(0.038)

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

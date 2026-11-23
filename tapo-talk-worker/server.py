import asyncio
import os
from aiohttp import web
from pytapo import Tapo
from pytapo.media_stream.talk import Talk

PORT = int(os.environ.get("PORT", "8099"))


async def send_talk_audio_async(payload: dict) -> dict:
    host = payload["host"]
    control_port = int(payload.get("control_port") or 443)
    rtsp_password = payload.get("rtsp_password") or ""
    cloud_password = payload.get("cloud_password") or rtsp_password
    audio_path = payload["audio_path"]

    print(f"[tapo-talk] playing {audio_path} to {host}:{control_port}", flush=True)

    tapo = await asyncio.to_thread(
        Tapo,
        host=host,
        user="admin",
        password=cloud_password,
        cloudPassword=cloud_password,
        controlPort=control_port,
    )

    async with Talk(tapo) as talk:
        await talk.play(audio_path)

    return {"played": True, "host": host, "control_port": control_port}


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

import asyncio
import os
import subprocess
import time
from aiohttp import web
from pytapo import Tapo
from pytapo.media_stream.talk import Talk

PORT = int(os.environ.get("PORT", "8099"))
SIRINE_DIR = os.environ.get("SIRINE_DIR", "/sirine")
AUDIO_EXTS = (".mpeg", ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus")

# Cache koneksi Tapo agar tidak perlu login ulang pada setiap permintaan talk/siren
_tapo_clients: dict[tuple[str, int, str], Tapo] = {}
_siren_cache: dict[tuple[str, float, int], bytes] = {}


def get_tapo_client(host: str, control_port: int, cloud_password: str, force_new: bool = False) -> Tapo:
    key = (host, control_port, cloud_password)
    if force_new or key not in _tapo_clients:
        _tapo_clients[key] = Tapo(
            host=host,
            user="admin",
            password=cloud_password,
            cloudPassword=cloud_password,
            controlPort=control_port,
        )
    return _tapo_clients[key]


def transcode_to_alaw(audio_path: str) -> bytes:
    proc = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            audio_path,
            "-vn",
            "-sn",
            "-dn",
            "-af",
            "adelay=200:all=1",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-c:a",
            "pcm_alaw",
            "-f",
            "alaw",
            "pipe:1",
        ],
        capture_output=True,
        timeout=20,
    )
    if proc.returncode != 0 or not proc.stdout:
        stderr = proc.stderr.decode("utf-8", errors="ignore")
        raise RuntimeError(f"FFmpeg transcode gagal: {stderr[-300:]}")
    return proc.stdout


def find_custom_siren_file() -> tuple[str, float] | None:
    if not os.path.isdir(SIRINE_DIR):
        return None
    for name in sorted(os.listdir(SIRINE_DIR)):
        if name.lower().endswith(AUDIO_EXTS):
            full = os.path.join(SIRINE_DIR, name)
            if os.path.isfile(full):
                return full, os.path.getmtime(full)
    return None


def generate_siren_alaw(duration_seconds: int) -> bytes:
    custom = find_custom_siren_file()
    if custom:
        file_path, mtime = custom
        cache_key = (file_path, mtime, duration_seconds)
        if cache_key in _siren_cache:
            return _siren_cache[cache_key]

        print(f"[tapo-siren] memakai file custom sirine: {file_path}", flush=True)
        proc = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-stream_loop",
                "-1",
                "-i",
                file_path,
                "-t",
                str(duration_seconds),
                "-vn",
                "-sn",
                "-dn",
                "-af",
                "adelay=200:all=1",
                "-ac",
                "1",
                "-ar",
                "8000",
                "-c:a",
                "pcm_alaw",
                "-f",
                "alaw",
                "pipe:1",
            ],
            capture_output=True,
            timeout=20,
        )
        if proc.returncode != 0 or not proc.stdout:
            stderr = proc.stderr.decode("utf-8", errors="ignore")
            raise RuntimeError(f"FFmpeg decode file sirine gagal: {stderr[-300:]}")
        _siren_cache[cache_key] = proc.stdout
        return proc.stdout

    fallback_key = ("__builtin__", 0.0, duration_seconds)
    if fallback_key in _siren_cache:
        return _siren_cache[fallback_key]

    # Fallback: nada sirine naik-turun (750Hz <-> 1250Hz, siklus ~1.2 detik) berformat PCMA 8kHz mono
    expr = "0.9*sin(2*PI*(1000+250*sin(2*PI*t/1.2))*t)"
    proc = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc={expr}:s=8000:d={duration_seconds}",
            "-af",
            "adelay=200:all=1",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-c:a",
            "pcm_alaw",
            "-f",
            "alaw",
            "pipe:1",
        ],
        capture_output=True,
        timeout=20,
    )
    if proc.returncode != 0 or not proc.stdout:
        stderr = proc.stderr.decode("utf-8", errors="ignore")
        raise RuntimeError(f"FFmpeg generate siren gagal: {stderr[-300:]}")
    _siren_cache[fallback_key] = proc.stdout
    return proc.stdout


async def stream_alaw_to_speaker(tapo: Tapo, alaw_bytes: bytes) -> None:
    async with Talk(tapo) as talk:
        loop = asyncio.get_running_loop()
        deadline = loop.time()
        chunk_size = 160  # 20ms per paket PCMA 8kHz
        for offset in range(0, len(alaw_bytes), chunk_size):
            chunk = alaw_bytes[offset : offset + chunk_size]
            await asyncio.sleep(max(0.0, deadline - loop.time()))
            await asyncio.wait_for(talk.write(chunk), 5)
            deadline = max(deadline + len(chunk) / 8000.0, loop.time())
        await asyncio.sleep(max(0.0, deadline - loop.time()))


async def run_with_cached_tapo(
    host: str,
    control_port: int,
    cloud_password: str,
    fn,
):
    tapo = await asyncio.to_thread(get_tapo_client, host, control_port, cloud_password, False)
    try:
        return await fn(tapo)
    except Exception as first_err:
        print(f"[tapo-talk] cached session retry for {host}:{control_port}: {first_err}", flush=True)
        tapo = await asyncio.to_thread(get_tapo_client, host, control_port, cloud_password, True)
        return await fn(tapo)


async def send_talk_audio_async(payload: dict) -> dict:
    host = payload["host"]
    control_port = int(payload.get("control_port") or 443)
    rtsp_password = payload.get("rtsp_password") or ""
    cloud_password = payload.get("cloud_password") or rtsp_password
    audio_path = payload["audio_path"]

    started = time.monotonic()
    alaw_bytes = await asyncio.to_thread(transcode_to_alaw, audio_path)
    print(f"[tapo-talk] playing {len(alaw_bytes)} bytes PCMA to {host}:{control_port}", flush=True)

    await run_with_cached_tapo(
        host,
        control_port,
        cloud_password,
        lambda tapo: stream_alaw_to_speaker(tapo, alaw_bytes),
    )

    elapsed = round(time.monotonic() - started, 2)
    return {"played": True, "host": host, "control_port": control_port, "elapsed_seconds": elapsed}


async def trigger_siren_async(payload: dict) -> dict:
    host = payload["host"]
    control_port = int(payload.get("control_port") or 443)
    rtsp_password = payload.get("rtsp_password") or ""
    cloud_password = payload.get("cloud_password") or rtsp_password
    duration_seconds = max(3, min(20, int(payload.get("duration_seconds") or 8)))

    print(f"[tapo-siren] triggering siren ({duration_seconds}s) on {host}:{control_port}", flush=True)

    async def _execute(tapo: Tapo) -> str:
        # 1. Coba alarm bawaan firmware jika didukung
        try:
            await asyncio.to_thread(tapo.startManualAlarm)
            return "native_alarm"
        except Exception as exc:
            print(f"[tapo-siren] native alarm unavailable ({exc}), fallback ke speaker siren", flush=True)

        # 2. Fallback: putar nada sirine keras ke speaker kamera via Talk
        siren_bytes = await asyncio.to_thread(generate_siren_alaw, duration_seconds)
        await stream_alaw_to_speaker(tapo, siren_bytes)
        return "speaker_siren"

    mode = await run_with_cached_tapo(host, control_port, cloud_password, _execute)
    return {"triggered": True, "mode": mode, "host": host, "control_port": control_port}


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


async def handle_siren(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
        result = await trigger_siren_async(payload)
        return web.json_response({"ok": True, **result})
    except Exception as exc:
        print(f"[tapo-siren] error: {exc}", flush=True)
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


app = web.Application()
app.router.add_get("/health", handle_health)
app.router.add_post("/talk", handle_talk)
app.router.add_post("/siren", handle_siren)

if __name__ == "__main__":
    print(f"[tapo-talk] worker listening on :{PORT}", flush=True)
    web.run_app(app, host="0.0.0.0", port=PORT)

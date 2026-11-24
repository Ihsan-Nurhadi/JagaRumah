import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import html
import os
from pathlib import Path
import time
from typing import Any
from urllib.parse import unquote, urlparse
import uuid
import xml.etree.ElementTree as ET

import aiohttp

WEB_INTERNAL_URL = os.environ.get("WEB_INTERNAL_URL", "http://127.0.0.1:701").rstrip("/")
INTERNAL_WORKER_SECRET = os.environ.get("INTERNAL_WORKER_SECRET", "")
MEDIAMTX_RTSP_BASE = os.environ.get("MEDIAMTX_RTSP_BASE", "rtsp://127.0.0.1:8554").rstrip("/")
EVIDENCE_DIR = Path(os.environ.get("EVIDENCE_DIR", "/evidence"))
EVIDENCE_RETENTION_DAYS = int(os.environ.get("EVIDENCE_RETENTION_DAYS", "7"))
CAMERA_SYNC_INTERVAL_SEC = int(os.environ.get("CAMERA_SYNC_INTERVAL_SEC", "60"))
CLIP_DURATION_SEC = int(os.environ.get("CLIP_DURATION_SEC", "10"))


def build_ws_security_header(username: str, password: str) -> str:
    if not username:
        return ""
    nonce_bytes = os.urandom(16)
    created = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    digest_raw = hashlib.sha1(nonce_bytes + created.encode("utf-8") + password.encode("utf-8")).digest()
    digest_b64 = base64.b64encode(digest_raw).decode("ascii")
    nonce_b64 = base64.b64encode(nonce_bytes).decode("ascii")
    return (
        '<wsse:Security s:mustUnderstand="1" '
        'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" '
        'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
        "<wsse:UsernameToken>"
        f"<wsse:Username>{html.escape(username)}</wsse:Username>"
        '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
        f"{digest_b64}</wsse:Password>"
        '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">'
        f"{nonce_b64}</wsse:Nonce>"
        f"<wsu:Created>{created}</wsu:Created>"
        "</wsse:UsernameToken>"
        "</wsse:Security>"
    )


def wrap_soap(body_xml: str, username: str, password: str) -> str:
    sec = build_ws_security_header(username, password)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:tev="http://www.onvif.org/ver10/events/wsdl" '
        'xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">'
        f"<s:Header>{sec}</s:Header>"
        f"<s:Body>{body_xml}</s:Body>"
        "</s:Envelope>"
    )


def rewrite_subscription_url(base_onvif_url: str, sub_addr: str) -> str:
    """
    Kamera di balik OpenVPN/NAT sering mengembalikan IP LAN lokal (mis. 192.168.x.x) di SubscriptionReference.
    Pertahankan path+query dari sub_addr, tetapi gunakan scheme+host:port dari base_onvif_url yang bisa dijangkau VPS.
    """
    base = urlparse(base_onvif_url)
    sub = urlparse(sub_addr)
    path_and_query = sub.path or base.path
    if sub.query:
        path_and_query = f"{path_and_query}?{sub.query}"
    return f"{base.scheme}://{base.netloc}{path_and_query}"


def candidate_onvif_urls(stream_url: str) -> tuple[list[str], str, str]:
    parsed = urlparse(stream_url)
    host = parsed.hostname or ""
    rtsp_port = parsed.port or 554
    username = unquote(parsed.username or "")
    password = unquote(parsed.password or "")

    ports: list[int] = []
    if 554 <= rtsp_port <= 599:
        ports.append(2020 + (rtsp_port - 554))
    for fallback in (2020, 2021, 2022, 80, 8000):
        if fallback not in ports:
            ports.append(fallback)

    urls: list[str] = []
    for port in ports:
        for path in ("/onvif/event_service", "/onvif/service"):
            urls.append(f"http://{host}:{port}{path}")
    return urls, username, password


async def post_soap(session: aiohttp.ClientSession, url: str, xml_body: str, timeout_sec: float = 10.0) -> tuple[int, str]:
    headers = {"Content-Type": "application/soap+xml; charset=utf-8"}
    async with session.post(url, data=xml_body.encode("utf-8"), headers=headers, timeout=aiohttp.ClientTimeout(total=timeout_sec)) as resp:
        text = await resp.text(errors="replace")
        return resp.status, text


def extract_subscription_address(xml_text: str) -> str | None:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None
    for elem in root.iter():
        if elem.tag.endswith("Address") and elem.text and elem.text.strip().startswith("http"):
            return elem.text.strip()
    return None


def parse_onvif_events(xml_text: str) -> list[tuple[str, str]]:
    """
    Mengembalikan daftar (alert_type, topic) untuk event Motion atau Person yang bernilai true.
    """
    events: list[tuple[str, str]] = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return events

    for msg in root.iter():
        if not msg.tag.endswith("NotificationMessage"):
            continue
        topic = ""
        is_active = False
        has_state_item = False

        for child in msg.iter():
            if child.tag.endswith("Topic") and child.text:
                topic = child.text.strip()
            elif child.tag.endswith("SimpleItem"):
                name = (child.attrib.get("Name") or "").lower()
                val = (child.attrib.get("Value") or "").strip().lower()
                if name in ("ismotion", "ispeople", "isperson", "state", "value", "objectid"):
                    has_state_item = True
                    if val in ("true", "1", "yes"):
                        is_active = True

        if not topic:
            continue
        if has_state_item and not is_active:
            continue

        topic_lower = topic.lower()
        if "peopledetector" in topic_lower or "person" in topic_lower or "ispeople" in topic_lower:
            events.append(("person", topic))
        elif "cellmotiondetector" in topic_lower or "motionalarm" in topic_lower or "motion" in topic_lower:
            events.append(("motion", topic))

    return events


async def run_ffmpeg(args: list[str], timeout_sec: float = 25.0) -> bool:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        if proc.returncode != 0:
            err_msg = stderr.decode("utf-8", errors="replace")[-300:]
            print(f"[onvif-worker] ffmpeg exit={proc.returncode}: {err_msg}", flush=True)
            return False
        return True
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        print("[onvif-worker] ffmpeg timeout", flush=True)
        return False


async def capture_and_report(
    http_session: aiohttp.ClientSession,
    camera: dict[str, Any],
    alert_type: str,
    topic: str,
) -> None:
    device_id = camera["device_id"]
    stream_key = camera["stream_key"]
    alert_id = str(uuid.uuid4())
    occurred_at = datetime.now(timezone.utc).isoformat()

    device_dir = EVIDENCE_DIR / device_id
    device_dir.mkdir(parents=True, exist_ok=True)

    snapshot_rel = f"{device_id}/{alert_id}.jpg"
    clip_rel = f"{device_id}/{alert_id}.mp4"
    snapshot_abs = EVIDENCE_DIR / snapshot_rel
    clip_abs = EVIDENCE_DIR / clip_rel

    rtsp_local = f"{MEDIAMTX_RTSP_BASE}/{stream_key}"

    snap_ok = await run_ffmpeg(
        [
            "-y",
            "-rtsp_transport",
            "tcp",
            "-i",
            rtsp_local,
            "-frames:v",
            "1",
            "-q:v",
            "3",
            str(snapshot_abs),
        ],
        timeout_sec=15.0,
    )

    clip_ok = await run_ffmpeg(
        [
            "-y",
            "-rtsp_transport",
            "tcp",
            "-i",
            rtsp_local,
            "-t",
            str(CLIP_DURATION_SEC),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(clip_abs),
        ],
        timeout_sec=float(CLIP_DURATION_SEC + 15),
    )

    evidence_status = "ready" if (snap_ok or clip_ok) else "failed"
    payload = {
        "alert_id": alert_id,
        "device_id": device_id,
        "alert_type": alert_type,
        "onvif_topic": topic,
        "occurred_at": occurred_at,
        "snapshot_path": snapshot_rel if snap_ok and snapshot_abs.exists() else None,
        "clip_path": clip_rel if clip_ok and clip_abs.exists() else None,
        "clip_duration_seconds": CLIP_DURATION_SEC if clip_ok else None,
        "evidence_status": evidence_status,
    }

    headers = {"Content-Type": "application/json"}
    if INTERNAL_WORKER_SECRET:
        headers["X-Internal-Secret"] = INTERNAL_WORKER_SECRET

    try:
        async with http_session.post(
            f"{WEB_INTERNAL_URL}/api/v1/internal/onvif-events",
            json=payload,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=15.0),
        ) as resp:
            if resp.status >= 300:
                body = await resp.text()
                print(f"[onvif-worker] report failed ({resp.status}): {body}", flush=True)
            else:
                print(
                    f"[onvif-worker] alert sent device={device_id} type={alert_type} status={evidence_status}",
                    flush=True,
                )
    except Exception as exc:
        print(f"[onvif-worker] error reporting alert: {exc}", flush=True)


class CameraEventMonitor:
    def __init__(self, http_session: aiohttp.ClientSession, camera: dict[str, Any]):
        self.http_session = http_session
        self.camera = camera
        self.last_alert_ts: dict[str, float] = {}
        self._stop = False
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self.run())

    def stop(self) -> None:
        self._stop = True
        if self._task:
            self._task.cancel()

    def update_config(self, camera: dict[str, Any]) -> None:
        self.camera = camera

    async def subscribe(self, urls: list[str], username: str, password: str) -> tuple[str, str] | None:
        body = "<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT60S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>"
        last_err = ""
        for url in urls:
            try:
                soap = wrap_soap(body, username, password)
                status, text = await post_soap(self.http_session, url, soap, timeout_sec=5.0)
                if 200 <= status < 300:
                    sub_addr = extract_subscription_address(text)
                    if sub_addr:
                        rewritten = rewrite_subscription_url(url, sub_addr)
                        return url, rewritten
                    last_err = f"{url} -> 200 tanpa SubscriptionReference"
                else:
                    last_err = f"{url} -> HTTP {status}"
            except Exception as exc:
                last_err = f"{url} -> {exc}"
                continue
        print(f"[onvif-worker] subscribe failed device={self.camera['device_id']}: {last_err}", flush=True)
        return None

    async def run(self) -> None:
        device_id = self.camera["device_id"]
        backoff = 5
        while not self._stop:
            try:
                urls, username, password = candidate_onvif_urls(self.camera["stream_url"])
                sub = await self.subscribe(urls, username, password)
                if not sub:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60)
                    continue

                _, sub_addr = sub
                backoff = 5
                last_renew = time.monotonic()
                print(f"[onvif-worker] subscribed device={device_id} -> {sub_addr}", flush=True)

                while not self._stop:
                    if time.monotonic() - last_renew >= 40:
                        renew_body = "<wsnt:Renew><wsnt:TerminationTime>PT60S</wsnt:TerminationTime></wsnt:Renew>"
                        renew_soap = wrap_soap(renew_body, username, password)
                        r_status, _ = await post_soap(self.http_session, sub_addr, renew_soap, timeout_sec=5.0)
                        if r_status >= 400:
                            print(f"[onvif-worker] renew HTTP {r_status} device={device_id}", flush=True)
                            break
                        last_renew = time.monotonic()

                    pull_body = "<tev:PullMessages><tev:Timeout>PT25S</tev:Timeout><tev:MessageLimit>10</tev:MessageLimit></tev:PullMessages>"
                    pull_soap = wrap_soap(pull_body, username, password)
                    p_status, p_text = await post_soap(self.http_session, sub_addr, pull_soap, timeout_sec=32.0)
                    if p_status >= 400:
                        print(f"[onvif-worker] pull HTTP {p_status} device={device_id}", flush=True)
                        break

                    parsed_events = parse_onvif_events(p_text)
                    if "NotificationMessage" in p_text and not parsed_events:
                        print(f"[onvif-worker] raw notification (unmatched) device={device_id}: {p_text[:500]}", flush=True)

                    for alert_type, topic in parsed_events:
                        if alert_type == "motion" and not self.camera.get("motion_detection_enabled", True):
                            continue
                        if alert_type == "person" and not self.camera.get("person_detection_enabled", True):
                            continue

                        cooldown = int(self.camera.get("cooldown_seconds", 30))
                        now_mono = time.monotonic()
                        if now_mono - self.last_alert_ts.get(alert_type, 0.0) < cooldown:
                            continue
                        self.last_alert_ts[alert_type] = now_mono
                        asyncio.create_task(capture_and_report(self.http_session, self.camera, alert_type, topic))

            except asyncio.CancelledError:
                break
            except Exception as exc:
                print(f"[onvif-worker] monitor error device={device_id}: {exc}", flush=True)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)


async def cleanup_old_evidence_loop() -> None:
    while True:
        try:
            cutoff = time.time() - (EVIDENCE_RETENTION_DAYS * 86400)
            if EVIDENCE_DIR.exists():
                for file_path in EVIDENCE_DIR.rglob("*"):
                    if file_path.is_file() and file_path.stat().st_mtime < cutoff:
                        file_path.unlink(missing_ok=True)
        except Exception as exc:
            print(f"[onvif-worker] cleanup error: {exc}", flush=True)
        await asyncio.sleep(3600)


async def main() -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    monitors: dict[str, CameraEventMonitor] = {}

    async with aiohttp.ClientSession() as http_session:
        asyncio.create_task(cleanup_old_evidence_loop())
        print(f"[onvif-worker] started, polling {WEB_INTERNAL_URL}", flush=True)

        while True:
            try:
                headers = {}
                if INTERNAL_WORKER_SECRET:
                    headers["X-Internal-Secret"] = INTERNAL_WORKER_SECRET
                async with http_session.get(
                    f"{WEB_INTERNAL_URL}/api/v1/internal/onvif-events",
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=10.0),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        cameras = data.get("data", {}).get("cameras", data.get("cameras", []))
                        print(f"[onvif-worker] synced {len(cameras)} camera(s)", flush=True)
                        active_ids = set()
                        for cam in cameras:
                            cid = cam["device_id"]
                            active_ids.add(cid)
                            if cid in monitors:
                                monitors[cid].update_config(cam)
                            else:
                                mon = CameraEventMonitor(http_session, cam)
                                monitors[cid] = mon
                                mon.start()
                        for stale_id in list(monitors.keys()):
                            if stale_id not in active_ids:
                                monitors.pop(stale_id).stop()
                    else:
                        print(f"[onvif-worker] sync cameras HTTP {resp.status}", flush=True)
            except Exception as exc:
                print(f"[onvif-worker] sync cameras error: {exc}", flush=True)

            await asyncio.sleep(CAMERA_SYNC_INTERVAL_SEC)


if __name__ == "__main__":
    asyncio.run(main())

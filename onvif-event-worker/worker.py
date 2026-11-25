import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import html
import os
from pathlib import Path
import re
import time
from typing import Any
from urllib.parse import unquote, urlparse
import uuid
import xml.etree.ElementTree as ET

import aiohttp

from vehicle_detector import (
    ParkedVehicleTracker,
    YoloOnnxDetector,
    annotate_vehicle_snapshot,
)

WEB_INTERNAL_URL = os.environ.get("WEB_INTERNAL_URL", "http://127.0.0.1:701").rstrip("/")
INTERNAL_WORKER_SECRET = os.environ.get("INTERNAL_WORKER_SECRET", "")
MEDIAMTX_RTSP_BASE = os.environ.get("MEDIAMTX_RTSP_BASE", "rtsp://127.0.0.1:8554").rstrip("/")
EVIDENCE_DIR = Path(os.environ.get("EVIDENCE_DIR", "/evidence"))
RECORDINGS_DIR = Path(os.environ.get("RECORDINGS_DIR", "/recordings"))
EVIDENCE_RETENTION_DAYS = int(os.environ.get("EVIDENCE_RETENTION_DAYS", "7"))
CAMERA_SYNC_INTERVAL_SEC = int(os.environ.get("CAMERA_SYNC_INTERVAL_SEC", "60"))
CLIP_DURATION_SEC = int(os.environ.get("CLIP_DURATION_SEC", "10"))
CLIP_PRE_ROLL_SEC = float(os.environ.get("CLIP_PRE_ROLL_SEC", "4.0"))
RECORDING_FLUSH_MARGIN_SEC = float(os.environ.get("RECORDING_FLUSH_MARGIN_SEC", "1.5"))
VEHICLE_MAX_CONCURRENCY = max(1, int(os.environ.get("VEHICLE_MAX_CONCURRENCY", "1")))
VEHICLE_BASELINE_REFRESH_SEC = int(os.environ.get("VEHICLE_BASELINE_REFRESH_SEC", "300"))
VEHICLE_CONFIRM_DELAY_SEC = float(os.environ.get("VEHICLE_CONFIRM_DELAY_SEC", "1.5"))

INFERENCE_SEMAPHORE = asyncio.Semaphore(VEHICLE_MAX_CONCURRENCY)


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


SEGMENT_FILENAME_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?(?:_Z)?\.mp4$",
    re.IGNORECASE,
)


def parse_segment_start_epoch(file_path: Path, mtime: float) -> float | None:
    match = SEGMENT_FILENAME_RE.match(file_path.name)
    if not match:
        return None
    year, month, day, hour, minute, second = (int(g) for g in match.groups())
    try:
        dt_utc = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    except ValueError:
        return None
    ts = dt_utc.timestamp()
    # Antisipasi jika suatu saat MediaMTX memakai TZ lokal (mis. WIB UTC+7) alih-alih UTC
    if abs(ts - mtime) > 1800:
        tz_offset = round((ts - (mtime - 150.0)) / 1800.0) * 1800.0
        ts -= tz_offset
    return ts


def has_active_recording_segment(stream_key: str, max_age_sec: float = 30.0) -> bool:
    cam_dir = RECORDINGS_DIR / stream_key
    if not cam_dir.is_dir():
        return False
    now = time.time()
    try:
        for entry in cam_dir.iterdir():
            if entry.is_file() and entry.suffix.lower() == ".mp4":
                st = entry.stat()
                if st.st_size > 0 and (now - st.st_mtime) <= max_age_sec:
                    return True
    except OSError:
        return False
    return False


async def capture_snapshot(rtsp_local: str, dest: Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    return await run_ffmpeg(
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
            str(dest),
        ],
        timeout_sec=15.0,
    )


async def capture_clip_live(rtsp_local: str, dest: Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    return await run_ffmpeg(
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
            str(dest),
        ],
        timeout_sec=float(CLIP_DURATION_SEC + 15),
    )


async def capture_snapshot_and_clip_live(rtsp_local: str, snapshot_dest: Path, clip_dest: Path) -> tuple[bool, bool]:
    """
    Fallback jika /recordings tidak tersedia: ambil snapshot & klip 10 detik sekaligus
    dalam 1 koneksi RTSP agar tidak ada jeda antrean antara foto dan video.
    """
    snapshot_dest.parent.mkdir(parents=True, exist_ok=True)
    clip_dest.parent.mkdir(parents=True, exist_ok=True)
    ok = await run_ffmpeg(
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
            str(snapshot_dest),
            "-t",
            str(CLIP_DURATION_SEC),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(clip_dest),
        ],
        timeout_sec=float(CLIP_DURATION_SEC + 15),
    )
    snap_ok = snapshot_dest.exists() and snapshot_dest.stat().st_size > 0
    clip_ok = ok and clip_dest.exists() and clip_dest.stat().st_size > 0
    return snap_ok, clip_ok


async def capture_clip_from_recordings(stream_key: str, event_epoch: float, dest: Path) -> bool:
    """
    Memotong klip [event_epoch - pre_roll, event_epoch + post_roll] langsung dari segmen fMP4
    24/7 milik MediaMTX (/recordings/<stream_key>/*.mp4) sehingga momen sebelum & saat
    foto diambil ikut terekam secara sinkron.
    """
    cam_dir = RECORDINGS_DIR / stream_key
    if not cam_dir.is_dir():
        return False

    pre_roll = min(max(0.0, CLIP_PRE_ROLL_SEC), float(CLIP_DURATION_SEC - 2))
    post_roll = max(2.0, float(CLIP_DURATION_SEC) - pre_roll)
    clip_start = event_epoch - pre_roll
    clip_end = event_epoch + post_roll

    wait_sec = (clip_end + RECORDING_FLUSH_MARGIN_SEC) - time.time()
    if wait_sec > 0:
        await asyncio.sleep(wait_sec)

    segments: list[tuple[float, float, Path]] = []
    try:
        for entry in cam_dir.iterdir():
            if not entry.is_file() or entry.suffix.lower() != ".mp4":
                continue
            st = entry.stat()
            if st.st_size <= 0:
                continue
            start_ts = parse_segment_start_epoch(entry, st.st_mtime)
            if start_ts is None:
                continue
            segments.append((start_ts, st.st_mtime, entry))
    except OSError as exc:
        print(f"[onvif-worker] gagal membaca /recordings/{stream_key}: {exc}", flush=True)
        return False

    if not segments:
        return False

    segments.sort(key=lambda item: item[0])

    overlapping: list[tuple[float, float, Path]] = []
    for idx, (start_ts, mtime, path_obj) in enumerate(segments):
        next_start = segments[idx + 1][0] if idx + 1 < len(segments) else mtime
        end_ts = max(mtime, min(next_start, start_ts + 310.0))
        if end_ts >= (clip_start - 1.0) and start_ts <= (clip_end + 1.0):
            overlapping.append((start_ts, end_ts, path_obj))

    if not overlapping:
        return False

    dest.parent.mkdir(parents=True, exist_ok=True)
    seek_sec = max(0.0, clip_start - overlapping[0][0])
    duration_sec = float(CLIP_DURATION_SEC)

    if len(overlapping) == 1:
        ok = await run_ffmpeg(
            [
                "-y",
                "-ss",
                f"{seek_sec:.2f}",
                "-i",
                str(overlapping[0][2]),
                "-t",
                f"{duration_sec:.2f}",
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                "-movflags",
                "+faststart",
                str(dest),
            ],
            timeout_sec=20.0,
        )
    else:
        concat_list = Path("/tmp") / f"ev_concat_{uuid.uuid4().hex}.txt"
        try:
            lines = []
            for _, _, seg_path in overlapping:
                escaped = str(seg_path).replace("'", "'\\''")
                lines.append(f"file '{escaped}'")
            concat_list.write_text("\n".join(lines), encoding="utf-8")
            ok = await run_ffmpeg(
                [
                    "-y",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    str(concat_list),
                    "-ss",
                    f"{seek_sec:.2f}",
                    "-t",
                    f"{duration_sec:.2f}",
                    "-c",
                    "copy",
                    "-avoid_negative_ts",
                    "make_zero",
                    "-movflags",
                    "+faststart",
                    str(dest),
                ],
                timeout_sec=25.0,
            )
        finally:
            concat_list.unlink(missing_ok=True)

    return ok and dest.exists() and dest.stat().st_size > 4096


async def capture_clip_synced(stream_key: str, rtsp_local: str, event_epoch: float, dest: Path) -> bool:
    if await capture_clip_from_recordings(stream_key, event_epoch, dest):
        return True
    print(f"[onvif-worker] fallback live RTSP clip untuk stream={stream_key}", flush=True)
    return await capture_clip_live(rtsp_local, dest)


async def report_alert(http_session: aiohttp.ClientSession, payload: dict[str, Any]) -> None:
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
                    f"[onvif-worker] alert sent device={payload['device_id']} type={payload['alert_type']} status={payload['evidence_status']}",
                    flush=True,
                )
    except Exception as exc:
        print(f"[onvif-worker] error reporting alert: {exc}", flush=True)


async def capture_and_report(
    http_session: aiohttp.ClientSession,
    camera: dict[str, Any],
    alert_type: str,
    topic: str,
) -> None:
    device_id = camera["device_id"]
    stream_key = camera["stream_key"]
    alert_id = str(uuid.uuid4())
    event_dt = datetime.now(timezone.utc)
    event_epoch = event_dt.timestamp()
    occurred_at = event_dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    snapshot_rel = f"{device_id}/{alert_id}.jpg"
    clip_rel = f"{device_id}/{alert_id}.mp4"
    snapshot_abs = EVIDENCE_DIR / snapshot_rel
    clip_abs = EVIDENCE_DIR / clip_rel

    rtsp_local = f"{MEDIAMTX_RTSP_BASE}/{stream_key}"
    if has_active_recording_segment(stream_key):
        # Jalankan snapshot pada detik event sambil menunggu post-roll fMP4 di /recordings secara paralel
        snap_ok, clip_ok = await asyncio.gather(
            capture_snapshot(rtsp_local, snapshot_abs),
            capture_clip_synced(stream_key, rtsp_local, event_epoch, clip_abs),
        )
    else:
        snap_ok, clip_ok = await capture_snapshot_and_clip_live(rtsp_local, snapshot_abs, clip_abs)

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
    await report_alert(http_session, payload)


class CameraEventMonitor:
    def __init__(self, http_session: aiohttp.ClientSession, camera: dict[str, Any], detector: YoloOnnxDetector):
        self.http_session = http_session
        self.camera = camera
        self.detector = detector
        self.vehicle_tracker = ParkedVehicleTracker()
        self.last_alert_ts: dict[str, float] = {}
        self._vehicle_check_running = False
        self._stop = False
        self._task: asyncio.Task[None] | None = None
        self._baseline_task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self.run())
        self._baseline_task = asyncio.create_task(self.baseline_refresh_loop())

    def stop(self) -> None:
        self._stop = True
        if self._task:
            self._task.cancel()
        if self._baseline_task:
            self._baseline_task.cancel()

    def update_config(self, camera: dict[str, Any]) -> None:
        self.camera = camera

    async def _run_inference(self, img_path: Path):
        async with INFERENCE_SEMAPHORE:
            return await asyncio.to_thread(self.detector.detect, img_path)

    async def baseline_refresh_loop(self) -> None:
        """
        Kalibrasi ringan posisi kendaraan parkir setiap 5 menit saat kamera tenang
        (hanya 1 snapshot, ~60ms CPU) agar referensi parkir tetap akurat.
        """
        await asyncio.sleep(5)
        while not self._stop:
            try:
                if (
                    self.detector.available
                    and self.camera.get("vehicle_detection_enabled", True)
                    and not self._vehicle_check_running
                ):
                    now_mono = time.monotonic()
                    if now_mono - self.last_alert_ts.get("vehicle", 0.0) >= 60.0:
                        device_id = self.camera["device_id"]
                        rtsp_local = f"{MEDIAMTX_RTSP_BASE}/{self.camera['stream_key']}"
                        tmp_path = EVIDENCE_DIR / device_id / f"_baseline_{uuid.uuid4().hex[:8]}.jpg"
                        try:
                            if await capture_snapshot(rtsp_local, tmp_path):
                                dets = await self._run_inference(tmp_path)
                                self.vehicle_tracker.refresh_baseline(
                                    dets,
                                    self.camera.get("parking_zone"),
                                    self.camera.get("last_ptz_at"),
                                )
                        finally:
                            tmp_path.unlink(missing_ok=True)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                print(f"[vehicle-ai] baseline refresh error device={self.camera['device_id']}: {exc}", flush=True)
            await asyncio.sleep(VEHICLE_BASELINE_REFRESH_SEC)

    async def handle_vehicle_check(self, trigger_topic: str) -> None:
        if self._vehicle_check_running:
            return
        self._vehicle_check_running = True
        device_id = self.camera["device_id"]
        stream_key = self.camera["stream_key"]
        rtsp_local = f"{MEDIAMTX_RTSP_BASE}/{stream_key}"
        parking_zone = self.camera.get("parking_zone")
        guard_mode = bool(self.camera.get("vehicle_guard_mode", False))
        last_ptz_at = self.camera.get("last_ptz_at")

        tmp_frame1 = EVIDENCE_DIR / device_id / f"_vcheck_{uuid.uuid4().hex[:8]}.jpg"
        trigger_epoch = time.time()
        try:
            if not await capture_snapshot(rtsp_local, tmp_frame1):
                return

            dets1 = await self._run_inference(tmp_frame1)
            eval1 = self.vehicle_tracker.evaluate(dets1, parking_zone, guard_mode, last_ptz_at)
            if not eval1 or not eval1.should_alert:
                return

            # Konfirmasi frame ke-2 setelah jeda singkat untuk menghilangkan false positive sesaat
            await asyncio.sleep(VEHICLE_CONFIRM_DELAY_SEC)
            alert_id = str(uuid.uuid4())
            occurred_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
            snapshot_rel = f"{device_id}/{alert_id}.jpg"
            clip_rel = f"{device_id}/{alert_id}.mp4"
            snapshot_abs = EVIDENCE_DIR / snapshot_rel
            clip_abs = EVIDENCE_DIR / clip_rel

            snap_ok = await capture_snapshot(rtsp_local, snapshot_abs)
            if not snap_ok:
                return

            dets2 = await self._run_inference(snapshot_abs)
            eval2 = self.vehicle_tracker.evaluate(dets2, parking_zone, guard_mode, last_ptz_at)
            if not eval2 or not eval2.should_alert:
                snapshot_abs.unlink(missing_ok=True)
                return

            # Terkonfirmasi! Gambar bounding box bukti, potong klip 10 detik (dengan pre-roll), lalu kirim alert
            self.last_alert_ts["vehicle"] = time.monotonic()
            await asyncio.to_thread(annotate_vehicle_snapshot, snapshot_abs, eval2, parking_zone)
            clip_ok = await capture_clip_synced(stream_key, rtsp_local, trigger_epoch, clip_abs)
            self.vehicle_tracker.commit_baseline(eval2.vehicles_in_zone)

            evidence_status = "ready" if (snap_ok or clip_ok) else "failed"
            payload = {
                "alert_id": alert_id,
                "device_id": device_id,
                "alert_type": "vehicle",
                "onvif_topic": f"ai:VehicleDetector/{eval2.sub_type} (via {trigger_topic})",
                "occurred_at": occurred_at,
                "snapshot_path": snapshot_rel if snapshot_abs.exists() else None,
                "clip_path": clip_rel if clip_ok and clip_abs.exists() else None,
                "clip_duration_seconds": CLIP_DURATION_SEC if clip_ok else None,
                "evidence_status": evidence_status,
                "metadata": {
                    "sub_type": eval2.sub_type,
                    "vehicle_class": eval2.vehicle_class,
                    "confidence": eval2.confidence,
                    "count_before": eval2.count_before,
                    "count_after": eval2.count_after,
                    "person_nearby": eval2.person_nearby,
                    "guard_mode": guard_mode,
                },
            }
            await report_alert(self.http_session, payload)
        except Exception as exc:
            print(f"[vehicle-ai] check error device={device_id}: {exc}", flush=True)
        finally:
            tmp_frame1.unlink(missing_ok=True)
            self._vehicle_check_running = False

    async def subscribe(self, urls: list[str], username: str, password: str) -> tuple[str, str] | None:
        body = "<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT300S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>"
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
                    if time.monotonic() - last_renew >= 240:
                        break

                    pull_body = "<tev:PullMessages><tev:Timeout>PT25S</tev:Timeout><tev:MessageLimit>10</tev:MessageLimit></tev:PullMessages>"
                    pull_soap = wrap_soap(pull_body, username, password)
                    p_status, p_text = await post_soap(self.http_session, sub_addr, pull_soap, timeout_sec=35.0)
                    if p_status >= 400:
                        print(f"[onvif-worker] pull HTTP {p_status} device={device_id}, resubscribing...", flush=True)
                        break

                    parsed_events = parse_onvif_events(p_text)
                    cooldown = int(self.camera.get("cooldown_seconds", 30))
                    now_mono = time.monotonic()

                    if (
                        parsed_events
                        and self.detector.available
                        and self.camera.get("vehicle_detection_enabled", True)
                        and not self._vehicle_check_running
                        and (now_mono - self.last_alert_ts.get("vehicle", 0.0) >= cooldown)
                    ):
                        trigger_topic = parsed_events[0][1]
                        asyncio.create_task(self.handle_vehicle_check(trigger_topic))

                    for alert_type, topic in parsed_events:
                        if alert_type == "motion" and not self.camera.get("motion_detection_enabled", True):
                            continue
                        if alert_type == "person" and not self.camera.get("person_detection_enabled", True):
                            continue

                        if now_mono - self.last_alert_ts.get(alert_type, 0.0) < cooldown:
                            continue
                        self.last_alert_ts[alert_type] = now_mono
                        asyncio.create_task(capture_and_report(self.http_session, self.camera, alert_type, topic))

            except asyncio.CancelledError:
                break
            except Exception as exc:
                print(f"[onvif-worker] monitor error device={device_id}: {type(exc).__name__}: {exc}", flush=True)
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
    detector = YoloOnnxDetector()
    monitors: dict[str, CameraEventMonitor] = {}

    async with aiohttp.ClientSession() as http_session:
        asyncio.create_task(cleanup_old_evidence_loop())
        print(
            f"[onvif-worker] started, polling {WEB_INTERNAL_URL} (vehicle_ai={'ready' if detector.available else 'disabled'})",
            flush=True,
        )

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
                                mon = CameraEventMonitor(http_session, cam, detector)
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

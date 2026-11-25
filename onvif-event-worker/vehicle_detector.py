from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import math
import os
from pathlib import Path
import time
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

try:
    import onnxruntime as ort
except ImportError:  # pragma: no cover - fallback bila dijalankan di env tanpa onnxruntime
    ort = None  # type: ignore[assignment]

# COCO class IDs yang relevan untuk Jaga Rumah
COCO_PERSON_ID = 0
COCO_VEHICLE_CLASSES: dict[int, str] = {
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}
TRACKED_CLASS_IDS = {COCO_PERSON_ID, *COCO_VEHICLE_CLASSES.keys()}

VEHICLE_MODEL_PATH = os.environ.get("VEHICLE_MODEL_PATH", "/app/models/yolo11n.onnx")
ONNX_INTRA_THREADS = int(os.environ.get("ONNX_INTRA_THREADS", "1"))
VEHICLE_CONF_THRESHOLD = float(os.environ.get("VEHICLE_CONF_THRESHOLD", "0.30"))
VEHICLE_NMS_IOU = float(os.environ.get("VEHICLE_NMS_IOU", "0.45"))
PTZ_GRACE_SECONDS = float(os.environ.get("PTZ_GRACE_SECONDS", "12.0"))


@dataclass(frozen=True)
class Detection:
    class_id: int
    class_name: str
    confidence: float
    # Koordinat ternormalisasi [0.0 .. 1.0] terhadap ukuran frame asli
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) * 0.5

    @property
    def cy(self) -> float:
        return (self.y1 + self.y2) * 0.5

    @property
    def area(self) -> float:
        return max(0.0, self.x2 - self.x1) * max(0.0, self.y2 - self.y1)


@dataclass
class VehicleEvaluation:
    should_alert: bool
    sub_type: str  # "moved" | "missing" | "entered" | "detected"
    vehicle_class: str
    confidence: float
    count_before: int
    count_after: int
    person_nearby: bool
    highlighted_indices: list[int]
    vehicles_in_zone: list[Detection]
    persons: list[Detection]
    baseline_snapshot: list[Detection]


def compute_iou(a: Detection, b: Detection) -> float:
    ix1 = max(a.x1, b.x1)
    iy1 = max(a.y1, b.y1)
    ix2 = min(a.x2, b.x2)
    iy2 = min(a.y2, b.y2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0.0:
        return 0.0
    union = a.area + b.area - inter
    return inter / union if union > 0.0 else 0.0


def box_in_zone(det: Detection, zone: dict[str, float] | None) -> bool:
    if not zone:
        return True
    zx1 = float(zone.get("x1", 0.0))
    zy1 = float(zone.get("y1", 0.0))
    zx2 = float(zone.get("x2", 1.0))
    zy2 = float(zone.get("y2", 1.0))

    # Cek apakah titik tumpu bawah-tengah (roda) berada di dalam zona
    if zx1 <= det.cx <= zx2 and zy1 <= det.y2 <= zy2:
        return True

    # Atau cek apakah minimal 25% luas objek beririsan dengan zona parkir
    ix1 = max(det.x1, zx1)
    iy1 = max(det.y1, zy1)
    ix2 = min(det.x2, zx2)
    iy2 = min(det.y2, zy2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    return det.area > 0.0 and (inter / det.area) >= 0.25


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thresh: float) -> list[int]:
    if len(boxes) == 0:
        return []
    x1 = boxes[:, 0]
    y1 = boxes[:, 1]
    x2 = boxes[:, 2]
    y2 = boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep: list[int] = []

    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        union = areas[i] + areas[order[1:]] - inter
        iou = np.where(union > 0.0, inter / union, 0.0)
        inds = np.where(iou <= iou_thresh)[0]
        order = order[inds + 1]
    return keep


class YoloOnnxDetector:
    """
    Detektor ringan YOLO11n / YOLOv8n berbasis ONNX Runtime CPU.
    Dikonfigurasi khusus agar hemat CPU & RAM pada VPS 2 vCPU (~100-150 MB RAM).
    """

    def __init__(self, model_path: str = VEHICLE_MODEL_PATH) -> None:
        self.model_path = Path(model_path)
        self.session: Any = None
        self.input_name: str = ""
        self.input_size: int = 640
        self._load()

    @property
    def available(self) -> bool:
        return self.session is not None

    def _load(self) -> None:
        if ort is None:
            print("[vehicle-ai] onnxruntime belum terinstal, deteksi kendaraan AI dinonaktifkan.", flush=True)
            return
        if not self.model_path.exists():
            print(f"[vehicle-ai] model tidak ditemukan di {self.model_path}, deteksi kendaraan AI dinonaktifkan.", flush=True)
            return
        try:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = max(1, ONNX_INTRA_THREADS)
            opts.inter_op_num_threads = 1
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            self.session = ort.InferenceSession(
                str(self.model_path),
                sess_options=opts,
                providers=["CPUExecutionProvider"],
            )
            inp = self.session.get_inputs()[0]
            self.input_name = inp.name
            if len(inp.shape) == 4 and isinstance(inp.shape[2], int):
                self.input_size = int(inp.shape[2])
            print(
                f"[vehicle-ai] model {self.model_path.name} dimuat (input={self.input_size}, threads={ONNX_INTRA_THREADS})",
                flush=True,
            )
        except Exception as exc:
            print(f"[vehicle-ai] gagal memuat model ONNX: {exc}", flush=True)
            self.session = None

    def detect(self, image_path: Path, conf_threshold: float = VEHICLE_CONF_THRESHOLD) -> list[Detection]:
        if not self.available or not image_path.exists():
            return []

        with Image.open(image_path) as img:
            rgb = img.convert("RGB")
            orig_w, orig_h = rgb.size
            if orig_w <= 0 or orig_h <= 0:
                return []

            size = self.input_size
            scale = min(size / orig_w, size / orig_h)
            new_w = max(1, int(round(orig_w * scale)))
            new_h = max(1, int(round(orig_h * scale)))
            pad_x = (size - new_w) // 2
            pad_y = (size - new_h) // 2

            resized = rgb.resize((new_w, new_h), Image.Resampling.BILINEAR)
            canvas = Image.new("RGB", (size, size), (114, 114, 114))
            canvas.paste(resized, (pad_x, pad_y))

            arr = np.asarray(canvas, dtype=np.float32) / 255.0
            tensor = np.transpose(arr, (2, 0, 1))[None, ...]

        outputs = self.session.run(None, {self.input_name: tensor})
        pred = outputs[0]
        if pred.ndim == 3:
            pred = pred[0]
        # Format standar YOLOv8/YOLO11 adalah (84, 8400) -> transpose ke (8400, 84)
        if pred.shape[0] < pred.shape[1]:
            pred = pred.T

        if pred.shape[1] < 84:
            return []

        boxes_xywh = pred[:, :4]
        class_scores = pred[:, 4:]
        class_ids = np.argmax(class_scores, axis=1)
        confidences = class_scores[np.arange(len(class_ids)), class_ids]

        mask = (confidences >= conf_threshold) & np.isin(class_ids, list(TRACKED_CLASS_IDS))
        if not np.any(mask):
            return []

        boxes_xywh = boxes_xywh[mask]
        class_ids = class_ids[mask]
        confidences = confidences[mask]

        # Konversi cx, cy, w, h -> x1, y1, x2, y2 pada skala letterbox
        cx = boxes_xywh[:, 0]
        cy = boxes_xywh[:, 1]
        bw = boxes_xywh[:, 2]
        bh = boxes_xywh[:, 3]
        x1 = np.clip((cx - bw * 0.5 - pad_x) / scale, 0.0, float(orig_w)) / orig_w
        y1 = np.clip((cy - bh * 0.5 - pad_y) / scale, 0.0, float(orig_h)) / orig_h
        x2 = np.clip((cx + bw * 0.5 - pad_x) / scale, 0.0, float(orig_w)) / orig_w
        y2 = np.clip((cy + bh * 0.5 - pad_y) / scale, 0.0, float(orig_h)) / orig_h

        xyxy = np.stack([x1, y1, x2, y2], axis=1)
        detections: list[Detection] = []

        for cid in np.unique(class_ids):
            cid_int = int(cid)
            idx = np.where(class_ids == cid)[0]
            kept = _nms(xyxy[idx], confidences[idx], VEHICLE_NMS_IOU)
            name = "person" if cid_int == COCO_PERSON_ID else COCO_VEHICLE_CLASSES.get(cid_int, "vehicle")
            for k in kept:
                b = xyxy[idx[k]]
                detections.append(
                    Detection(
                        class_id=cid_int,
                        class_name=name,
                        confidence=float(confidences[idx[k]]),
                        x1=float(b[0]),
                        y1=float(b[1]),
                        x2=float(b[2]),
                        y2=float(b[3]),
                    )
                )

        return detections


def _parse_iso_ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


class ParkedVehicleTracker:
    """
    Melacak posisi baseline kendaraan yang sedang parkir per kamera.
    Membandingkan pergeseran bounding box AI (IoU & centroid), bukan perubahan piksel mentah,
    sehingga tahan terhadap perubahan cahaya matahari, lampu, mode IR malam, dan bayangan.
    """

    def __init__(self) -> None:
        self.baseline: list[Detection] = []
        self.initialized: bool = False
        self.last_seen_ptz_at: str | None = None
        self.ptz_grace_until: float = 0.0

    def _handle_ptz_grace(self, last_ptz_at: str | None) -> bool:
        now = time.time()
        if last_ptz_at and last_ptz_at != self.last_seen_ptz_at:
            self.last_seen_ptz_at = last_ptz_at
            ptz_ts = _parse_iso_ts(last_ptz_at)
            if ptz_ts is not None and (now - ptz_ts) < 60.0:
                self.ptz_grace_until = max(self.ptz_grace_until, ptz_ts + PTZ_GRACE_SECONDS)
                self.initialized = False
                self.baseline = []
        if now < self.ptz_grace_until:
            return True
        return False

    def refresh_baseline(
        self,
        detections: list[Detection],
        parking_zone: dict[str, float] | None,
        last_ptz_at: str | None,
    ) -> None:
        if self._handle_ptz_grace(last_ptz_at):
            return
        vehicles = [
            d for d in detections
            if d.class_id in COCO_VEHICLE_CLASSES and box_in_zone(d, parking_zone)
        ]
        self.baseline = vehicles
        self.initialized = True

    def evaluate(
        self,
        detections: list[Detection],
        parking_zone: dict[str, float] | None,
        guard_mode: bool,
        last_ptz_at: str | None,
    ) -> VehicleEvaluation | None:
        if self._handle_ptz_grace(last_ptz_at):
            return None

        vehicles = [
            d for d in detections
            if d.class_id in COCO_VEHICLE_CLASSES and box_in_zone(d, parking_zone)
        ]
        persons = [d for d in detections if d.class_id == COCO_PERSON_ID]

        if not self.initialized:
            self.baseline = vehicles
            self.initialized = True
            return None

        count_before = len(self.baseline)
        count_after = len(vehicles)

        # Greedy IoU matching antara baseline dan deteksi sekarang
        matched_cur: set[int] = set()
        matched_base: set[int] = set()
        moved_indices: list[int] = []

        for b_idx, base_box in enumerate(self.baseline):
            best_iou = 0.0
            best_c_idx = -1
            for c_idx, cur_box in enumerate(vehicles):
                if c_idx in matched_cur:
                    continue
                iou = compute_iou(base_box, cur_box)
                if iou > best_iou:
                    best_iou = iou
                    best_c_idx = c_idx

            if best_c_idx >= 0 and best_iou >= 0.20:
                matched_base.add(b_idx)
                matched_cur.add(best_c_idx)
                cur_box = vehicles[best_c_idx]
                shift = math.hypot(cur_box.cx - base_box.cx, cur_box.cy - base_box.cy)
                # Motor/kendaraan dianggap bergeser signifikan bila IoU < 0.50 atau pusat bergeser > 8% layar
                if best_iou < 0.50 or shift > 0.08:
                    moved_indices.append(best_c_idx)

        unmatched_cur = [i for i in range(count_after) if i not in matched_cur]
        unmatched_base = [i for i in range(count_before) if i not in matched_base]

        # Cek apakah ada orang yang beririsan/dekat dengan kendaraan
        person_nearby = False
        for p in persons:
            for v in vehicles + self.baseline:
                if compute_iou(p, v) > 0.02 or math.hypot(p.cx - v.cx, p.cy - v.cy) < 0.22:
                    person_nearby = True
                    break

        sub_type: str | None = None
        highlighted: list[int] = []

        if moved_indices:
            sub_type = "moved"
            highlighted = moved_indices
        elif unmatched_base and unmatched_cur:
            # Kendaraan pindah cukup jauh sehingga tidak ter-match IoU > 0.20
            sub_type = "moved"
            highlighted = unmatched_cur
        elif unmatched_base and count_after < count_before:
            sub_type = "missing"
            highlighted = []
        elif unmatched_cur and count_after > count_before:
            sub_type = "entered"
            highlighted = unmatched_cur
        elif not guard_mode and count_after > 0 and count_before == 0:
            sub_type = "detected"
            highlighted = list(range(count_after))

        if not sub_type:
            return None

        # Di Mode Jaga Parkir, prioritaskan pergeseran/hilang/masuk; di mode biasa semua perubahan kendaraan dilaporkan
        primary = (
            vehicles[highlighted[0]]
            if highlighted
            else (self.baseline[unmatched_base[0]] if unmatched_base else vehicles[0])
        )
        return VehicleEvaluation(
            should_alert=True,
            sub_type=sub_type,
            vehicle_class=primary.class_name,
            confidence=round(primary.confidence, 3),
            count_before=count_before,
            count_after=count_after,
            person_nearby=person_nearby,
            highlighted_indices=highlighted,
            vehicles_in_zone=vehicles,
            persons=persons,
            baseline_snapshot=list(self.baseline),
        )

    def commit_baseline(self, vehicles: list[Detection]) -> None:
        self.baseline = list(vehicles)
        self.initialized = True


def annotate_vehicle_snapshot(
    image_path: Path,
    evaluation: VehicleEvaluation,
    parking_zone: dict[str, float] | None,
) -> None:
    """
    Menggambar overlay bounding box langsung ke snapshot bukti (.jpg):
    - Cyan: Zona Parkir (jika diatur)
    - Hijau: Posisi awal / kendaraan diam
    - Merah: Kendaraan bergerak / baru masuk
    - Kuning: Orang di sekitar kendaraan
    """
    if not image_path.exists():
        return
    try:
        with Image.open(image_path) as img:
            rgb = img.convert("RGB")
            w, h = rgb.size
            draw = ImageDraw.Draw(rgb)

            if parking_zone:
                zx1 = int(float(parking_zone["x1"]) * w)
                zy1 = int(float(parking_zone["y1"]) * h)
                zx2 = int(float(parking_zone["x2"]) * w)
                zy2 = int(float(parking_zone["y2"]) * h)
                draw.rectangle([zx1, zy1, zx2, zy2], outline=(34, 211, 238), width=3)
                draw.text((zx1 + 6, max(4, zy1 + 4)), "ZONA PARKIR", fill=(34, 211, 238))

            # Gambar posisi baseline (hijau) bila motor bergeser/hilang
            if evaluation.sub_type in ("moved", "missing"):
                for b in evaluation.baseline_snapshot:
                    draw.rectangle(
                        [int(b.x1 * w), int(b.y1 * h), int(b.x2 * w), int(b.y2 * h)],
                        outline=(34, 197, 94),
                        width=2,
                    )

            for p in evaluation.persons:
                px1, py1, px2, py2 = int(p.x1 * w), int(p.y1 * h), int(p.x2 * w), int(p.y2 * h)
                draw.rectangle([px1, py1, px2, py2], outline=(250, 204, 21), width=2)
                draw.text((px1 + 4, max(4, py1 - 14)), f"ORANG {int(p.confidence * 100)}%", fill=(250, 204, 21))

            for idx, v in enumerate(evaluation.vehicles_in_zone):
                is_alert = idx in evaluation.highlighted_indices
                color = (239, 68, 68) if is_alert else (34, 197, 94)
                width = 4 if is_alert else 2
                vx1, vy1, vx2, vy2 = int(v.x1 * w), int(v.y1 * h), int(v.x2 * w), int(v.y2 * h)
                draw.rectangle([vx1, vy1, vx2, vy2], outline=color, width=width)
                tag = v.class_name.upper()
                if is_alert and evaluation.sub_type == "moved":
                    tag = f"{tag} BERGERAK"
                elif is_alert and evaluation.sub_type == "entered":
                    tag = f"{tag} MASUK"
                draw.text((vx1 + 4, max(4, vy1 - 14)), f"{tag} {int(v.confidence * 100)}%", fill=color)

            rgb.save(image_path, format="JPEG", quality=88)
    except Exception as exc:
        print(f"[vehicle-ai] gagal menggambar anotasi snapshot: {exc}", flush=True)

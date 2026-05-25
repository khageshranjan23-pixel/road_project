"""
detector.py
===========
YOLOv8x-based vehicle detector + ByteTrack tracker + GPU-accelerated velocity estimator.
Processes video frames and computes per-vehicle metrics.
"""

import os
import cv2
import numpy as np
import time
from collections import defaultdict, deque
from ultralytics import YOLO
import torch

# Local path to bytetrack config (sits next to detector.py)
_HERE = os.path.dirname(os.path.abspath(__file__))
BYTETRACK_CFG = os.path.join(_HERE, "bytetrack.yaml")

# ── GPU check (safe — handles Blackwell RTX 50xx kernel mismatch) ─────────────
def _detect_device() -> str:
    if not torch.cuda.is_available():
        print("[Detector] CUDA not available — using CPU")
        return "cpu"
    try:
        # Quick kernel test: if this fails the GPU arch isn't supported by this PyTorch build
        t = torch.zeros(1).cuda()
        _ = t + t
        name = torch.cuda.get_device_name(0)
        print(f"[Detector] GPU detected: {name} — using CUDA ✅")
        return "cuda"
    except Exception as e:
        print(f"[Detector] CUDA kernel error ({e})")
        print("[Detector] Your GPU (RTX 50xx Blackwell) needs PyTorch with CUDA 12.8")
        print("[Detector] Falling back to CPU — run fix_gpu.bat to upgrade PyTorch")
        return "cpu"

DEVICE = _detect_device()
print(f"[Detector] Active device: {DEVICE.upper()}")

# ── Vehicle class IDs in COCO (used by YOLOv8) ───────────────────────────────
VEHICLE_CLASSES = {
    2:  "car",
    3:  "motorcycle",
    5:  "bus",
    7:  "truck",
    1:  "bicycle",
}

# ── Average real-world widths (meters) for scale estimation ──────────────────
AVG_WIDTHS_M = {
    "car":        1.8,
    "truck":      2.5,
    "bus":        2.5,
    "motorcycle": 0.8,
    "bicycle":    0.6,
}

# ── History deque length for velocity smoothing ───────────────────────────────
HISTORY_LEN = 20   # frames


class VehicleTracker:
    """
    Wraps YOLOv8x + ByteTrack.
    Maintains per-track centroid history to compute smooth velocity estimates.
    """

    def __init__(self, model_path: str = "yolov8m.pt", conf: float = 0.35):
        self.model = YOLO(model_path)
        self.model.to(DEVICE)
        self.model_name = os.path.basename(model_path).replace(".pt", "")
        self.conf = conf

        # track_id → deque of (frame_idx, cx, cy, bbox_w_px, class_name)
        self.history: dict[int, deque] = defaultdict(lambda: deque(maxlen=HISTORY_LEN))

        # Calibration: meters-per-pixel (estimated from first detected car)
        self.mpp: float | None = None   # metres per pixel (vertical axis)
        self.mpp_h: float | None = None # metres per pixel (horizontal axis)
        self.road_width_m: float = 7.0  # fallback 2-lane road
        self.road_width_px: float | None = None
        self.frame_width: int = 0
        self.frame_height: int = 0
        self.fps: float = 30.0

        # Analytics accumulator
        self.all_velocities: list[float] = []          # km/h per detection
        self.vehicle_counts: list[dict] = []           # per-second counts
        self.frame_results: list[dict] = []            # full per-frame results
        self._second_buf: list[int] = []               # track IDs seen this second
        self._last_second: int = 0

    # ─────────────────────────────────────────────────────────────────────────
    def set_video_meta(self, width: int, height: int, fps: float):
        self.frame_width = width
        self.frame_height = height
        self.fps = fps

    # ─────────────────────────────────────────────────────────────────────────
    def _update_calibration(self, class_name: str, bbox_w_px: float):
        """Update metres-per-pixel using detected vehicle bounding box width."""
        ref_w = AVG_WIDTHS_M.get(class_name, 1.8)
        mpp = ref_w / bbox_w_px          # metres / pixel (horizontal)
        if self.mpp_h is None:
            self.mpp_h = mpp
        else:
            self.mpp_h = 0.9 * self.mpp_h + 0.1 * mpp   # EMA smoothing

        # Vertical mpp assumed same (top-down approximation)
        self.mpp = self.mpp_h

        # Road width in pixels → road width in metres
        if self.frame_width > 0:
            self.road_width_px = float(self.frame_width)
            self.road_width_m = self.road_width_px * self.mpp_h

    # ─────────────────────────────────────────────────────────────────────────
    def _compute_velocity(self, track_id: int, frame_idx: int) -> float | None:
        """
        Returns velocity in km/h for a given track, or None if insufficient history.
        Uses the vertical (approaching) component as primary speed estimate.
        """
        hist = self.history[track_id]
        if len(hist) < 3:
            return None

        # Take oldest and newest entries with enough separation
        old = hist[0]
        new = hist[-1]
        frame_delta = new[0] - old[0]
        if frame_delta == 0:
            return None

        # Centroid displacement in pixels
        dy = abs(new[2] - old[2])   # vertical (approaching)
        dx = abs(new[1] - old[1])   # horizontal (lateral)

        # Euclidean pixel displacement
        d_px = (dx**2 + dy**2) ** 0.5

        if self.mpp is None:
            return None

        d_m = d_px * self.mpp                       # metres
        t_s = frame_delta / self.fps                # seconds
        v_ms = d_m / t_s                            # m/s
        v_kmh = v_ms * 3.6                          # km/h
        return round(v_kmh, 1)

    # ─────────────────────────────────────────────────────────────────────────
    def process_frame(self, frame: np.ndarray, frame_idx: int) -> tuple[np.ndarray, dict]:
        """
        Run detection + tracking on one frame.
        Returns (annotated_frame, result_dict).
        """
        results = self.model.track(
            frame,
            persist=True,
            conf=self.conf,
            device=DEVICE,
            tracker=BYTETRACK_CFG,
            classes=list(VEHICLE_CLASSES.keys()),
            verbose=False,
        )

        annotated = frame.copy()
        frame_data = {
            "frame": frame_idx,
            "time_s": round(frame_idx / self.fps, 2),
            "vehicles": [],
        }

        current_second = int(frame_idx / self.fps)

        boxes = results[0].boxes
        if boxes is None or boxes.id is None:
            return annotated, frame_data

        for box in boxes:
            cls_id = int(box.cls[0])
            if cls_id not in VEHICLE_CLASSES:
                continue

            track_id = int(box.id[0])
            class_name = VEHICLE_CLASSES[cls_id]
            conf_score = float(box.conf[0])

            # Bounding box
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            bw = x2 - x1
            bh = y2 - y1
            cx = (x1 + x2) // 2
            cy = (y1 + y2) // 2

            # Update calibration
            if bw > 20:
                self._update_calibration(class_name, bw)

            # Update history
            self.history[track_id].append((frame_idx, cx, cy, bw, class_name))

            # Compute velocity
            velocity = self._compute_velocity(track_id, frame_idx)

            # Distance to crossing line (bottom of frame)
            dist_px = self.frame_height - cy
            dist_m = (dist_px * self.mpp) if self.mpp else None

            # Time to arrival at crossing line
            tta = None
            if velocity and dist_m and velocity > 0.5:
                v_ms = velocity / 3.6
                tta = round(dist_m / v_ms, 2)

            vehicle_info = {
                "id":         track_id,
                "class":      class_name,
                "conf":       round(conf_score, 2),
                "bbox":       [x1, y1, x2, y2],
                "centroid":   [cx, cy],
                "velocity_kmh": velocity,
                "dist_m":     round(dist_m, 2) if dist_m else None,
                "tta_s":      tta,
            }
            frame_data["vehicles"].append(vehicle_info)

            if velocity:
                self.all_velocities.append(velocity)

            # ── Draw annotation ───────────────────────────────────────────
            color = self._get_color(track_id)
            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)

            label_parts = [f"#{track_id} {class_name}"]
            if velocity:
                label_parts.append(f"{velocity:.0f}km/h")
            if tta:
                label_parts.append(f"TTA:{tta:.1f}s")
            label = "  ".join(label_parts)

            # Background for label
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
            cv2.rectangle(annotated, (x1, y1 - th - 8), (x1 + tw + 4, y1), color, -1)
            cv2.putText(annotated, label, (x1 + 2, y1 - 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 2)

            # Centroid dot
            cv2.circle(annotated, (cx, cy), 4, color, -1)

            # ── Velocity arrow (direction of movement) ─────────────────
            hist = self.history[track_id]
            if len(hist) >= 2:
                prev = hist[-2]
                arrow_end = (cx + (cx - prev[1]) * 5, cy + (cy - prev[2]) * 5)
                cv2.arrowedLine(annotated, (cx, cy), arrow_end, color, 2, tipLength=0.3)

            # Track for per-second count
            if current_second == self._last_second:
                if track_id not in self._second_buf:
                    self._second_buf.append(track_id)
            else:
                # Save previous second's data
                self.vehicle_counts.append({
                    "second": self._last_second,
                    "count": len(self._second_buf),
                })
                self._second_buf = [track_id]
                self._last_second = current_second

        # ── Overlay: road width & info bar ────────────────────────────────────
        self._draw_info_bar(annotated, frame_data)

        self.frame_results.append(frame_data)
        return annotated, frame_data

    # ─────────────────────────────────────────────────────────────────────────
    def _draw_info_bar(self, frame: np.ndarray, frame_data: dict):
        """Draw top info bar on the frame."""
        h, w = frame.shape[:2]
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (w, 38), (10, 10, 20), -1)
        cv2.addWeighted(overlay, 0.7, frame, 0.3, 0, frame)

        rw = f"{self.road_width_m:.1f}m" if self.road_width_m else "?m"
        n = len(frame_data["vehicles"])
        t = frame_data["time_s"]
        txt = f"  Time: {t:.1f}s   |   Vehicles: {n}   |   Road width: {rw}   |   Device: {DEVICE.upper()}"
        cv2.putText(frame, txt, (6, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 230, 255), 1)

        # Draw crossing line
        cv2.line(frame, (0, h - 2), (w, h - 2), (0, 255, 120), 3)
        cv2.putText(frame, "CROSSING LINE", (w // 2 - 80, h - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 120), 1)

    # ─────────────────────────────────────────────────────────────────────────
    @staticmethod
    def _get_color(track_id: int) -> tuple[int, int, int]:
        """Deterministic per-track color."""
        np.random.seed(track_id * 31 % 255)
        return tuple(int(c) for c in np.random.randint(80, 255, 3))

    # ─────────────────────────────────────────────────────────────────────────
    def get_analytics(self) -> dict:
        """Return aggregated analytics after processing."""
        base = {
            "road_width_m": round(self.road_width_m, 2),
            "mpp":          round(self.mpp, 6) if self.mpp else None,
            "total_frames": len(self.frame_results),
            "fps":          self.fps,
            "device":       DEVICE,
            "model":        self.model_name,
        }
        if not self.all_velocities:
            base.update({
                "avg_velocity":  None,
                "max_velocity":  None,
                "min_velocity":  None,
                "velocity_hist": [],
                "velocity_bins": [],
                "vehicle_counts": self.vehicle_counts,
            })
            return base

        velocities = np.array(self.all_velocities)
        base.update({
            "avg_velocity":   round(float(velocities.mean()), 1),
            "max_velocity":   round(float(velocities.max()), 1),
            "min_velocity":   round(float(velocities.min()), 1),
            "velocity_hist":  np.histogram(velocities, bins=12)[0].tolist(),
            "velocity_bins":  np.histogram(velocities, bins=12)[1].tolist(),
            "vehicle_counts": self.vehicle_counts,
        })
        return base

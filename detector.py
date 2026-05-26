"""
detector.py
===========
YOLOv8 vehicle detector + ByteTrack + road-geometry estimator.
Road boundary = two edge lines (no forced vanishing point).
"""

import os
import cv2
import numpy as np
from collections import defaultdict, deque
from ultralytics import YOLO
import torch

_HERE = os.path.dirname(os.path.abspath(__file__))
BYTETRACK_CFG = os.path.join(_HERE, "bytetrack.yaml")


def _detect_device() -> str:
    if not torch.cuda.is_available():
        print("[Detector] CUDA not available — CPU mode")
        return "cpu"
    try:
        torch.zeros(1).cuda()
        print(f"[Detector] GPU: {torch.cuda.get_device_name(0)} ✅")
        return "cuda"
    except Exception as e:
        print(f"[Detector] CUDA error ({e}) — CPU fallback")
        return "cpu"


DEVICE = _detect_device()

VEHICLE_CLASSES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck", 1: "bicycle"}
AVG_WIDTHS_M    = {"car": 1.8, "truck": 2.5, "bus": 2.5, "motorcycle": 0.8, "bicycle": 0.6}
HISTORY_LEN     = 30
SPEED_MIN_KMH   = 2.0
SPEED_MAX_KMH   = 180.0


# ─────────────────────────────────────────────────────────────────────────────
# Geometry estimation
# ─────────────────────────────────────────────────────────────────────────────

def _extrapolate_x(x1, y1, x2, y2, target_y):
    """X coordinate on the line (x1,y1)→(x2,y2) at target_y."""
    dy = y2 - y1
    if abs(dy) < 1:
        return x1
    return x1 + (target_y - y1) * (x2 - x1) / dy


def estimate_geometry(frames: list[np.ndarray]) -> dict:
    """
    Detect the left and right road-edge lines from sampled frames.
    Does NOT force a vanishing point — lines stop where road is visible.
    Returns geometry dict used by VehicleTracker and the frontend overlay.
    """
    if not frames:
        return _fallback_geometry(1280, 720)

    h, w = frames[0].shape[:2]
    road_top_y = int(h * 0.30)   # road starts at 30% from top (above = sky/buildings)

    all_lines = []

    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        # Work on lower 70% of frame where road dominates
        roi = gray[road_top_y:, :]
        blur = cv2.GaussianBlur(roi, (7, 7), 0)
        edges = cv2.Canny(blur, 40, 120)
        lines = cv2.HoughLinesP(edges, 1, np.pi / 180,
                                threshold=50, minLineLength=50, maxLineGap=40)
        if lines is None:
            continue

        for seg in lines:
            x1, y1, x2, y2 = seg[0]
            # Translate back to full-frame coords
            y1 += road_top_y
            y2 += road_top_y

            # Ensure y1 < y2 (y1 = higher in frame = further from camera)
            if y1 > y2:
                x1, y1, x2, y2 = x2, y2, x1, y1

            dy = y2 - y1
            dx = x2 - x1
            if abs(dy) < 10:
                continue   # skip near-horizontal lines

            # Accept lines with 15°–75° from horizontal (road edges lean inward)
            angle = abs(np.degrees(np.arctan2(dy, dx)))
            if angle < 15 or angle > 165:
                continue

            # Extrapolate to frame bottom and road_top_y
            xb = _extrapolate_x(x1, y1, x2, y2, h)          # at bottom
            xt = _extrapolate_x(x1, y1, x2, y2, road_top_y)  # at road top

            all_lines.append((xb, xt))

    # Sort lines by bottom X coordinate
    all_lines.sort(key=lambda x: x[0])

    # Cluster lines that are spatially close at the bottom
    clusters = []
    curr = []
    for line in all_lines:
        if not curr:
            curr.append(line)
        else:
            avg_xb = np.mean([l[0] for l in curr])
            if abs(line[0] - avg_xb) < w * 0.15:  # 15% of frame width clustering
                curr.append(line)
            else:
                clusters.append(curr)
                curr = [line]
    if curr:
        clusters.append(curr)

    # For each cluster, get robust mean of xb and xt
    def _robust_mean(vals):
        arr = np.array(vals)
        lo, hi = np.percentile(arr, 20), np.percentile(arr, 80)
        filtered = arr[(arr >= lo) & (arr <= hi)]
        return float(np.mean(filtered)) if len(filtered) > 0 else float(np.mean(arr))

    boundaries = []
    for c in clusters:
        boundaries.append((_robust_mean([l[0] for l in c]), _robust_mean([l[1] for l in c])))

    boundaries.sort(key=lambda x: x[0])

    roads = []
    if len(boundaries) >= 4:
        # Likely dual carriageway: pair [0,1] and [2,3]
        for i in range(2):
            idx = i * 2
            roads.append({
                "id": i + 1,
                "left_line":  [[int(boundaries[idx][0]), h], [int(boundaries[idx][1]), road_top_y]],
                "right_line": [[int(boundaries[idx+1][0]), h], [int(boundaries[idx+1][1]), road_top_y]]
            })
    elif len(boundaries) >= 2:
        # Single road: use outermost boundaries
        roads.append({
            "id": 1,
            "left_line":  [[int(boundaries[0][0]), h], [int(boundaries[0][1]), road_top_y]],
            "right_line": [[int(boundaries[-1][0]), h], [int(boundaries[-1][1]), road_top_y]]
        })
    else:
        # Fallback
        roads = [_fallback_geometry(w, h)["roads"][0]]

    # Ensure coordinates are clamped
    for r in roads:
        for pt in [r["left_line"][0], r["left_line"][1], r["right_line"][0], r["right_line"][1]]:
            pt[0] = max(0, min(w - 1, int(pt[0])))

    default_y = int(road_top_y + 0.30 * (h - road_top_y))

    return {
        "roads": roads,
        "road_top_y": road_top_y,
        "default_crossing_y": default_y,
        "frame_width":  w,
        "frame_height": h,
    }

def _fallback_geometry(w: int, h: int) -> dict:
    road_top_y = int(h * 0.30)
    return {
        "roads": [{
            "id": 1,
            "left_line":  [[int(w * 0.18), h], [int(w * 0.38), road_top_y]],
            "right_line": [[int(w * 0.82), h], [int(w * 0.62), road_top_y]],
        }],
        "road_top_y": road_top_y,
        "default_crossing_y": int(road_top_y + 0.30 * (h - road_top_y)),
        "frame_width":  w,
        "frame_height": h,
    }


def road_edges_at_y(road: dict, y: int) -> tuple[int, int]:
    """Linear interpolation of a specific road's left/right edge at image row y."""
    ll = road["left_line"]   # [[lx_bot, h], [lx_top, road_top_y]]
    rl = road["right_line"]

    lx_bot, ly_bot = ll[0]
    lx_top, ly_top = ll[1]
    rx_bot, ry_bot = rl[0]
    rx_top, ry_top = rl[1]

    # Left edge at y
    if abs(ly_bot - ly_top) < 1:
        lx = lx_bot
    else:
        t = (y - ly_bot) / (ly_top - ly_bot)
        lx = int(round(lx_bot + t * (lx_top - lx_bot)))

    # Right edge at y
    if abs(ry_bot - ry_top) < 1:
        rx = rx_bot
    else:
        t = (y - ry_bot) / (ry_top - ry_bot)
        rx = int(round(rx_bot + t * (rx_top - rx_bot)))

    return lx, rx


# ─────────────────────────────────────────────────────────────────────────────
# VehicleTracker
# ─────────────────────────────────────────────────────────────────────────────

class VehicleTracker:
    def __init__(self, model_path: str = "yolov8m.pt", conf: float = 0.35):
        self.model = YOLO(model_path)
        self.model.to(DEVICE)
        self.model_name = os.path.basename(model_path).replace(".pt", "")
        self.conf = conf

        # history: (frame_idx, cx, cy, bw, bh, class_name)
        self.history: dict[int, deque] = defaultdict(lambda: deque(maxlen=HISTORY_LEN))
        self._speed_ema: dict[int, float] = {}

        self.mpp_h: float | None = None
        self.mpp_h_samples: int = 0
        self.road_width_m: float = 7.0
        self.frame_width: int = 0
        self.frame_height: int = 0
        self.fps: float = 30.0
        self.geo: dict | None = None

        self.all_velocities: list[float] = []
        self.vehicle_counts: list[dict] = []
        self.frame_results: list[dict] = []
        self._second_buf: list[int] = []
        self._last_second: int = 0

    def set_video_meta(self, width: int, height: int, fps: float):
        self.frame_width = width
        self.frame_height = height
        self.fps = fps

    def set_geometry(self, geo: dict):
        self.geo = geo

    # ── Calibration ──────────────────────────────────────────────────────────
    def _update_calibration(self, class_name: str, bw_px: float):
        ref_w = AVG_WIDTHS_M.get(class_name, 1.8)
        mpp = ref_w / max(bw_px, 1)
        self.mpp_h_samples += 1
        if self.mpp_h is None:
            self.mpp_h = mpp
        else:
            self.mpp_h = 0.95 * self.mpp_h + 0.05 * mpp

        if self.geo and self.geo["roads"]:
            # Default to the first road for calibration
            lx, rx = road_edges_at_y(self.geo["roads"][0], self.frame_height)
            road_px = max(1, rx - lx)
            self.road_width_m = max(3.0, road_px * self.mpp_h)

    # ── Speed (bbox-area growth, pinhole model) ───────────────────────────────
    def _compute_velocity(self, track_id: int, _frame_idx: int) -> float | None:
        hist = list(self.history[track_id])
        if len(hist) < 10 or self.mpp_h is None or self.mpp_h_samples < 6:
            return None

        mid = len(hist) // 2
        old_h, new_h = hist[:mid], hist[mid:]

        area_old = np.mean([e[3] * e[4] for e in old_h])
        area_new = np.mean([e[3] * e[4] for e in new_h])

        if area_old <= 0 or area_new <= area_old * 1.01:
            return None   # not approaching

        dist_ratio = np.sqrt(area_old / area_new)   # < 1 → vehicle is closer now

        class_name = old_h[-1][5]
        known_w    = AVG_WIDTHS_M.get(class_name, 1.8)
        bw_old     = np.mean([e[3] for e in old_h])

        # Pinhole: dist ∝ known_w / bw_px
        dist_old_m = known_w / max(bw_old * self.mpp_h, 1e-6)
        d_m        = dist_old_m * (1 - dist_ratio)

        f_old = old_h[len(old_h) // 2][0]
        f_new = new_h[len(new_h) // 2][0]
        t_s   = max((f_new - f_old) / self.fps, 1e-6)

        v_kmh = (d_m / t_s) * 3.6
        if not (SPEED_MIN_KMH <= v_kmh <= SPEED_MAX_KMH):
            return None

        alpha = 0.2
        if track_id in self._speed_ema:
            v_kmh = (1 - alpha) * self._speed_ema[track_id] + alpha * v_kmh
        self._speed_ema[track_id] = v_kmh
        return round(v_kmh, 1)

    # ── Lane drawing (server-side, on video frames) ───────────────────────────
    def _draw_lanes(self, frame: np.ndarray):
        """Draw road edge lines + interior lane dividers. No crossing line."""
        if not self.geo:
            return
        geo = self.geo
        h   = frame.shape[0]
        road_top_y = geo["road_top_y"]

        overlay = frame.copy()

        for road in geo["roads"]:
            ll = road["left_line"]
            rl = road["right_line"]
            lx_bot, lx_top = ll[0][0], ll[1][0]
            rx_bot, rx_top = rl[0][0], rl[1][0]

            # Semi-transparent road overlay (trapezoid fill)
            trap = np.array([
                [lx_top, road_top_y],
                [rx_top, road_top_y],
                [rx_bot, h],
                [lx_bot, h],
            ], dtype=np.int32)
            cv2.fillPoly(overlay, [trap], (15, 35, 15))

            # Road edge lines
            cv2.line(frame, (lx_bot, h), (lx_top, road_top_y), (240, 220, 60), 2, cv2.LINE_AA)
            cv2.line(frame, (rx_bot, h), (rx_top, road_top_y), (240, 220, 60), 2, cv2.LINE_AA)

            # Interior lane dividers (dashed)
            n_lanes = max(2, min(5, int(round(self.road_width_m / 3.5))))
            for i in range(1, n_lanes):
                frac  = i / n_lanes
                bx    = int(lx_bot + (rx_bot - lx_bot) * frac)
                tx    = int(lx_top + (rx_top - lx_top) * frac)
                self._dashed_line(frame, (bx, h), (tx, road_top_y),
                                  (160, 160, 160), thickness=1, dash=18, gap=12)
        
        cv2.addWeighted(overlay, 0.22, frame, 0.78, 0, frame)

    @staticmethod
    def _dashed_line(img, pt1, pt2, color, thickness=1, dash=12, gap=8):
        x1, y1 = pt1; x2, y2 = pt2
        dist = max(1, int(np.hypot(x2 - x1, y2 - y1)))
        step = dash + gap
        for s in range(0, dist, step):
            e = min(s + dash, dist)
            sx = int(x1 + (x2 - x1) * s / dist)
            sy = int(y1 + (y2 - y1) * s / dist)
            ex = int(x1 + (x2 - x1) * e / dist)
            ey = int(y1 + (y2 - y1) * e / dist)
            cv2.line(img, (sx, sy), (ex, ey), color, thickness, cv2.LINE_AA)

    # ── Main processing ───────────────────────────────────────────────────────
    def process_frame(self, frame: np.ndarray, frame_idx: int) -> tuple[np.ndarray, dict]:
        results = self.model.track(
            frame, persist=True, conf=self.conf, device=DEVICE,
            tracker=BYTETRACK_CFG, classes=list(VEHICLE_CLASSES.keys()), verbose=False,
        )

        annotated = frame.copy()
        self._draw_lanes(annotated)   # road edges only — no crossing line

        frame_data = {
            "frame":    frame_idx,
            "time_s":   round(frame_idx / self.fps, 2),
            "vehicles": [],
        }
        current_second = int(frame_idx / self.fps)

        boxes = results[0].boxes
        if boxes is None or boxes.id is None:
            self._draw_info_bar(annotated, frame_data)
            self.frame_results.append(frame_data)
            return annotated, frame_data

        for box in boxes:
            cls_id = int(box.cls[0])
            if cls_id not in VEHICLE_CLASSES:
                continue

            track_id   = int(box.id[0])
            class_name = VEHICLE_CLASSES[cls_id]
            conf_score = float(box.conf[0])

            x1, y1, x2, y2 = map(int, box.xyxy[0])
            bw = x2 - x1; bh = y2 - y1
            cx = (x1 + x2) // 2; cy = (y1 + y2) // 2

            if bw > 20:
                self._update_calibration(class_name, bw)

            self.history[track_id].append((frame_idx, cx, cy, bw, bh, class_name))
            velocity = self._compute_velocity(track_id, frame_idx)

            # Distance to bottom crossing reference (bottom of frame)
            dist_m, tta = None, None
            if self.mpp_h and self.geo:
                ref_y = self.geo["default_crossing_y"]
                dist_px = cy - ref_y
                if dist_px > 0:
                    dist_m = round(dist_px * self.mpp_h, 2)
                    if velocity and velocity > 0.5:
                        tta = round(dist_m / (velocity / 3.6), 2)

            vehicle_info = {
                "id": track_id, "class": class_name,
                "conf": round(conf_score, 2),
                "bbox": [x1, y1, x2, y2],
                "centroid": [cx, cy],
                "velocity_kmh": velocity,
                "dist_m": dist_m,
                "tta_s": tta,
            }
            frame_data["vehicles"].append(vehicle_info)
            if velocity:
                self.all_velocities.append(velocity)

            # Bounding box
            color = self._get_color(track_id)
            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)

            parts = [f"#{track_id} {class_name}"]
            if velocity: parts.append(f"{velocity:.0f}km/h")
            if tta:      parts.append(f"TTA:{tta:.1f}s")
            label = "  ".join(parts)

            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.50, 1)
            cv2.rectangle(annotated, (x1, y1 - th - 8), (x1 + tw + 4, y1), color, -1)
            cv2.putText(annotated, label, (x1 + 2, y1 - 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.50, (0, 0, 0), 1, cv2.LINE_AA)
            cv2.circle(annotated, (cx, cy), 4, color, -1)

            # Motion arrow
            hist = self.history[track_id]
            if len(hist) >= 2:
                prev = hist[-2]
                ax = max(0, min(self.frame_width - 1, cx + int((cx - prev[1]) * 4)))
                ay = max(0, min(self.frame_height - 1, cy + int((cy - prev[2]) * 4)))
                cv2.arrowedLine(annotated, (cx, cy), (ax, ay), color, 2, tipLength=0.3)

            if current_second == self._last_second:
                if track_id not in self._second_buf:
                    self._second_buf.append(track_id)
            else:
                self.vehicle_counts.append({"second": self._last_second,
                                            "count":  len(self._second_buf)})
                self._second_buf = [track_id]
                self._last_second = current_second

        self._draw_info_bar(annotated, frame_data)
        self.frame_results.append(frame_data)
        return annotated, frame_data

    # ── Info bar ──────────────────────────────────────────────────────────────
    def _draw_info_bar(self, frame: np.ndarray, frame_data: dict):
        h, w = frame.shape[:2]
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (w, 36), (6, 8, 18), -1)
        cv2.addWeighted(overlay, 0.75, frame, 0.25, 0, frame)
        txt = (f"  T:{frame_data['time_s']:.1f}s  |  "
               f"Vehicles:{len(frame_data['vehicles'])}  |  "
               f"Road:{self.road_width_m:.1f}m  |  {DEVICE.upper()}")
        cv2.putText(frame, txt, (6, 24), cv2.FONT_HERSHEY_SIMPLEX,
                    0.50, (200, 230, 255), 1, cv2.LINE_AA)

    # ── Color ─────────────────────────────────────────────────────────────────
    @staticmethod
    def _get_color(track_id: int) -> tuple[int, int, int]:
        np.random.seed(track_id * 31 % 255)
        return tuple(int(c) for c in np.random.randint(80, 255, 3))

    # ── Analytics ─────────────────────────────────────────────────────────────
    def get_analytics(self) -> dict:
        base = {
            "road_width_m": round(self.road_width_m, 2),
            "mpp":          round(self.mpp_h, 6) if self.mpp_h else None,
            "total_frames": len(self.frame_results),
            "fps":          self.fps,
            "device":       DEVICE,
            "model":        self.model_name,
            "geometry":     self.geo,
        }
        if not self.all_velocities:
            base.update({
                "avg_velocity": None, "max_velocity": None,
                "min_velocity": None, "velocity_hist": [],
                "velocity_bins": [], "vehicle_counts": self.vehicle_counts,
            })
            return base

        v = np.array(self.all_velocities)
        base.update({
            "avg_velocity":   round(float(v.mean()), 1),
            "max_velocity":   round(float(v.max()),  1),
            "min_velocity":   round(float(v.min()),  1),
            "velocity_hist":  np.histogram(v, bins=12)[0].tolist(),
            "velocity_bins":  np.histogram(v, bins=12)[1].tolist(),
            "vehicle_counts": self.vehicle_counts,
        })
        return base

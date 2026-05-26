"""
app.py
======
Flask backend for the Road Crossing Safety Predictor.
Handles video upload, background processing, MJPEG streaming, and all REST APIs.
"""

import os
import uuid
import time
import json
import threading
import subprocess
import cv2
import numpy as np
import imageio_ffmpeg
from flask import Flask, request, jsonify, Response, send_from_directory
from flask_cors import CORS

from detector import VehicleTracker, estimate_geometry
from road_analyzer import compute_crossing_windows, simulate_crossing

# ── Flask setup ───────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)

UPLOAD_DIR = "uploads"
OUTPUT_DIR = "output"
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── Global state (single-session, localhost) ──────────────────────────────────
state = {
    "status":        "idle",
    "progress":      0,
    "message":       "",
    "frame_results": [],
    "analytics":     {},
    "windows":       [],
    "tracker":       None,
    "video_path":    None,
    "output_path":   None,
    "current_frame": None,
    "frame_lock":    threading.Lock(),
    "total_frames":  0,
    "error":         None,
    "geometry":      None,
}


# ── Helper: process video in background thread ────────────────────────────────
def process_video(video_path: str):
    state["status"]   = "processing"
    state["progress"] = 0
    state["error"]    = None
    state["frame_results"] = []
    state["analytics"] = {}
    state["windows"]  = []

    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise RuntimeError("Cannot open video file.")

        fps    = cap.get(cv2.CAP_PROP_FPS) or 30.0
        width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        # Check for WebM variable framerate or other abnormal FPS reported by OpenCV
        if fps >= 100.0 or fps < 5.0 or total > 100000 or total <= 0:
            state["message"] = "Probing video characteristics..."
            # Count actual frames using fast grab
            actual_frames = 0
            while cap.grab():
                actual_frames += 1
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0) # rewind

            # Extract actual duration using ffmpeg
            duration_s = 30.0
            try:
                ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
                res = subprocess.run(
                    [ffmpeg_exe, "-i", video_path],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
                )
                import re
                match = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", res.stderr)
                if match:
                    hours, minutes, seconds = match.groups()
                    duration_s = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
            except Exception:
                pass

            if duration_s > 0:
                fps = actual_frames / duration_s
            else:
                fps = 30.0
            total = actual_frames

        state["total_frames"] = total

        # ── Geometry warmup: sample 30 frames evenly for VP detection ─────
        state["message"] = "Analysing road geometry…"
        warmup_frames = []
        warmup_indices = np.linspace(0, max(total-1, 0), min(30, total), dtype=int)
        for wi in warmup_indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(wi))
            ret, wf = cap.read()
            if ret:
                warmup_frames.append(wf)
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)   # rewind

        geo = estimate_geometry(warmup_frames) if warmup_frames else None
        state["geometry"] = geo

        # Output video writer
        temp_out_path = os.path.join(OUTPUT_DIR, "temp_processed.mp4")
        out_path = os.path.join(OUTPUT_DIR, "processed.mp4")
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(temp_out_path, fourcc, fps, (width, height))
        state["output_path"] = out_path

        tracker = VehicleTracker(model_path="yolov8m.pt", conf=0.35)
        tracker.set_video_meta(width, height, fps)
        if geo:
            tracker.set_geometry(geo)
        state["tracker"] = tracker

        frame_idx = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            annotated, frame_data = tracker.process_frame(frame, frame_idx)
            writer.write(annotated)

            # Store latest frame for streaming
            _, jpeg = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])
            with state["frame_lock"]:
                state["current_frame"] = jpeg.tobytes()

            state["frame_results"] = tracker.frame_results
            state["progress"] = int((frame_idx / max(total, 1)) * 100)
            frame_idx += 1

        cap.release()
        writer.release()

        state["progress"] = 99
        state["message"] = "Encoding video for browser playback..."
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        subprocess.run([
            ffmpeg_exe, "-y", "-i", temp_out_path,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            out_path
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        if os.path.exists(temp_out_path):
            try:
                os.remove(temp_out_path)
            except Exception:
                pass

        # Finalise analytics
        analytics = tracker.get_analytics()
        state["analytics"] = analytics

        road_w = analytics.get("road_width_m", 7.0)
        windows = compute_crossing_windows(
            tracker.frame_results,
            road_width_m=road_w,
            fps=fps,
        )
        state["windows"]   = windows
        state["status"]    = "done"
        state["progress"]  = 100
        state["message"]   = "Processing complete!"

    except Exception as exc:
        import traceback
        state["status"] = "error"
        state["error"]  = str(exc)
        state["message"] = f"Error: {exc}"
        print(f"[process_video ERROR] {traceback.format_exc()}")
        # Do NOT re-raise — this is a daemon thread, re-raising just kills it silently


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("static", "index.html")

@app.route("/runs/<path:filename>")
def serve_run_file(filename):
    return send_from_directory(OUTPUT_DIR, filename)


@app.route("/upload", methods=["POST"])
def upload():
    if "video" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    f    = request.files["video"]
    ext  = os.path.splitext(f.filename)[1].lower()
    name = f"upload_{uuid.uuid4().hex[:8]}{ext}"
    path = os.path.join(UPLOAD_DIR, name)
    f.save(path)
    state["video_path"] = path

    # Start processing in background
    t = threading.Thread(target=process_video, args=(path,), daemon=True)
    t.start()

    return jsonify({"message": "Upload successful, processing started.", "file": name})


@app.route("/status")
def status():
    return jsonify({
        "status":   state["status"],
        "progress": state["progress"],
        "message":  state["message"],
        "error":    state["error"],
    })


@app.route("/stream")
def stream():
    """MJPEG stream of the annotated video."""
    def generate():
        last_frame = None
        idle_count = 0
        while True:
            try:
                lock = state.get("frame_lock")
                if lock is None:
                    time.sleep(0.1)
                    continue
                with lock:
                    frame = state["current_frame"]
                if frame:
                    if frame != last_frame:
                        last_frame = frame
                        idle_count = 0
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
                    )
                else:
                    idle_count += 1
                    if idle_count > 300:   # 10s idle → stop
                        break
                time.sleep(0.033)   # ~30 fps cap
            except GeneratorExit:
                break
            except Exception:
                time.sleep(0.1)

    return Response(
        generate(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.route("/analytics")
def analytics():
    return jsonify(state["analytics"])


@app.route("/crossings")
def crossings():
    return jsonify({
        "windows":      state["windows"],
        "road_width_m": state["analytics"].get("road_width_m", 7.0),
        "fps":          state["analytics"].get("fps", 30.0),
    })


@app.route("/geometry")
def geometry():
    geo = state.get("geometry")
    if not geo:
        return jsonify({"error": "No geometry computed yet."}), 404
    return jsonify(geo)


@app.route("/frame_results")
def frame_results():
    """Return a summary of per-second vehicle data (not full frames)."""
    by_second = {}
    for fr in state["frame_results"]:
        s = int(fr["time_s"])
        if s not in by_second:
            by_second[s] = {
                "second": s,
                "vehicle_count": 0,
                "avg_velocity": 0,
                "min_tta": None,
                "vehicles": [],
            }
        entry = by_second[s]
        for v in fr["vehicles"]:
            entry["vehicle_count"] += 1
            if v["velocity_kmh"]:
                entry["avg_velocity"] = (entry["avg_velocity"] + v["velocity_kmh"]) / 2
            if v["tta_s"] and (entry["min_tta"] is None or v["tta_s"] < entry["min_tta"]):
                entry["min_tta"] = v["tta_s"]
            entry["vehicles"].append({
                "id":    v["id"],
                "class": v["class"],
                "vel":   v["velocity_kmh"],
                "tta":   v["tta_s"],
            })

    return jsonify(list(by_second.values()))


@app.route("/simulate", methods=["POST"])
def simulate():
    data = request.get_json(force=True)
    start_time = float(data.get("time", 0))
    ped_speed  = float(data.get("speed", 1.4))

    if not state["frame_results"]:
        return jsonify({"error": "No processed video data yet."}), 400

    road_w = state["analytics"].get("road_width_m", 7.0)
    frame_width = state["tracker"].frame_width if state["tracker"] else 1920
    fps = state["analytics"].get("fps", 30.0)

    # Recalculate vehicle metrics based on user's selected crossing line and road boundaries
    import copy
    frame_results = copy.deepcopy(state["frame_results"])

    crossing_y_frac = data.get("crossing_y_frac")
    geometry = data.get("geometry")

    # Determine which geometry to use (default or adjusted)
    geo = geometry if (geometry and "roads" in geometry) else state.get("geometry")

    if geo and "roads" in geo and len(geo["roads"]) > 0:
        road_idx = int(data.get("selected_road_index", 0) or 0)
        if road_idx < len(geo["roads"]):
            road = geo["roads"][road_idx]
            h = geo.get("frame_height", 720)
            crossing_y = float(crossing_y_frac) * h if crossing_y_frac is not None else geo.get("default_crossing_y", h * 0.5)
            mpp = state["analytics"].get("mpp", 0.008)
            num_lanes = 3

            lxb, lyb = road["left_line"][0]
            lxt, lyt = road["left_line"][1]
            rxb, ryb = road["right_line"][0]
            rxt, ryt = road["right_line"][1]

            for fr in frame_results:
                for v in fr["vehicles"]:
                    cx, cy = v["centroid"]

                    # 1. Recalculate distance from crossing line
                    dist_px = cy - crossing_y
                    if dist_px > 0:
                        v["dist_m"] = round(dist_px * mpp, 2)
                        vel = v.get("velocity_kmh")
                        if vel and vel > 0.5:
                            v["tta_s"] = round(v["dist_m"] / (vel / 3.6), 2)
                        else:
                            v["tta_s"] = None
                    else:
                        v["dist_m"] = -1.0
                        v["tta_s"] = None

                    # 2. Recalculate vehicle lane position relative to perspective boundaries at vehicle's cy
                    t_left = 0.0 if abs(lyb - lyt) < 1 else (cy - lyb) / (lyt - lyb)
                    t_right = 0.0 if abs(ryb - ryt) < 1 else (cy - ryb) / (ryt - ryb)
                    
                    left_x = lxb + t_left * (lxt - lxb)
                    right_x = rxb + t_right * (rxt - rxb)

                    road_w_px = right_x - left_x
                    if road_w_px > 0:
                        rel_x = cx - left_x
                        v_lane = 1 + int((rel_x / road_w_px) * num_lanes)
                        v["lane"] = max(1, min(num_lanes, v_lane))
                    else:
                        v["lane"] = 2

    result = simulate_crossing(
        frame_results=frame_results,
        start_time=start_time,
        ped_speed=ped_speed,
        road_width_m=road_w,
        frame_width=frame_width,
        fps=fps,
    )
    return jsonify(result)


@app.route("/reset", methods=["POST"])
def reset():
    state.update({
        "status": "idle", "progress": 0, "message": "",
        "frame_results": [], "analytics": {}, "windows": [],
        "tracker": None, "video_path": None, "output_path": None,
        "current_frame": None, "total_frames": 0, "error": None,
        "geometry": None,
    })
    return jsonify({"message": "Reset complete."})


@app.route("/healthcheck")
def healthcheck():
    import torch
    return jsonify({
        "status":  "ok",
        "cuda":    torch.cuda.is_available(),
        "gpu":     torch.cuda.get_device_name(0) if torch.cuda.is_available() else "N/A",
    })


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("\n" + "="*60)
    print("  Road Crossing Safety Predictor")
    print("  Running at: http://localhost:5000")
    print("="*60 + "\n")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)

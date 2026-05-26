"""
app.py
======
Flask backend for the Road Crossing Safety Predictor.
Handles video upload, background processing, MJPEG streaming, and all REST APIs.
"""

import os
import cv2
import json
import time
import threading
import uuid
from flask import Flask, request, jsonify, Response, send_from_directory
from flask_cors import CORS

from detector import VehicleTracker
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
    "status":        "idle",          # idle | processing | done | error
    "progress":      0,               # 0–100
    "message":       "",
    "frame_results": [],
    "analytics":     {},
    "windows":       [],
    "tracker":       None,
    "video_path":    None,
    "output_path":   None,
    "current_frame": None,            # latest annotated frame (JPEG bytes)
    "frame_lock":    threading.Lock(),
    "total_frames":  0,
    "error":         None,
}


# ── Helper: process video in background thread ────────────────────────────────
def process_video(video_path: str):
    state["status"]   = "processing"
    state["progress"] = 0
    state["error"]    = None
    state["message"]  = "Analyzing video frames..."
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
        
        # Safely compute total frames
        total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if total <= 0:
            # Fallback estimation for videos with corrupt headers (e.g. webm)
            total = 600 # 20 seconds at 30 fps
        state["total_frames"] = total

        # Output video writer disabled for 5x speedup (never served to frontend)
        state["output_path"] = None

        tracker = VehicleTracker(model_path="yolov8m.pt", conf=0.35)
        tracker.set_video_meta(width, height, fps)
        state["tracker"] = tracker

        frame_idx = 0
        skip_factor = 2  # Process every 2nd frame for 2x speedup (cuts CPU & GPU overhead in half)
        last_annotated = None
        last_frame_data = None
        last_jpeg_bytes = None

        while True:
            if state.get("abort_processing"):
                cap.release()
                print("[process_video] Aborted by request.")
                return
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % skip_factor == 0:
                annotated, frame_data = tracker.process_frame(frame, frame_idx)
                last_annotated = annotated
                last_frame_data = frame_data

                # Store latest frame for streaming (only encode on processed frames to save CPU)
                _, jpeg = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])
                last_jpeg_bytes = jpeg.tobytes()
                with state["frame_lock"]:
                    state["current_frame"] = last_jpeg_bytes
            else:
                # Re-use last detection data but update the timestamp for smooth timeline math
                if last_frame_data:
                    frame_data = {
                        "frame": frame_idx,
                        "time_s": round(frame_idx / fps, 2),
                        "vehicles": last_frame_data["vehicles"]
                    }
                    tracker.frame_results.append(frame_data)
                else:
                    frame_data = {
                        "frame": frame_idx,
                        "time_s": round(frame_idx / fps, 2),
                        "vehicles": []
                    }
                    tracker.frame_results.append(frame_data)

            state["frame_results"] = tracker.frame_results
            # Cap progress at 99% until fully processed
            state["progress"] = min(99, int((frame_idx / max(total, 1)) * 100))
            frame_idx += 1

        cap.release()

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


@app.route("/upload", methods=["POST"])
def upload():
    if "video" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    # Abort any currently running processing thread
    state["abort_processing"] = True
    time.sleep(0.35)
    state["abort_processing"] = False

    # Clear old results to prevent UI race conditions
    state.update({
        "status": "processing",
        "progress": 0,
        "message": "Uploading video...",
        "frame_results": [],
        "analytics": {},
        "windows": [],
        "current_frame": None,
    })

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

    start_x = data.get("start_x")
    start_z = data.get("start_z")
    end_x = data.get("end_x")
    end_z = data.get("end_z")

    kwargs = {}
    if start_x is not None: kwargs["start_x"] = float(start_x)
    if start_z is not None: kwargs["start_z"] = float(start_z)
    if end_x is not None: kwargs["end_x"] = float(end_x)
    if end_z is not None: kwargs["end_z"] = float(end_z)

    if not state["frame_results"]:
        return jsonify({"error": "No processed video data yet."}), 400

    road_w = state["analytics"].get("road_width_m", 7.0)
    frame_width = state["tracker"].frame_width if state["tracker"] else 1920
    
    result = simulate_crossing(
        frame_results=state["frame_results"],
        start_time=start_time,
        ped_speed=ped_speed,
        road_width_m=road_w,
        frame_width=frame_width,
        **kwargs
    )
    return jsonify(result)


@app.route("/reset", methods=["POST"])
def reset():
    state.update({
        "status": "idle", "progress": 0, "message": "",
        "frame_results": [], "analytics": {}, "windows": [],
        "tracker": None, "video_path": None, "output_path": None,
        "current_frame": None, "total_frames": 0, "error": None,
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

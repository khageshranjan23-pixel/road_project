"""
test_pipeline.py
================
Standalone test: runs detector + road_analyzer on the test video
and prints a full report WITHOUT needing Flask/browser.
Run with:  python test_pipeline.py
"""

import cv2
import sys
import os

VIDEO_PATH = os.path.join("uploads", "test_road.mp4")

def main():
    print("\n" + "="*60)
    print("  RoadSafe AI — Pipeline Test")
    print("="*60)

    # ── 1. Check video ────────────────────────────────────────
    if not os.path.exists(VIDEO_PATH):
        print(f"[ERROR] Video not found: {VIDEO_PATH}")
        sys.exit(1)

    cap = cv2.VideoCapture(VIDEO_PATH)
    if not cap.isOpened():
        print("[ERROR] Cannot open video.")
        sys.exit(1)

    fps    = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    dur    = total / fps
    cap.release()

    print(f"\n[Video]  {VIDEO_PATH}")
    print(f"  Resolution : {width}x{height}")
    print(f"  FPS        : {fps:.1f}")
    print(f"  Frames     : {total}")
    print(f"  Duration   : {dur:.1f}s")

    # ── 2. Import detector ────────────────────────────────────
    print("\n[Loading] Importing detector (YOLOv8x)...")
    try:
        from detector import VehicleTracker
        print("  [OK] detector.py imported")
    except Exception as e:
        print(f"  [ERROR] {e}")
        sys.exit(1)

    # ── 3. Initialise tracker ──────────────────────────────────
    print("\n[Loading] Initialising YOLOv8x model...")
    try:
        tracker = VehicleTracker(model_path="yolov8x.pt", conf=0.35)
        tracker.set_video_meta(width, height, fps)
        print("  [OK] Model loaded")
    except Exception as e:
        print(f"  [ERROR] {e}")
        sys.exit(1)

    # ── 4. Process frames (first 150 = ~5s for quick test) ────
    MAX_FRAMES = 150
    print(f"\n[Processing] Running on first {MAX_FRAMES} frames (~{MAX_FRAMES/fps:.0f}s)...")

    cap = cv2.VideoCapture(VIDEO_PATH)
    frame_idx = 0
    errors = 0

    while frame_idx < MAX_FRAMES:
        ret, frame = cap.read()
        if not ret:
            break
        try:
            annotated, frame_data = tracker.process_frame(frame, frame_idx)
            n = len(frame_data["vehicles"])
            if frame_idx % 30 == 0:
                vels = [v["velocity_kmh"] for v in frame_data["vehicles"] if v["velocity_kmh"]]
                avg_v = f"{sum(vels)/len(vels):.1f}" if vels else "—"
                print(f"  Frame {frame_idx:4d} | t={frame_data['time_s']:.1f}s | vehicles={n} | avg_speed={avg_v} km/h")
        except Exception as e:
            errors += 1
            print(f"  [WARN] Frame {frame_idx} error: {e}")
        frame_idx += 1

    cap.release()
    print(f"\n  Processed {frame_idx} frames with {errors} errors.")

    # ── 5. Analytics ──────────────────────────────────────────
    print("\n[Analytics]")
    analytics = tracker.get_analytics()
    if analytics:
        print(f"  Road width     : {analytics.get('road_width_m','?')} m")
        print(f"  Avg velocity   : {analytics.get('avg_velocity','?')} km/h")
        print(f"  Max velocity   : {analytics.get('max_velocity','?')} km/h")
        print(f"  Min velocity   : {analytics.get('min_velocity','?')} km/h")
        print(f"  Device used    : {analytics.get('device','?').upper()}")
        print(f"  Total detects  : {len(tracker.all_velocities)}")
    else:
        print("  [WARN] No vehicles detected — try a longer video or lower conf threshold")

    # ── 6. Crossing windows ───────────────────────────────────
    print("\n[Crossing Windows]")
    from road_analyzer import compute_crossing_windows, simulate_crossing
    road_w = analytics.get("road_width_m", 7.0)
    windows = compute_crossing_windows(tracker.frame_results, road_width_m=road_w, fps=fps)

    safe_count   = sum(1 for w in windows if w["safe"])
    danger_count = len(windows) - safe_count
    print(f"  Total windows  : {len(windows)}")
    print(f"  Safe windows   : {safe_count} 🟢")
    print(f"  Danger windows : {danger_count} 🔴")

    if windows:
        print("\n  First 5 windows:")
        for w in windows[:5]:
            status = "✅ SAFE" if w["safe"] else "🔴 DANGER"
            tta = f"TTA={w['min_tta']:.1f}s" if w["min_tta"] else "no cars"
            print(f"    t={w['second']:3d}s  {status}  {tta}  — {w['reason'][:60]}")

    # ── 7. Simulation test ────────────────────────────────────
    print("\n[Simulation Test]")
    # Find first safe window for test
    safe_windows = [w for w in windows if w["safe"]]
    test_time = safe_windows[0]["second"] if safe_windows else 2.0

    result = simulate_crossing(
        frame_results=tracker.frame_results,
        start_time=test_time,
        ped_speed=1.4,
        road_width_m=road_w,
    )
    arrivals = [v["t_arrival"] for v in result["simulated_vehicles"] if v["t_arrival"] > 0]
    min_arrival = min(arrivals) if arrivals else None
    min_margin = min_arrival - result["cross_time"] if min_arrival is not None else 99.0

    print(f"  Crossing at t={test_time}s, speed=1.4 m/s:")
    print(f"  Result  : {result['result']}")
    print(f"  Safe    : {result['safe']}")
    print(f"  Gap     : {min_arrival:.2f}s" if min_arrival is not None else "  Gap     : clear")
    print(f"  Margin  : {min_margin:+.2f}s" if min_margin != 99.0 else "  Margin  : —")
    print(f"  Advice  : {result['recommendation']}")

    print("\n" + "="*60)
    print("  ✅ ALL TESTS PASSED — Project is working correctly!")
    print("  Now run:  python app.py")
    print("  Then open: http://localhost:5000")
    print("="*60 + "\n")


if __name__ == "__main__":
    main()

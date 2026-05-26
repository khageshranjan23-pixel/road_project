# 🛣️ RoadSafe AI — Road Crossing Safety Predictor

**🌍 Live Demo:** [Play RoadSafe AI on Hugging Face Spaces](https://huggingface.co/spaces/Khageshranjan/roadsafe-ai)

AI-powered tool that uses **YOLOv8x + GPU** to:
- Detect & track all vehicles in a road video
- Estimate each car's **velocity** (km/h)
- Calculate **road width** automatically
- Show a **safe crossing timeline** (green = go, red = danger)
- **Simulate** any crossing time + walking speed

---

## 🚀 How to Run (First Time)

> **Requires:** Python 3.10+, Windows, NVIDIA GPU with CUDA

### Step 1 — Double-click `run.bat`

That's it. It will automatically:
1. Create a Python virtual environment
2. Install PyTorch with CUDA 12.1 support
3. Install all dependencies
4. Download YOLOv8x model (~130 MB, once only)
5. Start the server at **http://localhost:5000**

### Step 2 — Open your browser

Go to: **http://localhost:5000**

### Step 3 — Upload a road video

- Drag & drop any road/traffic video (MP4, AVI, MOV, MKV)
- Click **Analyse Video**
- Watch real-time detection in the live feed

### Step 4 — Read the results

| Panel | What it shows |
|---|---|
| 🎥 Live Feed | Annotated video with bounding boxes, speed, TTA |
| 📐 Road Metrics | Road width, avg/max speed, frame count |
| ⏱️ Timeline | Colour-coded safe/dangerous crossing moments |
| ✅ Top Safe Moments | Best times to cross, ranked by gap size |
| 📊 Charts | Speed distribution + vehicle count per second |

### Step 5 — Simulate your crossing

1. In the **Crossing Simulator** panel (right column):
2. Set the **time** (seconds into the video when you start crossing)
3. Set your **walking speed** (1.4 m/s = normal walk, 2.5 = jog)
4. Click **▶ Run Simulation**
5. See: SAFE ✅ / RISKY ⚠️ / DANGER 🚨 + gap to nearest car + margin

---

## 📁 Project Structure

```
road_project/
├── app.py              Flask server & API
├── detector.py         YOLOv8x + ByteTrack + velocity engine
├── road_analyzer.py    Road width + crossing window logic
├── bytetrack.yaml      Tracker configuration
├── requirements.txt    Python dependencies
├── run.bat             One-click launcher
├── static/
│   ├── index.html      Dashboard UI
│   ├── style.css       Dark glassmorphism theme
│   └── app.js          Frontend logic + charts
├── uploads/            Auto-created: uploaded videos
└── output/             Auto-created: processed output
```

---

## 🔬 How it works

### Vehicle Detection
- **YOLOv8x** (most accurate model) detects cars, trucks, buses, motorcycles, bicycles
- **ByteTrack** assigns stable IDs across frames

### Velocity Estimation
- Uses average known vehicle widths (car = 1.8m) to calibrate pixels → metres
- Computes centroid displacement across 20 frames → smooth velocity in km/h

### Road Width
- Detected car bounding box width vs known real width → metres-per-pixel scale
- `road_width_m = frame_width_px × metres_per_pixel`

### Safe Crossing
- For each second: compute **Time-To-Arrival (TTA)** of every car at the crossing line
- `TTA = distance_to_bottom / velocity_m_s`
- **Safe** if `gap > (road_width / your_speed) + 2s safety buffer`

---

## ⚙️ Manual Install (if run.bat fails)

```bat
python -m venv venv
venv\Scripts\activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
python app.py
```

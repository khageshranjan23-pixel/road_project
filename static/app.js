/**
 * app.js — RoadSafe AI frontend logic v2
 * Handles: file upload, polling, MJPEG stream, charts, timeline, simulation
 */

const API = "http://localhost:5000";

// ── Global Chart.js defaults (dark theme) ─────────────────────────────────
if (typeof Chart !== 'undefined') {
  Chart.defaults.color = '#8899b4';
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
}

// ── State ─────────────────────────────────────────────────────────────────────
let pollTimer    = null;
let velChart     = null;
let countChart   = null;
let analyticsData = null;
let crossingWindows = [];
let maxVideoTime = 120;
let simAnimId    = null;
let overlay      = null;   // CrossingOverlay instance

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone      = document.getElementById("drop-zone");
const fileInput     = document.getElementById("file-input");
const selectedFile  = document.getElementById("selected-file");
const fileNameLabel = document.getElementById("file-name-label");
const uploadBtn     = document.getElementById("upload-btn");
const progressWrap  = document.getElementById("progress-wrap");
const progressBar   = document.getElementById("progress-bar");
const progressLabel = document.getElementById("progress-label");
const statusMsg     = document.getElementById("status-msg");
const statusDot     = document.getElementById("status-dot");
const statusLabel   = document.getElementById("status-label");
const navDevice     = document.getElementById("nav-device");
const streamSrc     = document.getElementById("stream-src");       // hidden img
const videoCanvas   = document.getElementById("video-canvas");     // overlay canvas
const videoWrapper  = document.getElementById("video-wrapper");
const videoPlaceholder = document.getElementById("video-placeholder");
const timelineBar   = document.getElementById("timeline-bar");
const timelineEmpty = document.getElementById("timeline-empty");
const simResult     = document.getElementById("sim-result");
const vehiclesTbody = document.getElementById("vehicles-tbody");
const safeMomentsList = document.getElementById("safe-moments-list");
const simTimeRange  = document.getElementById("sim-time-range"); // deleted in html, but might throw error if we don't handle it
const simTime       = document.getElementById("sim-time");
const simSpeedRange = document.getElementById("sim-speed-range");
const simSpeed      = document.getElementById("sim-speed");
const simulateBtn   = document.getElementById("simulate-btn");

const processedVideo = document.getElementById("processed-video");
const crossingControls = document.getElementById("crossing-controls");
const ccSpeedRange  = document.getElementById("cc-speed-range");
const ccSpeedVal    = document.getElementById("cc-speed-val");
const resetLineBtn  = document.getElementById("reset-line-btn");
const rewindBtn     = document.getElementById("rewind-btn");
const safetyBadge   = document.getElementById("safety-badge");

// ── Drag & Drop ───────────────────────────────────────────────────────────────
dropZone.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", e => {
  e.preventDefault(); dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
dropZone.addEventListener("click", e => {
  if (e.target.tagName !== "LABEL") {
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  fileNameLabel.textContent = file.name;
  selectedFile.style.display = "flex";
  uploadBtn._pendingFile = file;
}

// ── Upload ─────────────────────────────────────────────────────────────────────
uploadBtn.addEventListener("click", async () => {
  const file = uploadBtn._pendingFile;
  if (!file) return;

  // Reset state
  resetUI();

  const fd = new FormData();
  fd.append("video", file);

  try {
    progressWrap.style.display = "flex";
    setStatus("processing", "Uploading video…");
    document.getElementById('video-wrapper').classList.add('scanning');

    const res = await fetch(`${API}/upload`, { method: "POST", body: fd });
    const data = await res.json();

    if (data.error) { setStatus("error", data.error); return; }

    setStatus("processing", "Processing with YOLO on GPU…");
    onProcessingStart();
    startStream();
    startPolling();
  } catch (err) {
    setStatus("error", "Upload failed: " + err.message);
  }
});

// ── Status polling ─────────────────────────────────────────────────────────────
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${API}/status`);
      const data = await res.json();
      updateProgress(data.progress, data.message);
      setStatus(data.status, data.message);

      // Keep frame results live for CrossingOverlay safety computation
      if (data.status === "processing" || data.status === "done") {
        fetch(`${API}/frame_results`)
          .then(r => r.json())
          .then(fr => { window._frameResults = fr || []; })
          .catch(() => {});
      }

      if (data.status === "done") {
        clearInterval(pollTimer);
        document.getElementById('video-wrapper').classList.remove('scanning');
        progressWrap.style.display = "none";
        await loadAnalytics();
        await loadCrossings();
        await loadGeometry();   // geometry last — needs analytics mpp
        onProcessingDone();
      } else if (data.status === "error") {
        clearInterval(pollTimer);
        document.getElementById('video-wrapper').classList.remove('scanning');
        progressWrap.style.display = "none";
        setStatus("error", data.error || data.message);
        onProcessingDone();
      }
    } catch (_) {}
  }, 800);
}

function updateProgress(pct, msg) {
  progressBar.style.width = pct + "%";
  progressLabel.textContent = pct + "%";
  if (msg) statusMsg.textContent = msg;
}

function setStatus(status, msg) {
  statusDot.className = "status-dot " + status;
  const labels = { idle: "Idle", processing: "Processing", done: "Done ✓", error: "Error" };
  statusLabel.textContent = labels[status] || status;
  if (msg) statusMsg.textContent = msg;
}

// ── MJPEG → Canvas stream ──────────────────────────────────────────────────
function startStream() {
  videoPlaceholder.style.display = "none";
  processedVideo.style.display   = "none";
  processedVideo.pause();
  videoCanvas.style.display      = "block";

  streamSrc.onload = () => {
    if (videoCanvas.width !== streamSrc.naturalWidth && streamSrc.naturalWidth > 0) {
      videoCanvas.width  = streamSrc.naturalWidth  || 1280;
      videoCanvas.height = streamSrc.naturalHeight || 720;
    }
  };
  streamSrc.src = `${API}/stream?t=${Date.now()}`;
}

// ── Playback Processed Video ────────────────────────────────────────────────
function playProcessedVideo() {
  streamSrc.src = "";
  streamSrc.style.display = "none";

  processedVideo.style.display = "block";
  processedVideo.controls = true; // Ensure native playback/scrubbing controls are visible
  processedVideo.src = `${API}/runs/processed.mp4?t=${Date.now()}`;
  processedVideo.play().catch(() => {}); // may fail if user hasn't interacted

  // Position the canvas on top of the video for overlay drawing
  videoCanvas.style.display = "block";
  videoCanvas.style.position = "absolute";
  videoCanvas.style.top = "0";
  videoCanvas.style.left = "0";
  videoCanvas.style.width = "100%";
  videoCanvas.style.height = "100%";
  videoCanvas.style.pointerEvents = "auto";

  // Enable click-through on bottom 45px so user can use video controls
  if (!videoWrapper._controlsHandlerAdded) {
    videoWrapper.addEventListener("mousemove", e => {
      if (processedVideo.style.display !== "block") return;
      const r = videoCanvas.getBoundingClientRect();
      const y = e.clientY - r.top;
      if (y > r.height - 45) {
        videoCanvas.style.pointerEvents = "none";
        videoCanvas.style.cursor = "default";
      } else {
        videoCanvas.style.pointerEvents = "auto";
        videoCanvas.style.cursor = "crosshair";
      }
    });
    videoWrapper._controlsHandlerAdded = true;
  }
}

// ── Global render loop (always running) ─────────────────────────────────────
(function renderLoop() {
  if (processedVideo && processedVideo.style.display === "block") {
    // Video playback mode: canvas is transparent overlay
    if (processedVideo.videoWidth > 0) {
      if (videoCanvas.width !== processedVideo.videoWidth) {
        videoCanvas.width = processedVideo.videoWidth;
        videoCanvas.height = processedVideo.videoHeight;
      }
      videoCanvas.getContext("2d").clearRect(0, 0, videoCanvas.width, videoCanvas.height);
      if (overlay) overlay.drawOverlayOnly();
    }
  } else {
    // Stream mode: paint MJPEG frame + overlay
    if (!overlay) {
      if (streamSrc.naturalWidth > 0) {
        videoCanvas.width  = streamSrc.naturalWidth;
        videoCanvas.height = streamSrc.naturalHeight;
        videoCanvas.getContext("2d").drawImage(streamSrc, 0, 0);
      }
    } else {
      overlay.draw();
    }
  }
  requestAnimationFrame(renderLoop);
})();

// ── Analytics ─────────────────────────────────────────────────────────────────
async function loadAnalytics() {
  try {
    const res = await fetch(`${API}/analytics`);
    const data = await res.json();
    analyticsData = data;
    if (overlay) overlay.setAnalytics(data);

    document.getElementById("m-road-width").textContent   = data.road_width_m ?? "—";
    document.getElementById("m-avg-vel").textContent      = data.avg_velocity  != null ? data.avg_velocity  : "—";
    document.getElementById("m-max-vel").textContent      = data.max_velocity  != null ? data.max_velocity  : "—";
    document.getElementById("m-total-frames").textContent = data.total_frames  ?? "—";
    navDevice.textContent = (data.device || "cpu").toUpperCase();

    const modelBadge = document.getElementById("badge-model");
    if (modelBadge && data.model) modelBadge.textContent = data.model.toUpperCase();

    if (data.velocity_hist && data.velocity_bins) renderVelChart(data.velocity_hist, data.velocity_bins);
    if (data.vehicle_counts) renderCountChart(data.vehicle_counts);
    if (data.total_frames && data.fps) {
      maxVideoTime = Math.ceil(data.total_frames / data.fps);
      if (simTimeRange) simTimeRange.max = maxVideoTime;
      if (simTime) simTime.max = maxVideoTime;
    }
  } catch (err) { console.error("Analytics load error:", err); }
}

// ── Geometry (load after processing done) ────────────────────────────────────
async function loadGeometry() {
  try {
    const res = await fetch(`${API}/geometry`);
    if (!res.ok) return;
    const geo = await res.json();

    // Create overlay if needed (it may not exist yet when stream didn't load)
    if (!overlay) {
      overlay = new CrossingOverlay(videoCanvas, streamSrc, analyticsData);
    }

    // If multiple roads detected, ask user to pick
    if (geo.roads && geo.roads.length > 1) {
      overlay.setGeometry(geo, null); // don't select a road yet
      overlay.showRoadPicker(geo.roads);
    } else {
      overlay.setGeometry(geo, 0); // select the only road
    }

    // Switch to processed video playback
    playProcessedVideo();

    // Show crossing controls
    crossingControls.style.display = "flex";
  } catch (err) { console.error("Geometry load error:", err); }
}

// ── Crossings ─────────────────────────────────────────────────────────────────
async function loadCrossings() {
  try {
    const res = await fetch(`${API}/crossings`);
    const data = await res.json();
    crossingWindows = data.windows || [];
    renderTimeline(crossingWindows);
    renderSafeMoments(crossingWindows);
  } catch (err) { console.error("Crossings load error:", err); }
}

// ── Timeline Renderer ─────────────────────────────────────────────────────────
function renderTimeline(windows) {
  timelineEmpty.style.display = "none";
  timelineBar.innerHTML = "";

  windows.forEach(w => {
    const seg = document.createElement("div");
    let cls = "t-seg ";
    if (w.safe) cls += "safe";
    else if (w.min_tta !== null && w.min_tta < 2) cls += "danger";
    else cls += "risky";

    seg.className = cls;
    seg.title = `${w.second}s: ${w.reason}`;

    // Tooltip
    const tip = document.createElement("div");
    tip.className = "t-seg-tooltip";
    tip.textContent = `T=${w.second}s • ${w.reason.substring(0, 40)}`;
    seg.appendChild(tip);

    // Click to seek video to that time
    seg.addEventListener("click", () => {
      if (processedVideo && processedVideo.style.display === "block") {
        processedVideo.currentTime = w.second;
      }
    });

    timelineBar.appendChild(seg);
  });
}

// ── Safe Moments List ─────────────────────────────────────────────────────────
function renderSafeMoments(windows) {
  const safe = windows.filter(w => w.safe);
  if (safe.length === 0) {
    safeMomentsList.innerHTML = '<div class="empty-state">No clearly safe windows found.</div>';
    return;
  }
  // Sort by gap (descending = most safe first)
  const sorted = [...safe].sort((a, b) => (b.gap || 0) - (a.gap || 0)).slice(0, 8);
  safeMomentsList.innerHTML = sorted.map(w => `
    <div class="safe-moment-item" onclick="fillSimTime(${w.second})">
      <span class="sm-time">${w.second}s</span>
      <span class="sm-info">${w.reason}</span>
      <span class="sm-gap">${w.gap ? w.gap.toFixed(1) + 's gap' : 'clear'}</span>
    </div>
  `).join("");
}

function fillSimTime(t) {
  if (processedVideo && processedVideo.style.display === "block") {
    processedVideo.currentTime = t;
  }
}

// ── Chart: Velocity Distribution ──────────────────────────────────────────────
function renderVelChart(hist, bins) {
  const labels = bins.slice(0, -1).map((b, i) => `${b.toFixed(0)}-${bins[i+1].toFixed(0)}`);
  const ctx = document.getElementById("vel-chart").getContext("2d");

  if (velChart) velChart.destroy();
  velChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Count",
        data: hist,
        backgroundColor: "rgba(91,141,238,0.6)",
        borderColor: "rgba(91,141,238,0.9)",
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `${items[0].label} km/h`,
            label: (item) => `${item.raw} detections`,
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#4b5a72", font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
        y: {
          ticks: { color: "#4b5a72", font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.06)" },
        }
      }
    }
  });
}

// ── Chart: Vehicle Count / Second ─────────────────────────────────────────────
function renderCountChart(counts) {
  const labels = counts.map(c => c.second + "s");
  const data   = counts.map(c => c.count);

  const ctx = document.getElementById("count-chart").getContext("2d");
  if (countChart) countChart.destroy();
  countChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Vehicles",
        data,
        borderColor: "#10d971",
        backgroundColor: "rgba(16,217,113,0.08)",
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 2,
        pointHoverRadius: 5,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#4b5a72", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.04)" } },
        y: { ticks: { color: "#4b5a72", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.06)" }, min: 0 },
      }
    }
  });
}

// ── Simulation ────────────────────────────────────────────────────────────────

// Sync range ↔ number inputs
if (simTimeRange && simTime) {
  simTimeRange.addEventListener("input",  () => simTime.value  = simTimeRange.value);
  simTime.addEventListener("input",       () => simTimeRange.value = simTime.value);
}
if (simSpeedRange && simSpeed) {
  simSpeedRange.addEventListener("input", () => simSpeed.value = simSpeedRange.value);
  simSpeed.addEventListener("input",      () => simSpeedRange.value = simSpeed.value);
}

if (simulateBtn) {
  simulateBtn.addEventListener("click", async () => {
    const t = simTime ? parseFloat(simTime.value) : 0;
    const s = simSpeed ? parseFloat(simSpeed.value) : 1.4;
    if (isNaN(t) || isNaN(s)) return;

    simulateBtn.textContent = "⏳ Simulating…";
    simulateBtn.disabled = true;
    try {
      const res = await fetch(`${API}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          time: t,
          speed: s,
          crossing_y_frac: overlay ? (overlay.lineY / overlay.canvas.height) : 0.5,
          geometry: overlay ? overlay.geo : null,
          selected_road_index: overlay ? overlay.selectedRoad : 0
        })
      });
      const data = await res.json();
      if (data.error) { alert(data.error); return; }
      displaySimResult(data);
    } catch (err) {
      alert("Simulation error: " + err.message);
    } finally {
      simulateBtn.textContent = "▶ Run Simulation";
      simulateBtn.disabled = false;
    }
  });
}

function displaySimResult(data) {
  simResult.style.display = "block";

  const banner   = document.getElementById("result-banner");
  const icon     = document.getElementById("result-icon");
  const title    = document.getElementById("result-title");
  const sub      = document.getElementById("result-sub");
  const rec      = document.getElementById("result-rec");
  const crossT   = document.getElementById("rs-cross-time");
  const gap      = document.getElementById("rs-gap");
  const margin   = document.getElementById("rs-margin");
  const nearest  = document.getElementById("rs-nearest");

  // Determine safety metrics from the new simulated vehicles and collisions
  const isSafe = data.safe;
  
  // Calculate minArrival time of oncoming vehicles
  const arrivals = data.simulated_vehicles.map(v => v.t_arrival).filter(t => t > 0);
  const minArrival = arrivals.length > 0 ? Math.min(...arrivals) : null;
  const minMargin = minArrival !== null ? minArrival - data.cross_time : 99.0;
  
  const isRisky = isSafe && (minMargin < 2.0);
  const isDanger = !isSafe;

  banner.className = "result-banner " + (isSafe ? (isRisky ? "risky" : "safe") : "danger");

  if (isDanger) {
    icon.textContent  = "🚨";
    title.textContent = "COLLISION DANGER";
    title.style.color = "var(--red)";
  } else if (isRisky) {
    icon.textContent  = "⚠️";
    title.textContent = "RISKY CROSSING";
    title.style.color = "var(--yellow)";
  } else {
    icon.textContent  = "✅";
    title.textContent = "SAFE TO CROSS";
    title.style.color = "var(--green)";
  }

  sub.textContent = data.result;
  rec.textContent = "💡 " + data.recommendation;

  crossT.textContent  = data.cross_time != null ? data.cross_time.toFixed(2) + " s" : "—";
  gap.textContent     = minArrival !== null ? minArrival.toFixed(2) + " s" : "clear";
  margin.textContent  = minMargin !== 99.0
    ? (minMargin > 0 ? "+" : "") + minMargin.toFixed(2) + " s"
    : "—";

  // Find nearest vehicle
  const oncoming = data.simulated_vehicles.filter(v => v.t_arrival > 0);
  oncoming.sort((a,b) => a.t_arrival - b.t_arrival);
  const nearestCar = oncoming[0] || null;

  if (nearestCar) {
    nearest.textContent = `#${nearestCar.id} ${nearestCar.class} (Lane ${nearestCar.lane}) @ ${nearestCar.velocity_kmh}km/h`;
  } else {
    nearest.textContent = "None";
  }

  // Render simulated vehicles table
  const simVehicles = data.simulated_vehicles || [];
  if (simVehicles.length === 0) {
    vehiclesTbody.innerHTML = '<tr><td colspan="6" class="table-empty">No vehicles near crossing</td></tr>';
  } else {
    vehiclesTbody.innerHTML = simVehicles.map(v => {
      const dangerClass = v.t_arrival < 3 ? "text-red" : v.t_arrival < 6 ? "text-yellow" : "text-green";
      const statusText = v.collision ? "💥 COLLISION" : "✓ Safe";
      const statusClass = v.collision ? "text-red" : "text-green";
      return `<tr>
        <td>#${v.id}</td>
        <td>${v.class}</td>
        <td>Lane ${v.lane}</td>
        <td>${v.velocity_kmh} km/h</td>
        <td class="${dangerClass}">${v.t_arrival > 0 ? v.t_arrival.toFixed(2) + "s" : "passed"}</td>
        <td class="${statusClass}" style="font-weight: bold;">${statusText}</td>
      </tr>`;
    }).join("");
  }

  // Run visual canvas animation
  runSimAnimation(data);

  // Scroll to result
  simResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function runSimAnimation(data) {
  const canvas = document.getElementById("sim-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  
  if (simAnimId) {
    cancelAnimationFrame(simAnimId);
  }
  
  const width = canvas.width;
  const height = canvas.height;
  const numLanes = data.num_lanes || 3;
  const laneHeight = height / numLanes;
  const crossingX = 120; // Pedestrian crosses vertically at x = 120
  const scale = 10; // Pixels per meter
  
  let t = 0;
  const dt = 0.016; // ~60 FPS step
  const crossTime = data.cross_time;
  const pedSpeed = data.ped_speed;
  const roadWidth = data.road_width_m;
  const vehicles = data.simulated_vehicles || [];
  
  let collisionTime = null;
  let collisionLane = null;
  if (data.collisions && data.collisions.length > 0) {
    collisionTime = data.collisions[0].time;
    collisionLane = data.collisions[0].lane;
  }
  
  function draw() {
    // 1. Draw Road Background
    ctx.fillStyle = "#111625";
    ctx.fillRect(0, 0, width, height);
    
    // Draw Lane Dividers
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 2;
    for (let i = 1; i < numLanes; i++) {
      ctx.beginPath();
      ctx.setLineDash([8, 8]);
      ctx.moveTo(0, i * laneHeight);
      ctx.lineTo(width, i * laneHeight);
      ctx.stroke();
    }
    ctx.setLineDash([]); // Reset dash
    
    // Draw Crossing Stripes (Zebra Crossing)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 14;
    for (let y = 6; y < height; y += 18) {
      ctx.beginPath();
      ctx.moveTo(crossingX - 10, y);
      ctx.lineTo(crossingX + 10, y);
      ctx.stroke();
    }
    
    // Draw Lane Labels
    ctx.fillStyle = "rgba(136, 153, 180, 0.3)";
    ctx.font = "9px 'JetBrains Mono', monospace";
    for (let i = 1; i <= numLanes; i++) {
      ctx.fillText(`LANE ${i}`, 15, height - (i - 0.5) * laneHeight + 3);
    }
    
    // Draw Vehicles
    vehicles.forEach(v => {
      const velMs = (v.velocity_kmh / 3.6);
      // Position calculated from current simulated time step
      const currentDist = v.init_dist_m - velMs * t;
      const x = crossingX + currentDist * scale;
      const y = height - (v.lane - 0.5) * laneHeight; // vertical center of lane
      
      const vLen = (v.class === "car" || v.class === "truck" || v.class === "bus") ? 4.5 : 2.2;
      const wPx = vLen * scale;
      const hPx = laneHeight * 0.5;
      
      // Vehicle color scheme
      let color = "rgba(91, 141, 238, 0.8)"; // Blue for normal vehicles
      if (v.class === "motorcycle" || v.class === "bicycle") {
        color = "rgba(245, 158, 11, 0.8)"; // Orange for two-wheelers
      } else if (v.class === "truck" || v.class === "bus") {
        color = "rgba(167, 139, 250, 0.8)"; // Violet for large vehicles
      }
      
      // Check if vehicle is currently colliding in the active window
      const isCollidingNow = v.collision && t >= v.t_enter && t <= v.t_exit;
      if (isCollidingNow) {
        color = `rgba(244, 63, 94, ${Math.floor(Date.now() / 150) % 2 ? 0.9 : 0.4})`; // Blinking Red
      }
      
      ctx.fillStyle = color;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y - hPx / 2, wPx, hPx, 4);
        ctx.fill();
      } else {
        ctx.fillRect(x, y - hPx / 2, wPx, hPx);
      }
      
      // Draw label
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 8px system-ui";
      ctx.fillText(`#${v.id}`, x + 3, y + 2.5);
    });
    
    // Draw Pedestrian (YOU)
    let pedY = height;
    let collided = false;
    let pedActive = true;
    
    if (collisionTime !== null && t >= collisionTime) {
      const colPedY = height - (collisionTime / crossTime) * height;
      pedY = colPedY;
      collided = true;
    } else if (t >= crossTime) {
      pedY = 0;
      pedActive = false;
    } else {
      pedY = height - (t / crossTime) * height;
    }
    
    // Glowing effect
    ctx.shadowBlur = 12;
    ctx.shadowColor = collided ? "rgba(244, 63, 94, 0.85)" : "rgba(16, 217, 113, 0.85)";
    ctx.fillStyle = collided ? "#f43f5e" : "#10d971";
    ctx.beginPath();
    ctx.arc(crossingX, pedY, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0; // Reset shadow
    
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 9px system-ui";
    ctx.fillText("YOU", crossingX + 12, pedY + 3);
    
    // 3. Draw Simulation Timer & Status Header
    ctx.fillStyle = "rgba(10, 15, 30, 0.85)";
    ctx.fillRect(0, 0, width, 24);
    
    ctx.fillStyle = "#8899b4";
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillText(`TIME: ${t.toFixed(2)}s / ${crossTime.toFixed(1)}s`, 10, 16);
    
    if (collided) {
      ctx.fillStyle = "#f43f5e";
      ctx.font = "bold 10px system-ui";
      ctx.fillText("💥 COLLISION!", width - 95, 16);
    } else if (!pedActive) {
      ctx.fillStyle = "#10d971";
      ctx.font = "bold 10px system-ui";
      ctx.fillText("✅ SUCCESS!", width - 85, 16);
    } else {
      ctx.fillStyle = "#5b8dee";
      ctx.font = "bold 10px system-ui";
      ctx.fillText("🚶 WALKING...", width - 90, 16);
    }
    
    // Increment time
    t += dt;
    
    // Continue loop until pedestrian finishes crossing or hit
    if (t < crossTime + 1.2 && (!collided || t < collisionTime + 0.8)) {
      simAnimId = requestAnimationFrame(draw);
    }
  }
  
  draw();
}

function resetUI() {
  progressBar.style.width = "0%";
  progressLabel.textContent = "0%";
  statusMsg.textContent = "";
  timelineBar.innerHTML = "";
  timelineEmpty.style.display = "block";
  timelineEmpty.textContent = "Awaiting analysis...";
  safeMomentsList.innerHTML = '<div class="empty-state">Awaiting analysis...</div>';
  simResult.style.display = "none";
  vehiclesTbody.innerHTML = '<tr><td colspan="6" class="table-empty">Run simulation first</td></tr>';
  ["m-road-width","m-avg-vel","m-max-vel","m-total-frames"].forEach(id => {
    document.getElementById(id).textContent = "—";
  });
  if (velChart)  { velChart.destroy();  velChart  = null; }
  if (countChart){ countChart.destroy(); countChart = null; }
  analyticsData   = null;
  crossingWindows = [];
  window._frameResults = [];
  overlay = null;
  crossingControls.style.display = "none";
  const vb = document.getElementById("badge-view");
  if (vb) vb.style.display = "none";

  if (simAnimId) { cancelAnimationFrame(simAnimId); simAnimId = null; }
  if (videoCanvas) {
    videoCanvas.style.display = "none";
    videoCanvas.getContext("2d").clearRect(0, 0, videoCanvas.width, videoCanvas.height);
  }
  const canvas = document.getElementById("sim-canvas");
  if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

// ── Keyboard shortcut: Enter to cross ────────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && document.activeElement !== uploadBtn) {
    if (crossBtn && !crossBtn.disabled) crossBtn.click();
  }
});

// ── Crossing controls DOM refs ────────────────────────────────────────────────
const crossBtn     = document.getElementById("cross-btn");
const processingLock = document.getElementById("processing-lock");

// Speed slider ↔ number input sync
ccSpeedRange.addEventListener("input", () => {
  ccSpeedVal.value = ccSpeedRange.value;
  if (overlay) overlay.pedSpeed = parseFloat(ccSpeedRange.value);
});
ccSpeedVal.addEventListener("input", () => {
  ccSpeedRange.value = ccSpeedVal.value;
  if (overlay) overlay.pedSpeed = parseFloat(ccSpeedVal.value);
});
resetLineBtn.addEventListener("click", () => { if (overlay) overlay.resetLine(); });
if (rewindBtn) {
  rewindBtn.addEventListener("click", () => {
    if (processedVideo && processedVideo.style.display === "block") {
      processedVideo.currentTime = 0;
      processedVideo.play().catch(() => {});
    }
  });
}

// CROSS button → run simulation at current crossing line position
crossBtn && crossBtn.addEventListener("click", async () => {
  if (!overlay || !analyticsData) return;
  crossBtn.textContent = "⏳ Analysing…";
  crossBtn.disabled = true;
  try {
    // Get current playback time of the video (fallback to 0)
    const t = (processedVideo && processedVideo.style.display === "block") 
      ? processedVideo.currentTime 
      : 0;
    const s = overlay.pedSpeed;
    const yFrac = overlay.lineY / overlay.canvas.height;
    const res = await fetch(`${API}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        time: t,
        speed: s,
        crossing_y_frac: yFrac,
        geometry: overlay.geo,
        selected_road_index: overlay.selectedRoad
      }),
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    displaySimResult(data);
    simResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    alert("Simulation error: " + err.message);
  } finally {
    crossBtn.textContent = "🚶 CROSS NOW";
    crossBtn.disabled = false;
  }
});

// Show processing lock while video is processing
function showProcessingLock(show) {
  if (!processingLock) return;
  processingLock.style.display = show ? "flex" : "none";
}

// Called when processing starts
function onProcessingStart() {
  showProcessingLock(true);
  crossingControls.style.display = "none";
}

// Called when processing is done
function onProcessingDone() {
  showProcessingLock(false);
}

window._frameResults = [];

// ══════════════════════════════════════════════════════════════════════════════
// CrossingOverlay — road boundary lines + draggable crossing segment
// ══════════════════════════════════════════════════════════════════════════════
class CrossingOverlay {
  constructor(canvas, srcImg, analytics) {
    this.canvas    = canvas;
    this.ctx       = canvas.getContext("2d");
    this.src       = srcImg;
    this.analytics = analytics || {};
    this.geo       = null;
    this.selectedRoad = null;  // index into geo.roads[]
    this.pedSpeed  = 1.4;
    this.lineYFrac = null;
    this._drag     = false;
    this._dragOffY = 0;
    this._dragHandle = null;
    this._tick     = 0;
    this._locked   = true;
    this._roadPickerActive = false;
    this._bindEvents();
  }

  get lineY() {
    if (this.lineYFrac === null) return null;
    return this.lineYFrac * this.canvas.height;
  }

  set lineY(val) {
    if (val === null) {
      this.lineYFrac = null;
    } else {
      const h = this.canvas.height || 720;
      this.lineYFrac = val / h;
    }
  }

  setAnalytics(a) { this.analytics = a; }

  setGeometry(geo, roadIdx) {
    this.geo = geo;
    if (roadIdx !== null && roadIdx !== undefined) {
      this.selectedRoad = roadIdx;
      this._locked = false;
      this._roadPickerActive = false;
      this.resetLine();
    }
  }

  selectRoad(idx) {
    this.selectedRoad = idx;
    this._locked = false;
    this._roadPickerActive = false;
    this.resetLine();
  }

  showRoadPicker() {
    this._roadPickerActive = true;
    this._locked = false;
  }

  resetLine() {
    if (!this.geo || this.selectedRoad === null) return;
    const sh = this.canvas.height / (this.geo.frame_height || this.canvas.height);
    this.lineY = Math.round(this.geo.default_crossing_y * sh);
  }

  _road() {
    if (!this.geo || !this.geo.roads || this.selectedRoad === null) return null;
    return this.geo.roads[this.selectedRoad] || null;
  }

  _edgesAt(canvasY) {
    const road = this._road();
    if (!road || !this.geo) return [0, this.canvas.width];
    const sw = this.canvas.width  / (this.geo.frame_width  || this.canvas.width);
    const sh = this.canvas.height / (this.geo.frame_height || this.canvas.height);
    const [[lxb, lyb], [lxt, lyt]] = road.left_line.map(([x, y]) => [x * sw, y * sh]);
    const [[rxb, ryb], [rxt, ryt]] = road.right_line.map(([x, y]) => [x * sw, y * sh]);
    const tL = Math.abs(lyb - lyt) < 1 ? 0 : (canvasY - lyb) / (lyt - lyb);
    const tR = Math.abs(ryb - ryt) < 1 ? 0 : (canvasY - ryb) / (ryt - ryb);
    return [Math.round(lxb + tL * (lxt - lxb)), Math.round(rxb + tR * (rxt - rxb))];
  }

  _minY() {
    if (!this.geo) return 0;
    const sh = this.canvas.height / (this.geo.frame_height || this.canvas.height);
    return Math.round(this.geo.road_top_y * sh) + 4;
  }

  _safety() {
    const frs = window._frameResults;
    if (!frs || !frs.length || !this.geo || this.lineY === null) return null;
    const mpp = this.analytics.mpp || 0.008;
    const sh  = this.canvas.height / (this.geo.frame_height || this.canvas.height);
    const lineY_vid = this.lineY / sh;
    const roadW  = this.analytics.road_width_m || 7;
    const crossT = roadW / this.pedSpeed;
    const latest = frs[frs.length - 1];
    if (!latest || !latest.vehicles) return null;
    const threats = [];
    for (const v of latest.vehicles) {
      if (!v.velocity_kmh || v.velocity_kmh < 1) continue;
      const [, cy] = v.centroid;
      const distPx = cy - lineY_vid;
      if (distPx <= 0) continue;
      const distM = distPx * mpp;
      const tta   = distM / (v.velocity_kmh / 3.6);
      threats.push({ id: v.id, cls: v.class, vel: v.velocity_kmh, tta, distM });
    }
    if (!threats.length) return { status: "safe", threats: [], crossT };
    const minTTA = Math.min(...threats.map(t => t.tta));
    const status = minTTA <= crossT ? "danger" : minTTA <= crossT + 2 ? "risky" : "safe";
    return { status, threats, minTTA, crossT };
  }

  drawOverlayOnly() {
    const c = this.canvas, ctx = this.ctx;
    this._tick++;
    if (!this.geo) return;
    const sw  = c.width  / (this.geo.frame_width  || c.width);
    const sh  = c.height / (this.geo.frame_height || c.height);
    const topY    = Math.round(this.geo.road_top_y * sh);
    const bottomY = c.height;

    // Draw ALL road edge lines
    const ROAD_COLORS = ["rgba(240,220,60,0.85)", "rgba(60,180,240,0.85)"];
    for (let ri = 0; ri < this.geo.roads.length; ri++) {
      const road = this.geo.roads[ri];
      const col = ROAD_COLORS[ri % ROAD_COLORS.length];
      const [[lxb], [lxt]] = road.left_line.map(([x, y]) => [x * sw]);
      const [[rxb], [rxt]] = road.right_line.map(([x, y]) => [x * sw]);
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = ri === this.selectedRoad ? 3 : 1.5;
      ctx.shadowColor = col;
      ctx.shadowBlur = ri === this.selectedRoad ? 8 : 0;
      ctx.beginPath(); ctx.moveTo(lxb, bottomY); ctx.lineTo(lxt, topY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rxb, bottomY); ctx.lineTo(rxt, topY); ctx.stroke();
      ctx.shadowBlur = 0;
      const mx = (lxb + rxb) / 2;
      ctx.font = "bold 13px 'Inter', sans-serif";
      ctx.fillStyle = col;
      ctx.textAlign = "center";
      if (this.geo.roads.length > 1) ctx.fillText("Road " + (ri + 1), mx, bottomY - 8);
      ctx.textAlign = "left";
      if (ri === this.selectedRoad) {
        const handles = [
          { x: lxt, y: topY },
          { x: lxb, y: bottomY },
          { x: rxt, y: topY },
          { x: rxb, y: bottomY }
        ];
        for (const h of handles) {
          ctx.beginPath();
          ctx.arc(h.x, h.y, 8, 0, Math.PI * 2);
          ctx.fillStyle = "#ffffff";
          ctx.fill();
          ctx.strokeStyle = col;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Road picker prompt
    if (this._roadPickerActive && this.selectedRoad === null) {
      ctx.save();
      ctx.font = "bold 18px 'Inter', sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(c.width / 2 - 180, c.height / 2 - 22, 360, 40);
      ctx.fillStyle = "#f59e0b";
      ctx.fillText("Click on the road you want to cross", c.width / 2, c.height / 2 + 5);
      ctx.textAlign = "left";
      ctx.restore();
      return;
    }

    if (this.selectedRoad === null || this.lineY === null) return;

    const lineY = Math.max(this._minY(), Math.min(bottomY - 2, this.lineY));
    const [lx, rx] = this._edgesAt(lineY);
    const safety = this._safety();
    const status = safety ? safety.status : "positioned";
    const COLOR  = { safe: "#10d971", risky: "#f59e0b", danger: "#f43f5e", positioned: "#5b8dee" };
    const LABEL  = { safe: "✅ SAFE TO CROSS", risky: "⚠️ RISKY — Walk fast", danger: "🚨 DANGER — DO NOT CROSS", positioned: "Drag line · then click CROSS" };
    let col = COLOR[status];
    if (status === "danger" && Math.floor(this._tick / 8) % 2) col = "#ff8fa3";
    if (status === "risky"  && Math.floor(this._tick / 16) % 2) col = "#fcd34d";

    ctx.save();
    ctx.shadowColor = col; ctx.shadowBlur = 18;
    ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(lx, lineY); ctx.lineTo(rx, lineY); ctx.stroke();
    ctx.shadowBlur = 0; ctx.restore();

    for (const hx of [lx, rx]) {
      ctx.beginPath(); ctx.arc(hx, lineY, 7, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
    }
    const mx = (lx + rx) / 2;
    ctx.beginPath(); ctx.arc(mx, lineY, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#fff"; ctx.fill();

    ctx.font = "bold 12px 'Inter', sans-serif";
    const tw = ctx.measureText(LABEL[status]).width;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(mx - tw / 2 - 6, lineY - 26, tw + 12, 18);
    ctx.fillStyle = col;
    ctx.fillText(LABEL[status], mx - tw / 2, lineY - 12);

    if (safety && safety.threats.length) {
      ctx.font = "10px 'JetBrains Mono', monospace";
      safety.threats.forEach((t, i) => {
        ctx.fillStyle = t.tta < safety.crossT ? "#f43f5e" : "#fcd34d";
        ctx.fillText(`#${t.id} ${t.cls} ${t.vel.toFixed(0)}km/h  TTA:${t.tta.toFixed(1)}s`,
                     lx + 4, lineY + 14 + i * 13);
      });
    }

    if (typeof safetyBadge !== "undefined" && safetyBadge) {
      safetyBadge.textContent = LABEL[status];
      safetyBadge.className   = "safety-badge " + status;
    }
  }

  draw() {
    const c = this.canvas, ctx = this.ctx;
    if (this.src.naturalWidth > 0) {
      if (c.width !== this.src.naturalWidth) {
        c.width  = this.src.naturalWidth;
        c.height = this.src.naturalHeight;
        if (this.geo && this.selectedRoad !== null) this.resetLine();
      }
      ctx.drawImage(this.src, 0, 0);
    } else { return; }

    if (this._locked) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.font = "bold 22px 'Inter', sans-serif";
      ctx.fillStyle = "#f59e0b";
      ctx.textAlign = "center";
      ctx.fillText("⏳ Processing — please wait", c.width / 2, c.height / 2 - 14);
      ctx.font = "14px 'Inter', sans-serif";
      ctx.fillStyle = "#8899b4";
      ctx.fillText("Crossing controls will unlock when done", c.width / 2, c.height / 2 + 16);
      ctx.textAlign = "left";
      return;
    }
    this.drawOverlayOnly();
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener("mousedown",  e => this._onDown(e));
    c.addEventListener("mousemove",  e => this._onMove(e));
    c.addEventListener("mouseup",    () => { this._drag = false; this._dragHandle = null; c.style.cursor = "crosshair"; });
    c.addEventListener("mouseleave", () => { this._drag = false; this._dragHandle = null; c.style.cursor = "crosshair"; });
    c.addEventListener("touchstart", e => { e.preventDefault(); this._onDown(e.touches[0]); }, { passive: false });
    c.addEventListener("touchmove",  e => { e.preventDefault(); this._onMove(e.touches[0]); }, { passive: false });
    c.addEventListener("touchend",   () => { this._drag = false; this._dragHandle = null; });
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (this.canvas.width  / r.width),
      y: (e.clientY - r.top)  * (this.canvas.height / r.height),
    };
  }

  _onDown(e) {
    const { x, y } = this._pos(e);

    // Road picker: click to select
    if (this._roadPickerActive && this.selectedRoad === null && this.geo) {
      const sw = this.canvas.width / (this.geo.frame_width || this.canvas.width);
      const sh = this.canvas.height / (this.geo.frame_height || this.canvas.height);
      for (let ri = 0; ri < this.geo.roads.length; ri++) {
        const road = this.geo.roads[ri];
        const lxb = road.left_line[0][0] * sw, lxt = road.left_line[1][0] * sw;
        const rxb = road.right_line[0][0] * sw, rxt = road.right_line[1][0] * sw;
        const topY = this.geo.road_top_y * sh;
        const botY = this.canvas.height;
        const t = Math.abs(botY - topY) < 1 ? 0 : (y - botY) / (topY - botY);
        const leftAtY  = lxb + t * (lxt - lxb);
        const rightAtY = rxb + t * (rxt - rxb);
        if (x >= leftAtY && x <= rightAtY) {
          this.selectRoad(ri);
          return;
        }
      }
      return;
    }

    if (this._locked) return;

    // Check if clicked near road boundary handles
    if (this.selectedRoad !== null && this.geo) {
      const road = this._road();
      if (road) {
        const sw = this.canvas.width / (this.geo.frame_width || this.canvas.width);
        const sh = this.canvas.height / (this.geo.frame_height || this.canvas.height);
        const topY = Math.round(this.geo.road_top_y * sh);
        const bottomY = this.canvas.height;

        const lxb = road.left_line[0][0] * sw;
        const lxt = road.left_line[1][0] * sw;
        const rxb = road.right_line[0][0] * sw;
        const rxt = road.right_line[1][0] * sw;

        const handles = [
          { x: lxt, y: topY, id: "LT" },
          { x: lxb, y: bottomY, id: "LB" },
          { x: rxt, y: topY, id: "RT" },
          { x: rxb, y: bottomY, id: "RB" }
        ];

        for (const h of handles) {
          if (Math.hypot(x - h.x, y - h.y) < 18) {
            this._dragHandle = h.id;
            return;
          }
        }
      }
    }

    // Drag crossing line
    if (this.lineY !== null && Math.abs(y - this.lineY) < 16) {
      this._drag = true;
      this._dragOffY = y - this.lineY;
    }
  }

  _onMove(e) {
    const { x, y } = this._pos(e);

    // If dragging road handle
    if (this._dragHandle) {
      const road = this._road();
      if (road) {
        const sw = this.canvas.width / (this.geo.frame_width || this.canvas.width);
        const srcX = Math.max(0, Math.min((this.geo.frame_width || this.canvas.width) - 1, Math.round(x / sw)));

        if (this._dragHandle === "LT") {
          road.left_line[1][0] = srcX;
        } else if (this._dragHandle === "LB") {
          road.left_line[0][0] = srcX;
        } else if (this._dragHandle === "RT") {
          road.right_line[1][0] = srcX;
        } else if (this._dragHandle === "RB") {
          road.right_line[0][0] = srcX;
        }
        this.canvas.style.cursor = "ew-resize";
        return;
      }
    }

    // If dragging crossing line
    if (this._drag) {
      const newY = y - this._dragOffY;
      this.lineY = Math.max(this._minY(), Math.min(this.canvas.height - 2, newY));
      this.canvas.style.cursor = "ns-resize";
      return;
    }

    // Hover styling
    if (this._locked) return;
    
    // Check road handle hovers
    if (this.selectedRoad !== null && this.geo) {
      const road = this._road();
      if (road) {
        const sw = this.canvas.width / (this.geo.frame_width || this.canvas.width);
        const sh = this.canvas.height / (this.geo.frame_height || this.canvas.height);
        const topY = Math.round(this.geo.road_top_y * sh);
        const bottomY = this.canvas.height;
        
        const lxb = road.left_line[0][0] * sw;
        const lxt = road.left_line[1][0] * sw;
        const rxb = road.right_line[0][0] * sw;
        const rxt = road.right_line[1][0] * sw;

        const handles = [
          { x: lxt, y: topY },
          { x: lxb, y: bottomY },
          { x: rxt, y: topY },
          { x: rxb, y: bottomY }
        ];

        for (const h of handles) {
          if (Math.hypot(x - h.x, y - h.y) < 18) {
            this.canvas.style.cursor = "ew-resize";
            return;
          }
        }
      }
    }

    // Check crossing line hover
    if (this.lineY !== null && Math.abs(y - this.lineY) < 16) {
      this.canvas.style.cursor = "ns-resize";
    } else {
      this.canvas.style.cursor = "crosshair";
    }
  }
}

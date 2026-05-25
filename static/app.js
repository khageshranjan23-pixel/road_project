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
let pollTimer = null;
let velChart = null;
let countChart = null;
let analyticsData = null;
let crossingWindows = [];
let maxVideoTime = 120;
let simAnimId = null;

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
const streamImg     = document.getElementById("stream-img");
const videoPlaceholder = document.getElementById("video-placeholder");
const timelineBar   = document.getElementById("timeline-bar");
const timelineEmpty = document.getElementById("timeline-empty");
const simResult     = document.getElementById("sim-result");
const vehiclesTbody = document.getElementById("vehicles-tbody");
const safeMomentsList = document.getElementById("safe-moments-list");
const simTimeRange  = document.getElementById("sim-time-range");
const simTime       = document.getElementById("sim-time");
const simSpeedRange = document.getElementById("sim-speed-range");
const simSpeed      = document.getElementById("sim-speed");
const simulateBtn   = document.getElementById("simulate-btn");

// ── Drag & Drop ───────────────────────────────────────────────────────────────
dropZone.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", e => {
  e.preventDefault(); dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
dropZone.addEventListener("click", () => fileInput.click());
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

      if (data.status === "done") {
        clearInterval(pollTimer);
        document.getElementById('video-wrapper').classList.remove('scanning');
        await loadAnalytics();
        await loadCrossings();
      } else if (data.status === "error") {
        clearInterval(pollTimer);
        document.getElementById('video-wrapper').classList.remove('scanning');
        setStatus("error", data.error || data.message);
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

// ── MJPEG Stream ──────────────────────────────────────────────────────────────
function startStream() {
  videoPlaceholder.style.display = "none";
  streamImg.style.display = "block";
  streamImg.src = `${API}/stream?t=${Date.now()}`;
}

// ── Analytics ─────────────────────────────────────────────────────────────────
async function loadAnalytics() {
  try {
    const res = await fetch(`${API}/analytics`);
    const data = await res.json();
    analyticsData = data;

    // Update metrics
    document.getElementById("m-road-width").textContent   = data.road_width_m ?? "—";
    document.getElementById("m-avg-vel").textContent      = data.avg_velocity  != null ? data.avg_velocity  : "—";
    document.getElementById("m-max-vel").textContent      = data.max_velocity  != null ? data.max_velocity  : "—";
    document.getElementById("m-total-frames").textContent = data.total_frames  ?? "—";

    // Nav device
    navDevice.textContent = (data.device || "cpu").toUpperCase();

    // Model badge
    const modelBadge = document.getElementById("badge-model");
    if (modelBadge && data.model) {
      modelBadge.textContent = data.model.toUpperCase();
    }

    // Velocity chart
    if (data.velocity_hist && data.velocity_bins) {
      renderVelChart(data.velocity_hist, data.velocity_bins);
    }

    // Count chart
    if (data.vehicle_counts) {
      renderCountChart(data.vehicle_counts);
    }

    // Update slider max
    if (data.total_frames && data.fps) {
      maxVideoTime = Math.ceil(data.total_frames / data.fps);
      simTimeRange.max = maxVideoTime;
      simTime.max = maxVideoTime;
    }

  } catch (err) { console.error("Analytics load error:", err); }
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

    // Click to fill simulator time
    seg.addEventListener("click", () => {
      simTime.value = w.second;
      simTimeRange.value = w.second;
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
  simTime.value = t;
  simTimeRange.value = t;
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
simTimeRange.addEventListener("input",  () => simTime.value  = simTimeRange.value);
simTime.addEventListener("input",       () => simTimeRange.value = simTime.value);
simSpeedRange.addEventListener("input", () => simSpeed.value = simSpeedRange.value);
simSpeed.addEventListener("input",      () => simSpeedRange.value = simSpeed.value);

simulateBtn.addEventListener("click", async () => {
  const t = parseFloat(simTime.value);
  const s = parseFloat(simSpeed.value);
  if (isNaN(t) || isNaN(s)) return;

  simulateBtn.textContent = "⏳ Simulating…";
  simulateBtn.disabled = true;

  try {
    const res = await fetch(`${API}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time: t, speed: s }),
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
  
  if (simAnimId) {
    cancelAnimationFrame(simAnimId);
    simAnimId = null;
  }
  const canvas = document.getElementById("sim-canvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// ── Keyboard shortcut: Enter to simulate ─────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && document.activeElement !== uploadBtn) {
    simulateBtn.click();
  }
});

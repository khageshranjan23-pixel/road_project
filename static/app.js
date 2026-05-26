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
let simulator3D = null;

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

  const payload = { time: t, speed: s };
  
  if (simulator3D) {
    const pathType = document.getElementById("sim-path-type").value;
    simulator3D.pathType = pathType;
    
    if (pathType === 'diagonal-left') {
      payload.start_x = 0;
      payload.start_z = -6.0;
      payload.end_x = simulator3D.roadWidth;
      payload.end_z = 6.0;
    } else if (pathType === 'diagonal-right') {
      payload.start_x = 0;
      payload.start_z = 6.0;
      payload.end_x = simulator3D.roadWidth;
      payload.end_z = -6.0;
    } else if (pathType === 'custom') {
      if (simulator3D.customStartPoint && simulator3D.customEndPoint) {
        payload.start_x = simulator3D.customStartPoint.x;
        payload.start_z = simulator3D.customStartPoint.z;
        payload.end_x = simulator3D.customEndPoint.x;
        payload.end_z = simulator3D.customEndPoint.z;
      } else {
        alert("Please click two points in the 3D view to set custom path start & end points!");
        return;
      }
    }
  }

  simulateBtn.textContent = "⏳ Simulating…";
  simulateBtn.disabled = true;

  try {
    const res = await fetch(`${API}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

  // Run visual 3D simulation
  if (!simulator3D) {
    simulator3D = new Road3DSimulator("sim-canvas");
  }
  simulator3D.startSimulation(data);

  // Scroll to result
  simResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  
  if (simulator3D) {
    simulator3D.stop();
  }
}

// ── Keyboard shortcut: Enter to simulate ─────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && document.activeElement !== uploadBtn) {
    simulateBtn.click();
  }
});

// --- DOM Initialization & Selection event wiring ---
document.addEventListener("DOMContentLoaded", () => {
  // Initialize the 3D simulator on page load
  if (!simulator3D) {
    simulator3D = new Road3DSimulator("sim-canvas");
  }
  
  const levelSelect = document.getElementById("game-level-select");
  if (levelSelect && simulator3D) {
    simulator3D.gameLevel = levelSelect.value;
    levelSelect.addEventListener("change", (e) => {
      simulator3D.gameLevel = e.target.value;
      if (simulator3D.active) simulator3D.restartSimulation();
    });
  }
  
  const pathSelect = document.getElementById("sim-path-type");
  const customHint = document.getElementById("custom-path-hint");
  const customControls = document.getElementById("custom-path-controls");
  
  function syncCustomPathFromDOM() {
    if (!simulator3D) return;
    const startLaneVal = document.getElementById('custom-start-lane').value;
    const startZ = parseFloat(document.getElementById('custom-start-z').value);
    const endLaneVal = document.getElementById('custom-end-lane').value;
    const endZ = parseFloat(document.getElementById('custom-end-z').value);

    let startX = 0;
    if (startLaneVal === 'left') startX = 0;
    else if (startLaneVal === 'right') startX = simulator3D.roadWidth;
    else {
      const laneIdx = parseInt(startLaneVal.replace('lane', '')) - 1;
      startX = (laneIdx + 0.5) * simulator3D.laneWidth;
    }

    let endX = simulator3D.roadWidth;
    if (endLaneVal === 'left') endX = 0;
    else if (endLaneVal === 'right') endX = simulator3D.roadWidth;
    else {
      const laneIdx = parseInt(endLaneVal.replace('lane', '')) - 1;
      endX = (laneIdx + 0.5) * simulator3D.laneWidth;
    }

    simulator3D.customStartPoint = new THREE.Vector3(startX, 0.1, startZ);
    simulator3D.customEndPoint = new THREE.Vector3(endX, 0.1, endZ);

    simulator3D.drawMarkerPin(simulator3D.customStartPoint, 'start');
    simulator3D.drawMarkerPin(simulator3D.customEndPoint, 'end');
    simulator3D.drawPathLine();
  }

  if (pathSelect && simulator3D) {
    simulator3D.pathType = pathSelect.value;
    pathSelect.addEventListener("change", (e) => {
      const type = e.target.value;
      simulator3D.pathType = type;
      if (customHint) {
        customHint.style.display = (type === 'custom') ? 'block' : 'none';
      }
      if (customControls) {
        customControls.style.display = (type === 'custom') ? 'block' : 'none';
      }
      if (type !== 'custom') {
        simulator3D.clearCustomPathMarkers();
      } else {
        syncCustomPathFromDOM();
      }
      
      // If simulation is active, restart it with new path structure
      if (simulator3D.active) {
        simulateBtn.click();
      }
    });

    // Wire up sliders for custom path coordinates
    const startLane = document.getElementById('custom-start-lane');
    const startZ = document.getElementById('custom-start-z');
    const endLane = document.getElementById('custom-end-lane');
    const endZ = document.getElementById('custom-end-z');

    const startZVal = document.getElementById('custom-start-z-val');
    const endZVal = document.getElementById('custom-end-z-val');

    if (startLane && startZ && endLane && endZ) {
      [startLane, startZ, endLane, endZ].forEach(el => {
        el.addEventListener('input', () => {
          if (startZVal) startZVal.textContent = parseFloat(startZ.value).toFixed(1) + 'm';
          if (endZVal) endZVal.textContent = parseFloat(endZ.value).toFixed(1) + 'm';
          
          syncCustomPathFromDOM();
          
          // If simulation is running, trigger rerun to show updated path crossings
          if (simulator3D.active) {
            simulateBtn.click();
          }
        });
      });
    }
  }

  const clearScoresBtn = document.getElementById("clear-scores-btn");
  if (clearScoresBtn) {
    clearScoresBtn.addEventListener("click", () => {
      localStorage.removeItem("roadsafe_scores");
      loadLeaderboard();
    });
  }

  loadLeaderboard();
});

// --- LEADERBOARD FUNCTIONS ---
function loadLeaderboard() {
  const list = document.getElementById("leaderboard-list");
  if (!list) return;
  
  let scores = [];
  try {
    scores = JSON.parse(localStorage.getItem("roadsafe_scores") || "[]");
  } catch (_) {}
  
  if (scores.length === 0) {
    list.innerHTML = '<div class="empty-state">No scores recorded yet</div>';
    return;
  }
  
  scores.sort((a,b) => b.score - a.score);
  const topScores = scores.slice(0, 5);
  
  list.innerHTML = topScores.map((s, idx) => `
    <div class="leaderboard-item">
      <div class="lb-rank-name">
        <span class="lb-rank">#${idx+1}</span>
        <span class="lb-name">${s.name} (${s.level})</span>
      </div>
      <div class="lb-score-grade">
        <span class="lb-score">${Math.round(s.score)}</span>
        <span class="lb-grade ${s.grade}">${s.grade}</span>
      </div>
    </div>
  `).join("");
}

window.saveScore = function(score, grade) {
  let scores = [];
  try {
    scores = JSON.parse(localStorage.getItem("roadsafe_scores") || "[]");
  } catch (_) {}
  
  const levelsMap = {
    level1: 'Lvl 1',
    level2: 'Lvl 2',
    level3: 'Lvl 3',
    level4: 'Lvl 4'
  };
  const lvlName = levelsMap[simulator3D ? simulator3D.gameLevel : 'level1'] || 'Lvl 1';
  
  scores.push({
    name: "Player",
    score: score,
    grade: grade,
    level: lvlName,
    date: new Date().toLocaleDateString()
  });
  
  localStorage.setItem("roadsafe_scores", JSON.stringify(scores));
  loadLeaderboard();
};

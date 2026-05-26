/**
 * sim3d.js — RoadSafe AI 3D WebGL Simulation Engine
 * Procedural 3D street crossing rendering using Three.js.
 * Built for high visual fidelity, premium lighting, and realistic animation.
 */

class Road3DSimulator {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) {
      console.error(`Canvas with ID #${canvasId} not found.`);
      return;
    }

    this.container = this.canvas.parentElement;
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;

    this.active = false;
    this.isPlaying = true;
    this.currentTime = 0;
    this.crossTime = 5;
    this.pedSpeed = 1.4;
    this.roadWidth = 7.0;
    this.numLanes = 3;
    this.laneWidth = 2.33;
    
    this.vehiclesData = [];
    this.collisionsData = [];
    this.collisionTime = null;
    this.collisionLane = null;
    this.collided = false;
    this.exploded = false;
    this.successSignaled = false;

    // Interactive Game Mode variables
    this.isInteractive = false;
    this.playerScore = 1000;
    this.playerHearts = 3;
    this.playerDead = false;
    this.playerSurvived = false;
    this.keysPressed = { w: false, a: false, s: false, d: false, q: false, e: false };
    this.trailPoints = [];
    this.hudAlertTimeout = null;

    // Custom Path selection variables
    this.pathType = 'straight'; // straight | diagonal-left | diagonal-right | custom
    this.customStartPoint = null; // Vector3
    this.customEndPoint = null; // Vector3
    this.startPinMesh = null;
    this.endPinMesh = null;
    this.pathLineMesh = null;
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Advanced Game Powerups
    this.collectibles = []; // Array of { mesh, type, id, initY }
    this.shieldActive = false;
    this.shieldMesh = null;
    this.timeSlowActive = false;
    this.timeSlowTimer = 0;
    this.speedBoostActive = false;
    this.speedBoostTimer = 0;
    this.gameLevel = 'level1';

    // View tracking
    this.currentView = 'orbit'; // orbit | chase | pedestrian
    this.fpvYaw = 0; // look left/right angle offset
    this.currentTheme = 'day'; // day | sunset | night
    this.animationFrameId = null;

    // Scene variables
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    
    // Meshes
    this.pedestrian = null;
    this.vehicles = []; // Map of id -> mesh
    this.streetlights = [];
    this.particles = []; // Particle effects
    this.buildingsList = []; // Track cityscape buildings
    this.cityProps = []; // Track street side trees and details
    this.trafficLights = []; // Track traffic light elements

    // Camera shakes
    this.shakeIntensity = 0;
    this.shakeDecay = 0.9;
    this.originalCameraPos = new THREE.Vector3();

    // Ragdoll physics
    this.pedThrowVelocity = null;
    this.pedSpin = null;
    this.pedIsGrounded = false;

    // Procedural textures
    this.asphaltTexture = null;
    this.volumetricConeTexture = null;

    this.initScene();
    this.initLights();
    this.initEnvironment();

    // Bind event listeners
    this.initEvents();
  }

  // ── Init scene, camera, renderer ──────────────────────────────────────────
  initScene() {
    this.scene = new THREE.Scene();
    
    // Bright sunny Californian sky blue background
    this.scene.background = new THREE.Color(0xa5f3fc);
    this.scene.fog = new THREE.Fog(0xa5f3fc, 50, 250);

    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 1000);
    
    // Auxiliary cameras for First-Person Left/Right sideview PiPs
    this.leftCamera = new THREE.PerspectiveCamera(50, 1.44, 0.1, 100);
    this.rightCamera = new THREE.PerspectiveCamera(50, 1.44, 0.1, 100);

    // Default Camera position (angled GTA-style overview closer to ground)
    this.camera.position.set(-12, 6, 14);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance"
    });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Controls - Safe initialization
    if (THREE.OrbitControls) {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    } else if (window.OrbitControls) {
      this.controls = new window.OrbitControls(this.camera, this.renderer.domElement);
    } else {
      console.error("OrbitControls not found! Make sure OrbitControls.js script is loaded.");
      // Fallback dummy controls
      this.controls = { target: new THREE.Vector3(), update: () => {} };
    }
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05; // Don't go below ground
    this.controls.minDistance = 3;
    this.controls.maxDistance = 150;
    this.controls.target.set(3.5, 0, 0); // Focus on zebra crossing center
  }

  // ── Setup events and resizing ─────────────────────────────────────────────
  initEvents() {
    // Resize observer for container
    const resizeObserver = new ResizeObserver(() => {
      if (!this.container) return;
      this.width = this.container.clientWidth;
      this.height = this.container.clientHeight;
      
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      
      this.renderer.setSize(this.width, this.height);
    });
    resizeObserver.observe(this.container);

    // Camera view button controls
    const viewButtons = document.querySelectorAll('.cam-btn');
    viewButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        viewButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const view = btn.getAttribute('data-view');
        this.switchView(view);
      });
    });

    // Theme selector controls
    const themeButtons = document.querySelectorAll('.theme-btn');
    themeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        themeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const theme = btn.getAttribute('data-theme');
        this.switchTheme(theme);
      });
    });

    // Playback control buttons
    const playPauseBtn = document.getElementById('sim-play-pause-btn');
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.isPlaying = !this.isPlaying;
        playPauseBtn.textContent = this.isPlaying ? '\u23F8 Pause' : '\u25B6 Play';
        if (this.isPlaying && this.active) {
          this.animate();
        }
      });
    }

    const restartBtn = document.getElementById('sim-restart-btn');
    if (restartBtn) {
      restartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.restartSimulation();
      });
    }

    // ── GAME INPUT: WASD / ARROWS KEYBOARD LISTENERS ────────────────────
    window.addEventListener('keydown', (e) => {
      if (!this.active || !this.isPlaying || !this.isInteractive || this.playerDead || this.playerSurvived) return;
      const key = e.key.toLowerCase();
      
      let mapKey = '';
      if (key === 'w' || e.key === 'ArrowUp') mapKey = 'w';
      else if (key === 'a' || e.key === 'ArrowLeft') mapKey = 'a';
      else if (key === 's' || e.key === 'ArrowDown') mapKey = 's';
      else if (key === 'd' || e.key === 'ArrowRight') mapKey = 'd';
      else if (key === 'q') mapKey = 'q';
      else if (key === 'e') mapKey = 'e';
      
      if (mapKey) {
        if (e.key.startsWith('Arrow')) e.preventDefault(); // Stop default scroll
        this.keysPressed[mapKey] = true;
        const keyElement = document.getElementById(`key-${mapKey}`);
        if (keyElement) keyElement.classList.add('pressed');
      }
    });

    window.addEventListener('keyup', (e) => {
      if (!this.active) return;
      const key = e.key.toLowerCase();
      
      let mapKey = '';
      if (key === 'w' || e.key === 'ArrowUp') mapKey = 'w';
      else if (key === 'a' || e.key === 'ArrowLeft') mapKey = 'a';
      else if (key === 's' || e.key === 'ArrowDown') mapKey = 's';
      else if (key === 'd' || e.key === 'ArrowRight') mapKey = 'd';
      else if (key === 'q') mapKey = 'q';
      else if (key === 'e') mapKey = 'e';
      
      if (mapKey) {
        this.keysPressed[mapKey] = false;
        const keyElement = document.getElementById(`key-${mapKey}`);
        if (keyElement) keyElement.classList.remove('pressed');
      }
    });

    // ── MODE SELECTOR BUTTONS (AUTO VS INTERACTIVE PLAY) ──────────────────
    const modeAutoBtn = document.getElementById('mode-auto-btn');
    const modePlayBtn = document.getElementById('mode-play-btn');
    
    if (modeAutoBtn && modePlayBtn) {
      modeAutoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setInteractive(false);
        this.resetAnimation();
      });

      modePlayBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setInteractive(true);
        this.restartSimulation();
      });
    }

    // ── PERSPECTIVE VIEW SELECTOR BUTTONS ─────────────────────────────────
    const viewOrbitBtn = document.getElementById('view-orbit-btn');
    const viewTpvBtn = document.getElementById('view-tpv-btn');
    const viewFpvBtn = document.getElementById('view-fpv-btn');
    const cameraButtons = [viewOrbitBtn, viewTpvBtn, viewFpvBtn];
    
    cameraButtons.forEach(btn => {
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          cameraButtons.forEach(b => { if (b) b.classList.remove('active'); });
          btn.classList.add('active');
          const view = btn.getAttribute('data-view');
          this.switchView(view);
        });
      }
    });

    // ── RETRY / REPLAY BUTTONS ON OVERLAYS ────────────────────────────────
    const wastedRetry = document.getElementById('wasted-retry-btn');
    if (wastedRetry) {
      wastedRetry.addEventListener('click', (e) => {
        e.stopPropagation();
        this.restartSimulation();
      });
    }

    const survivedRestart = document.getElementById('survived-restart-btn');
    if (survivedRestart) {
      survivedRestart.addEventListener('click', (e) => {
        e.stopPropagation();
        this.restartSimulation();
      });
    }

    // ── CLICK LISTENER FOR CUSTOM PATH SELECTION ───────────────────────────
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.pathType !== 'custom') return;
      
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersects = this.raycaster.intersectObjects(this.scene.children, true);
      
      if (intersects.length > 0) {
        const hit = intersects.find(i => i.point.y >= 0 && i.point.y < 0.5);
        if (hit) {
          const pt = hit.point.clone();
          
          if (!this.customStartPoint) {
            this.customStartPoint = pt;
            this.drawMarkerPin(pt, 'start');
            this.syncCustomPathDOM('start');
          } else if (!this.customEndPoint) {
            this.customEndPoint = pt;
            this.drawMarkerPin(pt, 'end');
            this.drawPathLine();
            this.syncCustomPathDOM('end');
            
            // Auto run simulation when end point is set
            const simulateBtn = document.getElementById('simulate-btn');
            if (simulateBtn) simulateBtn.click();
          } else {
            this.clearCustomPathMarkers();
            this.customStartPoint = pt;
            this.drawMarkerPin(pt, 'start');
            this.syncCustomPathDOM('start');
          }
        }
      }
    });
  }

  // ── CUSTOM PATH DRAWING HELPERS ──────────────────────────────────────────
  drawMarkerPin(pt, type) {
    const color = (type === 'start') ? 0x22c55e : 0xef4444;
    const group = new THREE.Group();
    group.position.copy(pt);
    group.position.y = 0.1;
    
    const coneGeo = new THREE.ConeGeometry(0.16, 0.5, 8);
    coneGeo.rotateX(Math.PI);
    coneGeo.translate(0, 0.25, 0);
    const coneMat = new THREE.MeshPhongMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 0.4,
      shininess: 80
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    group.add(cone);
    
    const ringGeo = new THREE.RingGeometry(0.01, 0.2, 16);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.01;
    group.add(ring);
    
    this.scene.add(group);
    
    if (type === 'start') {
      if (this.startPinMesh) this.scene.remove(this.startPinMesh);
      this.startPinMesh = group;
    } else {
      if (this.endPinMesh) this.scene.remove(this.endPinMesh);
      this.endPinMesh = group;
    }
  }

  drawPathLine() {
    if (!this.customStartPoint || !this.customEndPoint) return;
    if (this.pathLineMesh) this.scene.remove(this.pathLineMesh);
    
    const p1 = this.customStartPoint;
    const p2 = this.customEndPoint;
    
    const group = new THREE.Group();
    const segments = 15;
    const dotGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.8 });
    
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.lerpVectors(p1, p2, t);
      dot.position.y = 0.03;
      group.add(dot);
    }
    
    this.scene.add(group);
    this.pathLineMesh = group;
  }

  clearCustomPathMarkers() {
    if (this.startPinMesh) { this.scene.remove(this.startPinMesh); this.startPinMesh = null; }
    if (this.endPinMesh) { this.scene.remove(this.endPinMesh); this.endPinMesh = null; }
    if (this.pathLineMesh) { this.scene.remove(this.pathLineMesh); this.pathLineMesh = null; }
    this.customStartPoint = null;
    this.customEndPoint = null;
  }

  syncCustomPathDOM(type) {
    const point = (type === 'start') ? this.customStartPoint : this.customEndPoint;
    if (!point) return;

    const selectEl = document.getElementById(type === 'start' ? 'custom-start-lane' : 'custom-end-lane');
    const zSld = document.getElementById(type === 'start' ? 'custom-start-z' : 'custom-end-z');
    const zVal = document.getElementById(type === 'start' ? 'custom-start-z-val' : 'custom-end-z-val');

    if (zSld) zSld.value = point.z.toFixed(1);
    if (zVal) zVal.textContent = point.z.toFixed(1) + 'm';

    if (selectEl) {
      if (point.x < 0.3) {
        selectEl.value = 'left';
      } else if (point.x > this.roadWidth - 0.3) {
        selectEl.value = 'right';
      } else {
        const laneNum = Math.min(this.numLanes, Math.max(1, Math.round(point.x / this.laneWidth + 0.5)));
        selectEl.value = 'lane' + laneNum;
      }
    }
  }

  // ── Setup lights ───────────────────────────────────────────────────────────
  initLights() {
    // Hemisphere light adds natural ambient sky light and ground bounce, lighting up surfaces
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x4d7c0f, 0.95);
    this.scene.add(this.hemiLight);

    // Soft environmental fill light
    this.ambientLight = new THREE.AmbientLight(0xfffbeb, 0.6);
    this.scene.add(this.ambientLight);

    // Directional light (moonlight/sunlight) casting clear, crisp shadows
    this.sunLight = new THREE.DirectionalLight(0xfef08a, 1.8);
    this.sunLight.position.set(40, 80, 20);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048; // High res shadow map
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.bias = -0.0005;
    
    // Setup orthographic shadow camera boundary for crisp shadows
    this.sunLight.shadow.camera.left = -40;
    this.sunLight.shadow.camera.right = 40;
    this.sunLight.shadow.camera.top = 40;
    this.sunLight.shadow.camera.bottom = -40;
    this.scene.add(this.sunLight);
  }

  // ── Generate Procedural Textures for Premium Look ────────────────────────
  getAsphaltTexture() {
    if (this.asphaltTexture) return this.asphaltTexture;

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    
    // Base dark grey color
    ctx.fillStyle = '#141822';
    ctx.fillRect(0, 0, 256, 256);

    // Grain/Noise
    for (let i = 0; i < 9000; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const size = Math.random() * 1.5;
      const opacity = Math.random() * 0.08;
      ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
      ctx.fillRect(x, y, size, size);
    }
    
    for (let i = 0; i < 9000; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const size = Math.random() * 1.5;
      const opacity = Math.random() * 0.12;
      ctx.fillStyle = `rgba(0, 0, 0, ${opacity})`;
      ctx.fillRect(x, y, size, size);
    }

    this.asphaltTexture = new THREE.CanvasTexture(canvas);
    this.asphaltTexture.wrapS = THREE.RepeatWrapping;
    this.asphaltTexture.wrapT = THREE.RepeatWrapping;
    this.asphaltTexture.repeat.set(1, 40); // Repeat along the road length
    return this.asphaltTexture;
  }

  getVolumetricConeTexture() {
    if (this.volumetricConeTexture) return this.volumetricConeTexture;

    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, 'rgba(255, 255, 240, 0.45)');
    grad.addColorStop(0.15, 'rgba(255, 255, 240, 0.25)');
    grad.addColorStop(0.5, 'rgba(255, 255, 240, 0.08)');
    grad.addColorStop(1, 'rgba(255, 255, 240, 0.0)');
    
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 256);

    this.volumetricConeTexture = new THREE.CanvasTexture(canvas);
    return this.volumetricConeTexture;
  }

  // ── Setup Road and Street Environment ──────────────────────────────────────
  initEnvironment() {
    const roadLength = 350;

    // 1. Asphalt Road Plane Group
    this.roadGroup = new THREE.Group();
    this.scene.add(this.roadGroup);

    // 2. Sidewalks Groups
    this.sidewalkLeft = new THREE.Group();
    this.scene.add(this.sidewalkLeft);
    
    this.sidewalkRight = new THREE.Group();
    this.scene.add(this.sidewalkRight);

    // 3. Grass Lawns Groups
    this.grassLeft = new THREE.Group();
    this.scene.add(this.grassLeft);

    this.grassRight = new THREE.Group();
    this.scene.add(this.grassRight);

    // 4. City Buildings Group
    this.buildings = new THREE.Group();
    this.scene.add(this.buildings);
    this.buildBuildings(roadLength);

    // 5. Zebra Crossing Stripes Group
    this.zebraStripes = new THREE.Group();
    this.scene.add(this.zebraStripes);

    // 6. Road Markings Group
    this.roadMarkings = new THREE.Group();
    this.scene.add(this.roadMarkings);

    // 7. Streetlights
    this.buildStreetlights(roadLength);

    // 8. City Props Group (palm trees, signs, rails)
    this.cityPropsGroup = new THREE.Group();
    this.scene.add(this.cityPropsGroup);

    // 9. Traffic Lights Group
    this.trafficLightsGroup = new THREE.Group();
    this.scene.add(this.trafficLightsGroup);
  }

  // Procedural Streetlights
  buildStreetlights(roadLength) {
    const lightMat = new THREE.MeshPhongMaterial({ color: 0x27272a, specular: 0x444444, shininess: 30 });
    // Use Phong Material with emissive mapping for street lamp bulb
    const bulbMat = new THREE.MeshPhongMaterial({
      color: 0x111111,
      emissive: 0x000000 // starts OFF in daytime
    });

    // Place poles along sidewalks at interval
    const spacing = 35;
    for (let z = -roadLength / 2 + 10; z < roadLength / 2; z += spacing) {
      if (Math.abs(z) < 5) continue; // Don't block pedestrian crossing line views

      // Left sidewalk poles (placed at X = -3.2)
      this.createStreetlight(lightMat, bulbMat, -3.2, z, Math.PI / 2);
      // Right side poles (repositioned dynamically relative to roadWidth later)
      this.createStreetlight(lightMat, bulbMat, 10.2, z, -Math.PI / 2);
    }
  }

  createStreetlight(metalMat, bulbMat, x, z, rotationY) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotationY;

    // Pole
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.1, 7, 8);
    const pole = new THREE.Mesh(poleGeo, metalMat);
    pole.position.y = 3.5;
    pole.castShadow = true;
    group.add(pole);

    // Curved extension arm
    const armGeo = new THREE.CylinderGeometry(0.04, 0.04, 2, 8);
    const arm = new THREE.Mesh(armGeo, metalMat);
    arm.rotation.z = Math.PI / 2.5;
    arm.position.set(0.6, 6.8, 0);
    arm.castShadow = true;
    group.add(arm);

    // Light head
    const headGeo = new THREE.BoxGeometry(0.5, 0.15, 0.3);
    const head = new THREE.Mesh(headGeo, metalMat);
    head.position.set(1.4, 7.1, 0);
    group.add(head);

    // Emissive bulb
    const bulbGeo = new THREE.SphereGeometry(0.12, 8, 8);
    const bulb = new THREE.Mesh(bulbGeo, bulbMat.clone());
    bulb.position.set(1.4, 7.0, 0);
    bulb.name = 'streetlightBulb';
    group.add(bulb);

    // Volumetric Cone for Streetlight
    const coneLength = 7.0;
    const coneGeo = new THREE.ConeGeometry(1.8, coneLength, 16, 1, true);
    coneGeo.translate(0, -coneLength / 2, 0); // moves tip to (0,0,0) and base to (0, -7.0, 0)
    
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xfffdf0,
      map: this.getVolumetricConeTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.0 // starts 0.0 during day
    });
    
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(1.4, 7.0, 0);
    cone.name = 'streetlightCone';
    group.add(cone);

    this.scene.add(group);
    this.streetlights.push({ group, baseOffset: x });
  }

  // Procedural Buildings (Skyscrapers)
  buildBuildings(roadLength) {
    const spacing = 55;
    const buildingColors = [0x1e293b, 0x0f172a, 0x111827];
    const windowMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });

    for (let z = -roadLength / 2 + 20; z < roadLength / 2; z += spacing) {
      // Left building block (placed at static X = -28)
      this.createBuilding(z, -28, buildingColors[Math.abs(z) % 3], windowMat, false);
      // Right building block (repositioned dynamically relative to roadWidth)
      this.createBuilding(z, 38, buildingColors[(Math.abs(z) + 1) % 3], windowMat, true);
    }
  }

  createBuilding(z, x, colorHex, windowMat, isRight = false) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    const bHeight = 20 + Math.random() * 30;
    const bWidth = 16;
    const bDepth = 16;

    const bMat = new THREE.MeshPhongMaterial({
      color: colorHex,
      specular: 0x222222,
      shininess: 30
    });
    const bGeo = new THREE.BoxGeometry(bWidth, bHeight, bDepth);
    bGeo.translate(0, bHeight / 2, 0); // pivot at bottom
    
    const building = new THREE.Mesh(bGeo, bMat);
    building.castShadow = true;
    building.receiveShadow = true;
    group.add(building);

    // Add glowing window matrices on the building front facade facing the road
    const windowGeo = new THREE.BoxGeometry(0.8, 0.6, 0.05);
    const floors = Math.floor(bHeight / 3) - 1;
    const cols = 3;

    for (let f = 1; f <= floors; f++) {
      for (let c = 0; c < cols; c++) {
        // Skip random windows for realistic look
        if (Math.random() < 0.25) continue;

        const wY = f * 3;
        const wZ = (c - 1) * 4;

        const win = new THREE.Mesh(windowGeo, windowMat);
        if (!isRight) {
          win.position.set(bWidth / 2 + 0.03, wY, wZ);
          win.rotation.y = Math.PI / 2;
        } else {
          win.position.set(-bWidth / 2 - 0.03, wY, wZ);
          win.rotation.y = -Math.PI / 2;
        }
        group.add(win);
      }
    }

    this.scene.add(group);
    this.buildingsList.push({ group, isRight });
  }

  // Adjust environment metrics depending on current road simulation settings
  updateEnvironment(roadWidth, numLanes) {
    this.roadWidth = roadWidth;
    this.numLanes = numLanes;
    this.laneWidth = roadWidth / numLanes;
    const roadLength = 350;

    // 1. Clear old groups
    this.clearGroup(this.roadGroup);
    this.clearGroup(this.sidewalkLeft);
    this.clearGroup(this.sidewalkRight);
    this.clearGroup(this.grassLeft);
    this.clearGroup(this.grassRight);

    // 2. Rebuild Asphalt road plane exactly matching roadWidth
    const roadGeo = new THREE.PlaneGeometry(roadWidth, roadLength);
    const roadMat = new THREE.MeshPhongMaterial({
      map: this.getAsphaltTexture(),
      bumpMap: this.getAsphaltTexture(),
      bumpScale: 0.015,
      specular: 0x111111,
      shininess: 10
    });
    const roadMesh = new THREE.Mesh(roadGeo, roadMat);
    roadMesh.rotation.x = -Math.PI / 2;
    roadMesh.position.set(roadWidth / 2, 0, 0); // Center the road
    roadMesh.receiveShadow = true;
    this.roadGroup.add(roadMesh);

    // 3. Rebuild Sidewalk Left
    const sidewalkMat = new THREE.MeshPhongMaterial({
      color: 0x64748b, // Slate concrete
      specular: 0x111111,
      shininess: 10
    });
    const sidewalkLeftGeo = new THREE.BoxGeometry(6, 0.2, roadLength);
    const swLeft = new THREE.Mesh(sidewalkLeftGeo, sidewalkMat);
    swLeft.position.set(-3, 0.1, 0);
    swLeft.receiveShadow = true;
    swLeft.castShadow = true;
    this.sidewalkLeft.add(swLeft);

    // Curb edge left (painted/darker concrete slab)
    const curbGeo = new THREE.BoxGeometry(0.15, 0.25, roadLength);
    const curbMat = new THREE.MeshPhongMaterial({ color: 0x475569, specular: 0x111111, shininess: 10 });
    const curbLeft = new THREE.Mesh(curbGeo, curbMat);
    curbLeft.position.set(0, 0.125, 0);
    this.sidewalkLeft.add(curbLeft);

    // Rebuild Sidewalk Right
    const swRight = new THREE.Mesh(sidewalkLeftGeo, sidewalkMat);
    swRight.position.set(roadWidth + 3, 0.1, 0);
    swRight.receiveShadow = true;
    swRight.castShadow = true;
    this.sidewalkRight.add(swRight);

    // Curb edge right
    const curbRight = new THREE.Mesh(curbGeo, curbMat);
    curbRight.position.set(roadWidth, 0.125, 0);
    this.sidewalkRight.add(curbRight);

    // 4. Rebuild Grass Lawns
    const grassMat = new THREE.MeshPhongMaterial({
      color: 0x166534, // Natural dark forest grass green
      specular: 0x050505,
      shininess: 2
    });
    const grassGeo = new THREE.PlaneGeometry(100, roadLength);
    
    const gLeft = new THREE.Mesh(grassGeo, grassMat);
    gLeft.rotation.x = -Math.PI / 2;
    gLeft.position.set(-56, 0.01, 0); // starts left of sidewalk Left
    gLeft.receiveShadow = true;
    this.grassLeft.add(gLeft);

    const gRight = new THREE.Mesh(grassGeo, grassMat);
    gRight.rotation.x = -Math.PI / 2;
    gRight.position.set(roadWidth + 56, 0.01, 0); // starts right of sidewalk Right
    gRight.receiveShadow = true;
    this.grassRight.add(gRight);

    // 5. Reposition Streetlights on the right side
    this.streetlights.forEach(light => {
      if (light.baseOffset > 0) {
        light.group.position.x = roadWidth + 0.2;
      }
    });

    // 6. Reposition Skyscrapers on the right side
    this.buildingsList.forEach(b => {
      if (b.isRight) {
        b.group.position.x = roadWidth + 20;
      }
    });

    // 7. Clear and rebuild city props and traffic lights
    this.clearGroup(this.cityPropsGroup);
    this.clearGroup(this.trafficLightsGroup);
    this.trafficLights = [];

    this.buildCityProps(roadLength);
    this.buildTrafficLights();

    // 8. Redraw markings
    this.drawZebraCrossing();
    this.drawRoadMarkings();
  }

  clearGroup(group) {
    while (group.children.length > 0) {
      const obj = group.children[0];
      group.remove(obj);
    }
  }

  // ── GTA-Style Environmental Props ──────────────────────────────────────────
  buildCityProps(roadLength) {
    const spacing = 28;
    for (let z = -roadLength / 2 + 15; z < roadLength / 2; z += spacing) {
      if (Math.abs(z) < 6) continue; // Keep the zebra crossing area visible and clean

      // Left sidewalk trees (placed at X = -2.5)
      this.createPalmTree(-2.5, z);
      // Right sidewalk trees (placed at X = roadWidth + 2.5)
      this.createPalmTree(this.roadWidth + 2.5, z);

      // Intermediate oak trees
      if (z + spacing / 2 < roadLength / 2) {
        this.createOakTree(-2.8, z + spacing / 2);
        this.createOakTree(this.roadWidth + 2.8, z + spacing / 2);
      }
    }

    // Pedestrian diamond warning signs near zebra crossing
    this.createWarningSign(-0.8, -8, 0);
    this.createWarningSign(this.roadWidth + 0.8, 8, Math.PI);

    // Silver guard rails along sidewalks
    this.createGuardRails(roadLength);
  }

  createPalmTree(x, z) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    // Palm Trunk: stacked segments with a slight organic bend
    const trunkSegments = 6;
    const trunkHeight = 1.0;
    const trunkMat = new THREE.MeshPhongMaterial({ color: 0x854d0e, specular: 0x050505, shininess: 2 });
    
    let lastY = 0;
    let lastOffset = 0;
    const leanDirection = (Math.random() - 0.5) * 0.25;

    for (let i = 0; i < trunkSegments; i++) {
      const radiusBottom = 0.22 - i * 0.025;
      const radiusTop = 0.19 - i * 0.025;
      const segGeo = new THREE.CylinderGeometry(radiusTop, radiusBottom, trunkHeight, 8);
      const seg = new THREE.Mesh(segGeo, trunkMat);
      
      seg.position.set(lastOffset + leanDirection * 0.15, lastY + trunkHeight / 2, 0);
      seg.rotation.z = leanDirection;
      seg.castShadow = true;
      group.add(seg);

      lastY += trunkHeight - 0.05;
      lastOffset += leanDirection * 0.15;
    }

    // Palm leaves at the top
    const leafMat = new THREE.MeshPhongMaterial({
      color: 0x166534,
      specular: 0x0a0a0a,
      shininess: 5,
      side: THREE.DoubleSide
    });
    
    const numLeaves = 8;
    const leafLength = 2.4;
    const leafGeo = new THREE.BoxGeometry(0.3, 0.04, leafLength);
    leafGeo.translate(0, 0, leafLength / 2); // pivot at base of leaf stem

    for (let i = 0; i < numLeaves; i++) {
      const leafMesh = new THREE.Mesh(leafGeo, leafMat);
      leafMesh.position.set(lastOffset, lastY, 0);
      
      leafMesh.rotation.y = (i / numLeaves) * Math.PI * 2 + (Math.random() - 0.5) * 0.1;
      leafMesh.rotation.x = Math.PI / 8 + (Math.random() * 0.1); // arch leaf downward
      leafMesh.castShadow = true;
      group.add(leafMesh);
    }

    this.cityPropsGroup.add(group);
  }

  createOakTree(x, z) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    // Trunk
    const trunkMat = new THREE.MeshPhongMaterial({ color: 0x451a03, specular: 0x050505, shininess: 2 });
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 2.5, 8);
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 1.25;
    trunk.castShadow = true;
    group.add(trunk);

    // Dense leafy canopy clusters
    const foliageMat = new THREE.MeshPhongMaterial({ color: 0x15803d, specular: 0x050505, shininess: 2 });
    const foliageGeo = new THREE.DodecahedronGeometry(1.2, 1);
    
    const cluster1 = new THREE.Mesh(foliageGeo, foliageMat);
    cluster1.position.set(0, 2.8, 0);
    cluster1.castShadow = true;
    group.add(cluster1);

    const cluster2 = new THREE.Mesh(foliageGeo, foliageMat);
    cluster2.position.set(-0.5, 3.4, 0.3);
    cluster2.scale.set(0.8, 0.8, 0.8);
    cluster2.castShadow = true;
    group.add(cluster2);

    const cluster3 = new THREE.Mesh(foliageGeo, foliageMat);
    cluster3.position.set(0.4, 3.2, -0.4);
    cluster3.scale.set(0.9, 0.9, 0.9);
    cluster3.castShadow = true;
    group.add(cluster3);

    this.cityPropsGroup.add(group);
  }

  createWarningSign(x, z, rotY) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotY;

    // Metal signpost
    const poleMat = new THREE.MeshPhongMaterial({ color: 0x64748b, specular: 0x666666, shininess: 80 });
    const poleGeo = new THREE.CylinderGeometry(0.04, 0.04, 3.2, 8);
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 1.6;
    pole.castShadow = true;
    group.add(pole);

    // Yellow Diamond Sign
    const signMat = new THREE.MeshPhongMaterial({
      color: 0xeab308, // Golden yellow
      specular: 0x222222,
      shininess: 20
    });
    const signGeo = new THREE.BoxGeometry(0.6, 0.6, 0.02);
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.position.set(0, 3.1, 0);
    sign.rotation.z = Math.PI / 4;
    sign.castShadow = true;
    group.add(sign);

    // Black border/inner warning square
    const graphicMat = new THREE.MeshPhongMaterial({ color: 0x0f172a, specular: 0x111111, shininess: 10 });
    const graphicGeo = new THREE.BoxGeometry(0.5, 0.5, 0.022);
    const graphic = new THREE.Mesh(graphicGeo, graphicMat);
    graphic.position.set(0, 3.1, 0);
    graphic.rotation.z = Math.PI / 4;
    group.add(graphic);

    // Pedestrian symbol representer (mini yellow box inside)
    const symbolGeo = new THREE.BoxGeometry(0.15, 0.25, 0.024);
    const symbol = new THREE.Mesh(symbolGeo, signMat);
    symbol.position.set(0, 3.1, 0);
    group.add(symbol);

    this.cityPropsGroup.add(group);
  }

  createGuardRails(roadLength) {
    const railMat = new THREE.MeshPhongMaterial({ color: 0x94a3b8, specular: 0x777777, shininess: 90 });
    const postGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.8, 8);
    const barGeo = new THREE.CylinderGeometry(0.02, 0.02, 5.8, 8);
    barGeo.rotateX(Math.PI / 2); // align along Z axis

    const leftX = -0.15;
    const rightX = this.roadWidth + 0.15;
    
    // Space posts around pedestrian path entrance boundaries
    const intervals = [-24, -18, -12, 12, 18, 24];
    intervals.forEach(z => {
      const postL = new THREE.Mesh(postGeo, railMat);
      postL.position.set(leftX, 0.4, z);
      postL.castShadow = true;
      this.cityPropsGroup.add(postL);

      const postR = new THREE.Mesh(postGeo, railMat);
      postR.position.set(rightX, 0.4, z);
      postR.castShadow = true;
      this.cityPropsGroup.add(postR);
    });

    // Connector bars
    const segments = [
      [-21, 6], [-15, 6], [15, 6], [21, 6]
    ];
    segments.forEach(([midZ, length]) => {
      // Left Guard rails
      const barL1 = new THREE.Mesh(barGeo, railMat);
      barL1.position.set(leftX, 0.65, midZ);
      barL1.scale.set(1, 1, length / 5.8);
      barL1.castShadow = true;
      this.cityPropsGroup.add(barL1);

      const barL2 = new THREE.Mesh(barGeo, railMat);
      barL2.position.set(leftX, 0.35, midZ);
      barL2.scale.set(1, 1, length / 5.8);
      barL2.castShadow = true;
      this.cityPropsGroup.add(barL2);

      // Right Guard rails
      const barR1 = new THREE.Mesh(barGeo, railMat);
      barR1.position.set(rightX, 0.65, midZ);
      barR1.scale.set(1, 1, length / 5.8);
      barR1.castShadow = true;
      this.cityPropsGroup.add(barR1);

      const barR2 = new THREE.Mesh(barGeo, railMat);
      barR2.position.set(rightX, 0.35, midZ);
      barR2.scale.set(1, 1, length / 5.8);
      barR2.castShadow = true;
      this.cityPropsGroup.add(barR2);
    });
  }

  // ── Traffic Lights System ──────────────────────────────────────────────────
  buildTrafficLights() {
    // Left side pole (approaching crossing)
    this.assembleTrafficLight(-0.5, 3.5, 0);
    // Right side pole (opposite direction approaching crossing)
    this.assembleTrafficLight(this.roadWidth + 0.5, -3.5, Math.PI);
  }

  assembleTrafficLight(x, z, rotY) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotY;

    const blackMat = new THREE.MeshPhongMaterial({ color: 0x111827, specular: 0x111111, shininess: 10 });
    const metalMat = new THREE.MeshPhongMaterial({ color: 0x334155, specular: 0x555555, shininess: 40 });

    // Vertical pole
    const poleGeo = new THREE.CylinderGeometry(0.1, 0.14, 5.5, 8);
    const pole = new THREE.Mesh(poleGeo, metalMat);
    pole.position.y = 2.75;
    pole.castShadow = true;
    group.add(pole);

    // Horizontal overhead arm
    const armGeo = new THREE.CylinderGeometry(0.07, 0.07, 2.5, 8);
    armGeo.rotateZ(Math.PI / 2);
    const arm = new THREE.Mesh(armGeo, metalMat);
    arm.position.set(1.1, 5.3, 0);
    arm.castShadow = true;
    group.add(arm);

    // Main signal box head
    const boxGeo = new THREE.BoxGeometry(0.4, 1.1, 0.35);
    const box = new THREE.Mesh(boxGeo, blackMat);
    box.position.set(2.0, 4.9, 0);
    box.castShadow = true;
    group.add(box);

    // Spherical lenses for Red, Yellow, Green bulbs
    const bulbGeo = new THREE.SphereGeometry(0.1, 8, 8);
    
    const redLight = new THREE.Mesh(bulbGeo, new THREE.MeshBasicMaterial({ color: 0x220000 }));
    redLight.position.set(2.0, 5.25, 0.18);
    group.add(redLight);

    const yellowLight = new THREE.Mesh(bulbGeo, new THREE.MeshBasicMaterial({ color: 0x222200 }));
    yellowLight.position.set(2.0, 4.9, 0.18);
    group.add(yellowLight);

    const greenLight = new THREE.Mesh(bulbGeo, new THREE.MeshBasicMaterial({ color: 0x002200 }));
    greenLight.position.set(2.0, 4.55, 0.18);
    group.add(greenLight);

    this.trafficLightsGroup.add(group);
    
    this.trafficLights.push({
      red: redLight,
      yellow: yellowLight,
      green: greenLight
    });
  }

  updateTrafficLights() {
    let state = 'green';
    
    if (this.collided) {
      // Alternate flashing warning lights when collided
      const flash = Math.floor(this.currentTime / 0.3) % 2 === 0;
      state = flash ? 'red' : 'yellow';
    } else if (this.active && this.currentTime > 0 && this.currentTime < this.crossTime) {
      if (this.currentTime < 1.2) {
        state = 'yellow'; // warn vehicles
      } else {
        state = 'red'; // stop vehicles
      }
    } else {
      state = 'green';
    }

    this.trafficLights.forEach(tl => {
      // Reset to dark
      tl.red.material.color.setHex(0x220000);
      tl.yellow.material.color.setHex(0x222200);
      tl.green.material.color.setHex(0x002200);
      
      if (state === 'red') {
        tl.red.material.color.setHex(0xff0000);
      } else if (state === 'yellow') {
        tl.yellow.material.color.setHex(0xeab308);
      } else if (state === 'green') {
        tl.green.material.color.setHex(0x22c55e);
      }
    });
  }

  // ── Exhaust Smoke System ───────────────────────────────────────────────────
  spawnSmokeParticle(x, y, z, direction) {
    const geo = new THREE.SphereGeometry(0.12, 6, 6);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x94a3b8,
      transparent: true,
      opacity: 0.35,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    
    const driftSpeed = 0.5 + Math.random() * 0.5;
    const vx = (Math.random() - 0.5) * 0.15;
    const vy = 0.3 + Math.random() * 0.4;
    const vz = -direction * driftSpeed; // Blow out of exhaust rear

    this.particles.push({
      mesh: mesh,
      velocity: new THREE.Vector3(vx, vy, vz),
      life: 1.0,
      decay: 0.025 + Math.random() * 0.02,
      isSmoke: true
    });
    
    this.scene.add(mesh);
  }

  // ── Theme Selector Core ───────────────────────────────────────────────────
  switchTheme(theme) {
    this.currentTheme = theme;
    
    // Update theme switcher active class
    const themeButtons = document.querySelectorAll('.theme-btn');
    themeButtons.forEach(btn => {
      if (btn.getAttribute('data-theme') === theme) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    if (theme === 'day') {
      this.scene.background.setHex(0xa5f3fc);
      this.scene.fog.color.setHex(0xa5f3fc);
      this.scene.fog.near = 50;
      this.scene.fog.far = 250;

      this.hemiLight.color.setHex(0xffffff);
      this.hemiLight.groundColor.setHex(0x4d7c0f);
      this.hemiLight.intensity = 0.95;

      this.ambientLight.color.setHex(0xfffbeb);
      this.ambientLight.intensity = 0.6;

      this.sunLight.color.setHex(0xfef08a);
      this.sunLight.intensity = 1.8;
      this.sunLight.position.set(40, 80, 20);

      this.vehicles.forEach(mesh => {
        mesh.children.forEach(child => {
          if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => {
              if (mat.name === 'headlampCone') {
                mat.opacity = 0.02;
              }
            });
          }
          if (child instanceof THREE.SpotLight) {
            child.intensity = 0.1;
          }
        });
      });

      this.streetlights.forEach(light => {
        light.group.children.forEach(child => {
          if (child.name === 'streetlightCone' && child.material) {
            child.material.opacity = 0.0;
          }
          if (child.name === 'streetlightBulb' && child.material) {
            child.material.emissive.setHex(0x000000);
          }
        });
      });

    } else if (theme === 'sunset') {
      this.scene.background.setHex(0xfdba74);
      this.scene.fog.color.setHex(0xfdba74);
      this.scene.fog.near = 40;
      this.scene.fog.far = 220;

      this.hemiLight.color.setHex(0xfdba74);
      this.hemiLight.groundColor.setHex(0x27272a);
      this.hemiLight.intensity = 0.7;

      this.ambientLight.color.setHex(0xffedd5);
      this.ambientLight.intensity = 0.45;

      this.sunLight.color.setHex(0xf97316);
      this.sunLight.intensity = 1.4;
      this.sunLight.position.set(60, 25, -10);

      this.vehicles.forEach(mesh => {
        mesh.children.forEach(child => {
          if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => {
              if (mat.name === 'headlampCone') {
                mat.opacity = 0.1;
              }
            });
          }
          if (child instanceof THREE.SpotLight) {
            child.intensity = 1.2;
          }
        });
      });

      this.streetlights.forEach(light => {
        light.group.children.forEach(child => {
          if (child.name === 'streetlightCone' && child.material) {
            child.material.opacity = 0.08;
          }
          if (child.name === 'streetlightBulb' && child.material) {
            child.material.emissive.setHex(0xf97316);
          }
        });
      });

    } else if (theme === 'night') {
      this.scene.background.setHex(0x090d16);
      this.scene.fog.color.setHex(0x090d16);
      this.scene.fog.near = 35;
      this.scene.fog.far = 180;

      this.hemiLight.color.setHex(0x0284c7);
      this.hemiLight.groundColor.setHex(0x0f172a);
      this.hemiLight.intensity = 0.3;

      this.ambientLight.color.setHex(0x0b0f19);
      this.ambientLight.intensity = 0.15;

      this.sunLight.color.setHex(0xffffff);
      this.sunLight.intensity = 0.4;
      this.sunLight.position.set(-25, 60, -15);

      this.vehicles.forEach(mesh => {
        mesh.children.forEach(child => {
          if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => {
              if (mat.name === 'headlampCone') {
                mat.opacity = 0.25;
              }
            });
          }
          if (child instanceof THREE.SpotLight) {
            child.intensity = 2.5;
          }
        });
      });

      this.streetlights.forEach(light => {
        light.group.children.forEach(child => {
          if (child.name === 'streetlightCone' && child.material) {
            child.material.opacity = 0.22;
          }
          if (child.name === 'streetlightBulb' && child.material) {
            child.material.emissive.setHex(0xfffdf0);
          }
        });
      });
    }
  }

  drawZebraCrossing() {
    // Clear old stripes
    while (this.zebraStripes.children.length > 0) {
      const obj = this.zebraStripes.children[0];
      this.zebraStripes.remove(obj);
    }

    // Draw zebra lines (at Z = 0)
    const stripeMat = new THREE.MeshPhongMaterial({
      color: 0xcccccc,
      specular: 0x111111,
      shininess: 5
    });

    const stripeWidth = 0.5;
    const stripeGap = 0.5;
    const stripeLength = 4.0; // pedestrian cross width

    const roadGeo = new THREE.PlaneGeometry(stripeWidth, stripeLength);

    for (let x = stripeWidth; x < this.roadWidth; x += stripeWidth + stripeGap) {
      const stripe = new THREE.Mesh(roadGeo, stripeMat);
      stripe.rotation.x = -Math.PI / 2;
      // Position slightly above the road surface to prevent Z-fighting
      stripe.position.set(x, 0.005, 0);
      stripe.receiveShadow = true;
      this.zebraStripes.add(stripe);
    }
  }

  drawRoadMarkings() {
    // Clear old markings
    while (this.roadMarkings.children.length > 0) {
      const obj = this.roadMarkings.children[0];
      this.roadMarkings.remove(obj);
    }

    const lineMat = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      specular: 0x111111,
      shininess: 5
    });
    const yellowMat = new THREE.MeshPhongMaterial({
      color: 0xfacc15,
      specular: 0x111111,
      shininess: 5
    });

    const roadLength = 350;

    // Yellow solid lines on outer boundary
    const sideLineGeo = new THREE.PlaneGeometry(0.12, roadLength);
    
    const leftLine = new THREE.Mesh(sideLineGeo, yellowMat);
    leftLine.rotation.x = -Math.PI / 2;
    leftLine.position.set(0.06, 0.003, 0);
    this.roadMarkings.add(leftLine);

    const rightLine = new THREE.Mesh(sideLineGeo, yellowMat);
    rightLine.rotation.x = -Math.PI / 2;
    rightLine.position.set(this.roadWidth - 0.06, 0.003, 0);
    this.roadMarkings.add(rightLine);

    // White dashed lane markings
    for (let l = 1; l < this.numLanes; l++) {
      const laneX = l * this.laneWidth;
      
      // Dashed geometry
      const dashLength = 3;
      const gapLength = 6;
      
      for (let z = -roadLength / 2; z < roadLength / 2; z += dashLength + gapLength) {
        // Skip crossing area
        if (Math.abs(z) < 3.5) continue;

        const dashGeo = new THREE.PlaneGeometry(0.08, dashLength);
        const dash = new THREE.Mesh(dashGeo, lineMat);
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(laneX, 0.003, z + dashLength / 2);
        this.roadMarkings.add(dash);
      }
    }
  }

  getPathPoints() {
    let startX = 0, startZ = 0;
    let endX = this.roadWidth, endZ = 0;
    
    if (this.pathType === 'diagonal-left') {
      startZ = -6.0;
      endZ = 6.0;
    } else if (this.pathType === 'diagonal-right') {
      startZ = 6.0;
      endZ = -6.0;
    } else if (this.pathType === 'custom') {
      if (this.customStartPoint && this.customEndPoint) {
        startX = this.customStartPoint.x;
        startZ = this.customStartPoint.z;
        endX = this.customEndPoint.x;
        endZ = this.customEndPoint.z;
      }
    }
    return { startX, startZ, endX, endZ };
  }

  // ── Procedural human walking mesh construction ─────────────────────────────
  buildPedestrian() {
    if (this.pedestrian) {
      this.scene.remove(this.pedestrian);
    }

    this.pedestrian = new THREE.Group();

    // Saturated clothing materials for high visibility and realistic contrast
    const skinMat = new THREE.MeshPhongMaterial({ color: 0xffd1a4, specular: 0x111111, shininess: 5 }); // Peach skin
    const shirtMat = new THREE.MeshPhongMaterial({ color: 0x3b82f6, specular: 0x111111, shininess: 5 }); // Cobalt blue shirt
    const pantsMat = new THREE.MeshPhongMaterial({ color: 0x1e3a8a, specular: 0x111111, shininess: 2 }); // Dark blue jeans
    const vestMat = new THREE.MeshPhongMaterial({ color: 0xa3e635, specular: 0x222222, shininess: 15, emissive: 0x84cc16 }); // High-vis yellow-green vest
    const stripeMat = new THREE.MeshPhongMaterial({ color: 0xe2e8f0, specular: 0xffffff, shininess: 100 }); // Silver retroreflective stripe
    const shoeMat = new THREE.MeshPhongMaterial({ color: 0x0f172a, specular: 0x050505, shininess: 2 }); // Rubber shoes
    const hairMat = new THREE.MeshPhongMaterial({ color: 0x27272a, specular: 0x050505, shininess: 2 }); // Dark hair

    // 1. Torso (Cylinder)
    const torsoGeo = new THREE.CylinderGeometry(0.18, 0.15, 0.7, 8);
    const torso = new THREE.Mesh(torsoGeo, shirtMat);
    torso.position.y = 0.95;
    torso.castShadow = true;
    torso.receiveShadow = true;
    this.pedestrian.add(torso);

    // 2. High-vis Safety Vest overlay
    const vestGeo = new THREE.CylinderGeometry(0.192, 0.162, 0.5, 8);
    const vest = new THREE.Mesh(vestGeo, vestMat);
    vest.position.y = 0.95;
    vest.castShadow = true;
    this.pedestrian.add(vest);

    // Reflective Stripes on vest (Vertical and Horizontal bands)
    const stripeHGeo = new THREE.CylinderGeometry(0.195, 0.165, 0.05, 8);
    const stripeH = new THREE.Mesh(stripeHGeo, stripeMat);
    stripeH.position.y = 0.9;
    this.pedestrian.add(stripeH);

    const stripeVLeftGeo = new THREE.BoxGeometry(0.04, 0.52, 0.02);
    stripeVLeftGeo.translate(-0.08, 0, 0.18);
    const stripeVLeft = new THREE.Mesh(stripeVLeftGeo, stripeMat);
    stripeVLeft.position.y = 0.95;
    this.pedestrian.add(stripeVLeft);

    const stripeVRightGeo = new THREE.BoxGeometry(0.04, 0.52, 0.02);
    stripeVRightGeo.translate(0.08, 0, 0.18);
    const stripeVRight = new THREE.Mesh(stripeVRightGeo, stripeMat);
    stripeVRight.position.y = 0.95;
    this.pedestrian.add(stripeVRight);

    // 3. Head (Sphere)
    const headGeo = new THREE.SphereGeometry(0.14, 12, 12);
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = 1.42;
    head.castShadow = true;
    this.pedestrian.add(head);

    // Hair / Cap (Sphere offset on top)
    const hairGeo = new THREE.SphereGeometry(0.13, 8, 8);
    hairGeo.scale(1.05, 0.8, 1.05);
    const hair = new THREE.Mesh(hairGeo, hairMat);
    hair.position.set(0, 1.48, -0.03);
    this.pedestrian.add(hair);

    // Cap Visor
    const visorGeo = new THREE.BoxGeometry(0.14, 0.02, 0.16);
    const visor = new THREE.Mesh(visorGeo, hairMat);
    visor.position.set(0.10, 1.48, 0);
    this.pedestrian.add(visor);

    // Eyes
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const eyeGeo = new THREE.SphereGeometry(0.02, 6, 6);
    
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(0.07, 1.45, 0.06);
    this.pedestrian.add(leftEye);

    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.07, 1.45, -0.06);
    this.pedestrian.add(rightEye);

    // Nose
    const noseGeo = new THREE.ConeGeometry(0.025, 0.06, 4);
    noseGeo.rotateZ(-Math.PI / 2);
    const nose = new THREE.Mesh(noseGeo, skinMat);
    nose.position.set(0.14, 1.41, 0);
    this.pedestrian.add(nose);

    // 4. Limbs
    // Legs (Pants + Shoes)
    this.leftLeg = this.createLeg(pantsMat, shoeMat, 0.45);
    this.leftLeg.position.set(0.09, 0.6, 0);
    this.pedestrian.add(this.leftLeg);

    this.rightLeg = this.createLeg(pantsMat, shoeMat, 0.45);
    this.rightLeg.position.set(-0.09, 0.6, 0);
    this.pedestrian.add(this.rightLeg);

    // Arms
    this.leftArm = this.createArm(shirtMat, skinMat, 0.45);
    this.leftArm.position.set(0.24, 1.25, 0);
    this.pedestrian.add(this.leftArm);

    // Shield graphic around pedestrian (if active)
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xa855f7, // purple
        transparent: true,
        opacity: 0.0, // start hidden, fade in when shield acquired
        blending: THREE.AdditiveBlending,
        wireframe: true
      })
    );
    this.shieldMesh.position.set(0, 0.8, 0);
    this.pedestrian.add(this.shieldMesh);

    this.rightArm = this.createArm(shirtMat, skinMat, 0.45);
    this.rightArm.position.set(-0.24, 1.25, 0);
    this.pedestrian.add(this.rightArm);

    // Position pedestrian at start position of the selected path
    const { startX, startZ, endX, endZ } = this.getPathPoints();
    this.pedestrian.position.set(startX, 0.05, startZ);
    const angle = Math.atan2(-(endZ - startZ), endX - startX);
    this.pedestrian.rotation.y = angle + Math.PI / 2;
    this.scene.add(this.pedestrian);
  }

  createLeg(pantsMat, shoeMat, length) {
    const pivot = new THREE.Group();

    // Pant leg
    const legGeo = new THREE.CylinderGeometry(0.07, 0.06, length, 6);
    legGeo.translate(0, -length / 2, 0);
    const leg = new THREE.Mesh(legGeo, pantsMat);
    leg.castShadow = true;
    pivot.add(leg);

    // Shoe
    const shoeGeo = new THREE.BoxGeometry(0.1, 0.08, 0.16);
    shoeGeo.translate(0, -length - 0.02, 0.04);
    const shoe = new THREE.Mesh(shoeGeo, shoeMat);
    shoe.castShadow = true;
    pivot.add(shoe);

    return pivot;
  }

  createArm(shirtMat, skinMat, length) {
    const pivot = new THREE.Group();

    // Sleeve
    const armGeo = new THREE.CylinderGeometry(0.06, 0.05, length * 0.7, 6);
    armGeo.translate(0, -length * 0.35, 0);
    const sleeve = new THREE.Mesh(armGeo, shirtMat);
    sleeve.castShadow = true;
    pivot.add(sleeve);

    // Forearm
    const forearmGeo = new THREE.CylinderGeometry(0.05, 0.04, length * 0.3, 6);
    forearmGeo.translate(0, -length * 0.8, 0);
    const forearm = new THREE.Mesh(forearmGeo, skinMat);
    forearm.castShadow = true;
    pivot.add(forearm);

    // Hand
    const handGeo = new THREE.SphereGeometry(0.05, 6, 6);
    handGeo.translate(0, -length * 0.95, 0);
    const hand = new THREE.Mesh(handGeo, skinMat);
    hand.castShadow = true;
    pivot.add(hand);

    return pivot;
  }

  animatePedestrianWalk(t, pedSpeed) {
    if (!this.pedestrian || this.collided) return;

    // Swing frequency proportional to walking speed
    const swingFreq = pedSpeed * 5.2;
    const maxAngle = 0.45; // Max swing angle in radians

    // Left leg and right arm swing together, right leg and left arm opposite
    const swing = Math.sin(t * swingFreq) * maxAngle;
    
    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;
    this.leftArm.rotation.x = -swing * 0.8;
    this.rightArm.rotation.x = swing * 0.8;

    // Slight vertical bounce during steps
    const bounce = Math.abs(Math.cos(t * swingFreq * 2)) * 0.05;
    this.pedestrian.position.y = 0.08 + bounce;
  }

  // ── Procedural Vehicle Construction ────────────────────────────────────────
  buildVehicle(v) {
    const group = new THREE.Group();
    group.name = `vehicle-${v.id}`;
    
    // Choose direction based on lane (odd lanes head North +Z, even head South -Z)
    const direction = (v.lane % 2 !== 0) ? 1 : -1;
    
    let exhaustZ = -2.2;
    if (v.class === 'truck' || v.class === 'bus') exhaustZ = -3.9;
    else if (v.class === 'motorcycle' || v.class === 'bicycle') exhaustZ = -0.9;
    const exhaustPipeOffset = new THREE.Vector3(-0.55, 0.22, exhaustZ);

    group.userData = {
      id: v.id,
      class: v.class,
      lane: v.lane,
      velocity: v.velocity_kmh / 3.6,
      t_arrival: v.t_arrival,
      t_enter: v.t_enter,
      t_exit: v.t_exit,
      collision: v.collision,
      direction: direction,
      init_dist_m: v.init_dist_m,
      exhaustPipe: exhaustPipeOffset
    };

    // Calculate initial positions
    const initialZ = -direction * v.init_dist_m;
    const xPos = (v.lane - 0.5) * this.laneWidth;
    group.position.set(xPos, 0, initialZ);

    // Face travel direction
    if (direction === -1) {
      group.rotation.y = Math.PI; // Face negative Z
    }

    // Sleek premium paint styling
    const colors = [0xdbeafe, 0xef4444, 0x3b82f6, 0xf59e0b, 0x10b981, 0x8b5cf6, 0x64748b, 0x1e293b, 0xf8fafc];
    const paintColor = colors[v.id % colors.length];

    const bodyMat = new THREE.MeshPhongMaterial({
      color: paintColor,
      specular: 0xffffff,
      shininess: 120,
      name: "carPaint"
    });

    const darkPlastic = new THREE.MeshPhongMaterial({ color: 0x111827, specular: 0x111111, shininess: 10 });
    const glassMat = new THREE.MeshPhongMaterial({
      color: 0x1e293b,
      specular: 0xffffff,
      shininess: 100,
      transparent: true,
      opacity: 0.4
    });
    const wheelMat = new THREE.MeshPhongMaterial({ color: 0x090d16, specular: 0x111111, shininess: 5 });
    const chromeMat = new THREE.MeshPhongMaterial({ color: 0xe2e8f0, specular: 0xffffff, shininess: 150 });

    // Procedural styling according to vehicle classes
    if (v.class === 'truck' || v.class === 'bus') {
      this.assembleTruck(group, bodyMat, darkPlastic, glassMat, wheelMat, chromeMat);
    } else if (v.class === 'motorcycle' || v.class === 'bicycle') {
      this.assembleMotorcycle(group, bodyMat, darkPlastic, wheelMat, chromeMat);
    } else {
      // Default: Sedan / SUV Car
      this.assembleCar(group, bodyMat, darkPlastic, glassMat, wheelMat, chromeMat);
    }

    // Attach dual glowing headlights & volumetric light cones
    this.attachLightingToVehicle(group, v.class);

    this.scene.add(group);
    this.vehicles.push(group);
  }

  // 1. CAR assembly
  assembleCar(group, paintMat, plasticMat, glassMat, wheelMat, chromeMat) {
    // Main base body
    const bodyGeo = new THREE.BoxGeometry(1.6, 0.45, 4.4);
    bodyGeo.translate(0, 0.45, 0);
    const body = new THREE.Mesh(bodyGeo, paintMat);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Cabin
    const cabinGeo = new THREE.BoxGeometry(1.4, 0.48, 2.4);
    // Shear vertices for aerodynamic sporty windshield look
    const pos = cabinGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let y = pos.getY(i);
      let z = pos.getZ(i);
      if (y > 0) {
        // Angled windshields
        if (z > 0) pos.setZ(i, z - 0.4);
        if (z < 0) pos.setZ(i, z + 0.4);
      }
    }
    pos.needsUpdate = true; // Ensure changes are uploaded to GPU
    cabinGeo.computeVertexNormals();
    cabinGeo.translate(0, 0.9, -0.2);
    
    const cabin = new THREE.Mesh(cabinGeo, paintMat);
    cabin.castShadow = true;
    group.add(cabin);

    // Glass windshields overlay
    const windGeo = new THREE.BoxGeometry(1.36, 0.42, 2.36);
    windGeo.translate(0, 0.92, -0.2);
    const windows = new THREE.Mesh(windGeo, glassMat);
    group.add(windows);

    // Wheel Arches
    const wheelPositions = [
      [-0.82, 0.32, 1.3],  // Front Left
      [0.82, 0.32, 1.3],   // Front Right
      [-0.82, 0.32, -1.3], // Rear Left
      [0.82, 0.32, -1.3]  // Rear Right
    ];

    const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.28, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.3, 12);
    hubGeo.rotateZ(Math.PI / 2);

    wheelPositions.forEach(([x, y, z]) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(x, y, z);
      wheel.castShadow = true;
      group.add(wheel);

      // Shiny rim cap
      const hub = new THREE.Mesh(hubGeo, chromeMat);
      hub.position.set(x * 1.02, y, z);
      group.add(hub);
    });

    // Grille & Bumper
    const bumperGeo = new THREE.BoxGeometry(1.64, 0.2, 0.3);
    const bumper = new THREE.Mesh(bumperGeo, plasticMat);
    bumper.position.set(0, 0.2, 2.15);
    bumper.castShadow = true;
    group.add(bumper);

    const grilleGeo = new THREE.BoxGeometry(1.2, 0.16, 0.05);
    const grille = new THREE.Mesh(grilleGeo, chromeMat);
    grille.position.set(0, 0.45, 2.21);
    group.add(grille);
  }

  // 2. BUS / TRUCK assembly
  assembleTruck(group, paintMat, plasticMat, glassMat, wheelMat, chromeMat) {
    // Cab cabin
    const cabGeo = new THREE.BoxGeometry(2.0, 1.9, 1.8);
    cabGeo.translate(0, 1.15, 1.9);
    const cab = new THREE.Mesh(cabGeo, paintMat);
    cab.castShadow = true;
    group.add(cab);

    // Windshield
    const windGeo = new THREE.BoxGeometry(1.9, 0.7, 0.15);
    windGeo.translate(0, 1.8, 2.76);
    const windshield = new THREE.Mesh(windGeo, glassMat);
    group.add(windshield);

    // Huge Cargo Bed box
    const cargoGeo = new THREE.BoxGeometry(2.1, 2.1, 4.8);
    cargoGeo.translate(0, 1.35, -1.5);
    const cargoMat = new THREE.MeshPhongMaterial({
      color: 0x334155, // Dark slate
      specular: 0x333333,
      shininess: 20
    });
    const cargo = new THREE.Mesh(cargoGeo, cargoMat);
    cargo.castShadow = true;
    cargo.receiveShadow = true;
    group.add(cargo);

    // Chassis frame
    const frameGeo = new THREE.BoxGeometry(1.6, 0.4, 6.2);
    frameGeo.translate(0, 0.3, -0.6);
    const frame = new THREE.Mesh(frameGeo, plasticMat);
    frame.castShadow = true;
    group.add(frame);

    // Six heavy wheels
    const wheelGeo = new THREE.CylinderGeometry(0.48, 0.48, 0.35, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.38, 12);
    rimGeo.rotateZ(Math.PI / 2);

    const wheelPositions = [
      [-0.95, 0.48, 1.9],   // Front L
      [0.95, 0.48, 1.9],    // Front R
      [-0.95, 0.48, -1.4],  // Mid L
      [0.95, 0.48, -1.4],   // Mid R
      [-0.95, 0.48, -2.4],  // Rear L
      [0.95, 0.48, -2.4]   // Rear R
    ];

    wheelPositions.forEach(([x, y, z]) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(x, y, z);
      wheel.castShadow = true;
      group.add(wheel);

      const rim = new THREE.Mesh(rimGeo, chromeMat);
      rim.position.set(x * 1.02, y, z);
      group.add(rim);
    });
  }

  // 3. MOTORCYCLE assembly
  assembleMotorcycle(group, paintMat, plasticMat, wheelMat, chromeMat) {
    // Body chassis
    const bodyGeo = new THREE.BoxGeometry(0.3, 0.7, 1.8);
    bodyGeo.translate(0, 0.6, 0);
    const body = new THREE.Mesh(bodyGeo, paintMat);
    body.castShadow = true;
    group.add(body);

    // Seat
    const seatGeo = new THREE.BoxGeometry(0.26, 0.1, 0.7);
    seatGeo.translate(0, 0.95, -0.2);
    const seat = new THREE.Mesh(seatGeo, plasticMat);
    group.add(seat);

    // Two big wheels
    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.16, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelF = new THREE.Mesh(wheelGeo, wheelMat);
    wheelF.position.set(0, 0.34, 0.8);
    wheelF.castShadow = true;
    group.add(wheelF);

    const wheelR = new THREE.Mesh(wheelGeo, wheelMat);
    wheelR.position.set(0, 0.34, -0.8);
    wheelR.castShadow = true;
    group.add(wheelR);

    // Simple rider cylinder dummy represent
    const riderGroup = new THREE.Group();
    riderGroup.position.set(0, 0.9, -0.15);
    riderGroup.rotation.x = 0.25; // Leaning forward

    const rBodyGeo = new THREE.CylinderGeometry(0.18, 0.14, 0.7, 8);
    const rBody = new THREE.Mesh(rBodyGeo, plasticMat);
    rBody.position.y = 0.35;
    riderGroup.add(rBody);

    const rHeadGeo = new THREE.SphereGeometry(0.13, 8, 8);
    const rHead = new THREE.Mesh(rHeadGeo, paintMat);
    rHead.position.y = 0.8;
    riderGroup.add(rHead);

    group.add(riderGroup);
  }

  // Add lights and volumetric light beam cones
  attachLightingToVehicle(group, type) {
    const isMotorcycle = (type === 'motorcycle' || type === 'bicycle');
    
    // Headlights emissive bulbs
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const bulbGeo = new THREE.SphereGeometry(0.08, 8, 8);

    const headlamps = isMotorcycle ? [[0, 0.75, 0.95]] : [[-0.65, 0.45, 2.21], [0.65, 0.45, 2.21]];
    if (type === 'truck' || type === 'bus') {
      headlamps[0] = [-0.85, 0.65, 2.81];
      headlamps[1] = [0.85, 0.65, 2.81];
    }

    headlamps.forEach(([x, y, z]) => {
      const bulb = new THREE.Mesh(bulbGeo, bulbMat);
      bulb.position.set(x, y, z);
      group.add(bulb);

      // Volumetric Light Cone geometry
      // Create cone pointing forward
      const coneLength = 16;
      const coneGeo = new THREE.ConeGeometry(1.2, coneLength, 16, 1, true);
      // Align cone so tip is at origin, and pointing down Y
      coneGeo.translate(0, -coneLength / 2, 0);
      coneGeo.rotateX(Math.PI / 2); // Point along Z

      const coneMat = new THREE.MeshBasicMaterial({
        color: 0xfffdd0,
        map: this.getVolumetricConeTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.16
      });
      coneMat.name = 'headlampCone'; // Essential for theme switching to update headlight opacity!

      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.set(x, y, z + 0.1);
      group.add(cone);
    });

    // Rear Taillights (Red)
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
    const tailGeo = new THREE.SphereGeometry(0.06, 6, 6);
    
    const tailPos = isMotorcycle ? [[0, 0.9, -0.92]] : [[-0.7, 0.5, -2.21], [0.7, 0.5, -2.21]];
    if (type === 'truck' || type === 'bus') {
      tailPos[0] = [-0.95, 0.5, -3.91];
      tailPos[1] = [0.95, 0.5, -3.91];
    }

    tailPos.forEach(([x, y, z]) => {
      const tailBulb = new THREE.Mesh(tailGeo, tailMat);
      tailBulb.position.set(x, y, z);
      group.add(tailBulb);
    });
  }

  // ── Particle System Engine ─────────────────────────────────────────────────
  createExplosion(x, y, z) {
    const particleCount = 45;
    const colorChoices = [0xff4500, 0xff8c00, 0xffd700, 0xff0000]; // Fire colors

    const geo = new THREE.SphereGeometry(0.08, 5, 5);

    for (let i = 0; i < particleCount; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: colorChoices[i % colorChoices.length],
        transparent: true,
        opacity: 0.9
      });
      const p = new THREE.Mesh(geo, mat);
      p.position.set(x, y, z);

      // Random outwards vector
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos((Math.random() * 2) - 1);
      const speed = 2 + Math.random() * 5;
      
      const vx = Math.sin(phi) * Math.cos(theta) * speed;
      const vy = Math.sin(phi) * Math.sin(theta) * speed + 2; // Upwards bias
      const vz = Math.cos(phi) * speed;

      this.particles.push({
        mesh: p,
        velocity: new THREE.Vector3(vx, vy, vz),
        life: 1.0,
        decay: 0.015 + Math.random() * 0.02
      });

      this.scene.add(p);
    }

    this.exploded = true;
    this.shakeIntensity = 0.5; // Visceral impact screen shake
  }

  createSuccessSparks(x, y, z) {
    const particleCount = 40;
    const geo = new THREE.SphereGeometry(0.06, 5, 5);

    for (let i = 0; i < particleCount; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x06b6d4, // Cyan
        transparent: true,
        opacity: 0.9
      });
      const p = new THREE.Mesh(geo, mat);
      p.position.set(x, y, z);

      const speed = 1.5 + Math.random() * 3;
      const angle = Math.random() * Math.PI * 2;
      const vx = Math.cos(angle) * speed * 0.5;
      const vy = 3 + Math.random() * 4; // High upwards fountain
      const vz = Math.sin(angle) * speed * 0.5;

      this.particles.push({
        mesh: p,
        velocity: new THREE.Vector3(vx, vy, vz),
        life: 1.0,
        decay: 0.01 + Math.random() * 0.015
      });
      this.scene.add(p);
    }
  }

  updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.mesh.position.addScaledVector(p.velocity, dt);
      
      // Apply gravity
      p.velocity.y -= 9.8 * dt;

      // Diminish life
      p.life -= p.decay;
      p.mesh.material.opacity = p.life;
      p.mesh.scale.set(p.life, p.life, p.life);

      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this.particles.splice(i, 1);
      }
    }
  }

  // ── Camera views state management ──────────────────────────────────────────
  switchView(viewName) {
    this.currentView = viewName;
    if (viewName === 'orbit') {
      this.controls.enabled = true;
      this.controls.target.set(this.roadWidth / 2, 0, 0);
    } else {
      this.controls.enabled = false;
    }

    // Sync HTML button active classes
    const viewButtons = {
      orbit: document.getElementById('view-orbit-btn'),
      chase: document.getElementById('view-tpv-btn'),
      pedestrian: document.getElementById('view-fpv-btn')
    };
    Object.keys(viewButtons).forEach(view => {
      const btn = viewButtons[view];
      if (btn) {
        if (view === viewName) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });
  }

  setInteractive(value) {
    this.isInteractive = value;
    const modeAuto = document.getElementById('mode-auto-btn');
    const modePlay = document.getElementById('mode-play-btn');
    if (modeAuto && modePlay) {
      if (value) {
        modeAuto.classList.remove('active');
        modePlay.classList.add('active');
      } else {
        modePlay.classList.remove('active');
        modeAuto.classList.add('active');
      }
    }
    this.updateHUDVisibility();
  }

  updateCameraView(dt) {
    if (!this.pedestrian) return;

    const pPos = this.pedestrian.position;
    const heading = this.pedestrian.rotation.y - Math.PI / 2;

    if (this.currentView === 'pedestrian') {
      // First-Person View inside player's head
      // Q / E to look left/right (with smooth snap back)
      if (this.keysPressed.q) {
        this.fpvYaw += 3.0 * dt;
        if (this.fpvYaw > Math.PI / 1.8) this.fpvYaw = Math.PI / 1.8;
      } else if (this.keysPressed.e) {
        this.fpvYaw -= 3.0 * dt;
        if (this.fpvYaw < -Math.PI / 1.8) this.fpvYaw = -Math.PI / 1.8;
      } else {
        // smooth decay back to 0
        this.fpvYaw += (0 - this.fpvYaw) * 12.0 * dt;
      }

      this.camera.position.set(pPos.x, 1.42, pPos.z);
      const lookAngle = heading + this.fpvYaw;
      const lookTarget = new THREE.Vector3(
        pPos.x + 5.0 * Math.cos(lookAngle),
        1.42,
        pPos.z - 5.0 * Math.sin(lookAngle)
      );
      this.camera.lookAt(lookTarget);

      const leftPip = document.getElementById('sim-pip-left');
      const rightPip = document.getElementById('sim-pip-right');
      if (leftPip && rightPip && !this.playerDead && !this.playerSurvived && this.isInteractive) {
        const pipW = Math.min(180, this.width * 0.3);
        const pipH = Math.round(pipW * 0.67);
        
        leftPip.style.width = `${pipW}px`;
        leftPip.style.height = `${pipH}px`;
        leftPip.style.display = 'block';

        rightPip.style.width = `${pipW}px`;
        rightPip.style.height = `${pipH}px`;
        rightPip.style.display = 'block';
      } else {
        if (leftPip) leftPip.style.display = 'none';
        if (rightPip) rightPip.style.display = 'none';
      }
    }
    else if (this.currentView === 'chase') {
      // Third Person Follow Chase View
      const targetPos = new THREE.Vector3(
        pPos.x - 3.8 * Math.cos(heading),
        1.6,
        pPos.z + 3.8 * Math.sin(heading)
      );
      this.camera.position.lerp(targetPos, 0.15);
      
      const lookTarget = new THREE.Vector3(
        pPos.x + 2.0 * Math.cos(heading),
        1.1,
        pPos.z - 2.0 * Math.sin(heading)
      );
      this.camera.lookAt(lookTarget);

      const leftPip = document.getElementById('sim-pip-left');
      const rightPip = document.getElementById('sim-pip-right');
      if (leftPip) leftPip.style.display = 'none';
      if (rightPip) rightPip.style.display = 'none';
    } 
    else if (this.currentView === 'orbit') {
      // Handle Orbit camera screen shake on impact
      if (this.shakeIntensity > 0.01) {
        this.camera.position.x += (Math.random() - 0.5) * this.shakeIntensity;
        this.camera.position.y += (Math.random() - 0.5) * this.shakeIntensity;
        this.camera.position.z += (Math.random() - 0.5) * this.shakeIntensity;
        this.shakeIntensity *= this.shakeDecay;
      }
      this.controls.update();

      const leftPip = document.getElementById('sim-pip-left');
      const rightPip = document.getElementById('sim-pip-right');
      if (leftPip) leftPip.style.display = 'none';
      if (rightPip) rightPip.style.display = 'none';
    }
  }

  // ── Run simulation loop ────────────────────────────────────────────────────
  startSimulation(originalData) {
    this.active = true;
    this.currentTime = 0;
    
    // Create a local deep copy of the original data to prevent mutating references across runs
    const data = JSON.parse(JSON.stringify(originalData));
    this.lastSimulationData = JSON.parse(JSON.stringify(originalData));

    // Reset interactive game state
    this.playerScore = 1000;
    this.playerHearts = 3;
    this.playerDead = false;
    this.playerSurvived = false;
    this.keysPressed = { w: false, a: false, s: false, d: false, q: false, e: false };
    this.shieldActive = false;
    this.timeSlowActive = false;
    this.speedBoostActive = false;
    this.fpvYaw = 0;

    // Clear and remove path trail meshes
    this.trailPoints.forEach(pt => {
      this.scene.remove(pt.mesh);
      pt.mesh.geometry.dispose();
      pt.mesh.material.dispose();
    });
    this.trailPoints = [];

    // Hide overlays/vignettes
    const screenWasted = document.getElementById('sim-wasted-screen');
    if (screenWasted) screenWasted.style.display = 'none';
    const screenSurvived = document.getElementById('sim-survived-screen');
    if (screenSurvived) screenSurvived.style.display = 'none';
    const dangerVignette = document.getElementById('sim-danger-vignette');
    if (dangerVignette) dangerVignette.style.display = 'none';

    this.updateHUDVisibility();
    this.updateHUD();

    const slomoBadge = document.getElementById('sim-slomo-badge');
    if (slomoBadge) slomoBadge.style.display = 'none';
    this.exploded = false;
    this.collided = false;
    this.successSignaled = false;

    this.pedThrowVelocity = null;
    this.pedSpin = null;
    this.pedIsGrounded = false;

    this.actualCollisionX = 0;
    this.actualCollisionZ = 0;
    this.hitSpeed = 0;
    this.hitDirection = 1;
    this.hittingVehicleMesh = null;

    this.crossTime = data.cross_time;
    this.pedSpeed = data.ped_speed;
    this.roadWidth = data.road_width_m;
    this.numLanes = data.num_lanes;

    // Configure level dynamically in interactive mode
    if (this.isInteractive) {
      const config = {
        level1: { lanes: 2, speedMult: 0.55, theme: 'day', roadWidth: 5.2 },
        level2: { lanes: 3, speedMult: 0.85, theme: 'sunset', roadWidth: 7.2 },
        level3: { lanes: 4, speedMult: 1.15, theme: 'night', roadWidth: 9.6 },
        level4: { lanes: 3, speedMult: 0.95, theme: 'sunset', roadWidth: 7.2 }
      }[this.gameLevel] || { lanes: 3, speedMult: 1.0, theme: 'day', roadWidth: 7.2 };
      
      this.numLanes = config.lanes;
      this.roadWidth = config.roadWidth;
      this.currentTheme = config.theme;
      this.laneWidth = this.roadWidth / this.numLanes;
      
      // Speed up vehicles in this level data
      data.simulated_vehicles.forEach(v => {
        v.velocity_kmh *= config.speedMult;
        v.lane = 1 + (v.id % this.numLanes); // distribute
      });
      // Re-calculate cross time based on adjusted roadWidth and speed
      this.crossTime = this.roadWidth / this.pedSpeed;
    }

    // Fix client dimensions when initially hidden (display: none -> display: block)
    this.width = this.container.clientWidth || 400;
    this.height = this.container.clientHeight || 280;
    
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    
    this.renderer.setSize(this.width, this.height);

    // Reset controls targets
    this.controls.target.set(this.roadWidth / 2, 0.5, 0);
    this.controls.update();

    // Clear old visual objects
    this.vehicles.forEach(v => this.scene.remove(v));
    this.vehicles = [];
    this.particles.forEach(p => this.scene.remove(p.mesh));
    this.particles = [];

    // Parse collisions and pre-compute intercept data
    this.collisionsData = data.collisions || [];
    this.collisionTime = this.collisionsData.length > 0 ? this.collisionsData[0].time : null;
    this.collisionLane = this.collisionsData.length > 0 ? this.collisionsData[0].lane : null;
    this.collidingVehicleId = null;
    this.collisionInterceptX = null;

    if (this.collisionsData.length > 0) {
      const col = this.collisionsData[0];
      // Store the collision vehicle ID so we can track it specifically
      if (col.vehicle && col.vehicle.id !== undefined) {
        this.collidingVehicleId = col.vehicle.id;
      }
      this.collisionInterceptX = (col.lane - 0.5) * (data.road_width_m / data.num_lanes);

      // ── TIMELINE SHIFT FOR VISUAL REALISM ────────────────────────────────
      const t_walk = this.collisionInterceptX / data.ped_speed;
      const t_col_orig = col.time;
      const shift = t_walk - t_col_orig;

      data.simulated_vehicles.forEach(v => {
        v.t_arrival += shift;
        v.t_enter += shift;
        v.t_exit += shift;
      });

      this.collisionsData.forEach(c => {
        c.time += shift;
      });

      this.collisionTime = t_walk;
    }

    // Rebuild static meshes adjusted to new dimensions
    this.updateEnvironment(this.roadWidth, this.numLanes);

    // Build pedestrian humanoid
    this.buildPedestrian();

    // Build vehicle meshes
    this.vehiclesData = data.simulated_vehicles || [];
    this.vehiclesData.forEach(v => {
      this.buildVehicle(v);
    });

    // Spawn collectibles in game mode
    this.spawnCollectibles();

    // Apply current theme settings
    this.switchTheme(this.currentTheme);

    // Display controls toolbar outside simulation
    const controlsBar = document.getElementById('sim-controls-bar');
    if (controlsBar) controlsBar.style.display = 'flex';

    // Reset playback buttons
    const playPauseBtn = document.getElementById('sim-play-pause-btn');
    if (playPauseBtn) playPauseBtn.textContent = '\u23F8 Pause';
    this.isPlaying = true;

    // Start frame loop
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.animate();
  }

  animate() {
    if (!this.active || !this.isPlaying) return;

    // ═══════════════════════════════════════════════════════════════════════
    // 1. TIMESTEP — cinematic slow-motion for the entire collision scenario
    // ═══════════════════════════════════════════════════════════════════════
    let dt = 0.016; // 60 fps baseline
    let inSlowMotion = false;

    // If we are interactively playing, we do not auto-trigger slow motion until
    // a collision has actually occurred.
    if (!this.isInteractive && this.collisionTime !== null && !this.collided) {
      // Entire simulation runs at 12% speed (~8× slower) so pedestrian
      // walk is clearly visible from the very first frame
      dt = 0.016 * 0.12;
      inSlowMotion = true;

      const ttc = this.collisionTime - this.currentTime;

      // 1.5s before impact: ramp from 12% → 4% for dramatic buildup
      if (ttc < 1.5) {
        const ramp = Math.max(0, Math.min(1, (1.5 - ttc) / 1.5));
        dt = 0.016 * (0.12 - ramp * 0.08); // 0.12 → 0.04
      }

      // Past predicted time, collision hasn't fired yet: ultra slow
      if (ttc <= 0) {
        dt = 0.016 * 0.04;
      }
    }

    // Ragdoll flight: 6% speed so viewer can track the body tumbling
    if (this.collided && !this.pedIsGrounded) {
      dt = 0.016 * 0.06;
      inSlowMotion = true;
    }

    // Slide on ground after landing: 20% speed
    if (this.collided && this.pedIsGrounded && this.pedThrowVelocity &&
        (Math.abs(this.pedThrowVelocity.x) > 0.1 || Math.abs(this.pedThrowVelocity.z) > 0.1)) {
      dt = 0.016 * 0.20;
      inSlowMotion = true;
    }

    dt *= 0.70; // Make overall simulation somewhat slower and easier to react to

    const slomoBadge = document.getElementById('sim-slomo-badge');
    if (slomoBadge) slomoBadge.style.display = inSlowMotion ? 'flex' : 'none';

    // ═══════════════════════════════════════════════════════════════════════
    // 2. ADVANCE CLOCK
    // ═══════════════════════════════════════════════════════════════════════
    this.currentTime += dt;
    this.updateTrafficLights();

    // In Interactive Play Mode: Decay player score over time to encourage speed
    if (this.isInteractive && !this.playerDead && !this.playerSurvived) {
      this.playerScore = Math.max(0, this.playerScore - dt * 15.0);
      this.updateHUD();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 3. MOVE PEDESTRIAN (before collision check so position is current)
    // ═══════════════════════════════════════════════════════════════════════
    let pedX = 0;
    let pedZ = 0;
    
    if (this.isInteractive) {
      if (!this.collided && !this.playerDead && !this.playerSurvived) {
        let moveX = 0;
        let moveZ = 0;
        if (this.keysPressed.w) moveX += 1;
        if (this.keysPressed.s) moveX -= 1;
        if (this.keysPressed.a) moveZ -= 1;
        if (this.keysPressed.d) moveZ += 1;

        if (moveX !== 0 || moveZ !== 0) {
          const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
          moveX /= len;
          moveZ /= len;

          const currentPedSpeed = this.speedBoostActive ? this.pedSpeed * 1.5 : this.pedSpeed;
          const dx = moveX * currentPedSpeed * dt;
          const dz = moveZ * currentPedSpeed * dt;

          if (this.pedestrian) {
            this.pedestrian.position.x += dx;
            this.pedestrian.position.z += dz;

            this.pedestrian.position.x = Math.max(-2.0, Math.min(this.roadWidth + 2.0, this.pedestrian.position.x));
            this.pedestrian.position.z = Math.max(-20.0, Math.min(20.0, this.pedestrian.position.z));

            const angle = Math.atan2(-moveZ, moveX);
            this.pedestrian.rotation.y = angle + Math.PI / 2;

            this.animatePedestrianWalk(this.currentTime, currentPedSpeed);

            if (Math.random() < 0.18) {
              let trailColor = 0x06b6d4;
              if (this.shieldActive) trailColor = 0xa855f7;
              else if (this.speedBoostActive) trailColor = 0xfacc15;
              this.spawnTrailDot(this.pedestrian.position.x, this.pedestrian.position.z, trailColor);
            }
          }
        }
      }
      pedX = this.pedestrian ? this.pedestrian.position.x : 0;
      pedZ = this.pedestrian ? this.pedestrian.position.z : 0;
    } else {
      // Auto Simulation: pedestrian walks linearly across the road
      const { startX, startZ, endX, endZ } = this.getPathPoints();
      if (!this.collided) {
        if (this.currentTime < this.crossTime) {
          const ratio = this.currentTime / this.crossTime;
          pedX = startX + (endX - startX) * ratio;
          pedZ = startZ + (endZ - startZ) * ratio;
        } else {
          pedX = endX;
          pedZ = endZ;
        }
        if (this.pedestrian) {
          this.pedestrian.position.set(pedX, this.pedestrian.position.y, pedZ);
          
          const dx = endX - startX;
          const dz = endZ - startZ;
          const angle = Math.atan2(-dz, dx);
          this.pedestrian.rotation.y = angle + Math.PI / 2;
          
          if (this.currentTime < this.crossTime) {
            this.animatePedestrianWalk(this.currentTime, this.pedSpeed);
            if (Math.random() < 0.15) {
              this.spawnTrailDot(pedX, pedZ, 0x06b6d4);
            }
          }
        }
      } else {
        pedX = this.pedestrian ? this.pedestrian.position.x : 0;
        pedZ = this.pedestrian ? this.pedestrian.position.z : 0;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4. MOVE VEHICLES (update Z positions incrementally)
    // ═══════════════════════════════════════════════════════════════════════
    this.vehicles.forEach(mesh => {
      const vd = mesh.userData;
      
      let currentSpeed = vd.velocity;
      if (this.timeSlowActive) {
        currentSpeed *= 0.35;
      }
      
      let isBraking = false;
      const sameLane = Math.abs(pedX - mesh.position.x) < this.laneWidth * 0.8;
      const distToPedZ = vd.direction === 1 ? (pedZ - mesh.position.z) : (mesh.position.z - pedZ);
      
      if (!this.isInteractive && !this.collided && sameLane && distToPedZ > 0 && distToPedZ < 8.0) {
        currentSpeed = Math.max(0, currentSpeed - 12.0 * dt);
        isBraking = true;
      }
      
      mesh.position.z += vd.direction * currentSpeed * dt;
      
      this.setBrakeLights(mesh, isBraking || this.timeSlowActive);
      this.animateIndicators(mesh, distToPedZ > 0 && distToPedZ < 15.0);

      // Exhaust smoke
      if (Math.random() < 0.26 && !this.collided) {
        const pipeOffset = vd.exhaustPipe.clone();
        pipeOffset.applyMatrix4(mesh.matrixWorld);
        this.spawnSmokeParticle(pipeOffset.x, pipeOffset.y, pipeOffset.z, vd.direction);
      }

      // Wheel rotation
      const wheelRot = vd.direction * currentSpeed * dt * 2.5;
      mesh.children.forEach(child => {
        if (child.geometry && child.geometry.type === 'CylinderGeometry' && child.position.y < 0.5) {
          child.rotation.x += wheelRot;
        }
      });
    });

    // Update powerups and collectibles
    this.updateCollectibles(dt);
    this.updatePowerupHUD(dt);

    // ═══════════════════════════════════════════════════════════════════════
    // 5. COLLISION DETECTION & PROXIMITY ALERT — game or simulation checks
    // ═══════════════════════════════════════════════════════════════════════
    if (this.isInteractive) {
      if (!this.collided && !this.playerDead && !this.playerSurvived) {
        let hittingVehicle = null;

        for (let i = 0; i < this.vehicles.length; i++) {
          const mesh = this.vehicles[i];
          const vd = mesh.userData;
          const carHalfX = (vd.class === 'truck' || vd.class === 'bus') ? 1.25 : 0.9;
          const carHalfZ = (vd.class === 'truck' || vd.class === 'bus') ? 3.9 : 2.5;

          if (Math.abs(this.pedestrian.position.x - mesh.position.x) < (carHalfX + 0.38) &&
              Math.abs(mesh.position.z - this.pedestrian.position.z) < (carHalfZ + 0.32)) {
            hittingVehicle = mesh;
            break;
          }
        }

        if (hittingVehicle) {
          if (this.shieldActive) {
            this.shieldActive = false;
            this.triggerCollectionEffect(this.pedestrian.position, 'shield');
            this.showAlertHUD('🛡️ SHIELD DESTROYED!', 'rgba(239, 68, 68, 0.95)');
            
            // Push player back and push car forward
            this.pedestrian.position.x = Math.max(-1.5, this.pedestrian.position.x - 1.5);
            hittingVehicle.position.z += hittingVehicle.userData.direction * 4.0;
            this.updateHUD();
          } else {
            this.playerHearts -= 1;
            this.updateHUD();
            
            if (this.playerHearts > 0) {
              this.triggerCollectionEffect(this.pedestrian.position, 'boot');
              this.showAlertHUD('💥 HIT! RETIRED TO CURB', 'rgba(244, 63, 94, 0.95)');
              
              const { startX, startZ } = this.getPathPoints();
              this.pedestrian.position.set(startX, 0.05, startZ);
              this.fpvYaw = 0;
            } else {
              this.collided = true;
              this.playerDead = true;
              this.hittingVehicleMesh = hittingVehicle;
              this.actualCollisionX = this.pedestrian.position.x;
              this.actualCollisionZ = this.pedestrian.position.z;
              this.hitSpeed = hittingVehicle.userData.velocity;
              this.hitDirection = hittingVehicle.userData.direction;
              
              this.triggerWasted();
            }
          }
        } else {
          // Calculate Proximity sirens and near-miss points
          let nearVehicle = false;
          const warnDist = 4.8;

          for (let i = 0; i < this.vehicles.length; i++) {
            const mesh = this.vehicles[i];
            const vd = mesh.userData;
            
            const dx = Math.abs(this.pedestrian.position.x - mesh.position.x);
            const dz = Math.abs(mesh.position.z - this.pedestrian.position.z);
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < warnDist) {
              nearVehicle = true;
            }

            if (dz < 1.7 && dx < 1.35 && !vd.nearMissAwarded) {
              vd.nearMissAwarded = true;
              this.playerScore += 150;
              this.showAlertHUD('+150 NEAR MISS! 💨', 'rgba(16, 185, 129, 0.95)');
              this.updateHUD();
            }
          }

          const dangerVignette = document.getElementById('sim-danger-vignette');
          const alertBadge = document.getElementById('hud-alert-badge');
          if (dangerVignette) dangerVignette.style.display = nearVehicle ? 'block' : 'none';
          if (alertBadge) alertBadge.style.display = nearVehicle ? 'flex' : 'none';
        }
      }
    } else {
      // Auto Simulation: run standard three-layer collision predictor logic
      if (this.collisionTime !== null && !this.collided) {
        let hittingVehicle = null;

        // ── Layer 1: AABB physics overlap with ANY vehicle ──────────────────
        for (let i = 0; i < this.vehicles.length; i++) {
          const mesh = this.vehicles[i];
          const vd = mesh.userData;
          const carHalfX = (vd.class === 'truck' || vd.class === 'bus') ? 1.2 : 0.85;
          const carHalfZ = (vd.class === 'truck' || vd.class === 'bus') ? 3.8 : 2.4;

          if (Math.abs(pedX - mesh.position.x) < (carHalfX + 0.35) &&
              Math.abs(mesh.position.z - pedZ) < (carHalfZ + 0.3)) {
            hittingVehicle = mesh;
            break;
          }
        }

        // ── Layer 2: Collision-flagged vehicle reaching pedestrian Z ───────────
        if (!hittingVehicle) {
          for (let i = 0; i < this.vehicles.length; i++) {
            const mesh = this.vehicles[i];
            const vd = mesh.userData;
            if (!vd.collision) continue;

            const vehicleNearPed = Math.abs(mesh.position.z - pedZ) < 4.0;
            const laneCenter = mesh.position.x;
            const pedNearLane = Math.abs(pedX - laneCenter) < (this.laneWidth * 0.8 + 0.5);

            if (vehicleNearPed && pedNearLane) {
              hittingVehicle = mesh;
              pedX = this.collisionInterceptX || laneCenter;
              pedZ = mesh.position.z;
              if (this.pedestrian) this.pedestrian.position.set(pedX, this.pedestrian.position.y, pedZ);
              break;
            }
          }
        }

        // ── Layer 3: Guaranteed fallback after collision time + buffer ──────
        if (!hittingVehicle && this.currentTime > this.collisionTime + 0.6) {
          for (let i = 0; i < this.vehicles.length; i++) {
            const mesh = this.vehicles[i];
            if (mesh.userData.collision) {
              hittingVehicle = mesh;
              pedX = this.collisionInterceptX || mesh.position.x;
              pedZ = mesh.position.z;
              if (this.pedestrian) this.pedestrian.position.set(pedX, this.pedestrian.position.y, pedZ);
              break;
            }
          }
        }

        // ── TRIGGER COLLISION ───────────────────────────────────────────────
        if (hittingVehicle) {
          this.collided = true;
          this.hittingVehicleMesh = hittingVehicle;
          this.actualCollisionX = pedX;
          this.actualCollisionZ = pedZ;
          this.hitSpeed = hittingVehicle.userData.velocity;
          this.hitDirection = hittingVehicle.userData.direction;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6. POST-COLLISION / VICTORY METRICS — ragdoll or success screen
    // ═══════════════════════════════════════════════════════════════════════
    if (this.isInteractive) {
      if (this.collided) {
        // Run standard premium ragdoll launch sequence
        if (!this.exploded) {
          this.exploded = true;

          if (this.pedestrian) {
            this.pedestrian.position.set(this.actualCollisionX, 0.9, this.actualCollisionZ);
          }

          // Trigger blast VFX
          this.createImpactBurst(this.actualCollisionX, 0.9, this.actualCollisionZ,
                                 this.hitSpeed, this.hitDirection);

          const speed = this.hitSpeed || 8;
          const dir   = this.hitDirection || 1;
          const sideOffset = this.hittingVehicleMesh
            ? (this.actualCollisionX - this.hittingVehicleMesh.position.x) / 1.1
            : 0;

          // Ragdoll velocities
          this.pedThrowVelocity = new THREE.Vector3(
            sideOffset * speed * 0.25,
            1.8 + speed * 0.15,
            dir * speed * 0.40
          );

          const spinScale = 0.4 + speed * 0.06;
          this.pedSpin = new THREE.Vector3(
            (Math.random() > 0.5 ? 1 : -1) * spinScale * (1.5 + Math.random() * 1.5),
            (Math.random() - 0.5) * spinScale * 0.8,
            (Math.random() - 0.5) * spinScale * 1.2
          );
          this.pedIsGrounded = false;
          this.shakeIntensity = 0.45;
          this.shakeDecay = 0.92;
        }

        // Apply physical ragdoll gravity and slide tumbles
        if (this.pedThrowVelocity && this.pedestrian) {
          if (!this.pedIsGrounded) {
            this.pedThrowVelocity.y -= 18.0 * dt;

            this.pedestrian.position.x += this.pedThrowVelocity.x * dt;
            this.pedestrian.position.y += this.pedThrowVelocity.y * dt;
            this.pedestrian.position.z += this.pedThrowVelocity.z * dt;

            this.pedestrian.rotation.x += this.pedSpin.x * dt;
            this.pedestrian.rotation.y += this.pedSpin.y * dt;
            this.pedestrian.rotation.z += this.pedSpin.z * dt;
            this.pedSpin.multiplyScalar(0.97);

            if (this.pedestrian.position.y <= 0.08) {
              this.pedestrian.position.y = 0.08;
              if (Math.abs(this.pedThrowVelocity.y) > 2.5) {
                this.pedThrowVelocity.y = -this.pedThrowVelocity.y * 0.3;
                this.pedThrowVelocity.x *= 0.5;
                this.pedThrowVelocity.z *= 0.5;
                this.createGroundDust(this.pedestrian.position.x, this.pedestrian.position.z);
              } else {
                this.pedThrowVelocity.set(0, 0, 0);
                this.pedSpin.set(0, 0, 0);
                this.pedIsGrounded = true;
              }
            }
          } else {
            this.pedThrowVelocity.x *= 0.80;
            this.pedThrowVelocity.z *= 0.80;
            this.pedestrian.position.x += this.pedThrowVelocity.x * dt;
            this.pedestrian.position.z += this.pedThrowVelocity.z * dt;
            const targetRx = Math.PI / 2;
            this.pedestrian.rotation.x += (targetRx - this.pedestrian.rotation.x) * 0.25;
          }
        }
      } else if (this.pedestrian && this.pedestrian.position.x >= this.roadWidth + 0.35 && !this.playerSurvived) {
        // Player crossed safely!
        this.triggerSurvived();
      }
    } else {
      // Auto Simulation: run original simulation outcomes
      if (this.collided) {
        if (!this.exploded) {
          this.exploded = true;
          if (this.pedestrian) {
            this.pedestrian.position.set(this.actualCollisionX, 0.9, this.actualCollisionZ);
          }
          this.createImpactBurst(this.actualCollisionX, 0.9, this.actualCollisionZ,
                                 this.hitSpeed, this.hitDirection);

          const speed = this.hitSpeed || 8;
          const dir   = this.hitDirection || 1;
          const sideOffset = this.hittingVehicleMesh
            ? (this.actualCollisionX - this.hittingVehicleMesh.position.x) / 1.1
            : 0;

          this.pedThrowVelocity = new THREE.Vector3(
            sideOffset * speed * 0.25,
            1.8 + speed * 0.15,
            dir * speed * 0.40
          );

          const spinScale = 0.4 + speed * 0.06;
          this.pedSpin = new THREE.Vector3(
            (Math.random() > 0.5 ? 1 : -1) * spinScale * (1.5 + Math.random() * 1.5),
            (Math.random() - 0.5) * spinScale * 0.8,
            (Math.random() - 0.5) * spinScale * 1.2
          );
          this.pedIsGrounded = false;
          this.shakeIntensity = 0.4;
          this.shakeDecay = 0.92;
        }

        if (this.pedThrowVelocity && this.pedestrian) {
          if (!this.pedIsGrounded) {
            this.pedThrowVelocity.y -= 18.0 * dt;

            this.pedestrian.position.x += this.pedThrowVelocity.x * dt;
            this.pedestrian.position.y += this.pedThrowVelocity.y * dt;
            this.pedestrian.position.z += this.pedThrowVelocity.z * dt;

            this.pedestrian.rotation.x += this.pedSpin.x * dt;
            this.pedestrian.rotation.y += this.pedSpin.y * dt;
            this.pedestrian.rotation.z += this.pedSpin.z * dt;
            this.pedSpin.multiplyScalar(0.97);

            if (this.pedestrian.position.y <= 0.08) {
              this.pedestrian.position.y = 0.08;
              if (Math.abs(this.pedThrowVelocity.y) > 2.5) {
                this.pedThrowVelocity.y = -this.pedThrowVelocity.y * 0.3;
                this.pedThrowVelocity.x *= 0.5;
                this.pedThrowVelocity.z *= 0.5;
                this.createGroundDust(this.pedestrian.position.x, this.pedestrian.position.z);
              } else {
                this.pedThrowVelocity.set(0, 0, 0);
                this.pedSpin.set(0, 0, 0);
                this.pedIsGrounded = true;
              }
            }
          } else {
            this.pedThrowVelocity.x *= 0.80;
            this.pedThrowVelocity.z *= 0.80;
            this.pedestrian.position.x += this.pedThrowVelocity.x * dt;
            this.pedestrian.position.z += this.pedThrowVelocity.z * dt;
            const targetRx = Math.PI / 2;
            this.pedestrian.rotation.x += (targetRx - this.pedestrian.rotation.x) * 0.25;
          }
        }
      } else if (this.currentTime >= this.crossTime && this.collisionTime === null) {
        if (!this.successSignaled) {
          this.createSuccessSparks(this.roadWidth + 0.8, 0.2, 0);
          this.successSignaled = true;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 7. PARTICLES / TRAILS / CAMERA / WebGL PiP RENDERING
    // ═══════════════════════════════════════════════════════════════════════
    this.updateParticles(dt);

    // Update and fade path trail segments
    for (let i = this.trailPoints.length - 1; i >= 0; i--) {
      const pt = this.trailPoints[i];
      pt.life -= dt * 0.45; // lasts ~2.2 seconds
      if (pt.life <= 0) {
        this.scene.remove(pt.mesh);
        pt.mesh.geometry.dispose();
        pt.mesh.material.dispose();
        this.trailPoints.splice(i, 1);
      } else {
        pt.mesh.material.opacity = pt.life * 0.75;
        pt.mesh.scale.setScalar(pt.life * 0.85);
      }
    }

    this.updateCameraView(dt);

    const width = this.width;
    const height = this.height;

    // Render full canvas view using main camera
    this.renderer.setViewport(0, 0, width, height);
    this.renderer.setScissor(0, 0, width, height);
    this.renderer.setScissorTest(false);
    this.renderer.render(this.scene, this.camera);

    // Renders PIP sideviews if First-Person View is active in interactive mode
    if (this.currentView === 'pedestrian' && this.isInteractive && !this.playerDead && !this.playerSurvived) {
      this.renderer.setScissorTest(true);

      const heading = this.pedestrian.rotation.y - Math.PI / 2;
      const pipW = Math.min(180, width * 0.3);
      const pipH = Math.round(pipW * 0.67);

      // Left view: rotate 90 deg clockwise (look down negative Z)
      const leftHeading = heading + Math.PI / 2;
      this.leftCamera.position.set(this.pedestrian.position.x, 1.42, this.pedestrian.position.z);
      this.leftCamera.lookAt(
        this.pedestrian.position.x + 5.0 * Math.cos(leftHeading),
        1.42,
        this.pedestrian.position.z - 5.0 * Math.sin(leftHeading)
      );
      this.renderer.setViewport(15, height - pipH - 15, pipW, pipH);
      this.renderer.setScissor(15, height - pipH - 15, pipW, pipH);
      this.renderer.render(this.scene, this.leftCamera);

      // Right view: rotate 90 deg counter-clockwise (look down positive Z)
      const rightHeading = heading - Math.PI / 2;
      this.rightCamera.position.set(this.pedestrian.position.x, 1.42, this.pedestrian.position.z);
      this.rightCamera.lookAt(
        this.pedestrian.position.x + 5.0 * Math.cos(rightHeading),
        1.42,
        this.pedestrian.position.z - 5.0 * Math.sin(rightHeading)
      );
      this.renderer.setViewport(width - pipW - 15, height - pipH - 15, pipW, pipH);
      this.renderer.setScissor(width - pipW - 15, height - pipH - 15, pipW, pipH);
      this.renderer.render(this.scene, this.rightCamera);

      this.renderer.setScissorTest(false);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 8. LOOP CONTROL
    // ═══════════════════════════════════════════════════════════════════════
    let shouldLoop = false;
    
    if (this.isInteractive) {
      // Loop forever as long as the game is active
      shouldLoop = !this.playerDead || (this.playerDead && !this.pedIsGrounded) || (this.currentTime < this.crossTime + 10.0 && !this.playerSurvived);
    } else {
      const simMaxTime = this.crossTime + 1.2;
      const colMaxTime = this.collisionTime !== null ? this.collisionTime + 4.0 : Infinity;
      shouldLoop = this.currentTime < simMaxTime && this.currentTime < colMaxTime;
    }

    if (shouldLoop) {
      this.animationFrameId = requestAnimationFrame(() => this.animate());
    } else {
      this.isPlaying = false;
      const playPauseBtn = document.getElementById('sim-play-pause-btn');
      if (playPauseBtn) playPauseBtn.textContent = '\u25B6 Play';
    }
  }

  // ── Premium Impact Burst VFX ─────────────────────────────────────────────
  // Replaces the old basic createExplosion with a multi-layer system:
  // 1) Fire/sparks core  2) Dark smoke ring  3) Debris shards
  createImpactBurst(x, y, z, speed, dir) {
    const geo = new THREE.SphereGeometry(0.07, 5, 5);

    // --- 1) Fiery core sparks ---
    const fireColors = [0xff6600, 0xff3300, 0xffcc00, 0xff9900, 0xffffff];
    for (let i = 0; i < 60; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: fireColors[i % fireColors.length],
        transparent: true, opacity: 0.95
      });
      const p = new THREE.Mesh(geo, mat);
      p.position.set(x, y, z);

      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(Math.random() * 2 - 1);
      const spd   = 3 + Math.random() * (4 + speed * 0.4);
      this.particles.push({
        mesh: p,
        velocity: new THREE.Vector3(
          Math.sin(phi) * Math.cos(theta) * spd,
          Math.abs(Math.sin(phi) * Math.sin(theta)) * spd + 2.5,
          Math.cos(phi) * spd + dir * speed * 0.3
        ),
        life: 1.0,
        decay: 0.018 + Math.random() * 0.025
      });
      this.scene.add(p);
    }

    // --- 2) Dark smoke puffs ---
    const smokeGeo = new THREE.SphereGeometry(0.18, 5, 5);
    for (let i = 0; i < 18; i++) {
      const smokeMat = new THREE.MeshBasicMaterial({
        color: 0x222222, transparent: true, opacity: 0.55
      });
      const s = new THREE.Mesh(smokeGeo, smokeMat);
      s.position.set(x + (Math.random()-0.5)*0.4, y + Math.random()*0.5, z + (Math.random()-0.5)*0.4);
      const sv = new THREE.Vector3(
        (Math.random()-0.5) * 1.8,
        1.5 + Math.random() * 2.5,
        (Math.random()-0.5) * 1.2 + dir * 0.4
      );
      this.particles.push({ mesh: s, velocity: sv, life: 1.0, decay: 0.007 + Math.random() * 0.01 });
      this.scene.add(s);
    }

    // --- 3) Debris chunks ---
    const debrisGeo = new THREE.BoxGeometry(0.08, 0.04, 0.12);
    for (let i = 0; i < 22; i++) {
      const debrisMat = new THREE.MeshBasicMaterial({
        color: [0x666666, 0x444444, 0x888888, 0x333333][i % 4],
        transparent: true, opacity: 0.9
      });
      const d = new THREE.Mesh(debrisGeo, debrisMat);
      d.position.set(x, y, z);
      d.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
      const dspd = 2 + Math.random() * 5;
      const dtheta = Math.random() * Math.PI * 2;
      this.particles.push({
        mesh: d,
        velocity: new THREE.Vector3(
          Math.cos(dtheta) * dspd,
          1.5 + Math.random() * 3.5,
          Math.sin(dtheta) * dspd * 0.5 + dir * speed * 0.25
        ),
        life: 1.0,
        decay: 0.01 + Math.random() * 0.012
      });
      this.scene.add(d);
    }

    // Screen shake
    this.shakeIntensity = 0.65;
    this.shakeDecay     = 0.87;
  }

  // Dust puff when body hits ground
  createGroundDust(x, z) {
    const dustGeo = new THREE.SphereGeometry(0.14, 5, 5);
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xaa9977, transparent: true, opacity: 0.6
      });
      const d = new THREE.Mesh(dustGeo, mat);
      d.position.set(x + (Math.random()-0.5)*0.3, 0.1, z + (Math.random()-0.5)*0.3);
      this.particles.push({
        mesh: d,
        velocity: new THREE.Vector3(
          (Math.random()-0.5) * 2.5,
          0.4 + Math.random() * 1.2,
          (Math.random()-0.5) * 2.5
        ),
        life: 1.0,
        decay: 0.012 + Math.random() * 0.015
      });
      this.scene.add(d);
    }
  }


  resetAnimation() {
    this.currentTime = 0;
    this.collided = false;
    this.hittingVehicleMesh = null;

    // Reset interactive game parameters
    this.playerScore = 1000;
    this.playerHearts = 3;
    this.playerDead = false;
    this.playerSurvived = false;
    this.keysPressed = { w: false, a: false, s: false, d: false };

    // Clear path trail meshes
    this.trailPoints.forEach(pt => {
      this.scene.remove(pt.mesh);
      pt.mesh.geometry.dispose();
      pt.mesh.material.dispose();
    });
    this.trailPoints = [];

    // Hide overlays & indicators
    const screenWasted = this.container.querySelector('#sim-wasted-screen');
    if (screenWasted) screenWasted.style.display = 'none';
    const screenSurvived = this.container.querySelector('#sim-survived-screen');
    if (screenSurvived) screenSurvived.style.display = 'none';
    const dangerVignette = this.container.querySelector('#sim-danger-vignette');
    if (dangerVignette) dangerVignette.style.display = 'none';

    this.updateHUDVisibility();
    this.updateHUD();

    const slomoBadge = this.container.querySelector('#sim-slomo-badge');
    if (slomoBadge) slomoBadge.style.display = 'none';
    this.exploded = false;
    this.successSignaled = false;

    this.pedThrowVelocity = null;
    this.pedSpin = null;
    this.pedIsGrounded = false;

    this.actualCollisionX = 0;
    this.actualCollisionZ = 0;
    this.hitSpeed = 0;
    this.hitDirection = 1;

    // Reset particles
    this.particles.forEach(p => this.scene.remove(p.mesh));
    this.particles = [];

    // Reset vehicle positions to start
    this.vehicles.forEach(mesh => {
      const vd = mesh.userData;
      mesh.position.z = -vd.direction * vd.init_dist_m;
    });

    // Rebuild pedestrian limbs
    this.buildPedestrian();

    // Reset cameras & controls
    this.switchView(this.currentView);
    if (this.currentView === 'orbit') {
      this.camera.position.set(-12, 6, 14);
      this.controls.target.set(this.roadWidth / 2, 0.5, 0);
      this.controls.update();
    }

    // Apply current theme settings
    this.switchTheme(this.currentTheme);

    // Reset play/pause buttons
    const playPauseBtn = document.getElementById('sim-play-pause-btn');
    if (playPauseBtn) playPauseBtn.textContent = '\u23F8 Pause';
    this.isPlaying = true;

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.animate();
  }

  stop() {
    this.active = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    // Clear and remove path trail meshes
    this.trailPoints.forEach(pt => {
      this.scene.remove(pt.mesh);
      pt.mesh.geometry.dispose();
      pt.mesh.material.dispose();
    });
    this.trailPoints = [];

    // Hide overlays controls and game overlays
    const overlays = [
      this.container.querySelector('#sim-hud'),
      this.container.querySelector('#sim-controls-hud'),
      this.container.querySelector('#sim-wasted-screen'),
      this.container.querySelector('#sim-survived-screen'),
      this.container.querySelector('#sim-danger-vignette'),
      this.container.querySelector('#sim-pip-left'),
      this.container.querySelector('#sim-pip-right')
    ];
    overlays.forEach(overlay => {
      if (overlay) overlay.style.display = 'none';
    });
  }

  // ── GAME METHODS & HUD UPDATES ───────────────────────────────────────────
  updateHUDVisibility() {
    const hud = this.container.querySelector('#sim-hud');
    const controlsGuide = this.container.querySelector('#sim-controls-hud');
    if (hud) hud.style.display = (this.isInteractive && !this.playerDead && !this.playerSurvived) ? 'flex' : 'none';
    if (controlsGuide) controlsGuide.style.display = (this.isInteractive && !this.playerDead && !this.playerSurvived) ? 'flex' : 'none';
  }

  updateHUD() {
    const scoreVal = this.container.querySelector('#hud-score-val');
    if (scoreVal) {
      scoreVal.textContent = Math.round(this.playerScore);
    }
    const heartsContainer = this.container.querySelector('#hud-hearts-container');
    if (heartsContainer) {
      let heartsHtml = '';
      for (let i = 0; i < 3; i++) {
        heartsHtml += (i < this.playerHearts) ? '❤️ ' : '🖤 ';
      }
      heartsContainer.innerHTML = heartsHtml.trim();
    }
  }

  showNearMissHUD() {
    const badge = this.container.querySelector('#hud-alert-badge');
    const badgeText = this.container.querySelector('#hud-alert-text');
    if (badge && badgeText) {
      if (this.hudAlertTimeout) clearTimeout(this.hudAlertTimeout);
      badge.style.display = 'flex';
      badge.style.background = 'rgba(16, 185, 129, 0.95)'; // Green for success
      badge.style.boxShadow = '0 4px 15px rgba(16, 185, 129, 0.4)';
      badgeText.textContent = '+150 NEAR MISS!';
      
      this.hudAlertTimeout = setTimeout(() => {
        badge.style.display = 'none';
      }, 1500);
    }
  }

  triggerWasted() {
    const wastedScreen = this.container.querySelector('#sim-wasted-screen');
    if (wastedScreen) {
      wastedScreen.style.display = 'flex';
    }
    
    // Set force and speed stats
    const forceVal = this.container.querySelector('#wasted-force');
    const speedVal = this.container.querySelector('#wasted-speed');
    const speedKmh = Math.round(this.hitSpeed * 3.6);
    if (speedVal) speedVal.textContent = `${speedKmh} km/h`;
    if (forceVal) {
      // Rough physical force estimate: F = m * a where a is proportional to speed
      const forceKn = Math.round(75 * this.hitSpeed * 0.18);
      forceVal.textContent = `${forceKn} kN`;
    }
    
    // Hide standard HUD and keyboard overlays
    this.updateHUDVisibility();
    
    const dangerVignette = this.container.querySelector('#sim-danger-vignette');
    if (dangerVignette) dangerVignette.style.display = 'none';
  }

  triggerSurvived() {
    this.playerSurvived = true;
    
    const survivedScreen = this.container.querySelector('#sim-survived-screen');
    if (survivedScreen) {
      survivedScreen.style.display = 'flex';
    }
    
    // Play spark particle burst at curb destination
    this.createSuccessSparks(this.pedestrian.position.x, 0.2, this.pedestrian.position.z);
    
    const scoreVal = this.container.querySelector('#survived-score');
    if (scoreVal) {
      scoreVal.textContent = Math.round(this.playerScore);
    }
    
    let grade = 'C';
    if (this.playerScore >= 950) grade = 'S';
    else if (this.playerScore >= 800) grade = 'A';
    else if (this.playerScore >= 600) grade = 'B';

    const gradeVal = this.container.querySelector('#survived-grade');
    if (gradeVal) {
      gradeVal.textContent = grade;
      // Change color based on grade
      if (grade === 'S') {
        gradeVal.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
      } else if (grade === 'A') {
        gradeVal.style.background = 'linear-gradient(135deg, #10b981, #059669)';
      } else {
        gradeVal.style.background = 'linear-gradient(135deg, #3b82f6, #1d4ed8)';
      }
    }
    
    if (window.saveScore) {
      window.saveScore(this.playerScore, grade);
    }
    
    this.updateHUDVisibility();
    
    const dangerVignette = this.container.querySelector('#sim-danger-vignette');
    if (dangerVignette) dangerVignette.style.display = 'none';
  }

  spawnTrailDot(x, z, colorHex = 0x06b6d4) {
    const geo = new THREE.CylinderGeometry(0.18, 0.18, 0.01, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.75
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.015, z);
    this.scene.add(mesh);
    
    this.trailPoints.push({
      mesh: mesh,
      life: 1.0
    });
  }

  // ── ADVANCED GAME LEVEL / POWERUPS METHODS ─────────────────────────────────
  spawnCollectibles() {
    this.collectibles.forEach(c => this.scene.remove(c.mesh));
    this.collectibles = [];
    
    if (!this.isInteractive) return;
    
    const itemTypes = ['coin', 'shield', 'boot', 'clock'];
    const spawnCount = 6 + Math.floor(Math.random() * 3);
    
    for (let i = 0; i < spawnCount; i++) {
      const lane = 1 + Math.floor(Math.random() * this.numLanes);
      const x = (lane - 0.5) * this.laneWidth;
      
      const z = -20 + Math.random() * 40;
      if (Math.abs(z) < 2) continue;
      
      let type = 'coin';
      if (i >= 3) {
        type = itemTypes[1 + Math.floor(Math.random() * 3)];
      }
      
      let mesh = null;
      let initY = 0.5;
      
      if (type === 'coin') {
        const geo = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 12);
        geo.rotateX(Math.PI / 2);
        const mat = new THREE.MeshPhongMaterial({
          color: 0xfacc15,
          emissive: 0xd97706,
          emissiveIntensity: 0.2,
          specular: 0xffffff,
          shininess: 100
        });
        mesh = new THREE.Mesh(geo, mat);
        initY = 0.4;
      } else if (type === 'shield') {
        const geo = new THREE.OctahedronGeometry(0.22, 0);
        const mat = new THREE.MeshPhongMaterial({
          color: 0xa855f7,
          emissive: 0x7e22ce,
          emissiveIntensity: 0.3,
          specular: 0xffffff,
          shininess: 80
        });
        mesh = new THREE.Mesh(geo, mat);
        initY = 0.45;
      } else if (type === 'boot') {
        const geo = new THREE.ConeGeometry(0.16, 0.3, 8);
        geo.rotateX(Math.PI / 2);
        const mat = new THREE.MeshPhongMaterial({
          color: 0xf97316,
          emissive: 0xc2410c,
          emissiveIntensity: 0.3,
          specular: 0xffffff,
          shininess: 80
        });
        mesh = new THREE.Mesh(geo, mat);
        initY = 0.45;
      } else if (type === 'clock') {
        const geo = new THREE.TorusGeometry(0.15, 0.05, 8, 16);
        const mat = new THREE.MeshPhongMaterial({
          color: 0x06b6d4,
          emissive: 0x0e7490,
          emissiveIntensity: 0.3,
          specular: 0xffffff,
          shininess: 80
        });
        mesh = new THREE.Mesh(geo, mat);
        initY = 0.45;
      }
      
      if (mesh) {
        mesh.position.set(x, initY, z);
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.collectibles.push({
          mesh: mesh,
          type: type,
          initY: initY,
          rotSpeed: 1.5 + Math.random() * 1.5
        });
      }
    }
  }

  updateCollectibles(dt) {
    if (!this.pedestrian || !this.isInteractive || this.playerDead || this.playerSurvived) return;
    
    const pPos = this.pedestrian.position;
    
    for (let i = this.collectibles.length - 1; i >= 0; i--) {
      const col = this.collectibles[i];
      col.mesh.rotation.y += col.rotSpeed * dt;
      col.mesh.position.y = col.initY + Math.sin(this.currentTime * 3.5) * 0.08;
      
      const dist = col.mesh.position.distanceTo(pPos);
      if (dist < 0.8) {
        this.triggerCollectionEffect(col.mesh.position, col.type);
        
        if (col.type === 'coin') {
          this.playerScore += 200;
          this.showAlertHUD('+200 COIN! 💰', 'rgba(245, 158, 11, 0.95)');
        } else if (col.type === 'shield') {
          this.shieldActive = true;
          if (this.shieldMesh) this.shieldMesh.material.opacity = 0.45;
          this.showAlertHUD('SHIELD ACTIVE! 🛡️', 'rgba(168, 85, 247, 0.95)');
        } else if (col.type === 'boot') {
          this.speedBoostActive = true;
          this.speedBoostTimer = 3.0;
          this.showAlertHUD('SPEED BOOST! ⚡', 'rgba(249, 115, 22, 0.95)');
        } else if (col.type === 'clock') {
          this.timeSlowActive = true;
          this.timeSlowTimer = 4.0;
          this.showAlertHUD('TIME FREEEZE! ⏰', 'rgba(6, 182, 212, 0.95)');
        }
        
        this.updateHUD();
        
        this.scene.remove(col.mesh);
        col.mesh.geometry.dispose();
        col.mesh.material.dispose();
        this.collectibles.splice(i, 1);
      }
    }
  }

  triggerCollectionEffect(pos, type) {
    const particleCount = 15;
    const geo = new THREE.SphereGeometry(0.04, 4, 4);
    let color = 0xfacc15;
    if (type === 'shield') color = 0xa855f7;
    else if (type === 'boot') color = 0xf97316;
    else if (type === 'clock') color = 0x06b6d4;
    
    const mat = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.9 });
    
    for (let i = 0; i < particleCount; i++) {
      const p = new THREE.Mesh(geo, mat);
      p.position.copy(pos);
      
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.0 + Math.random() * 2.0;
      
      this.particles.push({
        mesh: p,
        velocity: new THREE.Vector3(
          Math.cos(angle) * speed * 0.4,
          2.0 + Math.random() * 2.0,
          Math.sin(angle) * speed * 0.4
        ),
        life: 1.0,
        decay: 0.02 + Math.random() * 0.03
      });
      this.scene.add(p);
    }
  }

  showAlertHUD(text, background) {
    const badge = this.container.querySelector('#hud-alert-badge');
    const badgeText = this.container.querySelector('#hud-alert-text');
    if (badge && badgeText) {
      if (this.hudAlertTimeout) clearTimeout(this.hudAlertTimeout);
      badge.style.display = 'flex';
      badge.style.background = background || 'rgba(16, 185, 129, 0.95)';
      badge.style.boxShadow = `0 4px 15px ${background ? background.replace('0.95', '0.4') : 'rgba(16, 185, 129, 0.4)'}`;
      badgeText.textContent = text;
      
      this.hudAlertTimeout = setTimeout(() => {
        badge.style.display = 'none';
      }, 1500);
    }
  }

  updatePowerupHUD(dt) {
    const powerupBadge = this.container.querySelector('#hud-powerup-badge');
    const powerupText = this.container.querySelector('#hud-powerup-text');
    const powerupTimer = this.container.querySelector('#hud-powerup-timer');
    const powerupIcon = this.container.querySelector('#hud-powerup-icon');
    
    let activePowerup = null;
    let activeTime = 0;
    let activeIcon = '⚡';
    
    if (this.speedBoostActive) {
      this.speedBoostTimer -= dt;
      if (this.speedBoostTimer <= 0) {
        this.speedBoostActive = false;
      } else {
        activePowerup = 'SPEED BOOST';
        activeTime = this.speedBoostTimer;
        activeIcon = '⚡';
      }
    }
    
    if (this.timeSlowActive) {
      this.timeSlowTimer -= dt;
      if (this.timeSlowTimer <= 0) {
        this.timeSlowActive = false;
      } else {
        activePowerup = 'TIME FREEZE';
        activeTime = this.timeSlowTimer;
        activeIcon = '⏰';
      }
    }
    
    if (activePowerup) {
      if (powerupBadge && powerupText && powerupTimer && powerupIcon) {
        powerupBadge.style.display = 'flex';
        powerupText.textContent = activePowerup;
        powerupTimer.textContent = `${activeTime.toFixed(1)}s`;
        powerupIcon.textContent = activeIcon;
      }
    } else {
      if (powerupBadge) {
        powerupBadge.style.display = 'none';
      }
    }
    
    if (this.shieldMesh) {
      if (this.shieldActive) {
        this.shieldMesh.rotation.y += 2.0 * dt;
        this.shieldMesh.rotation.z += 1.0 * dt;
        this.shieldMesh.material.opacity = 0.35 + Math.sin(this.currentTime * 5.0) * 0.1;
      } else {
        this.shieldMesh.material.opacity = 0.0;
      }
    }
  }

  setBrakeLights(mesh, on) {
    mesh.children.forEach(child => {
      if (child.material) {
        // Red spheres are tail lights
        if (child.geometry && child.geometry.type === 'SphereGeometry' && child.position.z < 0) {
          child.material.color.setHex(on ? 0xff0000 : 0xbe123c);
        }
      }
    });
  }

  animateIndicators(mesh, on) {
    if (!on) return;
    const flash = Math.floor(this.currentTime / 0.4) % 2 === 0;
    mesh.children.forEach(child => {
      if (child.geometry && child.geometry.type === 'SphereGeometry') {
        // Front indicators: z > 0 and x offset > 0.5
        if (child.position.z > 0 && Math.abs(child.position.x) > 0.5) {
          child.material.color.setHex(flash ? 0xeab308 : 0xffffff);
        }
      }
    });
  }

  restartSimulation() {
    if (this.lastSimulationData) {
      this.startSimulation(this.lastSimulationData);
    }
  }
}

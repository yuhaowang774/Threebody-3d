import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const YOSHIDA = (() => {
  const w1 = 1 / (2 - Math.pow(2, 1 / 3));
  return [w1, w1, 1 - 2 * w1, w1];
})();

const TRAIL_VERTEX_SHADER = `
attribute vec3 color;
varying vec3 vColor;
void main() {
  vColor = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TRAIL_FRAGMENT_SHADER = `
uniform vec3 baseColor;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;

function createTrailMaterial(colorHex) {
  return new THREE.ShaderMaterial({
    uniforms: {
      baseColor: { value: new THREE.Color(colorHex) },
    },
    vertexShader: TRAIL_VERTEX_SHADER,
    fragmentShader: TRAIL_FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

function flashButton(btn) {
  btn.style.background = "linear-gradient(135deg, #2a5a2a 0%, #1a4a1a 100%)";
  btn.style.borderColor = "#4caf50";
  btn.style.color = "#fff";
  setTimeout(() => {
    btn.style.background = "";
    btn.style.borderColor = "";
    btn.style.color = "";
  }, 200);
}

function syncUI(mapping) {
  for (const [id, value, formatter] of mapping) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = value;
    if (id.endsWith("Val")) {
      el.textContent = formatter ? formatter(value) : value;
    }
  }
}

class GravityCage3D {
  constructor(config = {}) {
    this.enabled = config.enabled || false;
    this.boundaryRadius = config.boundaryRadius || 1600;
    this.warningRadius = config.warningRadius || 700;
    this.strength = config.strength || 1.0;
    this.exponent = config.exponent || 4;
    this.softening = config.softening || 0.001;
    this.maxMultiplier = config.maxMultiplier || 100;
    this.dampingFactor = config.dampingFactor || 0.1;
    this.center = { x: 0, y: 0, z: 0 };
    this.cageEnergy = 0;
    this.showBoundaries = false;
    this.userShowBoundaries = false;
    this.boundaryHideTimer = null;
  }

  showBoundariesTemporarily() {
    if (this.userShowBoundaries) return;
    this.showBoundaries = true;
    if (this.boundaryHideTimer) {
      clearTimeout(this.boundaryHideTimer);
    }
    this.boundaryHideTimer = setTimeout(() => {
      if (!this.userShowBoundaries) {
        this.showBoundaries = false;
      }
    }, 5000);
  }

  setUserShowBoundaries(show) {
    this.userShowBoundaries = show;
    this.showBoundaries = show;
    if (show && this.boundaryHideTimer) {
      clearTimeout(this.boundaryHideTimer);
      this.boundaryHideTimer = null;
    }
  }

  updateCenter(com) {
    this.center.x = com.x;
    this.center.y = com.y;
    this.center.z = com.z;
  }

  computeDistance(body, displayScale) {
    const dx = (body.x - this.center.x) / displayScale;
    const dy = (body.y - this.center.y) / displayScale;
    const dz = (body.z - this.center.z) / displayScale;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  computeDamping(body, displayScale) {
    if (!this.enabled) return { dampingX: 0, dampingY: 0, dampingZ: 0 };
    const r = this.computeDistance(body, displayScale);
    const boundaryR = this.boundaryRadius / displayScale;
    const warningR = this.warningRadius / displayScale;
    if (r < warningR) return { dampingX: 0, dampingY: 0, dampingZ: 0 };
    const effectiveR = r - warningR;
    const effectiveBoundary = boundaryR - warningR;
    const ratio = effectiveR / effectiveBoundary;
    const dampingStrength = this.dampingFactor * Math.pow(ratio, 2);
    return {
      dampingX: -dampingStrength * body.dx,
      dampingY: -dampingStrength * body.dy,
      dampingZ: -dampingStrength * body.dz,
    };
  }

  computePotential(body, displayScale) {
    if (!this.enabled) return 0;
    const r = this.computeDistance(body, displayScale);
    const boundaryR = this.boundaryRadius / displayScale;
    const warningR = this.warningRadius / displayScale;
    if (r < warningR) return 0;
    const rNorm = r / boundaryR;
    if (rNorm >= 1 - this.softening) {
      return this.strength * body.m * this.maxMultiplier;
    }
    const effectiveR = r - warningR;
    const effectiveBoundary = boundaryR - warningR;
    const effectiveRNorm = effectiveR / effectiveBoundary;
    const factor =
      Math.pow(effectiveRNorm, this.exponent) /
      (1 - Math.pow(effectiveRNorm, this.exponent) + this.softening);
    return this.strength * body.m * Math.min(factor, this.maxMultiplier);
  }

  computeAcceleration(body, displayScale) {
    if (!this.enabled) return { ax: 0, ay: 0, az: 0 };
    const dx = (body.x - this.center.x) / displayScale;
    const dy = (body.y - this.center.y) / displayScale;
    const dz = (body.z - this.center.z) / displayScale;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r < 1e-10) return { ax: 0, ay: 0, az: 0 };
    const boundaryR = this.boundaryRadius / displayScale;
    const warningR = this.warningRadius / displayScale;
    const rNorm = r / boundaryR;
    if (r < warningR) return { ax: 0, ay: 0, az: 0 };
    if (rNorm >= 1 - this.softening) {
      const forceMag = (this.strength * this.maxMultiplier) / r;
      return {
        ax: (-forceMag * dx) / r,
        ay: (-forceMag * dy) / r,
        az: (-forceMag * dz) / r,
      };
    }
    const effectiveR = r - warningR;
    const effectiveBoundary = boundaryR - warningR;
    const effectiveRNorm = effectiveR / effectiveBoundary;
    const rNormExp = Math.pow(effectiveRNorm, this.exponent - 1);
    const denom = 1 - Math.pow(effectiveRNorm, this.exponent) + this.softening;
    const denomSq = denom * denom;
    const factor = (this.exponent * rNormExp) / effectiveBoundary / denomSq;
    const forceMag = this.strength * Math.min(factor, this.maxMultiplier / r);
    return { ax: -forceMag * dx, ay: -forceMag * dy, az: -forceMag * dz };
  }

  computeTotalCageEnergy(bodies, displayScale) {
    if (!this.enabled) return 0;
    let total = 0;
    for (const body of bodies) {
      total += this.computePotential(body, displayScale);
    }
    this.cageEnergy = total;
    return total;
  }

  getBoundaryStatus(body, displayScale) {
    const r = this.computeDistance(body, displayScale);
    const boundaryR = this.boundaryRadius / displayScale;
    const warningR = this.warningRadius / displayScale;
    const rNorm = r / boundaryR;
    const wNorm = r / warningR;
    if (rNorm >= 1 - this.softening) return "critical";
    if (rNorm >= 0.9) return "danger";
    if (wNorm >= 1) return "warning";
    return "safe";
  }
}

function calcKineticEnergy(m, vx, vy, vz) {
  return 0.5 * m * (vx * vx + vy * vy + vz * vz);
}

function calcPotentialEnergy(m1, m2, distance, G) {
  return (-G * m1 * m2) / distance;
}

function calcAngularMomentum3D(
  m,
  x,
  y,
  z,
  vx,
  vy,
  vz,
  centerX,
  centerY,
  centerZ,
) {
  const rx = x - centerX;
  const ry = y - centerY;
  const rz = z - centerZ;
  const Lx = m * (ry * vz - rz * vy);
  const Ly = m * (rz * vx - rx * vz);
  const Lz = m * (rx * vy - ry * vx);
  return Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz);
}

function calcSystemAngularMomentum3D(bodies, centerX, centerY, centerZ) {
  let L = 0;
  for (const b of bodies) {
    L += calcAngularMomentum3D(
      b.m,
      b.x,
      b.y,
      b.z,
      b.dx,
      b.dy,
      b.dz,
      centerX,
      centerY,
      centerZ,
    );
  }
  return L;
}

function calcSystemEnergy3D(bodies, G, displayScale) {
  let kinetic = 0;
  let potential = 0;
  for (let i = 0; i < bodies.length; i++) {
    kinetic += calcKineticEnergy(
      bodies[i].m,
      bodies[i].dx,
      bodies[i].dy,
      bodies[i].dz,
    );
    for (let j = i + 1; j < bodies.length; j++) {
      const dx = (bodies[j].x - bodies[i].x) / displayScale;
      const dy = (bodies[j].y - bodies[i].y) / displayScale;
      const dz = (bodies[j].z - bodies[i].z) / displayScale;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      potential += calcPotentialEnergy(bodies[i].m, bodies[j].m, dist, G);
    }
  }
  return { kinetic, potential, total: kinetic + potential };
}

const createBody = (x, y, z, dx, dy, dz, m, textureIndex, type = "star") => ({
  x,
  y,
  z,
  dx,
  dy,
  dz,
  m,
  r: type === "planet" ? 3 + m * 10 : 5 + m * 2,
  textureIndex,
  type,
});

class CircularTrail3D {
  constructor(maxLength) {
    this.xs = new Float64Array(maxLength);
    this.ys = new Float64Array(maxLength);
    this.zs = new Float64Array(maxLength);
    this.maxLength = maxLength;
    this.head = 0;
    this.count = 0;
  }
  push(x, y, z) {
    if (this.count < this.maxLength) {
      this.xs[this.count] = x;
      this.ys[this.count] = y;
      this.zs[this.count] = z;
      this.count++;
    } else {
      this.xs[this.head] = x;
      this.ys[this.head] = y;
      this.zs[this.head] = z;
      this.head = (this.head + 1) % this.maxLength;
    }
  }
  get length() {
    return this.count;
  }
  clear() {
    this.head = 0;
    this.count = 0;
  }
  resize(newMaxLength) {
    if (newMaxLength === this.maxLength) return;
    const newXs = new Float64Array(newMaxLength);
    const newYs = new Float64Array(newMaxLength);
    const newZs = new Float64Array(newMaxLength);
    const copyCount = Math.min(this.count, newMaxLength);
    const startOffset =
      this.count > newMaxLength ? this.count - newMaxLength : 0;
    for (let i = 0; i < copyCount; i++) {
      const srcIdx = (this.head + startOffset + i) % this.count;
      newXs[i] = this.xs[srcIdx];
      newYs[i] = this.ys[srcIdx];
      newZs[i] = this.zs[srcIdx];
    }
    this.xs = newXs;
    this.ys = newYs;
    this.zs = newZs;
    this.maxLength = newMaxLength;
    this.head = 0;
    this.count = copyCount;
  }
}

class NBodySim3D {
  constructor(container, bodies, G = 1, displayScale = 200) {
    Object.assign(this, {
      container,
      bodies,
      G,
      displayScale,
      dt: 0.001,
      speedMultiplier: 1,
      showCom: false,
      showTrail: true,
      useMinDist: true,
      enableCollision: false,
      timer: null,
      running: false,
      totalTime: 0,
      trailLength: 1000,
      trails: bodies.map(() => new CircularTrail3D(1000)),
      domUpdateCounter: 0,
      domElements: {
        timeDisplay: null,
        cageEnergy: null,
        nearestBodyStatus: null,
      },
      trailColors: [],
      autoZoom: {
        enabled: true,
        sensitivity: 0.01,
        minDistance: 50,
        maxDistance: 30000,
        padding: 2,
        smoothing: 0.1,
      },
      autoRotate: {
        enabled: true,
        speed: 1,
        minSpeed: 0.5,
        maxSpeed: 5,
        minAngle: null,
        maxAngle: null,
        currentAngle: 0,
      },
      mouseFollow: {
        enabled: false,
        sensitivity: 0.3,
        maxOffsetX: 200,
        maxOffsetY: 150,
        smoothing: 0.08,
        targetX: 0,
        targetY: 0,
        currentX: 0,
        currentY: 0,
      },
      cachedCom: { x: 0, y: 0, z: 0 },
    });

    this._tmpVec3a = new THREE.Vector3();
    this._tmpVec3b = new THREE.Vector3();
    this._tmpVec3c = new THREE.Vector3();
    this._tmpColor = new THREE.Color();

    this.loadingManager = new THREE.LoadingManager();
    this.setupLoadingUI();

    this.initThreeJS();
    this.initDomElements();
    this.initTrailColors();
    this.initTrailMeshes();
    this.initBodyMeshes();
    this.initDustField();
    this.initGravityCageMesh();
    this.initComMesh();
    this.gravityCage = new GravityCage3D({
      enabled: true,
      boundaryRadius: 1600,
      warningRadius: 700,
      strength: 1.0,
      exponent: 4,
      softening: 0.001,
      maxMultiplier: 100,
    });
    const initCom = this.computeCenterOfMass();
    this.gravityCage.updateCenter(initCom);
    this.initState = JSON.parse(JSON.stringify(bodies));
    this.initEvents();

    try {
      this.physicsWorker = new Worker(new URL('./physics-worker.js', import.meta.url));
      this._stepResolve = null;
      this.physicsWorker.onmessage = (e) => {
        const { positions, velocities } = e.data;
        const posArr = new Float32Array(positions);
        const velArr = new Float32Array(velocities);
        const n = this.bodies.length;
        for (let i = 0; i < n; i++) {
          this.bodies[i].x = posArr[i * 3];
          this.bodies[i].y = posArr[i * 3 + 1];
          this.bodies[i].z = posArr[i * 3 + 2];
          this.bodies[i].dx = velArr[i * 3];
          this.bodies[i].dy = velArr[i * 3 + 1];
          this.bodies[i].dz = velArr[i * 3 + 2];
        }
        this.totalTime += this.dt;
        this.updateTrails();
        if (this.enableCollision) {
          this.checkCollisions();
        }
        this.cachedCom = this.computeCenterOfMass();
        if (this._stepResolve) {
          const resolve = this._stepResolve;
          this._stepResolve = null;
          resolve();
        }
      };
      this.physicsWorker.onerror = (e) => {
        console.error("Physics worker error, falling back to sync:", e);
        this.physicsWorker = null;
      };
    } catch (e) {
      console.error("Failed to create physics worker, using sync fallback:", e);
      this.physicsWorker = null;
    }
  }

  setupLoadingUI() {
    const overlay = document.getElementById("loading-overlay");
    const trackFill = document.getElementById("loaderTrackFill");
    const percent = document.getElementById("loaderPercent");
    const status = document.getElementById("loaderStatus");

    // 手动统计核心贴图（背景1 + 天体4 = 5 张），不依赖 LoadingManager 的自动计数，
    // 避免单张挂起/干扰导致进度永久卡住。
    this._texTotal = 5;
    this._texLoaded = 0;
    this._texDone = false;
    this._loadStart = Date.now();
    this._minDuration = 2000; // 加载动画最短显示时长（ms）

    this.updateLoader = () => {
      const p = Math.min(100, Math.round((this._texLoaded / this._texTotal) * 100));
      if (trackFill) trackFill.style.width = p + "%";
      if (percent) percent.textContent = String(p).padStart(2, "0") + "%";
    };
    this.onTextureSettled = () => {
      this._texLoaded++;
      this.updateLoader();
      if (this._texLoaded >= this._texTotal && !this._texDone) {
        this._texDone = true;
        if (status) status.textContent = "READY";
        // 保证动画至少显示 _minDuration 秒：已用时间不足则延迟补足
        const elapsed = Date.now() - this._loadStart;
        const delay = Math.max(400, this._minDuration - elapsed);
        setTimeout(() => overlay && overlay.classList.add("hidden"), delay);
      }
    };
  }

  initThreeJS() {
    this.scene = new THREE.Scene();

    const textureLoader = new THREE.TextureLoader(this.loadingManager);
    textureLoader.load(
      "medres/eso0932a.webp",
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const bgGeometry = new THREE.SphereGeometry(50000, 64, 64);
        const bgMaterial = new THREE.MeshBasicMaterial({
          map: texture,
          side: THREE.BackSide,
          color: 0x444444,
        });
        const bgMesh = new THREE.Mesh(bgGeometry, bgMaterial);
        this.scene.add(bgMesh);
        if (this.onTextureSettled) this.onTextureSettled();
      },
      undefined,
      (err) => {
        console.error("背景纹理加载失败: medres/eso0932a.webp", err);
        if (this.onTextureSettled) this.onTextureSettled();
      },
    );

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      100000,
    );
    this.camera.position.set(0, 0, 800);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.5;
    this.container.appendChild(this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer);
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.5,
      0.4,
      0.85,
    );
    bloomPass.threshold = 0.1;
    bloomPass.strength = 2.0;
    bloomPass.radius = 0.5;
    this.composer.addPass(bloomPass);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 50000;

    const ambientLight = new THREE.AmbientLight(0x333333);
    this.scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0xffffff, 1, 0, 0.5);
    pointLight.position.set(0, 0, 0);
    this.scene.add(pointLight);
  }

  initDomElements() {
    const ids = [
      "timeDisplay",
      "cageEnergy",
      "nearestBodyStatus",
      "kineticEnergy",
      "potentialEnergy",
      "totalEnergy",
      "angularMomentum",
    ];
    for (const id of ids) {
      this.domElements[id] = document.getElementById(id);
    }
  }

  initTrailColors() {
    this.trailColors = [0xffcc00, 0xff3333, 0xaaccff, 0x00ffaa];
  }

  initTrailMeshes() {
    this.trailMeshes = [];
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      const colorIndex = body.type === "planet" ? 3 : i;
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(this.trailLength * 3);
      const colors = new Float32Array(this.trailLength * 3);
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometry.setDrawRange(0, 0);

      const material = createTrailMaterial(this.trailColors[colorIndex]);

      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      this.scene.add(line);
      this.trailMeshes.push(line);
    }
  }

  loadBodyTextures() {
    const textureLoader = new THREE.TextureLoader(this.loadingManager);
    const texturePaths = [
      "medres/ostar-6.webp",
      "medres/mstar-5.webp",
      "medres/kstar-4.webp",
      "medres/mars.webp",
    ];

    this.bodyTextures = [];
    this.textureColors = [0xffcc00, 0xff3333, 0xaaccff, 0x00ffaa];

    for (let i = 0; i < texturePaths.length; i++) {
      const texture = textureLoader.load(
        texturePaths[i],
        () => {
          if (this.onTextureSettled) this.onTextureSettled();
        },
        undefined,
        (err) => {
          console.error(`天体纹理加载失败: ${texturePaths[i]}`, err);
          if (this.onTextureSettled) this.onTextureSettled();
        },
      );
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      this.bodyTextures.push(texture);

      this.extractTextureColor(texturePaths[i], i);
    }
  }

  extractTextureColor(path, index) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = path;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = 32;
      canvas.height = 32;
      ctx.drawImage(img, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      let r = 0,
        g = 0,
        b = 0,
        count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a > 128) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count++;
        }
      }
      if (count > 0) {
        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);
        const color = (r << 16) | (g << 8) | b;
        this.textureColors[index] = color;
        this.trailColors[index] = color;
        if (this.trailMeshes[index]) {
          this.trailMeshes[index].material.uniforms.baseColor.value.setHex(
            color,
          );
        }
        if (this.bodyMeshes[index]) {
          this.bodyMeshes[index].material.color.setHex(color);
        }
      }
    };
  }

  initBodyMeshes() {
    this.bodyMeshes = [];
    this.loadBodyTextures();

    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      const radius = body.r;
      const textureIndex = body.type === "planet" ? 3 : i;
      const color = new THREE.Color(
        this.textureColors[textureIndex] || 0xffffff,
      );

      const geometry = new THREE.SphereGeometry(radius, 32, 32);
      const material = new THREE.MeshBasicMaterial({
        map: this.bodyTextures[textureIndex] || null,
        color: color,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(body.x, body.y, body.z);

      this.scene.add(mesh);
      this.bodyMeshes.push(mesh);
    }
  }

  initDustField() {
    this.dustConfig = {
      enabled: true,
      layerCounts: [1200, 800, 500],
      driftSpeed: 1,
      opacityMultiplier: 1,
      sizeMultiplier: 3,
      lightIntensity: 3.0,
      maxViewDistance: 2500,
    };

    const dustLayers = [
      {
        count: this.dustConfig.layerCounts[0],
        minRadius: 300,
        maxRadius: 2500,
        baseSize: 1.8,
        opacity: 0.35,
        turbulence: 0.8,
      },
      {
        count: this.dustConfig.layerCounts[1],
        minRadius: 2500,
        maxRadius: 7000,
        baseSize: 2.5,
        opacity: 0.25,
        turbulence: 0.5,
      },
      {
        count: this.dustConfig.layerCounts[2],
        minRadius: 7000,
        maxRadius: 12000,
        baseSize: 3.2,
        opacity: 0.15,
        turbulence: 0.3,
      },
    ];

    this.dustParticles = [];
    this.dustTime = 0;

    dustLayers.forEach((layer, layerIndex) => {
      const count = layer.count;
      const positions = new Float32Array(count * 3);
      const sizes = new Float32Array(count);
      const alphas = new Float32Array(count);
      const randoms = new Float32Array(count * 4);
      const velX = new Float32Array(count);
      const velY = new Float32Array(count);
      const velZ = new Float32Array(count);
      const noiseOffsetX = new Float32Array(count);
      const noiseOffsetY = new Float32Array(count);
      const noiseOffsetZ = new Float32Array(count);
      const turbulenceScale = new Float32Array(count);

      for (let i = 0; i < count; i++) {
        const radius =
          layer.minRadius +
          Math.pow(Math.random(), 0.7) * (layer.maxRadius - layer.minRadius);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);

        positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = radius * Math.cos(phi);

        const sizeVariation = Math.pow(Math.random(), 0.5);
        sizes[i] = layer.baseSize * (0.3 + sizeVariation * 1.2);

        const alphaVariation = 0.2 + Math.random() * 0.8;
        alphas[i] = layer.opacity * alphaVariation;

        randoms[i * 4] = Math.random();
        randoms[i * 4 + 1] = Math.random();
        randoms[i * 4 + 2] = Math.random();
        randoms[i * 4 + 3] = Math.random() * Math.PI * 2;

        velX[i] = (Math.random() - 0.5) * 0.015 * layer.turbulence;
        velY[i] = (Math.random() - 0.5) * 0.015 * layer.turbulence;
        velZ[i] = (Math.random() - 0.5) * 0.015 * layer.turbulence;
        noiseOffsetX[i] = Math.random() * 1000;
        noiseOffsetY[i] = Math.random() * 1000;
        noiseOffsetZ[i] = Math.random() * 1000;
        turbulenceScale[i] = 0.3 + Math.random() * 0.7;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
      geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
      geometry.setAttribute("alpha", new THREE.BufferAttribute(alphas, 1));
      geometry.setAttribute("random", new THREE.BufferAttribute(randoms, 4));

      const material = new THREE.ShaderMaterial({
        uniforms: {
          time: { value: 0 },
          cameraPos: { value: new THREE.Vector3() },
          lightPos: { value: new THREE.Vector3(0, 0, 0) },
          opacityMultiplier: { value: 1.0 },
          sizeMultiplier: { value: 1.0 },
          lightIntensity: { value: 1.0 },
          maxViewDistance: { value: 2500.0 },
        },
        vertexShader: `
attribute float size;
attribute float alpha;
attribute vec4 random;
varying float vAlpha;
varying vec3 vWorldPos;
varying float vDist;
varying vec3 vNormal;
varying float vRandom;
uniform vec3 cameraPos;
uniform vec3 lightPos;
uniform float sizeMultiplier;
uniform float time;
uniform float maxViewDistance;

float hash(vec2 p) {
return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
vec2 i = floor(p);
vec2 f = fract(p);
f = f * f * (3.0 - 2.0 * f);
float a = hash(i);
float b = hash(i + vec2(1.0, 0.0));
float c = hash(i + vec2(0.0, 1.0));
float d = hash(i + vec2(1.0, 1.0));
return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
vRandom = random.x;
vec3 pos = position;

float n = noise(pos.xy * 0.01 + time * 0.1);
pos += vec3(n - 0.5, noise(pos.yz * 0.01 + time * 0.08) - 0.5, noise(pos.xz * 0.01 + time * 0.12) - 0.5) * 50.0;

vWorldPos = pos;
vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
float dist = length(pos - cameraPos);
vDist = dist;

if (dist > maxViewDistance) {
gl_Position = vec4(-1000.0, -1000.0, -1000.0, 1.0);
gl_PointSize = 0.0;
return;
}

float fadeStart = maxViewDistance * 0.3;
float depthFade = 1.0 - smoothstep(fadeStart, maxViewDistance, dist);
vAlpha = alpha * depthFade;

vec3 toLight = normalize(lightPos - pos);
vec3 toCamera = normalize(cameraPos - pos);
vNormal = normalize(cross(toLight, toCamera));

float baseSize = size * sizeMultiplier;
float sizeVariation = 0.8 + noise(pos.xy * 0.005 + time * 0.05) * 0.4;
gl_PointSize = baseSize * sizeVariation * (350.0 / -mvPosition.z);
gl_PointSize = clamp(gl_PointSize, 0.5, 15.0);

gl_Position = projectionMatrix * mvPosition;
}
`,
        fragmentShader: `
varying float vAlpha;
varying vec3 vWorldPos;
varying float vDist;
varying vec3 vNormal;
varying float vRandom;
uniform vec3 cameraPos;
uniform vec3 lightPos;
uniform float opacityMultiplier;
uniform float lightIntensity;
uniform float time;

float hash(float n) {
return fract(sin(n) * 43758.5453);
}

void main() {
vec2 center = gl_PointCoord - vec2(0.5);
float dist = length(center);
if (dist > 0.5) discard;

vec3 toLight = normalize(lightPos - vWorldPos);
vec3 toCamera = normalize(cameraPos - vWorldPos);
vec3 halfVec = normalize(toLight + toCamera);

float NdotL = max(dot(vNormal, toLight), 0.0);
float NdotH = max(dot(vNormal, halfVec), 0.0);
float specular = pow(NdotH, 32.0) * 0.5;
float diffuse = NdotL * 0.3 + 0.4;

float lightDist = length(lightPos - vWorldPos);
float attenuation = 1.0 / (1.0 + 0.00001 * lightDist + 0.000000001 * lightDist * lightDist);
float lightFactor = (diffuse + specular) * attenuation * lightIntensity;

float edgeFade = 1.0 - smoothstep(0.2, 0.5, dist);
float coreFade = exp(-dist * 4.0);
float particleShape = mix(coreFade, edgeFade, 0.5);

float irregularity = hash(vRandom * 1000.0 + floor(time * 0.5)) * 0.15;
particleShape *= (1.0 - irregularity);

vec3 baseColor = vec3(0.85, 0.87, 0.9);
vec3 warmColor = vec3(0.95, 0.9, 0.85);
vec3 coolColor = vec3(0.8, 0.85, 0.95);

float colorMix = hash(vRandom * 500.0);
vec3 particleColor = mix(mix(baseColor, warmColor, colorMix), coolColor, 1.0 - colorMix);

vec3 finalColor = particleColor * (lightFactor + 0.3) * particleShape;
float finalAlpha = vAlpha * particleShape * opacityMultiplier * (0.6 + lightFactor * 0.4);

gl_FragColor = vec4(finalColor, finalAlpha);
}
`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      const dustField = new THREE.Points(geometry, material);
      this.scene.add(dustField);
      this.dustParticles.push({
        mesh: dustField,
        velX,
        velY,
        velZ,
        noiseOffsetX,
        noiseOffsetY,
        noiseOffsetZ,
        turbulenceScale,
        layerIndex: layerIndex,
        baseCount: count,
        layerConfig: layer,
      });
    });
  }

  updateDustField(deltaTime) {
    if (!this.dustConfig.enabled) {
      this.dustParticles.forEach((dustLayer) => {
        dustLayer.mesh.visible = false;
      });
      return;
    }

    this.dustTime += deltaTime * 0.001 * this.dustConfig.driftSpeed;

    const com = this.cachedCom;

    this.dustParticles.forEach((dustLayer) => {
      dustLayer.mesh.visible = true;
      const positions = dustLayer.mesh.geometry.attributes.position.array;
      const velX = dustLayer.velX;
      const velY = dustLayer.velY;
      const velZ = dustLayer.velZ;
      const noiseOffsetX = dustLayer.noiseOffsetX;
      const noiseOffsetY = dustLayer.noiseOffsetY;
      const noiseOffsetZ = dustLayer.noiseOffsetZ;
      const turbulenceScale = dustLayer.turbulenceScale;
      const layer = dustLayer.layerConfig;

      dustLayer.mesh.material.uniforms.time.value = this.dustTime;
      dustLayer.mesh.material.uniforms.cameraPos.value.copy(
        this.camera.position,
      );
      dustLayer.mesh.material.uniforms.opacityMultiplier.value =
        this.dustConfig.opacityMultiplier;
      dustLayer.mesh.material.uniforms.sizeMultiplier.value =
        this.dustConfig.sizeMultiplier;
      dustLayer.mesh.material.uniforms.lightIntensity.value =
        this.dustConfig.lightIntensity;
      dustLayer.mesh.material.uniforms.maxViewDistance.value =
        this.dustConfig.maxViewDistance;

      dustLayer.mesh.material.uniforms.lightPos.value.set(com.x, com.y, com.z);

      for (let i = 0; i < dustLayer.baseCount; i++) {
        const idx = i * 3;

        const noiseX =
          Math.sin(this.dustTime * 0.3 + noiseOffsetX[i]) * turbulenceScale[i];
        const noiseY =
          Math.cos(this.dustTime * 0.25 + noiseOffsetY[i]) * turbulenceScale[i];
        const noiseZ =
          Math.sin(this.dustTime * 0.35 + noiseOffsetZ[i]) * turbulenceScale[i];

        positions[idx] += velX[i] + noiseX * 0.005;
        positions[idx + 1] += velY[i] + noiseY * 0.005;
        positions[idx + 2] += velZ[i] + noiseZ * 0.005;

        const dist = Math.sqrt(
          positions[idx] * positions[idx] +
            positions[idx + 1] * positions[idx + 1] +
            positions[idx + 2] * positions[idx + 2],
        );

        const maxDist = layer.maxRadius;
        const minDist = layer.minRadius;

        if (dist > maxDist * 1.1 || dist < minDist * 0.9) {
          const radius =
            minDist + Math.pow(Math.random(), 0.7) * (maxDist - minDist);
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(2 * Math.random() - 1);
          positions[idx] = radius * Math.sin(phi) * Math.cos(theta);
          positions[idx + 1] = radius * Math.sin(phi) * Math.sin(theta);
          positions[idx + 2] = radius * Math.cos(phi);
        }
      }

      dustLayer.mesh.geometry.attributes.position.needsUpdate = true;
    });
  }

  updateDustLayerVisibility(layerIndex, count) {
    const dustLayer = this.dustParticles[layerIndex];
    if (!dustLayer) return;
    dustLayer.mesh.geometry.setDrawRange(0, count);
  }

  initGravityCageMesh() {
    this.cageWarningMesh = null;
    this.cageBoundaryMesh = null;
    this.cageMeshDirty = true;

    const warningGeometry = new THREE.SphereGeometry(1, 32, 32);
    const warningMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc832,
      transparent: true,
      opacity: 0.08,
      wireframe: true,
    });
    this.cageWarningMesh = new THREE.Mesh(warningGeometry, warningMaterial);
    this.cageWarningMesh.visible = false;
    this.scene.add(this.cageWarningMesh);

    const boundaryGeometry = new THREE.SphereGeometry(1, 32, 32);
    const boundaryMaterial = new THREE.MeshBasicMaterial({
      color: 0xff3232,
      transparent: true,
      opacity: 0.15,
      wireframe: true,
    });
    this.cageBoundaryMesh = new THREE.Mesh(boundaryGeometry, boundaryMaterial);
    this.cageBoundaryMesh.visible = false;
    this.scene.add(this.cageBoundaryMesh);
  }

  updateGravityCageMesh() {
    if (!this.cageWarningMesh || !this.cageBoundaryMesh) return;

    const shouldShow = this.gravityCage.showBoundaries;
    this.cageWarningMesh.visible = shouldShow;
    this.cageBoundaryMesh.visible = shouldShow;

    if (!shouldShow) return;

    const cx = this.gravityCage.center.x;
    const cy = this.gravityCage.center.y;
    const cz = this.gravityCage.center.z;

    this.cageWarningMesh.position.set(cx, cy, cz);
    this.cageWarningMesh.scale.setScalar(this.gravityCage.warningRadius);

    this.cageBoundaryMesh.position.set(cx, cy, cz);
    this.cageBoundaryMesh.scale.setScalar(this.gravityCage.boundaryRadius);
  }

  initComMesh() {
    const geometry = new THREE.SphereGeometry(6, 16, 16);
    const material = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.9,
    });
    this.comMesh = new THREE.Mesh(geometry, material);
    this.comMesh.visible = false;
    this.scene.add(this.comMesh);

    const ringGeometry = new THREE.RingGeometry(10, 12, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    this.comRing = new THREE.Mesh(ringGeometry, ringMaterial);
    this.comRing.visible = false;
    this.scene.add(this.comRing);

    const octaGeometry = new THREE.OctahedronGeometry(30, 0);
    const octaMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
    });
    this.comOctahedron = new THREE.Mesh(octaGeometry, octaMaterial);
    this.comOctahedron.visible = false;
    this.scene.add(this.comOctahedron);
  }

  initEvents() {
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("mousemove", (e) => this.handleMouseMove(e));
    window.addEventListener("click", (e) => this.handleClick(e));
    window.addEventListener("dblclick", (e) => this.handleDoubleClick(e));
    this.renderer.domElement.addEventListener("wheel", () =>
      this.handleWheel(),
    );
    // 拖动（旋转视角）期间暂停 autoZoom，避免自动取景与手动旋转争抢相机位置
    this.renderer.domElement.addEventListener("pointerdown", () =>
      this.pauseAutoZoom(),
    );
    window.addEventListener("pointerup", () => {
      if (this.autoZoom.enabled && this.autoZoomPaused) {
        this.scheduleAutoZoomResume();
      }
    });

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.hoveredBodyIndex = -1;

    this.autoZoomPaused = false;
    this.autoZoomResumeTimer = null;

    this.focusMode = {
      enabled: false,
      bodyIndex: -1,
      distance: 100,
      transitioning: false,
      exitAnimation: null,
      transitionStartTime: 0,
      exiting: false,
      exitStartTime: 0,
      exitStartPosition: null,
      exitStartCameraPos: null,
      exitStartDistance: 200,
    };

    this.initBodyLabels();
  }

  handleWheel() {
    this.pauseAutoZoom();
    this.scheduleAutoZoomResume();
  }

  pauseAutoZoom() {
    if (this.autoZoom.enabled && !this.autoZoomPaused) {
      this.autoZoomPaused = true;
      this.updateAutoZoomUI();
    }
  }

  scheduleAutoZoomResume() {
    if (this.autoZoomResumeTimer) {
      clearTimeout(this.autoZoomResumeTimer);
      this.autoZoomResumeTimer = null;
    }

    if (!this.focusMode.enabled) {
      this.autoZoomResumeTimer = setTimeout(() => {
        if (this.autoZoomPaused && !this.focusMode.enabled) {
          this.autoZoomPaused = false;
          this.updateAutoZoomUI();
        }
      }, 5000);
    }
  }

  handleMouseMove(e) {
    this.checkHover(e);

    if (!this.mouseFollow.enabled) return;

    const config = this.mouseFollow;
    const normalizedX = (e.clientX / window.innerWidth - 0.5) * 2;
    const normalizedY = (e.clientY / window.innerHeight - 0.5) * 2;

    config.targetX = normalizedX * config.maxOffsetX * config.sensitivity;
    config.targetY = -normalizedY * config.maxOffsetY * config.sensitivity;
  }

  initBodyLabels() {
    this.bodyLabels = [];
    this.labelsContainer = document.getElementById("bodyLabelsContainer");

    const bodyNames = ["恒星1", "恒星2", "恒星3", "行星"];

    for (let i = 0; i < this.bodies.length; i++) {
      const label = document.createElement("div");
      label.className = "body-label";
      label.dataset.bodyIndex = i;

      const body = this.bodies[i];
      const nameIndex = body.type === "planet" ? 3 : i;
      const colorHex =
        "#" + this.trailColors[nameIndex].toString(16).padStart(6, "0");

      label.innerHTML = `
<div class="body-label-content">
<div class="body-label-name" style="color: ${colorHex}">${bodyNames[nameIndex]}</div>
</div>
`;

      label.addEventListener("click", (e) => {
        e.stopPropagation();
        this.focusOnBody(i);
      });

      this.labelsContainer.appendChild(label);
      this.bodyLabels.push(label);
    }
  }

  updateBodyLabels() {
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      const label = this.bodyLabels[i];

      if (!label) continue;

      const screenPos = this._tmpVec3a
        .set(body.x, body.y, body.z)
        .project(this.camera);

      const x = (screenPos.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-screenPos.y * 0.5 + 0.5) * window.innerHeight;

      if (screenPos.z > 1) {
        label.classList.remove("visible");
        continue;
      }

      label.style.left = x + "px";
      label.style.top = y + "px";

      if (i === this.hoveredBodyIndex) {
        label.classList.add("visible");
      } else {
        label.classList.remove("visible");
      }
    }
  }

  checkHover(e) {
    this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    const nearest = this.findNearestBody(this.mouse, 50);
    if (nearest.index !== -1 && nearest.index !== this.hoveredBodyIndex) {
      this.hoveredBodyIndex = nearest.index;
      document.body.style.cursor = "pointer";
    } else if (nearest.index === -1 && this.hoveredBodyIndex !== -1) {
      this.hoveredBodyIndex = -1;
      document.body.style.cursor = "default";
    }
  }

  findNearestBody(mouseNDC, minScreenRadius = 50) {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouseNDC, this.camera);

    const fov = this.camera.fov * (Math.PI / 180);
    const tanHalfFov = Math.tan(fov / 2);

    let nearestIndex = -1;
    let nearestDist = Infinity;

    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      const bodyPos = this._tmpVec3a.set(body.x, body.y, body.z);
      const dist = raycaster.ray.distanceToPoint(bodyPos);

      const bodyToCamera = this.camera.position.distanceTo(bodyPos);
      const pixelSize = (2 * bodyToCamera * tanHalfFov) / window.innerHeight;
      const effectiveRadius = Math.max(body.r, minScreenRadius * pixelSize);

      if (dist < effectiveRadius && dist < nearestDist) {
        nearestDist = dist;
        nearestIndex = i;
      }
    }

    return { index: nearestIndex, distance: nearestDist };
  }

  handleClick(e) {
    const labelClicked = e.target.closest(".body-label");
    if (labelClicked) return;

    this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    const nearest = this.findNearestBody(this.mouse, 50);
    if (nearest.index !== -1) {
      this.focusOnBody(nearest.index);
    }
  }

  focusOnBody(bodyIndex) {
    if (bodyIndex < 0 || bodyIndex >= this.bodies.length) return;

    if (this.focusMode.exitAnimation) {
      cancelAnimationFrame(this.focusMode.exitAnimation);
      this.focusMode.exitAnimation = null;
    }

    const body = this.bodies[bodyIndex];
    const distance = Math.max(body.r * 15, 100);

    this.focusMode.bodyIndex = bodyIndex;
    this.focusMode.distance = distance;
    this.focusMode.transitioning = true;
    this.focusMode.enabled = true;
    this.focusMode.exiting = false;
    this.focusMode.transitionStartTime = performance.now();

    if (this.autoZoom.enabled) {
      this.autoZoomPaused = true;
      this.updateAutoZoomUI();
    }
  }

  exitFocusMode() {
    if (!this.focusMode.enabled && !this.focusMode.transitioning) return;

    const bodyIndex = this.focusMode.bodyIndex;
    const body = this.bodies[bodyIndex];

    this.focusMode.exitStartPosition = body
      ? new THREE.Vector3(body.x, body.y, body.z).clone()
      : this.controls.target.clone();
    this.focusMode.exitStartCameraPos = this.camera.position.clone();
    this.focusMode.exitStartDistance = this.camera.position
      .clone()
      .sub(this.controls.target)
      .length();

    this.focusMode.enabled = false;
    this.focusMode.transitioning = false;
    this.focusMode.exiting = true;
    this.focusMode.exitStartTime = performance.now();
  }

  handleDoubleClick(e) {
    const labelClicked = e.target.closest(".body-label");
    if (labelClicked) return;

    if (
      this.focusMode.enabled ||
      this.focusMode.transitioning ||
      this.focusMode.exiting
    ) {
      this.exitFocusMode();
    }
  }

  updateFocusFollow(deltaTime = 1 / 60) {
    const lerpFactor = 1 - Math.pow(0.0001, deltaTime);

    if (this.focusMode.exiting) {
      const elapsed = performance.now() - this.focusMode.exitStartTime;
      const duration = 2000;
      const progress = Math.min(elapsed / duration, 1);
      const easeProgress = 1 - Math.pow(1 - progress, 5);

      const com = this.cachedCom;
      const targetPosition = this._tmpVec3a.set(com.x, com.y, com.z);

      let maxDist = 0;
      for (const body of this.bodies) {
        const dx = body.x - com.x;
        const dy = body.y - com.y;
        const dz = body.z - com.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + body.r;
        if (dist > maxDist) maxDist = dist;
      }
      const targetDistance = Math.max(maxDist * 2, 200);
      const clampedDistance = Math.max(100, Math.min(5000, targetDistance));

      const startDistance = this.focusMode.exitStartDistance || 200;
      const currentDistance =
        startDistance + (clampedDistance - startDistance) * easeProgress;

      const startTarget =
        this.focusMode.exitStartPosition || targetPosition.clone();
      const currentTarget = new THREE.Vector3().lerpVectors(
        startTarget,
        targetPosition,
        easeProgress,
      );

      const cameraDirection = this.camera.position
        .clone()
        .sub(this.controls.target);
      const dist = cameraDirection.length();
      let direction = new THREE.Vector3(0, 0, 1);
      if (dist > 0.001) {
        direction = cameraDirection.normalize();
      }

      const targetCameraPos = currentTarget
        .clone()
        .add(direction.multiplyScalar(currentDistance));

      this.camera.position.lerp(targetCameraPos, lerpFactor);
      this.controls.target.lerp(currentTarget, lerpFactor);

      if (progress >= 1) {
        this.focusMode.exiting = false;
        if (this.autoZoom.enabled) {
          this.autoZoomPaused = false;
          this.updateAutoZoomUI();
        }
      }
      return;
    }

    if (!this.focusMode.enabled) return;

    const bodyIndex = this.focusMode.bodyIndex;
    if (bodyIndex < 0 || bodyIndex >= this.bodies.length) {
      this.exitFocusMode();
      return;
    }

    const body = this.bodies[bodyIndex];
    const targetPosition = new THREE.Vector3(body.x, body.y, body.z);

    if (this.focusMode.transitioning) {
      const currentOffset = this.camera.position
        .clone()
        .sub(this.controls.target);
      const currentDist = currentOffset.length();

      let currentDirection = new THREE.Vector3(0, 0, 1);
      if (currentDist > 0.001) {
        currentDirection = currentOffset.clone().normalize();
      }

      const targetDist = this.focusMode.distance;
      const targetCameraPos = targetPosition
        .clone()
        .add(currentDirection.multiplyScalar(targetDist));

      this.camera.position.lerp(targetCameraPos, lerpFactor);
      this.controls.target.lerp(targetPosition, lerpFactor);

      const transitionDist = Math.abs(currentDist - targetDist);
      if (transitionDist < 5) {
        this.focusMode.transitioning = false;
      }
    } else {
      const oldTarget = this.controls.target.clone();
      this.controls.target.lerp(targetPosition, lerpFactor);
      const delta = this.controls.target.clone().sub(oldTarget);
      this.camera.position.add(delta);
    }
  }

  animateCameraTo(targetPosition, targetLookAt, onComplete) {
    if (this.cameraAnimation) {
      cancelAnimationFrame(this.cameraAnimation);
    }

    const startPosition = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const startTime = performance.now();
    const duration = 800;

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      const easeProgress = 1 - Math.pow(1 - progress, 3);

      this.camera.position.lerpVectors(
        startPosition,
        targetPosition,
        easeProgress,
      );
      this.controls.target.lerpVectors(startTarget, targetLookAt, easeProgress);

      if (progress < 1) {
        this.cameraAnimation = requestAnimationFrame(animate);
      } else {
        this.cameraAnimation = null;
        if (onComplete) onComplete();
      }
    };

    this.cameraAnimation = requestAnimationFrame(animate);
  }

  updateMouseFollow() {
    if (!this.mouseFollow.enabled) return;

    try {
      const config = this.mouseFollow;

      const prevX = config.currentX;
      const prevY = config.currentY;
      config.currentX += (config.targetX - config.currentX) * config.smoothing;
      config.currentY += (config.targetY - config.currentY) * config.smoothing;

      const deltaX = config.currentX - prevX;
      const deltaY = config.currentY - prevY;

      const offset = new THREE.Vector3(deltaX, deltaY, 0);
      this.camera.position.add(offset);
      this.controls.target.add(offset);
    } catch (e) {
      console.error("鼠标跟随错误:", e);
      this.mouseFollow.enabled = false;
    }
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
  }

  computeCenterOfMass() {
    const bodies = this.bodies;
    let totalMass = 0,
      massWeightedX = 0,
      massWeightedY = 0,
      massWeightedZ = 0;
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i];
      totalMass += body.m;
      massWeightedX += body.m * body.x;
      massWeightedY += body.m * body.y;
      massWeightedZ += body.m * body.z;
    }
    return {
      x: massWeightedX / totalMass,
      y: massWeightedY / totalMass,
      z: massWeightedZ / totalMass,
    };
  }

  computeAcc(body, bodies) {
    const ds = this.displayScale;
    const minDist = 0.5;
    const minSq = minDist * minDist;
    let ax = 0,
      ay = 0,
      az = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b === body) continue;
      const dx = (b.x - body.x) / ds;
      const dy = (b.y - body.y) / ds;
      const dz = (b.z - body.z) / ds;
      let distSq = dx * dx + dy * dy + dz * dz;
      if (this.useMinDist) distSq = Math.max(distSq, minSq);
      const dist = Math.sqrt(distSq);
      const force = (this.G * b.m) / (dist * distSq);
      ax += force * dx;
      ay += force * dy;
      az += force * dz;
    }
    return { ax, ay, az };
  }

  computeCageAccelerations() {
    if (!this.gravityCage.enabled) return null;
    const accelerations = [];
    let totalForceX = 0,
      totalForceY = 0,
      totalForceZ = 0,
      totalMass = 0;

    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      const cageAcc = this.gravityCage.computeAcceleration(
        body,
        this.displayScale,
      );
      const damping = this.gravityCage.computeDamping(body, this.displayScale);
      accelerations.push({
        ax: cageAcc.ax + damping.dampingX,
        ay: cageAcc.ay + damping.dampingY,
        az: cageAcc.az + damping.dampingZ,
      });
      totalForceX += (cageAcc.ax + damping.dampingX) * body.m;
      totalForceY += (cageAcc.ay + damping.dampingY) * body.m;
      totalForceZ += (cageAcc.az + damping.dampingZ) * body.m;
      totalMass += body.m;
    }

    const compensationAx = -totalForceX / totalMass;
    const compensationAy = -totalForceY / totalMass;
    const compensationAz = -totalForceZ / totalMass;

    for (let i = 0; i < accelerations.length; i++) {
      accelerations[i].ax += compensationAx;
      accelerations[i].ay += compensationAy;
      accelerations[i].az += compensationAz;
    }
    return accelerations;
  }

  step() {
    const bodies = this.bodies;
    const dt = this.dt;
    const displayScale = this.displayScale;
    const yoshidaCoeffs = YOSHIDA;

    if (this.gravityCage.enabled) {
      const com = this.computeCenterOfMass();
      this.gravityCage.updateCenter(com);
    }

    for (let stepIndex = 0; stepIndex < yoshidaCoeffs.length; stepIndex++) {
      const w = yoshidaCoeffs[stepIndex];
      const h = dt * w;
      const cageAccs = this.computeCageAccelerations();

      for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        const acc = this.computeAcc(body, bodies);
        let ax = acc.ax,
          ay = acc.ay,
          az = acc.az;
        if (cageAccs) {
          ax += cageAccs[i].ax;
          ay += cageAccs[i].ay;
          az += cageAccs[i].az;
        }
        body.dx += ax * h;
        body.dy += ay * h;
        body.dz += az * h;
      }

      for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        body.x += body.dx * h * displayScale;
        body.y += body.dy * h * displayScale;
        body.z += body.dz * h * displayScale;
      }
    }

    this.totalTime += dt;
    this.updateTrails();

    if (this.enableCollision) {
      this.checkCollisions();
    }

    this.cachedCom = this.computeCenterOfMass();
  }

  stepAsync() {
    return new Promise((resolve) => {
      if (this.gravityCage.enabled) {
        const com = this.computeCenterOfMass();
        this.gravityCage.updateCenter(com);
      }

      const n = this.bodies.length;
      const positions = new Float32Array(n * 3);
      const velocities = new Float32Array(n * 3);
      const masses = new Float32Array(n);

      for (let i = 0; i < n; i++) {
        const b = this.bodies[i];
        positions[i * 3] = b.x;
        positions[i * 3 + 1] = b.y;
        positions[i * 3 + 2] = b.z;
        velocities[i * 3] = b.dx;
        velocities[i * 3 + 1] = b.dy;
        velocities[i * 3 + 2] = b.dz;
        masses[i] = b.m;
      }

      const cageParams = {
        enabled: this.gravityCage.enabled,
        boundaryRadius: this.gravityCage.boundaryRadius,
        warningRadius: this.gravityCage.warningRadius,
        strength: this.gravityCage.strength,
        exponent: this.gravityCage.exponent,
        softening: this.gravityCage.softening,
        maxMultiplier: this.gravityCage.maxMultiplier,
        dampingFactor: this.gravityCage.dampingFactor,
        centerX: this.gravityCage.center.x,
        centerY: this.gravityCage.center.y,
        centerZ: this.gravityCage.center.z,
      };

      this._stepResolve = resolve;

      this.physicsWorker.postMessage(
        {
          positions: positions.buffer,
          velocities: velocities.buffer,
          masses: masses.buffer,
          n,
          G: this.G,
          dt: this.dt,
          displayScale: this.displayScale,
          useMinDist: this.useMinDist,
          cageParams,
        },
        [positions.buffer, velocities.buffer, masses.buffer],
      );
    });
  }

  checkCollisions() {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const b1 = bodies[i];
        const b2 = bodies[j];
        const dx = b2.x - b1.x;
        const dy = b2.y - b1.y;
        const dz = b2.z - b1.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const collisionThreshold = b1.r + b2.r;

        if (dist < collisionThreshold && dist > 0) {
          const totalMass = b1.m + b2.m;
          const newBody = {
            x: (b1.x * b1.m + b2.x * b2.m) / totalMass,
            y: (b1.y * b1.m + b2.y * b2.m) / totalMass,
            z: (b1.z * b1.m + b2.z * b2.m) / totalMass,
            dx: (b1.dx * b1.m + b2.dx * b2.m) / totalMass,
            dy: (b1.dy * b1.m + b2.dy * b2.m) / totalMass,
            dz: (b1.dz * b1.m + b2.dz * b2.m) / totalMass,
            m: totalMass,
            r: Math.pow(Math.pow(b1.r, 3) + Math.pow(b2.r, 3), 1 / 3),
            textureIndex: -1,
          };
          bodies.splice(j, 1);
          bodies[i] = newBody;
          this.trails.splice(j, 1);
          this.trails[i] = new CircularTrail3D(this.trailLength);
          this.updateBodyMeshes();
          this.updateTrailMeshes();
          return;
        }
      }
    }
  }

  updateTrails() {
    if (!this.showTrail) return;
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      this.trails[i].push(body.x, body.y, body.z);
    }
  }

  updateBodyMeshes() {
    while (this.bodyMeshes.length > this.bodies.length) {
      const mesh = this.bodyMeshes.pop();
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }

    while (this.bodyMeshes.length < this.bodies.length) {
      const i = this.bodyMeshes.length;
      const body = this.bodies[i];
      const radius = body.r;
      const textureIndex = body.type === "planet" ? 3 : i % 3;

      const geometry = new THREE.SphereGeometry(radius, 32, 32);
      const material = new THREE.MeshStandardMaterial({
        map: this.bodyTextures[textureIndex] || null,
        roughness: 0.8,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(geometry, material);

      this.scene.add(mesh);
      this.bodyMeshes.push(mesh);
    }

    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      this.bodyMeshes[i].position.set(body.x, body.y, body.z);
    }
  }

  updateTrailMeshes() {
    for (let i = 0; i < this.trailMeshes.length; i++) {
      this.trailMeshes[i].visible = this.showTrail;
    }
    if (!this.showTrail) return;

    while (this.trailMeshes.length > this.trails.length) {
      const line = this.trailMeshes.pop();
      this.scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }

    while (this.trailMeshes.length < this.trails.length) {
      const i = this.trailMeshes.length;
      const body = this.bodies[i];
      const colorIndex = body && body.type === "planet" ? 3 : i;
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(this.trailLength * 3);
      const colors = new Float32Array(this.trailLength * 3);
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometry.setDrawRange(0, 0);

      const material = createTrailMaterial(
        this.trailColors[colorIndex % this.trailColors.length],
      );

      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      this.scene.add(line);
      this.trailMeshes.push(line);
    }

    for (let i = 0; i < this.trails.length; i++) {
      const trail = this.trails[i];
      const mesh = this.trailMeshes[i];
      const body = this.bodies[i];
      const colorIndex = body && body.type === "planet" ? 3 : i;
      const positions = mesh.geometry.attributes.position.array;
      const colors = mesh.geometry.attributes.color.array;
      const baseColor = this._tmpColor.set(
        this.trailColors[colorIndex % this.trailColors.length],
      );

      for (let j = 0; j < trail.count; j++) {
        const idx = (trail.head + j) % trail.count;
        positions[j * 3] = trail.xs[idx];
        positions[j * 3 + 1] = trail.ys[idx];
        positions[j * 3 + 2] = trail.zs[idx];

        const t = j / Math.max(1, trail.count - 1);
        const alpha = t * t;
        colors[j * 3] = baseColor.r * alpha;
        colors[j * 3 + 1] = baseColor.g * alpha;
        colors[j * 3 + 2] = baseColor.b * alpha;
      }

      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.attributes.color.needsUpdate = true;
      mesh.geometry.setDrawRange(0, trail.count);
    }
  }

  resizeTrailMeshes() {
    for (let i = 0; i < this.trailMeshes.length; i++) {
      const line = this.trailMeshes[i];
      const trail = this.trails[i];
      const body = this.bodies[i];
      const colorIndex = body && body.type === "planet" ? 3 : i;

      const newPositions = new Float32Array(this.trailLength * 3);
      const newColors = new Float32Array(this.trailLength * 3);
      const copyCount = Math.min(trail.count, this.trailLength);
      const baseColor = new THREE.Color(
        this.trailColors[colorIndex % this.trailColors.length],
      );

      for (let j = 0; j < copyCount; j++) {
        const idx = (trail.head + j) % trail.count;
        newPositions[j * 3] = trail.xs[idx];
        newPositions[j * 3 + 1] = trail.ys[idx];
        newPositions[j * 3 + 2] = trail.zs[idx];

        const t = j / Math.max(1, copyCount - 1);
        const alpha = t * t;
        newColors[j * 3] = baseColor.r * alpha;
        newColors[j * 3 + 1] = baseColor.g * alpha;
        newColors[j * 3 + 2] = baseColor.b * alpha;
      }

      line.geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(newPositions, 3),
      );
      line.geometry.setAttribute(
        "color",
        new THREE.BufferAttribute(newColors, 3),
      );
      line.geometry.setDrawRange(0, copyCount);
    }
  }

  updateComMesh() {
    if (this.showCom) {
      const com = this.cachedCom;
      this.comOctahedron.position.set(com.x, com.y, com.z);
      this.comOctahedron.visible = true;
    } else {
      this.comOctahedron.visible = false;
    }
  }

  updateAutoZoom() {
    if (!this.autoZoom.enabled || this.autoZoomPaused) return;

    const com = this.cachedCom;
    let maxDist = 0;

    for (const body of this.bodies) {
      const dx = body.x - com.x;
      const dy = body.y - com.y;
      const dz = body.z - com.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + body.r;
      if (dist > maxDist) maxDist = dist;
    }

    const targetDistance = Math.max(maxDist * this.autoZoom.padding, 200);
    // 统一基准：使用"相机到 target 的距离"，而非"相机到世界原点的距离"，
    // 避免 target（质心）漂移时原点/质心两套基准混用导致视角被甩偏。
    const currentDistance = this.camera.position.distanceTo(this.controls.target);
    const newDistance =
      currentDistance +
      (targetDistance - currentDistance) * this.autoZoom.sensitivity;

    const clampedDistance = Math.max(
      this.autoZoom.minDistance,
      Math.min(this.autoZoom.maxDistance, newDistance),
    );

    // 关键修复：避免在极点附近（相机距离 target 趋近 0）时 normalize()
    // 把相机位置塌缩到原点、丢失朝向导致视角"锁死"。
    // 改用比例缩放而非 normalize → 保持原方向，只改距离。
    const curLen = this.camera.position.distanceTo(this.controls.target);
    const minLen = 1e-3;
    if (curLen > minLen) {
      this.camera.position.sub(this.controls.target)
        .multiplyScalar(clampedDistance / curLen)
        .add(this.controls.target);
    } else if (curLen > 0) {
      // 距离过小：沿相机当前视线方向（从 target 指向相机）安全外推，避免塌缩
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      this.camera.position.copy(this.controls.target).addScaledVector(dir, clampedDistance);
    }
    this.controls.target.set(com.x, com.y, com.z);
  }

  updateAutoRotate() {
    if (!this.autoRotate.enabled) return;

    try {
      const rotateConfig = this.autoRotate;
      const deltaTime = 1 / 60;
      const rotateAmount = (rotateConfig.speed * deltaTime * Math.PI) / 180;

      const offset = this.camera.position.clone().sub(this.controls.target);
      const spherical = new THREE.Spherical();
      spherical.setFromVector3(offset);

      spherical.theta -= rotateAmount;

      if (rotateConfig.minAngle !== null && rotateConfig.maxAngle !== null) {
        const currentDeg = (spherical.theta * 180) / Math.PI;
        const normalizedDeg = ((currentDeg % 360) + 360) % 360;
        if (
          normalizedDeg < rotateConfig.minAngle ||
          normalizedDeg > rotateConfig.maxAngle
        ) {
          rotateConfig.enabled = false;
          this.updateAutoRotateUI();
          return;
        }
      }

      offset.setFromSpherical(spherical);
      this.camera.position.copy(this.controls.target).add(offset);

      rotateConfig.currentAngle = spherical.theta;
    } catch (e) {
      console.error("自动旋转错误:", e);
      this.autoRotate.enabled = false;
      this.updateAutoRotateUI();
    }
  }

  updateAutoRotateUI() {
    const btn = document.getElementById("btnAutoRotate");
    if (btn) {
      btn.classList.toggle("active", this.autoRotate.enabled);
    }
  }

  updateAutoZoomUI() {
    const btn = document.getElementById("btnAutoZoom");
    if (btn) {
      const isActive = this.autoZoom.enabled && !this.autoZoomPaused;
      btn.classList.toggle("active", isActive);
    }
  }

  draw() {
    this.updateBodyMeshes();
    this.updateTrailMeshes();
    this.updateComMesh();
    this.updateGravityCageMesh();
    this.updateDustField(16);
    this.updateBodyLabels();

    this.controls.update();
    this.composer.render();

    this.domUpdateCounter++;
    if (this.domUpdateCounter >= 10) {
      this.domUpdateCounter = 0;
      this.updateTimeDisplay();
      this.updateEnergyDisplay();
      this.updateCameraInfo();
    }
  }

  updateTimeDisplay() {
    const el = this.domElements.timeDisplay;
    if (el) el.textContent = this.totalTime.toFixed(2) + "s";
  }

  updateEnergyDisplay() {
    if (this.gravityCage.enabled) {
      const cageEnergy = this.gravityCage.computeTotalCageEnergy(
        this.bodies,
        this.displayScale,
      );
      if (this.domElements.cageEnergy) {
        this.domElements.cageEnergy.textContent = cageEnergy.toFixed(4);
      }

      let maxRNorm = 0;
      let nearestStatus = "safe";
      for (const body of this.bodies) {
        const status = this.gravityCage.getBoundaryStatus(
          body,
          this.displayScale,
        );
        const dist = this.gravityCage.computeDistance(body, this.displayScale);
        const boundaryR = this.gravityCage.boundaryRadius / this.displayScale;
        const rNorm = dist / boundaryR;
        if (rNorm > maxRNorm) {
          maxRNorm = rNorm;
          nearestStatus = status;
        }
      }

      const statusEl = this.domElements.nearestBodyStatus;
      if (statusEl) {
        const statusText = {
          safe: "安全",
          warning: "警告",
          danger: "危险",
          critical: "临界",
        };
        statusEl.textContent = statusText[nearestStatus] || "安全";
        const statusColor = {
          safe: "#4caf50",
          warning: "#ffc107",
          danger: "#ff9800",
          critical: "#f44336",
        };
        statusEl.style.color = statusColor[nearestStatus] || "#4caf50";
      }
    } else {
      if (this.domElements.cageEnergy) {
        this.domElements.cageEnergy.textContent = "0.0000";
      }
      if (this.domElements.nearestBodyStatus) {
        this.domElements.nearestBodyStatus.textContent = "未启用";
        this.domElements.nearestBodyStatus.style.color = "#888";
      }
    }

    const com = this.cachedCom;
    const energy = calcSystemEnergy3D(this.bodies, this.G, this.displayScale);
    const angularMomentum = calcSystemAngularMomentum3D(
      this.bodies,
      com.x,
      com.y,
      com.z,
    );
    if (this.domElements.kineticEnergy)
      this.domElements.kineticEnergy.textContent = energy.kinetic.toFixed(4);
    if (this.domElements.potentialEnergy)
      this.domElements.potentialEnergy.textContent =
        energy.potential.toFixed(4);
    if (this.domElements.totalEnergy)
      this.domElements.totalEnergy.textContent = energy.total.toFixed(4);
    if (this.domElements.angularMomentum)
      this.domElements.angularMomentum.textContent = angularMomentum.toFixed(4);
  }

  updateCameraInfo() {
    const distance = this.camera.position.length();
    const angle =
      (Math.atan2(this.camera.position.y, this.camera.position.x) * 180) /
      Math.PI;

    document.getElementById("cameraDistance").textContent = distance.toFixed(0);
    document.getElementById("cameraAngle").textContent = angle.toFixed(0) + "°";

    const rotateAngleEl = document.getElementById("currentRotateAngle");
    if (rotateAngleEl) {
      const currentDeg =
        ((((this.autoRotate.currentAngle * 180) / Math.PI) % 360) + 360) % 360;
      rotateAngleEl.textContent = currentDeg.toFixed(1) + "°";
    }
  }

  run() {
    const sim = this;
    let lastFrameTime = performance.now();
    let stepping = false;
    async function runSteps() {
      for (let i = 0; i < sim.speedMultiplier; i++) {
        await sim.stepAsync();
      }
      stepping = false;
    }
    function frame() {
      const now = performance.now();
      const deltaTime = Math.min((now - lastFrameTime) / 1000, 0.1);
      lastFrameTime = now;
      if (sim.running) {
        if (sim.physicsWorker && !stepping) {
          stepping = true;
          runSteps();
        } else if (!sim.physicsWorker) {
          for (let i = 0; i < sim.speedMultiplier; i++) {
            sim.step();
          }
        }
        sim.updateAutoZoom();
      }
      sim.updateAutoRotate();
      sim.updateMouseFollow();
      sim.updateFocusFollow(deltaTime);
      sim.controls.update();
      sim.draw();
      sim.timer = requestAnimationFrame(frame);
    }
    frame();
  }

  start() {
    this.running = true;
    if (!this.timer) this.run();
  }

  stop() {
    this.running = false;
  }
}

function generateRandomBodies() {
  const bodies = [];
  const masses = [];
  const positions = [];
  const velocities = [];
  const scale = 200;

  for (let i = 0; i < 3; i++) {
    const mass = 0.5 + Math.random() * 4.5;
    masses.push(mass);

    const angle = (i * 2 * Math.PI) / 3 + Math.random() * 0.5;
    const radius = 200 + Math.random() * 300;
    const zOffset = (Math.random() - 0.5) * 200;
    positions.push({
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      z: zOffset,
    });
  }

  let potentialEnergy = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const dx = (positions[j].x - positions[i].x) / scale;
      const dy = (positions[j].y - positions[i].y) / scale;
      const dz = (positions[j].z - positions[i].z) / scale;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.5);
      potentialEnergy -= (1 * masses[i] * masses[j]) / dist;
    }
  }

  const targetKinetic = Math.abs(potentialEnergy) * 0.3;
  const kineticPerBody = targetKinetic / 3;

  for (let i = 0; i < 3; i++) {
    const speed = Math.sqrt((2 * kineticPerBody) / masses[i]);
    const velAngle = Math.random() * 2 * Math.PI;
    const zVel = (Math.random() - 0.5) * speed * 0.5;
    velocities.push({
      dx: speed * Math.cos(velAngle),
      dy: speed * Math.sin(velAngle),
      dz: zVel,
    });
  }

  const totalMomentumX = masses.reduce(
    (sum, m, i) => sum + m * velocities[i].dx,
    0,
  );
  const totalMomentumY = masses.reduce(
    (sum, m, i) => sum + m * velocities[i].dy,
    0,
  );
  const totalMomentumZ = masses.reduce(
    (sum, m, i) => sum + m * velocities[i].dz,
    0,
  );

  for (let i = 0; i < 3; i++) {
    velocities[i].dx -= totalMomentumX / (3 * masses[i]);
    velocities[i].dy -= totalMomentumY / (3 * masses[i]);
    velocities[i].dz -= totalMomentumZ / (3 * masses[i]);
  }

  for (let i = 0; i < 3; i++) {
    bodies.push(
      createBody(
        positions[i].x,
        positions[i].y,
        positions[i].z,
        velocities[i].dx,
        velocities[i].dy,
        velocities[i].dz,
        masses[i],
        i,
        "star",
      ),
    );
  }

  let comX = 0,
    comY = 0,
    comZ = 0,
    totalMass = 0;
  for (let i = 0; i < 3; i++) {
    comX += masses[i] * positions[i].x;
    comY += masses[i] * positions[i].y;
    comZ += masses[i] * positions[i].z;
    totalMass += masses[i];
  }
  comX /= totalMass;
  comY /= totalMass;
  comZ /= totalMass;

  const planetDistance = 150 + Math.random() * 100;
  const planetAngle = Math.random() * 2 * Math.PI;
  const planetZ = (Math.random() - 0.5) * 50;
  const planetX = comX + planetDistance * Math.cos(planetAngle);
  const planetY = comY + planetDistance * Math.sin(planetAngle);

  let totalGMass = 0;
  for (let i = 0; i < 3; i++) {
    const dx = (positions[i].x - planetX) / scale;
    const dy = (positions[i].y - planetY) / scale;
    const dz = (positions[i].z - planetZ) / scale;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    totalGMass += masses[i] / Math.max(dist, 0.5);
  }
  const orbitalSpeed = Math.sqrt(totalGMass * 1) * 0.8;
  const planetVx = -orbitalSpeed * Math.sin(planetAngle);
  const planetVy = orbitalSpeed * Math.cos(planetAngle);
  const planetVz = (Math.random() - 0.5) * 0.2;

  bodies.push(
    createBody(
      planetX,
      planetY,
      planetZ,
      planetVx,
      planetVy,
      planetVz,
      0.01,
      3,
      "planet",
    ),
  );

  return bodies;
}

const container = document.getElementById("canvas-container");
const bodies = generateRandomBodies();
const sim = new NBodySim3D(container, bodies, 1, 200);

function updateControlPanel(bodies) {
  bodies.forEach((b, i) => {
    document.getElementById(`m${i + 1}`).value = b.m.toFixed(2);
    document.getElementById(`v${i + 1}x`).value = b.dx.toFixed(4);
    document.getElementById(`v${i + 1}y`).value = b.dy.toFixed(4);
    document.getElementById(`v${i + 1}z`).value = b.dz.toFixed(4);
  });
}

updateControlPanel(bodies);
sim.draw();
sim.start();

const toggleBtn = document.getElementById("togglePanel");
const controlPanel = document.getElementById("controlPanel");
const panelContainer = document.getElementById("panelContainer");
let panelExpanded = false;

let isDragging = false;
let hasMoved = false;
let dragStartX, dragStartY, containerStartX, containerStartY;

panelContainer.addEventListener("mousedown", (e) => {
  if (e.target.tagName === "INPUT") return;
  isDragging = true;
  hasMoved = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  const rect = panelContainer.getBoundingClientRect();
  containerStartX = rect.left;
  containerStartY = rect.top;
  panelContainer.style.cursor = "grabbing";
});

document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const deltaX = e.clientX - dragStartX;
  const deltaY = e.clientY - dragStartY;
  if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
    hasMoved = true;
  }
  const newX = containerStartX + deltaX;
  const newY = containerStartY + deltaY;
  panelContainer.style.left = newX + "px";
  panelContainer.style.top = newY + "px";
  panelContainer.style.right = "auto";
  panelContainer.style.transform = "none";
});

document.addEventListener("mouseup", () => {
  if (isDragging) {
    isDragging = false;
    panelContainer.style.cursor = "move";
  }
});

toggleBtn.addEventListener("click", (e) => {
  if (hasMoved) {
    hasMoved = false;
    return;
  }
  e.stopPropagation();
  panelExpanded = !panelExpanded;
  controlPanel.classList.toggle("show", panelExpanded);
  toggleBtn.classList.toggle("expanded", panelExpanded);
  toggleBtn.textContent = panelExpanded ? "✕" : "⚙";
});

function hideControlPanel() {
  if (panelExpanded) {
    panelExpanded = false;
    controlPanel.classList.remove("show");
    toggleBtn.classList.remove("expanded");
    toggleBtn.textContent = "⚙";
  }
}

document.addEventListener("click", (e) => {
  if (panelExpanded && !panelContainer.contains(e.target)) {
    hideControlPanel();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && panelExpanded) {
    hideControlPanel();
  }
});

document.addEventListener(
  "touchstart",
  (e) => {
    if (panelExpanded && !panelContainer.contains(e.target)) {
      hideControlPanel();
    }
  },
  { passive: true },
);

document.getElementById("start").onclick = () => sim.start();
document.getElementById("stop").onclick = () => sim.stop();

function resetSimulation(newBodies) {
  sim.stop();
  sim.bodies = newBodies;
  sim.totalTime = 0;
  sim.trails = newBodies.map(() => new CircularTrail3D(sim.trailLength));
  sim.initState = JSON.parse(JSON.stringify(newBodies));

  const com = sim.computeCenterOfMass();
  sim.gravityCage.updateCenter(com);
  sim.controls.target.set(com.x, com.y, com.z);

  updateControlPanel(newBodies);
  sim.draw();
}

document.getElementById("reset").onclick = () => {
  const currentG = sim.G;
  const currentDt = sim.dt;
  const currentSpeed = sim.speedMultiplier;
  const newBodies = generateRandomBodies();
  resetSimulation(newBodies);
  sim.G = currentG;
  sim.dt = currentDt;
  sim.speedMultiplier = currentSpeed;
  sim.start();
};

document.getElementById("restore").onclick = () => {
  resetSimulation(JSON.parse(JSON.stringify(sim.initState)));
  sim.start();
};

document.getElementById("speedRange").oninput = (e) => {
  document.getElementById("speedVal").textContent = e.target.value + "x";
  document.getElementById("speedInput").value = e.target.value;
  sim.speedMultiplier = +e.target.value;
};
document.getElementById("speedInput").oninput = (e) => {
  let val = Math.max(1, Math.min(50, +e.target.value || 1));
  document.getElementById("speedVal").textContent = val + "x";
  document.getElementById("speedRange").value = val;
  sim.speedMultiplier = val;
};
document.getElementById("btnTrail").onclick = (e) => {
  sim.showTrail = !sim.showTrail;
  e.target.classList.toggle("active", sim.showTrail);
};
document.getElementById("btnCom").onclick = (e) => {
  sim.showCom = !sim.showCom;
  e.target.classList.toggle("active", sim.showCom);
};
document.getElementById("btnMinDist").onclick = (e) => {
  sim.useMinDist = !sim.useMinDist;
  e.target.classList.toggle("active", sim.useMinDist);
};
document.getElementById("btnCollision").onclick = (e) => {
  sim.enableCollision = !sim.enableCollision;
  e.target.classList.toggle("active", sim.enableCollision);
};
document.getElementById("trailLength").oninput = (e) => {
  let val = Math.max(10, Math.min(5000, +e.target.value || 100));
  document.getElementById("trailLengthVal").textContent = val;
  document.getElementById("trailLengthRange").value = val;
  sim.trailLength = val;
  sim.trails.forEach((trail) => trail.resize(val));
  sim.resizeTrailMeshes();
};
document.getElementById("trailLengthRange").oninput = (e) => {
  let val = Math.max(10, Math.min(5000, +e.target.value || 100));
  document.getElementById("trailLengthVal").textContent = val;
  document.getElementById("trailLength").value = val;
  sim.trailLength = val;
  sim.trails.forEach((trail) => trail.resize(val));
  sim.resizeTrailMeshes();
};

function updateBodyParams() {
  const getVal = (id) => +document.getElementById(id).value || 0;
  sim.bodies.forEach((b, i) => {
    b.m = getVal(`m${i + 1}`) || 1;
    b.dx = getVal(`v${i + 1}x`);
    b.dy = getVal(`v${i + 1}y`);
    b.dz = getVal(`v${i + 1}z`);
    b.r = b.type === "planet" ? 3 + b.m * 10 : 5 + b.m * 2;
  });
  sim.G = getVal("gravity") || 1;
  if (!sim.timer) sim.draw();
}

[
  "m1",
  "m2",
  "m3",
  "m4",
  "v1x",
  "v1y",
  "v1z",
  "v2x",
  "v2y",
  "v2z",
  "v3x",
  "v3y",
  "v3z",
  "v4x",
  "v4y",
  "v4z",
  "gravity",
].forEach((id) => {
  document.getElementById(id).oninput = updateBodyParams;
});

document.getElementById("btnCageEnabled").onclick = (e) => {
  sim.gravityCage.enabled = !sim.gravityCage.enabled;
  e.target.classList.toggle("active", sim.gravityCage.enabled);
  if (sim.gravityCage.enabled) {
    const com = sim.computeCenterOfMass();
    sim.gravityCage.updateCenter(com);
    sim.gravityCage.showBoundariesTemporarily();
  }
  if (!sim.timer) sim.draw();
};

document.getElementById("btnCageShowBoundaries").onclick = (e) => {
  const newState = !sim.gravityCage.userShowBoundaries;
  sim.gravityCage.setUserShowBoundaries(newState);
  e.target.classList.toggle("active", newState);
  if (!sim.timer) sim.draw();
};

const syncCageParam = (
  id,
  rangeId,
  valId,
  prop,
  parser = parseFloat,
  showBoundary = false,
) => {
  const input = document.getElementById(id);
  const range = document.getElementById(rangeId);
  const valSpan = document.getElementById(valId);
  const update = (v) => {
    const val = parser(v);
    sim.gravityCage[prop] = val;
    if (valSpan) valSpan.textContent = val;
    if (input) input.value = val;
    if (range) range.value = val;
    if (showBoundary) {
      sim.gravityCage.showBoundariesTemporarily();
    }
    if (!sim.timer) sim.draw();
  };
  if (input) input.oninput = (e) => update(e.target.value);
  if (range) range.oninput = (e) => update(e.target.value);
};

syncCageParam(
  "cageBoundary",
  "cageBoundaryRange",
  "cageBoundaryVal",
  "boundaryRadius",
  parseInt,
  true,
);
syncCageParam(
  "cageWarning",
  "cageWarningRange",
  "cageWarningVal",
  "warningRadius",
  parseInt,
  true,
);
syncCageParam(
  "cageStrength",
  "cageStrengthRange",
  "cageStrengthVal",
  "strength",
  parseFloat,
  true,
);
syncCageParam(
  "cageExponent",
  "cageExponentRange",
  "cageExponentVal",
  "exponent",
  parseInt,
  true,
);
syncCageParam(
  "cageMaxMult",
  "cageMaxMultRange",
  "cageMaxMultVal",
  "maxMultiplier",
  parseInt,
  true,
);
syncCageParam(
  "cageDamping",
  "cageDampingRange",
  "cageDampingVal",
  "dampingFactor",
  parseFloat,
  true,
);

document.getElementById("btnAutoZoom").onclick = (e) => {
  sim.autoZoom.enabled = !sim.autoZoom.enabled;
  e.target.classList.toggle("active", sim.autoZoom.enabled);
  if (!sim.timer) sim.draw();
};

const syncAutoZoomParam = (
  id,
  rangeId,
  valId,
  prop,
  parser = parseFloat,
  formatter = (v) => v,
) => {
  const input = document.getElementById(id);
  const range = document.getElementById(rangeId);
  const valSpan = document.getElementById(valId);
  const update = (v) => {
    const val = parser(v);
    sim.autoZoom[prop] = val;
    if (valSpan) valSpan.textContent = formatter(val);
    if (input) input.value = val;
    if (range) range.value = val;
    if (!sim.timer) sim.draw();
  };
  if (input) input.oninput = (e) => update(e.target.value);
  if (range) range.oninput = (e) => update(e.target.value);
};

syncAutoZoomParam(
  "autoZoomSensitivity",
  "autoZoomSensitivityRange",
  "autoZoomSensitivityVal",
  "sensitivity",
  parseFloat,
  (v) => v.toFixed(2),
);
syncAutoZoomParam(
  "autoZoomPadding",
  "autoZoomPaddingRange",
  "autoZoomPaddingVal",
  "padding",
  parseFloat,
  (v) => v.toFixed(1),
);

document.getElementById("resetAutoZoom").onclick = (e) => {
  flashButton(e.target);
  document.getElementById("btnAutoZoom").classList.add("active");
  sim.autoZoom.enabled = true;
  const defaultSensitivity = 0.01;
  const defaultPadding = 2.0;
  sim.autoZoom.sensitivity = defaultSensitivity;
  sim.autoZoom.padding = defaultPadding;
  document.getElementById("autoZoomSensitivity").value = defaultSensitivity;
  document.getElementById("autoZoomSensitivityRange").value =
    defaultSensitivity;
  document.getElementById("autoZoomSensitivityVal").textContent =
    defaultSensitivity.toFixed(2);
  document.getElementById("autoZoomPadding").value = defaultPadding;
  document.getElementById("autoZoomPaddingRange").value = defaultPadding;
  document.getElementById("autoZoomPaddingVal").textContent =
    defaultPadding.toFixed(1);
  if (!sim.timer) sim.draw();
};

document.getElementById("btnAutoRotate").onclick = (e) => {
  sim.autoRotate.enabled = !sim.autoRotate.enabled;
  e.target.classList.toggle("active", sim.autoRotate.enabled);
};

function updateAutoRotateSpeed(value) {
  const speed = parseFloat(value);
  sim.autoRotate.speed = Math.max(0.5, Math.min(5, speed));
  document.getElementById("autoRotateSpeed").value = sim.autoRotate.speed;
  document.getElementById("autoRotateSpeedRange").value = sim.autoRotate.speed;
  document.getElementById("autoRotateSpeedVal").textContent =
    sim.autoRotate.speed.toFixed(1);
}

document.getElementById("autoRotateSpeed").oninput = (e) =>
  updateAutoRotateSpeed(e.target.value);
document.getElementById("autoRotateSpeedRange").oninput = (e) =>
  updateAutoRotateSpeed(e.target.value);

document.getElementById("enableAngleLimit").onchange = (e) => {
  const enabled = e.target.checked;
  document.getElementById("minAngle").disabled = !enabled;
  document.getElementById("maxAngle").disabled = !enabled;
  if (enabled) {
    sim.autoRotate.minAngle =
      parseFloat(document.getElementById("minAngle").value) || 0;
    sim.autoRotate.maxAngle =
      parseFloat(document.getElementById("maxAngle").value) || 360;
  } else {
    sim.autoRotate.minAngle = null;
    sim.autoRotate.maxAngle = null;
  }
};

document.getElementById("minAngle").oninput = (e) => {
  sim.autoRotate.minAngle = parseFloat(e.target.value) || 0;
};

document.getElementById("maxAngle").oninput = (e) => {
  sim.autoRotate.maxAngle = parseFloat(e.target.value) || 360;
};

document.getElementById("resetAutoRotate").onclick = (e) => {
  flashButton(e.target);
  sim.autoRotate.enabled = false;
  sim.autoRotate.speed = 1;
  sim.autoRotate.minAngle = null;
  sim.autoRotate.maxAngle = null;
  document.getElementById("btnAutoRotate").classList.remove("active");
  document.getElementById("autoRotateSpeed").value = 1;
  document.getElementById("autoRotateSpeedRange").value = 1;
  document.getElementById("autoRotateSpeedVal").textContent = "1.0";
  document.getElementById("enableAngleLimit").checked = false;
  document.getElementById("minAngle").disabled = true;
  document.getElementById("maxAngle").disabled = true;
  document.getElementById("minAngle").value = 0;
  document.getElementById("maxAngle").value = 360;
};

document.getElementById("btnMouseFollow").onclick = (e) => {
  sim.mouseFollow.enabled = !sim.mouseFollow.enabled;
  e.target.classList.toggle("active", sim.mouseFollow.enabled);
  if (sim.mouseFollow.enabled) {
    sim.mouseFollow.currentX = 0;
    sim.mouseFollow.currentY = 0;
    sim.mouseFollow.targetX = 0;
    sim.mouseFollow.targetY = 0;
  }
};

function updateMouseFollowSensitivity(value) {
  const val = parseFloat(value);
  sim.mouseFollow.sensitivity = Math.max(0.1, Math.min(1.0, val));
  document.getElementById("mouseFollowSensitivity").value =
    sim.mouseFollow.sensitivity;
  document.getElementById("mouseFollowSensitivityRange").value =
    sim.mouseFollow.sensitivity;
  document.getElementById("mouseFollowSensitivityVal").textContent =
    sim.mouseFollow.sensitivity.toFixed(1);
}

document.getElementById("mouseFollowSensitivity").oninput = (e) =>
  updateMouseFollowSensitivity(e.target.value);
document.getElementById("mouseFollowSensitivityRange").oninput = (e) =>
  updateMouseFollowSensitivity(e.target.value);

function updateMouseFollowMaxX(value) {
  const val = parseInt(value);
  sim.mouseFollow.maxOffsetX = Math.max(50, Math.min(500, val));
  document.getElementById("mouseFollowMaxX").value = sim.mouseFollow.maxOffsetX;
  document.getElementById("mouseFollowMaxXRange").value =
    sim.mouseFollow.maxOffsetX;
  document.getElementById("mouseFollowMaxXVal").textContent =
    sim.mouseFollow.maxOffsetX;
}

document.getElementById("mouseFollowMaxX").oninput = (e) =>
  updateMouseFollowMaxX(e.target.value);
document.getElementById("mouseFollowMaxXRange").oninput = (e) =>
  updateMouseFollowMaxX(e.target.value);

function updateMouseFollowMaxY(value) {
  const val = parseInt(value);
  sim.mouseFollow.maxOffsetY = Math.max(50, Math.min(400, val));
  document.getElementById("mouseFollowMaxY").value = sim.mouseFollow.maxOffsetY;
  document.getElementById("mouseFollowMaxYRange").value =
    sim.mouseFollow.maxOffsetY;
  document.getElementById("mouseFollowMaxYVal").textContent =
    sim.mouseFollow.maxOffsetY;
}

document.getElementById("mouseFollowMaxY").oninput = (e) =>
  updateMouseFollowMaxY(e.target.value);
document.getElementById("mouseFollowMaxYRange").oninput = (e) =>
  updateMouseFollowMaxY(e.target.value);

function updateMouseFollowSmoothing(value) {
  const val = parseFloat(value);
  sim.mouseFollow.smoothing = Math.max(0.01, Math.min(0.3, val));
  document.getElementById("mouseFollowSmoothing").value =
    sim.mouseFollow.smoothing;
  document.getElementById("mouseFollowSmoothingRange").value =
    sim.mouseFollow.smoothing;
  document.getElementById("mouseFollowSmoothingVal").textContent =
    sim.mouseFollow.smoothing.toFixed(2);
}

document.getElementById("mouseFollowSmoothing").oninput = (e) =>
  updateMouseFollowSmoothing(e.target.value);
document.getElementById("mouseFollowSmoothingRange").oninput = (e) =>
  updateMouseFollowSmoothing(e.target.value);

document.getElementById("resetMouseFollow").onclick = (e) => {
  flashButton(e.target);
  sim.mouseFollow.enabled = false;
  sim.mouseFollow.sensitivity = 0.3;
  sim.mouseFollow.maxOffsetX = 200;
  sim.mouseFollow.maxOffsetY = 150;
  sim.mouseFollow.smoothing = 0.08;
  sim.mouseFollow.targetX = 0;
  sim.mouseFollow.targetY = 0;
  sim.mouseFollow.currentX = 0;
  sim.mouseFollow.currentY = 0;
  document.getElementById("btnMouseFollow").classList.remove("active");
  document.getElementById("mouseFollowSensitivity").value = 0.3;
  document.getElementById("mouseFollowSensitivityRange").value = 0.3;
  document.getElementById("mouseFollowSensitivityVal").textContent = "0.3";
  document.getElementById("mouseFollowMaxX").value = 200;
  document.getElementById("mouseFollowMaxXRange").value = 200;
  document.getElementById("mouseFollowMaxXVal").textContent = "200";
  document.getElementById("mouseFollowMaxY").value = 150;
  document.getElementById("mouseFollowMaxYRange").value = 150;
  document.getElementById("mouseFollowMaxYVal").textContent = "150";
  document.getElementById("mouseFollowSmoothing").value = 0.08;
  document.getElementById("mouseFollowSmoothingRange").value = 0.08;
  document.getElementById("mouseFollowSmoothingVal").textContent = "0.08";
};

document.getElementById("resetGravityCage").onclick = (e) => {
  flashButton(e.target);
  document.getElementById("btnCageEnabled").classList.add("active");
  document.getElementById("btnCageShowBoundaries").classList.remove("active");
  sim.gravityCage.enabled = true;
  const defaults = {
    boundaryRadius: 1600,
    warningRadius: 700,
    strength: 1.0,
    exponent: 4,
    maxMultiplier: 100,
    dampingFactor: 0.1,
  };
  sim.gravityCage.boundaryRadius = defaults.boundaryRadius;
  sim.gravityCage.warningRadius = defaults.warningRadius;
  sim.gravityCage.strength = defaults.strength;
  sim.gravityCage.exponent = defaults.exponent;
  sim.gravityCage.maxMultiplier = defaults.maxMultiplier;
  sim.gravityCage.dampingFactor = defaults.dampingFactor;
  document.getElementById("cageBoundary").value = defaults.boundaryRadius;
  document.getElementById("cageBoundaryRange").value = defaults.boundaryRadius;
  document.getElementById("cageBoundaryVal").textContent =
    defaults.boundaryRadius;
  document.getElementById("cageWarning").value = defaults.warningRadius;
  document.getElementById("cageWarningRange").value = defaults.warningRadius;
  document.getElementById("cageWarningVal").textContent =
    defaults.warningRadius;
  document.getElementById("cageStrength").value = defaults.strength;
  document.getElementById("cageStrengthRange").value = defaults.strength;
  document.getElementById("cageStrengthVal").textContent =
    defaults.strength.toFixed(1);
  document.getElementById("cageExponent").value = defaults.exponent;
  document.getElementById("cageExponentRange").value = defaults.exponent;
  document.getElementById("cageExponentVal").textContent = defaults.exponent;
  document.getElementById("cageMaxMult").value = defaults.maxMultiplier;
  document.getElementById("cageMaxMultRange").value = defaults.maxMultiplier;
  document.getElementById("cageMaxMultVal").textContent =
    defaults.maxMultiplier;
  document.getElementById("cageDamping").value = defaults.dampingFactor;
  document.getElementById("cageDampingRange").value = defaults.dampingFactor;
  document.getElementById("cageDampingVal").textContent =
    defaults.dampingFactor.toFixed(2);
  sim.gravityCage.setUserShowBoundaries(false);
  if (!sim.timer) sim.draw();
};

document.getElementById("btnDustEnabled").onclick = (e) => {
  sim.dustConfig.enabled = !sim.dustConfig.enabled;
  e.target.classList.toggle("active", sim.dustConfig.enabled);
  if (!sim.timer) sim.draw();
};

const dustLayerInputs = [
  { id: "dustLayer1Count", valId: "dustLayer1CountVal", layerIndex: 0 },
  { id: "dustLayer2Count", valId: "dustLayer2CountVal", layerIndex: 1 },
  { id: "dustLayer3Count", valId: "dustLayer3CountVal", layerIndex: 2 },
];

dustLayerInputs.forEach(({ id, valId, layerIndex }) => {
  const input = document.getElementById(id);
  const range = document.getElementById(id + "Range");
  const val = document.getElementById(valId);

  const updateLayer = (value) => {
    const count = parseInt(value);
    sim.dustConfig.layerCounts[layerIndex] = count;
    sim.updateDustLayerVisibility(layerIndex, count);
    input.value = count;
    range.value = count;
    val.textContent = count;
  };

  input.oninput = (e) => updateLayer(e.target.value);
  range.oninput = (e) => updateLayer(e.target.value);
});

const dustDriftSpeedInput = document.getElementById("dustDriftSpeed");
const dustDriftSpeedRange = document.getElementById("dustDriftSpeedRange");
const dustDriftSpeedVal = document.getElementById("dustDriftSpeedVal");

const updateDustDriftSpeed = (value) => {
  const speed = parseFloat(value);
  sim.dustConfig.driftSpeed = speed;
  dustDriftSpeedInput.value = speed;
  dustDriftSpeedRange.value = speed;
  dustDriftSpeedVal.textContent = speed.toFixed(1);
};

dustDriftSpeedInput.oninput = (e) => updateDustDriftSpeed(e.target.value);
dustDriftSpeedRange.oninput = (e) => updateDustDriftSpeed(e.target.value);

const dustOpacityInput = document.getElementById("dustOpacity");
const dustOpacityRange = document.getElementById("dustOpacityRange");
const dustOpacityVal = document.getElementById("dustOpacityVal");

const updateDustOpacity = (value) => {
  const opacity = parseFloat(value);
  sim.dustConfig.opacityMultiplier = opacity;
  dustOpacityInput.value = opacity;
  dustOpacityRange.value = opacity;
  dustOpacityVal.textContent = opacity.toFixed(1);
};

dustOpacityInput.oninput = (e) => updateDustOpacity(e.target.value);
dustOpacityRange.oninput = (e) => updateDustOpacity(e.target.value);

const dustSizeInput = document.getElementById("dustSize");
const dustSizeRange = document.getElementById("dustSizeRange");
const dustSizeVal = document.getElementById("dustSizeVal");

const updateDustSize = (value) => {
  const size = parseFloat(value);
  sim.dustConfig.sizeMultiplier = size;
  dustSizeInput.value = size;
  dustSizeRange.value = size;
  dustSizeVal.textContent = size.toFixed(1);
};

dustSizeInput.oninput = (e) => updateDustSize(e.target.value);
dustSizeRange.oninput = (e) => updateDustSize(e.target.value);

const dustLightIntensityInput = document.getElementById("dustLightIntensity");
const dustLightIntensityRange = document.getElementById(
  "dustLightIntensityRange",
);
const dustLightIntensityVal = document.getElementById("dustLightIntensityVal");

const updateDustLightIntensity = (value) => {
  const intensity = parseFloat(value);
  sim.dustConfig.lightIntensity = intensity;
  dustLightIntensityInput.value = intensity;
  dustLightIntensityRange.value = intensity;
  dustLightIntensityVal.textContent = intensity.toFixed(1);
};

dustLightIntensityInput.oninput = (e) =>
  updateDustLightIntensity(e.target.value);
dustLightIntensityRange.oninput = (e) =>
  updateDustLightIntensity(e.target.value);

const dustMaxViewDistanceInput = document.getElementById("dustMaxViewDistance");
const dustMaxViewDistanceRange = document.getElementById(
  "dustMaxViewDistanceRange",
);
const dustMaxViewDistanceVal = document.getElementById(
  "dustMaxViewDistanceVal",
);

const updateDustMaxViewDistance = (value) => {
  const distance = parseInt(value);
  sim.dustConfig.maxViewDistance = distance;
  dustMaxViewDistanceInput.value = distance;
  dustMaxViewDistanceRange.value = distance;
  dustMaxViewDistanceVal.textContent = distance;
};

dustMaxViewDistanceInput.oninput = (e) =>
  updateDustMaxViewDistance(e.target.value);
dustMaxViewDistanceRange.oninput = (e) =>
  updateDustMaxViewDistance(e.target.value);

document.getElementById("resetDust").onclick = (e) => {
  flashButton(e.target);

  document.getElementById("btnDustEnabled").classList.add("active");
  sim.dustConfig.enabled = true;
  sim.dustConfig.driftSpeed = 1;
  sim.dustConfig.opacityMultiplier = 1;
  sim.dustConfig.sizeMultiplier = 3;
  sim.dustConfig.lightIntensity = 3;
  sim.dustConfig.maxViewDistance = 2500;
  sim.dustConfig.layerCounts = [1200, 800, 500];

  document.getElementById("dustLayer1Count").value = 1200;
  document.getElementById("dustLayer1CountRange").value = 1200;
  document.getElementById("dustLayer1CountVal").textContent = "1200";
  document.getElementById("dustLayer2Count").value = 800;
  document.getElementById("dustLayer2CountRange").value = 800;
  document.getElementById("dustLayer2CountVal").textContent = "800";
  document.getElementById("dustLayer3Count").value = 500;
  document.getElementById("dustLayer3CountRange").value = 500;
  document.getElementById("dustLayer3CountVal").textContent = "500";

  document.getElementById("dustDriftSpeed").value = 1;
  document.getElementById("dustDriftSpeedRange").value = 1;
  document.getElementById("dustDriftSpeedVal").textContent = "1.0";

  document.getElementById("dustOpacity").value = 1;
  document.getElementById("dustOpacityRange").value = 1;
  document.getElementById("dustOpacityVal").textContent = "1.0";

  document.getElementById("dustSize").value = 3;
  document.getElementById("dustSizeRange").value = 3;
  document.getElementById("dustSizeVal").textContent = "3.0";

  document.getElementById("dustLightIntensity").value = 3;
  document.getElementById("dustLightIntensityRange").value = 3;
  document.getElementById("dustLightIntensityVal").textContent = "3.0";

  document.getElementById("dustMaxViewDistance").value = 2500;
  document.getElementById("dustMaxViewDistanceRange").value = 2500;
  document.getElementById("dustMaxViewDistanceVal").textContent = "2500";

  sim.dustParticles.forEach((layer, idx) => {
    layer.mesh.geometry.setDrawRange(0, sim.dustConfig.layerCounts[idx]);
  });

  if (!sim.timer) sim.draw();
};

setInterval(() => {
  const zoomEl = document.getElementById("currentZoomLevel");
  if (zoomEl) zoomEl.textContent = sim.camera.position.length().toFixed(0);
}, 100);

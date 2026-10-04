import * as THREE from 'three';
import sharedSim from '../integration/simulationStore';

export const CITY_CONFIG = {
  scaleMultiplier: 2.0,
  defaultGrid: 8,         // 8x8 urban blocks (was 4x4) -> 108x108 footprint (2.0x of 54x54)
  compactGrid: 6,         // 6x6 urban blocks (was 3x3) -> 84x84 footprint (2.0x of 42x42)
  blockSpacing: 12.6,
  compactSpacing: 12.8,
  platformPadding: 3.6,
  avenueHalfGap: 1.4,
  openLotProbability: 0.14,
  survivorCount: 8,
  minSurvivorSpacing: 14.0
};

export const MODES_META = [
  {
    id: 'earthquake',
    name: 'Earthquake',
    icon: '🏚️',
    desc: 'Single-burst seismic event. Trigger a 10-second earthquake to observe magnitude-scaled ground displacement, P/S wave harmonics, building oscillation, and debris shedding.',
    tip: 'Drop, cover and hold on until the shaking stops. Then move to open space away from buildings and power lines.'
  },
  {
    id: 'flood',
    name: 'Flood',
    icon: '🌊',
    desc: 'River water rises and falls over the valley town. With the streets under water, unconscious survivors lie on rooftops while others wave to the boats and helicopter.',
    tip: 'Move to higher ground right away. Never walk or drive through floodwater; even shallow moving water can sweep you off your feet.'
  },
  {
    id: 'wildfire',
    name: 'Wildfire',
    icon: '🔥',
    desc: 'A fire front sweeps east through the forest, leaving burnt trees behind. Smoke drifts downwind while a water helicopter works the edge. People overcome by smoke lie in the town streets.',
    tip: 'Leave early when told to evacuate. If trapped, get to a cleared area, stay low out of the smoke and cover your nose and mouth.'
  },
  {
    id: 'tornado',
    name: 'Tornado',
    icon: '🌪️',
    desc: 'A rotating funnel tracks across farmland under a dark storm cloud, lifting debris and stripping roofs. People knocked unconscious lie in the town streets.',
    tip: 'Go to a basement or an interior room on the lowest floor, away from windows. Cover your head and neck.'
  },
  {
    id: 'volcano',
    name: 'Volcano',
    icon: '🌋',
    desc: 'The volcano erupts an ash column and throws lava bombs while glowing lava flows creep downhill. People who collapsed in the ash lie in the town streets.',
    tip: 'Follow official evacuation routes and avoid valleys where lava and mudflows travel. Cover your nose and mouth against falling ash.'
  },
  {
    id: 'tsunami',
    name: 'Tsunami',
    icon: '🌊',
    desc: 'The sea pulls back from the beach, then a wave surges ashore and floods the low coast. Unconscious survivors lie in the streets of the coastal town.',
    tip: 'If the ground shakes hard or the sea suddenly pulls back, go to high ground or far inland right away. Do not wait for an official warning.'
  },
  {
    id: 'landslide',
    name: 'Landslide',
    icon: '⛰️',
    desc: 'Boulders and mud break loose from the mountainside and slide down a channel toward the edge of town, damaging the nearest buildings. Unconscious survivors lie in the streets below the slide.',
    tip: 'Move out of the slide path quickly, sideways rather than downhill. Listen for rumbling, cracking trees or rocks knocking together.'
  }
];

export function createDisasterEngine(canvas, { onStatsUpdate, onEarthquakeUpdate } = {}) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- helpers ---------- */
  let seed = 1;
  function rand() {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const R = (a, b) => a + rand() * (b - a);
  const pick = a => a[Math.floor(rand() * a.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  function hash(x, y) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, o = 4) {
    let s = 0, a = 0.5, f = 1;
    for (let i = 0; i < o; i++) {
      s += a * vnoise(x * f, y * f);
      f *= 2;
      a *= 0.5;
    }
    return s;
  }
  const hills = (x, z, amp) => (fbm(x * 0.018 + 10, z * 0.018 + 3) - 0.5) * 2 * amp;

  /* ---------- renderer ---------- */
  if (!window.WebGLRenderingContext) {
    throw new Error('WebGL is unavailable in this browser. Please enable hardware acceleration.');
  }
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance'
  });
  if (!renderer.getContext()) {
    renderer.dispose();
    throw new Error('WebGL context creation failed. Please enable hardware acceleration.');
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  window.__rendererInfo = renderer.info;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb6c0c6);
  scene.fog = new THREE.Fog(0xb6c0c6, 90, 330);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 900);
  const amb = new THREE.AmbientLight(0xffffff, 0.22);
  scene.add(amb);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x555544, 0.75);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -130, right: 130, top: 130, bottom: -130, near: 10, far: 450 });
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0006;
  scene.add(sun);
  scene.add(sun.target);

  // Persistent PointLight avoids shader recompilation when switching to/from Volcano mode
  const ptLight = new THREE.PointLight(0xff5a1a, 0, 140);
  scene.add(ptLight);

  const world = new THREE.Group();
  scene.add(world);
  let modeGroup = new THREE.Group();
  world.add(modeGroup);
  const swarmGroup = new THREE.Group();
  world.add(swarmGroup);

  const _dummy = new THREE.Object3D();
  const PSCALE = (navigator.hardwareConcurrency || 4) <= 4 ? 0.55 : 1;

  function resize() {
    const w = Math.max(1, canvas.clientWidth || window.innerWidth || 1);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight || 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  const resizeObs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (resizeObs) resizeObs.observe(canvas);
  resize();

  /* ---------- shared assets ---------- */
  const shared = new Set();
  const G = {
    body: new THREE.CylinderGeometry(0.33, 0.38, 1.15, 8),
    head: new THREE.SphereGeometry(0.28, 10, 8),
    limb: new THREE.BoxGeometry(0.17, 0.8, 0.17),
    helmet: new THREE.SphereGeometry(0.32, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    trunk: new THREE.CylinderGeometry(0.25, 0.35, 2, 6),
    crown: new THREE.ConeGeometry(1.8, 4.5, 7),
    box: new THREE.BoxGeometry(1, 1, 1),
    rock: new THREE.DodecahedronGeometry(1, 0),
    wheel: new THREE.CylinderGeometry(0.5, 0.5, 0.4, 10),
    heli: new THREE.SphereGeometry(1.4, 10, 8),
    blob: new THREE.SphereGeometry(1, 10, 6),
    beacon: new THREE.OctahedronGeometry(0.45),
    ring: new THREE.RingGeometry(1.1, 1.4, 24),
    droneRotor: new THREE.CylinderGeometry(0.65, 0.65, 0.06, 12),
    droneRing: new THREE.RingGeometry(1.35, 1.75, 24),
    selRing: new THREE.RingGeometry(2.1, 2.6, 28),
    hitSphere: new THREE.SphereGeometry(3.2, 8, 8),
    zoneCyl: new THREE.CylinderGeometry(1, 1, 14, 28, 1, true),
    zoneRing: new THREE.RingGeometry(0.94, 1.0, 32),
    beamCyl: new THREE.CylinderGeometry(0.18, 0.55, 1, 10, 1, true),
    apfSphere: new THREE.SphereGeometry(1.5, 14, 10),
    apfRing: new THREE.RingGeometry(2.8, 3.0, 28),
    downwashCone: new THREE.CylinderGeometry(0.7, 3.2, 9.0, 16, 1, true),
    tierHalo: new THREE.RingGeometry(1.85, 2.2, 24),
    lidarCone: new THREE.ConeGeometry(7.0, 14.0, 16, 1, true),
    octoBox: new THREE.BoxGeometry(1.0, 1.0, 1.0),
    packetSphere: new THREE.SphereGeometry(0.35, 8, 8),
    hazardPyramid: new THREE.ConeGeometry(2.4, 4.8, 4),
    gasCloud: new THREE.SphereGeometry(3.5, 12, 10)
  };
  Object.values(G).forEach(g => shared.add(g));

  const matCache = new Map();
  function M(hex, opts) {
    const key = hex + (opts ? JSON.stringify(opts) : '');
    if (!matCache.has(key)) {
      const m = new THREE.MeshStandardMaterial(
        Object.assign({ color: hex, roughness: 0.85, metalness: 0, flatShading: true }, opts || {})
      );
      shared.add(m);
      matCache.set(key, m);
    }
    return matCache.get(key);
  }

  const dotTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.45, 'rgba(255,255,255,.6)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  shared.add(dotTex);

  const windowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#5a6b80';
    [[10, 12], [38, 12], [10, 40], [38, 40]].forEach(([x, y]) => g.fillRect(x, y, 16, 16));
    g.fillStyle = 'rgba(255,255,255,.35)';
    [[10, 12], [38, 12], [10, 40], [38, 40]].forEach(([x, y]) => g.fillRect(x, y, 6, 16));
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  })();
  shared.add(windowTex);

  const crackedWindowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#f2efe9';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#4b5a6c';
    [[10, 12], [38, 12], [10, 40], [38, 40]].forEach(([x, y]) => g.fillRect(x, y, 16, 16));
    g.fillStyle = 'rgba(255,255,255,.25)';
    [[10, 12], [38, 12], [10, 40], [38, 40]].forEach(([x, y]) => g.fillRect(x, y, 6, 16));

    // Hairline diagonal and branching fracture lines across facade & window panes
    g.strokeStyle = '#2b2622';
    g.lineWidth = 1.2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(6, 2);
    g.lineTo(14, 16);
    g.lineTo(19, 23);
    g.lineTo(12, 33);
    g.lineTo(22, 45);
    g.stroke();

    g.beginPath();
    g.moveTo(48, 6);
    g.lineTo(43, 19);
    g.lineTo(52, 28);
    g.lineTo(39, 43);
    g.lineTo(44, 58);
    g.stroke();

    // Subtle horizontal shear branch
    g.strokeStyle = 'rgba(43,38,34,0.7)';
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(19, 23);
    g.lineTo(32, 26);
    g.lineTo(43, 19);
    g.stroke();

    // Fractured glass highlights
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(12, 14); g.lineTo(24, 25);
    g.moveTo(40, 42); g.lineTo(51, 52);
    g.stroke();

    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  })();
  shared.add(crackedWindowTex);

  const damagedWindowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    // Stained, distressed concrete base
    g.fillStyle = '#d8d0c2';
    g.fillRect(0, 0, 64, 64);

    // Distress staining patches
    g.fillStyle = 'rgba(75, 60, 45, 0.22)';
    g.beginPath();
    g.arc(20, 30, 18, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(46, 44, 16, 0, Math.PI * 2);
    g.fill();

    // Windows: shattered & blackened panes
    g.fillStyle = '#343e4a';
    g.fillRect(10, 12, 16, 16);
    g.fillStyle = '#181b20';
    g.fillRect(38, 12, 16, 16);
    g.fillStyle = '#28323d';
    g.fillRect(10, 40, 16, 16);
    g.fillStyle = '#14161a';
    g.fillRect(38, 40, 16, 16);

    // Jagged glass remnants on shattered window
    g.fillStyle = '#657a91';
    g.beginPath();
    g.moveTo(38, 12); g.lineTo(45, 12); g.lineTo(41, 18); g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(54, 24); g.lineTo(54, 28); g.lineTo(48, 28); g.closePath();
    g.fill();

    // Heavy structural fracture lines (dark thick fissures)
    g.strokeStyle = '#15120e';
    g.lineWidth = 2.2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(2, 8);
    g.lineTo(16, 20);
    g.lineTo(24, 18);
    g.lineTo(34, 38);
    g.lineTo(48, 44);
    g.lineTo(60, 56);
    g.stroke();

    // Cross-shear fracture
    g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(58, 4);
    g.lineTo(44, 22);
    g.lineTo(34, 38);
    g.lineTo(18, 48);
    g.lineTo(8, 62);
    g.stroke();

    // Concrete spall exposing darker aggregate core
    g.fillStyle = '#856e5c';
    g.fillRect(29, 33, 9, 9);
    g.strokeStyle = '#382f27';
    g.lineWidth = 1;
    g.strokeRect(29, 33, 9, 9);

    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  })();
  shared.add(damagedWindowTex);

  const bMatCache = new Map();
  function BM(hex) {
    if (!bMatCache.has(hex)) {
      const m = new THREE.MeshStandardMaterial({ color: hex, map: windowTex, roughness: 0.9, flatShading: true });
      shared.add(m);
      bMatCache.set(hex, m);
    }
    return bMatCache.get(hex);
  }

  const bMatCrackedCache = new Map();
  function BM_Cracked(hex) {
    if (!bMatCrackedCache.has(hex)) {
      const m = new THREE.MeshStandardMaterial({ color: hex, map: crackedWindowTex, roughness: 0.92, flatShading: true });
      shared.add(m);
      bMatCrackedCache.set(hex, m);
    }
    return bMatCrackedCache.get(hex);
  }

  const bMatDamagedCache = new Map();
  function BM_Damaged(hex) {
    if (!bMatDamagedCache.has(hex)) {
      const col = new THREE.Color(hex).multiplyScalar(0.88);
      const m = new THREE.MeshStandardMaterial({ color: col, map: damagedWindowTex, roughness: 0.95, flatShading: true });
      shared.add(m);
      bMatDamagedCache.set(hex, m);
    }
    return bMatDamagedCache.get(hex);
  }

  function buildingGeo(w, h, d) {
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.attributes.uv;
    for (let f = 0; f < 6; f++) {
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        let u = uv.getX(i), v = uv.getY(i);
        if (f === 2 || f === 3) {
          u = 0.02;
          v = 0.02;
        } else {
          const fw = f < 2 ? d : w;
          u *= Math.max(1, Math.round(fw / 3.4));
          v *= Math.max(1, Math.round(h / 3.4));
        }
        uv.setXY(i, u, v);
      }
    }
    return g;
  }

  /* ---------- state ---------- */
  const W = 280, SEG = 170;
  let H = () => 0;
  let curMode = null;
  let ctx = {};
  let INT = 1;
  let paused = false;
  let showPeople = true;
  let viewMode = '3d';
  let agents = [], victimList = [], obstacles = [], buildings = [], parts = [], sirens = [], helis = [], modeT = 0;

  function clearMode() {
    world.remove(modeGroup);
    const disposed = new Set();
    modeGroup.traverse(o => {
      if (o.geometry && !shared.has(o.geometry) && !disposed.has(o.geometry)) {
        disposed.add(o.geometry);
        o.geometry.dispose();
      }
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
          if (m && !shared.has(m) && !disposed.has(m)) {
            disposed.add(m);
            m.dispose();
          }
        });
      }
    });
    modeGroup.clear();
    modeGroup = new THREE.Group();
    world.add(modeGroup);
    world.position.set(0, 0, 0);
    ptLight.intensity = 0;
    agents = [];
    victimList = [];
    obstacles = [];
    buildings = [];
    parts = [];
    sirens = [];
    helis = [];
  }

  /* ---------- terrain ---------- */
  function makeH(m) {
    const raw = m.raw, [tx, tz] = m.town, [sx, sz] = m.safe;
    const tl = m.townLevel ?? raw(tx, tz), sl = m.safeLevel ?? raw(sx, sz);
    m._townLevel = tl;
    const r0 = m.townR, r1 = m.townR + 20;
    return (x, z) => {
      let h = raw(x, z);
      const dt = Math.max(Math.abs(x - tx), Math.abs(z - tz));
      if (dt < r1) h = tl + (h - tl) * smooth(r0, r1, dt);
      const ds = Math.hypot(x - sx, z - sz);
      if (ds < 18) h = sl + (h - sl) * smooth(9, 18, ds);
      return h;
    };
  }

  const _c2 = new THREE.Color();
  function natural(c, x, y, z, s, o = {}) {
    const n = vnoise(x * 0.09 + 5, z * 0.09 + 9);
    c.set(o.grass ?? 0x5f8a3c);
    _c2.set(o.dry ?? 0x93904f);
    c.lerp(_c2, n * 0.6);
    if (o.sandBelow !== undefined) {
      _c2.set(o.sand ?? 0xd8c48f);
      c.lerp(_c2, smooth(o.sandBelow, o.sandBelow - 1.5, y));
    }
    _c2.set(o.rock ?? 0x7d756b);
    c.lerp(_c2, smooth(0.18, 0.42, s));
    return c;
  }

  function buildTerrain(m) {
    const geo = new THREE.PlaneGeometry(W, W, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, H(pos.getX(i), pos.getZ(i)));
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal, cols = new Float32Array(pos.count * 3), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), s = 1 - nrm.getY(i);
      if (m.color) m.color(c, x, y, z, s);
      else natural(c, x, y, z, s);
      cols[i * 3] = c.r;
      cols[i * 3 + 1] = c.g;
      cols[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
    mesh.receiveShadow = true;
    modeGroup.add(mesh);
  }
  function slopeAt(x, z) {
    return Math.hypot(H(x + 1, z) - H(x - 1, z), H(x, z + 1) - H(x, z - 1)) / 2;
  }

  /* ---------- particles ---------- */
  class Particles {
    constructor(n, o) {
      n = Math.max(10, Math.round(n * PSCALE));
      this.n = n;
      this.o = o;
      this.pos = new Float32Array(n * 3);
      this.vel = new Float32Array(n * 3);
      this.life = new Float32Array(n);
      this.geo = new THREE.BufferGeometry();
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      this.mat = new THREE.PointsMaterial({
        color: o.color,
        size: o.size,
        map: dotTex,
        transparent: true,
        opacity: o.opacity ?? 1,
        depthWrite: false,
        blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        sizeAttenuation: true
      });
      this.points = new THREE.Points(this.geo, this.mat);
      this.points.frustumCulled = false;
      modeGroup.add(this.points);
      for (let i = 0; i < n; i++) {
        o.spawn(i, this, true);
        if (o.prewarm) this.life[i] *= rand();
      }
      parts.push(this);
    }
    set(i, x, y, z, vx, vy, vz, l) {
      const k = i * 3;
      this.pos[k] = x;
      this.pos[k + 1] = y;
      this.pos[k + 2] = z;
      this.vel[k] = vx;
      this.vel[k + 1] = vy;
      this.vel[k + 2] = vz;
      this.life[i] = l;
    }
    update(dt) {
      const p = this.pos, v = this.vel, o = this.o;
      for (let i = 0; i < this.n; i++) {
        const k = i * 3;
        if (o.step) o.step(i, dt, this);
        p[k] += v[k] * dt;
        p[k + 1] += v[k + 1] * dt;
        p[k + 2] += v[k + 2] * dt;
        this.life[i] -= dt;
        if (this.life[i] <= 0) o.spawn(i, this, false);
      }
      this.geo.attributes.position.needsUpdate = true;
    }
  }

  function precip(n, { color, size, opacity, fall, wind, height = 80, spread = 180 }) {
    return new Particles(n, {
      color,
      size,
      opacity,
      spawn: (i, p, init) => {
        const t = orbit.target;
        p.set(i, t.x + R(-spread / 2, spread / 2), init ? R(-2, height) : height, t.z + R(-spread / 2, spread / 2), 0, 0, 0, 1e9);
      },
      step: (i, _dt, p) => {
        const k = i * 3;
        p.vel[k] = wind * INT + Math.sin(modeT * 1.3 + i) * 1.2;
        p.vel[k + 1] = -fall * (0.75 + INT * 0.3);
        p.vel[k + 2] = wind * 0.3 * INT;
        if (p.pos[k + 1] < -3) p.life[i] = 0;
      }
    });
  }

  /* ---------- scenery ---------- */
  const BCOL = [0xd9d0c3, 0xbab3a7, 0xc9a98a, 0xa3b3bb, 0xe0d6b4, 0xa99689, 0xcbc6be, 0xb7c2a6];
  function rubble(x, z, w, d, level) {
    const inst = new THREE.InstancedMesh(G.box, M(0x9b9389), 14);
    inst.castShadow = true;
    for (let k = 0; k < 14; k++) {
      _dummy.scale.set(R(0.8, 3), R(0.4, 1.6), R(0.8, 3));
      _dummy.position.set(x + R(-w / 2, w / 2), level + R(0.2, 1.3), z + R(-d / 2, d / 2));
      _dummy.rotation.set(R(-0.6, 0.6), R(0, 3), R(-0.6, 0.6));
      _dummy.updateMatrix();
      inst.setMatrixAt(k, _dummy.matrix);
      _c2.set(pick([0x9b9389, 0x857c72, 0xb0a698, 0x6f6a64]));
      inst.setColorAt(k, _c2);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    modeGroup.add(inst);
    const wall = new THREE.Mesh(G.box, BM(pick(BCOL)));
    wall.scale.set(w * 0.8, R(2, 4), 0.6);
    wall.position.set(x, level + 1.5, z - d / 2 + 0.4);
    wall.rotation.z = R(-0.15, 0.15);
    wall.castShadow = true;
    modeGroup.add(wall);
  }

  function addTown(cx, cz, level, o = {}) {
    const isCompact = Boolean(o.compact || o.grid === 3 || o.grid === CITY_CONFIG.compactGrid);
    const grid = o.grid
      ? (o.grid <= 4 ? o.grid * CITY_CONFIG.scaleMultiplier : o.grid)
      : (isCompact ? CITY_CONFIG.compactGrid : CITY_CONFIG.defaultGrid);
    const sp = isCompact ? CITY_CONFIG.compactSpacing : CITY_CONFIG.blockSpacing;
    const half = Math.round((grid * sp) / 2 + CITY_CONFIG.platformPadding);
    curMode._townHalf = half;
    curMode.cityBounds = {
      centerX: cx,
      centerZ: cz,
      halfSize: half,
      width: half * 2,
      depth: half * 2,
      minX: cx - half,
      maxX: cx + half,
      minZ: cz - half,
      maxZ: cz + half
    };

    const pg = new THREE.PlaneGeometry(half * 2, half * 2);
    pg.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(pg, M(o.snow ? 0xe3e9ee : 0x5b5f62));
    ground.position.set(cx, level + 0.06, cz);
    ground.receiveShadow = true;
    modeGroup.add(ground);

    // Main cross-avenue road strips across the expanded urban district
    const roadMat = M(o.snow ? 0xcfd8e0 : 0x484c50);
    const roadEWGeo = new THREE.PlaneGeometry(half * 2 - 2, 5.2);
    roadEWGeo.rotateX(-Math.PI / 2);
    const roadEW = new THREE.Mesh(roadEWGeo, roadMat);
    roadEW.position.set(cx, level + 0.08, cz);
    roadEW.receiveShadow = true;
    const roadNSGeo = new THREE.PlaneGeometry(5.2, half * 2 - 2);
    roadNSGeo.rotateX(-Math.PI / 2);
    const roadNS = new THREE.Mesh(roadNSGeo, roadMat);
    roadNS.position.set(cx, level + 0.085, cz);
    roadNS.receiveShadow = true;
    modeGroup.add(roadEW, roadNS);

    for (let i = 0; i < grid; i++) {
      for (let j = 0; j < grid; j++) {
        const aveX = CITY_CONFIG.avenueHalfGap * (i >= grid / 2 ? 1 : -1);
        const aveZ = CITY_CONFIG.avenueHalfGap * (j >= grid / 2 ? 1 : -1);
        const x = cx + (i - (grid - 1) / 2) * sp + aveX + R(-0.55, 0.55);
        const z = cz + (j - (grid - 1) / 2) * sp + aveZ + R(-0.55, 0.55);
        if (rand() < (isCompact ? 0.11 : CITY_CONFIG.openLotProbability)) continue;
        const distNorm = Math.hypot(i - (grid - 1) / 2, j - (grid - 1) / 2) / (grid * 0.7);
        const w = R(5, 8.5), d = R(5, 8.5), h = R(4.5, 15.5) * (1.12 - distNorm * 0.24);
        const dmg = typeof o.damage === 'function' ? o.damage(x, z) : (o.damage || 0);
        if (dmg > 0 && rand() < dmg * 0.3) {
          rubble(x, z, w, d, level);
          buildings.push({ x, z, hw: w / 2, hd: d / 2, top: level + 1.5, rubble: true });
          continue;
        }
        const hex = pick(BCOL);
        const intactMat = BM(hex);
        const crackedMat = BM_Cracked(hex);
        const damagedMat = BM_Damaged(hex);
        const mesh = new THREE.Mesh(buildingGeo(w, h, d), intactMat);
        mesh.position.set(x, level + h / 2, z);
        mesh.castShadow = mesh.receiveShadow = true;
        const rh = o.snow ? 0.8 : 0.35;
        const roofMat = M(o.snow ? 0xf4f7f9 : 0x4d4a48);
        const roof = new THREE.Mesh(G.box, roofMat);
        roof.scale.set(w + 0.4, rh, d + 0.4);
        roof.position.y = h / 2 + rh / 2;
        roof.castShadow = true;
        mesh.add(roof);

        // Pre-create hidden rubble group for zero-allocation runtime collapse
        const rubbleGroup = new THREE.Group();
        rubbleGroup.position.set(x, level, z);
        rubbleGroup.visible = false;

        const rubbleBlocks = new THREE.InstancedMesh(G.box, M(0x8a8278), 14);
        rubbleBlocks.castShadow = true;
        for (let k = 0; k < 14; k++) {
          _dummy.scale.set(R(0.8, Math.min(w * 0.55, 3.2)), R(0.4, 1.4), R(0.8, Math.min(d * 0.55, 3.2)));
          _dummy.position.set(R(-w * 0.45, w * 0.45), R(0.2, 1.3), R(-d * 0.45, d * 0.45));
          _dummy.rotation.set(R(-0.6, 0.6), R(0, 3.14), R(-0.6, 0.6));
          _dummy.updateMatrix();
          rubbleBlocks.setMatrixAt(k, _dummy.matrix);
          _c2.set(pick([0x9b9389, 0x857c72, 0xb0a698, 0x6f6a64]));
          rubbleBlocks.setColorAt(k, _c2);
        }
        rubbleBlocks.instanceMatrix.needsUpdate = true;
        if (rubbleBlocks.instanceColor) rubbleBlocks.instanceColor.needsUpdate = true;
        rubbleGroup.add(rubbleBlocks);

        // Crumbled perimeter wall remnants
        const brokenWall = new THREE.Mesh(G.box, damagedMat);
        brokenWall.scale.set(w * 0.72, R(1.6, 3.0), 0.6);
        brokenWall.position.set(0, 1.2, -d * 0.32);
        brokenWall.rotation.set(R(-0.08, 0.08), R(-0.2, 0.2), R(-0.15, 0.15));
        brokenWall.castShadow = true;
        rubbleGroup.add(brokenWall);

        modeGroup.add(rubbleGroup);

        const b = {
          x,
          z,
          w,
          h,
          d,
          rh,
          level,
          hw: w / 2,
          hd: d / 2,
          top: level + h + rh,
          initTop: level + h + rh,
          mesh,
          roof,
          rubbleGroup,
          intactMat,
          crackedMat,
          damagedMat,
          initPosX: x,
          initPosY: level + h / 2,
          initPosZ: z,
          tz: 0,
          tilt: false,
          damageState: 'intact',
          accumulatedStress: 0,
          resistance: R(0.92, 1.15),
          targetSubsidence: 0,
          currentSubsidence: 0,
          targetTiltX: 0,
          targetTiltZ: 0,
          currentTiltX: 0,
          currentTiltZ: 0,
          shearX: 0,
          shearZ: 0,
        };
        if (rand() < dmg * 0.5) {
          b.tz = R(-0.18, 0.18);
          b.targetTiltZ = b.tz;
          b.currentTiltZ = b.tz;
          mesh.rotation.z = b.tz;
          mesh.rotation.x = R(-0.1, 0.1);
          b.currentTiltX = mesh.rotation.x;
          b.targetTiltX = mesh.rotation.x;
          mesh.position.y -= 0.4;
          b.currentSubsidence = 0.4;
          b.targetSubsidence = 0.4;
          b.tilt = true;
        }
        modeGroup.add(mesh);
        buildings.push(b);
      }
    }
  }

  function okTree(x, z, minY = -99) {
    const m = curMode;
    if (Math.max(Math.abs(x - m.town[0]), Math.abs(z - m.town[1])) < m.townR + 2) return false;
    if (Math.hypot(x - m.safe[0], z - m.safe[1]) < 15) return false;
    if (H(x, z) < minY) return false;
    return slopeAt(x, z) < 1.1;
  }

  function addTrees(n, accept, crownCol, dynamic = false) {
    const list = [];
    let tries = 0;
    if (!dynamic) {
      const pts = [];
      while (pts.length < n && tries < n * 25) {
        tries++;
        const x = R(-125, 125), z = R(-125, 125);
        if (!accept(x, z)) continue;
        const y = H(x, z), col = crownCol ?? pick([0x3f6b35, 0x4c7a3a, 0x35603a]), s = R(0.7, 1.4);
        pts.push({ x, y, z, s, col });
      }
      if (pts.length) {
        const trunks = new THREE.InstancedMesh(G.trunk, M(0x6b4a2f), pts.length);
        const crowns = new THREE.InstancedMesh(G.crown, M(crownCol ?? 0xffffff), pts.length);
        crowns.castShadow = true;
        pts.forEach((p, i) => {
          _dummy.rotation.set(0, 0, 0);
          _dummy.scale.setScalar(p.s);
          _dummy.position.set(p.x, p.y + p.s, p.z);
          _dummy.updateMatrix();
          trunks.setMatrixAt(i, _dummy.matrix);
          _dummy.position.set(p.x, p.y + 4.2 * p.s, p.z);
          _dummy.updateMatrix();
          crowns.setMatrixAt(i, _dummy.matrix);
          if (crownCol === undefined) {
            _c2.set(p.col);
            crowns.setColorAt(i, _c2);
          }
          list.push({ x: p.x, z: p.z, y: p.y, s: p.s, state: 0 });
        });
        trunks.instanceMatrix.needsUpdate = true;
        crowns.instanceMatrix.needsUpdate = true;
        if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
        modeGroup.add(trunks, crowns);
      }
      return list;
    }
    while (list.length < n && tries < n * 25) {
      tries++;
      const x = R(-125, 125), z = R(-125, 125);
      if (!accept(x, z)) continue;
      const y = H(x, z), g = new THREE.Group();
      const trunk = new THREE.Mesh(G.trunk, M(0x6b4a2f));
      trunk.position.y = 1;
      const crown = new THREE.Mesh(G.crown, M(crownCol ?? pick([0x3f6b35, 0x4c7a3a, 0x35603a])));
      crown.position.y = 4.2;
      crown.castShadow = true;
      g.add(trunk, crown);
      const s = R(0.7, 1.4);
      g.scale.setScalar(s);
      g.position.set(x, y, z);
      modeGroup.add(g);
      list.push({ g, crown, trunk, x, z, y, s, state: 0 });
    }
    return list;
  }

  function makeVehicle(color, lights, x, z, rot) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(G.box, M(color));
    body.scale.set(4.8, 1.7, 2.2);
    body.position.y = 1.35;
    body.castShadow = true;
    const cab = new THREE.Mesh(G.box, M(0x2c3a46));
    cab.scale.set(1.6, 1.1, 2.05);
    cab.position.set(1.5, 2.75, 0);
    g.add(body, cab);
    [[1.6, 1], [1.6, -1], [-1.6, 1], [-1.6, -1]].forEach(([wx, wz]) => {
      const w = new THREE.Mesh(G.wheel, M(0x1e1e1e));
      w.rotation.x = Math.PI / 2;
      w.position.set(wx, 0.5, wz);
      g.add(w);
    });
    g.userData.lights = [];
    if (lights) {
      lights.forEach((lc, k) => {
        const l = new THREE.Mesh(G.box, new THREE.MeshStandardMaterial({ color: 0x222222, emissive: lc, emissiveIntensity: 0 }));
        l.scale.set(0.5, 0.3, 0.6);
        l.position.set(1.5, 3.45, k ? 0.5 : -0.5);
        g.add(l);
        g.userData.lights.push(l);
      });
      sirens.push(g);
    }
    g.position.set(x, H(x, z), z);
    g.rotation.y = rot || 0;
    modeGroup.add(g);
    obstacles.push({ x, z, hw: 2.8, hd: 2.8 });
    return g;
  }

  function makeHeli(color, center, rad, alt, speed) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(G.heli, M(color));
    body.scale.set(1.8, 1, 1);
    body.castShadow = true;
    const tail = new THREE.Mesh(G.box, M(color));
    tail.scale.set(4.2, 0.35, 0.35);
    tail.position.set(-3.6, 0.3, 0);
    const rotor = new THREE.Group();
    rotor.position.y = 1.5;
    const b1 = new THREE.Mesh(G.box, M(0x222222));
    b1.scale.set(11, 0.08, 0.45);
    const b2 = b1.clone();
    b2.rotation.y = Math.PI / 2;
    rotor.add(b1, b2);
    const sk = new THREE.Mesh(G.box, M(0x333333));
    sk.scale.set(3.4, 0.12, 0.12);
    sk.position.set(0, -1.5, 0.8);
    const sk2 = sk.clone();
    sk2.position.z = -0.8;
    g.add(body, tail, rotor, sk, sk2);
    modeGroup.add(g);
    helis.push({ g, rotor, center, rad, alt, speed, ang: rand() * 6.28 });
  }

  /* ---------- people ---------- */
  const SKIN = [0xf1c9a5, 0xd9a27a, 0xb07850, 0x7d5233, 0x5a3a22];
  const SHIRTS = [0x3b6ea8, 0x8c3b3b, 0x4a7a4a, 0x7a5a9a, 0xc9b458, 0x2f4f5f, 0xa86a3b, 0xd0d0d0];
  function makePerson(kind) {
    const g = new THREE.Group(), resc = kind === 'rescuer';
    const shirt = resc ? 0xff7a1a : pick(SHIRTS), pants = resc ? 0x2b3a4a : pick([0x2c3440, 0x4b3b2b, 0x1f2a36, 0x5b5b5b]);
    const body = new THREE.Mesh(G.body, M(shirt));
    body.position.y = 1.45;
    body.castShadow = true;
    const head = new THREE.Mesh(G.head, M(pick(SKIN)));
    head.position.y = 2.3;
    g.add(body, head);
    if (resc) {
      const h = new THREE.Mesh(G.helmet, M(0xffd23a));
      h.position.y = 2.33;
      g.add(h);
    }
    const limb = (x, y, col) => {
      const p = new THREE.Group();
      p.position.set(x, y, 0);
      const m = new THREE.Mesh(G.limb, M(col));
      m.position.y = -0.4;
      p.add(m);
      g.add(p);
      return p;
    };
    g.userData.limbs = {
      legL: limb(-0.15, 0.88, pants),
      legR: limb(0.15, 0.88, pants),
      armL: limb(-0.47, 1.95, shirt),
      armR: limb(0.47, 1.95, shirt)
    };
    return g;
  }

  const VMAT = {
    wait: M(0xff3b30, { emissive: 0xff2010, emissiveIntensity: 1.3 }),
    surveying: M(0xf59e0b, { emissive: 0xd97706, emissiveIntensity: 1.4 }),
    surveyed: M(0x10b981, { emissive: 0x059669, emissiveIntensity: 1.4 }),
    selected: M(0x38bdf8, { emissive: 0x0ea5e9, emissiveIntensity: 1.6, side: THREE.DoubleSide }),
    hitInvisible: new THREE.MeshBasicMaterial({ visible: false })
  };
  shared.add(VMAT.hitInvisible);

  function addAgent(kind, x, z, o = {}) {
    const g = makePerson(kind);
    g.position.set(x, 0, z);
    g.visible = showPeople;
    modeGroup.add(g);
    const a = { g, kind, state: o.state || 'wave', phase: rand() * 6, fixedY: o.fixedY };
    agents.push(a);
    return a;
  }

  function makeVictim(x, z, th, fixedY) {
    const id = `SURV-${String(victimList.length + 1).padStart(2, '0')}`;
    const g = new THREE.Group(), p = makePerson('resident');
    p.rotation.x = -Math.PI / 2;
    p.position.y = 0.42;
    const L = p.userData.limbs;
    L.armL.rotation.z = -R(0.2, 0.6);
    L.armR.rotation.z = R(0.2, 0.7);
    L.legL.rotation.z = -R(0, 0.15);
    L.legR.rotation.z = R(0, 0.2);
    const beacon = new THREE.Mesh(G.beacon, VMAT.wait);
    beacon.position.set(0, 3.4, -1.1);
    const ring = new THREE.Mesh(G.ring, VMAT.wait);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.18, -1.1);
    const selRing = new THREE.Mesh(G.selRing, VMAT.selected);
    selRing.rotation.x = -Math.PI / 2;
    selRing.position.set(0, 0.26, -1.1);
    selRing.visible = false;
    const hitMesh = new THREE.Mesh(G.hitSphere, VMAT.hitInvisible);
    hitMesh.position.set(0, 1.8, -1.1);
    hitMesh.userData = { pickType: 'poi', poiId: id, survivorId: id };
    g.add(p, beacon, ring, selRing, hitMesh);
    g.rotation.y = th;
    g.visible = showPeople;
    modeGroup.add(g);
    const v = { id, g, beacon, ring, selRing, hitMesh, phase: rand() * 6, fixedY, x, z };
    g.position.set(x, (fixedY ?? H(x, z)) + 0.05, z);
    victimList.push(v);
  }

  function blocked(x, z, m) {
    for (const b of buildings) if (Math.abs(x - b.x) < b.hw + m && Math.abs(z - b.z) < b.hd + m) return true;
    for (const b of obstacles) if (Math.abs(x - b.x) < b.hw + m && Math.abs(z - b.z) < b.hd + m) return true;
    return false;
  }

  function scatterVictims() {
    const m = curMode, [cx, cz] = m.town, half = (m._townHalf || m.townR) - 2.2;
    const targetCount = CITY_CONFIG.survivorCount;
    if (m.roofVictims) {
      const avail = buildings.filter(b => b.mesh && !b.taken).sort(() => rand() - 0.5);
      const chosen = [];
      for (const b of avail) {
        if (chosen.length >= targetCount) break;
        if (chosen.every(c => Math.hypot(c.x - b.x, c.z - b.z) >= CITY_CONFIG.minSurvivorSpacing)) {
          chosen.push(b);
        }
      }
      for (const b of avail) {
        if (chosen.length >= targetCount) break;
        if (!chosen.includes(b)) chosen.push(b);
      }
      chosen.forEach(b => {
        const th = rand() * 6.28;
        makeVictim(b.x + 1.1 * Math.sin(th), b.z + 1.1 * Math.cos(th), th, b.top);
      });
      return;
    }
    const n = targetCount, cells = Math.ceil(Math.sqrt(n * 3)), step = (2 * half) / cells, cand = [];
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        cand.push([cx - half + (i + R(0.12, 0.88)) * step, cz - half + (j + R(0.12, 0.88)) * step]);
      }
    }
    cand.sort(() => rand() - 0.5);
    const placed = [], inside = (x, z) => Math.abs(x - cx) < half && Math.abs(z - cz) < half;
    for (const [x0, z0] of cand) {
      if (placed.length >= n) break;
      for (let k = 0; k < 18; k++) {
        const x = x0 + R(-step * 0.4, step * 0.4), z = z0 + R(-step * 0.4, step * 0.4), th = rand() * 6.28;
        const sx = Math.sin(th), sz = Math.cos(th);
        const pts = [[x, z], [x - 1.15 * sx, z - 1.15 * sz], [x - 2.4 * sx, z - 2.4 * sz]];
        if (pts.some(([px, pz]) => !inside(px, pz) || blocked(px, pz, 0.45))) continue;
        const mx = x - 1.15 * sx, mz = z - 1.15 * sz;
        if (placed.some(q => Math.hypot(q[0] - mx, q[1] - mz) < CITY_CONFIG.minSurvivorSpacing)) continue;
        placed.push([mx, mz]);
        makeVictim(x, z, th);
        break;
      }
    }
  }

  function updateAgents(dt, t) {
    for (const a of agents) {
      const L = a.g.userData.limbs;
      L.armL.rotation.z = -2.6 + Math.sin(t * 6 + a.phase) * 0.45;
      L.armR.rotation.z = 2.6 - Math.sin(t * 6 + a.phase + 1) * 0.45;
      a.g.position.y = a.fixedY;
    }
    const selPoiId = sharedSim.state.selection.selectedPoiId;
    const survMap = new Map(sharedSim.state.survivors.map(s => [s.id, s]));
    for (const v of victimList) {
      v.beacon.position.y = 3.4 + Math.sin(t * 2.5 + v.phase) * 0.3;
      v.beacon.rotation.y += dt * 2;
      v.ring.scale.setScalar(1 + Math.sin(t * 4 + v.phase) * 0.25);
      const survState = survMap.get(v.id);
      if (survState) {
        const st = survState.status;
        const mat = (st === 'SURVEYED' || st === 'ACKNOWLEDGED')
          ? VMAT.surveyed
          : (st === 'SURVEYING' || st === 'DATA_CREATED' || st === 'IN_TRANSIT' || st === 'ASSIGNED')
            ? VMAT.surveying
            : VMAT.wait;
        v.beacon.material = mat;
        v.ring.material = mat;
      }
      if (v.selRing) {
        v.selRing.visible = selPoiId === v.id;
        if (v.selRing.visible) v.selRing.rotation.z = t * 2;
      }
    }
  }

  function makeWater(color, opacity) {
    const g = new THREE.PlaneGeometry(W, W, 60, 60);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position, xs = new Float32Array(p.count), zs = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      xs[i] = p.getX(i);
      zs[i] = p.getZ(i);
    }
    g.userData.xs = xs;
    g.userData.zs = zs;
    g.userData.tick = 0;
    const mesh = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ color, transparent: true, opacity, roughness: 0.25, metalness: 0.1, flatShading: true })
    );
    mesh.receiveShadow = true;
    modeGroup.add(mesh);
    return mesh;
  }

  function updateWater(mesh, fn) {
    const g = mesh.geometry, p = g.attributes.position, arr = p.array, xs = g.userData.xs, zs = g.userData.zs;
    for (let i = 0, n = p.count; i < n; i++) arr[i * 3 + 1] = fn(xs[i], zs[i]);
    p.needsUpdate = true;
    if ((g.userData.tick++ & 1) === 0) g.computeVertexNormals();
  }

  /* =========================================================================
   * EARTHQUAKE SINGLE-BURST TRIGGER & MAGNITUDE PHYSICS CONFIGURATION
   * ========================================================================= */
  const EARTHQUAKE_CONFIG = {
    DURATION_SEC: 10.0,       // Exactly 10.0 seconds of seismic activity
    DEFAULT_MAGNITUDE: 7.0,   // Default magnitude: M 7.0 Major
    MIN_MAGNITUDE: 1.0,       // Minimum magnitude: M 1.0
    MAX_MAGNITUDE: 9.0,       // Maximum magnitude: M 9.0
    P_WAVE_DURATION: 1.8,     // P-wave compressional onset duration
    PEAK_SHAKE_END: 6.5,      // End of peak S/Rayleigh wave window
  };

  const earthquakeState = {
    active: false,
    elapsed: EARTHQUAKE_CONFIG.DURATION_SEC, // Initial load starts as completed post-M7.0 aftermath
    magnitude: EARTHQUAKE_CONFIG.DEFAULT_MAGNITUDE,
    envelope: 0.0,            // Normalized 0.0 - 1.0 temporal envelope
    pga: 0.08 * Math.pow(10, 0.28 * (7.0 - 5.0)), // Peak ground acceleration ~0.29g
    displacement: 0.0,        // Peak ground displacement in Three.js world units
    statusText: 'M7.0 event complete - Partial collapse: Upper-story shearing & tilt',
  };

  /**
   * Smooth 10-second earthquake envelope curve E(t).
   * Ramps up cleanly over 1.8s, sustains peak shaking through 6.5s,
   * then executes a smooth C^1 continuous coda decay to exactly 0.0 at 10.0s.
   */
  function getEarthquakeEnvelope(t, duration = EARTHQUAKE_CONFIG.DURATION_SEC) {
    if (t <= 0 || t >= duration) return 0.0;
    const rUp = EARTHQUAKE_CONFIG.P_WAVE_DURATION;
    const rDown = EARTHQUAKE_CONFIG.PEAK_SHAKE_END;
    if (t < rUp) {
      // Smoothstep ramp-up for primary P-wave onset (0 to 1)
      const u = t / rUp;
      return u * u * (3 - 2 * u);
    } else if (t <= rDown) {
      // Main shock S-wave and Rayleigh surface wave sustain with harmonic wave-train
      const phase = (t - rUp) / (rDown - rUp);
      return 0.88 + 0.12 * Math.cos(phase * Math.PI * 4);
    } else {
      // Coda wave decay to exactly 0.0 at duration with zero derivative
      const u = (duration - t) / (duration - rDown);
      return u * u * (3 - 2 * u);
    }
  }

  function emitEarthquakeUpdate() {
    if (onEarthquakeUpdate) {
      onEarthquakeUpdate(getEarthquakeState());
    }
  }

  /**
   * Target accumulated structural stress based on earthquake magnitude M.
   * Calibrated strictly to the 5 damage tiers:
   * Tier 1: M < 4.0      -> S < 1.0  (No Damage: Elastic sway only)
   * Tier 2: 4.0 <= M < 5.5 -> 1.0 <= S < 3.0 (Minor Cosmetic Damage: Hairline cracks)
   * Tier 3: 5.5 <= M < 7.0 -> 3.0 <= S < 6.0 (Moderate Damage: Tilt, settling, dust bursts)
   * Tier 4: 7.0 <= M < 8.2 -> 6.0 <= S < 10.0 (Partial Collapse: Upper shear, severe tilt)
   * Tier 5: M >= 8.2      -> S >= 10.0 (Catastrophic Failure: Pancake collapse into rubble)
   */
  function getEarthquakeTargetStress(M) {
    if (M < 4.0) {
      return (M / 4.0) * 0.82;
    }
    if (M < 5.5) {
      const u = (M - 4.0) / 1.5;
      return 1.15 + u * 1.70;
    }
    if (M < 7.0) {
      const u = (M - 5.5) / 1.5;
      return 3.25 + u * 2.50;
    }
    if (M < 8.2) {
      const u = (M - 7.0) / 1.2;
      return 6.30 + u * 3.30;
    }
    const u = Math.min(1.0, (M - 8.2) / 0.8);
    return 10.5 + u * 4.0;
  }

  /**
   * Applies the default post-M7.0 earthquake damage aftermath (Tier 4: Partial Collapse)
   * to all buildings on initial mount without requiring the 10-second shaking sequence.
   */
  function applyM70Aftermath() {
    for (const b of buildings) {
      if (!b.mesh) continue;
      b.damageState = 'partial_collapse';
      b.accumulatedStress = 7.5; // Tier 4 calibrated stress
      b.mesh.material = b.damagedMat;
      b.tilt = true;

      // 1. Severe structural tilt
      const signZ = rand() < 0.5 ? -1 : 1;
      b.targetTiltZ = signZ * R(0.20, 0.32);
      b.targetTiltX = R(-0.16, 0.16);
      b.currentTiltZ = b.targetTiltZ;
      b.currentTiltX = b.targetTiltX;
      b.tz = b.targetTiltZ;
      b.mesh.rotation.z = b.targetTiltZ;
      b.mesh.rotation.x = b.targetTiltX;

      // 2. Downward vertical subsidence (settling 30% to 50% into foundation)
      b.targetSubsidence = Math.min(b.h * 0.52, R(2.0, 4.2));
      b.currentSubsidence = b.targetSubsidence;
      b.mesh.position.y = b.initPosY - b.targetSubsidence;

      // 3. Upper-story shearing of the roof and upper facade
      b.shearX = R(-1.2, 1.2);
      b.shearZ = R(-1.2, 1.2);
      if (b.roof) {
        b.roof.position.x = b.shearX;
        b.roof.position.z = b.shearZ;
        b.roof.rotation.z = R(-0.25, 0.25);
        b.roof.rotation.x = R(-0.2, 0.2);
      }

      // 4. Perimeter rubble & slab piles at building base
      if (b.rubbleGroup) {
        b.rubbleGroup.visible = true;
      }

      // 5. Update obstacle top height for UAV line-of-sight
      b.top = Math.max(b.level + 2.5, b.initTop - b.targetSubsidence);
    }
  }

  /* ---------- modes ---------- */
  const MODES = [
    {
      ...MODES_META[0],
      sky: 0xb6c0c6, fogNear: 90, fogFar: 330, hemiGround: 0x6b5d48,
      town: [0, 0], townR: 54, safe: [82, 72], camR: 165,
      raw: (x, z) => hills(x, z, 14) + fbm(x * 0.08, z * 0.08, 2) * 1.2,
      build(c) {
        const L = this._townLevel;
        // Build the town grid
        addTown(0, 0, L, { damage: 0 });
        // Apply default post-M7.0 earthquake damage aftermath (Tier 4: Partial Collapse) immediately on mount
        applyM70Aftermath();
        let px = -140, pz = -95;
        const fis = new THREE.InstancedMesh(G.box, M(0x1b1612), 75);
        for (let k = 0; k < 75; k++) {
          const nx = px + 3.8, nz = pz + 1.9 + (vnoise(k * 0.35, 1.7) - 0.5) * 7;
          const mx = (px + nx) / 2, mz = (pz + nz) / 2;
          _dummy.scale.set(Math.hypot(nx - px, nz - pz) + 0.6, 0.4, R(0.8, 2.4));
          _dummy.position.set(mx, H(mx, mz) + 0.12, mz);
          _dummy.rotation.set(0, -Math.atan2(nz - pz, nx - px), 0);
          _dummy.updateMatrix();
          fis.setMatrixAt(k, _dummy.matrix);
          px = nx;
          pz = nz;
        }
        fis.instanceMatrix.needsUpdate = true;
        modeGroup.add(fis);
        addTrees(90, (x, z) => okTree(x, z));
        makeVehicle(0xf4f4f4, [0xff2a2a, 0x2a6bff], 56, 14, Math.PI / 2);
        makeVehicle(0xc0262b, [0xff2a2a, 0xff2a2a], 56, -12, Math.PI / 2);
        makeVehicle(0xf4f4f4, [0xff2a2a, 0x2a6bff], -56, 10, -Math.PI / 2);

        // Dynamic dust particle system for structural stress, cracks & failure bursts
        const DUST_COUNT = 600;
        const dustPos = new Float32Array(DUST_COUNT * 3);
        const dustVel = new Float32Array(DUST_COUNT * 3);
        const dustLife = new Float32Array(DUST_COUNT);

        for (let i = 0; i < DUST_COUNT; i++) {
          dustPos[i * 3 + 1] = -999;
          dustLife[i] = 0;
        }

        const dustGeo = new THREE.BufferGeometry();
        dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
        const dustMat = new THREE.PointsMaterial({
          color: 0xc4b9a8,
          size: 3.2,
          map: dotTex,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
          blending: THREE.NormalBlending,
          sizeAttenuation: true,
        });
        const dustPoints = new THREE.Points(dustGeo, dustMat);
        dustPoints.frustumCulled = false;
        modeGroup.add(dustPoints);

        c.spawnDustBurst = (bx, bz, by, count, radius, upwardVel = 2.2) => {
          let spawned = 0;
          for (let i = 0; i < DUST_COUNT && spawned < count; i++) {
            if (dustLife[i] <= 0) {
              const k = i * 3;
              const angle = rand() * Math.PI * 2;
              const r = rand() * radius;
              dustPos[k] = bx + Math.cos(angle) * r;
              dustPos[k + 1] = by + R(0.2, 1.2);
              dustPos[k + 2] = bz + Math.sin(angle) * r;

              const radialSpeed = R(0.8, 2.4);
              dustVel[k] = Math.cos(angle) * radialSpeed;
              dustVel[k + 1] = R(upwardVel * 0.7, upwardVel * 1.3);
              dustVel[k + 2] = Math.sin(angle) * radialSpeed;

              const life = R(1.8, 3.5);
              dustLife[i] = life;
              spawned++;
            }
          }
          dustGeo.attributes.position.needsUpdate = true;
        };

        c.updateDust = dt => {
          let anyActive = false;
          for (let i = 0; i < DUST_COUNT; i++) {
            if (dustLife[i] > 0) {
              anyActive = true;
              const k = i * 3;
              dustPos[k] += dustVel[k] * dt;
              dustPos[k + 1] += dustVel[k + 1] * dt;
              dustPos[k + 2] += dustVel[k + 2] * dt;
              dustVel[k + 1] -= 1.8 * dt; // gravity deceleration
              dustVel[k] *= 0.96; // air drag
              dustVel[k + 2] *= 0.96;
              dustLife[i] -= dt;
              if (dustLife[i] <= 0) {
                dustPos[k + 1] = -999;
              }
            }
          }
          if (anyActive) {
            dustGeo.attributes.position.needsUpdate = true;
          }
        };

        c.clearDust = () => {
          for (let i = 0; i < DUST_COUNT; i++) {
            dustLife[i] = 0;
            dustPos[i * 3 + 1] = -999;
          }
          dustGeo.attributes.position.needsUpdate = true;
        };

        c.debris = [];
        const standing = buildings.filter(b => b.mesh);
        for (let k = 0; k < 42; k++) {
          const m = new THREE.Mesh(G.box, M(pick([0x8d857b, 0x7b7369, 0x9b9389, 0x6e6862])));
          m.scale.set(R(0.4, 1.2), R(0.3, 0.9), R(0.4, 1.2));
          m.castShadow = true;
          // Spawn baseline fallen debris fragments on the ground around the damaged buildings
          const b = pick(standing);
          const angle = rand() * Math.PI * 2;
          const dist = R(b.hw * 0.8, b.hw * 1.8);
          const dx = b.x + Math.cos(angle) * dist;
          const dz = b.z + Math.sin(angle) * dist;
          const gy = H(dx, dz) + 0.18;
          m.position.set(dx, gy, dz);
          m.rotation.set(R(-0.4, 0.4), rand() * 3.14, R(-0.4, 0.4));
          m.visible = true;
          modeGroup.add(m);
          c.debris.push({ m, vy: 0, vx: 0, vz: 0, rest: 999, src: standing });
        }
      },
      update(dt, t, c) {
        const M = earthquakeState.magnitude;
        // Peak ground acceleration (PGA) in g: Esteva scaling law
        const pga = 0.08 * Math.pow(10, 0.28 * (M - 5.0));
        earthquakeState.pga = pga;

        let env = 0.0;
        if (earthquakeState.active) {
          // Internal timer decoupled from display framerate
          earthquakeState.elapsed += dt;

          if (earthquakeState.elapsed >= EARTHQUAKE_CONFIG.DURATION_SEC) {
            // Exactly 10.0 seconds reached: complete event cleanly
            earthquakeState.active = false;
            earthquakeState.elapsed = EARTHQUAKE_CONFIG.DURATION_SEC;
            earthquakeState.envelope = 0.0;
            env = 0.0;

            let aftermathSummary = 'No structural damage (Elastic response)';
            if (M >= 8.2) aftermathSummary = 'Catastrophic failure: Pancake collapse & rubble';
            else if (M >= 7.0) aftermathSummary = 'Partial collapse: Upper-story shearing & tilt';
            else if (M >= 5.5) aftermathSummary = 'Moderate damage: Structural tilt & settling';
            else if (M >= 4.0) aftermathSummary = 'Minor damage: Hairline facade & window cracks';

            earthquakeState.statusText = `M${M.toFixed(1)} event complete - ${aftermathSummary}`;
            emitStats();
            emitEarthquakeUpdate();
          } else {
            env = getEarthquakeEnvelope(earthquakeState.elapsed, EARTHQUAKE_CONFIG.DURATION_SEC);
            earthquakeState.envelope = env;

            const t_e = earthquakeState.elapsed;
            const remaining = EARTHQUAKE_CONFIG.DURATION_SEC - t_e;
            if (t_e < EARTHQUAKE_CONFIG.P_WAVE_DURATION) {
              earthquakeState.statusText = `M${M.toFixed(1)} P-wave onset · Tremor (${remaining.toFixed(1)}s left)`;
            } else if (t_e <= EARTHQUAKE_CONFIG.PEAK_SHAKE_END) {
              earthquakeState.statusText = `M${M.toFixed(1)} Peak shaking · PGA ~${pga.toFixed(2)}g (${remaining.toFixed(1)}s left)`;
            } else {
              earthquakeState.statusText = `M${M.toFixed(1)} Coda decay · Subsiding (${remaining.toFixed(1)}s left)`;
            }
          }
        } else {
          env = 0.0;
          earthquakeState.envelope = 0.0;
          if (earthquakeState.elapsed <= 0) {
            earthquakeState.statusText = 'Quake inactive · Ready to trigger';
          }
        }
        c.env = env;

        // Progressive Structural Damage Accumulation Integral
        // Accumulated structural stress is computed continuously over the 10s shaking duration
        if (earthquakeState.active && env > 0.001) {
          const targetStress = getEarthquakeTargetStress(M);
          // Total integral of E(t)^2 over 10 seconds is approx 5.74
          const baseStressRate = (targetStress / 5.74) * (env * env);
          let structuralChangeOccurred = false;

          for (const b of buildings) {
            if (!b.mesh) continue;
            const dStress = (baseStressRate / (b.resistance || 1.0)) * dt;
            b.accumulatedStress = (b.accumulatedStress || 0) + dStress;
            const S = b.accumulatedStress;

            // Tier 1: S < 1.0 -> Intact (Elastic sway only, no cracking)

            // Tier 2: 1.0 <= S < 3.0 -> Minor Cosmetic Damage (Surface hairline cracks & broken window textures)
            if (S >= 1.0 && b.damageState === 'intact') {
              b.damageState = 'cracked';
              b.mesh.material = b.crackedMat;
              if (c.spawnDustBurst) {
                c.spawnDustBurst(b.x, b.z, b.level + b.h * 0.4, 14, b.hw * 0.8, 1.2);
              }
            }

            // Tier 3: 3.0 <= S < 6.0 -> Moderate Structural Damage (Visible tilt/settling, facade detachment, dust bursts)
            if (S >= 3.0 && (b.damageState === 'intact' || b.damageState === 'cracked')) {
              b.damageState = 'damaged';
              b.mesh.material = b.damagedMat;
              b.tilt = true;
              b.tz = (Math.sign(b.tz) || (rand() < 0.5 ? -1 : 1)) * R(0.08, 0.14);
              b.targetTiltZ = b.tz;
              b.targetTiltX = R(-0.08, 0.08);
              b.targetSubsidence = R(0.4, 0.85); // Downward vertical subsidence
              if (c.spawnDustBurst) {
                c.spawnDustBurst(b.x, b.z, b.level, 35, b.hw * 1.1, 2.2);
              }
              structuralChangeOccurred = true;
            }

            // Tier 4: 6.0 <= S < 10.0 -> Partial Collapse (Upper-story shearing, severe tilt, section fracture, dense dust)
            if (S >= 6.0 && b.damageState !== 'partial_collapse' && b.damageState !== 'rubble') {
              b.damageState = 'partial_collapse';
              b.mesh.material = b.damagedMat;
              b.tilt = true;
              b.targetTiltZ = (Math.sign(b.targetTiltZ) || (rand() < 0.5 ? -1 : 1)) * R(0.20, 0.32);
              b.targetTiltX = R(-0.16, 0.16);
              b.tz = b.targetTiltZ;
              b.targetSubsidence = Math.min(b.h * 0.52, R(2.0, 4.2));
              b.shearX = R(-1.2, 1.2);
              b.shearZ = R(-1.2, 1.2);
              if (b.roof) {
                b.roof.position.x = b.shearX;
                b.roof.position.z = b.shearZ;
                b.roof.rotation.z = R(-0.25, 0.25);
                b.roof.rotation.x = R(-0.2, 0.2);
              }
              if (b.rubbleGroup) {
                b.rubbleGroup.visible = true;
              }
              b.top = Math.max(b.level + 2.5, b.initTop - b.targetSubsidence);
              if (c.spawnDustBurst) {
                c.spawnDustBurst(b.x, b.z, b.level + 0.5, 75, b.hw * 1.3, 3.2);
              }
              structuralChangeOccurred = true;
            }

            // Tier 5: S >= 10.0 -> Catastrophic Failure (Pancake collapse down to ground-level rubble piles, major plumes)
            if (S >= 10.0 && b.damageState !== 'rubble') {
              b.damageState = 'rubble';
              b.mesh.visible = false;
              if (b.rubbleGroup) {
                b.rubbleGroup.visible = true;
              }
              b.top = b.level + 1.4;
              if (c.spawnDustBurst) {
                c.spawnDustBurst(b.x, b.z, b.level + 0.3, 140, b.hw * 1.5, 4.5);
              }
              structuralChangeOccurred = true;
            }
          }

          if (structuralChangeOccurred) {
            syncWorldToSharedStore(curModeIndex);
          }
        }

        // Smooth procedural subsidence and permanent tilt convergence
        for (const b of buildings) {
          if (b.damageState === 'rubble' || !b.mesh) continue;
          b.currentSubsidence += (b.targetSubsidence - b.currentSubsidence) * Math.min(1.0, dt * 4.0);
          b.currentTiltX += (b.targetTiltX - b.currentTiltX) * Math.min(1.0, dt * 4.0);
          b.currentTiltZ += (b.targetTiltZ - b.currentTiltZ) * Math.min(1.0, dt * 4.0);
          b.mesh.position.y = b.initPosY - b.currentSubsidence;
        }

        if (env > 0.0001) {
          const t_e = earthquakeState.elapsed;

          // 1. Amplitude (Displacement) scaling: Exponential scaling ~ 10^(0.35 * (M - 5.0))
          const baseDisp = 0.18 * Math.pow(10, 0.35 * (M - 5.0));
          const amp = env * baseDisp * INT * (reduced ? 0.28 : 1.0);
          earthquakeState.displacement = amp;

          // 2. Frequency & Harmonic Waves:
          const omegaP = 2 * Math.PI * (3.4 + 0.35 * M);
          const omegaS = 2 * Math.PI * (1.3 + 0.12 * M);
          const waveX = Math.sin(t_e * omegaS) * 0.7 + Math.sin(t_e * omegaP) * 0.3;
          const waveZ = Math.cos(t_e * omegaS * 0.88 + 0.4) * 0.7 + Math.cos(t_e * omegaP * 0.94) * 0.3;
          const waveY = Math.sin(t_e * omegaP * 1.3) * 0.45;

          // 3. High-Frequency Stochastic Noise & Ground Jitter
          const jitterScale = 0.45 * Math.pow(M / 5.0, 1.4);
          const jitterX = (vnoise(t_e * 26.0, 14.1) - 0.5) * 2.0 * jitterScale;
          const jitterZ = (vnoise(t_e * 26.0, 83.7) - 0.5) * 2.0 * jitterScale;
          const jitterY = (vnoise(t_e * 34.0, 41.9) - 0.5) * 1.6 * jitterScale;

          // Apply combined ground motion to world group
          const dx = amp * (waveX + jitterX);
          const dy = amp * (waveY + jitterY) * 0.35;
          const dz = amp * (waveZ + jitterZ);
          world.position.set(dx, dy, dz);

          // 4. Structural Building Tilt Dynamics (Angular oscillation + permanent tilt baseline)
          const swayFactor = env * (0.012 * Math.pow(10, 0.24 * (M - 5.0))) * INT;
          for (const b of buildings) {
            if (!b.mesh || !b.mesh.visible) continue;
            const elasticOscZ = Math.sin(t_e * 24.0 + b.x * 0.4) * swayFactor * (b.h / 8.0);
            const elasticOscX = Math.cos(t_e * 19.0 + b.z * 0.4) * swayFactor * 0.5 * (b.h / 8.0);
            b.mesh.rotation.z = b.currentTiltZ + elasticOscZ;
            b.mesh.rotation.x = b.currentTiltX + elasticOscX;
          }

          // 5. Dynamic Debris Physics & Acceleration / Force Scaling
          for (const d of c.debris) {
            if (d.rest > 0) {
              d.rest -= dt;
              // Debris shedding only occurs above M 4.0 during substantial shaking (env > 0.3)
              if (d.rest <= 0 && M >= 4.0 && env > 0.3 && d.src.length) {
                const b = pick(d.src);
                d.m.visible = true;
                const side = rand() < 0.5 ? -1 : 1;
                d.m.position.set(b.x + side * b.hw, b.top, b.z + R(-b.hd, b.hd));
                // Horizontal ejection impulse proportional to Peak Ground Acceleration (PGA)
                const ejectForce = pga * 6.5 * (rand() * 0.8 + 0.6);
                d.vx = side * ejectForce * R(0.5, 1.2);
                d.vz = (rand() - 0.5) * ejectForce;
                d.vy = R(1.0, 3.5) * Math.sqrt(pga / 0.08);
              } else if (d.rest <= 0) {
                d.rest = R(0.4, 1.5);
              }
            } else {
              // Debris flight under gravity
              d.vy -= 26 * dt;
              d.m.position.x += (d.vx || 0) * dt;
              d.m.position.z += (d.vz || 0) * dt;
              d.m.position.y += d.vy * dt;
              d.m.rotation.x += dt * 4.5;
              d.m.rotation.z += dt * 3.5;
              const gy = H(d.m.position.x, d.m.position.z) + 0.2;
              if (d.m.position.y <= gy) {
                d.m.position.y = gy;
                d.vx = 0;
                d.vz = 0;
                d.rest = R(1.5, 4.5);
              }
            }
          }
        } else {
          // Strictly neutral origin / baseline when earthquake is inactive or completed
          world.position.set(0, 0, 0);
          for (const b of buildings) {
            if (!b.mesh || !b.mesh.visible) continue;
            // Structural tilt persists permanently after earthquake concludes
            b.mesh.rotation.z = b.currentTiltZ;
            b.mesh.rotation.x = b.currentTiltX;
          }

          // Any airborne debris completes landing and persists on ground
          for (const d of c.debris) {
            if (d.rest <= 0 && d.m.visible) {
              d.vy -= 26 * dt;
              d.m.position.x += (d.vx || 0) * dt;
              d.m.position.z += (d.vz || 0) * dt;
              d.m.position.y += d.vy * dt;
              const gy = H(d.m.position.x, d.m.position.z) + 0.2;
              if (d.m.position.y <= gy) {
                d.m.position.y = gy;
                d.vx = 0;
                d.vz = 0;
                d.rest = 999;
              }
            }
          }
        }

        // Update dynamic dust particle system
        if (c.updateDust) c.updateDust(dt);
      },
      status() {
        return earthquakeState.statusText;
      }
    },
    {
      ...MODES_META[1],
      sky: 0x8a97a3, fogNear: 60, fogFar: 280, hemiGround: 0x4a4a3c, sunI: 0.55,
      town: [0, -4], townLevel: 0.6, townR: 54, safe: [18, 86], camR: 162,
      roofVictims: true,
      raw: (x, z) => hills(x, z, 5) + Math.pow(Math.abs(z) / 72, 1.8) * 16 - 1.5,
      color(c, x, y, z, s) {
        natural(c, x, y, z, s, { grass: 0x56803a });
        _c2.set(0x6d6248);
        c.lerp(_c2, smooth(1.4, -0.5, y));
      },
      build(c) {
        addTown(0, -4, 0.6, {});
        addTrees(100, (x, z) => okTree(x, z, 3));
        c.L = 0.3;
        c.water = makeWater(0x7b6b4c, 0.88);
        const tall = buildings.filter(b => b.mesh).sort(() => rand() - 0.5).slice(0, 6);
        tall.forEach(b => {
          b.taken = true;
          addAgent('resident', b.x + R(-1.5, 1.5), b.z + R(-1.5, 1.5), { state: 'wave', fixedY: b.top });
        });
        c.boats = [];
        for (let k = 0; k < 4; k++) {
          const g = new THREE.Group();
          const hull = new THREE.Mesh(G.box, M(0xff8a1a));
          hull.scale.set(3.6, 0.8, 1.7);
          hull.castShadow = true;
          g.add(hull);
          [-0.8, 0.8].forEach(px => {
            const p = makePerson('rescuer');
            p.scale.setScalar(0.75);
            p.position.set(px, -0.2, 0);
            p.rotation.y = Math.PI / 2;
            g.add(p);
          });
          modeGroup.add(g);
          c.boats.push({ g, r: R(16, 48), ang: rand() * 6.28, sp: R(0.15, 0.3) * (rand() < 0.5 ? -1 : 1) });
        }
        makeHeli(0xd23a2a, () => [0, -4], 48, 38, 0.35);
        precip(2600, { color: 0xb9c8d6, size: 0.45, opacity: 0.6, fall: 38, wind: 3 });
      },
      update(dt, t, c) {
        c.L = 0.3 + ((1 - Math.cos((t * 2 * Math.PI) / 40)) / 2) * 4.2 * INT;
        updateWater(c.water, (x, z) => c.L + Math.sin(x * 0.13 + t * 1.4) * 0.12 + Math.sin(z * 0.21 + t * 0.9) * 0.08);
        for (const b of c.boats) {
          b.ang += b.sp * dt;
          const x = Math.cos(b.ang) * b.r, z = -4 + Math.sin(b.ang) * b.r;
          b.g.position.set(x, c.L + 0.3 + Math.sin(t * 2 + b.r) * 0.1, z);
          b.g.rotation.y = -(b.ang + (b.sp > 0 ? Math.PI / 2 : -Math.PI / 2));
        }
      },
      status(c) {
        return `Floodwater ${Math.max(0, c.L - 0.6).toFixed(1)} m above street level`;
      }
    },
    {
      ...MODES_META[2],
      sky: 0xc79a72, fogNear: 60, fogFar: 270, hemiSky: 0xffd2a8, hemiGround: 0x5a4030, sun: 0xffb070,
      town: [36, 26], townR: 42, safe: [98, -52], camR: 162,
      raw: (x, z) => hills(x, z, 18) + 6,
      color(c, x, y, z, s) {
        natural(c, x, y, z, s, { grass: 0x6a7d3a, dry: 0xa08a4a });
      },
      build(c) {
        addTown(36, 26, this._townLevel, { compact: true });
        c.trees = addTrees(240, (x, z) => okTree(x, z), undefined, true);
        c.trees.forEach(t => (t.off = (vnoise(t.x * 0.05, t.z * 0.05) - 0.5) * 24));
        c.burning = [];
        c.mats = {
          green: M(0x4c7a3a),
          burn: M(0xff6a1a, { emissive: 0xff4400, emissiveIntensity: 1.2 }),
          burnt: M(0x1e1a18),
          bt: M(0x141110),
          tk: M(0x6b4a2f)
        };
        makeVehicle(0xc0262b, [0xff2a2a, 0xff2a2a], -9, 38, 0);
        makeVehicle(0xc0262b, [0xff2a2a, 0xff2a2a], -9, 12, 0);
        makeVehicle(0xc0262b, [0xff2a2a, 0xff2a2a], 24, -19, Math.PI / 2);
        makeHeli(0xe8c020, () => [c.front + 12, 0], 28, 42, 0.4);
        new Particles(900, {
          color: 0xff7a1e, size: 2.6, opacity: 0.9, additive: true,
          spawn: (i, p) => {
            if (c.burning.length) {
              const t = pick(c.burning);
              p.set(i, t.x + R(-1.5, 1.5), t.y + R(1, 5) * t.s, t.z + R(-1.5, 1.5), R(-0.6, 0.6), R(3, 6), R(-0.6, 0.6), R(0.4, 1.1));
            } else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.4));
          }
        });
        new Particles(520, {
          color: 0x4a4440, size: 8, opacity: 0.33,
          spawn: (i, p) => {
            if (c.burning.length) {
              const t = pick(c.burning);
              p.set(i, t.x, t.y + 6 * t.s, t.z, R(1.5, 3.5), R(4, 7), R(-1, 1), R(5, 9));
            } else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.4));
          }
        });
      },
      update(_dt, t, c) {
        c.front = -140 + ((t * 4.5 * INT) % 280);
        c.burning.length = 0;
        const { green, burn, burnt, bt, tk } = c.mats;
        for (const tr of c.trees) {
          const e = tr.x + tr.off, st = e > c.front ? 0 : e > c.front - 22 ? 1 : 2;
          if (st !== tr.state) {
            tr.state = st;
            tr.crown.material = st === 0 ? green : st === 1 ? burn : burnt;
            tr.trunk.material = st === 0 ? tk : bt;
            tr.crown.scale.set(1, 1, 1);
            if (st === 2) tr.crown.scale.set(0.6, 0.8, 0.6);
          }
          if (st === 1) {
            c.burning.push(tr);
            tr.crown.scale.y = 1 + Math.sin(t * 12 + tr.x) * 0.08;
          }
        }
      },
      status(c) {
        return `Fire front moving east, ${c.burning.length} trees burning`;
      }
    },
    {
      ...MODES_META[3],
      sky: 0x5b6862, fog: 0x6a7670, fogNear: 40, fogFar: 240, hemiI: 0.55, sunI: 0.4, hemiGround: 0x3c4038,
      town: [-5, 10], townR: 54, safe: [-88, -74], camR: 162,
      raw: (x, z) => hills(x, z, 4) + fbm(x * 0.06, z * 0.06, 2) * 1.5,
      build(c) {
        addTown(-5, 10, this._townLevel, {});
        c.trees = addTrees(110, (x, z) => okTree(x, z), undefined, true);
        makeVehicle(0xf4f4f4, [0xff2a2a, 0x2a6bff], -62, -10, 0);
        makeVehicle(0xc0262b, [0xff2a2a, 0xff2a2a], 52, 18, Math.PI);
        c.cx = 0;
        c.cz = 0;
        c.gy = 0;
        const N = Math.max(10, Math.round(2600 * PSCALE)), fa = new Float32Array(N), fh = new Float32Array(N), fr = new Float32Array(N);
        new Particles(2600, {
          color: 0x8e8b82, size: 2.4, opacity: 0.5,
          spawn: (i, p) => {
            fa[i] = rand() * 6.283;
            fh[i] = rand();
            fr[i] = R(0.7, 1.3);
            p.life[i] = 1e9;
          },
          step: (i, dt, p) => {
            fa[i] += dt * INT * (7 - fh[i] * 3);
            fh[i] += dt * 0.045 * fr[i];
            if (fh[i] > 1) fh[i] -= 1;
            const h = fh[i];
            const r = (1.3 + Math.pow(h, 1.7) * 17) * fr[i], sway = Math.sin(h * 3 + modeT * 0.8) * h * 5, k = i * 3;
            p.pos[k] = c.cx + Math.cos(fa[i]) * r + sway;
            p.pos[k + 1] = c.gy + h * 56;
            p.pos[k + 2] = c.cz + Math.sin(fa[i]) * r;
          }
        });
        const D = Math.max(10, Math.round(500 * PSCALE)), da = new Float32Array(D), dr = new Float32Array(D), dh = new Float32Array(D);
        new Particles(500, {
          color: 0x7a6650, size: 3.2, opacity: 0.45,
          spawn: (i, p) => {
            da[i] = rand() * 6.283;
            dr[i] = R(3, 14);
            dh[i] = R(0, 6);
            p.life[i] = 1e9;
          },
          step: (i, dt, p) => {
            da[i] += dt * INT * 4;
            const k = i * 3;
            p.pos[k] = c.cx + Math.cos(da[i]) * dr[i];
            p.pos[k + 1] = c.gy + dh[i];
            p.pos[k + 2] = c.cz + Math.sin(da[i]) * dr[i];
          }
        });
        const cloudMat = new THREE.MeshStandardMaterial({ color: 0x3c4440, transparent: true, opacity: 0.92, flatShading: true });
        c.cloud = new THREE.Mesh(new THREE.CylinderGeometry(100, 100, 8, 32), cloudMat);
        c.cloud.position.y = 64;
        modeGroup.add(c.cloud);
        c.wall = new THREE.Mesh(new THREE.ConeGeometry(24, 14, 16), cloudMat);
        c.wall.rotation.x = Math.PI;
        modeGroup.add(c.wall);
        c.debris = [];
        for (let k = 0; k < 50; k++) {
          const m = new THREE.Mesh(G.box, M(pick([0x7a5a3a, 0x8d857b, 0x5a4a3a, 0xb0a698])));
          m.scale.set(R(0.3, 1.4), R(0.1, 0.5), R(0.3, 1.2));
          modeGroup.add(m);
          c.debris.push({ m, a: rand() * 6.28, r: R(3, 14), h: R(0, 24), s: R(2, 5) });
        }
        precip(1800, { color: 0xa8b4bc, size: 0.45, opacity: 0.55, fall: 40, wind: 10 });
      },
      update(dt, t, c) {
        const T = t * INT;
        c.cx = 10 + Math.sin(T * 0.13) * 55;
        c.cz = Math.sin(T * 0.083 + 1) * 55;
        c.gy = H(c.cx, c.cz);
        c.cloud.position.x = c.cx * 0.5;
        c.cloud.position.z = c.cz * 0.5;
        c.wall.position.set(c.cx, c.gy + 56, c.cz);
        for (const d of c.debris) {
          d.a += dt * d.s * INT;
          d.m.position.set(c.cx + Math.cos(d.a) * d.r, c.gy + d.h + Math.sin(t + d.r) * 2, c.cz + Math.sin(d.a) * d.r);
          d.m.rotation.x += dt * 5;
          d.m.rotation.y += dt * 4;
        }
        for (const b of buildings) {
          if (!b.hit && b.mesh && Math.hypot(b.x - c.cx, b.z - c.cz) < 11) {
            b.hit = true;
            b.roof.visible = false;
            b.mesh.rotation.z = R(-0.12, 0.12);
          }
        }
        for (const tr of c.trees) {
          if (!tr.hit && Math.hypot(tr.x - c.cx, tr.z - c.cz) < 9) {
            tr.hit = true;
            tr.g.rotation.z = R(-1.4, 1.4);
          }
        }
      },
      status(c) {
        return `Funnel ${Math.round(Math.hypot(c.cx + 5, c.cz - 10))} m from the town center`;
      }
    },
    {
      ...MODES_META[4],
      sky: 0x7d716b, fogNear: 70, fogFar: 300, hemiI: 0.6, sun: 0xffd2b0, sunI: 0.7, hemiGround: 0x3a302c,
      town: [44, 38], townR: 42, safe: [96, -36], camR: 175, camTarget: [10, 8],
      raw: (x, z) => {
        const d = Math.hypot(x + 50, z + 50);
        return hills(x, z, 6) + 54 / (1 + (d / 21) ** 2) - 13 * Math.exp(-((d / 5.5) ** 2));
      },
      color(c, x, y, z, s) {
        natural(c, x, y, z, s, { grass: 0x6f7a4a, dry: 0x8a8060 });
        _c2.set(0x3a3230);
        c.lerp(_c2, smooth(9, 24, y));
        _c2.set(0x77706a);
        c.lerp(_c2, 0.5 * smooth(90, 30, Math.hypot(x + 50, z + 50)));
      },
      build(c) {
        addTown(44, 38, this._townLevel, { compact: true });
        addTrees(120, (x, z) => okTree(x, z) && Math.hypot(x + 50, z + 50) > 42);
        makeVehicle(0xe8b820, null, 0, 48, 0);
        makeVehicle(0xf4f4f4, [0xff2a2a, 0x2a6bff], 88, 22, Math.PI / 2);
        makeHeli(0x3a6ea8, () => [10, 10], 55, 48, 0.25);
        c.flows = [];
        [0.35, 0.8, 1.25, 2.6, -1].forEach((a, fi) => {
          let x = -50 + Math.cos(a) * 6.5, z = -50 + Math.sin(a) * 6.5;
          const pts = [];
          for (let k = 0; k < 160; k++) {
            const y = H(x, z);
            pts.push(new THREE.Vector3(x, y + 0.4, z));
            const gx = (H(x + 0.8, z) - H(x - 0.8, z)) / 1.6, gz = (H(x, z + 0.8) - H(x, z - 0.8)) / 1.6, g = Math.hypot(gx, gz);
            if (g < 0.02 || y < 1.5) break;
            x -= (gx / g) * 1.4 + R(-0.3, 0.3);
            z -= (gz / g) * 1.4 + R(-0.3, 0.3);
          }
          if (pts.length < 4) return;
          const curve = new THREE.CatmullRomCurve3(pts), seg = pts.length * 2;
          const mat = new THREE.MeshStandardMaterial({ color: 0x331100, emissive: 0xff4a00, emissiveIntensity: 1.4, flatShading: true });
          const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, seg, 1.3, 6), mat);
          modeGroup.add(tube);
          c.flows.push({ tube, mat, total: tube.geometry.index.count, delay: fi * 0.23 });
        });
        const top = H(-50, -50);
        const glow = new THREE.Mesh(new THREE.CircleGeometry(5, 24), new THREE.MeshBasicMaterial({ color: 0xff6a10 }));
        glow.rotation.x = -Math.PI / 2;
        glow.position.set(-50, top + 0.6, -50);
        modeGroup.add(glow);
        ptLight.position.set(-50, top + 8, -50);
        ptLight.intensity = 2.5;
        c.light = ptLight;
        const rim = top + 6;
        new Particles(1200, {
          color: 0x4a4442, size: 5, opacity: 0.35, prewarm: true,
          spawn: (i, p) => p.set(i, -50 + R(-3, 3), rim, -50 + R(-3, 3), R(-1.5, 1.5), R(9, 15), R(-1.5, 1.5), R(6, 10)),
          step: (i, dt, p) => {
            const k = i * 3;
            p.vel[k] += dt * 2.2 * INT;
            p.vel[k + 1] *= 0.996;
          }
        });
        c.bombs = [];
        for (let k = 0; k < 14; k++) {
          const m = new THREE.Mesh(G.blob, M(0xff5a10, { emissive: 0xff3300, emissiveIntensity: 1.5 }));
          m.scale.setScalar(R(0.5, 1.1));
          modeGroup.add(m);
          c.bombs.push({ m, v: new THREE.Vector3(), rim });
          m.position.set(-50, -20, -50);
        }
      },
      update(dt, t, c) {
        for (const f of c.flows) {
          const p = (t * 0.035 * INT + f.delay) % 1.3, draw = Math.min(1, p);
          f.tube.geometry.setDrawRange(0, Math.floor((f.total * draw) / 36) * 36);
          f.mat.emissiveIntensity = 1.2 + Math.sin(t * 3 + f.delay * 10) * 0.35;
        }
        c.light.intensity = 2.2 + Math.sin(t * 7) * 0.5;
        for (const b of c.bombs) {
          const p = b.m.position;
          if (p.y < H(p.x, p.z)) {
            p.set(-50 + R(-2, 2), b.rim, -50 + R(-2, 2));
            b.v.set(R(-12, 12), R(22, 34) * Math.sqrt(INT), R(-12, 12));
          }
          b.v.y -= 20 * dt;
          p.addScaledVector(b.v, dt);
        }
      },
      status() {
        return 'Eruption ongoing: ash column and lava flows advancing';
      }
    },
    {
      ...MODES_META[5],
      sky: 0x9fb6c4, fogNear: 90, fogFar: 330, hemiGround: 0x5a5a48,
      town: [-36, 0], townLevel: 5, townR: 42, safe: [-96, 62], camTarget: [-14, 0], camR: 168,
      raw: (x, z) => hills(x, z, 5) + 7 - smooth(-15, 75, x) * 24 + 16 * Math.exp(-(((x + 96) ** 2 + (z - 62) ** 2) / 900)),
      color(c, x, y, z, s) {
        natural(c, x, y, z, s, { sandBelow: 2.6 });
        _c2.set(0x5d6a6a);
        c.lerp(_c2, smooth(-0.5, -4, y));
      },
      build(c) {
        addTown(-36, 0, 5, { compact: true });
        addTrees(90, (x, z) => okTree(x, z, 3.5));
        c.water = makeWater(0x2f6f8a, 0.86);
        makeVehicle(0xf4f4f4, [0xff2a2a, 0x2a6bff], -80, -16, Math.PI / 2);
        makeVehicle(0xc0262b, [0xff2a2a, 0xff2a2a], -80, 16, Math.PI / 2);
        makeHeli(0xd23a2a, () => [-14, 0], 50, 40, 0.3);
        c.boats = [];
        for (let k = 0; k < 3; k++) {
          const g = new THREE.Group();
          const hull = new THREE.Mesh(G.box, M(pick([0xf0f0f0, 0x2a5a8a, 0xc04a2a])));
          hull.scale.set(4, 1, 1.8);
          const cab = new THREE.Mesh(G.box, M(0xeeeeee));
          cab.scale.set(1.4, 1, 1.4);
          cab.position.y = 0.9;
          g.add(hull, cab);
          modeGroup.add(g);
          c.boats.push({ g, x: R(45, 85), z: R(-60, 60) });
        }
        c.wave = () => 0;
        new Particles(450, {
          color: 0xffffff, size: 1.6, opacity: 0.85,
          spawn: (i, p) => {
            if (c.active) {
              const z = R(-140, 140), x = c.wx + Math.sin(z * 0.05 + 1) * 5 + R(-1, 2);
              p.set(i, x, c.crest(x), z, R(-2, 0), R(1, 4), 0, R(0.4, 1));
            } else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.3));
          }
        });
        c.wx = 200;
        c.active = false;
        c.crest = () => 0;
      },
      update(_dt, t, c) {
        const cyc = t % 24, A0 = 9 * INT;
        c.active = cyc < 16;
        c.wx = c.active ? 130 - (cyc / 16) * 240 : -200;
        c.cyc = cyc;
        const rec = c.active ? 1 : Math.max(0, 1 - (cyc - 16) / 6), wx = c.wx;
        const amp = x => A0 * (0.5 + 0.5 * smooth(110, 10, x));
        c.crest = x => amp(x);
        const fn = (x, z) => {
          const w = wx + Math.sin(z * 0.05 + 1) * 5;
          let y = amp(x) * Math.exp(-(((x - w) / 7) ** 2));
          y += A0 * 0.35 * smooth(w, w + 20, x) * rec;
          if (c.active) y -= 1.6 * Math.exp(-(((x - w + 28) / 16) ** 2));
          return y + Math.sin(x * 0.2 + t * 1.5) * 0.15 + Math.sin(z * 0.17 + t) * 0.1;
        };
        updateWater(c.water, fn);
        for (const b of c.boats) {
          b.g.position.set(b.x, fn(b.x, b.z) + 0.3, b.z);
          b.g.rotation.z = Math.sin(t * 1.5 + b.z) * 0.08;
        }
      },
      status(c) {
        if (!c.active) return 'Water receding from the coast';
        return c.wx > 55 ? 'Sea pulling back from the shore' : c.wx > -5 ? 'Wave reaching the coast' : 'Water surging inland';
      }
    },
    {
      ...MODES_META[6],
      sky: 0xa9b4ba, fogNear: 80, fogFar: 320, hemiGround: 0x54483a,
      town: [0, 46], townR: 54, safe: [-82, 74], camTarget: [0, 12], camR: 170,
      raw: (x, z) => {
        const m = smooth(-12, -85, z);
        let h = hills(x, z, 5) + m * 58 + (fbm(x * 0.05, z * 0.05) - 0.5) * 10 * m;
        h -= 5 * Math.exp(-((x / 18) ** 2)) * smooth(-2, -30, z) * (1 - smooth(-70, -92, z));
        return h;
      },
      color(c, x, y, z, s) {
        natural(c, x, y, z, s, {});
        const k = smooth(26, 15, Math.abs(x)) * smooth(12, 4, z) * smooth(-95, -85, z);
        _c2.set(0x6b4f35);
        c.lerp(_c2, k * 0.9);
      },
      build(c) {
        addTown(0, 46, this._townLevel, { damage: (x, z) => (z < 16 && Math.abs(x) < 34 ? 0.9 : 0.08) });
        c.trees = addTrees(110, (x, z) => okTree(x, z) && (Math.abs(x) > 28 || z > 12));
        makeVehicle(0xe8b820, [0xffb000, 0xffb000], -57, 20, 0);
        makeVehicle(0xf4f4f4, [0xff2a2a, 0x2a6bff], 57, 28, Math.PI);
        c.rocks = [];
        for (let k = 0; k < 44; k++) {
          const s = R(0.8, 3), m = new THREE.Mesh(G.rock, M(pick([0x7b7066, 0x6a5f55, 0x8a7f72])));
          m.scale.setScalar(s);
          m.castShadow = true;
          modeGroup.add(m);
          const r = { m, s, x: 0, z: 0, vx: 0, vz: 0, rest: R(0, 6), stopZ: 0 };
          c.rocks.push(r);
          this.respawnRock(r);
          r.z = R(-88, 0);
        }
        const moving = () => c.rocks.filter(r => r.rest <= 0);
        new Particles(500, {
          color: 0x8a7258, size: 4, opacity: 0.3,
          spawn: (i, p) => {
            const mv = moving();
            if (mv.length) {
              const r = pick(mv);
              p.set(i, r.x + R(-1, 1), r.m.position.y, r.z + R(-1, 1), R(-1, 1), R(1, 3), R(-1, 1), R(1.5, 3));
            } else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.3));
          }
        });
      },
      respawnRock(r) {
        r.x = R(-24, 24);
        r.z = R(-90, -64);
        r.vx = 0;
        r.vz = 0;
        r.stopZ = R(-2, 20);
      },
      update(dt, _t, c) {
        let n = 0;
        for (const r of c.rocks) {
          if (r.rest > 0) {
            r.rest -= dt;
            if (r.rest <= 0) this.respawnRock(r);
          } else {
            n++;
            const gx = (H(r.x + 0.8, r.z) - H(r.x - 0.8, r.z)) / 1.6, gz = (H(r.x, r.z + 0.8) - H(r.x, r.z - 0.8)) / 1.6;
            r.vx += -gx * 26 * dt * INT;
            r.vz += (-gz * 26 + 2) * dt * INT;
            r.vx *= 0.985;
            r.vz *= 0.985;
            r.x += r.vx * dt;
            r.z += r.vz * dt;
            r.m.rotation.x += (r.vz * dt) / r.s;
            r.m.rotation.z -= (r.vx * dt) / r.s;
            if (r.z > r.stopZ) r.rest = R(3, 8);
          }
          r.m.position.set(r.x, H(r.x, r.z) + r.s * 0.75, r.z);
        }
        c.moving = n;
      },
      status(c) {
        return `${c.moving || 0} boulders sliding downhill`;
      }
    }
  ];

  /* ---------- 3D Swarm C2 & Tactical Network Layer ---------- */
  const ROLE_MATS = {
    mission: M(0x7fc95e, { emissive: 0x3b8a22, emissiveIntensity: 0.9 }),
    relay: M(0xe6b345, { emissive: 0xb47b15, emissiveIntensity: 1.0 }),
    hold: M(0xd970a8, { emissive: 0x9d346e, emissiveIntensity: 0.9 }),
    relink: M(0x5ecfcf, { emissive: 0x1e8e8e, emissiveIntensity: 1.0 }),
    rescue: M(0x6f9fe6, { emissive: 0x2b5fb3, emissiveIntensity: 0.9 }),
    rtb: M(0x38bdf8, { emissive: 0x0284c7, emissiveIntensity: 1.0 }),
    landed: M(0x4ade80, { emissive: 0x16a34a, emissiveIntensity: 0.7 }),
    recharging: M(0xfbbf24, { emissive: 0xd97706, emissiveIntensity: 0.9 }),
    dead: M(0xe06050, { emissive: 0x991b1b, emissiveIntensity: 0.8 }),
    bodyDark: M(0x1e293b, { roughness: 0.5, metalness: 0.3 }),
    rotorMat: M(0x94a3b8, { transparent: true, opacity: 0.65 }),
    gcsBase: M(0x334155, { roughness: 0.6 }),
    gcsBeacon: M(0x38bdf8, { emissive: 0x0ea5e9, emissiveIntensity: 1.4 }),
    poiCritical: M(0xff3333, { emissive: 0xdc2626, emissiveIntensity: 1.2, side: THREE.DoubleSide }),
    poiHigh: M(0xff7700, { emissive: 0xea580c, emissiveIntensity: 1.1, side: THREE.DoubleSide }),
    poiSurveying: M(0xffaa00, { emissive: 0xd97706, emissiveIntensity: 1.3, side: THREE.DoubleSide }),
    poiSurveyed: M(0x22c55e, { emissive: 0x16a34a, emissiveIntensity: 1.2, side: THREE.DoubleSide }),
    jammerFill: new THREE.MeshBasicMaterial({ color: 0xe06050, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    jammerEdge: new THREE.MeshBasicMaterial({ color: 0xff5544, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
    gpsFill: new THREE.MeshBasicMaterial({ color: 0xa48fe0, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }),
    gpsEdge: new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
    selBeam: new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }),
    linkOk: new THREE.LineBasicMaterial({ color: 0x8fd960, transparent: true, opacity: 0.9 }),
    linkDegraded: new THREE.LineBasicMaterial({ color: 0xe0a63c, transparent: true, opacity: 0.85 }),
    linkLost: new THREE.LineBasicMaterial({ color: 0xe06050, transparent: true, opacity: 0.75 }),

    // Khatib APF Collision Avoidance & Downwash
    apfSafetyOk: new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, transparent: true, opacity: 0.28 }),
    apfSafetyWarn: new THREE.MeshBasicMaterial({ color: 0xef4444, wireframe: true, transparent: true, opacity: 0.7 }),
    apfFieldOk: new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.16, side: THREE.DoubleSide }),
    apfFieldWarn: new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    downwashMat: new THREE.MeshBasicMaterial({ color: 0x06b6d4, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }),

    // Dual-Band FANET Links & Telemetry Packets
    link24G: new THREE.LineBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.95 }),
    linkLora: new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.95 }),
    packetPulseMat: new THREE.MeshBasicMaterial({ color: 0xffffff }),

    // AI Vision FLIR Thermal & OpenCV Hazards
    flirVitalSign: M(0xff0055, { emissive: 0xff0044, emissiveIntensity: 1.8, side: THREE.DoubleSide }),
    hazardFire: M(0xff4500, { emissive: 0xff2200, emissiveIntensity: 2.0 }),
    hazardGas: new THREE.MeshBasicMaterial({ color: 0xeab308, transparent: true, opacity: 0.35, depthWrite: false }),
    hazardRoad: M(0xf59e0b, { emissive: 0xd97706, emissiveIntensity: 1.4 }),

    // OctoMap 3D Rubble Voxels
    octoRubble: new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.75, metalness: 0.2, transparent: true, opacity: 0.72 })
  };
  [
    ROLE_MATS.jammerFill, ROLE_MATS.jammerEdge, ROLE_MATS.gpsFill, ROLE_MATS.gpsEdge,
    ROLE_MATS.selBeam, ROLE_MATS.linkOk, ROLE_MATS.linkDegraded, ROLE_MATS.linkLost,
    ROLE_MATS.apfSafetyOk, ROLE_MATS.apfSafetyWarn, ROLE_MATS.apfFieldOk, ROLE_MATS.apfFieldWarn,
    ROLE_MATS.downwashMat, ROLE_MATS.link24G, ROLE_MATS.linkLora, ROLE_MATS.packetPulseMat,
    ROLE_MATS.flirVitalSign, ROLE_MATS.hazardFire, ROLE_MATS.hazardGas, ROLE_MATS.hazardRoad, ROLE_MATS.octoRubble
  ].forEach(m => shared.add(m));

  function getRoleMat(role, mode) {
    if (mode === 'dead' || role === 'dead') return ROLE_MATS.dead;
    if (mode === 'returning' || mode === 'landing' || role === 'RETURNING_TO_BASE' || role === 'LANDING' || role === 'rtb' || role === 'rtl') return ROLE_MATS.rtb;
    if (mode === 'landed' || role === 'LANDED' || role === 'AVAILABLE') return ROLE_MATS.landed;
    if (role === 'RECHARGING') return ROLE_MATS.recharging;
    return ROLE_MATS[role] || ROLE_MATS.mission;
  }

  // GCS Ground Station (C2) 3D Object
  const gcsGroup = new THREE.Group();
  {
    const van = new THREE.Mesh(G.box, ROLE_MATS.gcsBase);
    van.scale.set(4.5, 2.2, 2.8);
    van.position.y = 1.1;
    van.castShadow = true;
    const mast = new THREE.Mesh(G.trunk, M(0xcbd5e1));
    mast.scale.set(0.45, 2.6, 0.45);
    mast.position.set(0, 3.8, 0);
    const beacon = new THREE.Mesh(G.beacon, ROLE_MATS.gcsBeacon);
    beacon.scale.setScalar(1.3);
    beacon.position.set(0, 6.8, 0);
    const ring = new THREE.Mesh(G.selRing, ROLE_MATS.gcsBeacon);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.2;
    gcsGroup.add(van, mast, beacon, ring);
    gcsGroup.userData = { beacon, ring };
    swarmGroup.add(gcsGroup);
  }

  // Layer visibility toggles
  let showApfBubbles = true;
  let showFanetLinks = true;
  let showOctomapVoxels = true;
  let showAiDetections = true;

  // 1. OctoMap 3D Rubble Voxels (InstancedMesh for high performance)
  const MAX_OCTO_VOXELS = 600;
  const octoInstanced = new THREE.InstancedMesh(G.octoBox, ROLE_MATS.octoRubble, MAX_OCTO_VOXELS);
  octoInstanced.count = 0;
  octoInstanced.frustumCulled = false;
  swarmGroup.add(octoInstanced);

  // 3. Telemetry packet pulse particles along FANET links
  const packetMeshes = [];
  const MAX_PACKETS = 16;
  for (let i = 0; i < MAX_PACKETS; i++) {
    const pm = new THREE.Mesh(G.packetSphere, ROLE_MATS.packetPulseMat);
    pm.visible = false;
    swarmGroup.add(pm);
    packetMeshes.push(pm);
  }

  // 4. OpenCV Tagged Hazard Group (Fire, Gas, Blocked Roads)
  const hazardGroup = new THREE.Group();
  swarmGroup.add(hazardGroup);
  const hazardMeshes = new Map();

  const droneMeshes = new Map();
  const poiMeshes = new Map();
  const jammerMeshes = [];
  const gpsZoneMeshes = [];
  const linkLines = [];
  const MAX_LINKS = 40;

  for (let i = 0; i < MAX_LINKS; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    shared.add(geo);
    const line = new THREE.Line(geo, ROLE_MATS.linkOk);
    line.frustumCulled = false;
    line.visible = false;
    swarmGroup.add(line);
    linkLines.push(line);
  }

  function makeDroneMesh3D(id) {
    const g = new THREE.Group();
    const core = new THREE.Mesh(G.box, ROLE_MATS.bodyDark);
    core.scale.set(1.5, 0.42, 1.5);
    const arm1 = new THREE.Mesh(G.box, ROLE_MATS.bodyDark);
    arm1.scale.set(3.4, 0.16, 0.22);
    arm1.rotation.y = Math.PI / 4;
    const arm2 = new THREE.Mesh(G.box, ROLE_MATS.bodyDark);
    arm2.scale.set(3.4, 0.16, 0.22);
    arm2.rotation.y = -Math.PI / 4;
    g.add(core, arm1, arm2);

    const rotors = [];
    const offs = [[1.15, 1.15], [1.15, -1.15], [-1.15, 1.15], [-1.15, -1.15]];
    offs.forEach(([rx, rz]) => {
      const r = new THREE.Mesh(G.droneRotor, ROLE_MATS.rotorMat);
      r.position.set(rx, 0.22, rz);
      g.add(r);
      rotors.push(r);
    });

    const beacon = new THREE.Mesh(G.beacon, ROLE_MATS.mission);
    beacon.scale.setScalar(0.95);
    beacon.position.y = 0.75;
    const roleRing = new THREE.Mesh(G.droneRing, ROLE_MATS.mission);
    roleRing.rotation.x = -Math.PI / 2;
    roleRing.position.y = -0.15;

    const selRing = new THREE.Mesh(G.selRing, VMAT.selected);
    selRing.rotation.x = -Math.PI / 2;
    selRing.position.y = -0.2;
    selRing.visible = false;

    const selBeam = new THREE.Mesh(G.beamCyl, ROLE_MATS.selBeam);
    selBeam.position.y = -6;
    selBeam.scale.set(1, 12, 1);
    selBeam.visible = false;

    // Khatib APF Collision Avoidance: 1.5m Hard Safety Clearance Sphere
    const apfSphere = new THREE.Mesh(G.apfSphere, ROLE_MATS.apfSafetyOk);
    apfSphere.visible = showApfBubbles;

    // Khatib APF Repulsive Potential Field Ring: 3.0m
    const apfRing = new THREE.Mesh(G.apfRing, ROLE_MATS.apfFieldOk);
    apfRing.rotation.x = -Math.PI / 2;
    apfRing.position.y = -0.05;
    apfRing.visible = showApfBubbles;

    // Downwash Vortex Ring State Avoidance Cone underneath drone
    const downwashCone = new THREE.Mesh(G.downwashCone, ROLE_MATS.downwashMat);
    downwashCone.position.y = -4.5;
    downwashCone.visible = showApfBubbles;

    // 3D Synthetic LiDAR Scanning Fan Cone
    const lidarFan = new THREE.Mesh(G.lidarCone, ROLE_MATS.downwashMat);
    lidarFan.position.y = -7.0;
    lidarFan.rotation.x = Math.PI;
    lidarFan.visible = false;

    const hitMesh = new THREE.Mesh(G.hitSphere, VMAT.hitInvisible);
    hitMesh.userData = { pickType: 'drone', droneId: id };

    g.add(beacon, roleRing, selRing, selBeam, apfSphere, apfRing, downwashCone, lidarFan, hitMesh);
    swarmGroup.add(g);
    const item = { id, g, rotors, beacon, roleRing, selRing, selBeam, apfSphere, apfRing, downwashCone, lidarFan, hitMesh };
    droneMeshes.set(id, item);
    return item;
  }

  function makePoiMesh3D(id) {
    const g = new THREE.Group();
    const pin = new THREE.Mesh(G.beacon, ROLE_MATS.poiCritical);
    pin.scale.setScalar(1.25);
    pin.position.y = 4.2;
    const ring = new THREE.Mesh(G.ring, ROLE_MATS.poiCritical);
    ring.scale.setScalar(1.65);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.25;
    const selRing = new THREE.Mesh(G.selRing, VMAT.selected);
    selRing.scale.setScalar(1.3);
    selRing.rotation.x = -Math.PI / 2;
    selRing.position.y = 0.32;
    selRing.visible = false;
    const hitMesh = new THREE.Mesh(G.hitSphere, VMAT.hitInvisible);
    hitMesh.position.y = 2.5;
    hitMesh.userData = { pickType: 'poi', poiId: id };
    g.add(pin, ring, selRing, hitMesh);
    swarmGroup.add(g);
    const item = { id, g, pin, ring, selRing, hitMesh };
    poiMeshes.set(id, item);
    return item;
  }

  function updateSwarmLayer(dt, t) {
    const st = sharedSim.state;
    const selDroneId = st.selection.selectedDroneId;
    const selPoiId = st.selection.selectedPoiId;

    // 1. Update GCS (C2) station
    if (st.network && st.network.gcsPosition) {
      const gx = st.network.gcsPosition.x;
      const gz = st.network.gcsPosition.z;
      const gy = H(gx, gz);
      gcsGroup.position.set(gx, gy, gz);
      gcsGroup.userData.beacon.rotation.y += dt * 1.8;
      gcsGroup.userData.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.15);
    }

    // 2. Update Drones
    const activeDroneIds = new Set();
    for (const d of st.drones) {
      activeDroneIds.add(d.id);
      let dm = droneMeshes.get(d.id);
      if (!dm) dm = makeDroneMesh3D(d.id);
      dm.g.visible = true;
      const gx = d.position.x;
      const gz = d.position.z;
      const groundY = H(gx, gz);
      const isGround = d.mode === 'landed' || d.mode === 'dead';
      const flyY = isGround ? groundY + 0.55 : Math.max(groundY + 9, d.position.y);
      dm.g.position.set(gx, flyY, gz);

      // 6-DOF kinematics tilt and rotor spinning
      if (d.mode === 'dead') {
        dm.g.rotation.set(0.45, 0, 0.55);
      } else {
        if (d.attitude) {
          dm.g.rotation.x = d.attitude.pitch || 0;
          dm.g.rotation.z = d.attitude.roll || 0;
          if (d.attitude.yaw) dm.g.rotation.y = d.attitude.yaw;
        } else {
          dm.g.rotation.x = 0;
          dm.g.rotation.z = 0;
          if (Math.hypot(d.velocity.vx, d.velocity.vy) > 0.2) {
            dm.g.rotation.y = -Math.atan2(d.velocity.vy, d.velocity.vx);
          }
        }
        for (let r = 0; r < dm.rotors.length; r++) {
          dm.rotors[r].rotation.y += dt * (d.mode === 'landed' ? 2 : 34);
        }
      }

      // Check peer distance for Khatib APF repulsive collision avoidance
      let minPeerDist = 999;
      for (const other of st.drones) {
        if (other.id !== d.id && other.status !== 'dead') {
          const dist = Math.hypot(gx - other.position.x, gz - other.position.z, flyY - other.position.y);
          if (dist < minPeerDist) minPeerDist = dist;
        }
      }
      const apfActive = minPeerDist < 3.0;
      dm.apfSphere.material = apfActive ? ROLE_MATS.apfSafetyWarn : ROLE_MATS.apfSafetyOk;
      dm.apfRing.material = apfActive ? ROLE_MATS.apfFieldWarn : ROLE_MATS.apfFieldOk;
      dm.apfRing.scale.setScalar(apfActive ? 1.0 + Math.sin(t * 8) * 0.12 : 1.0);
      dm.apfSphere.visible = showApfBubbles && !isGround;
      dm.apfRing.visible = showApfBubbles && !isGround;
      dm.downwashCone.visible = showApfBubbles && !isGround;
      dm.downwashCone.rotation.y += dt * 1.5;

      // 3D Synthetic LiDAR Scanning Fan Cone
      dm.lidarFan.visible = (d.fsm === 'SURV' || d.mode === 'surveying' || d.role === 'mission') && !isGround;
      if (dm.lidarFan.visible) {
        dm.lidarFan.rotation.y += dt * 3.5;
        dm.lidarFan.scale.set(1 + Math.sin(t * 5) * 0.08, 1, 1 + Math.sin(t * 5) * 0.08);
      }

      const rMat = getRoleMat(d.role, d.mode);
      dm.beacon.material = rMat;
      dm.roleRing.material = rMat;
      dm.beacon.rotation.y += dt * 2.5;

      const isSelected = selDroneId === d.id;
      dm.selRing.visible = isSelected;
      dm.selBeam.visible = isSelected && !isGround;
      if (isSelected) {
        dm.selRing.rotation.z = t * 2.4;
        const hToGround = Math.max(1, flyY - groundY);
        dm.selBeam.scale.set(1, hToGround, 1);
        dm.selBeam.position.y = -hToGround / 2;
      }
    }
    for (const [id, dm] of droneMeshes.entries()) {
      if (!activeDroneIds.has(id)) dm.g.visible = false;
    }

    // 3. Update Crisis PoIs (non-survivor PoIs; survivor PoIs are rendered on the 3D survivors themselves)
    const activePoiIds = new Set();
    for (const p of st.pois) {
      if (p.type === 'survivor') continue;
      activePoiIds.add(p.id);
      let pm = poiMeshes.get(p.id);
      if (!pm) pm = makePoiMesh3D(p.id);
      pm.g.visible = true;
      const px = p.position.x;
      const pz = p.position.z;
      const py = H(px, pz);
      pm.g.position.set(px, py, pz);
      pm.pin.position.y = 4.0 + Math.sin(t * 2.6 + px) * 0.35;
      pm.pin.rotation.y += dt * 2.0;

      let pMat = ROLE_MATS.poiCritical;
      if (p.status === 'SURVEYED' || p.status === 'ACKNOWLEDGED') pMat = ROLE_MATS.poiSurveyed;
      else if (p.status === 'SURVEYING' || p.status === 'DATA_CREATED') pMat = ROLE_MATS.poiSurveying;
      else if (p.priority === 'HIGH' || p.priority === 'MEDIUM' || p.priority === 'LOW') pMat = ROLE_MATS.poiHigh;
      pm.pin.material = pMat;
      pm.ring.material = pMat;

      pm.selRing.visible = selPoiId === p.id;
      if (pm.selRing.visible) pm.selRing.rotation.z = t * 2.2;
    }
    for (const [id, pm] of poiMeshes.entries()) {
      if (!activePoiIds.has(id)) pm.g.visible = false;
    }

    // 4. Update Dual-Band RF Network Links
    const links = (st.network && st.network.links) ? st.network.links : [];
    for (let i = 0; i < MAX_LINKS; i++) {
      const line = linkLines[i];
      if (i >= links.length || !showFanetLinks) {
        line.visible = false;
        continue;
      }
      const lk = links[i];
      line.visible = true;
      const posAttr = line.geometry.attributes.position;
      const arr = posAttr.array;
      const ay = Math.max(H(lk.from3D.x, lk.from3D.z) + 4.5, lk.from3D.y);
      const by = Math.max(H(lk.to3D.x, lk.to3D.z) + 4.5, lk.to3D.y);
      arr[0] = lk.from3D.x;
      arr[1] = ay;
      arr[2] = lk.from3D.z;
      arr[3] = lk.to3D.x;
      arr[4] = by;
      arr[5] = lk.to3D.z;
      posAttr.needsUpdate = true;
      line.material = lk.band === 'LORA'
        ? ROLE_MATS.linkLora
        : lk.state === 'ok'
          ? ROLE_MATS.link24G
          : lk.state === 'degraded'
            ? ROLE_MATS.linkDegraded
            : ROLE_MATS.linkLost;
    }

    // Animate telemetry packet transmission pulses along links
    for (let p = 0; p < packetMeshes.length; p++) {
      const pm = packetMeshes[p];
      if (p >= links.length || !showFanetLinks) {
        pm.visible = false;
        continue;
      }
      const lk = links[p];
      pm.visible = true;
      const progress = ((t * 2.2 + p * 0.28) % 1.0);
      const lfrom = lk.from3D;
      const lto = lk.to3D;
      const ay = Math.max(H(lfrom.x, lfrom.z) + 4.5, lfrom.y);
      const by = Math.max(H(lto.x, lto.z) + 4.5, lto.y);
      pm.position.set(
        lfrom.x + (lto.x - lfrom.x) * progress,
        ay + (by - ay) * progress,
        lfrom.z + (lto.z - lfrom.z) * progress
      );
      pm.material = lk.band === 'LORA' ? ROLE_MATS.linkLora : ROLE_MATS.link24G;
    }

    // 5. Update RF Jammers & GPS Denied Zones in 3D
    const jammers = (st.hazards && st.hazards.jammerZones) ? st.hazards.jammerZones : [];
    while (jammerMeshes.length < jammers.length) {
      const g = new THREE.Group();
      const cyl = new THREE.Mesh(G.zoneCyl, ROLE_MATS.jammerFill);
      cyl.position.y = 7;
      const ring = new THREE.Mesh(G.zoneRing, ROLE_MATS.jammerEdge);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.35;
      const emitter = new THREE.Mesh(G.beacon, ROLE_MATS.dead);
      emitter.scale.setScalar(1.4);
      emitter.position.y = 3.5;
      g.add(cyl, ring, emitter);
      swarmGroup.add(g);
      jammerMeshes.push({ g, cyl, ring, emitter });
    }
    for (let i = 0; i < jammerMeshes.length; i++) {
      const jm = jammerMeshes[i];
      if (i >= jammers.length || !jammers[i].on) {
        jm.g.visible = false;
        continue;
      }
      const j = jammers[i];
      jm.g.visible = true;
      const jx = j.position3D.x, jz = j.position3D.z, jy = H(jx, jz);
      jm.g.position.set(jx, jy, jz);
      const r = Math.max(6, Math.min(55, j.radius3D || 24));
      jm.cyl.scale.set(r, 1, r);
      jm.ring.scale.set(r, r, 1);
      jm.emitter.rotation.y += dt * 3;
    }

    const gpsZones = (st.hazards && st.hazards.gpsDeniedZones) ? st.hazards.gpsDeniedZones : [];
    while (gpsZoneMeshes.length < gpsZones.length) {
      const g = new THREE.Group();
      const cyl = new THREE.Mesh(G.zoneCyl, ROLE_MATS.gpsFill);
      cyl.position.y = 7;
      const ring = new THREE.Mesh(G.zoneRing, ROLE_MATS.gpsEdge);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.35;
      const emitter = new THREE.Mesh(G.beacon, ROLE_MATS.gpsEdge);
      emitter.scale.setScalar(1.3);
      emitter.position.y = 3.5;
      g.add(cyl, ring, emitter);
      swarmGroup.add(g);
      gpsZoneMeshes.push({ g, cyl, ring, emitter });
    }
    for (let i = 0; i < gpsZoneMeshes.length; i++) {
      const gm = gpsZoneMeshes[i];
      if (i >= gpsZones.length || !gpsZones[i].on) {
        gm.g.visible = false;
        continue;
      }
      const z = gpsZones[i];
      gm.g.visible = true;
      const zx = z.position3D.x, zz = z.position3D.z, zy = H(zx, zz);
      gm.g.position.set(zx, zy, zz);
      const r = Math.max(6, Math.min(55, z.radius3D || 22));
      gm.cyl.scale.set(r, 1, r);
      gm.ring.scale.set(r, r, 1);
      gm.emitter.rotation.y -= dt * 2.2;
    }

    // 6. Update Survivors with FLIR Thermal Life Sign Verification
    for (const v of victimList) {
      const match = st.survivors.find(s => s.id === v.id || (Math.hypot(s.position.x - v.g.position.x, s.position.z - v.g.position.z) < 8));
      if (match && match.detected) {
        if (match.lifeVerified) {
          v.beacon.material = ROLE_MATS.flirVitalSign;
          v.ring.material = ROLE_MATS.flirVitalSign;
          const pulse = 1.0 + Math.sin(t * 7) * 0.35; // Heartbeat vital pulse
          v.beacon.scale.setScalar(pulse * 1.25);
          v.ring.scale.setScalar(pulse * 1.6);
        } else {
          v.beacon.material = ROLE_MATS.poiSurveying;
        }
      }
    }

    // 7. Update OpenCV Tagged Hazards (Fire, Gas, Blocked Roads)
    const hazards = (st.hazards && st.hazards.taggedHazards) ? st.hazards.taggedHazards : [];
    const activeHazardIds = new Set();
    for (const hz of hazards) {
      activeHazardIds.add(hz.id);
      let hm = hazardMeshes.get(hz.id);
      if (!hm) {
        const g = new THREE.Group();
        const cone = new THREE.Mesh(G.hazardPyramid, ROLE_MATS.hazardFire);
        cone.position.y = 2.4;
        const ring = new THREE.Mesh(G.zoneRing, ROLE_MATS.hazardFire);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.2;
        ring.scale.set(6, 6, 1);
        g.add(cone, ring);
        hazardGroup.add(g);
        hm = { g, cone, ring, type: hz.type };
        hazardMeshes.set(hz.id, hm);
      }
      hm.g.visible = showAiDetections;
      const hx = hz.position3D.x;
      const hzCoord = hz.position3D.z;
      const hy = H(hx, hzCoord);
      hm.g.position.set(hx, hy, hzCoord);
      hm.cone.rotation.y += dt * 2.0;

      if (hz.type === 'FIRE') {
        hm.cone.material = ROLE_MATS.hazardFire;
        hm.cone.scale.set(1 + Math.sin(t * 9) * 0.15, 1 + Math.sin(t * 11) * 0.2, 1 + Math.sin(t * 9) * 0.15);
      } else if (hz.type === 'GAS' || hz.type === 'PLUM') {
        hm.cone.material = ROLE_MATS.hazardGas;
        hm.cone.scale.set(1.4 + Math.sin(t * 2) * 0.2, 1.2, 1.4 + Math.sin(t * 2) * 0.2);
      } else {
        hm.cone.material = ROLE_MATS.hazardRoad;
      }
    }
    for (const [id, hm] of hazardMeshes.entries()) {
      if (!activeHazardIds.has(id)) hm.g.visible = false;
    }

    // 8. Update OctoMap 3D Rubble Voxels from LiDAR Scanning
    const voxels = (st.octomap && st.octomap.voxels) ? st.octomap.voxels : [];
    const vCount = Math.min(voxels.length, MAX_OCTO_VOXELS);
    octoInstanced.count = vCount;
    octoInstanced.visible = showOctomapVoxels && vCount > 0;
    if (octoInstanced.visible) {
      const dummy = new THREE.Object3D();
      for (let i = 0; i < vCount; i++) {
        const v = voxels[i];
        const vx = v[0];
        const vz = v[1];
        const vy = v[2];
        const gy = H(vx, vz);
        dummy.position.set(vx, gy + vy, vz);
        dummy.scale.set(0.95, 0.95, 0.95);
        dummy.updateMatrix();
        octoInstanced.setMatrixAt(i, dummy.matrix);
      }
      octoInstanced.instanceMatrix.needsUpdate = true;
    }
  }

  function syncWorldToSharedStore(modeIndex) {
    if (!curMode) return;
    const m = curMode;
    const buildings3D = buildings.map((b, idx) => ({
      id: `BLD-${idx + 1}`,
      x: b.x,
      y: m._townLevel || 0,
      z: b.z,
      w: (b.hw || 3) * 2,
      d: (b.hd || 3) * 2,
      h: Math.max(1, (b.top || 8) - (m._townLevel || 0)),
      damageState: b.damageState || 'intact',
    }));
    const survivors3D = victimList.map((v) => ({
      id: v.id,
      x: v.g.position.x,
      y: v.g.position.y,
      z: v.g.position.z,
    }));

    const hazardZones3D = {
      fireZones: [],
      floodZones: [],
      debrisZones: [],
      landslideZones: [],
    };
    const rScale = 0.75 + 0.35 * INT;
    const cityRad = m._townHalf || m.townR || 54;
    if (m.id === 'wildfire') {
      hazardZones3D.fireZones.push({ kind: 'fire', label: 'WILDFIRE FRONT', x: -20, z: 0, r: 34 * rScale });
    } else if (m.id === 'volcano') {
      hazardZones3D.fireZones.push({ kind: 'fire', label: 'VOLCANIC VENT', x: -50, z: -50, r: 30 * rScale });
    } else if (m.id === 'flood') {
      hazardZones3D.floodZones.push({ kind: 'flood', label: 'FLOOD BASIN', x: m.town[0], z: m.town[1], r: cityRad * 0.85 * rScale });
    } else if (m.id === 'tsunami') {
      hazardZones3D.floodZones.push({ kind: 'tsunami', label: 'TSUNAMI SURGE', x: 10, z: 0, r: 42 * rScale });
    } else if (m.id === 'tornado') {
      hazardZones3D.debrisZones.push({ kind: 'tornado', label: 'TORNADO VORTEX', x: m.town[0], z: m.town[1], r: cityRad * 0.75 * rScale });
    } else if (m.id === 'earthquake') {
      hazardZones3D.debrisZones.push({ kind: 'debris', label: 'SEISMIC RUBBLE', x: m.town[0], z: m.town[1], r: cityRad * 0.85 * rScale });
    } else if (m.id === 'landslide') {
      hazardZones3D.landslideZones.push({ kind: 'landslide', label: 'SLIDE CHANNEL', x: 0, z: -15, r: 32 * rScale });
    }

    sharedSim.sync3DWorldToStore({
      disasterType: m.id,
      disasterIndex: modeIndex,
      disasterTitle: m.name,
      intensity: INT,
      safeZone3D: { x: m.safe[0], z: m.safe[1] },
      townCenter3D: { x: m.town[0], z: m.town[1] },
      cityBounds3D: m.cityBounds,
      buildings3D,
      survivors3D,
      hazardZones3D,
      heightFn: (x, z) => H(x, z),
    });
  }

  /* ---------- camera & 3D selection raycasting ---------- */
  const orbit = { theta: 0.9, phi: 0.95, r: 150, target: new THREE.Vector3(), auto: !reduced };
  const ptrs = new Map();
  let pinch0 = 0, r0 = 0;
  let downPos = null;
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  function pick3DObject(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);

    const pickables = [];
    for (const dm of droneMeshes.values()) {
      if (dm.g.visible) pickables.push(dm.hitMesh);
    }
    for (const pm of poiMeshes.values()) {
      if (pm.g.visible) pickables.push(pm.hitMesh);
    }
    for (const v of victimList) {
      if (v.g.visible && v.hitMesh) pickables.push(v.hitMesh);
    }

    const hits = raycaster.intersectObjects(pickables, false);
    if (hits.length > 0) {
      const ud = hits[0].object.userData || {};
      if (ud.pickType === 'drone' && ud.droneId) {
        sharedSim.selectDrone(ud.droneId, '3d');
      } else if (ud.pickType === 'poi' && ud.poiId) {
        sharedSim.selectPoi(ud.poiId, '3d');
        const poiObj = sharedSim.state.pois.find(p => p.id === ud.poiId);
        if (poiObj && poiObj.assignedDrone) {
          sharedSim.selectDrone(poiObj.assignedDrone, '3d');
        }
      }
    }
  }

  const onPtrDown = e => {
    if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) {
      downPos = { x: e.clientX, y: e.clientY };
    } else {
      downPos = null;
    }
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      r0 = orbit.r;
    }
  };
  const onPtrMove = e => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId), cur = { x: e.clientX, y: e.clientY };
    ptrs.set(e.pointerId, cur);
    if (ptrs.size === 1) {
      orbit.theta -= (cur.x - prev.x) * 0.006;
      orbit.phi = clamp(orbit.phi - (cur.y - prev.y) * 0.005, 0.2, 1.45);
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 1 && pinch0 > 1) orbit.r = clamp((r0 * pinch0) / d, 35, 280);
    }
  };
  const up = e => {
    if (downPos && ptrs.size === 1) {
      const moveDist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      if (moveDist < 6) {
        pick3DObject(e.clientX, e.clientY);
      }
    }
    downPos = null;
    ptrs.delete(e.pointerId);
  };
  const clearPtrs = () => {
    downPos = null;
    ptrs.clear();
  };
  const onWheel = e => {
    e.preventDefault();
    orbit.r = clamp(orbit.r * (1 + e.deltaY * 0.0012), 35, 280);
  };

  canvas.addEventListener('pointerdown', onPtrDown);
  canvas.addEventListener('pointermove', onPtrMove);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('lostpointercapture', up);
  window.addEventListener('blur', clearPtrs);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const onKeyCamera = e => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      orbit.theta -= 0.05;
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      orbit.theta += 0.05;
    } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
      orbit.phi = clamp(orbit.phi - 0.04, 0.2, 1.45);
    } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
      orbit.phi = clamp(orbit.phi + 0.04, 0.2, 1.45);
    } else if (e.key === '+' || e.key === '=') {
      orbit.r = clamp(orbit.r * 0.92, 35, 280);
    } else if (e.key === '-' || e.key === '_') {
      orbit.r = clamp(orbit.r * 1.08, 35, 280);
    }
  };
  window.addEventListener('keydown', onKeyCamera);

  function updateCamera() {
    const t = orbit.target, s = Math.sin(orbit.phi);
    camera.position.set(t.x + orbit.r * s * Math.sin(orbit.theta), t.y + orbit.r * Math.cos(orbit.phi), t.z + orbit.r * s * Math.cos(orbit.theta));
    const gy = H(camera.position.x, camera.position.z) + 4;
    if (camera.position.y < gy) camera.position.y = gy;
    camera.lookAt(t);
  }

  function resetView() {
    if (!curMode) return;
    const m = curMode, ct = m.camTarget || m.town;
    orbit.target.set(ct[0], m._townLevel, ct[1]);
    orbit.r = m.camR || 150;
    orbit.theta = 0.9;
    orbit.phi = 0.95;
    sun.position.set(orbit.target.x + 70, orbit.target.y + 120, orbit.target.z + 50);
    sun.target.position.copy(orbit.target);
  }

  function focusPosition(x, y, z) {
    orbit.target.set(x, y ?? H(x, z), z);
    orbit.r = clamp(orbit.r, 55, 110);
  }

  function emitStats() {
    if (onStatsUpdate && curMode) {
      onStatsUpdate({
        status: curMode.status(ctx),
        waiting: victimList.length
      });
    }
  }

  function triggerEarthquake() {
    if (earthquakeState.active) return false;
    // Reset to pristine baseline before launching the 10-second shaking sequence
    resetEarthquakeBuildings(true);
    earthquakeState.active = true;
    earthquakeState.elapsed = 0.0;
    earthquakeState.envelope = 0.0;
    // Reset debris cooldowns on standing buildings
    if (ctx && Array.isArray(ctx.debris)) {
      for (const d of ctx.debris) {
        d.rest = R(0.2, 1.8);
      }
    }
    sharedSim.logSync(`Earthquake triggered: Magnitude M ${earthquakeState.magnitude.toFixed(1)} (10.0s single-burst)`);
    emitStats();
    emitEarthquakeUpdate();
    return true;
  }

  function setEarthquakeMagnitude(val) {
    const next = clamp(Number(val) || 7.0, 1.0, 9.0);
    earthquakeState.magnitude = next;
    earthquakeState.pga = 0.08 * Math.pow(10, 0.28 * (next - 5.0));
    emitStats();
    emitEarthquakeUpdate();
  }

  function getEarthquakeState() {
    return {
      active: earthquakeState.active,
      elapsed: earthquakeState.elapsed,
      duration: EARTHQUAKE_CONFIG.DURATION_SEC,
      remaining: Math.max(0, EARTHQUAKE_CONFIG.DURATION_SEC - earthquakeState.elapsed),
      magnitude: earthquakeState.magnitude,
      envelope: earthquakeState.envelope,
      pga: 0.08 * Math.pow(10, 0.28 * (earthquakeState.magnitude - 5.0)),
      displacement: earthquakeState.displacement,
      status: earthquakeState.statusText,
    };
  }

  function resetEarthquakeBuildings(isPreTrigger = false) {
    if (curModeIndex !== 0) return;
    earthquakeState.active = false;
    earthquakeState.elapsed = 0.0;
    earthquakeState.envelope = 0.0;
    world.position.set(0, 0, 0);

    for (const b of buildings) {
      b.damageState = 'intact';
      b.accumulatedStress = 0;
      b.targetSubsidence = 0;
      b.currentSubsidence = 0;
      b.targetTiltX = 0;
      b.targetTiltZ = 0;
      b.currentTiltX = 0;
      b.currentTiltZ = 0;
      b.tilt = false;
      b.tz = 0;
      b.shearX = 0;
      b.shearZ = 0;
      b.top = b.initTop || (b.level + b.h + b.rh);

      if (b.mesh) {
        b.mesh.visible = true;
        b.mesh.material = b.intactMat;
        b.mesh.position.set(b.initPosX, b.initPosY, b.initPosZ);
        b.mesh.rotation.set(0, 0, 0);
      }
      if (b.roof) {
        b.roof.position.set(0, b.h / 2 + b.rh / 2, 0);
        b.roof.rotation.set(0, 0, 0);
      }
      if (b.rubbleGroup) {
        b.rubbleGroup.visible = false;
      }
    }

    if (ctx && typeof ctx.clearDust === 'function') {
      ctx.clearDust();
    }
    if (ctx && Array.isArray(ctx.debris)) {
      for (const d of ctx.debris) {
        d.m.visible = false;
        d.vx = 0;
        d.vy = 0;
        d.vz = 0;
        d.rest = 999;
      }
    }

    syncWorldToSharedStore(0);
    if (!isPreTrigger) {
      earthquakeState.statusText = 'City restored to pristine condition · Ready';
      sharedSim.logSync('Earthquake simulation: City structures reset to pristine baseline');
      emitStats();
      emitEarthquakeUpdate();
    }
  }

  let curModeIndex = 0;
  function setMode(i) {
    clearMode();
    curModeIndex = i;
    world.position.set(0, 0, 0);
    earthquakeState.active = false;
    if (i === 0) {
      earthquakeState.magnitude = 7.0;
      earthquakeState.pga = 0.08 * Math.pow(10, 0.28 * (7.0 - 5.0));
      earthquakeState.elapsed = EARTHQUAKE_CONFIG.DURATION_SEC;
      earthquakeState.envelope = 0.0;
      earthquakeState.statusText = 'M7.0 event complete - Partial collapse: Upper-story shearing & tilt';
    } else {
      earthquakeState.elapsed = 0.0;
      earthquakeState.envelope = 0.0;
    }
    emitEarthquakeUpdate();
    const m = MODES[i];
    curMode = m;
    ctx = {};
    modeT = 0;
    seed = 1234 + i * 977;
    H = makeH(m);
    scene.background.set(m.sky);
    scene.fog.color.set(m.fog ?? m.sky);
    scene.fog.near = m.fogNear;
    scene.fog.far = m.fogFar;
    hemi.color.set(m.hemiSky ?? 0xffffff);
    hemi.groundColor.set(m.hemiGround ?? 0x555544);
    hemi.intensity = m.hemiI ?? 0.75;
    sun.color.set(m.sun ?? 0xffffff);
    sun.intensity = m.sunI ?? 0.85;
    resetView();
    buildTerrain(m);
    m.build(ctx);
    scatterVictims();
    syncWorldToSharedStore(i);
    emitStats();
  }

  /* ---------- animation loop & lifecycle ---------- */
  let last = performance.now(), hudAcc = 0, rafId = 0, disposed = false;

  const onVisChange = () => {
    if (!document.hidden) last = performance.now();
  };
  document.addEventListener('visibilitychange', onVisChange);

  const onContextLost = e => {
    e.preventDefault();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
  const onContextRestored = () => {
    if (disposed) return;
    last = performance.now();
    if (!rafId) rafId = requestAnimationFrame(frame);
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  function frame(now) {
    if (disposed) return;
    rafId = requestAnimationFrame(frame);
    if (document.hidden || viewMode !== '3d') {
      last = now;
      return;
    }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const simScale = Math.min(4.5, Math.pow(Math.max(1, sharedSim.state.mission.timeScale || 1), 0.38));
    const simDt = dt * simScale;
    if (!paused && curMode) {
      modeT += simDt;
      curMode.update(simDt, modeT, ctx);
      updateAgents(simDt, modeT);
      for (let i = 0; i < parts.length; i++) parts[i].update(simDt);
      for (const s of sirens) {
        s.userData.lights.forEach((l, k) => {
          l.material.emissiveIntensity = (Math.floor(modeT * 6) + k) % 2 ? 2.2 : 0.1;
        });
      }
      for (const h of helis) {
        h.ang += simDt * h.speed;
        const [cx, cz] = h.center();
        h.g.position.set(cx + Math.cos(h.ang) * h.rad, h.alt + Math.sin(modeT) * 0.8, cz + Math.sin(h.ang) * h.rad);
        h.g.rotation.y = -(h.ang + Math.PI / 2);
        h.rotor.rotation.y += simDt * 28;
      }
    }
    // Always update the 3D Swarm C2 visualization from SharedSimulationState
    updateSwarmLayer(dt, modeT);

    if (orbit.auto && ptrs.size === 0) orbit.theta += dt * 0.05;
    updateCamera();
    renderer.render(scene, camera);
    hudAcc += dt;
    if (hudAcc > 0.15) {
      hudAcc = 0;
      emitStats();
      if (curModeIndex === 0) {
        emitEarthquakeUpdate();
      }
    }
  }

  const ctrl3D = {
    getHeightAt: (x, z) => H(x, z),
    setPaused(isPaused) {
      paused = isPaused;
    },
    focusPosition,
    selectObjectAtClientPos: pick3DObject,
    triggerEarthquake,
    setEarthquakeMagnitude,
    getEarthquakeState,
    resetEarthquakeBuildings,
  };
  sharedSim.register3DController(ctrl3D);

  setMode(0);
  rafId = requestAnimationFrame(frame);

  return {
    getInitialAutoRotate: () => orbit.auto,
    setMode,
    triggerEarthquake,
    setEarthquakeMagnitude,
    getEarthquakeState,
    resetEarthquakeBuildings,
    setIntensity(val) {
      INT = val;
      if (curMode) {
        syncWorldToSharedStore(curModeIndex);
        emitStats();
      }
    },
    setShowPeople(visible) {
      showPeople = visible;
      for (const a of agents) a.g.visible = visible;
      for (const v of victimList) v.g.visible = visible;
    },
    setAutoRotate(enabled) {
      orbit.auto = enabled;
    },
    setPaused(isPaused) {
      paused = isPaused;
    },
    setViewMode(dim) {
      viewMode = dim;
      if (dim === '3d') {
        last = performance.now();
        resize();
      }
    },
    focusPosition,
    resetView,
    setCorridorsVisible(_visible) {},
    setApfBubblesVisible(visible) {
      showApfBubbles = Boolean(visible);
      for (const dm of droneMeshes.values()) {
        dm.apfSphere.visible = showApfBubbles;
        dm.apfRing.visible = showApfBubbles;
        dm.downwashCone.visible = showApfBubbles;
      }
    },
    setFanetLinksVisible(visible) {
      showFanetLinks = Boolean(visible);
      for (const l of linkLines) l.visible = showFanetLinks;
      for (const p of packetMeshes) p.visible = showFanetLinks;
    },
    setOctomapVisible(visible) {
      showOctomapVoxels = Boolean(visible);
      octoInstanced.visible = showOctomapVoxels;
    },
    setAiDetectionsVisible(visible) {
      showAiDetections = Boolean(visible);
      hazardGroup.visible = showAiDetections;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      world.position.set(0, 0, 0);
      earthquakeState.active = false;
      earthquakeState.elapsed = 0.0;
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', clearPtrs);
      window.removeEventListener('keydown', onKeyCamera);
      document.removeEventListener('visibilitychange', onVisChange);
      canvas.removeEventListener('pointerdown', onPtrDown);
      canvas.removeEventListener('pointermove', onPtrMove);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('lostpointercapture', up);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      if (resizeObs) resizeObs.disconnect();
      clearMode();
      swarmGroup.clear();
      shared.forEach(s => {
        if (s && typeof s.dispose === 'function') s.dispose();
      });
      renderer.dispose();
    }
  };
}

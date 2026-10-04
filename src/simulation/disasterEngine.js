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
    desc: 'River water rises and falls over the valley town. With the streets under water, unconscious survivors lie on rooftops while others wave to the boats and two rescue helicopters.',
    tip: 'Move to higher ground right away. Never walk or drive through floodwater; even shallow moving water can sweep you off your feet.'
  },
  {
    id: 'wildfire',
    name: 'Wildfire',
    icon: '🔥',
    desc: 'A fire starts in the trees beside the town and spreads tree by tree, leaving charred trees and ash behind, until some buildings catch fire. Smoke drifts downwind while a water helicopter works the fire. People overcome by smoke lie in the town streets.',
    tip: 'Leave early when told to evacuate. If trapped, get to a cleared area, stay low out of the smoke and cover your nose and mouth.'
  },
  {
    id: 'tornado',
    name: 'Tornado',
    icon: '🌪️',
    desc: 'A rotating funnel tracks straight through the town under a dark storm cloud, ripping off roofs, tilting walls and flattening some buildings. People knocked unconscious lie in the town streets.',
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
    desc: 'Boulders and mud break loose from the mountainside and slide down a channel past hillside houses toward the edge of town, damaging the buildings they hit. Unconscious survivors lie in the streets below the slide.',
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
  // Second stream for choices added during the original build, so the town, trees and survivors
  // keep the exact random sequence (and therefore the exact layout) they always had.
  let seed2 = 1;
  function rand2() {
    seed2 |= 0;
    seed2 = (seed2 + 0x6D2B79F5) | 0;
    let t = Math.imul(seed2 ^ (seed2 >>> 15), 1 | seed2);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const R2 = (a, b) => a + rand2() * (b - a);
  const pick2 = a => a[Math.floor(rand2() * a.length)];
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
    beamCyl: new THREE.CylinderGeometry(0.18, 0.55, 1, 10, 1, true)
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
  let curTerrain = null, wreck = null, extraDispose = [];

  function clearMode() {
    if (curMode && curMode.id === 'volcano') {
      console.info('[Volcano] cleanup');
    }
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
            [m.map, m.emissiveMap].forEach(tx => {
              if (tx && !shared.has(tx) && !disposed.has(tx)) {
                disposed.add(tx);
                tx.dispose();
              }
            });
            m.dispose();
          }
        });
      }
    });
    extraDispose.forEach(m => {
      if (!disposed.has(m)) m.dispose();
    });
    extraDispose = [];
    wreck = null;
    curTerrain = null;
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
    curTerrain = mesh;
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
  // add=false makes the same random draws without placing anything (used when a building starts intact).
  function rubble(x, z, w, d, level, add = true) {
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
    const wall = new THREE.Mesh(G.box, BM(pick(BCOL)));
    wall.scale.set(w * 0.8, R(2, 4), 0.6);
    wall.position.set(x, level + 1.5, z - d / 2 + 0.4);
    wall.rotation.z = R(-0.15, 0.15);
    wall.castShadow = true;
    if (!add) {
      inst.dispose();
      return;
    }
    modeGroup.add(inst);
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
        // intact: the building starts standing and is damaged live by the disaster instead.
        const intact = typeof o.intact === 'function' ? o.intact(x, z) : Boolean(o.intact);
        let fate = null;
        if (dmg > 0 && rand() < dmg * 0.3) {
          if (!intact) {
            rubble(x, z, w, d, level);
            buildings.push({ x, z, hw: w / 2, hd: d / 2, top: level + 1.5, rubble: true });
            continue;
          }
          rubble(x, z, w, d, level, false);
          fate = 'collapse';
        }
        const hex = fate ? pick2(BCOL) : pick(BCOL);
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

        // Pre-create hidden rubble group for zero-allocation runtime collapse (uses seed2 stream)
        const rubbleGroup = new THREE.Group();
        rubbleGroup.position.set(x, level, z);
        rubbleGroup.visible = false;

        const rubbleBlocks = new THREE.InstancedMesh(G.box, M(0x8a8278), 14);
        rubbleBlocks.castShadow = true;
        for (let k = 0; k < 14; k++) {
          _dummy.scale.set(R2(0.8, Math.min(w * 0.55, 3.2)), R2(0.4, 1.4), R2(0.8, Math.min(d * 0.55, 3.2)));
          _dummy.position.set(R2(-w * 0.45, w * 0.45), R2(0.2, 1.3), R2(-d * 0.45, d * 0.45));
          _dummy.rotation.set(R2(-0.6, 0.6), R2(0, 3.14), R2(-0.6, 0.6));
          _dummy.updateMatrix();
          rubbleBlocks.setMatrixAt(k, _dummy.matrix);
          _c2.set(pick2([0x9b9389, 0x857c72, 0xb0a698, 0x6f6a64]));
          rubbleBlocks.setColorAt(k, _c2);
        }
        rubbleBlocks.instanceMatrix.needsUpdate = true;
        if (rubbleBlocks.instanceColor) rubbleBlocks.instanceColor.needsUpdate = true;
        rubbleGroup.add(rubbleBlocks);

        // Crumbled perimeter wall remnants
        const brokenWall = new THREE.Mesh(G.box, damagedMat);
        brokenWall.scale.set(w * 0.72, R2(1.6, 3.0), 0.6);
        brokenWall.position.set(0, 1.2, -d * 0.32);
        brokenWall.rotation.set(R2(-0.08, 0.08), R2(-0.2, 0.2), R2(-0.15, 0.15));
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
          fate: fate || 'sway',
          damageState: 'intact',
          accumulatedStress: 0,
          resistance: R2(0.92, 1.15),
          targetSubsidence: 0,
          currentSubsidence: 0,
          targetTiltX: 0,
          targetTiltZ: 0,
          currentTiltX: 0,
          currentTiltZ: 0,
          shearX: 0,
          shearZ: 0,
        };
        if (!fate && rand() < dmg * 0.5) {
          const tz = R(-0.18, 0.18), tx = R(-0.1, 0.1);
          if (intact) {
            b.fate = 'tilt';
            b.fateTilt = [tx, tz];
          } else {
            b.tz = tz;
            b.targetTiltZ = tz;
            b.currentTiltZ = tz;
            mesh.rotation.z = tz;
            mesh.rotation.x = tx;
            b.currentTiltX = tx;
            b.targetTiltX = tx;
            mesh.position.y -= 0.4;
            b.currentSubsidence = 0.4;
            b.targetSubsidence = 0.4;
            b.tilt = true;
          }
        }
        modeGroup.add(mesh);
        buildings.push(b);
      }
    }
  }

  /* ---------- live structural damage (earthquake, wildfire, tornado, tsunami, landslide) ---------- */
  const RUBBLE_COLS = [0x9b9389, 0x857c72, 0xb0a698, 0x6f6a64];
  function makeWreck() {
    const w = { list: [], chunks: [], ci: 0, dusting: [] };
    for (let k = 0; k < 160; k++) {
      const m = new THREE.Mesh(G.box, M(0x8d857b));
      m.castShadow = true;
      m.visible = false;
      modeGroup.add(m);
      w.chunks.push({ m, v: new THREE.Vector3(), spin: new THREE.Vector3(), live: false });
    }
    w.dust = new Particles(380, {
      color: 0xa39582, size: 4.5, opacity: 0.38,
      spawn: (i, p) => {
        if (w.dusting.length) {
          const b = pick(w.dusting), o = b.rig.pivot.position;
          p.set(i, o.x + R(-b.hw, b.hw) * 1.3, o.y + R(0, b.h * 0.6 * b.rig.pivot.scale.y + 1), o.z + R(-b.hd, b.hd) * 1.3,
            R(-1.2, 1.2), R(0.6, 2.2), R(-1.2, 1.2), R(1.5, 3.5));
        } else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.4));
      }
    });
    wreck = w;
    return w;
  }

  // Re-parents a building onto a pivot at its base so it can tilt, be pushed, sink and collapse.
  function rig(b) {
    if (!b.mesh || b.rig) return b;
    const mesh = b.mesh, h = mesh.geometry.parameters.height, pivot = new THREE.Group();
    pivot.position.set(mesh.position.x, mesh.position.y - h / 2, mesh.position.z);
    pivot.add(mesh);
    mesh.position.set(0, h / 2, 0);
    modeGroup.add(pivot);
    b.h = h;
    b.rig = {
      pivot, base: pivot.position.clone(), mat: mesh.material, roofMat: b.roof.material,
      roofPos: b.roof.position.clone(), roofScale: b.roof.scale.clone()
    };
    b.tl = new THREE.Vector2();
    b.tg = new THREE.Vector2();
    b.sway = new THREE.Vector2();
    b.off = new THREE.Vector3();
    b.offGoal = new THREE.Vector3();
    b.state = 'ok';
    b.cp = 0;
    b.crush = 1;
    b.dustT = 0;
    wreck.list.push(b);
    return b;
  }

  function spawnChunk(b, dx = 0, dz = 0) {
    const w = wreck, ch = w.chunks[w.ci++ % w.chunks.length], pv = b.rig.pivot, hNow = b.h * pv.scale.y;
    ch.m.material = rand() < 0.6 ? b.mesh.material : M(pick(RUBBLE_COLS));
    ch.m.scale.set(R(0.5, 1.6), R(0.35, 1.1), R(0.5, 1.6));
    ch.m.position.set(pv.position.x + R(-b.hw, b.hw), pv.position.y + R(0.35, 1) * hNow, pv.position.z + R(-b.hd, b.hd));
    ch.m.rotation.set(R(0, 3), R(0, 3), R(0, 3));
    ch.v.set(R(-1.6, 1.6) + dx * R(0.5, 2.5), R(0, 3), R(-1.6, 1.6) + dz * R(0.5, 2.5));
    ch.spin.set(R(-5, 5), R(-5, 5), R(-5, 5));
    ch.live = true;
    ch.m.visible = true;
  }

  // A few pieces break off (cracking walls, upper floors failing) without a full collapse.
  function crack(b, n, dx = 0, dz = 0) {
    for (let k = 0; k < n; k++) spawnChunk(b, dx, dz);
    b.dustT = Math.max(b.dustT, 2);
  }

  function collapse(b, dx = 0, dz = 0) {
    if (!b.rig || b.state !== 'ok') return;
    b.state = 'collapsing';
    b.cp = 0;
    b.cd = R(1.6, 2.6);
    b.cdx = dx;
    b.cdz = dz;
    b.nCh = 8 + Math.round(b.h * 0.9);
    b.emitted = 0;
    b.dustT = 6;
  }

  function makePile(b) {
    const inst = new THREE.InstancedMesh(G.box, M(0x9b9389), 12);
    inst.castShadow = true;
    for (let k = 0; k < 12; k++) {
      _dummy.scale.set(R(0.8, 2.6), R(0.4, 1.5), R(0.8, 2.6));
      _dummy.position.set(R(-b.hw, b.hw) * 0.9, R(0.2, 1.1), R(-b.hd, b.hd) * 0.9);
      _dummy.rotation.set(R(-0.6, 0.6), R(0, 3), R(-0.6, 0.6));
      _dummy.updateMatrix();
      inst.setMatrixAt(k, _dummy.matrix);
      _c2.set(pick(RUBBLE_COLS));
      inst.setColorAt(k, _c2);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    modeGroup.add(inst);
    return inst;
  }

  function restoreBuilding(b) {
    const r = b.rig;
    if (!r) return;
    b.state = 'ok';
    b.cp = 0;
    b.crush = 1;
    b.dustT = 0;
    b.tl.set(0, 0);
    b.tg.set(0, 0);
    b.sway.set(0, 0);
    b.off.set(0, 0, 0);
    b.offGoal.set(0, 0, 0);
    r.pivot.position.copy(r.base);
    r.pivot.rotation.set(0, 0, 0);
    r.pivot.scale.set(1, 1, 1);
    if (b.pile) b.pile.visible = false;
    if (b.roof.parent !== b.mesh) {
      b.mesh.add(b.roof);
      b.roof.rotation.set(0, 0, 0);
    }
    b.roof.position.copy(r.roofPos);
    b.roof.scale.copy(r.roofScale);
    b.roof.visible = true;
    b.mesh.material = r.mat;
    b.roof.material = r.roofMat;
  }

  function resetWreck() {
    if (!wreck) return;
    wreck.list.forEach(restoreBuilding);
    wreck.chunks.forEach(ch => {
      ch.live = false;
      ch.m.visible = false;
    });
  }

  function updateWreck(dt) {
    const w = wreck, k = 1 - Math.exp(-dt * 3);
    w.dusting.length = 0;
    for (const b of w.list) {
      const r = b.rig, pv = r.pivot;
      b.tl.x += (b.tg.x - b.tl.x) * k;
      b.tl.y += (b.tg.y - b.tl.y) * k;
      b.off.lerp(b.offGoal, k);
      const e = b.state === 'down' ? 1 : b.state === 'collapsing' ? b.cp * b.cp : 0;
      if (b.state === 'collapsing') {
        b.cp = Math.min(1, b.cp + dt / b.cd);
        while (b.emitted < b.cp * b.nCh) {
          b.emitted++;
          spawnChunk(b, b.cdx, b.cdz);
        }
        if (b.cp >= 1) {
          b.state = 'down';
          if (!b.pile) b.pile = makePile(b);
          b.pile.position.set(pv.position.x, r.base.y, pv.position.z);
          b.pile.visible = true;
        }
      }
      const sw = b.state === 'ok' ? 1 : 0, cdx = b.cdx || 0, cdz = b.cdz || 0;
      // rotation.x leans the top towards +z, rotation.z leans it towards -x
      pv.rotation.set(b.tl.x + b.sway.x * sw + cdz * 0.5 * e, 0, b.tl.y + b.sway.y * sw - cdx * 0.5 * e);
      pv.scale.y = Math.max(0.06, b.crush * (1 - 0.9 * e));
      pv.position.set(r.base.x + b.off.x, r.base.y + b.off.y - 0.3 * e, r.base.z + b.off.z);
      if (b.dustT > 0) {
        b.dustT -= dt;
        w.dusting.push(b);
      }
    }
    for (const ch of w.chunks) {
      if (!ch.live) continue;
      const p = ch.m.position;
      ch.v.y -= 24 * dt;
      p.addScaledVector(ch.v, dt);
      ch.m.rotation.x += ch.spin.x * dt;
      ch.m.rotation.y += ch.spin.y * dt;
      ch.m.rotation.z += ch.spin.z * dt;
      const gy = H(p.x, p.z) + 0.06 + ch.m.scale.y * 0.5;
      if (p.y <= gy) {
        p.y = gy;
        ch.live = false;
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

  // Dark crust plates with glowing cracks; used as colour and emissive map and scrolled along each flow.
  let lavaTex = null;
  function lavaFlow(curve, seg, r) {
    if (!lavaTex) {
      const cv = document.createElement('canvas');
      cv.width = 256;
      cv.height = 64;
      const g = cv.getContext('2d');
      g.fillStyle = '#1e0904';
      g.fillRect(0, 0, 256, 64);
      for (let k = 0; k < 26; k++) {
        const x = Math.random() * 256, y = Math.random() * 64, rr = 6 + Math.random() * 14;
        for (const ox of [-256, 0, 256]) {
          const gr = g.createRadialGradient(x + ox, y, 0, x + ox, y, rr);
          gr.addColorStop(0, 'rgba(255,120,20,0.9)');
          gr.addColorStop(1, 'rgba(255,60,0,0)');
          g.fillStyle = gr;
          g.fillRect(x + ox - rr, y - rr, rr * 2, rr * 2);
        }
      }
      for (let k = 0; k < 34; k++) {
        const x0 = Math.random() * 256, y0 = Math.random() * 64, x1 = x0 + 20 + Math.random() * 50, y1 = Math.random() * 64;
        const cx = (x0 + x1) / 2 + (Math.random() - 0.5) * 30, cy = Math.random() * 64;
        for (const ox of [-256, 0, 256]) {
          [[5, '#ff5a0a'], [2.2, '#ffb030'], [0.9, '#fff0a0']].forEach(([lw, cs]) => {
            g.strokeStyle = cs;
            g.lineWidth = lw;
            g.beginPath();
            g.moveTo(x0 + ox, y0);
            g.quadraticCurveTo(cx + ox, cy, x1 + ox, y1);
            g.stroke();
          });
        }
      }
      lavaTex = new THREE.CanvasTexture(cv);
      lavaTex.wrapS = lavaTex.wrapT = THREE.RepeatWrapping;
      shared.add(lavaTex);
    }
    const tex = lavaTex.clone();
    tex.needsUpdate = true;
    tex.repeat.set(Math.max(1, curve.getLength() / 14), 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.4, roughness: 0.9, flatShading: true
    });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, seg, r, 6), mat);
    modeGroup.add(tube);
    return { tube, mat, tex, curve, r, total: tube.geometry.index.count, draw: 0 };
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
      update(dt, _t, c) {
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
      postBuild() {
        // Second rescue helicopter: tighter circle, 18 m higher, flying the opposite way.
        makeHeli(0xff8c1a, () => [0, -4], 22, 56, -0.5);
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
        c.fireX = 0;
        c.fireZ = 0;
        makeHeli(0xe8c020, () => [c.fireX, c.fireZ], 28, 42, 0.4);
        c.flameP = new Particles(900, {
          color: 0xff7a1e, size: 2.6, opacity: 0.9, additive: true,
          spawn: (i, p) => {
            if (c.burning.length) {
              const t = pick(c.burning);
              p.set(i, t.x + R(-1.5, 1.5), t.y + R(1, 5) * t.s, t.z + R(-1.5, 1.5), R(-0.6, 0.6), R(3, 6), R(-0.6, 0.6), R(0.4, 1.1));
            } else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.4));
          }
        });
        c.smokeP = new Particles(520, {
          color: 0x4a4440, size: 8, opacity: 0.33,
          spawn: (i, p) => {
            if (c.burning.length) {
              const t = pick(c.burning);
              p.set(i, t.x, t.y + 6 * t.s, t.z, R(1.5, 3.5), R(4, 7), R(-1, 1), R(5, 9));
            } else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.4));
          }
        });
      },
      postBuild(c) {
        const [tx, tz] = this.town, half = this._townHalf;
        makeWreck();
        buildings.forEach(rig);
        const edge = (x, z) => Math.max(Math.abs(x - tx), Math.abs(z - tz)) - half;
        // Extra trees just outside the camera-facing (south) side of the town so the fire visibly creeps up to it.
        c.trees = c.trees.concat(addTrees(40, (x, z) => {
          const e = edge(x, z);
          return e > 3 && e < 24 && z > tz && okTree(x, z);
        }, undefined, true));
        // Only trees in a ring around the town burn, so the fire stays in view.
        c.fuel = c.trees.filter(tr => edge(tr.x, tr.z) < 34);
        c.fuel.forEach(tr => {
          tr.st = 0;
          tr.nb = c.fuel.filter(o => o !== tr && Math.hypot(o.x - tr.x, o.z - tr.z) < 17);
          tr.yaw = R(0, 6.28);
        });
        // Ignite on the south side, in front of the default camera; the east wind carries it along the town.
        const sx = tx - half * 0.4, sz = tz + half + 10;
        c.start = c.fuel.reduce((a, b) => (Math.hypot(b.x - sx, b.z - sz) < Math.hypot(a.x - sx, a.z - sz) ? b : a));
        c.fireX = c.start.x;
        c.fireZ = c.start.z;
        const standing = buildings.filter(b => b.rig);
        standing.forEach(b => {
          b.fire = 0;
          b.fnb = standing.filter(o => o !== b && Math.hypot(o.x - b.x, o.z - b.z) < 15);
        });
        c.maxBld = Math.ceil(standing.length * 0.4);
        c.emit = [];

        // Flickering flame cones (outer orange, inner yellow), pooled.
        const coneG = new THREE.ConeGeometry(1, 1, 8, 1, true);
        const flameM = o => new THREE.MeshBasicMaterial(Object.assign({
          transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false
        }, o));
        // Normal blending keeps the outer flame orange against the bright smoky sky; the core glows additively.
        const outerM = flameM({ color: 0xff4a0a, opacity: 0.88 });
        const innerM = flameM({ color: 0xffb030, opacity: 0.8, blending: THREE.AdditiveBlending });
        c.flames = [];
        for (let k = 0; k < 80; k++) {
          const g = new THREE.Group(), inner = new THREE.Mesh(coneG, innerM);
          inner.scale.set(0.55, 0.7, 0.55);
          inner.position.y = -0.12;
          g.add(new THREE.Mesh(coneG, outerM), inner);
          g.visible = false;
          modeGroup.add(g);
          c.flames.push(g);
        }
        const CHAR = new THREE.Color(0x1c1714), WALL_CHAR = new THREE.Color(0x2a2420), ROOF_CHAR = new THREE.Color(0x15110f);
        c.CHAR = CHAR;
        c.WALL_CHAR = WALL_CHAR;
        c.ROOF_CHAR = ROOF_CHAR;

        c.ignite = tr => {
          tr.st = 1;
          tr.f = 0;
          if (!tr.cm) {
            tr.m0 = tr.crown.material;
            tr.cm = tr.m0.clone();
            tr.c0 = tr.m0.color.clone();
            extraDispose.push(tr.cm);
            tr.ash = new THREE.Mesh(G.blob, M(0x45403c));
            tr.ember = new THREE.Mesh(G.blob, M(0xff5a10, { emissive: 0xff3a00, emissiveIntensity: 1.6 }));
            tr.ash.position.set(tr.x, tr.y + 0.05, tr.z);
            tr.ember.position.set(tr.x, tr.y + 0.25, tr.z);
            modeGroup.add(tr.ash, tr.ember);
          }
          tr.ash.visible = tr.ember.visible = false;
          tr.cm.color.copy(tr.c0);
          tr.crown.material = tr.cm;
          tr.g.rotation.order = 'YXZ';
          tr.g.rotation.set(0, tr.yaw, 0);
        };
        c.igniteB = b => {
          b.fire = 0.001;
          c.bldCount++;
          if (!b.fm) {
            b.fm = b.rig.mat.clone();
            b.rm = b.rig.roofMat.clone();
            extraDispose.push(b.fm, b.rm);
          }
          b.fm.color.copy(b.rig.mat.color);
          b.rm.color.copy(b.rig.roofMat.color);
          b.mesh.material = b.fm;
          b.roof.material = b.rm;
          const side = rand() < 0.5 ? -1 : 1;
          b.spots = [
            { x: R(-b.hw, b.hw) * 0.6, z: R(-b.hd, b.hd) * 0.6, roof: true },
            { x: R(-b.hw, b.hw) * 0.6, z: R(-b.hd, b.hd) * 0.6, roof: true },
            rand() < 0.5
              ? { x: side * (b.hw + 0.3), z: R(-b.hd, b.hd) * 0.6, y: R(0.25, 0.7) * b.h }
              : { x: R(-b.hw, b.hw) * 0.6, z: side * (b.hd + 0.3), y: R(0.25, 0.7) * b.h }
          ];
        };
        c.resetFire = () => {
          c.ft = 0;
          c.idle = 0;
          c.bldCount = 0;
          for (const tr of c.fuel) {
            if (!tr.st) continue;
            tr.st = 0;
            tr.g.visible = true;
            tr.g.rotation.set(0, 0, 0);
            tr.g.scale.setScalar(tr.s);
            tr.crown.material = tr.m0;
            tr.trunk.material = c.mats.tk;
            tr.crown.scale.set(1, 1, 1);
            tr.ash.visible = tr.ember.visible = false;
          }
          for (const b of standing) {
            if (!b.fire) continue;
            b.fire = 0;
            b.mesh.material = b.rig.mat;
            b.roof.material = b.rig.roofMat;
          }
          c.ignite(c.start);
        };

        // Flames, embers and smoke all come from the live list of burning trees and buildings.
        const em = () => {
          const e = c.emit.length ? pick(c.emit) : null;
          return e && rand() < 0.25 + e.I ? e : null;
        };
        c.flameP.o.spawn = (i, p) => {
          const e = em();
          if (e) p.set(i, e.x + R(-e.rx, e.rx) * 0.8, e.y + R(0, e.ry), e.z + R(-e.rz, e.rz) * 0.8, R(-0.6, 0.6), R(3, 6), R(-0.6, 0.6), R(0.4, 1.1));
          else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.4));
        };
        c.smokeP.o.spawn = (i, p) => {
          const e = em();
          if (e) p.set(i, e.x + R(-1, 1), e.top, e.z + R(-1, 1), R(1.5, 3.5), R(4, 7), R(-1, 1), R(5, 9));
          else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.4));
        };
        c.smokeP.mat.size = 11;
        c.smokeP.mat.opacity = 0.42;
        c.smokeP.mat.color.set(0x3c3734);
        new Particles(420, {
          color: 0x2c2826, size: 15, opacity: 0.3,
          spawn: (i, p) => {
            const e = em();
            if (e) p.set(i, e.x + R(-e.rx, e.rx), e.top + R(0, 2), e.z + R(-e.rz, e.rz), R(1, 3), R(3, 6), R(-0.8, 0.8), R(6, 11));
            else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.4));
          },
          step: (i, dt, p) => {
            p.vel[i * 3] += dt * 0.6;
            p.vel[i * 3 + 1] *= 0.995;
          }
        });
        new Particles(420, {
          color: 0xffa040, size: 0.9, opacity: 1, additive: true,
          spawn: (i, p) => {
            const e = em();
            if (e) p.set(i, e.x + R(-e.rx, e.rx), e.y + R(0, e.ry), e.z + R(-e.rz, e.rz), R(-1, 1) + 1.2, R(2, 6), R(-1, 1), R(0.8, 2.4));
            else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.4));
          },
          step: (i, dt, p) => {
            const k = i * 3;
            p.vel[k] += Math.sin(modeT * 3 + i) * dt * 4;
            p.vel[k + 2] += Math.cos(modeT * 2.3 + i * 1.7) * dt * 3;
            p.vel[k + 1] -= dt * 0.8;
          }
        });
      },
      update(dt, t, c) {
        if (c.ft === undefined || c.ft > 115 || c.idle > 7) c.resetFire();
        const rate = 0.6 + 0.4 * INT, bt = c.mats.bt;
        c.ft += dt;
        c.emit.length = 0;
        let fu = 0, nTrees = 0, nBld = 0, sx = 0, sz = 0;
        const flame = (x, y, z, w, h) => {
          const f = c.flames[fu++];
          if (!f) return;
          f.visible = true;
          f.position.set(x, y + h / 2, z);
          f.scale.set(w, h, w);
          f.rotation.y = t * 2 + x;
        };
        for (const tr of c.fuel) {
          if (!tr.st) continue;
          tr.f += dt * rate;
          const f = tr.f, s = tr.s, fl = 0.85 + Math.sin(t * 17 + tr.x * 3) * 0.12 + Math.sin(t * 29 + tr.z) * 0.08;
          if (tr.st === 1) {
            // Starts as a small flame low on the tree, grows, then dies down as the crown chars and shrinks.
            nTrees++;
            const I = smooth(0, 3, f) * (1 - 0.55 * smooth(7, 10, f));
            tr.cm.color.copy(tr.c0).lerp(c.CHAR, smooth(1.5, 8, f));
            const sh = 1 - 0.45 * smooth(4, 10, f);
            tr.crown.scale.set(sh, sh * (1 + Math.sin(t * 12 + tr.x) * 0.04), sh);
            if (f > 2.5) tr.trunk.material = bt;
            const base = tr.y + 1.6 * s, w = (0.45 + I * 1.7) * s * fl, h = (0.9 + I * 6) * s * fl;
            flame(tr.x, base, tr.z, w, h);
            if (I > 0.5) flame(tr.x + Math.sin(t * 3 + tr.z) * 0.7 * s, base + 0.6 * s, tr.z + Math.cos(t * 2.6 + tr.x) * 0.7 * s, w * 0.6, h * 0.75);
            c.emit.push({ x: tr.x, y: base, z: tr.z, rx: 1.4 * s, ry: 4 * s * I + 0.5, rz: 1.4 * s, top: tr.y + (3 + 4 * I) * s, I });
            sx += tr.x;
            sz += tr.z;
            if (I > 0.45) {
              // The wind drives the fire towards the town: neighbours in that direction catch first.
              const [tx, tz] = this.town, td = Math.hypot(tx - tr.x, tz - tr.z) || 1;
              for (const nb of tr.nb) {
                if (nb.st) continue;
                const d = Math.hypot(nb.x - tr.x, nb.z - tr.z);
                const wind = 0.35 + Math.max(0, ((nb.x - tr.x) * (tx - tr.x) + (nb.z - tr.z) * (tz - tr.z)) / (d * td)) * 1.6;
                if (rand() < dt * 0.6 * INT * wind * (1 - d / 18) * I) c.ignite(nb);
              }
              // Wind-blown embers occasionally start a spot fire further towards the town.
              if (rand() < dt * 0.06 * INT * I) {
                const spot = c.fuel.find(o => !o.st && Math.hypot(o.x - tr.x, o.z - tr.z) < 26 && Math.hypot(tx - o.x, tz - o.z) < td - 4);
                if (spot) c.ignite(spot);
              }
            }
            if (I > 0.55 && c.bldCount < c.maxBld) {
              for (const b of buildings) {
                if (!b.rig || b.fire) continue;
                const ex = Math.max(Math.abs(tr.x - b.x) - b.hw, Math.abs(tr.z - b.z) - b.hd);
                if (ex < 11 && rand() < dt * 0.35 * INT * (1 - ex / 12)) c.igniteB(b);
              }
            }
            if (f > 10) {
              tr.st = 2;
              tr.ff = 0;
            }
          } else if (tr.st === 2) {
            // The charred tree topples, then crumbles into an ash pile.
            nTrees++;
            tr.ff += dt * rate;
            const e = Math.min(1, tr.ff / 1.5), k = smooth(1.5, 3.5, tr.ff);
            tr.g.rotation.z = (Math.PI / 2 - 0.12) * e * e;
            tr.g.scale.setScalar(s * (1 - 0.85 * k));
            tr.ash.visible = true;
            tr.ash.scale.set(1.7 * s * (0.2 + 0.8 * k), 0.45 * s * (0.2 + 0.8 * k), 1.7 * s * (0.2 + 0.8 * k));
            flame(tr.x, tr.y, tr.z, 0.9 * s * fl, 1.8 * s * fl * (1 - 0.5 * k));
            c.emit.push({ x: tr.x, y: tr.y, z: tr.z, rx: 1.5 * s, ry: 1.5, rz: 1.5 * s, top: tr.y + 2, I: 0.4 });
            if (tr.ff > 3.5) {
              tr.st = 3;
              tr.ef = 0;
              tr.g.visible = false;
            }
          } else {
            // Glowing embers in the ash slowly die out.
            tr.ef += dt;
            const k = 1 - smooth(4, 22, tr.ef);
            tr.ember.visible = k > 0.02;
            if (tr.ember.visible) {
              const g = k * (0.9 + 0.1 * Math.sin(t * 9 + tr.x));
              tr.ember.scale.set(1.1 * s * g, 0.22 * s, 1.1 * s * g);
              if (k > 0.3) c.emit.push({ x: tr.x, y: tr.y + 0.3, z: tr.z, rx: s, ry: 0.6, rz: s, top: tr.y + 1, I: 0.12 * k });
            }
          }
        }
        for (const b of buildings) {
          if (!b.fire) continue;
          b.fire += dt * rate;
          const I = smooth(0, 4, b.fire) * (1 - 0.6 * smooth(30, 45, b.fire)), dark = smooth(2, 28, b.fire);
          if (b.fire < 45) nBld++;
          b.fm.color.copy(b.rig.mat.color).lerp(c.WALL_CHAR, dark * 0.85);
          b.rm.color.copy(b.rig.roofMat.color).lerp(c.ROOF_CHAR, dark);
          const base = b.rig.base.y;
          b.spots.forEach((sp, k) => {
            const fl = 0.85 + Math.sin(t * 15 + k * 2 + b.x) * 0.12 + Math.sin(t * 27 + b.z + k) * 0.08;
            if (sp.roof) flame(b.x + sp.x, b.top - 0.2, b.z + sp.z, (1 + I * 2.2) * fl, (1.5 + I * 6) * fl);
            else flame(b.x + sp.x, base + sp.y, b.z + sp.z, (0.6 + I * 1.2) * fl, (1 + I * 3.5) * fl);
          });
          c.emit.push({ x: b.x, y: b.top - 1, z: b.z, rx: b.hw, ry: 2, rz: b.hd, top: b.top + 1, I });
          sx += b.x;
          sz += b.z;
          if (I > 0.7 && c.bldCount < c.maxBld) {
            for (const nb of b.fnb) if (!nb.fire && rand() < dt * 0.035 * INT) c.igniteB(nb);
          }
        }
        for (let k = fu; k < c.flames.length; k++) c.flames[k].visible = false;
        const n = nTrees + nBld;
        if (n) {
          const kk = 1 - Math.exp(-dt * 0.8);
          c.fireX += (sx / n - c.fireX) * kk;
          c.fireZ += (sz / n - c.fireZ) * kk;
        }
        c.idle = n === 0 && c.ft > 3 ? c.idle + dt : 0;
        c.nTrees = nTrees;
        c.nBld = nBld;
      },
      status(c) {
        const b = c.nBld || 0;
        return `${c.nTrees || 0} trees burning${b ? `, ${b} building${b > 1 ? 's' : ''} on fire` : ''}`;
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
      postBuild(c) {
        makeWreck();
        buildings.forEach(rig);
        // Closed loop that crosses the whole town corner to corner, twice (an X through the centre).
        const [tx, tz] = this.town, V = (x, z) => new THREE.Vector3(tx + x, 0, tz + z);
        c.path = new THREE.CatmullRomCurve3([V(-85, -80), V(-3, -2), V(80, 82), V(86, -76), V(3, 2), V(-82, 84)], true, 'centripetal');
        c.loop = -1;
        c.flying = [];
        c.pt = new THREE.Vector3();
      },
      update(dt, t, c) {
        const T = t * INT, u = T * 0.014, loop = Math.floor(u);
        if (loop !== c.loop) {
          if (c.loop >= 0) {
            // New pass: rebuild the town and stand the trees back up.
            resetWreck();
            c.flying.length = 0;
            buildings.forEach(b => {
              b.thit = false;
              b.tcol = 0;
            });
            c.trees.forEach(tr => {
              tr.hit = false;
              tr.g.rotation.z = 0;
            });
          }
          c.loop = loop;
        }
        c.path.getPointAt(u - loop, c.pt);
        c.cx = c.pt.x + Math.sin(T * 0.9) * 2.5;
        c.cz = c.pt.z + Math.cos(T * 0.7) * 2.5;
        c.gy = H(c.cx, c.cz);
        c.cloud.position.x = c.cx * 0.5;
        c.cloud.position.z = c.cz * 0.5;
        // Seen from above, the storm cloud thins out so it never hides the town and the funnel's path.
        const cm = c.cloud.material, above = camera.position.y > c.cloud.position.y + 4;
        cm.opacity += ((above ? 0.25 : 0.92) - cm.opacity) * Math.min(1, dt * 4);
        cm.depthWrite = cm.opacity > 0.8;
        c.wall.position.set(c.cx, c.gy + 56, c.cz);
        for (const d of c.debris) {
          d.a += dt * d.s * INT;
          d.m.position.set(c.cx + Math.cos(d.a) * d.r, c.gy + d.h + Math.sin(t + d.r) * 2, c.cz + Math.sin(d.a) * d.r);
          d.m.rotation.x += dt * 5;
          d.m.rotation.y += dt * 4;
        }
        for (const b of buildings) {
          if (!b.rig) continue;
          const dx = b.x - c.cx, dz = b.z - c.cz, d = Math.hypot(dx, dz) || 1;
          if (!b.thit && d < 13 + Math.max(b.hw, b.hd) * 0.5) {
            b.thit = true;
            // Roof ripped off and pulled into the debris cloud.
            modeGroup.attach(b.roof);
            c.flying.push({ m: b.roof, a: Math.atan2(dz, dx), r: Math.max(3, d), h: b.top - c.gy, t: 0, life: R(1.6, 3.2), mode: 0, v: new THREE.Vector3(), spin: R(4, 9) });
            // Walls lean with the rotating wind (counter-clockwise) and slightly outward.
            const nx = dx / d, nz = dz / d, wx = -nz * 0.7 + nx * 0.3, wz = nx * 0.7 + nz * 0.3, mag = R(0.1, 0.26) * Math.min(1.3, INT);
            b.tg.set(wz * mag, -wx * mag);
            b.tdir = [wx, wz];
            crack(b, 3, wx, wz);
            if (d < 9 || rand() < 0.3 * INT) b.tcol = t + R(0.3, 1.2);
          }
          if (b.tcol && t >= b.tcol) {
            collapse(b, b.tdir[0], b.tdir[1]);
            b.tcol = 0;
          }
        }
        for (const f of c.flying) {
          const p = f.m.position;
          f.t += dt;
          if (f.mode === 0) {
            const w = Math.max(1.5, 5 - f.r * 0.12) * INT;
            f.a += dt * w;
            f.r += dt * 1.5;
            f.h = Math.min(30, f.h + dt * 9);
            p.set(c.cx + Math.cos(f.a) * f.r, c.gy + f.h, c.cz + Math.sin(f.a) * f.r);
            f.m.rotation.x += dt * f.spin;
            f.m.rotation.y += dt * f.spin * 0.7;
            if (f.t > f.life) {
              const sp = Math.min(22, w * f.r);
              f.mode = 1;
              f.v.set(-Math.sin(f.a) * sp, R(2, 6), Math.cos(f.a) * sp);
            }
          } else if (f.mode === 1) {
            f.v.y -= 22 * dt;
            p.addScaledVector(f.v, dt);
            f.m.rotation.x += dt * f.spin;
            f.m.rotation.z += dt * f.spin * 0.5;
            const gy = H(p.x, p.z) + 0.3;
            if (p.y <= gy) {
              p.y = gy;
              f.mode = 2;
              f.m.rotation.set(R(-0.3, 0.3), f.m.rotation.y, R(-0.3, 0.3));
            }
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
      sky: 0x7d716b, fogNear: 115, fogFar: 420, hemiI: 0.62, sun: 0xffd2b0, sunI: 0.72, hemiGround: 0x3a302c,
      town: [44, 38], townR: 42, safe: [96, -36], camR: 168, camTarget: [-2, -2],
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

        const top = H(-50, -50);
        const rim = top + 5.8;
        const poolY = rim - 1.15;
        c.samplePt = new THREE.Vector3();
        c.flowOffset = 0;

        // 1. Animated Crater Lava Pool + Convective Core + Bubbling Magma Mounds
        const poolMat = new THREE.MeshStandardMaterial({
          color: 0xff3b00,
          emissive: 0xff4500,
          emissiveIntensity: 1.85,
          roughness: 0.28,
          flatShading: true
        });
        const pool = new THREE.Mesh(new THREE.CircleGeometry(7.2, 28), poolMat);
        pool.rotation.x = -Math.PI / 2;
        pool.position.set(-50, poolY, -50);
        modeGroup.add(pool);

        const coreMat = new THREE.MeshStandardMaterial({
          color: 0xffc83b,
          emissive: 0xff8800,
          emissiveIntensity: 2.35,
          roughness: 0.2,
          flatShading: true
        });
        const poolCore = new THREE.Mesh(new THREE.CircleGeometry(4.4, 24), coreMat);
        poolCore.rotation.x = -Math.PI / 2;
        poolCore.position.set(-50, poolY + 0.12, -50);
        modeGroup.add(poolCore);

        const bubbleMat = new THREE.MeshStandardMaterial({
          color: 0xffb020,
          emissive: 0xff5500,
          emissiveIntensity: 2.2,
          roughness: 0.25,
          flatShading: true
        });
        c.poolBubbles = [];
        for (let k = 0; k < 6; k++) {
          const bm = new THREE.Mesh(G.blob, bubbleMat);
          const ang = (k / 6) * Math.PI * 2 + R(-0.2, 0.2);
          const rad = R(1.0, 4.6);
          const bx = -50 + Math.cos(ang) * rad;
          const bz = -50 + Math.sin(ang) * rad;
          bm.position.set(bx, poolY + 0.15, bz);
          bm.scale.set(1.2, 0.5, 1.2);
          modeGroup.add(bm);
          c.poolBubbles.push({ m: bm, bx, bz, phase: k * 1.1 + rand() * 2, spd: R(2.2, 3.6) });
        }
        c.pool = pool;
        c.poolMat = poolMat;
        c.poolCore = poolCore;
        c.coreMat = coreMat;
        c.poolY = poolY;

        // 2. Five Downhill Lava Flows (CatmullRomCurve3 starting over the outer crater rim)
        c.flows = [];
        [0.35, 0.8, 1.25, 2.6, -1].forEach((a, fi) => {
          const pts = [
            new THREE.Vector3(-50 + Math.cos(a) * 5.8, poolY + 0.08, -50 + Math.sin(a) * 5.8),
            new THREE.Vector3(
              -50 + Math.cos(a) * 8.2,
              H(-50 + Math.cos(a) * 8.2, -50 + Math.sin(a) * 8.2) + 0.72,
              -50 + Math.sin(a) * 8.2
            )
          ];
          let x = -50 + Math.cos(a) * 10.4, z = -50 + Math.sin(a) * 10.4;
          for (let k = 0; k < 64; k++) {
            const y = H(x, z);
            pts.push(new THREE.Vector3(x, y + 0.65, z));
            const gx = (H(x + 0.8, z) - H(x - 0.8, z)) / 1.6;
            const gz = (H(x, z + 0.8) - H(x, z - 0.8)) / 1.6;
            const g = Math.hypot(gx, gz);
            if (g < 0.014 || Math.max(Math.abs(x - 44), Math.abs(z - 38)) < 43) break;
            x -= (gx / g) * 1.45 + R(-0.22, 0.22);
            z -= (gz / g) * 1.45 + R(-0.22, 0.22);
          }
          if (pts.length < 4) return;
          const curve = new THREE.CatmullRomCurve3(pts), seg = pts.length * 2;
          const f = lavaFlow(curve, seg, 1.55);
          f.delay = fi * 0.23;
          f.draw = 0.85;
          c.flows.push(f);
        });

        // Animated hot-spot magma surges traveling downhill along the 5 CatmullRomCurve3 lava tubes
        const surgesPerFlow = 9;
        const totalSurges = c.flows.length * surgesPerFlow;
        const surgeMat = new THREE.MeshStandardMaterial({
          color: 0xffd24c,
          emissive: 0xff6e00,
          emissiveIntensity: 2.4,
          roughness: 0.2,
          flatShading: true
        });
        c.flowHotspots = new THREE.InstancedMesh(G.blob, surgeMat, Math.max(1, totalSurges));
        c.flowHotspots.frustumCulled = false;
        c.surgesPerFlow = surgesPerFlow;
        c.surgeMat = surgeMat;
        modeGroup.add(c.flowHotspots);

        // Glowing lava embers/sparks rising along the 5 downhill lava flows
        c.flowSparks = new Particles(320, {
          color: 0xff8c24,
          size: 3.8,
          opacity: 0.85,
          additive: true,
          prewarm: true,
          spawn: (i, p) => {
            if (!c.flows.length) {
              p.set(i, -50, rim, -50, 0, 2, 0, 1);
              return;
            }
            const f = pick(c.flows);
            const u = rand() * (f.draw || 0.85);
            f.curve.getPointAt(u, c.samplePt);
            p.set(
              i,
              c.samplePt.x + R(-1.2, 1.2),
              c.samplePt.y + R(0.3, 1.2),
              c.samplePt.z + R(-1.2, 1.2),
              R(-0.7, 0.7),
              R(2.2, 5.2) * (0.75 + 0.35 * INT),
              R(-0.7, 0.7),
              R(0.8, 2.0)
            );
          }
        });

        // 3. Dynamic Crater PointLight Illumination
        ptLight.position.set(-50, rim + 9, -50);
        ptLight.distance = 165;
        ptLight.decay = 1.0;
        ptLight.intensity = 3.2 * INT;
        c.light = ptLight;

        // 4. Two-Stage Eruption Column: Incandescent Fire Jet + Towering Dark Ash Plume
        c.plumeFire = new Particles(420, {
          color: 0xff6e1a,
          size: 7.5,
          opacity: 0.88,
          additive: true,
          prewarm: true,
          spawn: (i, p, init) => {
            const vy = R(14, 26) * (0.65 + 0.45 * INT);
            const vx = R(-3.8, 3.8) * (0.7 + 0.35 * INT);
            const vz = R(-3.8, 3.8) * (0.7 + 0.35 * INT);
            const life = R(1.0, 2.2);
            const age = init ? rand() * life : 0;
            p.set(
              i,
              -50 + R(-3.4, 3.4) + vx * age,
              poolY + 0.5 + vy * age,
              -50 + R(-3.4, 3.4) + vz * age,
              vx,
              vy,
              vz,
              Math.max(0.1, life - age)
            );
          },
          step: (i, dt, p) => {
            const k = i * 3;
            p.vel[k] += dt * 1.6 * INT;
            p.vel[k + 1] -= dt * 3.5;
          }
        });

        c.plumeAsh = new Particles(1600, {
          color: 0x26211f,
          size: 11.5,
          opacity: 0.72,
          prewarm: true,
          spawn: (i, p, init) => {
            const vy = R(11, 20) * (0.65 + 0.45 * INT);
            const ang = rand() * Math.PI * 2;
            const radSpd = R(0.8, 3.8) * (0.7 + 0.4 * INT);
            const vx = Math.cos(ang) * radSpd;
            const vz = Math.sin(ang) * radSpd;
            const life = R(5.5, 9.5) * (0.75 + 0.3 * INT);
            const age = init ? rand() * life : 0;
            const windX = 1.2 * INT * age * age * 0.16;
            const windZ = 0.5 * INT * age * age * 0.16;
            p.set(
              i,
              -50 + R(-3.8, 3.8) + vx * age + windX,
              rim + vy * age * 0.88,
              -50 + R(-3.8, 3.8) + vz * age + windZ,
              vx + 1.8 * INT * (age / life),
              vy * Math.max(0.55, 1 - age * 0.04),
              vz + 0.7 * INT * (age / life),
              Math.max(0.15, life - age)
            );
          },
          step: (i, dt, p) => {
            const k = i * 3;
            const hAboveRim = Math.max(0, p.pos[k + 1] - rim);
            const umbrella = smooth(18, 65, hAboveRim) * 1.8 * INT;
            p.vel[k] += dt * (2.2 * INT + (p.pos[k] + 50) * 0.03 * umbrella);
            p.vel[k + 2] += dt * (0.85 * INT + (p.pos[k + 2] + 50) * 0.03 * umbrella);
            p.vel[k + 1] *= Math.max(0.92, 1 - dt * 0.07);
          }
        });

        // 5. Ballistic Lava Bombs
        const bombMat = new THREE.MeshStandardMaterial({
          color: 0xff9a22,
          emissive: 0xff3b00,
          emissiveIntensity: 2.3,
          roughness: 0.22,
          flatShading: true
        });
        c.bombMat = bombMat;
        c.bombs = [];
        c.launchBomb = (b, prewarmFrac = 0) => {
          const ang = rand() * Math.PI * 2;
          const hSpd = R(6.5, 19.5) * (0.65 + 0.45 * INT);
          const vy0 = R(22, 36) * (0.65 + 0.45 * INT);
          const vx = Math.cos(ang) * hSpd;
          const vz = Math.sin(ang) * hSpd;
          const sx = -50 + Math.cos(ang) * R(1.0, 4.2);
          const sz = -50 + Math.sin(ang) * R(1.0, 4.2);
          const sy = rim + 0.8;
          const tArc = prewarmFrac * R(0.6, 2.2);
          b.m.position.set(sx + vx * tArc, sy + vy0 * tArc - 0.5 * 20 * tArc * tArc, sz + vz * tArc);
          b.v.set(vx, vy0 - 20 * tArc, vz);
          b.baseScale = R(0.85, 1.65);
          b.m.scale.setScalar(b.baseScale * (0.85 + 0.25 * INT));
        };
        for (let k = 0; k < 22; k++) {
          const m = new THREE.Mesh(G.blob, bombMat);
          modeGroup.add(m);
          const b = { m, v: new THREE.Vector3(), rim, baseScale: 1.1 };
          c.launchBomb(b, (k + 0.3) / 22);
          c.bombs.push(b);
        }

        console.info('[Volcano] initialized');
        console.info(`[Volcano] lava flows: ${c.flows.length}`);
        console.info('[Volcano] ash system initialized');
        console.info('[Volcano] lava bomb system initialized');
        console.info('[Volcano] eruption update active');
      },
      postBuild(c) {
        const [tx, tz] = this.town, half = this._townHalf, L = this._townLevel, rim = H(-50, -50) + 6;
        // An extra flow steered towards the town's south-west corner, stopping just outside it.
        const gx0 = tx - half - 6, gz0 = tz - half - 6, a0 = Math.atan2(gz0 + 50, gx0 + 50);
        let x = -50 + Math.cos(a0) * 6.5, z = -50 + Math.sin(a0) * 6.5;
        const pts = [];
        for (let k = 0; k < 220; k++) {
          pts.push(new THREE.Vector3(x, H(x, z) + 0.5, z));
          const ex = gx0 - x, ez = gz0 - z, ed = Math.hypot(ex, ez);
          if (ed < 4) break;
          const gx = (H(x + 0.8, z) - H(x - 0.8, z)) / 1.6, gz = (H(x, z + 0.8) - H(x, z - 0.8)) / 1.6, g = Math.hypot(gx, gz) || 1;
          let dx = 0.6 * ex / ed - 0.4 * gx / g, dz = 0.6 * ez / ed - 0.4 * gz / g;
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl;
          dz /= dl;
          x += dx * 1.4 + R(-0.25, 0.25);
          z += dz * 1.4 + R(-0.25, 0.25);
        }
        c.townFlow = lavaFlow(new THREE.CatmullRomCurve3(pts), pts.length * 2, 1.8);
        c.townFlow.town = true;
        // Glowing advancing front on every flow.
        const frontM = M(0xff7a20, { emissive: 0xff5000, emissiveIntensity: 1.9 });
        [...c.flows, c.townFlow].forEach(f => {
          f.front = new THREE.Mesh(G.blob, frontM);
          modeGroup.add(f.front);
        });
        new Particles(180, {
          color: 0xff8a2a, size: 1.3, opacity: 0.95, additive: true,
          spawn: (i, p) => {
            const f = pick([...c.flows, c.townFlow]);
            const o = f.front.position;
            if (f.draw > 0.02) p.set(i, o.x + R(-1.5, 1.5), o.y + R(0, 1), o.z + R(-1.5, 1.5), R(-1, 1), R(1, 3.5), R(-1, 1), R(0.4, 1.2));
            else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.3));
          }
        });

        // Thick dark ash column that bends towards the town once it is high up.
        new Particles(1100, {
          color: 0x2a2624, size: 13, opacity: 0.45, prewarm: true,
          spawn: (i, p) => p.set(i, -50 + R(-4, 4), rim + R(0, 4), -50 + R(-4, 4), R(-2, 2), R(14, 22), R(-2, 2), R(7, 12)),
          step: (i, dt, p) => {
            const k = i * 3;
            p.vel[k + 1] *= 0.993;
            // High up, the plume is carried towards the town, then spreads out and hangs over it.
            if (p.pos[k + 1] - rim > 28 && p.pos[k] < tx && p.pos[k + 2] < tz) {
              p.vel[k] += dt * 1.6 * INT;
              p.vel[k + 2] += dt * 1.4 * INT;
            } else if (p.pos[k] >= tx || p.pos[k + 2] >= tz) {
              p.vel[k] *= 0.97;
              p.vel[k + 2] *= 0.97;
            }
          }
        });
        // Ash falling over the town and the survivors.
        const span = half * 2 + 50, ax = tx - 16, az = tz - 14;
        c.ashFall = new Particles(1500, {
          color: 0x46423f, size: 1.0, opacity: 0,
          spawn: (i, p, init) => p.set(i, ax + R(-span / 2, span / 2), init ? R(L, L + 55) : L + R(45, 60), az + R(-span / 2, span / 2), 0, 0, 0, 1e9),
          step: (i, _dt, p) => {
            const k = i * 3;
            p.vel[k] = 1.6 * INT + Math.sin(modeT * 1.1 + i) * 0.8;
            p.vel[k + 1] = -(3.2 + (i % 7) * 0.35) * (0.7 + 0.3 * INT);
            p.vel[k + 2] = 1.2 * INT + Math.cos(modeT * 0.9 + i) * 0.6;
            if (p.pos[k + 1] < L) p.life[i] = 0;
          }
        });
        // Ground near the town greys over as ash settles: terrain colours, town ground and roofs.
        const pos = curTerrain.geometry.attributes.position, col = curTerrain.geometry.attributes.color;
        c.ash = { idx: [], w: [], base: [], acc: 0, col: new THREE.Color(0x77736f) };
        for (let i = 0; i < pos.count; i++) {
          const e = Math.max(Math.abs(pos.getX(i) - tx), Math.abs(pos.getZ(i) - tz)) - half, w = smooth(36, 0, e);
          if (w <= 0) continue;
          c.ash.idx.push(i);
          c.ash.w.push(w);
          c.ash.base.push(new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)));
        }
        c.ashMat = new THREE.MeshStandardMaterial({
          color: 0x9a9692, transparent: true, opacity: 0, roughness: 1, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        });
        const pg = new THREE.PlaneGeometry(half * 2, half * 2);
        pg.rotateX(-Math.PI / 2);
        const layer = new THREE.Mesh(pg, c.ashMat);
        layer.position.set(tx, L + 0.12, tz);
        modeGroup.add(layer);
        buildings.forEach(b => {
          if (!b.mesh) return;
          const cap = new THREE.Mesh(G.box, c.ashMat);
          cap.scale.set(b.hw * 2 + 0.45, 0.05, b.hd * 2 + 0.45);
          cap.position.set(b.x, b.top + 0.03, b.z);
          modeGroup.add(cap);
        });
      },
      update(dt, t, c) {
        // 1. Animate Crater Lava Pool & Bubbling Magma Mounds
        const poolPulse = 1 + Math.sin(t * 3.2 * INT) * 0.06 * INT;
        c.pool.scale.setScalar(poolPulse);
        c.pool.rotation.z = t * 0.22 * INT;
        c.poolMat.emissiveIntensity = (1.55 + Math.sin(t * 4.5) * 0.4) * (0.7 + 0.45 * INT);

        const corePulse = 1 + Math.cos(t * 4.8 * INT) * 0.1 * INT;
        c.poolCore.scale.setScalar(corePulse);
        c.poolCore.rotation.z = -t * 0.38 * INT;
        c.coreMat.emissiveIntensity = (2.0 + Math.sin(t * 6.2 + 1) * 0.55) * (0.75 + 0.45 * INT);

        for (const pb of c.poolBubbles) {
          const w = 0.5 + 0.5 * Math.sin(t * pb.spd * INT + pb.phase);
          pb.m.scale.set((0.8 + w * 1.1) * (0.8 + 0.25 * INT), (0.35 + w * 1.25) * INT, (0.8 + w * 1.1) * (0.8 + 0.25 * INT));
          pb.m.position.y = c.poolY + 0.1 + w * 0.65 * INT;
        }

        // 2. Animate Five Downhill Lava Flows, Town-Facing Flow & Traveling Hot-Spot Surges
        c.flowOffset = (c.flowOffset + dt * 0.18 * INT) % 1;
        let instIdx = 0;
        for (let fi = 0; fi < c.flows.length; fi++) {
          const f = c.flows[fi];
          const draw = Math.min(1, 0.74 + 0.26 * (0.5 + 0.5 * Math.sin(t * 0.45 * INT + f.delay * 4)));
          f.draw = draw;
          f.tube.geometry.setDrawRange(0, Math.floor((f.total * draw) / 36) * 36);
          f.mat.emissiveIntensity = (1.35 + Math.sin(t * 3.4 * INT + f.delay * 10) * 0.45) * (0.7 + 0.45 * INT);
          if (f.tex) f.tex.offset.x -= dt * 0.08 * INT;
          if (f.front) {
            f.front.visible = draw > 0.02;
            if (f.front.visible) {
              f.curve.getPointAt(draw, f.front.position);
              const pulse = 1 + Math.sin(t * 5 + (f.delay || 0) * 7) * 0.12;
              f.front.scale.set(f.r * 1.7 * pulse, f.r * 0.9 * pulse, f.r * 1.7 * pulse);
            }
          }

          for (let si = 0; si < c.surgesPerFlow; si++) {
            const u = (((si / c.surgesPerFlow) + c.flowOffset + f.delay * 0.7) % 1) * draw;
            f.curve.getPointAt(u, c.samplePt);
            const pulse = 0.85 + 0.3 * Math.sin(t * 5 + si * 1.3 + fi);
            const sc = (1.55 - (u / Math.max(0.2, draw)) * 0.55) * pulse * (0.8 + 0.25 * INT);
            _dummy.position.set(c.samplePt.x, c.samplePt.y + 0.32, c.samplePt.z);
            _dummy.rotation.set(0, t * 1.5 + si, 0);
            _dummy.scale.set(sc * 1.15, sc * 0.55, sc * 1.15);
            _dummy.updateMatrix();
            c.flowHotspots.setMatrixAt(instIdx++, _dummy.matrix);
          }
        }
        if (c.townFlow) {
          const tf = c.townFlow;
          const p = Math.min(1, t * 0.018 * INT), draw = Math.min(1, p);
          tf.draw = draw;
          tf.tube.geometry.setDrawRange(0, Math.floor((tf.total * draw) / 36) * 36);
          tf.mat.emissiveIntensity = 1.2 + Math.sin(t * 3) * 0.35;
          if (tf.tex) tf.tex.offset.x -= dt * 0.08 * INT;
          if (tf.front) {
            tf.front.visible = draw > 0.02;
            if (tf.front.visible) {
              tf.curve.getPointAt(draw, tf.front.position);
              const pulse = 1 + Math.sin(t * 5) * 0.12;
              tf.front.scale.set(tf.r * 1.7 * pulse, tf.r * 0.9 * pulse, tf.r * 1.7 * pulse);
            }
          }
        }
        c.flowHotspots.instanceMatrix.needsUpdate = true;
        c.surgeMat.emissiveIntensity = (1.9 + Math.sin(t * 5.5) * 0.5) * (0.75 + 0.45 * INT);

        // Ashfall & ground/roof ash accumulation near town
        if (c.ashFall && c.ashMat && c.ash) {
          const ak = smooth(3, 55, t) * Math.min(1, 0.55 + 0.45 * INT);
          c.ashFall.mat.opacity = 0.85 * smooth(1, 12, t);
          c.ashMat.opacity = ak * 0.7;
          c.ash.acc += dt;
          if (c.ash.acc > 0.3) {
            c.ash.acc = 0;
            const col = curTerrain.geometry.attributes.color;
            c.ash.idx.forEach((i, n) => {
              _c2.copy(c.ash.base[n]).lerp(c.ash.col, c.ash.w[n] * ak * 0.9);
              col.setXYZ(i, _c2.r, _c2.g, _c2.b);
            });
            col.needsUpdate = true;
          }
        }

        // 3. Dynamic Crater PointLight Pulse
        c.light.intensity = (2.8 + Math.sin(t * 7.5) * 0.75 + Math.cos(t * 13.2) * 0.35) * (0.65 + 0.55 * INT);

        // 4. Update Plume Visual Density / Size with Intensity
        if (c.plumeAsh && c.plumeAsh.mat) {
          c.plumeAsh.mat.size = 9.5 + 2.8 * INT;
          c.plumeAsh.mat.opacity = Math.min(0.88, 0.54 + 0.2 * INT);
        }
        if (c.plumeFire && c.plumeFire.mat) {
          c.plumeFire.mat.size = 6.0 + 2.2 * INT;
        }

        // 5. Update Ballistic Lava Bombs
        const activeBombs = Math.max(6, Math.min(c.bombs.length, Math.round(13 * INT)));
        c.bombMat.emissiveIntensity = (1.85 + Math.sin(t * 8) * 0.45) * (0.75 + 0.4 * INT);
        for (let i = 0; i < c.bombs.length; i++) {
          const b = c.bombs[i];
          if (i >= activeBombs) {
            b.m.visible = false;
            continue;
          }
          b.m.visible = true;
          const p = b.m.position;
          if (p.y < H(p.x, p.z)) {
            c.launchBomb(b, 0);
          }
          b.v.y -= 20 * dt;
          p.addScaledVector(b.v, dt);
          b.m.rotation.x += dt * 4.5;
          b.m.rotation.z += dt * 3.8;
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
      postBuild(c) {
        makeWreck();
        buildings.forEach(rig);
        c.prevCyc = 0;
        this.planWave(c);
        // Floodwater left standing over all the low land after the wave. It lies flat inland (hills poke out
        // as islands) and thins into a sheet running back down to the sea. Slightly see-through so the
        // survivors in the streets can still be made out under it.
        const fg = new THREE.PlaneGeometry(W, W, 110, 110);
        fg.rotateX(-Math.PI / 2);
        const fp = fg.attributes.position;
        c.floodXs = new Float32Array(fp.count);
        c.floodZs = new Float32Array(fp.count);
        c.floodHs = new Float32Array(fp.count);
        for (let i = 0; i < fp.count; i++) {
          c.floodXs[i] = fp.getX(i);
          c.floodZs[i] = fp.getZ(i);
          c.floodHs[i] = H(fp.getX(i), fp.getZ(i));
        }
        c.flood = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({
          color: 0x587078, transparent: true, opacity: 0.72, roughness: 0.25, metalness: 0.1, flatShading: true
        }));
        c.flood.receiveShadow = true;
        c.flood.visible = false;
        modeGroup.add(c.flood);
        c.floodLvl = 0;
        c.floodEdge = 999;
      },
      // Decides, from the Intensity slider, which buildings this wave will flatten, which it damages and
      // which it only floods. Buildings nearest the sea (largest x) are the most likely to fall.
      planWave(c) {
        const list = buildings.filter(b => b.rig), N = list.length, k = clamp((INT - 0.3) / 1.5, 0, 1);
        const frac = k < 0.5 ? 0.03 + 0.94 * k : 0.5 + (k - 0.5);
        const K = Math.min(N - 2, Math.round(frac * N)), D = Math.min(N, K + Math.round((0.18 + 0.27 * k) * N));
        const xs = list.map(b => b.x), x0 = Math.min(...xs), span = Math.max(1, Math.max(...xs) - x0);
        list.forEach(b => (b.seaScore = (b.x - x0) / span + R(-0.2, 0.2)));
        list.sort((a, b) => b.seaScore - a.seaScore).forEach((b, i) => (b.fate = i < K ? 'fall' : i < D ? 'damage' : 'wet'));
        c.planInt = INT;
        c.planK = K;
        c.planN = N;
      },
      update(_dt, t, c) {
        // Below 1x the wave is smaller but still tops the seawall, so it always reaches the town.
        const cyc = t % 24, A0 = Math.max(9 * INT, 6.4 + 2.6 * INT);
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
        const k = clamp((INT - 0.3) / 1.5, 0, 1), f = 0.6 + 0.6 * k;
        if (cyc < c.prevCyc) {
          // New wave: the town is rebuilt and the damage is planned for the current intensity.
          resetWreck();
          buildings.forEach(b => {
            b.wet = false;
            b.tcol = 0;
          });
          this.planWave(c);
          c.draining = true;
        } else if (INT !== c.planInt && !buildings.some(b => b.wet)) this.planWave(c);
        c.prevCyc = cyc;
        // The floodwater follows the wave front inland, stays after the wave goes back out,
        // and drains when the next wave cycle rebuilds the town.
        const L = this.townLevel, depth = 0.7 + 0.4 * k;
        if (c.active && wx < 60) {
          c.draining = false;
          c.floodEdge = Math.min(c.floodEdge, wx);
          if (wx < this.town[0] + this._townHalf + 4) c.floodLvl = Math.min(1, c.floodLvl + _dt * 1.2);
        } else if (c.draining) {
          c.floodLvl = Math.max(0, c.floodLvl - _dt * 0.8);
          if (c.floodLvl === 0) {
            c.draining = false;
            c.floodEdge = 999;
          }
        }
        c.flood.visible = c.floodLvl > 0;
        if (c.flood.visible) {
          const arr = c.flood.geometry.attributes.position.array, lv = c.floodLvl;
          const flat = L - 0.8 + (depth + 0.8) * lv;
          for (let i = 0; i < c.floodXs.length; i++) {
            const x = c.floodXs[i], z = c.floodZs[i], h = c.floodHs[i];
            const rip = Math.sin(x * 0.4 + t * 1.6) * 0.04 + Math.sin(z * 0.33 + t * 1.1) * 0.03;
            const sheet = h + (0.25 + (depth - 0.25) * (1 - smooth(8, 50, x))) * lv;
            const b = smooth(0, 14, x);
            let y = flat * (1 - b) + sheet * b + rip;
            const passed = x > c.floodEdge + Math.sin(z * 0.05 + 1) * 5 - 2;
            if (!passed || y < h + 0.05 || h < -0.6) y = h - 0.6;
            arr[i * 3 + 1] = y;
          }
          c.flood.geometry.attributes.position.needsUpdate = true;
          c.flood.geometry.computeVertexNormals();
        }
        let down = 0;
        for (const b of buildings) {
          if (!b.rig) continue;
          // Damage starts only when the wave front actually reaches this building.
          if (!b.wet && c.active && wx + Math.sin(b.z * 0.05 + 1) * 5 < b.x + b.hw + 1) {
            b.wet = true;
            if (b.fate === 'fall') {
              b.offGoal.set(-R(0.8, 2.4) * f, 0, R(-0.4, 0.4) * f);
              b.tg.set(R(-0.06, 0.06) * f, R(0.1, 0.25) * f);
              crack(b, 3, -1, 0);
              b.tcol = t + 0.45 + R(0, 0.25); // pushed and tilted first, then it gives way
            } else if (b.fate === 'damage') {
              b.offGoal.set(-R(0.3, 1.2) * f, 0, R(-0.25, 0.25) * f);
              b.tg.set(R(-0.04, 0.04) * f, R(0.05, 0.16) * f);
              crack(b, 2, -1, 0);
            } else b.offGoal.set(-R(0, 0.3), 0, 0);
          }
          if (b.tcol && t >= b.tcol) {
            collapse(b, -1, R(-0.3, 0.3));
            b.tcol = 0;
          }
          if (b.state !== 'ok') down++;
        }
        c.down = down;
      },
      status(c) {
        const lost = c.down ? `, ${c.down} of ${c.planN} buildings collapsed` : '';
        if (!c.active) return `Water receding from the coast${lost}`;
        return (c.wx > 55 ? 'Sea pulling back from the shore' : c.wx > -5 ? 'Wave reaching the coast' : 'Water surging inland') + lost;
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
        // Buildings beside the slide start standing; boulders damage them live.
        const inSlide = (x, z) => z < 16 && Math.abs(x) < 34;
        addTown(0, 46, this._townLevel, { damage: (x, z) => (inSlide(x, z) ? 0.9 : 0.08), intact: inSlide });
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
        c.dust = new Particles(500, {
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
        r.lastHit = null;
      },
      postBuild(c) {
        makeWreck();
        c.dmg = [];
        c.hill = [];
        buildings.forEach(b => {
          if (!b.mesh) return;
          rig(b);
          if (Math.abs(b.x) < 52 && b.z < 30) {
            b.town = true;
            c.dmg.push(b);
          }
        });
        // Houses on the hillside, each on a foundation stepped into the slope.
        const hillHouse = (x, z) => {
          const w = R(4.5, 6.5), d = R(4.5, 6), h = R(4, 7.5);
          const ys = [H(x - w / 2, z - d / 2), H(x + w / 2, z - d / 2), H(x - w / 2, z + d / 2), H(x + w / 2, z + d / 2), H(x, z)];
          const lo = Math.min(...ys) - 0.4, hi = Math.max(...ys) + 0.05;
          const plinth = new THREE.Mesh(G.box, M(0x8a837a));
          plinth.scale.set(w + 0.3, hi - lo, d + 0.3);
          plinth.position.set(x, (hi + lo) / 2, z);
          plinth.castShadow = plinth.receiveShadow = true;
          modeGroup.add(plinth);
          const mesh = new THREE.Mesh(buildingGeo(w, h, d), BM(pick(BCOL)));
          mesh.position.set(x, hi + h / 2, z);
          mesh.castShadow = mesh.receiveShadow = true;
          const roof = new THREE.Mesh(G.box, M(0x4d4a48));
          roof.scale.set(w + 0.4, 0.35, d + 0.4);
          roof.position.y = h / 2 + 0.175;
          roof.castShadow = true;
          mesh.add(roof);
          modeGroup.add(mesh);
          const b = { x, z, hw: w / 2, hd: d / 2, top: hi + h + 0.35, mesh, roof, hill: true };
          rig(b);
          c.dmg.push(b);
          c.hill.push(b);
        };
        // Along and beside the slide path...
        [[-20, -68], [8, -63], [-6, -54], [22, -50], [-22, -40], [12, -36], [-10, -27], [20, -22]].forEach(([x, z]) => hillHouse(x, z));
        // ...and scattered over the rest of the hillside, clear of trees and of each other.
        const trees = c.trees || [], cand = [];
        for (let gx = -112; gx <= 112; gx += 16) {
          for (let gz = -86; gz <= -18; gz += 14) cand.push([gx + R(-5, 5), gz + R(-4, 4)]);
        }
        cand.sort(() => rand() - 0.5);
        let added = 0;
        for (const [x, z] of cand) {
          if (added >= 24) break;
          if (c.hill.some(h => Math.hypot(h.x - x, h.z - z) < 13)) continue;
          if (trees.some(t => Math.hypot(t.x - x, t.z - z) < 5)) continue;
          if (slopeAt(x, z) > 1.6) continue;
          hillHouse(x, z);
          added++;
        }
        c.dmg.forEach(b => {
          b.fragK = b.hill ? R(0.85, 1.3) : R(0.35, 1.15);
          b.side = rand() < 0.5 ? -1 : 1;
        });

        // A much bigger slide: the original boulders plus more rocks and mud lumps across a wide slip zone.
        const cols = [0x7b7066, 0x6a5f55, 0x8a7f72, 0x6b5038, 0x5a4330];
        for (let k = 0; k < 80; k++) {
          const s = k < 50 ? R(0.7, 2.6) : R(1.2, 3.4), m = new THREE.Mesh(G.rock, M(pick(cols)));
          m.scale.setScalar(s);
          m.castShadow = true;
          modeGroup.add(m);
          c.rocks.push({ m, s, x: 0, z: 0, vx: 0, vz: 0 });
        }
        c.rocks.forEach(r => {
          r.hx = R(-46, 46);
          r.hz = R(-93, -76);
          r.delay = R(0, 9);
          r.stopZ = R(-4, 22);
        });
        c.halfW = z => 26 + (z + 95) * 0.17;

        // Mud sheet draped on the terrain; it spreads down behind the slide front.
        const mg = new THREE.PlaneGeometry(112, 120, 56, 60);
        mg.rotateX(-Math.PI / 2);
        mg.translate(0, 0, -35);
        const mp = mg.attributes.position, mc = new Float32Array(mp.count * 3), col = new THREE.Color();
        c.mudG = { xs: new Float32Array(mp.count), zs: new Float32Array(mp.count), gy: new Float32Array(mp.count), n: new Float32Array(mp.count) };
        for (let i = 0; i < mp.count; i++) {
          const x = mp.getX(i), z = mp.getZ(i), n = vnoise(x * 0.12 + 3, z * 0.12 + 7);
          c.mudG.xs[i] = x;
          c.mudG.zs[i] = z;
          c.mudG.gy[i] = H(x, z);
          c.mudG.n[i] = n;
          col.set(0x5c4128).lerp(_c2.set(0x7a5a3a), n);
          mc[i * 3] = col.r;
          mc[i * 3 + 1] = col.g;
          mc[i * 3 + 2] = col.b;
        }
        mg.setAttribute('color', new THREE.BufferAttribute(mc, 3));
        c.mud = new THREE.Mesh(mg, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
        c.mud.receiveShadow = true;
        modeGroup.add(c.mud);

        // Dust and mud spray come only from rocks that are moving.
        const mv = () => c.rocks.filter(r => r.state === 'move');
        c.dust.o.spawn = (i, p) => {
          const m = mv();
          if (m.length) {
            const r = pick(m);
            p.set(i, r.x + R(-1, 1), r.m.position.y, r.z + R(-1, 1), R(-1, 1), R(1, 3), R(-1, 1), R(1.5, 3));
          } else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.3));
        };
        new Particles(420, {
          color: 0x5e4630, size: 1.6, opacity: 0.85,
          spawn: (i, p) => {
            const m = mv();
            if (m.length) {
              const r = pick(m);
              p.set(i, r.x + R(-1.5, 1.5), r.m.position.y, r.z + R(-1.5, 1.5), R(-2, 2) + r.vx * 0.3, R(2, 5), R(-1, 2) + r.vz * 0.3, R(0.5, 1.2));
            } else p.set(i, 0, -80, 0, 0, 0, 0, R(0.1, 0.3));
          },
          step: (i, dt, p) => {
            p.vel[i * 3 + 1] -= dt * 14;
          }
        });
        this.resetSlide(c);
      },
      // Puts every rock back in the slip zone at the top, clears the mud and rebuilds every building.
      resetSlide(c) {
        resetWreck();
        c.dmg.forEach(b => {
          b.dmgP = 0;
          b.cracks = 0;
        });
        c.rocks.forEach(r => {
          r.state = 'wait';
          r.x = r.hx;
          r.z = r.hz;
          r.vx = r.vz = 0;
          r.slow = 0;
          r.lastHit = null;
          r.m.rotation.set(0, 0, 0);
          r.m.position.set(r.x, H(r.x, r.z) + r.s * 0.75, r.z);
        });
        c.front = -93;
        c.prevFront = -93;
        c.fv = 0;
        c.st = 0;
        c.moving = 0;
        c.slideState = 'calm';
        this.updateMud(c, true);
      },
      updateMud(c, force) {
        if (!force && Math.abs(c.front - (c.mudFront ?? -999)) < 0.4) return;
        c.mudFront = c.front;
        const g = c.mudG, arr = c.mud.geometry.attributes.position.array, started = c.st > 0;
        for (let i = 0; i < g.xs.length; i++) {
          const x = g.xs[i], z = g.zs[i], n = g.n[i];
          const on = started && z < c.front - 2 + n * 5 && Math.abs(x) < c.halfW(z) + (n - 0.5) * 8;
          arr[i * 3 + 1] = on ? g.gy[i] + 0.12 + n * 0.25 : g.gy[i] - 3;
        }
        c.mud.geometry.attributes.position.needsUpdate = true;
        c.mud.geometry.computeVertexNormals();
      },
      // Start / Stop from the Landslide control. Starting after the slide has come to rest replays it from the top.
      control(c, action) {
        if (action === 'start' && c.slideState === 'done') this.resetSlide(c);
        if (action === 'start' && (c.slideState === 'calm' || c.slideState === 'stopped')) c.slideState = 'running';
        else if (action === 'stop' && c.slideState === 'running') c.slideState = 'stopped';
        else if (action === 'reset') this.resetSlide(c);
        return c.slideState;
      },
      frozen(c) {
        return c.slideState !== 'running';
      },
      update(dt, t, c) {
        if (c.slideState !== 'running') return;
        c.st += dt;
        let n = 0, released = 0;
        const zs = [];
        for (const r of c.rocks) {
          if (r.state === 'wait') {
            if (c.st >= r.delay) r.state = 'move';
            else continue;
          }
          released++;
          zs.push(r.z);
          if (r.state !== 'move') continue;
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
          for (const b of c.dmg) {
            if (b.state !== 'ok' || r.lastHit === b) continue;
            if (Math.abs(r.x - b.x) < b.hw + r.s * 0.7 && Math.abs(r.z - b.z) < b.hd + r.s * 0.7) {
              // A boulder strike adds damage and knocks a few pieces loose, but never flattens a house on its own.
              r.lastHit = b;
              const sp = Math.hypot(r.vx, r.vz) || 1;
              b.dmgP += r.s * (0.04 + sp * 0.008) * b.fragK;
              crack(b, 1 + Math.round(r.s * 0.5), r.vx / sp, r.vz / sp);
              r.vz *= 0.35;
              r.vx *= 0.5;
            }
          }
          r.slow = Math.hypot(r.vx, r.vz) < 0.4 ? r.slow + dt : 0;
          if (r.z > r.stopZ || r.slow > 2.5) r.state = 'stop';
          r.m.position.set(r.x, H(r.x, r.z) + r.s * 0.75, r.z);
        }
        c.moving = n;
        // The slide front is where most of the released material has got to.
        if (zs.length) {
          zs.sort((a, b) => a - b);
          c.front = Math.max(c.front, zs[Math.floor(zs.length * 0.85)]);
        }
        c.fv += ((c.front - c.prevFront) / Math.max(dt, 1e-3) - c.fv) * Math.min(1, dt * 3);
        c.prevFront = c.front;
        const active = c.fv > 0.25 || n > 6;
        this.updateMud(c, false);
        for (const b of c.dmg) {
          if (b.state !== 'ok') continue;
          if (Math.abs(b.x) > c.halfW(b.z) + b.hw) {
            b.sway.set(0, 0);
            continue;
          }
          const ahead = b.z - b.hd - c.front;
          if (ahead > 0) {
            // The ground starts to shake as the slide approaches.
            const k = active && ahead < 14 ? (1 - ahead / 14) * 0.03 : 0;
            b.sway.set(Math.sin(t * 13 + b.x) * k, Math.sin(t * 11.3 + b.z) * k * 1.2);
            continue;
          }
          // Mud and rocks pressing on the house: shaking, then tilting downhill, cracking, and finally collapse.
          if (active) b.dmgP += dt * (b.town ? 0.07 : 0.12) * INT * b.fragK;
          const k = active ? 0.035 : 0;
          b.sway.set(Math.sin(t * 15 + b.x) * k, Math.sin(t * 12.7 + b.z) * k);
          const d = Math.min(1, b.dmgP);
          b.tg.set(d * 0.3, b.side * d * 0.08);
          const th = [0.3, 0.55, 0.8];
          while (b.cracks < 3 && d >= th[b.cracks]) {
            b.cracks++;
            b.crush = Math.max(0.6, b.crush - 0.07);
            crack(b, 3, 0, 1);
          }
          if (b.dmgP >= 1) collapse(b, b.side * 0.2, 1);
        }
        if (released === c.rocks.length && n === 0) c.slideState = 'done';
      },
      status(c) {
        if (c.slideState === 'calm') return 'Slope calm: press Start Landslide';
        if (c.slideState === 'stopped') return `Landslide stopped (${c.moving || 0} boulders frozen mid-slide)`;
        if (c.slideState === 'done') return 'Landslide has come to rest: press Start Landslide to replay';
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
    linkLost: new THREE.LineBasicMaterial({ color: 0xe06050, transparent: true, opacity: 0.75 })
  };
  [
    ROLE_MATS.jammerFill, ROLE_MATS.jammerEdge, ROLE_MATS.gpsFill, ROLE_MATS.gpsEdge,
    ROLE_MATS.selBeam, ROLE_MATS.linkOk, ROLE_MATS.linkDegraded, ROLE_MATS.linkLost
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

    const hitMesh = new THREE.Mesh(G.hitSphere, VMAT.hitInvisible);
    hitMesh.userData = { pickType: 'drone', droneId: id };

    g.add(beacon, roleRing, selRing, selBeam, hitMesh);
    swarmGroup.add(g);
    const item = { id, g, rotors, beacon, roleRing, selRing, selBeam, hitMesh };
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

      if (d.mode === 'dead') {
        dm.g.rotation.set(0.45, 0, 0.55);
      } else {
        dm.g.rotation.x = 0;
        dm.g.rotation.z = 0;
        if (Math.hypot(d.velocity.vx, d.velocity.vy) > 0.2) {
          dm.g.rotation.y = -Math.atan2(d.velocity.vy, d.velocity.vx);
        }
        for (let r = 0; r < dm.rotors.length; r++) {
          dm.rotors[r].rotation.y += dt * (d.mode === 'landed' ? 2 : 34);
        }
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

    // 4. Update RF Network Links
    const links = (st.network && st.network.links) ? st.network.links : [];
    for (let i = 0; i < MAX_LINKS; i++) {
      const line = linkLines[i];
      if (i >= links.length) {
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
      line.material = lk.state === 'ok'
        ? ROLE_MATS.linkOk
        : lk.state === 'degraded'
          ? ROLE_MATS.linkDegraded
          : ROLE_MATS.linkLost;
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
  // gr/gt are the zoom goals; r/target ease towards them each frame for smooth zooming.
  const orbit = { theta: 0.9, phi: 0.95, r: 150, target: new THREE.Vector3(), gr: 150, gt: new THREE.Vector3(), auto: !reduced };
  const ptrs = new Map();
  let pinchD = 0;
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
      pinchD = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  // Point on the terrain under a screen position, found by marching along the camera ray.
  const _gp = new THREE.Vector3();
  function groundPointAt(clientX, clientY, out) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);
    const o = raycaster.ray.origin, d = raycaster.ray.direction, lim = W / 2;
    let prev = 0;
    for (let s = 1.5; s < 800; s += 1.5) {
      _gp.copy(o).addScaledVector(d, s);
      if (Math.abs(_gp.x) > lim || Math.abs(_gp.z) > lim) {
        if (d.y >= 0 || s > 200) break;
        prev = s;
        continue;
      }
      if (_gp.y <= H(_gp.x, _gp.z)) {
        let a = prev, b = s;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) / 2;
          _gp.copy(o).addScaledVector(d, m);
          if (_gp.y <= H(_gp.x, _gp.z)) b = m;
          else a = m;
        }
        out.copy(o).addScaledVector(d, b);
        return true;
      }
      prev = s;
    }
    return false;
  }

  // Zoom about the ground point under the cursor: scaling camera and target around that point
  // keeps it fixed on screen. Falls back to zooming on the view centre over empty sky.
  const _zp = new THREE.Vector3();
  function zoomAt(clientX, clientY, factor) {
    const nr = clamp(orbit.gr * factor, 35, 280), f = nr / orbit.gr;
    if (Math.abs(f - 1) < 1e-4) return;
    if (groundPointAt(clientX, clientY, _zp)) {
      orbit.gt.sub(_zp).multiplyScalar(f).add(_zp);
      orbit.gt.x = clamp(orbit.gt.x, -130, 130);
      orbit.gt.z = clamp(orbit.gt.z, -130, 130);
      orbit.gt.y = Math.max(orbit.gt.y, H(orbit.gt.x, orbit.gt.z));
    }
    orbit.gr = nr;
  }
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
      if (d > 1 && pinchD > 1) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinchD / d);
      pinchD = d;
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
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    zoomAt(e.clientX, e.clientY, clamp(1 + dy * 0.0012, 0.7, 1.4));
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
      orbit.r = orbit.gr = clamp(orbit.gr * 0.92, 35, 280);
    } else if (e.key === '-' || e.key === '_') {
      orbit.r = orbit.gr = clamp(orbit.gr * 1.08, 35, 280);
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
    orbit.gt.copy(orbit.target);
    orbit.r = orbit.gr = m.camR || 150;
    orbit.theta = 0.9;
    orbit.phi = 0.95;
    sun.position.set(orbit.target.x + 70, orbit.target.y + 120, orbit.target.z + 50);
    sun.target.position.copy(orbit.target);
  }

  function focusPosition(x, y, z) {
    orbit.target.set(x, y ?? H(x, z), z);
    orbit.gt.copy(orbit.target);
    orbit.r = orbit.gr = clamp(orbit.gr, 55, 110);
  }

  function emitStats() {
    if (onStatsUpdate && curMode) {
      onStatsUpdate({
        status: curMode.status(ctx),
        waiting: victimList.length,
        slide: curMode.control ? ctx.slideState : null
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
    seed2 = 4321 + i * 131;
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
    // Anything added after the survivors are placed cannot shift the original layout.
    if (m.postBuild) m.postBuild(ctx);
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
      if (wreck && !(curMode.frozen && curMode.frozen(ctx))) updateWreck(simDt);
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
        h.g.rotation.y = -(h.ang + Math.sign(h.speed) * Math.PI / 2);
        h.rotor.rotation.y += simDt * 28;
      }
    }
    // Always update the 3D Swarm C2 visualization from SharedSimulationState
    updateSwarmLayer(dt, modeT);

    if (orbit.auto && ptrs.size === 0) orbit.theta += dt * 0.05;
    const zk = 1 - Math.exp(-dt * 10);
    orbit.r += (orbit.gr - orbit.r) * zk;
    orbit.target.lerp(orbit.gt, zk);
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
    // Landslide mode only: 'start' | 'stop' | 'reset'. Returns the new slide state.
    landslide(action) {
      if (!curMode || !curMode.control) return null;
      const st = curMode.control(ctx, action);
      emitStats();
      return st;
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

import * as THREE from 'three';
import sharedSim from '../integration/simulationStore';

export const MODES_META = [
  {
    id: 'earthquake',
    name: 'Earthquake',
    icon: '🏚️',
    desc: 'Shaking arrives in waves. Look for tilted and collapsed buildings, open fissures, falling debris and dust. Unconscious survivors lie in the streets between the damaged buildings.',
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
  },
  {
    id: 'blizzard',
    name: 'Blizzard',
    icon: '❄️',
    desc: 'Heavy snow and strong wind cut visibility. A plow clears the main street, a car sits stuck in a drift and people who collapsed from the cold lie in the snowy streets.',
    tip: 'Stay indoors if you can. If stranded in a car, stay with it, run the engine in short bursts and keep the exhaust pipe clear of snow.'
  }
];

export function createDisasterEngine(canvas, { onStatsUpdate } = {}) {
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

  const bMatCache = new Map();
  function BM(hex) {
    if (!bMatCache.has(hex)) {
      const m = new THREE.MeshStandardMaterial({ color: hex, map: windowTex, roughness: 0.9, flatShading: true });
      shared.add(m);
      bMatCache.set(hex, m);
    }
    return bMatCache.get(hex);
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
    const grid = o.grid || 4, sp = 12, half = (grid * sp) / 2 + 3;
    curMode._townHalf = half;
    const pg = new THREE.PlaneGeometry(half * 2, half * 2);
    pg.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(pg, M(o.snow ? 0xe3e9ee : 0x5b5f62));
    ground.position.set(cx, level + 0.06, cz);
    ground.receiveShadow = true;
    modeGroup.add(ground);
    for (let i = 0; i < grid; i++) {
      for (let j = 0; j < grid; j++) {
        const x = cx + (i - (grid - 1) / 2) * sp, z = cz + (j - (grid - 1) / 2) * sp;
        if (rand() < 0.1) continue;
        const w = R(5, 8.5), d = R(5, 8.5), h = R(4, 15);
        const dmg = typeof o.damage === 'function' ? o.damage(x, z) : (o.damage || 0);
        if (rand() < dmg * 0.3) {
          rubble(x, z, w, d, level);
          buildings.push({ x, z, hw: w / 2, hd: d / 2, top: level + 1.5, rubble: true });
          continue;
        }
        const mesh = new THREE.Mesh(buildingGeo(w, h, d), BM(pick(BCOL)));
        mesh.position.set(x, level + h / 2, z);
        mesh.castShadow = mesh.receiveShadow = true;
        const rh = o.snow ? 0.8 : 0.35;
        const roof = new THREE.Mesh(G.box, M(o.snow ? 0xf4f7f9 : 0x4d4a48));
        roof.scale.set(w + 0.4, rh, d + 0.4);
        roof.position.y = h / 2 + rh / 2;
        roof.castShadow = true;
        mesh.add(roof);
        const b = { x, z, hw: w / 2, hd: d / 2, top: level + h + rh, mesh, roof, tz: 0 };
        if (rand() < dmg * 0.5) {
          b.tz = R(-0.18, 0.18);
          mesh.rotation.z = b.tz;
          mesh.rotation.x = R(-0.1, 0.1);
          mesh.position.y -= 0.4;
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
    const m = curMode, [cx, cz] = m.town, half = (m._townHalf || m.townR) - 1.6;
    if (m.roofVictims) {
      const roofs = buildings.filter(b => b.mesh && !b.taken).sort(() => rand() - 0.5).slice(0, 6);
      roofs.forEach(b => {
        const th = rand() * 6.28;
        makeVictim(b.x + 1.1 * Math.sin(th), b.z + 1.1 * Math.cos(th), th, b.top);
      });
      return;
    }
    const n = Math.min(6, Math.max(4, Math.round(((2 * half) ** 2) / 210))), cells = Math.ceil(Math.sqrt(n * 2.5)), step = (2 * half) / cells, cand = [];
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        cand.push([cx - half + (i + R(0.1, 0.9)) * step, cz - half + (j + R(0.1, 0.9)) * step]);
      }
    }
    cand.sort(() => rand() - 0.5);
    const placed = [], inside = (x, z) => Math.abs(x - cx) < half && Math.abs(z - cz) < half;
    for (const [x0, z0] of cand) {
      if (placed.length >= n) break;
      for (let k = 0; k < 14; k++) {
        const x = x0 + R(-step * 0.35, step * 0.35), z = z0 + R(-step * 0.35, step * 0.35), th = rand() * 6.28;
        const sx = Math.sin(th), sz = Math.cos(th);
        const pts = [[x, z], [x - 1.15 * sx, z - 1.15 * sz], [x - 2.4 * sx, z - 2.4 * sz]];
        if (pts.some(([px, pz]) => !inside(px, pz) || blocked(px, pz, 0.35))) continue;
        const mx = x - 1.15 * sx, mz = z - 1.15 * sz;
        if (placed.some(q => Math.hypot(q[0] - mx, q[1] - mz) < 4.5)) continue;
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

  /* ---------- modes ---------- */
  const MODES = [
    {
      ...MODES_META[0],
      sky: 0xb6c0c6, fogNear: 90, fogFar: 330, hemiGround: 0x6b5d48,
      town: [0, 0], townR: 27, safe: [66, 52],
      raw: (x, z) => hills(x, z, 14) + fbm(x * 0.08, z * 0.08, 2) * 1.2,
      build(c) {
        const L = this._townLevel;
        addTown(0, 0, L, { damage: 1 });
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
        makeVehicle(0xf4f4f4, [0xff2a2a, 0x2a6bff], 27, 8, Math.PI / 2);
        makeVehicle(0xc0262b, [0xff2a2a, 0xff2a2a], 27, -6, Math.PI / 2);
        const rub = buildings.filter(b => b.rubble), src = rub.length ? rub : buildings;
        new Particles(380, {
          color: 0x9c8b74, size: 3.2, opacity: 0.35, prewarm: true,
          spawn: (i, p) => {
            const b = pick(src);
            p.set(i, b.x + R(-b.hw, b.hw), L + R(0, 2), b.z + R(-b.hd, b.hd), R(-0.6, 0.6), R(0.4, 1.4), R(-0.6, 0.6), R(3, 7));
          }
        });
        c.debris = [];
        const standing = buildings.filter(b => b.mesh);
        for (let k = 0; k < 20; k++) {
          const m = new THREE.Mesh(G.box, M(0x8d857b));
          m.scale.set(R(0.4, 1), R(0.3, 0.7), R(0.4, 1));
          m.castShadow = true;
          modeGroup.add(m);
          c.debris.push({ m, vy: 0, rest: R(0, 3), src: standing });
          m.visible = false;
        }
      },
      update(dt, t, c) {
        const cyc = t % 14, env = cyc < 6 ? Math.sin((Math.PI * cyc) / 6) : 0.06;
        c.env = env;
        const amp = env * INT * 0.8 * (reduced ? 0.25 : 1);
        world.position.set((rand() - 0.5) * amp, (rand() - 0.5) * amp * 0.4, (rand() - 0.5) * amp);
        for (const b of buildings) if (b.tilt) b.mesh.rotation.z = b.tz + Math.sin(t * 23 + b.x) * 0.015 * env * INT;
        for (const d of c.debris) {
          if (d.rest > 0) {
            d.rest -= dt;
            if (d.rest <= 0 && env > 0.35 && d.src.length) {
              const b = pick(d.src);
              d.m.visible = true;
              d.m.position.set(b.x + (rand() < 0.5 ? -1 : 1) * b.hw, b.top, b.z + R(-b.hd, b.hd));
              d.vy = R(0, 3);
            } else if (d.rest <= 0) d.rest = 0.5;
          } else {
            d.vy -= 25 * dt;
            d.m.position.y += d.vy * dt;
            d.m.rotation.x += dt * 4;
            d.m.rotation.z += dt * 3;
            const gy = H(d.m.position.x, d.m.position.z) + 0.2;
            if (d.m.position.y <= gy) {
              d.m.position.y = gy;
              d.rest = R(1, 4);
            }
          }
        }
      },
      status(c) {
        return c.env > 0.6 ? 'Strong shaking' : c.env > 0.2 ? 'Moderate shaking' : 'Aftershock lull';
      }
    },
    {
      ...MODES_META[1],
      sky: 0x8a97a3, fogNear: 60, fogFar: 280, hemiGround: 0x4a4a3c, sunI: 0.55,
      town: [0, -4], townLevel: 0.6, townR: 27, safe: [12, 66],
      roofVictims: true,
      raw: (x, z) => hills(x, z, 5) + Math.pow(Math.abs(z) / 55, 1.8) * 16 - 1.5,
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
        const tall = buildings.filter(b => b.mesh).sort(() => rand() - 0.5).slice(0, 4);
        tall.forEach(b => {
          b.taken = true;
          addAgent('resident', b.x + R(-1.5, 1.5), b.z + R(-1.5, 1.5), { state: 'wave', fixedY: b.top });
        });
        c.boats = [];
        for (let k = 0; k < 3; k++) {
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
          c.boats.push({ g, r: R(12, 26), ang: rand() * 6.28, sp: R(0.15, 0.3) * (rand() < 0.5 ? -1 : 1) });
        }
        makeHeli(0xd23a2a, () => [0, -4], 32, 36, 0.35);
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
      town: [35, 30], townR: 21, safe: [96, -40],
      raw: (x, z) => hills(x, z, 18) + 6,
      color(c, x, y, z, s) {
        natural(c, x, y, z, s, { grass: 0x6a7d3a, dry: 0xa08a4a });
      },
      build(c) {
        addTown(35, 30, this._townLevel, { grid: 3 });
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
        makeVehicle(0xc0262b, [0xff2a2a, 0xff2a2a], 14, 40, 0);
        makeVehicle(0xc0262b, [0xff2a2a, 0xff2a2a], 14, 22, 0);
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
      town: [-5, 10], townR: 27, safe: [-78, -64],
      raw: (x, z) => hills(x, z, 4) + fbm(x * 0.06, z * 0.06, 2) * 1.5,
      build(c) {
        addTown(-5, 10, this._townLevel, {});
        c.trees = addTrees(110, (x, z) => okTree(x, z), undefined, true);
        makeVehicle(0xf4f4f4, [0xff2a2a, 0x2a6bff], -38, -20, 0);
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
      town: [42, 40], townR: 21, safe: [92, -28], camR: 175, camTarget: [5, 0],
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
        addTown(42, 40, this._townLevel, { grid: 3 });
        addTrees(120, (x, z) => okTree(x, z) && Math.hypot(x + 50, z + 50) > 42);
        makeVehicle(0xe8b820, null, 22, 52, 0);
        makeVehicle(0xf4f4f4, [0xff2a2a, 0x2a6bff], 62, 22, Math.PI / 2);
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
      town: [-32, -5], townLevel: 5, townR: 21, safe: [-85, 45], camTarget: [-10, 0], camR: 165,
      raw: (x, z) => hills(x, z, 5) + 7 - smooth(-15, 75, x) * 24 + 16 * Math.exp(-(((x + 85) ** 2 + (z - 45) ** 2) / 900)),
      color(c, x, y, z, s) {
        natural(c, x, y, z, s, { sandBelow: 2.6 });
        _c2.set(0x5d6a6a);
        c.lerp(_c2, smooth(-0.5, -4, y));
      },
      build(c) {
        addTown(-32, -5, 5, { grid: 3 });
        addTrees(90, (x, z) => okTree(x, z, 3.5));
        c.water = makeWater(0x2f6f8a, 0.86);
        makeVehicle(0xf4f4f4, [0xff2a2a, 0x2a6bff], -55, -20, Math.PI / 2);
        makeHeli(0xd23a2a, () => [-10, 0], 50, 40, 0.3);
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
      town: [0, 32], townR: 27, safe: [-74, 62], camTarget: [0, 0], camR: 170,
      raw: (x, z) => {
        const m = smooth(-12, -85, z);
        let h = hills(x, z, 5) + m * 58 + (fbm(x * 0.05, z * 0.05) - 0.5) * 10 * m;
        h -= 5 * Math.exp(-((x / 15) ** 2)) * smooth(-2, -30, z) * (1 - smooth(-70, -92, z));
        return h;
      },
      color(c, x, y, z, s) {
        natural(c, x, y, z, s, {});
        const k = smooth(22, 13, Math.abs(x)) * smooth(12, 4, z) * smooth(-95, -85, z);
        _c2.set(0x6b4f35);
        c.lerp(_c2, k * 0.9);
      },
      build(c) {
        addTown(0, 32, this._townLevel, { damage: (_x, z) => (z < 26 ? 0.9 : 0) });
        c.trees = addTrees(110, (x, z) => okTree(x, z) && (Math.abs(x) > 24 || z > 14));
        makeVehicle(0xe8b820, [0xffb000, 0xffb000], -30, 8, 0);
        c.rocks = [];
        for (let k = 0; k < 40; k++) {
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
        r.x = R(-16, 16);
        r.z = R(-90, -64);
        r.vx = 0;
        r.vz = 0;
        r.stopZ = R(4, 22);
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
    },
    {
      ...MODES_META[7],
      sky: 0xd4dce3, fog: 0xdde4ea, fogNear: 20, fogFar: 150, hemiSky: 0xeef4ff, hemiGround: 0x9aa6b4, hemiI: 0.9, sun: 0xeef4ff, sunI: 0.5,
      town: [0, 0], townR: 27, safe: [-58, 54],
      raw: (x, z) => hills(x, z, 16) + fbm(x * 0.07, z * 0.07, 2) * 2,
      color(c, x, _y, z, s) {
        const n = vnoise(x * 0.08, z * 0.08);
        c.set(0xeef2f6);
        _c2.set(0xc4d2df);
        c.lerp(_c2, n * 0.5);
        _c2.set(0x6d6f72);
        c.lerp(_c2, smooth(0.32, 0.55, s) * 0.6);
      },
      build(c) {
        addTown(0, 0, this._townLevel, { snow: true });
        addTrees(130, (x, z) => okTree(x, z), 0x8fa89a);
        const drifts = new THREE.InstancedMesh(G.blob, M(0xf3f6f8), 30);
        for (let k = 0; k < 30; k++) {
          const x = R(-40, 40), z = R(-40, 40);
          _dummy.rotation.set(0, 0, 0);
          _dummy.scale.set(R(2, 5), R(0.6, 1.4), R(2, 4));
          _dummy.position.set(x, H(x, z), z);
          _dummy.updateMatrix();
          drifts.setMatrixAt(k, _dummy.matrix);
        }
        drifts.instanceMatrix.needsUpdate = true;
        modeGroup.add(drifts);
        const car = makeVehicle(0x3366aa, null, -8, 12, 0.3);
        car.rotation.z = 0.12;
        const drift = new THREE.Mesh(G.blob, M(0xf3f6f8));
        drift.scale.set(4, 1.6, 3);
        drift.position.set(-9, this._townLevel, 13);
        modeGroup.add(drift);
        c.plow = makeVehicle(0xe8a317, [0xffb000, 0xffb000], 0, 0, 0);
        precip(5000, { color: 0xffffff, size: 0.75, opacity: 0.9, fall: 7, wind: 12, height: 70, spread: 170 });
      },
      update(_dt, t, c) {
        scene.fog.far = 220 / (0.6 + INT);
        scene.fog.near = scene.fog.far * 0.12;
        const x = Math.sin(t * 0.12) * 32, dir = Math.cos(t * 0.12);
        c.plow.position.set(x, H(x, 0), 0);
        c.plow.rotation.y = dir > 0 ? 0 : Math.PI;
      },
      status() {
        return `Visibility about ${Math.round(scene.fog.far * 0.6)} m`;
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
      h: Math.max(3, (b.top || 8) - (m._townLevel || 0)),
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
    if (m.id === 'wildfire') {
      hazardZones3D.fireZones.push({ kind: 'fire', label: 'WILDFIRE FRONT', x: -20, z: 0, r: 28 * rScale });
    } else if (m.id === 'volcano') {
      hazardZones3D.fireZones.push({ kind: 'fire', label: 'VOLCANIC VENT', x: 0, z: -48, r: 26 * rScale });
    } else if (m.id === 'flood') {
      hazardZones3D.floodZones.push({ kind: 'flood', label: 'FLOOD BASIN', x: m.town[0], z: m.town[1], r: 30 * rScale });
    } else if (m.id === 'tsunami') {
      hazardZones3D.floodZones.push({ kind: 'tsunami', label: 'TSUNAMI SURGE', x: 0, z: 32, r: 34 * rScale });
    } else if (m.id === 'tornado') {
      hazardZones3D.debrisZones.push({ kind: 'tornado', label: 'TORNADO VORTEX', x: m.town[0], z: m.town[1], r: 24 * rScale });
    } else if (m.id === 'earthquake') {
      hazardZones3D.debrisZones.push({ kind: 'debris', label: 'SEISMIC RUBBLE', x: m.town[0], z: m.town[1], r: 25 * rScale });
    } else if (m.id === 'landslide') {
      hazardZones3D.landslideZones.push({ kind: 'landslide', label: 'SLIDE CHANNEL', x: 0, z: -25, r: 24 * rScale });
    } else if (m.id === 'blizzard') {
      hazardZones3D.debrisZones.push({ kind: 'blizzard', label: 'WHITEOUT CORE', x: m.town[0], z: m.town[1], r: 28 * rScale });
    }

    sharedSim.sync3DWorldToStore({
      disasterType: m.id,
      disasterIndex: modeIndex,
      disasterTitle: m.name,
      intensity: INT,
      safeZone3D: { x: m.safe[0], z: m.safe[1] },
      townCenter3D: { x: m.town[0], z: m.town[1] },
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

  let curModeIndex = 0;
  function setMode(i) {
    clearMode();
    curModeIndex = i;
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
    if (hudAcc > 0.2) {
      hudAcc = 0;
      emitStats();
    }
  }

  const ctrl3D = {
    getHeightAt: (x, z) => H(x, z),
    setPaused(isPaused) {
      paused = isPaused;
    },
    focusPosition,
    selectObjectAtClientPos: pick3DObject,
  };
  sharedSim.register3DController(ctrl3D);

  setMode(0);
  rafId = requestAnimationFrame(frame);

  return {
    getInitialAutoRotate: () => orbit.auto,
    setMode,
    setIntensity(val) {
      INT = val;
      if (curMode) {
        if (curMode.id === 'blizzard') {
          scene.fog.far = 220 / (0.6 + INT);
          scene.fog.near = scene.fog.far * 0.12;
        }
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
    dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', clearPtrs);
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

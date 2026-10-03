# Disaster Terrain Simulator (3D)

> **Smart India Hackathon (SIH) Project** — An interactive, zero-dependency 3D simulation of eight natural disasters on procedurally generated terrain, featuring real-time hazard dynamics, emergency response units, and spatial survivor tracking.

![Tech](https://img.shields.io/badge/Three.js-r128-black?logo=three.js)
![WebGL](https://img.shields.io/badge/Renderer-WebGL-blue)
![Offline](https://img.shields.io/badge/Mode-100%25_Offline-success)
![License](https://img.shields.io/badge/Three.js_License-MIT-green)

---

## Overview

**Disaster Terrain Simulator (3D)** visualizes how eight major natural disasters impact a multi-zone landscape (mountains, volcano, river, forest, town, and coastline) in real time. Built entirely with procedural geometry and noise functions, the simulator runs out-of-the-box in any modern browser without external 3D assets, internet connectivity, or build steps.

Alongside environmental effects and rescue vehicles, the simulation models **unconscious survivors requiring rescue**, complete with collision-free spatial distribution and visual distress beacons.

---

## Key Features

- **8 Real-Time Disaster Simulations** — Dynamic particle systems, terrain deformation, water level physics, and structural damage.
- **Procedural 3D World** — Custom noise-generated terrain featuring mountains, a river basin, forest, urban town grid, and coastal waters—zero external `.gltf` or `.obj` files required.
- **Smart Survivor Placement & Tracking** — Unconscious survivors are distributed across the town using a collision-aware jittered grid and highlighted with pulsing distress beacons.
- **Live Telemetry & Safety Guidance** — Each disaster mode displays real-time phase status, a live survivor counter, and actionable real-world safety guidelines.
- **Interactive Camera & Scene Controls** — Orbit, zoom, adjust disaster intensity (`0.3x`–`1.8x`), toggle 2D/3D view modes, pause simulation state, or toggle survivor visibility.
- **100% Offline Ready** — Bundles `three.min.js` locally so demonstrations run reliably even without Wi-Fi.

---

## Disaster Modes

Switch between modes instantly using keys **`1`–`8`** or the bottom navigation dock:

| Shortcut | Disaster Mode | Simulation Mechanics & Visual Effects |
|:---:|---|---|
| **`1`** | **Earthquake** | Periodic seismic shaking cycles, tilted and collapsed buildings, opening ground fissures, falling debris, and dust clouds |
| **`2`** | **Flood** | Rising river levels submerging town streets, survivors stranded on rooftops, patrolling rescue boats, helicopter, and heavy rain |
| **`3`** | **Wildfire** | Advancing fire front sweeping through the forest, charring trees, rising smoke plumes, fire trucks, and water-dropping helicopter |
| **`4`** | **Tornado** | Moving vortex funnel with orbiting debris, dark storm cloud, roofs torn off structures, and uprooted trees |
| **`5`** | **Volcano** | Erupting ash column, airborne lava bombs, and glowing downhill lava flows |
| **`6`** | **Tsunami** | Coastal drawback phase followed by a surging crest wave with sea foam flooding the shoreline |
| **`7`** | **Landslide** | Boulders, mud, and debris cascading down a mountain channel into the town perimeter |
| **`8`** | **Blizzard** | High-velocity wind-driven snowfall, reduced atmospheric visibility, operating snowplow, and stranded vehicles |

---

## Survivor Distribution & Rescue Beacons

A core focus of the simulation is visualizing victims who need immediate outside assistance:

- **Even Spatial Coverage** — Survivors are placed inside the town boundary using a **jittered grid** with a minimum separation of `4.5` units, preventing unnatural clustering.
- **Overlap & Collision Checks** — Every survivor's bounding footprint is validated against buildings, rubble piles, and vehicles so bodies lie strictly in open streets and lots.
- **Context-Aware Positioning** — During **Flood** mode (`2`), when town streets are submerged, survivors automatically relocate to building rooftops.
- **High-Visibility Distress Markers** — Each unconscious survivor is marked by a **floating red diamond** and a **pulsing red ground ring**, with a live counter in the HUD showing total survivors awaiting rescue.

---

## Controls & HUD

| Control / Input | Action |
|---|---|
| **Left-Click + Drag** / **One-Finger Drag** | Orbit / rotate camera around the terrain |
| **Scroll Wheel** / **Pinch** | Zoom camera in and out |
| **Keys `1` – `8`** / **Bottom Dock** | Switch active disaster scenario |
| **3D Model / 2D Model** | Toggle between the interactive 3D WebGL scene and the 2D model view |
| **Intensity Slider** | Scale disaster severity from `0.3` (mild) to `1.8` (extreme) |
| **People** | Show or hide unconscious survivors and distress markers |
| **Auto-rotate** | Toggle continuous orbital camera rotation |
| **Pause** | Freeze/resume simulation physics and animations |
| **Reset view** | Restore default camera angle and zoom |
| **Less / More** | Collapse or expand the disaster information card |

---

## Getting Started

No `npm install`, bundler, or internet connection is required.

### Option 1: Direct Open (Quickest)
Open `disaster-terrain-3d/index.html` directly by double-clicking it in **Google Chrome**, **Microsoft Edge**, **Firefox**, or **Safari**.

### Option 2: Local HTTP Server (Recommended)
If your browser restricts local file (`file://`) execution, serve the folder locally:

```bash
cd disaster-terrain-3d
python3 -m http.server 8000
```

Then open **[http://localhost:8000](http://localhost:8000)** in your browser.

---

## Tech Stack

- **Structure & UI:** HTML5, CSS3 (Responsive HUD, light/dark adaptive styling, mobile-friendly touch controls)
- **3D Engine:** **Three.js (r128)** via WebGL
- **Procedural Generation:** Custom JavaScript noise functions and procedural mesh generation (zero external 3D model dependencies)

---

## Project Structure

```text
disaster-terrain-3d/
├── index.html              # Application shell, HUD cards, and control panels
├── css/
│   └── style.css           # Responsive layout, glassmorphic cards, and theme styles
├── js/
│   └── main.js             # 3D WebGL scene, procedural terrain, disaster engines, and survivor logic
├── libs/
│   ├── three.min.js        # Bundled Three.js r128 library for offline execution
│   └── THREE-LICENSE.txt   # Three.js MIT license
└── README.md               # Project documentation
```

---

## Credits & License

- **Three.js** is © the Three.js authors, licensed under the **MIT License** (see `libs/THREE-LICENSE.txt`).
- Developed for the **Smart India Hackathon (SIH)**.

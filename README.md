# UAV Disaster-Response Simulation Platform (v5.0)

An integrated, mission-critical **3D & 2D UAV Swarm Disaster-Response Simulation Platform** built with **React 18**, **Three.js**, and **Vite**.

The system simulates autonomous UAV swarm coordination, multi-hop FANET mesh networking, volumetric APF obstacle avoidance, sensor-footprint coverage search, and survivor detection across six major natural disaster environments: **Earthquake**, **Floods**, **Wildfire**, **Landslide**, **Tsunami**, and **Volcano**.

---

## Key Features & Swarm Architecture

### 1. Authoritative Swarm Fleet Management (`FleetManager`)
- **Single Source of Truth ($N=7$)**: Canonical fleet size configured in `FLEET_CONFIG.DRONE_COUNT = 7`, strictly synchronized across the 3D WebGL scene, HUD metrics, reactive store, and network graph.
- **Robust Lifecycle Engine**: Full cleanup of timers, listeners, and drone meshes on resets, tab switches, and intensity adjustments. Drones launch with staggered radial departures ($i \times 1.5\text{s}$) from distinct launch pads with zero spatial overlap.
- **5-State Kinematic State Machine**:
  $$\text{LAUNCH} \longrightarrow \text{TRANSIT} \longrightarrow \text{SEARCH} \rightleftharpoons (\text{RELAY} \mid \text{RETURN\_TO\_CHARGE})$$
  Drones never disappear or sit idle: low-battery units automatically return to their pad, recharge, and resume search missions.
- **Fault Tolerance & Self-Healing (`Kill DR#` / `Revive`)**:
  Simulating in-flight drone failure instantly removes/disables the UAV, auto-heals mesh connected components to 1 by dynamically promoting a standby drone to relay, redistributes remaining search cells, updates HUD count to $N-1$, and allows instant fleet restoration via **Revive**.

### 2. Guaranteed Multi-Hop Mesh Network
- **Dynamic BFS Connectivity Graph**: Nodes consist of all active UAVs plus the Ground Control Centre (CC). Evaluated at every simulation step; guarantees 1 connected component and finite hop counts.
- **Motion Planning Articulation Constraints**: Before committing a movement vector, the kinematic planner checks that the move does not isolate the drone or cut off any downstream dependants (articulation point protection).
- **Dynamic Relay Allocation**: Search drones only extend outward as far as the relay chain supports. Relays dynamically rotate with fresh-battery drones to prevent chain collapse.
- **No-Network Zone**:
  - Replaces legacy RF jamming terminology across UI, code, and logs.
  - Direct communication between CC and drones inside the zone is prohibited ($0$ direct links).
  - Swarm constructs perimeter relays and forwards telemetry, detections, and C2 commands hop-by-hop.
  - Scene visualizes hops inside the zone, warns when a drone is one hop from chain severance, and auto-dispatches bridging relays.

### 3. Systematic Coverage Search & Survivor Detection
- **16×16 Lawnmower Grid Partitioning**: Dynamically partitions the operational rectangle into search strips allocated across active search UAVs.
- **Monotonic 100% Coverage**: Monotonically advances to 100% using each UAV's sensor footprint ($R=16\text{m}$). Once fully swept, drones enter active patrol loops to continuously monitor dynamic disaster hazards.
- **Guaranteed Survivor Detection**: Every resident inside the observation bounds is identified and tracked with synchronized HUD tallies.

### 4. Volumetric Obstacle & Collision Avoidance
- **Khatib Artificial Potential Field (APF)**: Drones sample building volumes with a 6m lookahead, exerting repulsive steering forces.
- **Mandatory Rooftop Clearance**: Hard kinematic constraint forcing drones to climb above building rooftop bounding boxes. Drones never penetrate building volumes.
- **Waterway Navigation in Floods**: Flood rescue boats are constrained to navigable water channels and steer around submerged structural footprints.

### 5. Resident State & Synchronized POI Subsystem
- **Pristine Initial State ($t=0$)**: All residents initialize alive, unharmed, and standing upright at scenario launch. Injuries and distress states trigger exclusively when disaster hazards physically reach their locations.
- **Universal Rendering**: Survivors are always rendered in 3D scenes (legacy toggle removed).
- **Strict Spatial Clamping**: All residents and POIs are strictly clamped within the observation rectangle.
- **Synchronized `+Critical POI`**: Raycasts onto the nearest resident within bounds, attaching a persistent 3D marker at $+2.5\text{m}$ and logging synchronously across all disaster scenarios.

### 6. Disaster Scenarios & Safe Control Centre Placements
- **Earthquake**: Control Centre safely stationed outside the urban boundary at $[82, 72]$ with UAV relay bridging. Features real-time **Thermal FLIR** shader and **Volumetric Gas Plume** overlays with live per-drone PPM sensor telemetry.
- **Floods**: Control Centre stationed on an elevated ridge at $[18, 86]$ (elevation $20\text{m} > 7\text{m}$ peak flood level).
- **Wildfire**: Control Centre located in the urban core at $[36, 26]$ on non-flammable pavement; eliminated initial takeoff bunching.
- **Volcano**: Safe Control Centre at $[96, -36]$ outside volcanic hazards; strict POI rectangle clamping.
- **Tsunami**: Safe Control Centre at $[-96, 62]$ outside inundation flood lines.
- **Landslide**: Safe Control Centre at $[-82, 74]$; debris seeded across the observation rectangle.

---

## Controls & Hotkeys

### Global Navigation & Telemetry
| Control / Key | Action |
|---|---|
| **`[D]`** | **Toggle Verification Suite Debug Overlay** (live telemetry, mesh stats, test results) |
| **`[1]` – `[7]`** | Switch active disaster scenario tab |
| **Left Click + Drag** | Orbit 3D perspective camera |
| **Right Click + Drag** | Pan 3D camera |
| **Scroll Wheel / Pinch** | Zoom in / out |
| **3D / 2D Toggle** | Switch between 3D WebGL simulator and 2D tactical relay map |
| **Intensity Slider** | Dynamically adjust hazard magnitude and scale |
| **Pause / Resume** | Freeze simulation clock |
| **Reset View** | Recenter camera to optimal scenario vantage point |

---

## Automated Verification & Test Suite

The platform includes a rigorous **Section I Verification Suite** testing 11 core mission invariants across all 6 disaster scenarios (84 in-browser checks and 70 Node checks):

- **In-Browser Headless Chrome Runner**: **84 / 84 Checks PASSED (100.0%)**
- **Node Headless Verifier**: **70 / 70 Checks PASSED (100.0%)**

### Running the Automated Tests Locally

```powershell
# Run the fast headless Node verification suite (70 checks)
node scripts/headless_verifier.js

# Run the full in-browser WebGL verification suite (84 checks)
powershell -ExecutionPolicy Bypass -File scripts/run_browser_autotest.ps1

# Capture all 24 visual verification screenshots
powershell -ExecutionPolicy Bypass -File scripts/capture_all_screenshots.ps1
```

All 24 generated screenshots (`start`, `mid`, `coverage`, and `nonetwork` across all 6 tabs) are stored in `screenshots/`.

---

## Running the Application Locally

### Prerequisites
- Node.js (v18+ recommended)
- npm

### Installation & Development Server

```bash
# Install dependencies
npm install

# Start Vite dev server on port 8000
npm run dev
```

Open your browser at `http://localhost:8000` to interact with the simulation.

### Production Build

```bash
# Build production bundle
npm run build

# Preview production build
npm run preview
```

---

## Project Structure

```text
├── index.html                           # Vite HTML entry point
├── package.json                         # Dependencies and build scripts
├── vite.config.js                       # Vite configuration (port 8000)
├── screenshots/                         # 24 visual verification scene captures
│   ├── earthquake_{start, mid, coverage, nonetwork}.png
│   ├── floods_{start, mid, coverage, nonetwork}.png
│   ├── wildfire_{start, mid, coverage, nonetwork}.png
│   ├── volcano_{start, mid, coverage, nonetwork}.png
│   ├── tsunami_{start, mid, coverage, nonetwork}.png
│   └── landslide_{start, mid, coverage, nonetwork}.png
├── scripts/
│   ├── headless_verifier.js             # 70-check Node headless test suite
│   ├── run_browser_autotest.ps1         # 84-check real WebGL Chrome test runner
│   └── capture_all_screenshots.ps1      # 24-screenshot automated capture script
├── public/
│   └── model2d/                         # 2D tactical drone swarm simulator
└── src/
    ├── main.jsx                         # React root entry point
    ├── App.jsx                          # Main UI, HUD metrics, and debug overlay
    ├── styles.css                       # Responsive dark glassmorphic styling
    ├── integration/
    │   └── simulationStore.js           # Reactive swarm telemetry and POI store
    └── simulation/
        ├── fleetManager.js              # Swarm manager, mesh BFS, APF & kinematics
        ├── disasterEngine.js            # Three.js 3D rendering and disaster physics
        └── verificationSuite.js         # Automated verification test suite
```

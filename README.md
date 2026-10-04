# Disaster Terrain & Drone Swarm Relay Simulator (React + Three.js)

An integrated **3D & 2D Disaster Simulation Platform** built with **React**, **Three.js**, and **Vite**:

- **3D Model**: Interactive 3D WebGL terrain simulator showing eight natural disasters (`Earthquake`, `Flood`, `Wildfire`, `Tornado`, `Volcano`, `Tsunami`, `Landslide`, `Blizzard`), procedural towns, emergency vehicles, helicopters/boats, and unconscious survivors waiting for help.
- **2D Model**: Full **Drone Swarm Relay Simulator** (`testingfortechfest`) featuring C2 mesh link planning, real radio hardware specs, terrain/OSM building obstruction, RF interference/jamming, mission & DDIL scenario libraries, RSSI field calibration, ATAK/CoT export/import, SITL vehicle bridge, and Disaster PoI detection.

---

---

### 3D Model
- **Drag** to orbit the camera around the terrain
- **Scroll** or **pinch** to zoom in and out
- **1–8 keys** or the bottom dock to switch disasters
- **3D Model / 2D Model** toggle to switch between the 3D WebGL view and the 2D Drone Swarm Relay Simulator
- **Intensity** slider to make the disaster stronger or milder
- **People** button to show or hide people in the scene
- **Auto-rotate** button to start or stop the slow camera turn
- **Pause** button to freeze the simulation
- **Reset view** button to return the camera to its starting angle

### 2D Model (`testingfortechfest`)
- **Pan / Zoom** on the 2D tactical map canvas (`#map`) or toggle its internal perspective view (`3D view`)
- **Radio hardware & Environment** selectors with real link-budget calculations
- **Mission setup**: Fleet size (3–120 drones), airframes, mixed fleet relay wing, altitude, hop spacing, corridor routing, spectrum agility, LPI/LPD, video backhaul, procedural/OSM terrain, wind, and simulation speed (`1×`, `5×`, `30×`, `120×`, `Pause`)
- **Interference (RF denial)**: Add/drag RF jammers and GPS outage zones, or enable Red-team mode
- **Disaster PoIs, Mission Library, DDIL Scenarios, Calibration, ATAK/TAK, and SITL Bridge**
- **Switch to 3D Model**: Use the top **3D Model / 2D Model** switcher or the **Switch to 3D Model** button in the 2D header

---

## Running Locally

```bash
cd /Users/admin/Desktop/SIHnewproject && npm run dev
```

Other scripts (run inside `/Users/admin/Desktop/SIHnewproject`):

```bash
npm run lint
npm run build
```

---

## Project Structure

```text
├── index.html                  # Vite HTML entry
├── package.json                # React, Three.js, Vite, and ESLint configuration
├── vite.config.js              # Vite configuration (port 8000)
├── eslint.config.js            # ESLint flat configuration
├── public/
│   └── model2d/                # Full 2D Drone Swarm Relay Simulator (from testingfortechfest)
│       ├── index.html
│       ├── css/style.css
│       ├── js/                 # poi, radios, terrain, osm, tiles, airframes, fleet, gpsnav, missions, scenarios, calibrate, tak, adversary, net, swarm, render, view3d, external, main
│       ├── batch/
│       ├── bench/
│       ├── sitl/
│       ├── test/
│       └── tools/
└── src/
    ├── main.jsx                # React root with StrictMode
    ├── App.jsx                 # React UI panels, 3D/2D view switcher, and lifecycle management
    ├── styles.css              # Responsive dark glassmorphic UI styles
    └── simulation/
        └── disasterEngine.js   # Three.js WebGL renderer, procedural terrain, instancing, and 8 disaster modes
```

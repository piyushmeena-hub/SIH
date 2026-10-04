# Coordinated 2D Drone Swarm C2 & 3D Disaster Terrain Simulation Architecture

## 1. Architecture Overview

The project unifies two specialized simulation engines into a single coordinated mission runtime:

```text
        DISASTER WORLD / 3D (Three.js + React)
                       ↕
         SHARED SIMULATION STATE (__SHARED_SIM__)
                       ↕
        DRONE SWARM / 2D C2 (public/model2d/)
```

### Authoritative Ownership

| Domain | Authoritative System | Responsibilities |
| :--- | :--- | :--- |
| **Drones (`DR-1`..`DR-N`)** | **2D Swarm Engine** (`public/model2d/js/swarm.js`, `fleet.js`) | Kinematics, waypoint routing, obstacle avoidance, battery drain, RTB/recharge lifecycle, failure handling |
| **RF Network & Relay Chain** | **2D Network Engine** (`public/model2d/js/net.js`, `radios.js`) | Link budget (dB margin), multi-hop relay slot placement, packet delivery, video backhaul scheduling |
| **PoI Assignment & Survey** | **2D PoI Store** (`public/model2d/js/poi.js`) | Priority queue (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`), UAV assignment, survey progress (`0–100%`), GCS packet acknowledgement |
| **EW Jammers & GPS Denial** | **2D Adversary / Nav Engine** (`public/model2d/js/adversary.js`, `gpsnav.js`) | RF jammer ERP & denial radius, GNSS outage zones, dead-reckoning INS drift |
| **Physical Disaster Terrain** | **3D Disaster Engine** (`src/simulation/disasterEngine.js`) | 8 procedural disaster environments (Earthquake, Flood, Wildfire, Tornado, Volcano, Tsunami, Landslide, Blizzard), 3D buildings, rubble, water/fire/wind physics |
| **Survivors (`SURV-01`..`SURV-06`)** | **3D Disaster Engine ↔ 2D PoI Store** | Spawned on 3D streets/rooftops by `scatterVictims()`, registered into `SharedSimulationState`, and synchronized into 2D `PoiStore` as `CRITICAL` rescue objectives |
| **Mission Clock & Selection** | **Shared Simulation Store** (`src/integration/simulationStore.js`) | Unified `elapsedTime`, `timeScale` (`1×`, `5×`, `30×`, `120×`), `paused`, `selectedDroneId`, and `selectedPoiId` |

---

## 2. Shared State Schema (`src/integration/simulationStore.js`)

`window.__SHARED_SIM__.state` maintains the canonical `SharedSimulationState`:

```javascript
{
  mission: {
    active: true,
    disasterType: "earthquake",   // earthquake | flood | wildfire | tornado | volcano | tsunami | landslide | blizzard
    disasterIndex: 0,
    disasterTitle: "EARTHQUAKE",
    intensity: 1.0,               // 0.3 .. 1.8
    elapsedTime: 0,               // seconds (T+MM:SS)
    timeScale: 5,                 // 1 | 5 | 30 | 120
    paused: false,
    target2D: { x: 450, y: -120 },
    target3D: { x: 48.89, y: 1.2, z: -14.44 }
  },
  world: {
    bounds: { minX: -140, maxX: 140, minZ: -140, maxZ: 140, width: 280 },
    terrainType: "earthquake",
    safeZone3D: { x: 66, z: 52 },
    townCenter3D: { x: 0, z: 0 },
    obstacles: [...],
    buildings: [...],             // 3D town buildings mapped into both 3D and 2D LOS footprints
    roads: [],
    hazardZones: [...]
  },
  drones: [
    {
      id: "DR-1",
      position: { x, y, z },      // 3D Three.js world coordinates
      position2D: { x, y, z },    // 2D tactical coordinates in meters
      role: "mission",            // mission | relay | hold | relink | rescue | RETURNING_TO_BASE | LANDED | dead
      status: "fly",
      battery: 94.2,
      health: 100,
      velocity: { vx, vy, speed },
      targetPoi: "POI-A",
      communicationStatus: "CONNECTED",
      gpsStatus: "LOCKED"
    }
  ],
  pois: [
    {
      id: "POI-A",                // Crisis PoIs (POI-A..E) + 3D Survivors (SURV-01..06)
      position: { x, y, z },
      position2D: { x, y },
      type: "crisis",             // crisis | survivor
      priority: "CRITICAL",
      detected: true,
      assignedDrone: "DR-2",
      progress: 65.0,
      status: "SURVEYING"
    }
  ],
  survivors: [
    {
      id: "SURV-01",
      position: { x, y, z },
      position2D: { x, y },
      status: "SURVEYING",
      detected: true,
      assignedDrone: "DR-4",
      progress: 42.0
    }
  ],
  network: {
    gcsPosition: { x, y, z },
    gcsPosition2D: { x, y },
    links: [...],                 // Hop-by-hop 3D & 2D link segments with state: ok | degraded | lost
    relayChain: [...],
    packetLoss: 0,
    throughput: 210,
    channelUtilization: 0.18,
    connected: true
  },
  hazards: {
    fireZones: [...],
    floodZones: [...],
    debrisZones: [...],
    landslideZones: [...],
    gpsDeniedZones: [...],
    jammerZones: [...]
  },
  selection: {
    selectedDroneId: "DR-1",
    selectedPoiId: "SURV-01"
  }
}
```

---

## 3. Coordinate Mapping (`src/integration/coordinateMapper.js`)

All spatial conversions between the 2D tactical map (meters) and the 3D Three.js terrain (`W = 280`, `[-140, +140]`) pass through `src/integration/coordinateMapper.js`:

- **Scale**: `SCALE_2D_PER_3D = 4.5` (`1` Three.js unit = `4.5 m` in 2D; `280` units = `1,260 m × 1,260 m` tactical sector).
- **Origin Alignment**: `ORIGIN_2D_X = 230`, `ORIGIN_2D_Y = -55`:
  - `world2DTo3D(x2d, y2d, altM, heightFn)` maps 2D `(x2d, y2d, altM)` to 3D `{ x, y, z, groundY }` where `y = H(x, z) + max(9, altM * 0.24)`.
  - `world3DTo2D(x3d, z3d, y3d, groundY3D)` maps 3D `(x3d, z3d)` to 2D `{ x, y, altM }`.
  - `radius2DTo3D(r2d)` and `radius3DTo2D(r3d)` convert jammer, GPS denial, and hazard radii between both views.

---

## 4. Event Flow (`src/integration/simulationEvents.js`)

The `SimulationEventBus` emits structured events and logs `[SYNC]` transitions to the console:

- `DISASTER_CHANGED` / `DISASTER_INTENSITY_CHANGED`: Triggered when switching disasters (`1–8` or bottom dock) or adjusting the intensity slider (`0.3×–1.8×`). Pushes updated 3D buildings, survivors, hazard zones, wind vectors, and RF environmental attenuation to the 2D swarm engine without resetting the mission.
- `SIMULATION_PAUSED` / `SIMULATION_TIME_CHANGED`: Synchronizes `Pause/Resume` and `1× / 5× / 30× / 120×` speed across both simulators.
- `DRONE_SELECTED` / `POI_UPDATED`: Bidirectional selection when clicking a drone or PoI/survivor in either 2D or 3D.
- `DRONE_DOWN`: Fired when a drone is killed in either 2D or 3D, unassigning its PoI and triggering C2 relay/mission self-healing.
- `POI_CREATED` / `POI_ASSIGNED` / `POI_COMPLETED` / `SURVIVOR_DETECTED`: Tracks crisis PoI and 3D survivor rescue progress across both views.
- `JAMMER_CHANGED` / `GPS_ZONE_CHANGED`: Synchronizes RF jammer and GNSS denial cylinders/rings between 2D and 3D.

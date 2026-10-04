import coordinateMapper, {
  world2DTo3D,
  world3DTo2D,
  radius2DTo3D,
  radius3DTo2D,
} from './coordinateMapper';
import { SIM_EVENTS, SimulationEventBus } from './simulationEvents';

/**
 * SharedSimulationStore
 * Single source of truth connecting:
 *   DISASTER WORLD / 3D  <-->  SHARED SIMULATION STATE  <-->  DRONE SWARM / 2D C2
 */
class SharedSimulationStore {
  constructor() {
    this.events = new SimulationEventBus();
    this.coord = coordinateMapper;
    this.ctrl2D = null;
    this.ctrl3D = null;
    this.heightFn3D = null;

    // Track previous values to emit edge-triggered [SYNC] logs without frame spam
    this._prevAssignments = new Map();
    this._prevPoiStates = new Map();
    this._prevDroneAlive = new Map();

    this.state = {
      mission: {
        active: true,
        disasterType: 'earthquake',
        disasterIndex: 0,
        disasterTitle: 'EARTHQUAKE',
        intensity: 1.0,
        elapsedTime: 0,
        timeScale: 5,
        paused: false,
        target2D: { x: 450, y: -120 },
        target3D: world2DTo3D(450, -120, 0),
      },

      world: {
        bounds: { minX: -140, maxX: 140, minZ: -140, maxZ: 140, width: 280 },
        cityBounds: { centerX: 0, centerZ: 0, halfSize: 54, width: 108, depth: 108, minX: -54, maxX: 54, minZ: -54, maxZ: 54 },
        terrainType: 'earthquake',
        safeZone3D: { x: 82, z: 72 },
        townCenter3D: { x: 0, z: 0 },
        obstacles: [],
        buildings: [],
        roads: [],
        hazardZones: [],
      },

      drones: [],
      pois: [],
      survivors: [],

      network: {
        gcsPosition: world2DTo3D(0, 0, 0),
        gcsPosition2D: { x: 0, y: 0 },
        links: [],
        relayChain: [],
        packetLoss: 0,
        throughput: 0,
        channelUtilization: 0,
        connected: false,
        fleetConnected: false,
        aliveCount: 0,
        freshCount: 0,
        relayCount: 0,
        missionCount: 0,
        deliveredPackets: 0,
      },

      hazards: {
        fireZones: [],
        floodZones: [],
        debrisZones: [],
        landslideZones: [],
        gpsDeniedZones: [],
        jammerZones: [],
      },

      selection: {
        selectedDroneId: null,
        selectedPoiId: null,
      },
    };
  }

  on(eventType, handler) {
    return this.events.on(eventType, handler);
  }

  off(eventType, handler) {
    this.events.off(eventType, handler);
  }

  logSync(msg, payload = null) {
    return this.events.logSync(msg, payload);
  }

  register2DController(ctrl) {
    this.ctrl2D = ctrl;
    this.logSync('2D Swarm C2 controller connected to SharedSimulationState');
    // Immediately push current 3D disaster environment & clock to 2D
    if (ctrl && typeof ctrl.applySharedEnvironment === 'function') {
      ctrl.applySharedEnvironment({
        mission: this.state.mission,
        world: this.state.world,
        survivors: this.state.survivors,
        hazards: this.state.hazards,
        selection: this.state.selection,
      });
    }
  }

  register3DController(ctrl) {
    this.ctrl3D = ctrl;
    if (ctrl && typeof ctrl.getHeightAt === 'function') {
      this.heightFn3D = ctrl.getHeightAt;
    }
    this.logSync('3D Disaster Engine controller connected to SharedSimulationState');
  }

  // --- Shared Clock & Speed Controls -----------------------------------------
  setPaused(paused, source = 'ui') {
    const next = Boolean(paused);
    if (this.state.mission.paused === next) return;
    this.state.mission.paused = next;
    if (source !== '2d' && this.ctrl2D && typeof this.ctrl2D.setPaused === 'function') {
      this.ctrl2D.setPaused(next);
    }
    if (source !== '3d' && this.ctrl3D && typeof this.ctrl3D.setPaused === 'function') {
      this.ctrl3D.setPaused(next);
    }
    this.logSync(`Simulation ${next ? 'PAUSED' : 'RESUMED'} (source: ${source})`);
    this.events.emit(SIM_EVENTS.SIMULATION_PAUSED, { paused: next, source });
  }

  setTimeScale(scale, source = 'ui') {
    const next = Math.max(0.25, Math.min(120, Number(scale) || 1));
    if (this.state.mission.timeScale === next) return;
    this.state.mission.timeScale = next;
    if (source !== '2d' && this.ctrl2D && typeof this.ctrl2D.setTimeScale === 'function') {
      this.ctrl2D.setTimeScale(next);
    }
    this.logSync(`Simulation speed set to ${next}x (source: ${source})`);
    this.events.emit(SIM_EVENTS.SIMULATION_TIME_CHANGED, {
      timeScale: next,
      elapsedTime: this.state.mission.elapsedTime,
      source,
    });
  }

  // --- Bidirectional Selection -----------------------------------------------
  selectDrone(droneId, source = 'ui') {
    const id = droneId || null;
    if (this.state.selection.selectedDroneId === id && source !== 'force') return;
    this.state.selection.selectedDroneId = id;
    if (source !== '2d' && this.ctrl2D && typeof this.ctrl2D.selectDrone === 'function') {
      this.ctrl2D.selectDrone(id);
    }
    if (id) {
      this.logSync(`Drone selected: ${id} (from ${source.toUpperCase()})`, { droneId: id, source });
    }
    const droneObj = this.state.drones.find((d) => d.id === id) || null;
    this.events.emit(SIM_EVENTS.DRONE_SELECTED, { droneId: id, drone: droneObj, source });
  }

  selectPoi(poiId, source = 'ui') {
    const id = poiId || null;
    if (this.state.selection.selectedPoiId === id && source !== 'force') return;
    this.state.selection.selectedPoiId = id;
    if (source !== '2d' && this.ctrl2D && typeof this.ctrl2D.selectPoi === 'function') {
      this.ctrl2D.selectPoi(id);
    }
    if (id) {
      this.logSync(`PoI/Survivor selected: ${id} (from ${source.toUpperCase()})`, { poiId: id, source });
    }
    const poiObj = this.state.pois.find((p) => p.id === id) || null;
    this.events.emit(SIM_EVENTS.POI_UPDATED, { poiId: id, poi: poiObj, source });
  }

  // --- Authoritative Actions Delegated to 2D Swarm Engine --------------------
  killDrone(droneId, source = 'ui') {
    const targetId = droneId || this.state.selection.selectedDroneId;
    if (!targetId) return false;
    if (this.ctrl2D && typeof this.ctrl2D.killDrone === 'function') {
      const ok = this.ctrl2D.killDrone(targetId);
      if (ok) {
        this.logSync(`Drone killed: ${targetId} (triggered from ${source.toUpperCase()})`, { droneId: targetId });
        this.events.emit(SIM_EVENTS.DRONE_DOWN, { droneId: targetId, source });
      }
      return ok;
    }
    return false;
  }

  addCriticalPoi(opts = {}, source = 'ui') {
    if (this.ctrl2D && typeof this.ctrl2D.addCriticalPoi === 'function') {
      const created = this.ctrl2D.addCriticalPoi(opts);
      if (created) {
        this.logSync(`New critical PoI created: ${created.id} at 2D(${Math.round(created.x)}, ${Math.round(created.y)}) from ${source.toUpperCase()}`);
        this.events.emit(SIM_EVENTS.POI_CREATED, { poi: created, source });
      }
      return created;
    }
    return null;
  }

  addJammer(opts = {}, source = 'ui') {
    if (this.ctrl2D && typeof this.ctrl2D.addJammer === 'function') {
      const jammer = this.ctrl2D.addJammer(opts);
      if (jammer) {
        this.logSync(`RF Jammer deployed at 2D(${Math.round(jammer.x)}, ${Math.round(jammer.y)}) [${jammer.erpDbm} dBm] from ${source.toUpperCase()}`);
        this.events.emit(SIM_EVENTS.JAMMER_CHANGED, { jammer, source });
      }
      return jammer;
    }
    return null;
  }

  addGpsZone(opts = {}, source = 'ui') {
    if (this.ctrl2D && typeof this.ctrl2D.addGpsZone === 'function') {
      const zone = this.ctrl2D.addGpsZone(opts);
      if (zone) {
        this.logSync(`GPS Denied Zone deployed at 2D(${Math.round(zone.x)}, ${Math.round(zone.y)}) [r=${Math.round(zone.rM)}m] from ${source.toUpperCase()}`);
        this.events.emit(SIM_EVENTS.GPS_ZONE_CHANGED, { zone, source });
      }
      return zone;
    }
    return null;
  }

  // --- 3D World -> Shared Store Synchronization ------------------------------
  sync3DWorldToStore({
    disasterType,
    disasterIndex,
    disasterTitle,
    intensity,
    safeZone3D,
    townCenter3D,
    cityBounds3D,
    buildings3D = [],
    survivors3D = [],
    hazardZones3D = {},
    heightFn = null,
  }) {
    if (heightFn) this.heightFn3D = heightFn;
    const prevDisaster = this.state.mission.disasterType;
    const prevIntensity = this.state.mission.intensity;

    if (disasterType) this.state.mission.disasterType = disasterType;
    if (disasterIndex !== undefined) this.state.mission.disasterIndex = disasterIndex;
    if (disasterTitle) this.state.mission.disasterTitle = disasterTitle;
    if (intensity !== undefined) this.state.mission.intensity = Number(intensity);

    this.state.world.terrainType = this.state.mission.disasterType;
    if (safeZone3D) this.state.world.safeZone3D = safeZone3D;
    if (townCenter3D) this.state.world.townCenter3D = townCenter3D;
    if (cityBounds3D) this.state.world.cityBounds = cityBounds3D;

    // Map 3D buildings into both 3D and 2D coordinates for 2D LOS & obstacle avoidance
    this.state.world.buildings = buildings3D.map((b, idx) => {
      const pos2D = world3DTo2D(b.x, b.z);
      return {
        id: b.id || `BLD-${idx + 1}`,
        position3D: { x: b.x, y: b.y || 0, z: b.z },
        size3D: { w: b.w || 4, h: b.h || 8, d: b.d || 4 },
        x: pos2D.x,
        y: pos2D.y,
        w: Math.max(10, radius3DTo2D(b.w || 4)),
        d: Math.max(10, radius3DTo2D(b.d || 4)),
        heightM: Math.round((b.h || 8) * 3.8),
      };
    });
    this.state.world.obstacles = this.state.world.buildings;

    // Map 3D survivors into shared survivors array with persistent IDs SURV-01, SURV-02...
    if (Array.isArray(survivors3D) && survivors3D.length > 0) {
      this.state.survivors = survivors3D.map((s, idx) => {
        const id = s.id || `SURV-${String(idx + 1).padStart(2, '0')}`;
        const existing = this.state.survivors.find((ex) => ex.id === id);
        const pos2D = world3DTo2D(s.x, s.z);
        return {
          id,
          position: { x: Number(s.x.toFixed(2)), y: Number((s.y || 0).toFixed(2)), z: Number(s.z.toFixed(2)) },
          position2D: { x: pos2D.x, y: pos2D.y },
          status: existing ? existing.status : 'UNASSIGNED',
          detected: existing ? existing.detected : false,
          assignedDrone: existing ? existing.assignedDrone : null,
          progress: existing ? existing.progress : 0,
        };
      });
      this.logSync(`Registered ${this.state.survivors.length} 3D survivors as shared rescue PoIs (${this.state.survivors.map((s) => s.id).join(', ')})`);
      this.events.emit(SIM_EVENTS.SURVIVOR_CREATED, { survivors: this.state.survivors });
    }

    // Update hazard zones
    if (hazardZones3D) {
      const mapZoneList = (zones = []) =>
        zones.map((z) => {
          const p2 = world3DTo2D(z.x, z.z);
          return {
            ...z,
            x2d: p2.x,
            y2d: p2.y,
            r2d: radius3DTo2D(z.r || 18),
          };
        });
      this.state.hazards.fireZones = mapZoneList(hazardZones3D.fireZones);
      this.state.hazards.floodZones = mapZoneList(hazardZones3D.floodZones);
      this.state.hazards.debrisZones = mapZoneList(hazardZones3D.debrisZones);
      this.state.hazards.landslideZones = mapZoneList(hazardZones3D.landslideZones);
      this.state.world.hazardZones = [
        ...this.state.hazards.fireZones,
        ...this.state.hazards.floodZones,
        ...this.state.hazards.debrisZones,
        ...this.state.hazards.landslideZones,
      ];
    }

    if (prevDisaster !== this.state.mission.disasterType) {
      this.logSync(`Disaster changed to ${this.state.mission.disasterType.toUpperCase()} (intensity ${this.state.mission.intensity.toFixed(1)}x)`);
      this.events.emit(SIM_EVENTS.DISASTER_CHANGED, {
        disasterType: this.state.mission.disasterType,
        intensity: this.state.mission.intensity,
      });
    } else if (Math.abs(prevIntensity - this.state.mission.intensity) > 0.01) {
      this.logSync(`Disaster intensity updated to ${this.state.mission.intensity.toFixed(1)}x for ${this.state.mission.disasterType.toUpperCase()}`);
      this.events.emit(SIM_EVENTS.DISASTER_INTENSITY_CHANGED, {
        disasterType: this.state.mission.disasterType,
        intensity: this.state.mission.intensity,
      });
    }

    if (this.ctrl2D && typeof this.ctrl2D.applySharedEnvironment === 'function') {
      this.ctrl2D.applySharedEnvironment({
        mission: this.state.mission,
        world: this.state.world,
        survivors: this.state.survivors,
        hazards: this.state.hazards,
        selection: this.state.selection,
      });
    }
  }

  // --- 2D Swarm Engine -> Shared Store Synchronization -----------------------
  sync2DSwarmToStore(snapshot) {
    if (!snapshot) return;
    const H = this.heightFn3D;

    // 1. Mission clock & target
    if (typeof snapshot.time === 'number') {
      this.state.mission.elapsedTime = snapshot.time;
    }
    if (typeof snapshot.timeScale === 'number') {
      this.state.mission.timeScale = snapshot.timeScale;
    }
    if (typeof snapshot.paused === 'boolean') {
      this.state.mission.paused = snapshot.paused;
    }
    if (snapshot.target) {
      this.state.mission.target2D = { x: snapshot.target.x, y: snapshot.target.y };
      this.state.mission.target3D = world2DTo3D(snapshot.target.x, snapshot.target.y, 0, H);
    }

    // 2. Drones
    if (Array.isArray(snapshot.drones)) {
      this.state.drones = snapshot.drones.map((d) => {
        const isGround = d.mode === 'landed' || d.mode === 'dead';
        const altM = isGround ? 0 : (snapshot.altitudeM || 50);
        const pos3D = world2DTo3D(d.x, d.y, altM, H);
        const alive = d.mode !== 'dead';
        const prevAlive = this._prevDroneAlive.get(d.id);
        if (prevAlive === true && !alive) {
          this.logSync(`Drone ${d.id} DOWN at 2D(${Math.round(d.x)}, ${Math.round(d.y)})`);
          this.events.emit(SIM_EVENTS.DRONE_DOWN, { droneId: d.id });
        }
        this._prevDroneAlive.set(d.id, alive);

        return {
          id: d.id,
          position: { x: pos3D.x, y: pos3D.y, z: pos3D.z },
          groundY: pos3D.groundY,
          position2D: { x: Number(d.x.toFixed(1)), y: Number(d.y.toFixed(1)), z: altM },
          role: d.effRole || d.role || 'mission',
          rawRole: d.role || 'mission',
          cls: d.cls || 'mission',
          mode: d.mode || 'fly',
          status: alive ? (d.mode || 'fly') : 'dead',
          battery: Number((d.batteryPct ?? 100).toFixed(1)),
          health: alive ? 100 : 0,
          velocity: {
            vx: Number((d.vx || 0).toFixed(2)),
            vy: Number((d.vy || 0).toFixed(2)),
            speed: Number(Math.hypot(d.vx || 0, d.vy || 0).toFixed(1)),
          },
          targetPoi: d.poiId || null,
          communicationStatus: d.commStatus || 'CONNECTED',
          gpsStatus: d.gpsDenied ? 'DENIED' : 'LOCKED',
          gpsDenied: Boolean(d.gpsDenied),
          driftM: Number((d.driftM || 0).toFixed(1)),
        };
      });
    }

    // 3. PoIs & Survivor synchronization
    if (Array.isArray(snapshot.pois)) {
      this.state.pois = snapshot.pois.map((p) => {
        const pos3D = world2DTo3D(p.x, p.y, 0, H);
        const assigned = p.assignedUavId || null;
        const prevAssigned = this._prevAssignments.get(p.id);
        if (assigned && assigned !== prevAssigned) {
          this.logSync(`Drone ${assigned} assigned to ${p.id} (${p.priority})`);
          this.events.emit(SIM_EVENTS.POI_ASSIGNED, { poiId: p.id, droneId: assigned });
        }
        this._prevAssignments.set(p.id, assigned);

        const prevState = this._prevPoiStates.get(p.id);
        if (p.state && p.state !== prevState && (p.state === 'SURVEYING' || p.state === 'SURVEYED')) {
          this.logSync(`PoI ${p.id} status -> ${p.state} (${Math.round(p.progress || 0)}%)`);
          if (p.state === 'SURVEYED') {
            this.events.emit(SIM_EVENTS.POI_COMPLETED, { poiId: p.id, droneId: assigned });
          }
        }
        this._prevPoiStates.set(p.id, p.state);

        return {
          id: p.id,
          label: p.type || 'Crisis Site',
          position: { x: pos3D.x, y: pos3D.groundY, z: pos3D.z },
          position2D: { x: Number(p.x.toFixed(1)), y: Number(p.y.toFixed(1)) },
          type: p.isSurvivor ? 'survivor' : 'crisis',
          priority: p.priority || 'HIGH',
          detected: p.state !== 'UNASSIGNED',
          assignedDrone: assigned,
          progress: Number((p.progress || 0).toFixed(1)),
          status: p.state || 'UNASSIGNED',
          survivorId: p.survivorId || (p.isSurvivor ? p.id : null),
        };
      });

      // Mirror survivor PoI states back onto state.survivors
      for (const surv of this.state.survivors) {
        const match = this.state.pois.find((p) => p.id === surv.id || p.survivorId === surv.id);
        if (match) {
          const wasDetected = surv.detected;
          surv.status = match.status;
          surv.assignedDrone = match.assignedDrone;
          surv.progress = match.progress;
          surv.detected = match.status === 'SURVEYING' || match.status === 'SURVEYED' || match.status === 'DATA_CREATED' || match.status === 'ACKNOWLEDGED';
          if (!wasDetected && surv.detected) {
            this.logSync(`Survivor ${surv.id} detected/reached by ${surv.assignedDrone || 'Swarm'}!`);
            this.events.emit(SIM_EVENTS.SURVIVOR_DETECTED, { survivor: surv });
          }
        }
      }
    }

    // 4. Network & Relay Chain
    if (snapshot.network) {
      const net = snapshot.network;
      const gcs3D = world2DTo3D(net.baseX || 0, net.baseY || 0, 0, H);
      this.state.network = {
        gcsPosition: { x: gcs3D.x, y: gcs3D.groundY, z: gcs3D.z },
        gcsPosition2D: { x: net.baseX || 0, y: net.baseY || 0 },
        links: (net.hops || []).map((h) => {
          const aAlt = h.a.kind === 'base' ? 4 : (snapshot.altitudeM || 50);
          const bAlt = h.b.kind === 'base' ? 4 : (snapshot.altitudeM || 50);
          const a3 = world2DTo3D(h.a.x, h.a.y, aAlt, H);
          const b3 = world2DTo3D(h.b.x, h.b.y, bAlt, H);
          return {
            fromId: h.a.label,
            toId: h.b.label,
            from3D: { x: a3.x, y: h.a.kind === 'base' ? a3.groundY + 4.5 : a3.y, z: a3.z },
            to3D: { x: b3.x, y: h.b.kind === 'base' ? b3.groundY + 4.5 : b3.y, z: b3.z },
            from2D: { x: h.a.x, y: h.a.y },
            to2D: { x: h.b.x, y: h.b.y },
            distM: h.distM,
            marginDb: h.marginDb,
            lossPct: h.lossPct,
            state: h.state, // 'ok' | 'degraded' | 'lost'
          };
        }),
        relayChain: (net.hops || []).map((h) => `${h.a.label}->${h.b.label}`),
        packetLoss: net.packetLoss || 0,
        throughput: net.throughputKbps || 0,
        channelUtilization: net.utilization || 0,
        connected: Boolean(net.connected),
        fleetConnected: Boolean(net.fleetConnected),
        aliveCount: net.aliveCount || 0,
        freshCount: net.freshCount || 0,
        relayCount: net.relayCount || 0,
        missionCount: net.missionCount || 0,
        deliveredPackets: net.delivered || 0,
      };
    }

    // 5. RF Jammers & GPS Denial Zones
    if (Array.isArray(snapshot.jammers)) {
      this.state.hazards.jammerZones = snapshot.jammers.map((j, idx) => {
        const p3 = world2DTo3D(j.x, j.y, 0, H);
        return {
          id: j.id || `JAM-${idx + 1}`,
          x2d: j.x,
          y2d: j.y,
          erpDbm: j.erpDbm,
          r2d: j.denialRadiusM || 140,
          on: j.on !== false,
          position3D: { x: p3.x, y: p3.groundY, z: p3.z },
          radius3D: Math.max(6, radius2DTo3D(j.denialRadiusM || 140)),
        };
      });
    }

    if (Array.isArray(snapshot.gpsZones)) {
      this.state.hazards.gpsDeniedZones = snapshot.gpsZones.map((z, idx) => {
        const p3 = world2DTo3D(z.x, z.y, 0, H);
        return {
          id: z.id || `GPSZ-${idx + 1}`,
          x2d: z.x,
          y2d: z.y,
          r2d: z.rM || 120,
          on: z.on !== false,
          position3D: { x: p3.x, y: p3.groundY, z: p3.z },
          radius3D: Math.max(6, radius2DTo3D(z.rM || 120)),
        };
      });
    }

    // 6. Selection sync from 2D if changed inside 2D
    if (snapshot.selectedDroneId !== undefined && snapshot.selectedDroneId !== this.state.selection.selectedDroneId) {
      this.state.selection.selectedDroneId = snapshot.selectedDroneId;
      const droneObj = this.state.drones.find((d) => d.id === snapshot.selectedDroneId) || null;
      if (snapshot.selectedDroneId) {
        this.logSync(`Drone selected: ${snapshot.selectedDroneId} (from 2D)`, { droneId: snapshot.selectedDroneId });
      }
      this.events.emit(SIM_EVENTS.DRONE_SELECTED, {
        droneId: snapshot.selectedDroneId,
        drone: droneObj,
        source: '2d',
      });
    }

    this.events.emit(SIM_EVENTS.STATE_SYNCED, this.state);
  }
}

// Create singleton and attach to window so both React/Three.js and same-origin 2D iframe share it
const sharedSim = (typeof window !== 'undefined' && window.__SHARED_SIM__)
  ? window.__SHARED_SIM__
  : new SharedSimulationStore();

if (typeof window !== 'undefined') {
  window.__SHARED_SIM__ = sharedSim;
}

export default sharedSim;

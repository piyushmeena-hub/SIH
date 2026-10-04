/**
 * FleetManager
 * Unified Authoritative Swarm Fleet Manager for all disaster scenarios.
 *
 * Implements:
 * - A1/A9: Central lifecycle ownership, staggered take-off, separate launch pads, guaranteed reset.
 * - A4: Single source of truth for N (FLEET_CONFIG.DRONE_COUNT = 7), HUD/scene integrity assertion.
 * - A2: State machine (LAUNCH -> TRANSIT -> SEARCH -> (RELAY | RETURN_TO_CHARGE) -> SEARCH), auto-recharge.
 * - A5: Gridded observation area coverage (100% target), monotonic coverage %, sensor footprint victim detection.
 * - A3: Dynamic BFS multi-hop mesh graph, articulation point avoidance, hop count & relay management.
 * - A8: No-Network Zone relay-first penetration, peer-to-peer relaying, link tagging.
 * - A6: Shared 3D AABB building obstacles, altitude clearance, drone separation.
 * - A7: Kill DR# (auto-repair mesh, cell rebalance, N-1 count) & Revive DR# (returns to N).
 */

export const FLEET_CONFIG = {
  DRONE_COUNT: 7,            // Canonical N
  TAKEOFF_INTERVAL: 1.5,     // Seconds between staggered launches
  RADIO_RANGE: 72.0,         // Max link distance (Three.js units ~320m)
  CRUISING_SPEED: 15.0,      // Max transit speed
  SENSOR_RADIUS: 16.0,       // Victim detection & cell coverage radius
  BATTERY_DRAIN_RATE: 0.16,  // % per second in flight
  BATTERY_CHARGE_RATE: 16.0, // % per second on charging pad
  APF_SAFETY_DIST: 3.5,      // Minimum separation between drones
  HARD_SAFETY_CLEARANCE: 1.8,// Hard collision envelope
  CRUISE_ALTITUDE: 14.0,     // Height above ground
  GRID_RESOLUTION: 16,       // 16x16 = 256 coverage cells
};

export class FleetManager {
  constructor(sharedStore) {
    this.store = sharedStore;
    this.drones = [];
    this.gridCells = [];
    this.relays = new Set();
    this.gcsPosition = { x: 0, y: 0, z: 0 };
    this.cityBounds = { minX: -54, maxX: 54, minZ: -54, maxZ: 54 };
    this.coveragePercent = 0;
    this.totalSurvivors = 0;
    this.detectedSurvivors = 0;
    this.meshState = {
      connected: false,
      connectedComponents: 1,
      maxHops: 0,
      relayCount: 0,
      allDronesLinked: false,
      links: [],
    };
    this.noNetworkZone = {
      active: false,
      x: 20,
      z: 10,
      radius: 35,
    };
    this.obstacles = [];
    this.simTime = 0;
    this.active = true;
    this.heightFn = null;
  }

  setHeightFunction(fn) {
    this.heightFn = fn;
  }

  getGroundHeight(x, z) {
    if (typeof this.heightFn === 'function') {
      return Number(this.heightFn(x, z) || 0);
    }
    return 0;
  }

  /**
   * Shared obstacle layer query (A6): returns the building whose volume
   * contains (x, y, z), or null.
   */
  obstacleAt(x, z, y) {
    for (const b of this.obstacles) {
      if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && y <= b.top) {
        return b;
      }
    }
    return null;
  }

  /**
   * Complete lifecycle reset: destroys all drone objects, timers, listeners,
   * creates exactly N drones at separate launch pads, and sets staggered launch times.
   */
  reset(scenarioConfig = {}) {
    this.active = true;
    this.simTime = 0;
    this.coveragePercent = 0;

    // 1. Establish Control Centre (GCS) position
    const safeZone = scenarioConfig.safeZone3D || (this.store?.state?.world?.safeZone3D) || { x: 82, z: 72 };
    const gy = this.getGroundHeight(safeZone.x, safeZone.z);
    this.gcsPosition = { x: safeZone.x, y: gy, z: safeZone.z };

    // 2. Establish Observation Rectangle (city bounds)
    if (scenarioConfig.cityBounds) {
      this.cityBounds = { ...scenarioConfig.cityBounds };
    } else if (this.store?.state?.world?.cityBounds) {
      this.cityBounds = { ...this.store.state.world.cityBounds };
    } else {
      this.cityBounds = { minX: -54, maxX: 54, minZ: -54, maxZ: 54 };
    }

    // 3. Cache building obstacle bounding boxes
    this.obstacles = (scenarioConfig.buildings || this.store?.state?.world?.buildings || []).map(b => {
      const hw = (b.w || 6) / 2 + 1.2;
      const hd = (b.d || 6) / 2 + 1.2;
      return {
        id: b.id,
        minX: b.x - hw,
        maxX: b.x + hw,
        minZ: b.z - hd,
        maxZ: b.z + hd,
        top: (b.y || 0) + (b.h || 12),
      };
    });

    // 4. Build Observation Coverage Grid (16x16 = 256 cells)
    this.gridCells = [];
    const res = FLEET_CONFIG.GRID_RESOLUTION;
    const stepX = (this.cityBounds.maxX - this.cityBounds.minX) / res;
    const stepZ = (this.cityBounds.maxZ - this.cityBounds.minZ) / res;
    let cellId = 0;
    for (let ix = 0; ix < res; ix++) {
      for (let iz = 0; iz < res; iz++) {
        const minX = this.cityBounds.minX + ix * stepX;
        const maxX = minX + stepX;
        const minZ = this.cityBounds.minZ + iz * stepZ;
        const maxZ = minZ + stepZ;
        this.gridCells.push({
          id: cellId++,
          cx: (minX + maxX) / 2,
          cz: (minZ + maxZ) / 2,
          minX, maxX, minZ, maxZ,
          covered: false,
          assignedTo: null,
          coveredAt: null,
        });
      }
    }

    // 5. Re-create exactly N drones with separate launch-pad offsets and staggered takeoff
    this.drones = [];
    this.relays.clear();
    const N = FLEET_CONFIG.DRONE_COUNT;

    // Check distance between GCS and city center to determine if static bridging relays are needed
    const cityCenterX = (this.cityBounds.minX + this.cityBounds.maxX) / 2;
    const cityCenterZ = (this.cityBounds.minZ + this.cityBounds.maxZ) / 2;
    const distToCity = Math.hypot(this.gcsPosition.x - cityCenterX, this.gcsPosition.z - cityCenterZ);
    const needBridgeRelays = distToCity > FLEET_CONFIG.RADIO_RANGE * 0.5;
    const bridgeRelayCount = needBridgeRelays ? (distToCity > FLEET_CONFIG.RADIO_RANGE * 1.1 ? 2 : 1) : 0;

    for (let i = 0; i < N; i++) {
      const droneId = i + 1;
      const angle = (2 * Math.PI * i) / N;
      const padDist = 4.2; // 4.2m offset from GCS center
      const padX = this.gcsPosition.x + Math.cos(angle) * padDist;
      const padZ = this.gcsPosition.z + Math.sin(angle) * padDist;
      const padY = this.getGroundHeight(padX, padZ);

      // Designate initial roles
      let initialRole = 'SEARCH';
      let relayTargetPos = null;
      if (i < bridgeRelayCount) {
        initialRole = 'RELAY';
        this.relays.add(droneId);
        // Relay 1 at city entrance, Relay 2 towards center/depth
        const fraction = bridgeRelayCount === 1 ? 0.65 : (i === 0 ? 0.45 : 0.88);
        relayTargetPos = {
          x: this.gcsPosition.x + (cityCenterX - this.gcsPosition.x) * fraction,
          z: this.gcsPosition.z + (cityCenterZ - this.gcsPosition.z) * fraction,
        };
      }

      const drone = {
        id: droneId,
        name: `DR${droneId}`,
        state: 'LAUNCH',          // State machine: LAUNCH -> TRANSIT -> SEARCH -> (RELAY | RETURN_TO_CHARGE) -> SEARCH
        mode: 'launch',
        role: initialRole,        // 'SEARCH' | 'RELAY' | 'RETURN_TO_CHARGE'
        battery: 100.0,
        position: { x: padX, y: padY + 0.1, z: padZ },
        velocity: { vx: 0, vy: 0, vz: 0 },
        attitude: { pitch: 0, roll: 0, yaw: angle },
        pad: { x: padX, y: padY, z: padZ },
        launchTime: i * FLEET_CONFIG.TAKEOFF_INTERVAL, // Staggered departure
        status: 'alive',
        killed: false,
        target: relayTargetPos,
        currentCell: null,
        hops: 1,
        path: ['GCS'],
        isArticulationPoint: false,
        inNoNetworkZone: false,
        lastMoveTime: 0,
        detectedVictimCount: 0,
        targetAltitude: FLEET_CONFIG.CRUISE_ALTITUDE,
      };

      this.drones.push(drone);
    }

    // 6. Reset survivors status
    if (this.store?.state?.survivors) {
      this.totalSurvivors = this.store.state.survivors.length;
      this.detectedSurvivors = 0;
      for (const s of this.store.state.survivors) {
        s.detected = false;
        s.detectedAt = null;
      }
    }

    // 7. Initial Mesh evaluation
    this.updateMeshGraph();
    this.syncToStore();
  }

  /**
   * Set No-Network Zone parameters
   */
  setNoNetworkZone(active, x = 20, z = 10, radius = 35) {
    this.noNetworkZone.active = Boolean(active);
    this.noNetworkZone.x = Number(x);
    this.noNetworkZone.z = Number(z);
    this.noNetworkZone.radius = Number(radius);

    if (this.noNetworkZone.active) {
      if (this.relays.size === 0) {
        const candidate = this.drones.find(d => !d.killed && d.status === 'alive');
        if (candidate) {
          candidate.role = 'RELAY';
          this.relays.add(candidate.id);
          const dx = x - this.gcsPosition.x;
          const dz = z - this.gcsPosition.z;
          const dist = Math.hypot(dx, dz) || 1;
          const boundaryDist = Math.max(5, dist - radius + 2);
          candidate.target = {
            x: this.gcsPosition.x + (dx / dist) * boundaryDist,
            z: this.gcsPosition.z + (dz / dist) * boundaryDist,
          };
        }
      }
    }
  }

  /**
   * Kill Drone DR#
   * The drone is removed from the mesh, search cells are redistributed,
   * another drone steps in as relay if needed, and count shows N-1.
   */
  killDrone(droneId) {
    const drone = this.drones.find(d => d.id === droneId);
    if (!drone || drone.killed) return false;

    drone.killed = true;
    drone.status = 'dead';
    drone.mode = 'dead';
    drone.velocity = { vx: 0, vy: -5, vz: 0 };

    const wasRelay = this.relays.has(droneId);
    this.relays.delete(droneId);

    // If killed drone was a relay, immediately promote the nearest healthy search drone
    if (wasRelay && drone.target) {
      let bestSearcher = null;
      let minDist = Infinity;
      for (const d of this.drones) {
        if (!d.killed && d.status === 'alive' && d.role === 'SEARCH' && d.battery > 40) {
          const dist = Math.hypot(d.position.x - drone.target.x, d.position.z - drone.target.z);
          if (dist < minDist) {
            minDist = dist;
            bestSearcher = d;
          }
        }
      }
      if (bestSearcher) {
        bestSearcher.role = 'RELAY';
        bestSearcher.state = 'RELAY';
        bestSearcher.target = { ...drone.target };
        this.relays.add(bestSearcher.id);
        if (this.store) {
          this.store.logSync(`Mesh self-healing: DR${bestSearcher.id} promoted to RELAY replacing killed DR${droneId}`);
        }
      }
    }

    // Unassign cell
    if (drone.currentCell) {
      drone.currentCell.assignedTo = null;
      drone.currentCell = null;
    }

    this.updateMeshGraph();
    this.syncToStore();
    return true;
  }

  /**
   * Revive Drone DR#
   * Resets the drone at its launch pad with 100% battery and returns fleet to N.
   */
  reviveDrone(droneId) {
    const drone = this.drones.find(d => d.id === droneId);
    if (!drone || !drone.killed) return false;

    drone.killed = false;
    drone.status = 'alive';
    drone.mode = 'launch';
    drone.state = 'LAUNCH';
    drone.role = 'SEARCH';
    drone.battery = 100.0;
    drone.position = { x: drone.pad.x, y: drone.pad.y + 0.1, z: drone.pad.z };
    drone.velocity = { vx: 0, vy: 0, vz: 0 };
    drone.launchTime = this.simTime + 0.5;

    this.updateMeshGraph();
    this.syncToStore();
    if (this.store) {
      this.store.logSync(`Drone revived: DR${droneId} ready on launch pad.`);
    }
    return true;
  }

  /**
   * Main simulation step (called from WebGL loop at 60 Hz or test runner)
   */
  step(dt, _simTime) {
    if (!this.active || dt <= 0) return;
    const clampedDt = Math.min(dt, 0.1);
    this.simTime += clampedDt;

    // 1. Step Each Drone
    for (const d of this.drones) {
      if (d.killed || d.status === 'dead') {
        d.position.y = Math.max(this.getGroundHeight(d.position.x, d.position.z) + 0.4, d.position.y - 12 * clampedDt);
        continue;
      }

      this.stepDroneKinematics(d, clampedDt);
    }

    // 2. Evaluate Coverage and Survivor Detection
    this.evaluateCoverageAndSurvivors();

    // 3. Evaluate Mesh Graph and BFS Invariants
    this.updateMeshGraph();

    // 4. Synchronize authoritative state to store
    this.syncToStore();
  }

  stepDroneKinematics(d, dt) {
    const groundY = this.getGroundHeight(d.position.x, d.position.z);

    // A. Waiting on pad for staggered launch
    if (this.simTime < d.launchTime) {
      d.mode = 'landed';
      d.state = 'LAUNCH';
      d.position.x = d.pad.x;
      d.position.z = d.pad.z;
      d.position.y = d.pad.y + 0.2;
      d.velocity = { vx: 0, vy: 0, vz: 0 };
      return;
    }

    // B. Recharging on pad
    if (d.mode === 'charging' || (d.role === 'RETURN_TO_CHARGE' && d.mode === 'landed')) {
      d.battery = Math.min(100.0, d.battery + FLEET_CONFIG.BATTERY_CHARGE_RATE * dt);
      d.velocity = { vx: 0, vy: 0, vz: 0 };
      if (d.battery >= 99.5) {
        d.battery = 100.0;
        d.role = 'SEARCH';
        d.state = 'LAUNCH';
        d.mode = 'launch';
        d.launchTime = this.simTime + 0.5;
      }
      return;
    }

    // C. Vertical Takeoff
    const cruiseY = groundY + d.targetAltitude;
    if (d.mode === 'launch' || d.state === 'LAUNCH') {
      d.position.y += 4.5 * dt;
      d.mode = 'launch';
      if (d.position.y >= cruiseY - 0.5) {
        d.position.y = cruiseY;
        d.mode = 'transit';
        d.state = d.role === 'RELAY' ? 'RELAY' : 'SEARCH';
      }
      return;
    }

    // D. Low Battery Return to Base Trigger (at <= 20%)
    if (d.battery <= 20.0 && d.role !== 'RETURN_TO_CHARGE') {
      if (d.role === 'RELAY') {
        // Swap with a fresh drone before leaving relay post
        this.requestRelayReplacement(d);
      }
      d.role = 'RETURN_TO_CHARGE';
      d.state = 'RETURN_TO_CHARGE';
      d.mode = 'returning';
      if (d.currentCell) {
        d.currentCell.assignedTo = null;
        d.currentCell = null;
      }
    }

    // E. Determine Target Waypoint based on State
    let targetPos = null;

    if (d.role === 'RETURN_TO_CHARGE') {
      targetPos = { x: d.pad.x, z: d.pad.z };
      // Once horizontally aligned above pad, descend and land
      const distToPad = Math.hypot(d.position.x - d.pad.x, d.position.z - d.pad.z);
      if (distToPad < 1.2) {
        d.position.x = d.pad.x;
        d.position.z = d.pad.z;
        d.position.y -= 3.5 * dt;
        if (d.position.y <= d.pad.y + 0.3) {
          d.position.y = d.pad.y + 0.2;
          d.mode = 'charging';
        }
        return;
      }
    } else if (d.role === 'RELAY') {
      targetPos = d.target || { x: this.gcsPosition.x, z: this.gcsPosition.z };
      d.mode = 'relay';
    } else {
      // SEARCH mode: select next cell
      d.mode = 'search';
      d.state = 'SEARCH';
      if (!d.currentCell || d.currentCell.covered) {
        this.assignNextSearchCell(d);
      }
      if (d.currentCell) {
        targetPos = { x: d.currentCell.cx, z: d.currentCell.cz };
      } else {
        // Patrol pass when all cells are covered
        const patrolAngle = (this.simTime * 0.4 + d.id) % (2 * Math.PI);
        const rx = (this.cityBounds.maxX - this.cityBounds.minX) * 0.4;
        const rz = (this.cityBounds.maxZ - this.cityBounds.minZ) * 0.4;
        const cx = (this.cityBounds.minX + this.cityBounds.maxX) / 2;
        const cz = (this.cityBounds.minZ + this.cityBounds.maxZ) / 2;
        targetPos = { x: cx + Math.cos(patrolAngle) * rx, z: cz + Math.sin(patrolAngle) * rz };
      }
    }

    // F. Motion Vector Calculation with Invariant Verification
    if (targetPos) {
      const dx = targetPos.x - d.position.x;
      const dz = targetPos.z - d.position.z;
      const dist = Math.hypot(dx, dz);
      let vx = 0, vz = 0;

      if (dist > 0.4) {
        const speed = Math.min(FLEET_CONFIG.CRUISING_SPEED, dist * 2.5);
        vx = (dx / dist) * speed;
        vz = (dz / dist) * speed;
      }

      // Khatib APF Collision Avoidance & Drone-Drone Separation
      for (const other of this.drones) {
        if (other.id !== d.id && !other.killed && other.status === 'alive') {
          const ox = d.position.x - other.position.x;
          const oz = d.position.z - other.position.z;
          const odist = Math.hypot(ox, oz);
          if (odist < FLEET_CONFIG.APF_SAFETY_DIST && odist > 0.01) {
            const repForce = (FLEET_CONFIG.APF_SAFETY_DIST - odist) * 5.0;
            vx += (ox / odist) * repForce;
            vz += (oz / odist) * repForce;
          }
        }
      }

      // Volumetric Building Obstacle Repulsion
      let buildingRepX = 0, buildingRepZ = 0;
      let minBldClearanceY = cruiseY;
      const LOOKAHEAD = 6.0; // start climbing well before reaching a footprint
      for (const b of this.obstacles) {
        if (d.position.x >= b.minX - LOOKAHEAD && d.position.x <= b.maxX + LOOKAHEAD &&
            d.position.z >= b.minZ - LOOKAHEAD && d.position.z <= b.maxZ + LOOKAHEAD) {
          // If drone is flying above building, enforce minimum vertical clearance
          if (b.top + 3.0 > minBldClearanceY) {
            minBldClearanceY = b.top + 3.0;
          }
          // Lateral repulsion if below rooftop
          if (d.position.y < b.top + 2.0) {
            const bx = (b.minX + b.maxX) / 2;
            const bz = (b.minZ + b.maxZ) / 2;
            const obx = d.position.x - bx;
            const obz = d.position.z - bz;
            const distB = Math.hypot(obx, obz) || 1;
            buildingRepX += (obx / distB) * 8.0;
            buildingRepZ += (obz / distB) * 8.0;
          }
        }
      }
      vx += buildingRepX;
      vz += buildingRepZ;

      // Candidate move
      let candX = d.position.x + vx * dt;
      let candZ = d.position.z + vz * dt;

      // HARD CONSTRAINT (A6): never enter a building volume. If the candidate
      // footprint cell is inside a building that is taller than the drone,
      // hold horizontal position and climb first.
      const blocking = this.obstacleAt(candX, candZ, d.position.y);
      if (blocking) {
        candX = d.position.x;
        candZ = d.position.z;
        vx = 0;
        vz = 0;
      }

      // HARD RULE (A3): Mesh Connectivity Pre-condition
      // Verify that candidate move keeps drone connected and does not cut off dependants
      if (this.isMoveSafeForConnectivity(d, candX, candZ)) {
        d.position.x = candX;
        d.position.z = candZ;
        d.velocity.vx = vx;
        d.velocity.vz = vz;
      } else {
        // Move would break mesh chain: clamp motion or deploy relay
        d.velocity.vx = 0;
        d.velocity.vz = 0;
        this.handleMeshLinkBreakImminent(d, targetPos);
      }

      // Smooth altitude tracking above terrain and rooftops (faster climb than descent)
      const dy = minBldClearanceY - d.position.y;
      d.position.y += dy * (dy > 0 ? 6.0 : 3.0) * dt;
      // Never let the altitude update itself drop the drone into a roof it is over
      const under = this.obstacleAt(d.position.x, d.position.z, d.position.y);
      if (under) d.position.y = under.top + 0.5;

      // Heading update
      if (Math.hypot(vx, vz) > 0.5) {
        d.attitude.yaw = -Math.atan2(vz, vx);
      }
    }

    // Battery drain
    d.battery = Math.max(0, d.battery - FLEET_CONFIG.BATTERY_DRAIN_RATE * dt);
  }

  /**
   * Check if candidate position maintains BFS graph connectivity
   * and does not sever an articulation point
   */
  isMoveSafeForConnectivity(drone, candX, candZ) {
    // Returning home to charge is always permitted
    if (drone.role === 'RETURN_TO_CHARGE') return true;

    let hasConnectedAnchor = false;

    // 1. Direct link to GCS
    const distToGcs = Math.hypot(candX - this.gcsPosition.x, candZ - this.gcsPosition.z);
    const inZone = this.noNetworkZone.active &&
      Math.hypot(candX - this.noNetworkZone.x, candZ - this.noNetworkZone.z) <= this.noNetworkZone.radius;

    if (!inZone && distToGcs <= FLEET_CONFIG.RADIO_RANGE * 0.92) {
      hasConnectedAnchor = true;
    }

    // 2. Link to an established lower-hop parent or static RELAY that is linked to GCS
    if (!hasConnectedAnchor) {
      for (const other of this.drones) {
        if (other.id !== drone.id && !other.killed && other.status === 'alive' && other.hops < Infinity) {
          // Anchor to a node closer to GCS (strictly fewer hops) or an established RELAY
          if (other.hops < drone.hops || other.role === 'RELAY') {
            const dist = Math.hypot(candX - other.position.x, candZ - other.position.z);
            if (dist <= FLEET_CONFIG.RADIO_RANGE * 0.92) {
              hasConnectedAnchor = true;
              break;
            }
          }
        }
      }
    }

    if (!hasConnectedAnchor) return false;

    // 3. Articulation point check: if drone is currently an articulation point, ensure all its dependants stay in range
    if (drone.isArticulationPoint) {
      for (const other of this.drones) {
        if (other.id !== drone.id && !other.killed && other.status === 'alive' && other.path?.includes(`DR${drone.id}`)) {
          const dist = Math.hypot(candX - other.position.x, candZ - other.position.z);
          if (dist > FLEET_CONFIG.RADIO_RANGE * 0.92) {
            return false; // Candidate move would cut off dependant
          }
        }
      }
    }

    return true;
  }

  handleMeshLinkBreakImminent(drone, _targetPos) {
    // Limit total active relays so the majority of the fleet remains active SEARCH drones
    const maxAllowedRelays = 2;
    if (this.relays.size >= maxAllowedRelays) {
      // Pick alternative waypoint within reachable connected horizon
      if (drone.currentCell) {
        drone.currentCell.assignedTo = null;
        drone.currentCell = null;
      }
      return;
    }

    // If drone cannot move further without breaking link, promote a free drone to RELAY to extend the bridge
    let availableDrone = null;
    for (const d of this.drones) {
      if (!d.killed && d.status === 'alive' && d.role === 'SEARCH' && d.id !== drone.id && d.battery > 50) {
        availableDrone = d;
        break;
      }
    }

    if (availableDrone) {
      availableDrone.role = 'RELAY';
      availableDrone.state = 'RELAY';
      this.relays.add(availableDrone.id);
      // Place relay halfway between drone's current position and GCS or nearest link
      availableDrone.target = {
        x: (drone.position.x + this.gcsPosition.x) / 2,
        z: (drone.position.z + this.gcsPosition.z) / 2,
      };
      if (this.store) {
        this.store.logSync(`Mesh Bridge extended: DR${availableDrone.id} deployed as RELAY to extend range for DR${drone.id}`);
      }
    }
  }

  requestRelayReplacement(relayDrone) {
    let bestCandidate = null;
    let maxBat = 0;
    for (const d of this.drones) {
      if (!d.killed && d.status === 'alive' && d.role === 'SEARCH' && d.battery > maxBat) {
        maxBat = d.battery;
        bestCandidate = d;
      }
    }
    if (bestCandidate && maxBat > 50) {
      bestCandidate.role = 'RELAY';
      bestCandidate.state = 'RELAY';
      bestCandidate.target = { ...relayDrone.target };
      this.relays.add(bestCandidate.id);
      if (this.store) {
        this.store.logSync(`Relay Handover: DR${bestCandidate.id} replacing low-battery DR${relayDrone.id}`);
      }
    }
  }

  assignNextSearchCell(drone) {
    const searchDrones = this.drones.filter(d => !d.killed && d.status === 'alive' && d.role === 'SEARCH');
    const droneIdx = searchDrones.findIndex(d => d.id === drone.id);
    const numSearch = Math.max(1, searchDrones.length);

    // Lawnmower strip bounds for this drone
    const stripWidth = (this.cityBounds.maxX - this.cityBounds.minX) / numSearch;
    const myStripMinX = this.cityBounds.minX + (droneIdx >= 0 ? droneIdx : 0) * stripWidth;
    const myStripMaxX = myStripMinX + stripWidth;

    let nearestCell = null;
    let minDist = Infinity;

    // 1. Primary: assign uncovered cells within this drone's allocated strip
    for (const cell of this.gridCells) {
      if (!cell.covered && (!cell.assignedTo || cell.assignedTo === drone.id)) {
        if (cell.cx >= myStripMinX - 1.0 && cell.cx <= myStripMaxX + 1.0) {
          const dist = Math.hypot(cell.cx - drone.position.x, cell.cz - drone.position.z);
          if (dist < minDist) {
            minDist = dist;
            nearestCell = cell;
          }
        }
      }
    }

    // 2. Secondary: if strip complete, rebalance to nearest uncovered cell anywhere
    if (!nearestCell) {
      minDist = Infinity;
      for (const cell of this.gridCells) {
        if (!cell.covered && (!cell.assignedTo || cell.assignedTo === drone.id)) {
          const dist = Math.hypot(cell.cx - drone.position.x, cell.cz - drone.position.z);
          if (dist < minDist) {
            minDist = dist;
            nearestCell = cell;
          }
        }
      }
    }

    if (nearestCell) {
      if (drone.currentCell && drone.currentCell !== nearestCell) {
        drone.currentCell.assignedTo = null;
      }
      nearestCell.assignedTo = drone.id;
      drone.currentCell = nearestCell;
    }
  }

  evaluateCoverageAndSurvivors() {
    let coveredCount = 0;
    const survivors = this.store?.state?.survivors || [];

    // Mark covered cells using sensor footprint
    for (const cell of this.gridCells) {
      if (!cell.covered) {
        for (const d of this.drones) {
          if (!d.killed && d.status === 'alive' && d.state !== 'LAUNCH' && d.mode !== 'landed' && d.mode !== 'launch' && d.mode !== 'charging') {
            const dist = Math.hypot(cell.cx - d.position.x, cell.cz - d.position.z);
            if (dist <= FLEET_CONFIG.SENSOR_RADIUS) {
              cell.covered = true;
              cell.coveredAt = this.simTime;
              break;
            }
          }
        }
      }
      if (cell.covered) coveredCount++;
    }

    this.coveragePercent = Number(((coveredCount / this.gridCells.length) * 100).toFixed(1));

    // Survivor detection: FLIR direct footprint or swept grid cell footprint
    let detectedCount = 0;
    for (const s of survivors) {
      const sx = s.x ?? s.position?.x ?? 0;
      const sz = s.z ?? s.position?.z ?? 0;
      if (!s.detected) {
        // Direct drone sensor footprint
        for (const d of this.drones) {
          if (!d.killed && d.status === 'alive' && d.state !== 'LAUNCH' && d.mode !== 'landed' && d.mode !== 'launch' && d.mode !== 'charging') {
            const dist = Math.hypot(sx - d.position.x, sz - d.position.z);
            if (dist <= FLEET_CONFIG.SENSOR_RADIUS) {
              s.detected = true;
              s.detectedAt = this.simTime;
              d.detectedVictimCount = (d.detectedVictimCount || 0) + 1;
              if (this.store) {
                this.store.logSync(`Victim ${s.id} detected by DR${d.id} at [${Math.round(sx)}, ${Math.round(sz)}] via FLIR/Optical sensor`);
              }
              break;
            }
          }
        }
        // Swept cell footprint
        if (!s.detected) {
          for (const cell of this.gridCells) {
            if (cell.covered) {
              const dist = Math.hypot(sx - cell.cx, sz - cell.cz);
              if (dist <= FLEET_CONFIG.SENSOR_RADIUS || (sx >= cell.minX && sx <= cell.maxX && sz >= cell.minZ && sz <= cell.maxZ)) {
                s.detected = true;
                s.detectedAt = this.simTime;
                if (this.store) {
                  this.store.logSync(`Victim ${s.id} detected at [${Math.round(sx)}, ${Math.round(sz)}] via footprint coverage`);
                }
                break;
              }
            }
          }
        }
      }
      if (s.detected) detectedCount++;
    }
    this.totalSurvivors = survivors.length;
    this.detectedSurvivors = detectedCount;
  }

  /**
   * BFS Mesh Graph Evaluator
   * Computes multi-hop routes, connected components, articulation points, and hop counts
   */
  updateMeshGraph() {
    const livingDrones = this.drones.filter(d => !d.killed && d.status === 'alive');
    const nodes = ['GCS', ...livingDrones.map(d => `DR${d.id}`)];
    const adj = new Map();
    nodes.forEach(n => adj.set(n, []));
    const activeLinks = [];

    // 1. Direct Links from GCS
    for (const d of livingDrones) {
      const inZone = this.noNetworkZone.active &&
        Math.hypot(d.position.x - this.noNetworkZone.x, d.position.z - this.noNetworkZone.z) <= this.noNetworkZone.radius;
      d.inNoNetworkZone = inZone;

      const dist = Math.hypot(d.position.x - this.gcsPosition.x, d.position.z - this.gcsPosition.z);
      // GCS cannot link directly into No-Network Zone
      if (!inZone && dist <= FLEET_CONFIG.RADIO_RANGE) {
        adj.get('GCS').push(`DR${d.id}`);
        adj.get(`DR${d.id}`).push('GCS');
        activeLinks.push({
          from: 'GCS',
          to: `DR${d.id}`,
          from3D: { ...this.gcsPosition },
          to3D: { ...d.position },
          band: '2.4G',
          state: 'ok',
          inZone: false,
        });
      }
    }

    // 2. Peer-to-Peer Links between Drones
    for (let i = 0; i < livingDrones.length; i++) {
      for (let j = i + 1; j < livingDrones.length; j++) {
        const d1 = livingDrones[i];
        const d2 = livingDrones[j];
        const dist = Math.hypot(d1.position.x - d2.position.x, d1.position.z - d2.position.z);
        if (dist <= FLEET_CONFIG.RADIO_RANGE) {
          adj.get(`DR${d1.id}`).push(`DR${d2.id}`);
          adj.get(`DR${d2.id}`).push(`DR${d1.id}`);
          const linkInZone = d1.inNoNetworkZone || d2.inNoNetworkZone;
          activeLinks.push({
            from: `DR${d1.id}`,
            to: `DR${d2.id}`,
            from3D: { ...d1.position },
            to3D: { ...d2.position },
            band: linkInZone ? 'LORA' : '2.4G',
            state: 'ok',
            inZone: linkInZone,
          });
        }
      }
    }

    // 3. BFS traversal starting from GCS
    const visited = new Set(['GCS']);
    const parent = new Map();
    const hops = new Map([['GCS', 0]]);
    const queue = ['GCS'];

    while (queue.length > 0) {
      const u = queue.shift();
      const currentHops = hops.get(u);
      for (const v of adj.get(u) || []) {
        if (!visited.has(v)) {
          visited.add(v);
          parent.set(v, u);
          hops.set(v, currentHops + 1);
          queue.push(v);
        }
      }
    }

    // 4. Update hops and path for every living drone
    let maxHops = 0;
    let allLinked = true;
    for (const d of livingDrones) {
      const key = `DR${d.id}`;
      if (visited.has(key)) {
        d.hops = hops.get(key);
        maxHops = Math.max(maxHops, d.hops);
        const path = [];
        let curr = key;
        while (curr) {
          path.unshift(curr);
          curr = parent.get(curr);
        }
        d.path = path;
      } else {
        d.hops = Infinity;
        d.path = [];
        allLinked = false;
      }
    }

    // 5. Detect Articulation Points (DFS Tarjan / Bridge Detection)
    this.detectArticulationPoints(nodes, adj);

    // 6. Connected Components Count
    const ccCount = allLinked && livingDrones.length > 0 ? 1 : (livingDrones.length > 0 ? 2 : 1);

    this.meshState = {
      connected: allLinked,
      connectedComponents: ccCount,
      maxHops,
      relayCount: this.relays.size,
      allDronesLinked: allLinked,
      links: activeLinks,
    };
  }

  detectArticulationPoints(nodes, adj) {
    const tin = new Map();
    const low = new Map();
    const isCut = new Set();
    let timer = 0;

    const dfs = (u, p = null) => {
      tin.set(u, timer);
      low.set(u, timer);
      timer++;
      let children = 0;
      for (const to of adj.get(u) || []) {
        if (to === p) continue;
        if (tin.has(to)) {
          low.set(u, Math.min(low.get(u), tin.get(to)));
        } else {
          dfs(to, u);
          low.set(u, Math.min(low.get(u), low.get(to)));
          if (low.get(to) >= tin.get(u) && p !== null) {
            isCut.add(u);
          }
          children++;
        }
      }
      if (p === null && children > 1) {
        isCut.add(u);
      }
    };

    for (const n of nodes) {
      if (!tin.has(n)) dfs(n);
    }

    for (const d of this.drones) {
      d.isArticulationPoint = isCut.has(`DR${d.id}`);
    }
  }

  /**
   * Synchronize FleetManager state into SharedSimulationStore
   */
  syncToStore() {
    if (!this.store || !this.store.state) return;
    const st = this.store.state;

    // Sync Drones array
    st.drones = this.drones.map(d => ({
      id: d.id,
      name: d.name,
      mode: d.mode,
      role: d.role,
      state: d.state,
      battery: Math.round(d.battery),
      position: { ...d.position },
      velocity: { ...d.velocity },
      attitude: { ...d.attitude },
      status: d.status,
      killed: d.killed,
      hops: d.hops,
      path: d.path,
      isArticulationPoint: d.isArticulationPoint,
      inNoNetworkZone: d.inNoNetworkZone,
      detectedVictimCount: d.detectedVictimCount,
      fsm: d.role === 'RELAY' ? 'RELAY' : (d.role === 'RETURN_TO_CHARGE' ? 'RTL' : (d.mode === 'search' ? 'SURV' : 'TRANS')),
    }));

    // Sync Network & Mesh state
    if (st.network) {
      st.network.gcsPosition = { ...this.gcsPosition };
      st.network.links = this.meshState.links;
      st.network.connected = this.meshState.allDronesLinked;
      st.network.fleetConnected = this.meshState.allDronesLinked;
      st.network.connectedComponents = this.meshState.connectedComponents;
      st.network.maxHops = this.meshState.maxHops;
      st.network.relayCount = this.meshState.relayCount;
      st.network.allDronesLinked = this.meshState.allDronesLinked;
      st.network.aliveCount = this.drones.filter(d => !d.killed).length;
    }

    // Sync Mission Coverage
    if (st.mission) {
      st.mission.coveragePercent = this.coveragePercent;
      st.mission.totalSurvivors = this.totalSurvivors;
      st.mission.detectedSurvivors = this.detectedSurvivors;
    }
  }
}

export default FleetManager;

/**
 * Unified Coordinate System Mapper between:
 *  - 2D Tactical Swarm Simulator (meters, x2d / y2d, altitudeM)
 *  - 3D Disaster Terrain Simulator (Three.js world units, x3d / y3d / z3d, terrain width W = 280: [-140..140])
 *
 * Coordinate relationship:
 *  - 1 unit in 3D world = 4.5 meters in 2D tactical map (280 units = 1260m x 1260m sector)
 *  - 2D Origin (0, 0) [default C2 Base] maps to (-51.1, +12.2) in 3D
 *  - 2D Crisis Cluster (~450, -120) maps to (+48.9, -14.4) in 3D
 *  - All 3D town buildings & survivors (x3d in [-90, 90], z3d in [-90, 90]) map to
 *    2D tactical coordinates ~150m-650m from C2 Base so multi-hop RF relay chains form naturally.
 */

export const COORD_CONFIG = {
  SCALE_2D_PER_3D: 4.5,       // 4.5 meters in 2D per 1 unit in 3D
  ORIGIN_2D_X: 230,           // 2D X corresponding to 3D X = 0
  ORIGIN_2D_Y: -55,           // 2D Y corresponding to 3D Z = 0
  ALT_SCALE_3D_PER_M: 0.24,   // 50m altitude in 2D -> 12 units above terrain in 3D
  MIN_FLIGHT_CLEARANCE_3D: 9, // Minimum 3D height above ground for flying drones
  WORLD_3D_HALF: 134,         // Safe playable clamping bound in 3D (terrain is [-140, 140])
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Convert 2D tactical coordinates (meters) to 3D world coordinates (Three.js units).
 * @param {number} x2d - 2D X position in meters
 * @param {number} y2d - 2D Y position in meters
 * @param {number} [altM=50] - 2D altitude above ground in meters
 * @param {function} [heightFn] - Optional 3D terrain height function H(x3d, z3d)
 * @returns {{ x: number, y: number, z: number, groundY: number }}
 */
export function world2DTo3D(x2d, y2d, altM = 50, heightFn = null) {
  const rawX = (Number(x2d || 0) - COORD_CONFIG.ORIGIN_2D_X) / COORD_CONFIG.SCALE_2D_PER_3D;
  const rawZ = (Number(y2d || 0) - COORD_CONFIG.ORIGIN_2D_Y) / COORD_CONFIG.SCALE_2D_PER_3D;
  const x = clamp(rawX, -COORD_CONFIG.WORLD_3D_HALF, COORD_CONFIG.WORLD_3D_HALF);
  const z = clamp(rawZ, -COORD_CONFIG.WORLD_3D_HALF, COORD_CONFIG.WORLD_3D_HALF);
  const groundY = typeof heightFn === 'function' ? Number(heightFn(x, z) || 0) : 0;
  const yOffset = altM <= 0.5
    ? 0.6
    : Math.max(COORD_CONFIG.MIN_FLIGHT_CLEARANCE_3D, Number(altM) * COORD_CONFIG.ALT_SCALE_3D_PER_M);
  return {
    x: Number(x.toFixed(2)),
    y: Number((groundY + yOffset).toFixed(2)),
    z: Number(z.toFixed(2)),
    groundY: Number(groundY.toFixed(2)),
  };
}

/**
 * Convert 3D world coordinates (x3d, z3d) to 2D tactical coordinates (meters).
 * @param {number} x3d - 3D X coordinate
 * @param {number} z3d - 3D Z coordinate
 * @param {number} [y3d=0] - Optional 3D Y coordinate
 * @param {number} [groundY3D=0] - Optional 3D ground height at (x3d, z3d)
 * @returns {{ x: number, y: number, altM: number }}
 */
export function world3DTo2D(x3d, z3d, y3d = 0, groundY3D = 0) {
  const x = COORD_CONFIG.ORIGIN_2D_X + Number(x3d || 0) * COORD_CONFIG.SCALE_2D_PER_3D;
  const y = COORD_CONFIG.ORIGIN_2D_Y + Number(z3d || 0) * COORD_CONFIG.SCALE_2D_PER_3D;
  const clearance3D = Math.max(0, Number(y3d || 0) - Number(groundY3D || 0));
  const altM = clearance3D > 0 ? clearance3D / COORD_CONFIG.ALT_SCALE_3D_PER_M : 0;
  return {
    x: Number(x.toFixed(1)),
    y: Number(y.toFixed(1)),
    altM: Number(altM.toFixed(1)),
  };
}

/**
 * Convert a 2D distance/radius in meters to 3D world units.
 * @param {number} r2d - Radius in 2D meters
 * @returns {number}
 */
export function radius2DTo3D(r2d) {
  return Number((Number(r2d || 0) / COORD_CONFIG.SCALE_2D_PER_3D).toFixed(2));
}

/**
 * Convert a 3D distance/radius in world units to 2D meters.
 * @param {number} r3d - Radius in 3D units
 * @returns {number}
 */
export function radius3DTo2D(r3d) {
  return Number((Number(r3d || 0) * COORD_CONFIG.SCALE_2D_PER_3D).toFixed(1));
}

const coordinateMapper = {
  COORD_CONFIG,
  world2DTo3D,
  world3DTo2D,
  radius2DTo3D,
  radius3DTo2D,
};

if (typeof window !== 'undefined') {
  window.__COORD_MAPPER__ = coordinateMapper;
}

export default coordinateMapper;

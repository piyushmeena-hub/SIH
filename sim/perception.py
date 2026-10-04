"""Perception & State Estimation Subsystem.

Components:
1. 3D Synthetic LiDAR Engine (360x30 beam array with Gaussian noise sigma=0.03m)
2. OctoMap 3D Log-Odds Voxel Mapping (with Shannon spatial entropy tracking)
3. 9-State Extended Kalman Filter (EKF tracking pos, vel, euler angles with GPS-denied handling)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Sequence, Set, Tuple

import numpy as np


# ============================================================================
# 1. 3D SYNTHETIC LIDAR ENGINE
# ============================================================================

@dataclass
class PointCloud:
    """Structured point cloud container."""
    points: np.ndarray          # (N, 3) float32 [x, y, z] in world frame
    ranges: np.ndarray          # (N,) float32 distance in meters
    intensities: np.ndarray     # (N,) float32 simulated reflectivity [0.0, 1.0]
    ray_dirs: np.ndarray        # (N, 3) normalized ray directions in world frame
    origin: np.ndarray          # (3,) sensor origin [x, y, z] in world frame
    timestamp: float            # simulation epoch in seconds

    def __len__(self) -> int:
        return len(self.points)


@dataclass
class BoxObstacle:
    """Axis-Aligned or Oriented 3D Bounding Box representing rubble/buildings."""
    min_pt: np.ndarray          # (3,) [min_x, min_y, min_z]
    max_pt: np.ndarray          # (3,) [max_x, max_y, max_z]
    material: str = "rubble"    # "rubble", "concrete", "metal", "vegetation"
    reflectivity: float = 0.6   # typical LiDAR reflectivity


class SyntheticLiDAR:
    """3D Synthetic LiDAR Engine.
    
    Generates realistic 360° horizontal x 30° vertical beam array point clouds,
    sampling terrain meshes and rubble structures with zero-mean Gaussian noise.
    """

    def __init__(
        self,
        h_beams: int = 180,              # Horizontal azimuth samples (360° FOV)
        v_beams: int = 16,               # Vertical elevation samples (30° FOV: -15° to +15°)
        min_range: float = 0.2,          # Minimum detection range (m)
        max_range: float = 80.0,         # Maximum detection range (m)
        noise_sigma: float = 0.03,       # Zero-mean Gaussian measurement noise sigma (m)
        seed: Optional[int] = None,
    ):
        self.h_beams = h_beams
        self.v_beams = v_beams
        self.min_range = min_range
        self.max_range = max_range
        self.noise_sigma = noise_sigma
        self.rng = np.random.default_rng(seed)

        # Precompute spherical beam array: 360° horizontal x 30° vertical (-15° to +15°)
        azimuths = np.linspace(-np.pi, np.pi, self.h_beams, endpoint=False)
        elevations = np.linspace(np.radians(-15.0), np.radians(15.0), self.v_beams)
        az_grid, el_grid = np.meshgrid(azimuths, elevations)
        az_flat = az_grid.flatten()
        el_flat = el_grid.flatten()

        # Unit vectors in sensor body frame (X: forward, Y: left, Z: up)
        cos_el = np.cos(el_flat)
        self.body_ray_dirs = np.stack(
            [
                cos_el * np.cos(az_flat),
                cos_el * np.sin(az_flat),
                np.sin(el_flat),
            ],
            axis=-1,
        ).astype(np.float32)  # (N_beams, 3)

        # Environment obstacles (buildings, collapsed walls, rubble)
        self.obstacles: List[BoxObstacle] = []
        self._default_ground_z = 0.0

    def add_obstacle(self, min_pt: Sequence[float], max_pt: Sequence[float], material: str = "rubble", reflectivity: float = 0.6) -> None:
        """Register a 3D rubble or building block."""
        self.obstacles.append(
            BoxObstacle(
                min_pt=np.array(min_pt, dtype=np.float32),
                max_pt=np.array(max_pt, dtype=np.float32),
                material=material,
                reflectivity=reflectivity,
            )
        )

    def populate_default_urban_disaster_scene(self) -> None:
        """Populates a representative urban earthquake disaster zone with collapsed rubble."""
        self.obstacles.clear()
        # Buildings and collapsed debris clusters
        self.add_obstacle([-40, -40, 0], [-20, -20, 25], "concrete", 0.65)   # Standing high-rise
        self.add_obstacle([20, -35, 0], [45, -15, 18], "concrete", 0.60)     # Damaged office
        self.add_obstacle([-15, 20, 0], [15, 45, 12], "concrete", 0.55)      # Partially collapsed school
        # Rubble fields (crushed concrete, rebar, collapsed slabs)
        self.add_obstacle([-10, -10, 0], [10, 10, 4.5], "rubble", 0.50)      # Central rubble pile
        self.add_obstacle([25, 10, 0], [35, 25, 3.0], "rubble", 0.48)       # Debris block
        self.add_obstacle([-35, 10, 0], [-22, 22, 5.0], "rubble", 0.52)     # Collapsed warehouse
        self.add_obstacle([5, -30, 0], [18, -18, 3.8], "rubble", 0.45)      # Debris slope

    @staticmethod
    def _euler_to_rotation_matrix(roll: float, pitch: float, yaw: float) -> np.ndarray:
        """Z-Y-X Tait-Bryan rotation matrix."""
        cr, sr = np.cos(roll), np.sin(roll)
        cp, sp = np.cos(pitch), np.sin(pitch)
        cy, sy = np.cos(yaw), np.sin(yaw)

        R = np.array([
            [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
            [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
            [-sp,     cp * sr,                cp * cr                ],
        ], dtype=np.float32)
        return R

    def scan(
        self,
        drone_pos: np.ndarray,
        drone_euler: Tuple[float, float, float] = (0.0, 0.0, 0.0),
        timestamp: float = 0.0,
    ) -> PointCloud:
        """Cast ray array into 3D environment, intersect meshes/boxes, and inject Gaussian noise."""
        origin = np.asarray(drone_pos, dtype=np.float32).reshape(3)
        R = self._euler_to_rotation_matrix(*drone_euler)
        world_dirs = (self.body_ray_dirs @ R.T).astype(np.float32)  # (N, 3)

        n_rays = len(world_dirs)
        hit_ranges = np.full(n_rays, self.max_range, dtype=np.float32)
        hit_reflectivity = np.full(n_rays, 0.25, dtype=np.float32)

        # 1. Ground plane intersection (z = ground_z)
        z_dirs = world_dirs[:, 2]
        downward_mask = z_dirs < -1e-4
        if np.any(downward_mask):
            t_ground = (self._default_ground_z - origin[2]) / z_dirs[downward_mask]
            valid_g = (t_ground >= self.min_range) & (t_ground < hit_ranges[downward_mask])
            indices_g = np.where(downward_mask)[0][valid_g]
            hit_ranges[indices_g] = t_ground[valid_g]
            hit_reflectivity[indices_g] = 0.35  # Ground asphalt/dirt reflectivity

        # 2. Rubble and building bounding box ray intersections (Kay-Kajiya slab method)
        orig_x, orig_y, orig_z = origin[0], origin[1], origin[2]
        dir_x = world_dirs[:, 0]
        dir_y = world_dirs[:, 1]
        dir_z = world_dirs[:, 2]

        safe_dx = np.where(np.abs(dir_x) > 1e-6, dir_x, np.sign(dir_x + 1e-12) * 1e-6)
        inv_dx = 1.0 / safe_dx
        safe_dy = np.where(np.abs(dir_y) > 1e-6, dir_y, np.sign(dir_y + 1e-12) * 1e-6)
        inv_dy = 1.0 / safe_dy
        safe_dz = np.where(np.abs(dir_z) > 1e-6, dir_z, np.sign(dir_z + 1e-12) * 1e-6)
        inv_dz = 1.0 / safe_dz

        for obs in self.obstacles:
            tx1 = (obs.min_pt[0] - orig_x) * inv_dx
            tx2 = (obs.max_pt[0] - orig_x) * inv_dx
            tmin_x = np.minimum(tx1, tx2)
            tmax_x = np.maximum(tx1, tx2)

            ty1 = (obs.min_pt[1] - orig_y) * inv_dy
            ty2 = (obs.max_pt[1] - orig_y) * inv_dy
            tmin_y = np.minimum(ty1, ty2)
            tmax_y = np.maximum(ty1, ty2)

            tz1 = (obs.min_pt[2] - orig_z) * inv_dz
            tz2 = (obs.max_pt[2] - orig_z) * inv_dz
            tmin_z = np.minimum(tz1, tz2)
            tmax_z = np.maximum(tz1, tz2)

            t_enter = np.maximum(np.maximum(tmin_x, tmin_y), tmin_z)
            t_exit = np.minimum(np.minimum(tmax_x, tmax_y), tmax_z)

            hit_mask = (t_exit >= t_enter) & (t_enter >= self.min_range) & (t_enter < hit_ranges)
            if np.any(hit_mask):
                hit_ranges[hit_mask] = t_enter[hit_mask]
                hit_reflectivity[hit_mask] = obs.reflectivity

        # Filter valid returns (within max range)
        valid_mask = hit_ranges < (self.max_range - 1e-2)
        valid_ranges = hit_ranges[valid_mask]
        valid_dirs = world_dirs[valid_mask]
        valid_reflect = hit_reflectivity[valid_mask]

        # Inject zero-mean Gaussian measurement noise: sigma = 0.03 m
        noise = self.rng.normal(0.0, self.noise_sigma, size=len(valid_ranges)).astype(np.float32)
        noisy_ranges = np.clip(valid_ranges + noise, self.min_range, self.max_range)

        # Reconstruct 3D hit points in world coordinates
        points = origin + valid_dirs * noisy_ranges[:, np.newaxis]

        # Range-dependent intensity attenuation: I = I_0 / (1 + 0.01 * r^2)
        intensities = np.clip(valid_reflect / (1.0 + 0.005 * (noisy_ranges ** 1.8)), 0.05, 1.0)

        return PointCloud(
            points=points.astype(np.float32),
            ranges=noisy_ranges.astype(np.float32),
            intensities=intensities.astype(np.float32),
            ray_dirs=valid_dirs.astype(np.float32),
            origin=origin.astype(np.float32),
            timestamp=float(timestamp),
        )


# ============================================================================
# 2. OCTOMAP 3D LOG-ODDS VOXEL MAPPING
# ============================================================================

class VoxelState(Enum):
    UNMAPPED = 0
    FREE_SPACE = 1
    OCCUPIED_RUBBLE = 2


@dataclass
class MapEntropyMetrics:
    total_entropy_bits: float
    mean_entropy_per_voxel: float
    mapped_volume_m3: float
    occupied_count: int
    free_count: int
    unmapped_count: int
    entropy_reduction_ratio: float  # [0.0 = completely unmapped, 1.0 = fully certain]


class OctoMap3D:
    """3D Occupancy Grid Mapping structure using Log-Odds updates and spatial entropy tracking.
    
    Log-Odds equations:
      L(m | z_1:t) = L(m | z_1:t-1) + l_occ (endpoints)
      L(m | z_1:t) = L(m | z_1:t-1) - l_free (ray traversal)
      P(m) = 1 / (1 + exp(-L))
    """

    def __init__(
        self,
        voxel_res: float = 0.5,           # Voxel resolution in meters
        p_occ_hit: float = 0.72,          # Probability of hit update
        p_free_miss: float = 0.40,        # Probability of miss update
        p_min: float = 0.12,              # Lower clamping limit
        p_max: float = 0.97,              # Upper clamping limit
        p_thresh_occ: float = 0.65,       # Classification threshold for occupied rubble
        p_thresh_free: float = 0.35,      # Classification threshold for free space
    ):
        self.res = float(voxel_res)
        self.inv_res = 1.0 / self.res

        # Convert probabilities to log-odds
        self.l_occ = math.log(p_occ_hit / (1.0 - p_occ_hit))
        self.l_free = math.log(p_free_miss / (1.0 - p_free_miss))  # negative
        self.l_min = math.log(p_min / (1.0 - p_min))
        self.l_max = math.log(p_max / (1.0 - p_max))

        self.thresh_occ_log = math.log(p_thresh_occ / (1.0 - p_thresh_occ))
        self.thresh_free_log = math.log(p_thresh_free / (1.0 - p_thresh_free))

        # Sparse voxel storage: key = (ix, iy, iz), value = log-odds float
        self.voxels: Dict[Tuple[int, int, int], float] = {}

    def world_to_grid(self, pt: np.ndarray) -> Tuple[int, int, int]:
        """Convert continuous 3D world coordinate to integer voxel indices."""
        return (
            int(math.floor(pt[0] * self.inv_res)),
            int(math.floor(pt[1] * self.inv_res)),
            int(math.floor(pt[2] * self.inv_res)),
        )

    def grid_to_world(self, idx: Tuple[int, int, int]) -> np.ndarray:
        """Convert integer voxel indices to cell center in 3D world coordinates."""
        return (np.array(idx, dtype=np.float32) + 0.5) * self.res

    def _ray_traversal_3d(
        self,
        start_idx: Tuple[int, int, int],
        end_idx: Tuple[int, int, int],
    ) -> List[Tuple[int, int, int]]:
        """3D Bresenham / Amanatides-Woo line algorithm for free-space voxel traversal."""
        x0, y0, z0 = start_idx
        x1, y1, z1 = end_idx

        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        dz = abs(z1 - z0)

        sx = 1 if x1 > x0 else -1
        sy = 1 if y1 > y0 else -1
        sz = 1 if z1 > z0 else -1

        free_cells: List[Tuple[int, int, int]] = []

        if dx >= dy and dx >= dz:
            p1 = 2 * dy - dx
            p2 = 2 * dz - dx
            while x0 != x1:
                free_cells.append((x0, y0, z0))
                x0 += sx
                if p1 >= 0:
                    y0 += sy
                    p1 -= 2 * dx
                if p2 >= 0:
                    z0 += sz
                    p2 -= 2 * dx
                p1 += 2 * dy
                p2 += 2 * dz
        elif dy >= dx and dy >= dz:
            p1 = 2 * dx - dy
            p2 = 2 * dz - dy
            while y0 != y1:
                free_cells.append((x0, y0, z0))
                y0 += sy
                if p1 >= 0:
                    x0 += sx
                    p1 -= 2 * dy
                if p2 >= 0:
                    z0 += sz
                    p2 -= 2 * dy
                p1 += 2 * dx
                p2 += 2 * dz
        else:
            p1 = 2 * dy - dz
            p2 = 2 * dx - dz
            while z0 != z1:
                free_cells.append((x0, y0, z0))
                z0 += sz
                if p1 >= 0:
                    y0 += sy
                    p1 -= 2 * dz
                if p2 >= 0:
                    x0 += sx
                    p2 -= 2 * dz
                p1 += 2 * dy
                p2 += 2 * dx

        return free_cells

    def update_from_point_cloud(self, point_cloud: PointCloud, max_free_range: float = 30.0) -> None:
        """Update voxel log-odds from a PointCloud scan."""
        origin_pt = point_cloud.origin
        start_idx = self.world_to_grid(origin_pt)

        # Batch free updates to deduplicate within single sweep
        visited_free_cells: Set[Tuple[int, int, int]] = set()

        for pt, r in zip(point_cloud.points, point_cloud.ranges):
            end_idx = self.world_to_grid(pt)

            # 1. Update endpoint as occupied rubble
            curr_l = self.voxels.get(end_idx, 0.0)
            self.voxels[end_idx] = min(self.l_max, curr_l + self.l_occ)

            # 2. Trace free space along ray up to hit point
            if r <= max_free_range:
                ray_cells = self._ray_traversal_3d(start_idx, end_idx)
                for cell in ray_cells:
                    visited_free_cells.add(cell)

        # Apply negative log-odds (free space)
        for cell in visited_free_cells:
            # Don't overwrite confirmed occupied cells unless repeatedly cleared
            curr_l = self.voxels.get(cell, 0.0)
            self.voxels[cell] = max(self.l_min, curr_l + self.l_free)

    def get_voxel_probability(self, idx: Tuple[int, int, int]) -> float:
        """Convert stored log-odds to occupancy probability P(m)."""
        l = self.voxels.get(idx, 0.0)
        return 1.0 / (1.0 + math.exp(-l))

    def get_voxel_state(self, idx: Tuple[int, int, int]) -> VoxelState:
        """Classify voxel into OCCUPIED_RUBBLE, FREE_SPACE, or UNMAPPED."""
        l = self.voxels.get(idx, 0.0)
        if l >= self.thresh_occ_log:
            return VoxelState.OCCUPIED_RUBBLE
        elif l <= self.thresh_free_log:
            return VoxelState.FREE_SPACE
        return VoxelState.UNMAPPED

    def get_occupied_points(self) -> np.ndarray:
        """Returns (M, 3) coordinates of all confirmed occupied rubble voxels."""
        pts = [
            self.grid_to_world(idx)
            for idx, l in self.voxels.items()
            if l >= self.thresh_occ_log
        ]
        if not pts:
            return np.zeros((0, 3), dtype=np.float32)
        return np.array(pts, dtype=np.float32)

    def compute_entropy_metrics(self) -> MapEntropyMetrics:
        """Calculate Shannon spatial entropy of the mapped voxel volume.
        
        H(p) = - [p * log2(p) + (1-p) * log2(1-p)]
        For unmapped cells with prior p=0.5, H(0.5) = 1.0 bit (maximum uncertainty).
        As voxels are surveyed to free (p->0) or occupied (p->1), H drops toward 0.
        """
        total_cells = len(self.voxels)
        if total_cells == 0:
            return MapEntropyMetrics(
                total_entropy_bits=0.0,
                mean_entropy_per_voxel=1.0,
                mapped_volume_m3=0.0,
                occupied_count=0,
                free_count=0,
                unmapped_count=0,
                entropy_reduction_ratio=0.0,
            )

        total_entropy = 0.0
        n_occ = 0
        n_free = 0
        n_unmapped = 0

        for l in self.voxels.values():
            p = 1.0 / (1.0 + math.exp(-l))
            # Clamp to prevent math domain error in log2
            p = min(max(p, 1e-6), 1.0 - 1e-6)
            h = -(p * math.log2(p) + (1.0 - p) * math.log2(1.0 - p))
            total_entropy += h

            if l >= self.thresh_occ_log:
                n_occ += 1
            elif l <= self.thresh_free_log:
                n_free += 1
            else:
                n_unmapped += 1

        mean_entropy = total_entropy / total_cells
        voxel_vol = self.res ** 3
        mapped_volume = total_cells * voxel_vol

        # Entropy reduction ratio: 0.0 = completely uncertain (1 bit/voxel), 1.0 = absolute certainty (0 bit/voxel)
        reduction_ratio = max(0.0, min(1.0, 1.0 - mean_entropy))

        return MapEntropyMetrics(
            total_entropy_bits=float(total_entropy),
            mean_entropy_per_voxel=float(mean_entropy),
            mapped_volume_m3=float(mapped_volume),
            occupied_count=n_occ,
            free_count=n_free,
            unmapped_count=n_unmapped,
            entropy_reduction_ratio=float(reduction_ratio),
        )


# ============================================================================
# 3. 9-STATE EXTENDED KALMAN FILTER (EKF)
# ============================================================================

class ExtendedKalmanFilter9State:
    """9-State Extended Kalman Filter for UAV State Estimation in GPS-denied environments.
    
    State vector x:
      x = [p_x, p_y, p_z, v_x, v_y, v_z, roll, pitch, yaw]^T in R^9
    
    Inertial frame: NED (North, East, Down) or Local ENU (East, North, Up).
    Default configuration: Local ENU where:
      p_x: East (m)
      p_y: North (m)
      p_z: Altitude above ground (m)
      g = [0, 0, -9.81] m/s^2
    """

    def __init__(
        self,
        init_pos: Optional[np.ndarray] = None,
        init_vel: Optional[np.ndarray] = None,
        init_euler: Optional[np.ndarray] = None,
        sigma_accel: float = 0.15,      # IMU accelerometer noise (m/s^2)
        sigma_gyro: float = 0.015,      # IMU gyroscope noise (rad/s)
        sigma_gps_pos: float = 0.8,     # Nominal GPS horizontal noise (m)
        sigma_baro: float = 0.25,       # Barometer altitude noise (m)
    ):
        # State: [px, py, pz, vx, vy, vz, roll, pitch, yaw]
        self.x = np.zeros(9, dtype=np.float64)
        if init_pos is not None:
            self.x[0:3] = init_pos
        if init_vel is not None:
            self.x[3:6] = init_vel
        if init_euler is not None:
            self.x[6:9] = init_euler

        # State covariance P (9x9)
        self.P = np.diag([
            1.0, 1.0, 1.0,           # Pos: 1 m^2
            0.5, 0.5, 0.5,           # Vel: 0.5 (m/s)^2
            0.05, 0.05, 0.1,         # Att: ~0.05-0.1 rad^2
        ]).astype(np.float64)

        # Process noise parameters
        self.sigma_accel = sigma_accel
        self.sigma_gyro = sigma_gyro
        self.sigma_gps_pos = sigma_gps_pos
        self.sigma_baro = sigma_baro

        # Gravity vector in world frame
        self.g = np.array([0.0, 0.0, -9.80665], dtype=np.float64)

        # GPS Health & Urban Canyon Tracking
        self.gps_denied = False
        self.gps_outage_time = 0.0
        self.hdop = 1.0
        self.last_update_time = 0.0

    @staticmethod
    def _rotation_matrix(roll: float, pitch: float, yaw: float) -> np.ndarray:
        """World rotation matrix from Euler angles (ZYX body-to-world)."""
        cr, sr = math.cos(roll), math.sin(roll)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cy, sy = math.cos(yaw), math.sin(yaw)

        return np.array([
            [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
            [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
            [-sp,     cp * sr,                cp * cr                ],
        ], dtype=np.float64)

    @staticmethod
    def _euler_rate_matrix(roll: float, pitch: float) -> np.ndarray:
        """Kinematic matrix mapping body gyro rates [wx, wy, wz] to [roll_dot, pitch_dot, yaw_dot]."""
        cr, sr = math.cos(roll), math.sin(roll)
        cp = math.cos(pitch)
        tp = math.tan(pitch)
        if abs(cp) < 1e-4:
            cp = 1e-4 * (1.0 if cp >= 0 else -1.0)

        return np.array([
            [1.0, sr * tp, cr * tp],
            [0.0, cr,      -sr    ],
            [0.0, sr / cp, cr / cp],
        ], dtype=np.float64)

    def predict(self, accel_imu: np.ndarray, gyro_imu: np.ndarray, dt: float) -> None:
        """High-frequency IMU strapdown mechanization step.
        
        Args:
            accel_imu: (3,) specific force measurement from accelerometer [ax, ay, az] in body frame
            gyro_imu: (3,) angular rate measurement from gyroscope [wx, wy, wz] in body frame
            dt: integration time step in seconds
        """
        if dt <= 0.0:
            return

        dt = float(dt)
        pos = self.x[0:3]
        vel = self.x[3:6]
        phi, theta, psi = self.x[6], self.x[7], self.x[8]

        # 1. Transform body accelerometer to world frame and subtract gravity
        R_b2w = self._rotation_matrix(phi, theta, psi)
        accel_world = R_b2w @ accel_imu + self.g

        # 2. Attitude kinematics
        W = self._euler_rate_matrix(phi, theta)
        euler_dot = W @ gyro_imu

        # 3. State integration
        self.x[0:3] = pos + vel * dt + 0.5 * accel_world * (dt ** 2)
        self.x[3:6] = vel + accel_world * dt
        self.x[6:9] = self.x[6:9] + euler_dot * dt

        # Wrap yaw to [-pi, pi]
        self.x[8] = (self.x[8] + math.pi) % (2.0 * math.pi) - math.pi

        # 4. State transition Jacobian F (9x9)
        F = np.eye(9, dtype=np.float64)
        F[0:3, 3:6] = np.eye(3) * dt

        # Derivatives of R_b2w * a_imu with respect to euler angles [phi, theta, psi]
        # Analytical approximation for small dt
        ax, ay, az = accel_imu[0], accel_imu[1], accel_imu[2]
        cr, sr = math.cos(phi), math.sin(phi)
        cp, sp = math.cos(theta), math.sin(theta)
        cy, sy = math.cos(yaw := psi), math.sin(psi)

        # d(accel_world)/d(phi, theta, psi)
        dR_dphi = np.array([
            [0, cy * sp * cr + sy * sr, -cy * sp * sr + sy * cr],
            [0, sy * sp * cr - cy * sr, -sy * sp * sr - cy * cr],
            [0, cp * cr,                -cp * sr               ],
        ], dtype=np.float64)

        dR_dtheta = np.array([
            [-cy * sp, cy * cp * sr, cy * cp * cr],
            [-sy * sp, sy * cp * sr, sy * cp * cr],
            [-cp,      -sp * sr,     -sp * cr    ],
        ], dtype=np.float64)

        dR_dyaw = np.array([
            [-sy * cp, -sy * sp * sr - cy * cr, -sy * sp * cr + cy * sr],
            [cy * cp,  cy * sp * sr - sy * cr,  cy * sp * cr + sy * sr ],
            [0,        0,                       0                      ],
        ], dtype=np.float64)

        d_acc_dphi = dR_dphi @ accel_imu
        d_acc_dtheta = dR_dtheta @ accel_imu
        d_acc_dyaw = dR_dyaw @ accel_imu

        F[3:6, 6] = d_acc_dphi * dt
        F[3:6, 7] = d_acc_dtheta * dt
        F[3:6, 8] = d_acc_dyaw * dt

        F[0:3, 6] = 0.5 * d_acc_dphi * (dt ** 2)
        F[0:3, 7] = 0.5 * d_acc_dtheta * (dt ** 2)
        F[0:3, 8] = 0.5 * d_acc_dyaw * (dt ** 2)

        # Attitude self-transition
        F[6:9, 6:9] = np.eye(3)

        # 5. Process Noise Covariance Q (9x9)
        Q = np.zeros((9, 9), dtype=np.float64)
        q_pos = (self.sigma_accel ** 2) * (dt ** 4) / 4.0
        q_vel = (self.sigma_accel ** 2) * (dt ** 2)
        q_att = (self.sigma_gyro ** 2) * (dt ** 2)

        for i in range(3):
            Q[i, i] = q_pos
            Q[i + 3, i + 3] = q_vel
            Q[i + 6, i + 6] = q_att

        # Covariance propagation: P = F * P * F^T + Q
        self.P = F @ self.P @ F.T + Q
        # Enforce symmetry
        self.P = 0.5 * (self.P + self.P.T)

    def update_gps(
        self,
        gps_pos: np.ndarray,
        gps_vel: Optional[np.ndarray] = None,
        hdop: float = 1.0,
        is_denied: bool = False,
    ) -> bool:
        """Fuse noisy GPS measurements with urban canyon degradation handling.
        
        Args:
            gps_pos: (3,) measured [px, py, pz]
            gps_vel: (3,) optional measured [vx, vy, vz]
            hdop: Horizontal Dilution of Precision (1.0 = ideal, > 4.0 = degraded)
            is_denied: boolean flag indicating GPS denial / jamming / canyon blackout
        """
        self.hdop = float(hdop)
        self.gps_denied = is_denied or (hdop > 4.5)

        if self.gps_denied:
            # Under GPS denial: suppress direct position updates to avoid bad fixes
            # Covariance naturally inflates during prediction, indicating loss of lock
            return False

        # Construct measurement vector z and model matrix H
        if gps_vel is not None:
            z = np.hstack([gps_pos, gps_vel])
            H = np.zeros((6, 9), dtype=np.float64)
            H[0:3, 0:3] = np.eye(3)
            H[3:6, 3:6] = np.eye(3)
            # Covariance scaled by HDOP
            r_pos = (self.sigma_gps_pos * max(1.0, hdop)) ** 2
            r_vel = (0.3 * max(1.0, hdop)) ** 2
            R = np.diag([r_pos, r_pos, r_pos * 2.0, r_vel, r_vel, r_vel]).astype(np.float64)
            z_pred = self.x[0:6]
        else:
            z = np.asarray(gps_pos, dtype=np.float64)
            H = np.zeros((3, 9), dtype=np.float64)
            H[0:3, 0:3] = np.eye(3)
            r_pos = (self.sigma_gps_pos * max(1.0, hdop)) ** 2
            R = np.diag([r_pos, r_pos, r_pos * 2.0]).astype(np.float64)
            z_pred = self.x[0:3]

        # Innovation (residual)
        y = z - z_pred

        # Innovation covariance S = H * P * H^T + R
        S = H @ self.P @ H.T + R

        # Chi-squared Mahalanobis gating to reject multipath spikes in urban canyons
        try:
            inv_S = np.linalg.inv(S)
            mahalanobis_sq = float(y.T @ inv_S @ y)
            gate_threshold = 16.27 if len(z) == 3 else 27.88  # Chi-sq 99.9% confidence
            if mahalanobis_sq > gate_threshold:
                # Outlier rejected
                return False

            # Kalman Gain: K = P * H^T * S^-1
            K = self.P @ H.T @ inv_S

            # State update: x = x + K * y
            self.x = self.x + K @ y

            # Covariance update (Joseph form for numerical stability):
            # P = (I - K*H) * P * (I - K*H)^T + K * R * K^T
            I_KH = np.eye(9) - K @ H
            self.P = I_KH @ self.P @ I_KH.T + K @ R @ K.T
            self.P = 0.5 * (self.P + self.P.T)
            return True
        except np.linalg.LinAlgError:
            return False

    def update_barometer(self, baro_alt: float) -> bool:
        """Fuse barometric altitude measurement (p_z)."""
        z = float(baro_alt)
        H = np.zeros((1, 9), dtype=np.float64)
        H[0, 2] = 1.0  # p_z

        y = z - self.x[2]
        r = self.sigma_baro ** 2
        s = float(self.P[2, 2] + r)

        if s <= 1e-6:
            return False

        k = self.P[:, 2] / s  # (9,)
        self.x = self.x + k * y

        # Covariance update
        I_kH = np.eye(9) - np.outer(k, H[0])
        self.P = I_kH @ self.P @ I_kH.T + np.outer(k, k) * r
        self.P = 0.5 * (self.P + self.P.T)
        return True

    @property
    def position(self) -> np.ndarray:
        return self.x[0:3].copy()

    @property
    def velocity(self) -> np.ndarray:
        return self.x[3:6].copy()

    @property
    def euler_angles(self) -> np.ndarray:
        return self.x[6:9].copy()

    @property
    def position_uncertainty_std(self) -> np.ndarray:
        """Returns 1-sigma uncertainty standard deviation [std_x, std_y, std_z]."""
        return np.sqrt(np.maximum(0.0, np.diag(self.P)[0:3]))

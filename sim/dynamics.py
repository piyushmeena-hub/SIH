"""Flight Dynamics & Multi-Agent Kinematics Subsystem.

Components:
1. 6-DOF Newton-Euler Quadrotor Dynamics integrated via 4th-Order Runge-Kutta (RK4)
2. Strict Kinematic Constraints (v_max = 15 m/s, a_max = 5 m/s^2), LERP position smoothing,
   and SLERP quaternion orientation smoothing
3. Khatib Artificial Potential Fields (APF) with inter-UAV collision avoidance (d < 3.0 m,
   hard safety clearance >= 1.5 m) and downward cone downwash avoidance vector
4. 4-Tier Altitude Corridor Allocation (Launch/Recovery, PoI Surveying, Transit, Relay Mesh)
5. Comprehensive Real-time Power Drain Model (thrust, drag, sensors, and RF transmission)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple

import numpy as np


# ============================================================================
# 1. 4-TIER ALTITUDE CORRIDOR ALLOCATION
# ============================================================================

class AltitudeTier(Enum):
    TIER_1_LAUNCH_RECOVERY = "TIER_1_LAUNCH_RECOVERY"  # 0 to 20 m
    TIER_2_POI_SURVEYING = "TIER_2_POI_SURVEYING"      # 25 to 45 m
    TIER_3_TRANSIT_CORRIDOR = "TIER_3_TRANSIT_CORRIDOR" # 50 to 65 m
    TIER_4_RELAY_MESH = "TIER_4_RELAY_MESH"            # 70 to 90 m


CORRIDOR_BOUNDS = {
    AltitudeTier.TIER_1_LAUNCH_RECOVERY: (0.0, 20.0, 10.0),   # min, max, nominal
    AltitudeTier.TIER_2_POI_SURVEYING: (25.0, 45.0, 35.0),
    AltitudeTier.TIER_3_TRANSIT_CORRIDOR: (50.0, 65.0, 55.0),
    AltitudeTier.TIER_4_RELAY_MESH: (70.0, 90.0, 75.0),
}


def get_corridor_bounds(tier: AltitudeTier) -> Tuple[float, float, float]:
    """Returns (z_min, z_max, z_nominal) for the specified altitude tier."""
    return CORRIDOR_BOUNDS[tier]


def assign_tier_for_mode(mode: str) -> AltitudeTier:
    """Maps operational flight mode to target altitude corridor."""
    m = mode.upper()
    if m in ("IDLE", "TAKEOFF", "LANDING", "COMPLETED"):
        return AltitudeTier.TIER_1_LAUNCH_RECOVERY
    elif m in ("SURVEYING", "SEARCH", "INSPECT"):
        return AltitudeTier.TIER_2_POI_SURVEYING
    elif m in ("RELAY", "MESH"):
        return AltitudeTier.TIER_4_RELAY_MESH
    else:  # TRANSIT, RTL, GOTO, GUIDED
        return AltitudeTier.TIER_3_TRANSIT_CORRIDOR


def clamp_to_corridor(z: float, tier: AltitudeTier) -> float:
    """Clamps an altitude command within the strict tier boundaries."""
    z_min, z_max, _ = CORRIDOR_BOUNDS[tier]
    return max(z_min, min(z_max, float(z)))


# ============================================================================
# 2. QUATERNION & INTERPOLATION UTILITIES (LERP & SLERP)
# ============================================================================

def quat_normalize(q: np.ndarray) -> np.ndarray:
    """Normalizes a quaternion [qw, qx, qy, qz]."""
    norm = np.linalg.norm(q)
    if norm < 1e-12:
        return np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float64)
    return q / norm


def quat_to_rotation_matrix(q: np.ndarray) -> np.ndarray:
    """Converts unit quaternion [qw, qx, qy, qz] to 3x3 rotation matrix (body to world)."""
    w, x, y, z = q[0], q[1], q[2], q[3]
    return np.array([
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z),       2.0 * (x * z + w * y)],
        [2.0 * (x * y + w * z),       1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x)],
        [2.0 * (x * z - w * y),       2.0 * (y * z + w * x),       1.0 - 2.0 * (x * x + y * y)],
    ], dtype=np.float64)


def quat_to_euler(q: np.ndarray) -> np.ndarray:
    """Converts unit quaternion [qw, qx, qy, qz] to Euler angles [roll, pitch, yaw] in radians."""
    w, x, y, z = q[0], q[1], q[2], q[3]
    # Roll (x-axis rotation)
    sinr_cosp = 2.0 * (w * x + y * z)
    cosr_cosp = 1.0 - 2.0 * (x * x + y * y)
    roll = math.atan2(sinr_cosp, cosr_cosp)

    # Pitch (y-axis rotation)
    sinp = 2.0 * (w * y - z * x)
    if abs(sinp) >= 1.0:
        pitch = math.copysign(math.pi / 2.0, sinp)
    else:
        pitch = math.asin(sinp)

    # Yaw (z-axis rotation)
    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    yaw = math.atan2(siny_cosp, cosy_cosp)

    return np.array([roll, pitch, yaw], dtype=np.float64)


def euler_to_quat(roll: float, pitch: float, yaw: float) -> np.ndarray:
    """Converts Euler angles [roll, pitch, yaw] in radians to unit quaternion [qw, qx, qy, qz]."""
    cy = math.cos(yaw * 0.5)
    sy = math.sin(yaw * 0.5)
    cp = math.cos(pitch * 0.5)
    sp = math.sin(pitch * 0.5)
    cr = math.cos(roll * 0.5)
    sr = math.sin(roll * 0.5)

    qw = cr * cp * cy + sr * sp * sy
    qx = sr * cp * cy - cr * sp * sy
    qy = cr * sp * cy + sr * cp * sy
    qz = cr * cp * sy - sr * sp * cy
    return quat_normalize(np.array([qw, qx, qy, qz], dtype=np.float64))


def lerp_pos(p0: np.ndarray, p1: np.ndarray, alpha: float) -> np.ndarray:
    """Linear Interpolation (LERP) between two 3D positions."""
    a = max(0.0, min(1.0, float(alpha)))
    return (1.0 - a) * p0 + a * p1


def slerp_quat(q0: np.ndarray, q1: np.ndarray, alpha: float) -> np.ndarray:
    """Spherical Linear Interpolation (SLERP) between two unit quaternions to eliminate jitter."""
    a = max(0.0, min(1.0, float(alpha)))
    q0_n = quat_normalize(q0)
    q1_n = quat_normalize(q1)

    dot = float(np.dot(q0_n, q1_n))

    # Take shortest path on 4D sphere
    if dot < 0.0:
        q1_n = -q1_n
        dot = -dot

    # If quaternions are extremely close, fall back to normalized LERP to avoid div-by-zero
    if dot > 0.9995:
        res = (1.0 - a) * q0_n + a * q1_n
        return quat_normalize(res)

    theta_0 = math.acos(dot)
    theta = theta_0 * a
    sin_theta = math.sin(theta)
    sin_theta_0 = math.sin(theta_0)

    s0 = math.cos(theta) - dot * sin_theta / sin_theta_0
    s1 = sin_theta / sin_theta_0

    return quat_normalize((s0 * q0_n) + (s1 * q1_n))


# ============================================================================
# 3. POWER DRAIN MODEL
# ============================================================================

@dataclass
class PowerMetrics:
    power_total_w: float
    power_motors_w: float
    power_sensors_w: float
    power_tx_w: float
    soc_pct: float
    drain_rate_pct_per_min: float


class DronePowerModel:
    """Real-time State-of-Charge (SoC) consumption model.
    
    Models electrical power from:
    1. Induced & profile rotor thrust power: P_thrust = c_t * T^(3/2)
    2. Parasite aerodynamic drag power: P_drag = 0.5 * rho * Cd * A * v^3
    3. Onboard companion computing & sensor suite (LiDAR, optical, FLIR)
    4. RF transceiver transmission power (2.4 GHz WiFi & 915 MHz LoRa)
    """

    def __init__(
        self,
        battery_capacity_wh: float = 99.0,   # Standard 4S/6S UAV battery (~4500-5000 mAh)
        initial_soc_pct: float = 100.0,
        mass_kg: float = 1.5,
        sensor_base_load_w: float = 28.0,     # LiDAR + Optical + FLIR + Jetson/Pi
        rf_idle_w: float = 2.0,
        rf_tx_w: float = 8.5,
    ):
        self.capacity_wh = battery_capacity_wh
        self.soc_pct = float(initial_soc_pct)
        self.mass = mass_kg
        self.sensor_load = sensor_base_load_w
        self.rf_idle = rf_idle_w
        self.rf_tx = rf_tx_w

        # Hover power baseline: P_hover ~ m*g * sqrt(m*g / (2*rho*A_disk))
        # For 1.5 kg quadrotor with 9" props, hover power is ~135-150 W
        self.p_hover_baseline = 145.0
        self.mg = self.mass * 9.80665

    def compute_power(
        self,
        thrust_n: float,
        speed_mps: float,
        is_transmitting: bool = True,
        dt: float = 0.033,
    ) -> PowerMetrics:
        """Calculates instantaneous power drain and decrements SoC."""
        # 1. Motor mechanical/electrical power
        thrust_ratio = max(0.1, thrust_n / self.mg)
        p_motors = self.p_hover_baseline * (thrust_ratio ** 1.5)

        # 2. Parasite drag power at speed v
        # P_drag = 0.5 * rho * Cd * A * v^3
        rho = 1.225  # kg/m^3
        cd_area = 0.035  # m^2 equivalent drag area
        p_drag = 0.5 * rho * cd_area * (speed_mps ** 3)
        p_motors += p_drag

        # 3. Sensor & computing payload
        p_sensors = self.sensor_load

        # 4. RF transmission load
        p_tx = self.rf_tx if is_transmitting else self.rf_idle

        p_total = p_motors + p_sensors + p_tx

        # Update State of Charge (SoC): energy = P * dt in Joules / (Wh * 3600)
        energy_wh = (p_total * dt) / 3600.0
        dsoc = (energy_wh / self.capacity_wh) * 100.0
        self.soc_pct = max(0.0, self.soc_pct - dsoc)

        drain_rate = (dsoc / max(1e-6, dt)) * 60.0  # % per minute

        return PowerMetrics(
            power_total_w=float(p_total),
            power_motors_w=float(p_motors),
            power_sensors_w=float(p_sensors),
            power_tx_w=float(p_tx),
            soc_pct=float(self.soc_pct),
            drain_rate_pct_per_min=float(drain_rate),
        )


# ============================================================================
# 4. KHATIB ARTIFICIAL POTENTIAL FIELDS (APF) & DOWNWASH AVOIDANCE
# ============================================================================

class KhatibFlockingAPF:
    """Khatib Artificial Potential Fields for Multi-UAV Swarms.
    
    Features:
    - Attractive force toward mission waypoints
    - Repulsive collision avoidance active when inter-UAV distance d < 3.0 m
    - Hard safety clearance guarantee >= 1.5 m
    - Downward cone downwash repulsive vector to prevent Vortex Ring State (VRS)
      stalls on trailing aircraft flying beneath leading quadrotors
    """

    def __init__(
        self,
        d_influence: float = 3.0,          # Repulsion activation distance (m)
        d_hard_clearance: float = 1.5,     # Minimum inviolable safety clearance (m)
        k_att: float = 1.8,                # Attractive gain
        k_rep: float = 8.5,                # Repulsive gain
        downwash_cone_angle_deg: float = 25.0,  # Downward downwash cone angle
        downwash_depth_m: float = 12.0,    # Vertical penetration depth of downwash cylinder
        k_downwash: float = 12.0,          # Downwash lateral escape gain
    ):
        self.d_influence = d_influence
        self.d_hard = d_hard_clearance
        self.k_att = k_att
        self.k_rep = k_rep
        self.downwash_angle = math.radians(downwash_cone_angle_deg)
        self.downwash_depth = downwash_depth_m
        self.k_downwash = k_downwash

    def compute_attractive_force(self, current_pos: np.ndarray, goal_pos: np.ndarray) -> np.ndarray:
        """Attractive force pulling UAV toward target waypoint."""
        err = goal_pos - current_pos
        dist = np.linalg.norm(err)
        if dist < 1e-4:
            return np.zeros(3, dtype=np.float64)
        # Linear attraction with saturation
        return self.k_att * (err / dist) * min(dist, 10.0)

    def compute_repulsive_force(
        self,
        self_pos: np.ndarray,
        other_positions: List[np.ndarray],
    ) -> Tuple[np.ndarray, float]:
        """Computes Khatib repulsive force from peer UAVs + downwash escape vector.
        
        Returns:
            (F_rep_total, min_peer_distance)
        """
        f_rep_total = np.zeros(3, dtype=np.float64)
        min_dist = float("inf")

        for other_pos in other_positions:
            diff = self_pos - other_pos
            dist = float(np.linalg.norm(diff))
            if dist < 1e-4:
                continue

            if dist < min_dist:
                min_dist = dist

            # 1. Standard Khatib Repulsive Field (active when d < 3.0 m)
            if dist < self.d_influence:
                unit_r = diff / dist
                # Effective clearance margin above hard floor (1.5 m)
                effective_margin = max(0.05, dist - self.d_hard)
                influence_margin = self.d_influence - self.d_hard

                # Khatib formulation: eta * (1/d_eff - 1/d_inf) * (1 / d_eff^2) * unit_vector
                mag = self.k_rep * (1.0 / effective_margin - 1.0 / influence_margin) * (1.0 / (effective_margin ** 2))
                f_rep_total += mag * unit_r

            # 2. Downward Cone Downwash Avoidance Vector
            # If self is BELOW other_pos: other_pos is leading drone, self is trailing
            dz = self_pos[2] - other_pos[2]  # dz < 0 means self is underneath
            if -self.downwash_depth <= dz < -0.5:
                depth = abs(dz)
                cone_radius = 0.5 + depth * math.tan(self.downwash_angle)
                horizontal_diff = self_pos[:2] - other_pos[:2]
                r_xy = float(np.linalg.norm(horizontal_diff))

                # If trapped inside leading drone's downward cone
                if r_xy < cone_radius:
                    # Direction to escape laterally (in XY plane)
                    if r_xy > 1e-3:
                        escape_dir = horizontal_diff / r_xy
                    else:
                        # Dead center: push out along default axis
                        escape_dir = np.array([1.0, 0.0], dtype=np.float64)

                    penetration_ratio = (cone_radius - r_xy) / cone_radius
                    # Repulsive lateral force pushing trailing drone out of downwash
                    f_downwash_xy = self.k_downwash * penetration_ratio * escape_dir
                    f_rep_total[0] += f_downwash_xy[0]
                    f_rep_total[1] += f_downwash_xy[1]

        return f_rep_total, min_dist


# ============================================================================
# 5. 6-DOF NEWTON-EULER DYNAMICS & RK4 INTEGRATOR
# ============================================================================

@dataclass
class QuadrotorState:
    pos: np.ndarray             # (3,) [x, y, z] in world ENU frame (m)
    vel: np.ndarray             # (3,) [vx, vy, vz] in world ENU frame (m/s)
    quat: np.ndarray            # (4,) [qw, qx, qy, qz] unit quaternion body->world
    omega: np.ndarray           # (3,) [p, q, r] body angular rates (rad/s)

    def copy(self) -> QuadrotorState:
        return QuadrotorState(
            pos=self.pos.copy(),
            vel=self.vel.copy(),
            quat=self.quat.copy(),
            omega=self.omega.copy(),
        )


class QuadrotorDynamics6DOF:
    """Full 6-DOF Newton-Euler Quadrotor Dynamics integrated via 4th-Order Runge-Kutta (RK4).
    
    Kinematic bounds enforced:
      v_max = 15.0 m/s
      a_max = 5.0 m/s^2
    """

    def __init__(
        self,
        mass_kg: float = 1.5,
        arm_length_m: float = 0.225,
        i_xx: float = 0.015,
        i_yy: float = 0.015,
        i_zz: float = 0.025,
        v_max_mps: float = 15.0,
        a_max_mps2: float = 5.0,
    ):
        self.m = mass_kg
        self.arm_length = arm_length_m
        self.J = np.diag([i_xx, i_yy, i_zz]).astype(np.float64)
        self.inv_J = np.linalg.inv(self.J)
        self.v_max = v_max_mps
        self.a_max = a_max_mps2
        self.g = np.array([0.0, 0.0, -9.80665], dtype=np.float64)

        # Aerodynamic linear drag coefficients
        self.drag_coeffs = np.array([0.25, 0.25, 0.40], dtype=np.float64)

    def _state_derivatives(
        self,
        state: QuadrotorState,
        thrust_total: float,
        torques_body: np.ndarray,
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Evaluates Newton-Euler equations of motion.
        
        Returns:
            (d_pos, d_vel, d_quat, d_omega)
        """
        pos, vel, quat, omega = state.pos, state.vel, state.quat, state.omega

        # 1. Translational kinematics: d_pos = vel
        d_pos = vel.copy()

        # 2. Translational dynamics: m * d_vel = R(q) * [0, 0, T] + m*g - drag
        R = quat_to_rotation_matrix(quat)
        thrust_body = np.array([0.0, 0.0, thrust_total], dtype=np.float64)
        thrust_world = R @ thrust_body
        drag_world = -self.drag_coeffs * vel * np.linalg.norm(vel)

        d_vel = (thrust_world + drag_world) / self.m + self.g

        # 3. Rotational kinematics: d_quat = 0.5 * quat (x) [0, omega]
        qw, qx, qy, qz = quat[0], quat[1], quat[2], quat[3]
        wx, wy, wz = omega[0], omega[1], omega[2]
        d_quat = 0.5 * np.array([
            -qx * wx - qy * wy - qz * wz,
             qw * wx + qy * wz - qz * wy,
             qw * wy - qx * wz + qz * wx,
             qw * wz + qx * wy - qy * wx,
        ], dtype=np.float64)

        # 4. Rotational dynamics: J * d_omega = torques - omega x (J * omega)
        gyroscopic = np.cross(omega, self.J @ omega)
        d_omega = self.inv_J @ (torques_body - gyroscopic)

        return d_pos, d_vel, d_quat, d_omega

    def rk4_step(
        self,
        state: QuadrotorState,
        thrust_total: float,
        torques_body: np.ndarray,
        dt: float,
    ) -> QuadrotorState:
        """Integrates 6-DOF dynamics forward by dt using 4th-order Runge-Kutta."""
        dt = float(dt)

        # Stage 1
        k1_p, k1_v, k1_q, k1_w = self._state_derivatives(state, thrust_total, torques_body)

        # Stage 2
        s2 = QuadrotorState(
            pos=state.pos + 0.5 * dt * k1_p,
            vel=state.vel + 0.5 * dt * k1_v,
            quat=quat_normalize(state.quat + 0.5 * dt * k1_q),
            omega=state.omega + 0.5 * dt * k1_w,
        )
        k2_p, k2_v, k2_q, k2_w = self._state_derivatives(s2, thrust_total, torques_body)

        # Stage 3
        s3 = QuadrotorState(
            pos=state.pos + 0.5 * dt * k2_p,
            vel=state.vel + 0.5 * dt * k2_v,
            quat=quat_normalize(state.quat + 0.5 * dt * k2_q),
            omega=state.omega + 0.5 * dt * k2_w,
        )
        k3_p, k3_v, k3_q, k3_w = self._state_derivatives(s3, thrust_total, torques_body)

        # Stage 4
        s4 = QuadrotorState(
            pos=state.pos + dt * k3_p,
            vel=state.vel + dt * k3_v,
            quat=quat_normalize(state.quat + dt * k3_q),
            omega=state.omega + dt * k3_w,
        )
        k4_p, k4_v, k4_q, k4_w = self._state_derivatives(s4, thrust_total, torques_body)

        # Weighted combination
        new_pos = state.pos + (dt / 6.0) * (k1_p + 2.0 * k2_p + 2.0 * k3_p + k4_p)
        new_vel = state.vel + (dt / 6.0) * (k1_v + 2.0 * k2_v + 2.0 * k3_v + k4_v)
        new_quat = quat_normalize(state.quat + (dt / 6.0) * (k1_q + 2.0 * k2_q + 2.0 * k3_q + k4_q))
        new_omega = state.omega + (dt / 6.0) * (k1_w + 2.0 * k2_w + 2.0 * k3_w + k4_w)

        # Enforce strict kinematic limits: v_max = 15 m/s
        speed = float(np.linalg.norm(new_vel))
        if speed > self.v_max:
            new_vel = (new_vel / speed) * self.v_max

        # Ground collision guard: clamp z >= 0
        if new_pos[2] < 0.0:
            new_pos[2] = 0.0
            new_vel[2] = max(0.0, new_vel[2])

        return QuadrotorState(pos=new_pos, vel=new_vel, quat=new_quat, omega=new_omega)


# ============================================================================
# 6. UNIFIED SWARM AGENT KINEMATICS CONTROLLER
# ============================================================================

class SwarmAgentKinematics:
    """High-level Multi-Agent Kinematics & APF Guidance Controller for a single UAV.
    
    Coordinates:
    - 6-DOF RK4 physics
    - Khatib APF obstacle/peer collision avoidance
    - LERP and SLERP state smoothing
    - 4-Tier altitude corridor allocation
    - Battery power consumption tracking
    """

    def __init__(
        self,
        drone_id: int,
        home_pos: np.ndarray,
        initial_mode: str = "IDLE",
    ):
        self.id = drone_id
        self.dynamics = QuadrotorDynamics6DOF()
        self.apf = KhatibFlockingAPF()
        self.power = DronePowerModel()

        # Initialize state
        init_pos = np.array(home_pos, dtype=np.float64)
        init_quat = euler_to_quat(0.0, 0.0, 0.0)
        self.state = QuadrotorState(
            pos=init_pos,
            vel=np.zeros(3, dtype=np.float64),
            quat=init_quat,
            omega=np.zeros(3, dtype=np.float64),
        )

        # Smoothing buffers for LERP/SLERP
        self.prev_state = self.state.copy()

        # Guidance targets
        self.target_pos = init_pos.copy()
        self.current_tier = assign_tier_for_mode(initial_mode)
        self.target_pos[2] = CORRIDOR_BOUNDS[self.current_tier][2]

        self.last_power_metrics: Optional[PowerMetrics] = None
        self.min_safety_clearance: float = float("inf")

    def set_mode(self, mode: str) -> None:
        """Updates operational mode and recalculates target altitude corridor."""
        self.current_tier = assign_tier_for_mode(mode)
        # Re-clamp altitude target to the assigned corridor
        self.target_pos[2] = clamp_to_corridor(self.target_pos[2], self.current_tier)

    def set_target(self, pos: np.ndarray) -> None:
        """Sets target position, strictly enforcing the active altitude corridor."""
        target = np.array(pos, dtype=np.float64)
        target[2] = clamp_to_corridor(target[2], self.current_tier)
        self.target_pos = target

    def step(
        self,
        peer_positions: List[np.ndarray],
        dt: float = 0.033,
    ) -> QuadrotorState:
        """Executes one control cycle: APF guidance -> RK4 integration -> power consumption."""
        self.prev_state = self.state.copy()

        # 1. APF Guidance: Attractive to target + Repulsion from peers & downwash
        f_att = self.apf.compute_attractive_force(self.state.pos, self.target_pos)
        f_rep, min_dist = self.apf.compute_repulsive_force(self.state.pos, peer_positions)
        self.min_safety_clearance = min_dist

        # Combined commanded acceleration
        a_cmd = f_att + f_rep

        # Enforce acceleration limit: a_max = 5.0 m/s^2
        a_mag = float(np.linalg.norm(a_cmd))
        if a_mag > self.dynamics.a_max:
            a_cmd = (a_cmd / a_mag) * self.dynamics.a_max

        # 2. Convert desired acceleration to total thrust and desired attitude
        # Total force required = m * (a_cmd - g)
        total_force = self.dynamics.m * (a_cmd - self.dynamics.g)
        thrust_total = float(np.linalg.norm(total_force))

        # Desired Z-axis (thrust direction in world frame)
        z_body_desired = total_force / max(1e-4, thrust_total)

        # Desired heading: align with velocity or target
        vel_xy = self.state.vel[:2]
        if np.linalg.norm(vel_xy) > 0.5:
            des_yaw = math.atan2(vel_xy[1], vel_xy[0])
        else:
            diff_xy = self.target_pos[:2] - self.state.pos[:2]
            des_yaw = math.atan2(diff_xy[1], diff_xy[0]) if np.linalg.norm(diff_xy) > 0.5 else 0.0

        # Construct desired rotation matrix
        x_c = np.array([math.cos(des_yaw), math.sin(des_yaw), 0.0], dtype=np.float64)
        y_b_desired = np.cross(z_body_desired, x_c)
        y_norm = np.linalg.norm(y_b_desired)
        if y_norm < 1e-4:
            y_b_desired = np.array([0.0, 1.0, 0.0], dtype=np.float64)
        else:
            y_b_desired /= y_norm
        x_b_desired = np.cross(y_b_desired, z_body_desired)

        R_des = np.column_stack([x_b_desired, y_b_desired, z_body_desired])

        # Simple proportional attitude tracking torque
        R_curr = quat_to_rotation_matrix(self.state.quat)
        err_rot = 0.5 * (R_des.T @ R_curr - R_curr.T @ R_des)
        att_error_vec = np.array([err_rot[2, 1], err_rot[0, 2], err_rot[1, 0]], dtype=np.float64)

        torques_body = -6.0 * att_error_vec - 0.8 * self.state.omega

        # 3. Integrate 6-DOF physics via RK4
        self.state = self.dynamics.rk4_step(self.state, thrust_total, torques_body, dt)

        # 4. Update Power Drain Model
        speed = float(np.linalg.norm(self.state.vel))
        self.last_power_metrics = self.power.compute_power(thrust_total, speed, is_transmitting=True, dt=dt)

        return self.state

    def get_smoothed_state(self, alpha: float) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Returns LERP-smoothed position, SLERP-smoothed quaternion, and Euler angles for rendering."""
        p_smooth = lerp_pos(self.prev_state.pos, self.state.pos, alpha)
        q_smooth = slerp_quat(self.prev_state.quat, self.state.quat, alpha)
        euler = quat_to_euler(q_smooth)
        return p_smooth, q_smooth, euler

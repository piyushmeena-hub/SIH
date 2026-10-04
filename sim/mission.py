"""Swarm Autonomy & Mission Orchestration Subsystem.

Components:
1. 10-State MAVSDK Finite State Machine (IDLE -> TAKEOFF -> TRANSIT -> SURVEYING -> RELAY -> DATA_TX -> RTL -> LANDING -> COMPLETED -> FAILSAFE)
2. Consensus-Based Bundle Algorithm (CBBA) for decentralized task allocation (Survivor Search > Structural Collapse > Hazard Inspection)
3. Virtual Spring Mesh (VSM) Relay Positioning with spring-damper dynamics
4. Skyline Bridging with elevation bias pushing relay nodes to 70-90 m corridor
5. Dynamic Handover & Self-Healing when battery <= 20%
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Sequence, Set, Tuple

import numpy as np

from .dynamics import AltitudeTier, assign_tier_for_mode, clamp_to_corridor, get_corridor_bounds


# ============================================================================
# 1. 10-STATE MAVSDK FINITE STATE MACHINE
# ============================================================================

class FSMState(Enum):
    IDLE = "IDLE"
    TAKEOFF = "TAKEOFF"
    TRANSIT = "TRANSIT"
    SURVEYING = "SURVEYING"
    RELAY = "RELAY"
    DATA_TX = "DATA_TX"
    RTL = "RTL"
    LANDING = "LANDING"
    COMPLETED = "COMPLETED"
    FAILSAFE = "FAILSAFE"


@dataclass
class FSMTransitionEvent:
    from_state: FSMState
    to_state: FSMState
    timestamp: float
    reason: str


class DroneFSM:
    """10-State MAVSDK Finite State Machine for an autonomous UAV."""

    def __init__(self, drone_id: int):
        self.drone_id = drone_id
        self.current_state = FSMState.IDLE
        self.state_entry_time = 0.0
        self.history: List[FSMTransitionEvent] = []

    def transition_to(self, new_state: FSMState, timestamp: float, reason: str = "") -> bool:
        """Executes state transition if valid."""
        if self.current_state == new_state:
            return False

        event = FSMTransitionEvent(
            from_state=self.current_state,
            to_state=new_state,
            timestamp=timestamp,
            reason=reason,
        )
        self.history.append(event)
        self.current_state = new_state
        self.state_entry_time = timestamp
        return True

    def time_in_state(self, current_time: float) -> float:
        return max(0.0, current_time - self.state_entry_time)


# ============================================================================
# 2. CONSENSUS-BASED BUNDLE ALGORITHM (CBBA)
# ============================================================================

class TaskPriority(Enum):
    HAZARD_INSPECTION = 1     # Priority 1
    STRUCTURAL_COLLAPSE = 2   # Priority 2
    SURVIVOR_SEARCH = 3       # Priority 3 (Highest)


PRIORITY_WEIGHTS = {
    TaskPriority.HAZARD_INSPECTION: 1.0,
    TaskPriority.STRUCTURAL_COLLAPSE: 1.6,
    TaskPriority.SURVIVOR_SEARCH: 2.5,
}


@dataclass
class MissionTask:
    task_id: str
    target_pos: np.ndarray             # (3,) [x, y, z] target location
    priority: TaskPriority
    required_duration_sec: float = 20.0
    assigned_drone_id: Optional[int] = None
    is_completed: bool = False


class CBBAAuctionEngine:
    """Consensus-Based Bundle Algorithm (CBBA) for Decentralized Task Allocation.
    
    Assigns Points of Interest (PoIs) dynamically based on:
    - Euclidean distance to target
    - State-of-Charge (SoC) / remaining endurance
    - Task Priority Tier (Survivor Search > Structural Collapse > Hazard Inspection)
    """

    def __init__(self, max_bundle_size: int = 2):
        self.max_bundle = max_bundle_size
        self.tasks: Dict[str, MissionTask] = {}

    def add_task(self, task_id: str, target_pos: Sequence[float], priority: TaskPriority, duration_sec: float = 20.0) -> None:
        self.tasks[task_id] = MissionTask(
            task_id=task_id,
            target_pos=np.array(target_pos, dtype=np.float64),
            priority=priority,
            required_duration_sec=duration_sec,
        )

    def populate_default_disaster_pois(self) -> None:
        """Populates high-priority disaster response PoIs."""
        self.tasks.clear()
        # Survivor search points (highest priority)
        self.add_task("POI_SURVIVOR_1", [15.0, 10.0, 30.0], TaskPriority.SURVIVOR_SEARCH, 25.0)
        self.add_task("POI_SURVIVOR_2", [-25.0, 18.0, 32.0], TaskPriority.SURVIVOR_SEARCH, 25.0)
        # Structural collapse points
        self.add_task("POI_COLLAPSE_1", [-30.0, -30.0, 35.0], TaskPriority.STRUCTURAL_COLLAPSE, 20.0)
        self.add_task("POI_COLLAPSE_2", [30.0, -20.0, 35.0], TaskPriority.STRUCTURAL_COLLAPSE, 20.0)
        # Hazard inspection points
        self.add_task("POI_HAZARD_FIRE", [-18.0, -22.0, 35.0], TaskPriority.HAZARD_INSPECTION, 15.0)
        self.add_task("POI_HAZARD_ROAD", [5.0, -10.0, 30.0], TaskPriority.HAZARD_INSPECTION, 15.0)

    def compute_bid(
        self,
        drone_id: int,
        drone_pos: np.ndarray,
        drone_soc: float,
        task: MissionTask,
    ) -> float:
        """Calculates agent bid for a specific task based on distance, SoC, and priority."""
        if drone_soc <= 20.0:
            return 0.0  # Ineligible if critical battery

        dist = float(np.linalg.norm(drone_pos[:2] - task.target_pos[:2]))
        p_weight = PRIORITY_WEIGHTS[task.priority]

        # Bid score: higher priority * higher battery / distance penalty
        # Scaled so closer, fresh drones with high priority tasks win
        dist_factor = 1.0 / (1.0 + 0.03 * dist)
        soc_factor = (drone_soc / 100.0) ** 1.2
        bid = p_weight * soc_factor * dist_factor * 100.0
        return float(bid)

    def solve_auction(
        self,
        drone_positions: Dict[int, np.ndarray],
        drone_soc: Dict[int, float],
    ) -> Dict[int, List[str]]:
        """Executes CBBA auction consensus across swarm agents.
        
        Returns:
            assigned_bundles: Dict[drone_id -> List[task_id]]
        """
        drone_ids = list(drone_positions.keys())
        bundles: Dict[int, List[str]] = {d: [] for d in drone_ids}
        winning_bids: Dict[str, float] = {t_id: -1.0 for t_id in self.tasks.keys()}
        winning_agents: Dict[str, Optional[int]] = {t_id: None for t_id in self.tasks.keys()}

        # Convergence loop
        max_iterations = len(drone_ids) * 2
        for _ in range(max_iterations):
            changed = False

            # Phase 1: Bundle construction
            for d in drone_ids:
                if len(bundles[d]) >= self.max_bundle or drone_soc.get(d, 0.0) <= 20.0:
                    continue

                best_task_id = None
                best_bid = -1.0

                for t_id, task in self.tasks.items():
                    if task.is_completed or t_id in bundles[d]:
                        continue

                    bid = self.compute_bid(d, drone_positions[d], drone_soc.get(d, 100.0), task)
                    if bid > winning_bids[t_id] and bid > best_bid:
                        best_bid = bid
                        best_task_id = t_id

                if best_task_id is not None:
                    bundles[d].append(best_task_id)
                    winning_bids[best_task_id] = best_bid
                    winning_agents[best_task_id] = d
                    changed = True

            # Phase 2: Consensus conflict resolution
            for t_id, winner in winning_agents.items():
                if winner is not None:
                    for d in drone_ids:
                        if d != winner and t_id in bundles[d]:
                            bundles[d].remove(t_id)
                            changed = True

            if not changed:
                break

        # Record task assignments
        for t_id, winner in winning_agents.items():
            self.tasks[t_id].assigned_drone_id = winner

        return bundles


# ============================================================================
# 3. VIRTUAL SPRING MESH (VSM) & SKYLINE BRIDGING
# ============================================================================

class VirtualSpringMeshRelay:
    """Virtual Spring Mesh (VSM) Relay Auto-Positioning with Skyline Bridging.
    
    Dynamically positions communication relay nodes along line-of-sight vectors
    between active surveying drones and the Ground Control Station (GCS).
    
    Features:
    - Spring-damper physics pulling relays toward equidistant backbone placement
    - Skyline Bridging: Applies an elevation bias pulling relay nodes toward the
      70 to 90 m corridor (TIER_4_RELAY_MESH) to clear urban building rooftops.
    """

    def __init__(
        self,
        gcs_position: Optional[np.ndarray] = None,
        spring_k: float = 0.35,
        damping_c: float = 0.65,
        skyline_elevation_bias_m: float = 75.0,  # Center of Tier 4 (70-90 m)
    ):
        self.gcs_pos = np.array(gcs_position if gcs_position is not None else [0.0, 0.0, 5.0], dtype=np.float64)
        self.spring_k = spring_k
        self.damping_c = damping_c
        self.skyline_elevation = skyline_elevation_bias_m

    def compute_relay_setpoint(
        self,
        relay_id: int,
        current_pos: np.ndarray,
        current_vel: np.ndarray,
        survey_cluster_pos: np.ndarray,
        relay_index: int = 1,
        total_relays: int = 1,
    ) -> np.ndarray:
        """Calculates target setpoint for a relay drone between GCS and Survey Cluster.
        
        Args:
            relay_index: 1-indexed position along the relay chain
            total_relays: total number of dedicated relay drones
        """
        # Linear backbone interpolation ratio: e.g. for 1 relay -> ratio = 0.5
        ratio = float(relay_index) / float(total_relays + 1)
        ideal_pos_xy = (1.0 - ratio) * self.gcs_pos[:2] + ratio * survey_cluster_pos[:2]

        # Skyline Bridging: enforce elevation into Tier 4 (70 to 90 m)
        target_z = clamp_to_corridor(self.skyline_elevation, AltitudeTier.TIER_4_RELAY_MESH)

        ideal_target = np.array([ideal_pos_xy[0], ideal_pos_xy[1], target_z], dtype=np.float64)

        # Virtual spring force towards target position
        spring_force = -self.spring_k * (current_pos - ideal_target)
        damping_force = -self.damping_c * current_vel

        # Resulting desired setpoint with smoothing
        smoothed_setpoint = ideal_target + 0.2 * (spring_force + damping_force)
        smoothed_setpoint[2] = clamp_to_corridor(smoothed_setpoint[2], AltitudeTier.TIER_4_RELAY_MESH)

        return smoothed_setpoint


# ============================================================================
# 4. SWARM MISSION ORCHESTRATOR & DYNAMIC HANDOVER
# ============================================================================

@dataclass
class SwarmAgentMissionContext:
    drone_id: int
    fsm: DroneFSM
    assigned_poi_id: Optional[str] = None
    is_relay: bool = False
    handover_requested: bool = False
    replacement_drone_id: Optional[int] = None


class SwarmMissionOrchestrator:
    """Master Autonomous Swarm Mission Orchestrator.
    
    Coordinates:
    - 10-State FSM per agent
    - CBBA auction dispatch
    - Virtual Spring Mesh (VSM) backbone relays
    - Automated battery-threshold Handover & Self-Healing (SoC <= 20%)
    """

    def __init__(
        self,
        drone_ids: List[int],
        gcs_position: Optional[np.ndarray] = None,
        battery_handover_threshold_pct: float = 20.0,
    ):
        self.gcs_pos = np.array(gcs_position if gcs_position is not None else [0.0, 0.0, 5.0], dtype=np.float64)
        self.handover_threshold = battery_handover_threshold_pct

        self.agents: Dict[int, SwarmAgentMissionContext] = {
            d_id: SwarmAgentMissionContext(drone_id=d_id, fsm=DroneFSM(drone_id=d_id))
            for d_id in drone_ids
        }

        self.auction = CBBAAuctionEngine(max_bundle_size=2)
        self.auction.populate_default_disaster_pois()

        self.vsm = VirtualSpringMeshRelay(gcs_position=self.gcs_pos)
        self.handover_events: List[str] = []

    def dispatch_initial_fleet(self, sim_time: float) -> None:
        """Transitions fleet from IDLE to TAKEOFF and assigns roles."""
        agent_list = list(self.agents.values())
        if not agent_list:
            return

        # Designate Agent 1 as primary survey lead, Agent 2 as relay bridge, others as search
        for i, ctx in enumerate(agent_list):
            ctx.fsm.transition_to(FSMState.TAKEOFF, sim_time, "Initial Fleet Launch")
            if i == len(agent_list) - 1:
                ctx.is_relay = True
            else:
                ctx.is_relay = False

    def update_cycle(
        self,
        drone_positions: Dict[int, np.ndarray],
        drone_velocities: Dict[int, np.ndarray],
        drone_soc: Dict[int, float],
        sim_time: float,
    ) -> Dict[int, Tuple[FSMState, np.ndarray]]:
        """Executes full mission autonomy loop.
        
        Returns:
            commands: Dict[drone_id -> (target_fsm_state, target_position)]
        """
        commands: Dict[int, Tuple[FSMState, np.ndarray]] = {}

        # 1. Evaluate Dynamic Handover & Self-Healing (Battery <= 20%)
        for d_id, ctx in self.agents.items():
            soc = drone_soc.get(d_id, 100.0)

            if soc <= self.handover_threshold and not ctx.handover_requested and ctx.fsm.current_state in (FSMState.SURVEYING, FSMState.RELAY, FSMState.TRANSIT):
                # Trigger Handover
                ctx.handover_requested = True
                replacement = self._find_best_replacement_drone(exclude_id=d_id, drone_soc=drone_soc)

                if replacement is not None:
                    ctx.replacement_drone_id = replacement
                    rep_ctx = self.agents[replacement]
                    # Transfer role and target to replacement
                    rep_ctx.is_relay = ctx.is_relay
                    rep_ctx.assigned_poi_id = ctx.assigned_poi_id
                    rep_ctx.fsm.transition_to(FSMState.TAKEOFF if rep_ctx.fsm.current_state == FSMState.IDLE else FSMState.TRANSIT,
                                              sim_time, f"Handover from low-battery UAV_{d_id}")

                    log_msg = f"[HANDOVER] UAV_{d_id} (SoC={soc:.1f}%) handed mission to UAV_{replacement} -> Commencing RTL"
                    self.handover_events.append(log_msg)

                # Active drone initiates Return to Launch (RTL)
                ctx.fsm.transition_to(FSMState.RTL, sim_time, f"Low battery ({soc:.1f}% <= {self.handover_threshold}%)")

        # 2. Run CBBA Task Allocation for active surveying drones
        active_search_drones = {
            d_id: pos for d_id, pos in drone_positions.items()
            if not self.agents[d_id].is_relay and self.agents[d_id].fsm.current_state not in (FSMState.RTL, FSMState.LANDING, FSMState.COMPLETED)
        }
        if active_search_drones:
            bundles = self.auction.solve_auction(active_search_drones, drone_soc)
            for d_id, task_ids in bundles.items():
                if task_ids:
                    self.agents[d_id].assigned_poi_id = task_ids[0]

        # 3. Compute survey cluster centroid for Virtual Spring Mesh relay positioning
        survey_positions = [
            drone_positions[d_id] for d_id, ctx in self.agents.items()
            if not ctx.is_relay and d_id in drone_positions
        ]
        survey_cluster = np.mean(survey_positions, axis=0) if survey_positions else np.array([20.0, 10.0, 35.0])

        # 4. Generate State Machine transitions and target positions
        for d_id, ctx in self.agents.items():
            curr_state = ctx.fsm.current_state
            pos = drone_positions.get(d_id, self.gcs_pos)
            vel = drone_velocities.get(d_id, np.zeros(3))
            soc = drone_soc.get(d_id, 100.0)

            # State transition handlers
            if curr_state == FSMState.IDLE:
                target = np.array([pos[0], pos[1], 0.0], dtype=np.float64)

            elif curr_state == FSMState.TAKEOFF:
                target_alt = get_corridor_bounds(AltitudeTier.TIER_1_LAUNCH_RECOVERY)[2]
                target = np.array([pos[0], pos[1], target_alt], dtype=np.float64)
                if abs(pos[2] - target_alt) < 1.0 or ctx.fsm.time_in_state(sim_time) > 4.0:
                    ctx.fsm.transition_to(FSMState.TRANSIT, sim_time, "Climb complete")

            elif curr_state == FSMState.TRANSIT:
                if ctx.is_relay:
                    # Target VSM Relay setpoint in Tier 4 (70-90 m)
                    target = self.vsm.compute_relay_setpoint(d_id, pos, vel, survey_cluster)
                    if np.linalg.norm(pos[:2] - target[:2]) < 5.0:
                        ctx.fsm.transition_to(FSMState.RELAY, sim_time, "Reached relay station")
                else:
                    # Transit to assigned PoI in Tier 3 (50-65 m)
                    poi_task = self.auction.tasks.get(ctx.assigned_poi_id) if ctx.assigned_poi_id else None
                    dest_xy = poi_task.target_pos[:2] if poi_task else np.array([15.0, 10.0])
                    transit_z = get_corridor_bounds(AltitudeTier.TIER_3_TRANSIT_CORRIDOR)[2]
                    target = np.array([dest_xy[0], dest_xy[1], transit_z], dtype=np.float64)

                    if np.linalg.norm(pos[:2] - dest_xy) < 5.0:
                        ctx.fsm.transition_to(FSMState.SURVEYING, sim_time, "Reached survey PoI")

            elif curr_state == FSMState.SURVEYING:
                # Descend into Tier 2 (25-45 m) and conduct local inspection
                poi_task = self.auction.tasks.get(ctx.assigned_poi_id) if ctx.assigned_poi_id else None
                base_xy = poi_task.target_pos[:2] if poi_task else np.array([15.0, 10.0])
                survey_z = get_corridor_bounds(AltitudeTier.TIER_2_POI_SURVEYING)[2]

                # Small orbital pattern around PoI
                t = sim_time * 0.4
                orbit_r = 6.0
                target = np.array([base_xy[0] + orbit_r * math.cos(t),
                                   base_xy[1] + orbit_r * math.sin(t),
                                   survey_z], dtype=np.float64)

                # Mark completed after required duration
                if ctx.fsm.time_in_state(sim_time) > (poi_task.required_duration_sec if poi_task else 20.0):
                    if poi_task:
                        poi_task.is_completed = True
                    ctx.fsm.transition_to(FSMState.DATA_TX, sim_time, "PoI survey complete")

            elif curr_state == FSMState.RELAY:
                # Dynamic VSM holding position with Skyline Bridging
                target = self.vsm.compute_relay_setpoint(d_id, pos, vel, survey_cluster)

            elif curr_state == FSMState.DATA_TX:
                # Hover in place for telemetry / point cloud upload
                target = pos.copy()
                if ctx.fsm.time_in_state(sim_time) > 3.0:
                    ctx.fsm.transition_to(FSMState.RTL, sim_time, "Data burst complete")

            elif curr_state == FSMState.RTL:
                # Fly back to GCS coordinates at transit altitude
                gcs_xy = self.gcs_pos[:2]
                transit_z = get_corridor_bounds(AltitudeTier.TIER_3_TRANSIT_CORRIDOR)[2]
                target = np.array([gcs_xy[0], gcs_xy[1], transit_z], dtype=np.float64)

                if np.linalg.norm(pos[:2] - gcs_xy) < 4.0:
                    ctx.fsm.transition_to(FSMState.LANDING, sim_time, "Arrived at base")

            elif curr_state == FSMState.LANDING:
                # Touchdown descent
                target = np.array([self.gcs_pos[0], self.gcs_pos[1], 0.0], dtype=np.float64)
                if pos[2] <= 0.4 or ctx.fsm.time_in_state(sim_time) > 8.0:
                    ctx.fsm.transition_to(FSMState.COMPLETED, sim_time, "Touchdown confirmed")

            elif curr_state == FSMState.COMPLETED:
                target = np.array([self.gcs_pos[0], self.gcs_pos[1], 0.0], dtype=np.float64)

            else:  # FAILSAFE
                target = np.array([pos[0], pos[1], max(0.0, pos[2] - 1.5 * 0.033)], dtype=np.float64)

            commands[d_id] = (ctx.fsm.current_state, target)

        return commands

    def _find_best_replacement_drone(self, exclude_id: int, drone_soc: Dict[int, float]) -> Optional[int]:
        """Finds highest-battery idle or candidate drone to take over role."""
        candidates = [
            d_id for d_id, ctx in self.agents.items()
            if d_id != exclude_id and ctx.fsm.current_state in (FSMState.IDLE, FSMState.COMPLETED)
        ]
        if not candidates:
            # Fallback to any drone with > 60% battery not already in RTL
            candidates = [
                d_id for d_id, ctx in self.agents.items()
                if d_id != exclude_id and drone_soc.get(d_id, 0.0) > 60.0 and ctx.fsm.current_state not in (FSMState.RTL, FSMState.LANDING)
            ]
        if not candidates:
            return None

        # Return candidate with maximum State of Charge
        return max(candidates, key=lambda d: drone_soc.get(d, 0.0))

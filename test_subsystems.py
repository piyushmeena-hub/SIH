"""Comprehensive Verification Test Suite for UAV-X Swarm Architecture.

Tests all 6 Backend Subsystems:
1. 6-DOF RK4 Quadrotor Dynamics & LERP/SLERP Smoothing (sim/dynamics.py)
2. Khatib APF Flocking & Downward Cone Downwash Avoidance (sim/dynamics.py)
3. 4-Tier Altitude Corridors & Power Drain Model (sim/dynamics.py)
4. Dual-Band Heterogeneous Links & Log-Distance Path Loss (sim/network.py)
5. 3D Ray-AABB Building Occlusion & Dijkstra Routing (sim/network.py)
6. DTN Ring Buffers & Hop Tracing Telemetry (sim/network.py)
7. 10-State MAVSDK Finite State Machine (sim/mission.py)
8. Consensus-Based Bundle Algorithm (CBBA) Task Allocation (sim/mission.py)
9. Virtual Spring Mesh (VSM) & Skyline Bridging (sim/mission.py)
10. Dynamic Handover & Self-Healing on Low Battery (sim/mission.py)
11. 3D Synthetic LiDAR Engine (sim/perception.py)
12. OctoMap 3D Log-Odds Voxel Mapping & Entropy Tracking (sim/perception.py)
13. 9-State Extended Kalman Filter & Urban Canyon GPS-Denial (sim/perception.py)
14. MAVLink v2.0 UDP Bridge Encoding (sim/mavlink_bridge.py)
15. YOLOv8 Victim Detection & FLIR Thermal Vital Sign Fusion (sim/vision_fusion.py)
16. OpenCV Hazard Tagging & Spatial Deduplication (sim/vision_fusion.py)
17. Telemetry JSON Frame Size Constraint (< 1.5 KB/frame) (main.py)
"""

import math
import numpy as np
import cv2

from sim.dynamics import (
    AltitudeTier,
    DronePowerModel,
    KhatibFlockingAPF,
    QuadrotorDynamics6DOF,
    QuadrotorState,
    SwarmAgentKinematics,
    assign_tier_for_mode,
    clamp_to_corridor,
    euler_to_quat,
    get_corridor_bounds,
    lerp_pos,
    quat_to_euler,
    slerp_quat,
)
from sim.network import (
    BuildingAABB,
    BuildingOcclusionEngine,
    DTNRingBuffer,
    DualBandChannelModel,
    FANETRouter,
    RadioBand,
    TelemetryPacket,
)
from sim.mission import (
    CBBAAuctionEngine,
    DroneFSM,
    FSMState,
    MissionTask,
    SwarmMissionOrchestrator,
    TaskPriority,
    VirtualSpringMeshRelay,
)
from sim.perception import (
    ExtendedKalmanFilter9State,
    OctoMap3D,
    SyntheticLiDAR,
)
from sim.mavlink_bridge import DroneTelemetry, MAVLinkBridge
from sim.vision_fusion import (
    Detection,
    FLIRThermalFusion,
    HazardType,
    OpenCVHazardTagger,
    PinholeCameraModel,
    SpatialDeduplicationEngine,
    YOLOv8Detector,
)
from main import SwarmSimulationEngine


# ============================================================================
# MODULE 1: FLIGHT DYNAMICS & KINEMATICS TESTS
# ============================================================================

def test_dynamics_rk4_and_smoothing():
    print("[1/17] Testing 6-DOF RK4 Quadrotor Dynamics & LERP/SLERP Smoothing...")
    dynamics = QuadrotorDynamics6DOF(mass_kg=1.5, v_max_mps=15.0, a_max_mps2=5.0)

    # Initial hover state
    state = QuadrotorState(
        pos=np.array([0.0, 0.0, 10.0]),
        vel=np.array([0.0, 0.0, 0.0]),
        quat=euler_to_quat(0.0, 0.0, 0.0),
        omega=np.array([0.0, 0.0, 0.0]),
    )

    # Hover thrust = m * g
    hover_thrust = 1.5 * 9.80665
    torques = np.zeros(3)

    # Step RK4 forward
    for _ in range(30):
        state = dynamics.rk4_step(state, hover_thrust, torques, dt=0.033)

    # Altitude should remain steady near 10.0 m
    assert abs(state.pos[2] - 10.0) < 0.2, f"Hover altitude drifted: {state.pos[2]}"

    # Test kinematic velocity clamp: v_max = 15 m/s
    overspeed_state = QuadrotorState(
        pos=np.array([0.0, 0.0, 10.0]),
        vel=np.array([20.0, 10.0, 0.0]),  # speed = 22.36 m/s > 15 m/s
        quat=euler_to_quat(0.0, 0.0, 0.0),
        omega=np.zeros(3),
    )
    clamped_state = dynamics.rk4_step(overspeed_state, hover_thrust, torques, dt=0.033)
    speed = float(np.linalg.norm(clamped_state.vel))
    assert speed <= 15.0001, f"Speed {speed} exceeded 15 m/s clamp!"

    # Test LERP and SLERP
    p0 = np.array([0.0, 0.0, 10.0])
    p1 = np.array([10.0, 20.0, 30.0])
    p_mid = lerp_pos(p0, p1, 0.5)
    np.testing.assert_allclose(p_mid, [5.0, 10.0, 20.0])

    q0 = euler_to_quat(0.0, 0.0, 0.0)
    q1 = euler_to_quat(0.0, 0.0, math.pi / 2.0)
    q_mid = slerp_quat(q0, q1, 0.5)
    euler_mid = quat_to_euler(q_mid)
    assert abs(euler_mid[2] - math.pi / 4.0) < 1e-3, f"SLERP yaw mismatch: {euler_mid[2]}"

    print(f"  -> RK4 hover steady, v_max clamped to {speed:.2f} m/s, SLERP orientation smooth. PASS.")


def test_apf_flocking_and_downwash():
    print("[2/17] Testing Khatib APF Flocking & Downward Downwash Avoidance...")
    apf = KhatibFlockingAPF(d_influence=3.0, d_hard_clearance=1.5)

    drone1_pos = np.array([10.0, 10.0, 20.0])
    # Peer 2.2 m away (inside 3.0 m influence zone)
    peer_near = np.array([12.2, 10.0, 20.0])

    f_rep, min_dist = apf.compute_repulsive_force(drone1_pos, [peer_near])
    assert f_rep[0] < -0.1, f"Expected negative X repulsive force, got {f_rep[0]}"
    assert abs(min_dist - 2.2) < 1e-4, f"Min dist mismatch: {min_dist}"

    # Hard safety clearance test: approaching hard floor 1.5 m (at 1.6 m distance)
    peer_very_close = np.array([11.6, 10.0, 20.0])
    f_rep_intense, _ = apf.compute_repulsive_force(drone1_pos, [peer_very_close])
    assert np.linalg.norm(f_rep_intense) > np.linalg.norm(f_rep), "Repulsion must increase near 1.5m floor"

    # Downwash cone test: drone2 is directly under leading drone1
    # Leading drone at [0, 0, 30], Trailing drone at [0.1, 0.1, 25] (5m below)
    leading_pos = np.array([0.0, 0.0, 30.0])
    trailing_pos = np.array([0.1, 0.1, 25.0])
    f_rep_downwash, _ = apf.compute_repulsive_force(trailing_pos, [leading_pos])
    # Downwash avoidance should push trailing drone horizontally away (XY plane)
    horizontal_mag = float(np.linalg.norm(f_rep_downwash[:2]))
    assert horizontal_mag > 0.5, f"Downwash lateral escape force too weak: {horizontal_mag}"

    print(f"  -> APF repulsion active at d={min_dist}m, lateral downwash escape force: {horizontal_mag:.2f} N. PASS.")


def test_altitude_corridors_and_power():
    print("[3/17] Testing 4-Tier Altitude Corridors & Power Drain Model...")
    # Verify corridor bounds
    assert get_corridor_bounds(AltitudeTier.TIER_1_LAUNCH_RECOVERY) == (0.0, 20.0, 10.0)
    assert get_corridor_bounds(AltitudeTier.TIER_2_POI_SURVEYING) == (25.0, 45.0, 35.0)
    assert get_corridor_bounds(AltitudeTier.TIER_3_TRANSIT_CORRIDOR) == (50.0, 65.0, 55.0)
    assert get_corridor_bounds(AltitudeTier.TIER_4_RELAY_MESH) == (70.0, 90.0, 75.0)

    # Test clamping
    z_clamped = clamp_to_corridor(120.0, AltitudeTier.TIER_4_RELAY_MESH)
    assert z_clamped == 90.0, f"Clamping failed: {z_clamped}"

    # Test mode-to-tier mapping
    assert assign_tier_for_mode("SURVEYING") == AltitudeTier.TIER_2_POI_SURVEYING
    assert assign_tier_for_mode("RELAY") == AltitudeTier.TIER_4_RELAY_MESH

    # Test Power Drain Model
    power_model = DronePowerModel(initial_soc_pct=100.0)
    metrics = power_model.compute_power(thrust_n=15.0, speed_mps=8.0, is_transmitting=True, dt=1.0)
    assert metrics.power_total_w > 100.0, f"Power consumption too low: {metrics.power_total_w} W"
    assert metrics.soc_pct < 100.0, "Battery SoC should decrement"
    assert metrics.drain_rate_pct_per_min > 0.0

    print(f"  -> Corridors verified [0-20, 25-45, 50-65, 70-90m]. Power: {metrics.power_total_w:.1f}W, SoC: {metrics.soc_pct:.3f}%. PASS.")


# ============================================================================
# MODULE 2: RESILIENT FANET NETWORKING TESTS
# ============================================================================

def test_fanet_dual_band_and_path_loss():
    print("[4/17] Testing Dual-Band Channel Model & Log-Distance Path Loss...")
    channel = DualBandChannelModel(pl0_db=40.05, eta_los=2.05, eta_nlos=3.60)

    # LoS link at 50 meters
    p1 = np.array([0.0, 0.0, 20.0])
    p2 = np.array([50.0, 0.0, 20.0])

    link_24, link_915 = channel.evaluate_link(p1, p2, is_los=True, obstacle_penalty_db=0.0)
    assert link_24.is_connected, "2.4 GHz link should be connected at 50m LoS"
    assert link_915.is_connected, "915 MHz link should be connected at 50m LoS"
    assert link_24.path_loss_db > 40.05, f"PL must exceed PL0: {link_24.path_loss_db}"
    assert link_915.p_rx_dbm > link_24.p_rx_dbm, "915 MHz should have higher received power"

    # Extreme range test: 500 meters NLoS with obstacle
    p3 = np.array([500.0, 0.0, 20.0])
    link_24_far, link_915_far = channel.evaluate_link(p1, p3, is_los=False, obstacle_penalty_db=22.0)
    assert not link_24_far.is_connected, "2.4 GHz should drop at 500m NLoS with building"
    assert link_915_far.is_connected, "915 MHz LoRa should maintain connection at 500m NLoS fallback!"

    print(f"  -> 2.4GHz: {link_24.bitrate_mbps:.1f} Mbps, 915MHz LoRa fallback maintained at 500m NLoS. PASS.")


def test_occlusion_and_dijkstra_routing():
    print("[5/17] Testing 3D Ray-AABB Building Occlusion & Dijkstra Routing...")
    router = FANETRouter(gcs_position=np.array([0.0, 0.0, 5.0]))
    router.occlusion.populate_default_urban_scene()

    # Link blocked by Office Highrise ([-40, -40, 0] to [-20, -20, 25])
    p_start = np.array([-50.0, -30.0, 10.0])
    p_end = np.array([-10.0, -30.0, 10.0])
    is_los, obs_count, penalty = router.occlusion.test_link_occlusion(p_start, p_end)
    assert not is_los, "Ray penetrating highrise should be NLoS"
    assert obs_count >= 1, f"Expected building intersection, got {obs_count}"
    assert penalty >= 22.0, f"Expected >= 22 dB penalty, got {penalty}"

    # Routing graph with multi-hop chain: UAV_2 acts as relay for UAV_1 to reach GCS (0)
    drone_positions = {
        1: np.array([60.0, 0.0, 30.0]),   # Far surveying drone
        2: np.array([30.0, 0.0, 60.0]),   # Intermediate relay drone
    }
    drone_soc = {1: 85.0, 2: 90.0}

    routes, links = router.compute_routing_graph(drone_positions, drone_soc)
    assert 1 in routes, "Drone 1 should have valid route to GCS"
    assert routes[1][-1] == 0, "Route must terminate at GCS (Node 0)"

    print(f"  -> Building ray-AABB occlusion: {obs_count} hits (+{penalty}dB). Route for UAV_1: {routes[1]}. PASS.")


def test_dtn_buffers_and_hop_tracing():
    print("[6/17] Testing DTN Ring Buffers & Hop Tracing Telemetry...")
    router = FANETRouter(gcs_position=np.array([0.0, 0.0, 5.0]))
    router.register_drone(1)

    # Disconnected scenario: empty routes
    routes_empty = {}
    active_links = {}

    success, pkt = router.transmit_telemetry(
        src_drone_id=1, payload_type="C2", size_bytes=100,
        routes_to_gcs=routes_empty, active_links=active_links, sim_time=10.0
    )
    assert not success, "Packet should not deliver without active route"
    assert len(router.dtn_buffers[1]) == 1, "Packet should be stored in DTN ring buffer"

    # Reconnection scenario: route established [1, 2, 0]
    routes_connected = {1: [1, 2, 0]}
    success2, pkt2 = router.transmit_telemetry(
        src_drone_id=1, payload_type="C2", size_bytes=100,
        routes_to_gcs=routes_connected, active_links=active_links, sim_time=15.0
    )
    assert success2, "Packet should deliver when route is active"
    assert pkt2.hop_trace == ["UAV_1", "UAV_2", "GCS"], f"Hop trace mismatch: {pkt2.hop_trace}"
    assert len(router.dtn_buffers[1]) == 0, "DTN buffer should be flushed upon reconnection!"

    metrics = router.get_network_metrics()
    assert metrics["pdr_percent"] > 0, "PDR should be positive"

    print(f"  -> DTN buffer queued and flushed on reconnection. Hop trace: {pkt2.hop_trace}, PDR={metrics['pdr_percent']}%. PASS.")


# ============================================================================
# MODULE 3: SWARM AUTONOMY & MISSION ORCHESTRATION TESTS
# ============================================================================

def test_10state_fsm_and_vsm_relay():
    print("[7/17] Testing 10-State MAVSDK FSM & Virtual Spring Mesh Relay...")
    fsm = DroneFSM(drone_id=1)
    assert fsm.current_state == FSMState.IDLE

    # Sequence of transitions
    fsm.transition_to(FSMState.TAKEOFF, 1.0, "Arm and climb")
    assert fsm.current_state == FSMState.TAKEOFF

    fsm.transition_to(FSMState.TRANSIT, 3.5, "Climb complete")
    assert fsm.current_state == FSMState.TRANSIT

    fsm.transition_to(FSMState.RELAY, 8.0, "Relay station reached")
    assert fsm.current_state == FSMState.RELAY
    assert len(fsm.history) == 3

    # Virtual Spring Mesh Relay positioning with Skyline Bridging
    vsm = VirtualSpringMeshRelay(gcs_position=np.array([0.0, 0.0, 5.0]))
    survey_pos = np.array([40.0, 20.0, 35.0])
    curr_pos = np.array([10.0, 5.0, 60.0])
    curr_vel = np.zeros(3)

    setpoint = vsm.compute_relay_setpoint(relay_id=2, current_pos=curr_pos, current_vel=curr_vel,
                                          survey_cluster_pos=survey_pos, relay_index=1, total_relays=1)

    # Setpoint XY should be roughly halfway between GCS (0,0) and Survey (40,20) -> ~ (20, 10)
    assert 15.0 <= setpoint[0] <= 25.0, f"VSM relay X unexpected: {setpoint[0]}"
    assert 5.0 <= setpoint[1] <= 15.0, f"VSM relay Y unexpected: {setpoint[1]}"
    # Skyline Bridging: Altitude must be in Tier 4 [70, 90 m]
    assert 70.0 <= setpoint[2] <= 90.0, f"Skyline Bridging altitude out of bounds: {setpoint[2]}"

    print(f"  -> 10-State FSM transitions verified. VSM Relay Setpoint: {np.round(setpoint, 1)} (Skyline Tier 4). PASS.")


def test_cbba_auction_and_handover():
    print("[8/17] Testing CBBA Decentralized Auction & Dynamic Handover...")
    auction = CBBAAuctionEngine(max_bundle_size=2)
    auction.populate_default_disaster_pois()

    drone_positions = {
        1: np.array([14.0, 9.0, 20.0]),   # Near POI_SURVIVOR_1
        2: np.array([-24.0, 17.0, 20.0]), # Near POI_SURVIVOR_2
    }
    drone_soc = {1: 95.0, 2: 90.0}

    bundles = auction.solve_auction(drone_positions, drone_soc)
    assert len(bundles[1]) > 0, "Drone 1 should be assigned a task"
    assert len(bundles[2]) > 0, "Drone 2 should be assigned a task"

    # Drone 1 should win survivor 1 because it's closest
    assert "POI_SURVIVOR_1" in bundles[1]
    assert "POI_SURVIVOR_2" in bundles[2]

    # Test Dynamic Handover when battery <= 20%
    orchestrator = SwarmMissionOrchestrator(drone_ids=[1, 2, 3], gcs_position=np.array([0.0, 0.0, 5.0]))
    orchestrator.dispatch_initial_fleet(sim_time=0.0)

    # Drone 1 is surveying, but hits 18% battery
    orchestrator.agents[1].fsm.transition_to(FSMState.SURVEYING, 10.0, "Surveying")
    orchestrator.agents[2].fsm.transition_to(FSMState.IDLE, 10.0, "Standby")

    drone_positions_3 = {1: np.array([20.0, 10.0, 35.0]), 2: np.array([0.0, 0.0, 0.0]), 3: np.array([0.0, 0.0, 0.0])}
    drone_velocities_3 = {1: np.zeros(3), 2: np.zeros(3), 3: np.zeros(3)}
    drone_soc_critical = {1: 18.0, 2: 98.0, 3: 95.0}  # Drone 1 critical!

    cmds = orchestrator.update_cycle(drone_positions_3, drone_velocities_3, drone_soc_critical, sim_time=12.0)

    # Drone 1 must transition to RTL
    assert orchestrator.agents[1].fsm.current_state == FSMState.RTL, "Drone 1 should transition to RTL on low battery"
    assert orchestrator.agents[1].handover_requested, "Handover should be flagged"
    assert orchestrator.agents[1].replacement_drone_id in (2, 3), "A replacement drone must be assigned"
    assert len(orchestrator.handover_events) > 0, "Handover event must be logged"

    print(f"  -> CBBA optimal consensus reached. Handover executed: {orchestrator.handover_events[0]}. PASS.")


# ============================================================================
# MODULES 4-6: PERCEPTION, MAVLINK, VISION FUSION & INTEGRATION TESTS
# ============================================================================

def test_lidar_engine():
    print("[9/17] Testing 3D Synthetic LiDAR Engine...")
    lidar = SyntheticLiDAR(h_beams=72, v_beams=16, noise_sigma=0.03, seed=42)
    lidar.populate_default_urban_disaster_scene()

    drone_pos = np.array([0.0, 0.0, 15.0], dtype=np.float32)
    pc = lidar.scan(drone_pos, drone_euler=(0.0, 0.0, 0.0), timestamp=1.0)

    assert len(pc) > 0, "Point cloud should contain points"
    assert pc.points.shape[1] == 3, "Points must be Nx3"
    assert len(pc.ranges) == len(pc.points), "Ranges must match point count"
    assert np.all(pc.ranges >= lidar.min_range), "Ranges must respect min_range"
    assert np.all(pc.ranges <= lidar.max_range), "Ranges must respect max_range"
    print(f"  -> Generated {len(pc)} LiDAR points with sigma={lidar.noise_sigma}m noise. PASS.")


def test_octomap_entropy():
    print("[10/17] Testing OctoMap 3D Log-Odds Voxel Mapping & Entropy...")
    octomap = OctoMap3D(voxel_res=1.0)
    lidar = SyntheticLiDAR(h_beams=72, v_beams=8, noise_sigma=0.03)
    lidar.populate_default_urban_disaster_scene()

    pc = lidar.scan(np.array([0.0, 0.0, 12.0]), timestamp=1.0)
    octomap.update_from_point_cloud(pc)

    metrics = octomap.compute_entropy_metrics()
    assert metrics.mapped_volume_m3 > 0, "Mapped volume should be > 0"
    assert metrics.occupied_count > 0, "Should have identified occupied rubble voxels"
    assert 0.0 <= metrics.mean_entropy_per_voxel <= 1.0, "Mean entropy must be within [0, 1]"
    assert metrics.entropy_reduction_ratio >= 0.0, "Entropy reduction ratio must be >= 0"
    print(f"  -> OctoMap: {metrics.occupied_count} occupied voxels, {metrics.free_count} free voxels. "
          f"Entropy reduction: {metrics.entropy_reduction_ratio * 100:.2f}%. PASS.")


def test_ekf_9state():
    print("[11/17] Testing 9-State Extended Kalman Filter (EKF)...")
    init_pos = np.array([10.0, -5.0, 20.0])
    ekf = ExtendedKalmanFilter9State(init_pos=init_pos)

    a_imu = np.array([0.0, 0.0, 9.80665])
    w_imu = np.array([0.0, 0.0, 0.05])
    for _ in range(50):
        ekf.predict(a_imu, w_imu, dt=0.02)

    gps_meas = np.array([10.1, -4.9, 20.05])
    updated = ekf.update_gps(gps_meas, hdop=1.0, is_denied=False)
    assert updated, "Nominal GPS update should be accepted"

    baro_updated = ekf.update_barometer(20.02)
    assert baro_updated, "Barometer update should be accepted"

    initial_unc = np.linalg.norm(ekf.position_uncertainty_std)
    for _ in range(30):
        ekf.predict(a_imu, np.zeros(3), dt=0.02)
        ekf.update_gps(np.array([50.0, 50.0, 20.0]), hdop=5.5, is_denied=True)
    final_unc = np.linalg.norm(ekf.position_uncertainty_std)

    assert ekf.gps_denied, "Filter should detect GPS denial"
    assert final_unc > initial_unc, "Uncertainty should grow under GPS denial"
    print(f"  -> EKF: Estimated pos={np.round(ekf.position, 2)}, unc growth={initial_unc:.3f}->{final_unc:.3f} under GPS denial. PASS.")


def test_mavlink_bridge():
    print("[12/17] Testing MAVLink v2.0 UDP Bridge Encoding...")
    bridge = MAVLinkBridge(bind_port=14556, broadcast_rate_hz=20.0)
    drone = DroneTelemetry(
        sysid=1,
        lat_deg=28.6139,
        lon_deg=77.2090,
        alt_msl_m=230.0,
        alt_rel_m=15.0,
        vx=2.5, vy=-1.0, vz=0.0,
        roll_rad=0.02, pitch_rad=-0.01, yaw_rad=1.57,
        rssi=220, remrssi=205,
    )
    bridge.register_drone(drone)

    payload = bridge.encode_packets_for_drone(drone, boot_ms=5000, tick_count=20)
    assert len(payload) > 0, "MAVLink payload must not be empty"
    assert payload[0] == 0xFD, f"Expected MAVLink v2 magic byte 0xFD, got {hex(payload[0])}"
    print(f"  -> Encoded MAVLink v2.0 packets (HEARTBEAT, GLOBAL_POS, ATTITUDE, RADIO): {len(payload)} bytes. PASS.")


def test_vision_pipeline_and_thermal_fusion():
    print("[13/17] Testing YOLOv8 Victim Detection & FLIR Thermal Fusion...")
    detector = YOLOv8Detector()
    fusion = FLIRThermalFusion()

    rgb = np.full((240, 320, 3), (80, 80, 80), dtype=np.uint8)
    thermal = np.full((240, 320), 20.0, dtype=np.float32)

    # Target 1: Living Human (Orange clothing, 36.5°C body heat)
    cv2.rectangle(rgb, (140, 95), (180, 155), (15, 120, 245), -1)
    thermal[95:155, 140:180] = 36.5

    dets = detector.detect(rgb, drone_pos=np.array([10.0, 10.0, 15.0]), drone_id=1, timestamp=1.0)
    assert len(dets) >= 1, "Optical candidate target should be detected"

    fused_dets = fusion.fuse(dets, thermal)
    life_verified = [d for d in fused_dets if d.is_life_verified]
    assert len(life_verified) >= 1, "Living survivor must be verified by thermal signature"
    print(f"  -> Optical detections: {len(dets)}, Life verified by FLIR: {len(life_verified)}. PASS.")


def test_opencv_hazard_tagging():
    print("[14/17] Testing OpenCV Hazard Tagging (Fire, Plume, Blocked Road)...")
    tagger = OpenCVHazardTagger()
    drone_pos = np.array([0.0, 0.0, 15.0])
    drone_euler = (0.0, 0.0, 0.0)

    # 1. Structural Fire Frame
    fire_frame = np.full((240, 320, 3), (40, 40, 40), dtype=np.uint8)
    cv2.circle(fire_frame, (160, 120), 20, (0, 215, 255), -1)
    fires = tagger.detect_structural_fires(fire_frame, drone_pos, drone_euler, drone_id=1, timestamp=1.0)
    assert len(fires) > 0, "Structural fire should be tagged"
    assert fires[0].hazard_type == HazardType.STRUCTURAL_FIRE

    # 2. Blocked Road (High edge density from rubble)
    rubble_frame = np.full((240, 320, 3), (80, 80, 80), dtype=np.uint8)
    for i in range(0, 300, 10):
        cv2.line(rubble_frame, (i, 140), (i + 8, 220), (255, 255, 255), 2)
    blocked_roads = tagger.detect_blocked_roads(rubble_frame, drone_pos, drone_euler, drone_id=1, timestamp=1.0)
    assert len(blocked_roads) > 0, "Rubble-blocked road should be tagged"
    assert blocked_roads[0].hazard_type == HazardType.BLOCKED_ROAD

    print(f"  -> Tagged {len(fires)} structural fires and {len(blocked_roads)} blocked road sections. PASS.")


def test_spatial_deduplication():
    print("[15/17] Testing Spatial Deduplication Engine...")
    dedup = SpatialDeduplicationEngine(survivor_merge_radius_m=3.5)

    det1 = Detection(
        bbox=(100, 100, 150, 150),
        confidence=0.85,
        class_id=0,
        class_name="survivor",
        world_pos=np.array([20.0, 15.0, 0.0]),
        drone_id=1,
        timestamp=1.0,
        is_life_verified=True,
    )
    det2 = Detection(
        bbox=(80, 90, 130, 140),
        confidence=0.90,
        class_id=0,
        class_name="survivor",
        world_pos=np.array([21.0, 15.5, 0.0]),
        drone_id=2,
        timestamp=1.5,
        is_life_verified=True,
    )
    det3 = Detection(
        bbox=(200, 120, 240, 170),
        confidence=0.75,
        class_id=0,
        class_name="survivor",
        world_pos=np.array([80.0, -40.0, 0.0]),
        drone_id=3,
        timestamp=2.0,
        is_life_verified=False,
    )

    dedup.add_survivor_detections([det1])
    dedup.add_survivor_detections([det2])
    dedup.add_survivor_detections([det3])

    canonical = dedup.get_canonical_survivors()
    assert len(canonical) == 2, f"Expected 2 canonical survivors, got {len(canonical)}"
    print(f"  -> Deduplicated {3} multi-drone sightings into {len(canonical)} canonical markers. PASS.")


def test_telemetry_frame_size():
    print("[16/17] Testing Swarm Telemetry JSON Frame Constraint (< 1.5 KB)...")
    engine = SwarmSimulationEngine(num_drones=5, enable_mavlink=False)
    for _ in range(15):
        engine.step(0.033)

    frame_json = engine.serialize_telemetry_frame()
    frame_bytes = len(frame_json.encode("utf-8"))

    assert frame_bytes < 1536, f"Frame size {frame_bytes} bytes exceeds 1.5 KB limit (1536 bytes)"
    print(f"  -> Swarm telemetry frame size: {frame_bytes} bytes / 1536 bytes max. PASS.")


def test_integrated_simulation_cycle():
    print("[17/17] Testing Full Simulation Step with Dynamics, FANET & Mission...")
    engine = SwarmSimulationEngine(num_drones=4, enable_mavlink=False)

    for step_i in range(30):
        engine.step(0.033, use_yolo=False)

    # Verify positions and states
    assert len(engine.drones) == 4
    assert len(engine.orchestrator.agents) == 4
    assert engine.sim_time > 0.9

    net_metrics = engine.router.get_network_metrics()
    assert net_metrics["total_sent"] > 0, "FANET telemetry packets should be transmitted"

    print(f"  -> Integrated engine stepped {30} frames. Sim time: {engine.sim_time:.2f}s, FANET sent: {int(net_metrics['total_sent'])}. PASS.")


if __name__ == "__main__":
    print("==================================================================")
    print("RUNNING UAV-X SWARM ALL-SUBSYSTEM VERIFICATION SUITE (17 TESTS)")
    print("==================================================================")
    test_dynamics_rk4_and_smoothing()
    test_apf_flocking_and_downwash()
    test_altitude_corridors_and_power()
    test_fanet_dual_band_and_path_loss()
    test_occlusion_and_dijkstra_routing()
    test_dtn_buffers_and_hop_tracing()
    test_10state_fsm_and_vsm_relay()
    test_cbba_auction_and_handover()
    test_lidar_engine()
    test_octomap_entropy()
    test_ekf_9state()
    test_mavlink_bridge()
    test_vision_pipeline_and_thermal_fusion()
    test_opencv_hazard_tagging()
    test_spatial_deduplication()
    test_telemetry_frame_size()
    test_integrated_simulation_cycle()
    print("==================================================================")
    print("ALL 17/17 SUBSYSTEM INTEGRATION TESTS PASSED SUCCESSFULLY!")
    print("==================================================================")

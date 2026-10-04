"""UAV-X Swarm Architecture Backend Modules.

Subsystems:
1. dynamics: 6-DOF Newton-Euler quadrotor dynamics (RK4), APF flocking, downwash avoidance, 4-tier altitude corridors, power drain model
2. network: Dual-band heterogeneous FANET (2.4 GHz & 915 MHz), log-distance path loss, 3D ray-AABB occlusion, Dijkstra routing, DTN ring buffers
3. mission: 10-state MAVSDK FSM, CBBA task auction, Virtual Spring Mesh (VSM) relay positioning, Skyline Bridging, dynamic handover
4. perception: 3D Synthetic LiDAR Engine, OctoMap 3D Log-Odds Voxel Mapping, 9-State EKF
5. mavlink_bridge: MAVLink v2.0 UDP bridge for ArduPilot/PX4 SITL and Ground Control Stations
6. vision_fusion: YOLOv8 Victim Detection, FLIR Thermal Fusion, OpenCV Hazard Tagging, Spatial Deduplication
"""

from .dynamics import (
    AltitudeTier,
    CORRIDOR_BOUNDS,
    DronePowerModel,
    KhatibFlockingAPF,
    PowerMetrics,
    QuadrotorDynamics6DOF,
    QuadrotorState,
    SwarmAgentKinematics,
    assign_tier_for_mode,
    clamp_to_corridor,
    euler_to_quat,
    get_corridor_bounds,
    lerp_pos,
    quat_to_euler,
    quat_to_rotation_matrix,
    slerp_quat,
)
from .network import (
    BuildingAABB,
    BuildingOcclusionEngine,
    DTNRingBuffer,
    DualBandChannelModel,
    FANETRouter,
    LinkQuality,
    RadioBand,
    TelemetryPacket,
)
from .mission import (
    CBBAAuctionEngine,
    DroneFSM,
    FSMState,
    FSMTransitionEvent,
    MissionTask,
    SwarmAgentMissionContext,
    SwarmMissionOrchestrator,
    TaskPriority,
    VirtualSpringMeshRelay,
)
from .perception import (
    ExtendedKalmanFilter9State,
    MapEntropyMetrics,
    OctoMap3D,
    PointCloud,
    SyntheticLiDAR,
    VoxelState,
)
from .mavlink_bridge import DroneTelemetry, MAVLinkBridge
from .vision_fusion import (
    CanonicalMarker,
    Detection,
    FLIRThermalFusion,
    HazardDetection,
    HazardType,
    OpenCVHazardTagger,
    PinholeCameraModel,
    SeverityLevel,
    SpatialDeduplicationEngine,
    YOLOv8Detector,
)

__all__ = [
    # Dynamics
    "AltitudeTier",
    "CORRIDOR_BOUNDS",
    "DronePowerModel",
    "KhatibFlockingAPF",
    "PowerMetrics",
    "QuadrotorDynamics6DOF",
    "QuadrotorState",
    "SwarmAgentKinematics",
    "assign_tier_for_mode",
    "clamp_to_corridor",
    "euler_to_quat",
    "get_corridor_bounds",
    "lerp_pos",
    "quat_to_euler",
    "quat_to_rotation_matrix",
    "slerp_quat",
    # Network
    "BuildingAABB",
    "BuildingOcclusionEngine",
    "DTNRingBuffer",
    "DualBandChannelModel",
    "FANETRouter",
    "LinkQuality",
    "RadioBand",
    "TelemetryPacket",
    # Mission
    "CBBAAuctionEngine",
    "DroneFSM",
    "FSMState",
    "FSMTransitionEvent",
    "MissionTask",
    "SwarmAgentMissionContext",
    "SwarmMissionOrchestrator",
    "TaskPriority",
    "VirtualSpringMeshRelay",
    # Perception
    "ExtendedKalmanFilter9State",
    "MapEntropyMetrics",
    "OctoMap3D",
    "PointCloud",
    "SyntheticLiDAR",
    "VoxelState",
    # MAVLink
    "DroneTelemetry",
    "MAVLinkBridge",
    # Vision
    "CanonicalMarker",
    "Detection",
    "FLIRThermalFusion",
    "HazardDetection",
    "HazardType",
    "OpenCVHazardTagger",
    "PinholeCameraModel",
    "SeverityLevel",
    "SpatialDeduplicationEngine",
    "YOLOv8Detector",
]

"""AI Perception & Sensor Fusion Pipeline.

Subsystem Components:
1. YOLOv8 Victim Detection (optical camera frames -> bounding boxes & 3D world coordinates)
2. FLIR Thermal Fusion (blending RGB detections with thermal heat signatures, life verification)
3. OpenCV Hazard Tagging (structural fires, hazardous gas plumes, blocked roads via HSV and edge density)
4. Spatial Deduplication Engine (Euclidean / DBSCAN clustering across multi-drone sightings)
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple

logger = logging.getLogger("vision_fusion")

import cv2
import numpy as np

# Try importing ultralytics YOLO
try:
    from ultralytics import YOLO
    ULTRALYTICS_AVAILABLE = True
except ImportError:
    ULTRALYTICS_AVAILABLE = False


# ============================================================================
# DATA MODELS & ENUMS
# ============================================================================

class HazardType(Enum):
    STRUCTURAL_FIRE = "STRUCTURAL_FIRE"
    GAS_PLUME = "GAS_PLUME"
    BLOCKED_ROAD = "BLOCKED_ROAD"


class SeverityLevel(Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


@dataclass
class Detection:
    """Optical detection bounding box with 3D projection."""
    bbox: Tuple[int, int, int, int]     # (x1, y1, x2, y2) in pixel space
    confidence: float                   # Optical confidence [0.0, 1.0]
    class_id: int                       # Class ID (0 for person/survivor)
    class_name: str                     # "survivor" or "person"
    world_pos: np.ndarray               # (3,) [x, y, z] estimated world position
    drone_id: int                       # ID of reporting drone
    timestamp: float                    # Detection timestamp
    # Thermal fusion fields
    thermal_temp_max: float = 0.0       # Peak temperature in °C
    thermal_temp_mean: float = 0.0      # Mean temperature in °C
    thermal_confidence: float = 0.0     # Thermal confidence [0.0, 1.0]
    is_life_verified: bool = False      # Thermal confirmation of vital signs
    fused_confidence: float = 0.0       # Bayesian fused confidence


@dataclass
class HazardDetection:
    """Visual hazard tag."""
    hazard_type: HazardType
    severity: SeverityLevel
    bbox: Tuple[int, int, int, int]     # (x1, y1, x2, y2)
    world_pos: np.ndarray               # (3,) [x, y, z] estimated world coordinate
    confidence: float                   # Confidence score [0.0, 1.0]
    drone_id: int
    timestamp: float
    metadata: Dict[str, float] = field(default_factory=dict)


@dataclass
class CanonicalMarker:
    """Deduplicated canonical marker for a survivor or hazard in world coordinates."""
    marker_id: str                      # Unique ID e.g. "SURVIVOR-001"
    entity_type: str                    # "SURVIVOR", "FIRE", "GAS", "BLOCKED_ROAD"
    canonical_pos: np.ndarray           # (3,) [x, y, z] weighted centroid
    confidence: float                   # Combined multi-observation confidence
    observations_count: int             # Number of sightings
    reporting_drones: Set[int]          # Drones that confirmed this target
    first_seen: float
    last_seen: float
    error_radius_m: float               # Estimated 1-sigma uncertainty radius
    metadata: Dict[str, any] = field(default_factory=dict)


# ============================================================================
# 1. YOLOV8 VICTIM DETECTION & CAMERA PROJECTION
# ============================================================================

class PinholeCameraModel:
    """Pinhole camera geometry model for 2D-to-3D ground plane projection."""

    def __init__(
        self,
        img_width: int = 640,
        img_height: int = 480,
        hfov_deg: float = 84.0,         # Typical UAV optical sensor FOV
    ):
        self.width = img_width
        self.height = img_height
        self.hfov = math.radians(hfov_deg)
        # Focal lengths and principal point
        self.fx = (img_width / 2.0) / math.tan(self.hfov / 2.0)
        self.fy = self.fx
        self.cx = img_width / 2.0
        self.cy = img_height / 2.0

    def pixel_to_ray_body(self, u: float, v: float) -> np.ndarray:
        """Computes unit ray vector in camera/body frame (X: forward, Y: right, Z: down)."""
        x_c = (u - self.cx) / self.fx
        y_c = (v - self.cy) / self.fy
        z_c = 1.0
        ray = np.array([z_c, x_c, y_c], dtype=np.float32)  # X-forward, Y-right, Z-down
        norm = np.linalg.norm(ray)
        return ray / (norm if norm > 1e-6 else 1.0)

    def project_to_ground(
        self,
        u: float,
        v: float,
        drone_pos: np.ndarray,
        drone_euler: Tuple[float, float, float] = (0.0, 0.0, 0.0),
        ground_z: float = 0.0,
    ) -> np.ndarray:
        """Projects a 2D image pixel onto the ground plane (z = ground_z) in world coordinates."""
        roll, pitch, yaw = drone_euler
        # Camera is mounted at nadir or forward-down (tilt = 45° or 90° down)
        # Assuming gimbal is pitch-stabilized downwards:
        # Default pitch = -45 deg (-pi/4) or nadir
        cr, sr = math.cos(roll), math.sin(roll)
        cp, sp = math.cos(pitch - math.radians(45.0)), math.sin(pitch - math.radians(45.0))
        cy, sy = math.cos(yaw), math.sin(yaw)

        R = np.array([
            [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
            [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
            [-sp,     cp * sr,                cp * cr                ],
        ], dtype=np.float32)

        ray_body = self.pixel_to_ray_body(u, v)
        ray_world = R @ ray_body

        if abs(ray_world[2]) < 1e-4:
            ray_world[2] = -1e-4

        # Intersect with ground_z
        t = (ground_z - drone_pos[2]) / ray_world[2]
        if t < 0:
            t = abs(t)  # Ensure forward projection
        hit_pos = drone_pos + ray_world * min(t, 200.0)
        return hit_pos.astype(np.float32)


class YOLOv8Detector:
    """YOLOv8 Victim Detector with automatic model management and synthetic fallback."""

    def __init__(
        self,
        model_path: str = "yolov8n.pt",
        conf_threshold: float = 0.45,
        camera_model: Optional[PinholeCameraModel] = None,
    ):
        self.conf_threshold = conf_threshold
        self.camera = camera_model or PinholeCameraModel()
        self.model = None

        if ULTRALYTICS_AVAILABLE:
            try:
                self.model = YOLO(model_path)
                logger.info(f"Loaded YOLOv8 model from {model_path}")
            except Exception as e:
                # Fallback to heuristic detector if weights cannot be downloaded/read
                logger.warning(f"Could not load YOLOv8 weights ({e}); using integrated vision engine.")
                self.model = None

    def detect(
        self,
        rgb_frame: np.ndarray,
        drone_pos: np.ndarray,
        drone_euler: Tuple[float, float, float] = (0.0, 0.0, 0.0),
        drone_id: int = 1,
        timestamp: float = 0.0,
        use_yolo: bool = True,
    ) -> List[Detection]:
        """Runs victim detection on optical RGB frame and projects bounding boxes to 3D."""
        detections: List[Detection] = []
        h, w = rgb_frame.shape[:2]

        if use_yolo and self.model is not None:
            try:
                results = self.model(rgb_frame, conf=self.conf_threshold, verbose=False)
                for r in results:
                    boxes = r.boxes
                    for box in boxes:
                        cls_id = int(box.cls[0])
                        conf = float(box.conf[0])
                        # In COCO, class 0 is 'person'
                        if cls_id == 0 and conf >= self.conf_threshold:
                            x1, y1, x2, y2 = map(int, box.xyxy[0].cpu().numpy())
                            center_u = (x1 + x2) / 2.0
                            center_v = (y1 + y2) / 2.0
                            world_pos = self.camera.project_to_ground(
                                center_u, center_v, drone_pos, drone_euler
                            )
                            detections.append(
                                Detection(
                                    bbox=(x1, y1, x2, y2),
                                    confidence=conf,
                                    class_id=0,
                                    class_name="survivor",
                                    world_pos=world_pos,
                                    drone_id=drone_id,
                                    timestamp=timestamp,
                                )
                            )
                if detections:
                    return detections
            except Exception:
                pass

        # Heuristic / Synthetic fallback detector:
        # Detects localized high-salience clusters with survivor clothing/contrast colors
        # (e.g. orange high-vis, red, or high-contrast human-scale blobs in rubble)
        hsv = cv2.cvtColor(rgb_frame, cv2.COLOR_BGR2HSV)
        # Mask for high-visibility clothing (orange, red, yellow)
        mask1 = cv2.inRange(hsv, np.array([5, 120, 100]), np.array([25, 255, 255]))
        mask2 = cv2.inRange(hsv, np.array([170, 120, 100]), np.array([180, 255, 255]))
        cloth_mask = cv2.bitwise_or(mask1, mask2)

        contours, _ = cv2.findContours(cloth_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            area = cv2.contourArea(cnt)
            # Human profile scale in pixels: e.g. 100 to 8000 pixels
            if 80 < area < 8000:
                x, y, bw, bh = cv2.boundingRect(cnt)
                aspect = float(bh) / max(1, bw)
                if 0.5 <= aspect <= 3.5:  # Human-like aspect ratio
                    center_u = x + bw / 2.0
                    center_v = y + bh / 2.0
                    world_pos = self.camera.project_to_ground(
                        center_u, center_v, drone_pos, drone_euler
                    )
                    conf = min(0.92, 0.55 + (area / 8000.0) * 0.35)
                    detections.append(
                        Detection(
                            bbox=(x, y, x + bw, y + bh),
                            confidence=float(conf),
                            class_id=0,
                            class_name="survivor",
                            world_pos=world_pos,
                            drone_id=drone_id,
                            timestamp=timestamp,
                        )
                    )

        return detections


# ============================================================================
# 2. FLIR THERMAL SENSOR FUSION & LIFE SIGN VERIFICATION
# ============================================================================

class FLIRThermalFusion:
    """FLIR Thermal Fusion Module.
    
    Blends optical RGB bounding boxes with FLIR long-wave infrared (LWIR)
    calibrated temperature maps (in °C) to verify live vital signs and
    eliminate optical false positives (mannequins, debris shapes).
    """

    def __init__(
        self,
        human_min_temp_c: float = 31.0,    # Minimum human skin/clothed temperature
        human_max_temp_c: float = 38.5,    # Maximum human surface temperature
        min_contrast_delta_c: float = 2.5, # Minimum temperature delta above background
        w_rgb: float = 0.45,               # Weight of optical detector
        w_thermal: float = 0.55,           # Weight of thermal detector
    ):
        self.human_min_temp = human_min_temp_c
        self.human_max_temp = human_max_temp_c
        self.min_contrast_delta = min_contrast_delta_c
        self.w_rgb = w_rgb
        self.w_thermal = w_thermal

    def fuse(
        self,
        detections: List[Detection],
        thermal_map_celsius: np.ndarray,    # (H, W) float32 temperatures in °C
    ) -> List[Detection]:
        """Fuses RGB bounding boxes with calibrated thermal map and verifies life signs."""
        th_h, th_w = thermal_map_celsius.shape[:2]
        ambient_temp = float(np.median(thermal_map_celsius))
        fused_results: List[Detection] = []

        for det in detections:
            x1, y1, x2, y2 = det.bbox

            # Clamp coordinates to thermal map dimensions
            tx1 = max(0, min(th_w - 1, x1))
            ty1 = max(0, min(th_h - 1, y1))
            tx2 = max(0, min(th_w, x2))
            ty2 = max(0, min(th_h, y2))

            if tx2 <= tx1 or ty2 <= ty1:
                continue

            thermal_patch = thermal_map_celsius[ty1:ty2, tx1:tx2]
            t_max = float(np.max(thermal_patch))
            t_mean = float(np.mean(thermal_patch))
            delta_t = t_max - ambient_temp

            det.thermal_temp_max = t_max
            det.thermal_temp_mean = t_mean

            # Thermal verification criteria:
            # 1. Surface temperature within living human range or significant delta T
            # 2. Rejects false positives (e.g., cold mannequins T < 25°C, or blazing fires T > 50°C)
            is_in_human_range = (self.human_min_temp - 3.0) <= t_max <= (self.human_max_temp + 3.0)
            has_thermal_contrast = delta_t >= self.min_contrast_delta
            is_overheated_fire = t_max > 50.0

            if is_in_human_range and has_thermal_contrast and not is_overheated_fire:
                det.is_life_verified = True
                # Higher thermal confidence when close to optimal core body surface (34-36°C)
                temp_diff = abs(t_max - 35.0)
                thermal_conf = max(0.2, min(0.98, 1.0 - (temp_diff / 8.0)))
            else:
                det.is_life_verified = False
                thermal_conf = 0.10  # Low thermal confidence (likely debris/false positive)

            det.thermal_confidence = float(thermal_conf)

            # Bayesian / Weighted Confidence Fusion
            fused_conf = (
                self.w_rgb * det.confidence + self.w_thermal * det.thermal_confidence
            ) / (self.w_rgb + self.w_thermal)

            det.fused_confidence = float(fused_conf)

            # Eliminate cold optical false positives: if thermal confidence is very low, suppress
            if not det.is_life_verified and det.thermal_confidence < 0.15 and det.confidence < 0.70:
                continue

            fused_results.append(det)

        return fused_results


# ============================================================================
# 3. OPENCV HAZARD TAGGING
# ============================================================================

class OpenCVHazardTagger:
    """Visual classification engine for structural hazards: fires, gas plumes, blocked roads."""

    def __init__(self, camera_model: Optional[PinholeCameraModel] = None):
        self.camera = camera_model or PinholeCameraModel()

    def detect_structural_fires(
        self,
        bgr_frame: np.ndarray,
        drone_pos: np.ndarray,
        drone_euler: Tuple[float, float, float],
        drone_id: int,
        timestamp: float,
    ) -> List[HazardDetection]:
        """Detects active structural flames via HSV thresholding and brightness ratio."""
        hazards: List[HazardDetection] = []
        hsv = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2HSV)

        # Fire color mask: yellow/orange/red flame tones
        # Hue: 0-25 & 165-180, High Saturation & Value
        mask1 = cv2.inRange(hsv, np.array([0, 140, 180]), np.array([25, 255, 255]))
        mask2 = cv2.inRange(hsv, np.array([165, 140, 180]), np.array([180, 255, 255]))
        fire_mask = cv2.bitwise_or(mask1, mask2)

        # Morphological opening to suppress point noise
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        fire_mask = cv2.morphologyEx(fire_mask, cv2.MORPH_OPEN, kernel)

        contours, _ = cv2.findContours(fire_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area > 120:  # Significant flame cluster
                x, y, w, h = cv2.boundingRect(cnt)
                center_u = x + w / 2.0
                center_v = y + h / 2.0
                world_pos = self.camera.project_to_ground(center_u, center_v, drone_pos, drone_euler)

                # Severity based on burning footprint
                severity = SeverityLevel.CRITICAL if area > 2500 else SeverityLevel.HIGH
                conf = min(0.96, 0.65 + (area / 4000.0) * 0.3)

                hazards.append(
                    HazardDetection(
                        hazard_type=HazardType.STRUCTURAL_FIRE,
                        severity=severity,
                        bbox=(x, y, x + w, y + h),
                        world_pos=world_pos,
                        confidence=float(conf),
                        drone_id=drone_id,
                        timestamp=timestamp,
                        metadata={"flame_area_px": float(area)},
                    )
                )

        return hazards

    def detect_gas_plumes(
        self,
        bgr_frame: np.ndarray,
        drone_pos: np.ndarray,
        drone_euler: Tuple[float, float, float],
        drone_id: int,
        timestamp: float,
    ) -> List[HazardDetection]:
        """Detects hazardous toxic gas / smoke plumes via gradient attenuation and diffuse saturation drop."""
        hazards: List[HazardDetection] = []
        gray = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2HSV)

        # Gas / smoke plume: high brightness, low-to-medium saturation (whitish / greyish / yellow-tinted cloud)
        s_channel = hsv[:, :, 1]
        v_channel = hsv[:, :, 2]

        # Low saturation, high value mask
        plume_mask = (s_channel < 60) & (v_channel > 160)
        plume_mask = plume_mask.astype(np.uint8) * 255

        # Check gradient blur (Laplacian variance in region is low due to smoke diffusion)
        contours, _ = cv2.findContours(plume_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area > 2000:  # Large diffuse plume
                x, y, w, h = cv2.boundingRect(cnt)
                patch_gray = gray[y:y+h, x:x+w]
                lap_var = float(cv2.Laplacian(patch_gray, cv2.CV_64F).var())

                # Diffuse smoke plumes exhibit attenuated texture/gradient
                if lap_var < 150.0:
                    center_u = x + w / 2.0
                    center_v = y + h / 2.0
                    world_pos = self.camera.project_to_ground(center_u, center_v, drone_pos, drone_euler)
                    conf = min(0.88, 0.50 + (area / 10000.0) * 0.35)

                    hazards.append(
                        HazardDetection(
                            hazard_type=HazardType.GAS_PLUME,
                            severity=SeverityLevel.HIGH if area > 6000 else SeverityLevel.MEDIUM,
                            bbox=(x, y, x + w, y + h),
                            world_pos=world_pos,
                            confidence=float(conf),
                            drone_id=drone_id,
                            timestamp=timestamp,
                            metadata={"plame_area_px": float(area), "laplacian_variance": lap_var},
                        )
                    )

        return hazards

    def detect_blocked_roads(
        self,
        bgr_frame: np.ndarray,
        drone_pos: np.ndarray,
        drone_euler: Tuple[float, float, float],
        drone_id: int,
        timestamp: float,
        road_mask: Optional[np.ndarray] = None,
    ) -> List[HazardDetection]:
        """Detects road blockages and rubble obstructions via edge-density analysis."""
        hazards: List[HazardDetection] = []
        gray = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 60, 160)

        h, w = gray.shape
        # Default analysis grid: divide lower half of frame (road corridor) into zones
        grid_h = h // 4
        grid_w = w // 4

        for gy in range(0, h - grid_h + 1, grid_h // 2):
            for gx in range(0, w - grid_w + 1, grid_w // 2):
                cell_edges = edges[gy:gy + grid_h, gx:gx + grid_w]
                edge_density = float(np.count_nonzero(cell_edges)) / (grid_h * grid_w)

                # Clear paved roads have low edge density (< 0.04).
                # Rubble debris, collapsed concrete, and fractured asphalt produce high edge density (> 0.08)
                if edge_density > 0.08:
                    center_u = gx + grid_w / 2.0
                    center_v = gy + grid_h / 2.0
                    world_pos = self.camera.project_to_ground(center_u, center_v, drone_pos, drone_euler)
                    conf = min(0.95, 0.45 + edge_density * 2.5)

                    hazards.append(
                        HazardDetection(
                            hazard_type=HazardType.BLOCKED_ROAD,
                            severity=SeverityLevel.HIGH if edge_density > 0.18 else SeverityLevel.MEDIUM,
                            bbox=(gx, gy, gx + grid_w, gy + grid_h),
                            world_pos=world_pos,
                            confidence=float(conf),
                            drone_id=drone_id,
                            timestamp=timestamp,
                            metadata={"edge_density": edge_density},
                        )
                    )

        return hazards


# ============================================================================
# 4. SPATIAL DEDUPLICATION ENGINE
# ============================================================================

class SpatialDeduplicationEngine:
    """Spatial Clustering & Canonical Target Registry.
    
    Aggregates multi-drone sightings of survivors and hazards into
    single canonical GPS/world markers using Euclidean distance / DBSCAN clustering.
    """

    def __init__(
        self,
        survivor_merge_radius_m: float = 3.5,
        hazard_merge_radius_m: float = 8.0,
    ):
        self.survivor_radius = survivor_merge_radius_m
        self.hazard_radius = hazard_merge_radius_m

        # Canonical markers storage: key = marker_id
        self.canonical_survivors: Dict[str, CanonicalMarker] = {}
        self.canonical_hazards: Dict[str, CanonicalMarker] = {}

        self._survivor_counter = 0
        self._hazard_counter = 0

    def add_survivor_detections(self, detections: List[Detection]) -> List[CanonicalMarker]:
        """Cluster and deduplicate incoming survivor detections across the swarm."""
        updated_markers: List[CanonicalMarker] = []

        for det in detections:
            det_pos = det.world_pos[:2]  # Cluster in XY plane
            matched_id: Optional[str] = None
            min_dist = float("inf")

            # Find closest existing canonical survivor marker
            for m_id, marker in self.canonical_survivors.items():
                dist = float(np.linalg.norm(det_pos - marker.canonical_pos[:2]))
                if dist <= self.survivor_radius and dist < min_dist:
                    min_dist = dist
                    matched_id = m_id

            if matched_id is not None:
                # Merge into existing canonical marker (weighted centroid update)
                marker = self.canonical_survivors[matched_id]
                old_weight = float(marker.observations_count)
                new_weight = 1.0 + (det.fused_confidence if det.fused_confidence > 0 else det.confidence)
                total_weight = old_weight + new_weight

                marker.canonical_pos = (
                    (marker.canonical_pos * old_weight + det.world_pos * new_weight) / total_weight
                )
                marker.observations_count += 1
                marker.reporting_drones.add(det.drone_id)
                marker.last_seen = det.timestamp

                # Boost confidence from independent confirmation
                marker.confidence = min(0.99, marker.confidence + (1.0 - marker.confidence) * 0.25)
                # Uncertainty radius shrinks with more confirmations: sigma = r / sqrt(N)
                marker.error_radius_m = max(0.5, self.survivor_radius / math.sqrt(marker.observations_count))

                if det.is_life_verified:
                    marker.metadata["life_verified"] = True
                    marker.metadata["peak_temp_c"] = max(
                        marker.metadata.get("peak_temp_c", 0.0), det.thermal_temp_max
                    )

                updated_markers.append(marker)
            else:
                # Create new canonical survivor marker
                self._survivor_counter += 1
                new_id = f"SURVIVOR-{self._survivor_counter:03d}"
                marker = CanonicalMarker(
                    marker_id=new_id,
                    entity_type="SURVIVOR",
                    canonical_pos=det.world_pos.copy(),
                    confidence=det.fused_confidence if det.fused_confidence > 0 else det.confidence,
                    observations_count=1,
                    reporting_drones={det.drone_id},
                    first_seen=det.timestamp,
                    last_seen=det.timestamp,
                    error_radius_m=self.survivor_radius,
                    metadata={
                        "life_verified": det.is_life_verified,
                        "peak_temp_c": det.thermal_temp_max,
                    },
                )
                self.canonical_survivors[new_id] = marker
                updated_markers.append(marker)

        return updated_markers

    def add_hazard_detections(self, hazards: List[HazardDetection]) -> List[CanonicalMarker]:
        """Cluster and deduplicate incoming hazard detections across the swarm."""
        updated_markers: List[CanonicalMarker] = []

        for haz in hazards:
            haz_pos = haz.world_pos[:2]
            matched_id: Optional[str] = None
            min_dist = float("inf")

            for m_id, marker in self.canonical_hazards.items():
                if marker.entity_type != haz.hazard_type.value:
                    continue
                dist = float(np.linalg.norm(haz_pos - marker.canonical_pos[:2]))
                if dist <= self.hazard_radius and dist < min_dist:
                    min_dist = dist
                    matched_id = m_id

            if matched_id is not None:
                marker = self.canonical_hazards[matched_id]
                old_weight = float(marker.observations_count)
                new_weight = 1.0 + haz.confidence
                total_weight = old_weight + new_weight

                marker.canonical_pos = (
                    (marker.canonical_pos * old_weight + haz.world_pos * new_weight) / total_weight
                )
                marker.observations_count += 1
                marker.reporting_drones.add(haz.drone_id)
                marker.last_seen = haz.timestamp
                marker.confidence = min(0.99, marker.confidence + (1.0 - marker.confidence) * 0.20)
                marker.error_radius_m = max(1.0, self.hazard_radius / math.sqrt(marker.observations_count))
                updated_markers.append(marker)
            else:
                self._hazard_counter += 1
                new_id = f"HAZARD-{self._hazard_counter:03d}"
                marker = CanonicalMarker(
                    marker_id=new_id,
                    entity_type=haz.hazard_type.value,
                    canonical_pos=haz.world_pos.copy(),
                    confidence=haz.confidence,
                    observations_count=1,
                    reporting_drones={haz.drone_id},
                    first_seen=haz.timestamp,
                    last_seen=haz.timestamp,
                    error_radius_m=self.hazard_radius,
                    metadata={
                        "severity": haz.severity.value,
                        **haz.metadata,
                    },
                )
                self.canonical_hazards[new_id] = marker
                updated_markers.append(marker)

        return updated_markers

    def get_canonical_survivors(self) -> List[CanonicalMarker]:
        return list(self.canonical_survivors.values())

    def get_canonical_hazards(self) -> List[CanonicalMarker]:
        return list(self.canonical_hazards.values())

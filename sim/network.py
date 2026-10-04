"""Resilient FANET Networking & Routing Subsystem.

Components:
1. Dual-Band Heterogeneous Links (2.4 GHz High-Bandwidth & 915 MHz LoRa Fallback)
2. Log-Distance Path Loss Model (PL_0 = 40.05 dB, eta_LoS = 2.05, eta_NLoS = 3.60)
3. 3D Ray-AABB Building Occlusion Engine (+22 dB attenuation per intersected structure)
4. Link-State Dijkstra Routing Solver with battery-aware cost weights
5. DTN Ring Buffers (250-packet FIFO per drone) and Hop Telemetry Tracing
"""

from __future__ import annotations

import collections
import heapq
import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Sequence, Set, Tuple

import numpy as np


# ============================================================================
# 1. DATA MODELS & PACKET STRUCTURE
# ============================================================================

class RadioBand(Enum):
    BAND_2_4_GHZ = "BAND_2_4_GHZ"   # High bandwidth: video & LiDAR point clouds
    BAND_915_MHZ = "BAND_915_MHZ"   # Long range fallback: C2 telemetry & heartbeats


@dataclass
class TelemetryPacket:
    """Network packet container with hop history tracing."""
    packet_id: int
    src_id: int
    dst_id: int                         # 0 is always GCS Base Station
    payload_type: str                   # "C2_TELEMETRY", "POINT_CLOUD", "ALERT"
    payload_size_bytes: int
    creation_time: float
    hop_trace: List[str] = field(default_factory=list)  # e.g. ["UAV_6", "UAV_2", "GCS"]
    delivered_time: Optional[float] = None
    band_used: RadioBand = RadioBand.BAND_2_4_GHZ

    @property
    def latency_seconds(self) -> float:
        if self.delivered_time is not None:
            return max(0.0, self.delivered_time - self.creation_time)
        return 0.0

    @property
    def hop_count(self) -> int:
        return len(self.hop_trace)


@dataclass
class LinkQuality:
    """RF Link state between two network nodes."""
    node_i: int
    node_j: int
    distance_m: float
    is_los: bool
    path_loss_db: float
    snr_db: float
    p_rx_dbm: float
    band: RadioBand
    is_connected: bool
    bitrate_mbps: float


# ============================================================================
# 2. 3D RAY-AABB BUILDING OCCLUSION ENGINE
# ============================================================================

@dataclass
class BuildingAABB:
    min_pt: np.ndarray  # (3,) [min_x, min_y, min_z]
    max_pt: np.ndarray  # (3,) [max_x, max_y, max_z]
    name: str = "building"


class BuildingOcclusionEngine:
    """3D Ray-Axis Aligned Bounding Box (AABB) Occlusion Engine.
    
    Evaluates whether direct line-of-sight between two nodes penetrates
    urban structural geometry and computes penetration penalties (+22 dB per structure).
    """

    def __init__(self, attenuation_per_building_db: float = 22.0):
        self.attenuation_penalty = attenuation_per_building_db
        self.buildings: List[BuildingAABB] = []

    def add_building(self, min_pt: Sequence[float], max_pt: Sequence[float], name: str = "building") -> None:
        self.buildings.append(
            BuildingAABB(
                min_pt=np.array(min_pt, dtype=np.float64),
                max_pt=np.array(max_pt, dtype=np.float64),
                name=name,
            )
        )

    def populate_default_urban_scene(self) -> None:
        """Populates urban structures matching the disaster sector."""
        self.buildings.clear()
        self.add_building([-40, -40, 0], [-20, -20, 25], "Office_Highrise")
        self.add_building([20, -35, 0], [45, -15, 18], "Commercial_Tower")
        self.add_building([-15, 20, 0], [15, 45, 12], "Damaged_School")
        self.add_building([-10, -10, 0], [10, 10, 5], "Collapsed_Rubble_Core")
        self.add_building([25, 10, 0], [35, 25, 4], "Debris_Block_East")
        self.add_building([-35, 10, 0], [-22, 22, 6], "Warehouse_West")

    def test_link_occlusion(self, p_start: np.ndarray, p_end: np.ndarray) -> Tuple[bool, int, float]:
        """Tests line segment between p_start and p_end against all building AABBs.
        
        Returns:
            (is_los, intersected_buildings_count, total_attenuation_penalty_db)
        """
        diff = p_end - p_start
        dist = float(np.linalg.norm(diff))
        if dist < 1e-4:
            return True, 0, 0.0

        dir_vec = diff / dist
        safe_dir = np.where(np.abs(dir_vec) > 1e-7, dir_vec, np.sign(dir_vec + 1e-12) * 1e-7)
        inv_d = 1.0 / safe_dir

        intersections = 0

        for b in self.buildings:
            # Kay-Kajiya slab intersection test
            t1 = (b.min_pt - p_start) * inv_d
            t2 = (b.max_pt - p_start) * inv_d

            t_min = np.minimum(t1, t2)
            t_max = np.maximum(t1, t2)

            t_enter = float(np.max(t_min))
            t_exit = float(np.min(t_max))

            # Hit condition: enter <= exit and enter within [0, dist]
            if t_exit >= t_enter and t_enter <= dist and t_exit >= 0.0:
                intersections += 1

        is_los = (intersections == 0)
        penalty_db = intersections * self.attenuation_penalty
        return is_los, intersections, penalty_db


# ============================================================================
# 3. DUAL-BAND LOG-DISTANCE PATH LOSS MODEL
# ============================================================================

class DualBandChannelModel:
    """Heterogeneous Dual-Band Path Loss & Link Quality Model.
    
    Equations:
      PL(d) = PL_0 + 10 * eta * log10(d / d_0) + X_sigma + ObstaclePenalty
      where:
        PL_0 = 40.05 dB at d_0 = 1.0 m (for 2.4 GHz)
        eta_LoS = 2.05 (Clear Line of Sight)
        eta_NLoS = 3.60 (Obstructed Non-Line of Sight)
    """

    def __init__(
        self,
        pl0_db: float = 40.05,
        eta_los: float = 2.05,
        eta_nlos: float = 3.60,
    ):
        self.pl0 = pl0_db
        self.eta_los = eta_los
        self.eta_nlos = eta_nlos

        # 2.4 GHz parameters (WiFi/COFDM data link)
        self.tx_power_2_4 = 23.0        # dBm (200 mW)
        self.rx_sensitivity_2_4 = -90.0 # dBm
        self.noise_floor_2_4 = -98.0    # dBm
        self.max_bitrate_2_4 = 24.0     # Mbps

        # 915 MHz parameters (LoRa resilient telemetry fallback)
        self.tx_power_915 = 27.0        # dBm (500 mW)
        self.rx_sensitivity_915 = -125.0# dBm (extreme sensitivity)
        self.noise_floor_915 = -118.0   # dBm
        self.max_bitrate_915 = 0.25     # Mbps (250 kbps)

        # Friis wavelength ratio offset for 915 MHz vs 2.4 GHz:
        # 20 * log10(915 / 2400) = -8.38 dB path loss benefit for 915 MHz
        self.freq_offset_915_db = 20.0 * math.log10(915.0 / 2400.0)

    def evaluate_link(
        self,
        p_i: np.ndarray,
        p_j: np.ndarray,
        is_los: bool,
        obstacle_penalty_db: float,
    ) -> Tuple[LinkQuality, LinkQuality]:
        """Calculates path loss, received power, and SNR for both bands.
        
        Returns:
            (link_2_4_ghz, link_915_mhz)
        """
        dist = max(1.0, float(np.linalg.norm(p_i - p_j)))
        eta = self.eta_los if is_los else self.eta_nlos

        # Log-distance path loss
        pl_base = self.pl0 + 10.0 * eta * math.log10(dist)

        # 1. Band 1: 2.4 GHz Link
        pl_2_4 = pl_base + obstacle_penalty_db
        p_rx_2_4 = self.tx_power_2_4 - pl_2_4
        snr_2_4 = p_rx_2_4 - self.noise_floor_2_4
        is_connected_2_4 = p_rx_2_4 >= self.rx_sensitivity_2_4

        # Shannon-Hartley capacity approximation
        if is_connected_2_4 and snr_2_4 > 0:
            rate_factor = min(1.0, snr_2_4 / 30.0)
            bitrate_2_4 = self.max_bitrate_2_4 * rate_factor
        else:
            bitrate_2_4 = 0.0

        link_2_4 = LinkQuality(
            node_i=0, node_j=0,
            distance_m=dist,
            is_los=is_los,
            path_loss_db=pl_2_4,
            snr_db=snr_2_4,
            p_rx_dbm=p_rx_2_4,
            band=RadioBand.BAND_2_4_GHZ,
            is_connected=is_connected_2_4,
            bitrate_mbps=bitrate_2_4,
        )

        # 2. Band 2: 915 MHz LoRa Fallback Link
        # Enjoys frequency propagation advantage (-8.38 dB) and lower obstacle attenuation (0.6x)
        pl_915 = (pl_base + self.freq_offset_915_db) + (obstacle_penalty_db * 0.65)
        p_rx_915 = self.tx_power_915 - pl_915
        snr_915 = p_rx_915 - self.noise_floor_915
        is_connected_915 = p_rx_915 >= self.rx_sensitivity_915

        if is_connected_915 and snr_915 > 0:
            bitrate_915 = self.max_bitrate_915 * min(1.0, snr_915 / 20.0)
        else:
            bitrate_915 = 0.0

        link_915 = LinkQuality(
            node_i=0, node_j=0,
            distance_m=dist,
            is_los=is_los,
            path_loss_db=pl_915,
            snr_db=snr_915,
            p_rx_dbm=p_rx_915,
            band=RadioBand.BAND_915_MHZ,
            is_connected=is_connected_915,
            bitrate_mbps=bitrate_915,
        )

        return link_2_4, link_915


# ============================================================================
# 4. DTN RING BUFFERS (DELAY-TOLERANT NETWORKING)
# ============================================================================

class DTNRingBuffer:
    """Fixed-capacity FIFO ring buffer storing telemetry during signal loss.
    
    Capacity: 250 packets. Drops oldest packet if buffer overflows.
    Flushes stored packets in FIFO order upon network reconnection.
    """

    def __init__(self, capacity: int = 250):
        self.capacity = capacity
        self.buffer: collections.deque[TelemetryPacket] = collections.deque(maxlen=capacity)
        self.total_buffered_count = 0
        self.total_dropped_overflow = 0

    def push(self, packet: TelemetryPacket) -> bool:
        """Stores packet in FIFO ring buffer."""
        if len(self.buffer) >= self.capacity:
            self.total_dropped_overflow += 1
        self.buffer.append(packet)
        self.total_buffered_count += 1
        return True

    def flush_all(self) -> List[TelemetryPacket]:
        """Drains and returns all buffered packets in chronological FIFO order."""
        flushed = list(self.buffer)
        self.buffer.clear()
        return flushed

    def __len__(self) -> int:
        return len(self.buffer)

    @property
    def is_empty(self) -> bool:
        return len(self.buffer) == 0


# ============================================================================
# 5. FANET LINK-STATE DIJKSTRA ROUTING SOLVER
# ============================================================================

class FANETRouter:
    """Dynamic Link-State Graph Routing Solver for UAV Ad-hoc Networks.
    
    Computes shortest path tree to GCS (Node 0) based on:
    - Euclidean distance
    - SNR / Link quality
    - Obstacle NLoS penalties
    - Node State-of-Charge (penalizing low-battery nodes <= 25% to preserve mesh topology)
    """

    def __init__(
        self,
        gcs_position: Optional[np.ndarray] = None,
        alpha_dist: float = 0.05,
        alpha_snr: float = 0.8,
        battery_exhaust_penalty: float = 45.0,
    ):
        self.gcs_pos = np.array(gcs_position if gcs_position is not None else [0.0, 0.0, 5.0], dtype=np.float64)
        self.alpha_dist = alpha_dist
        self.alpha_snr = alpha_snr
        self.battery_penalty = battery_exhaust_penalty

        self.occlusion = BuildingOcclusionEngine()
        self.channel = DualBandChannelModel()

        # DTN ring buffers per drone (drone_id -> buffer)
        self.dtn_buffers: Dict[int, DTNRingBuffer] = {}

        # Packet delivery stats
        self.total_packets_sent = 0
        self.total_packets_delivered = 0
        self.latency_samples: List[float] = []

    def register_drone(self, drone_id: int) -> None:
        if drone_id not in self.dtn_buffers:
            self.dtn_buffers[drone_id] = DTNRingBuffer(capacity=250)

    def compute_routing_graph(
        self,
        drone_positions: Dict[int, np.ndarray],
        drone_soc: Dict[int, float],
    ) -> Tuple[Dict[int, List[int]], Dict[Tuple[int, int], LinkQuality]]:
        """Constructs adjacency graph and computes shortest paths to GCS (Node 0) via Dijkstra."""
        # Nodes: 0 (GCS), 1..N (UAVs)
        all_positions: Dict[int, np.ndarray] = {0: self.gcs_pos}
        all_positions.update(drone_positions)

        node_ids = list(all_positions.keys())
        active_links: Dict[Tuple[int, int], LinkQuality] = {}

        # 1. Build adjacency list with edge weights
        adj: Dict[int, List[Tuple[int, float, RadioBand]]] = {node: [] for node in node_ids}

        for i in range(len(node_ids)):
            u = node_ids[i]
            pos_u = all_positions[u]
            for j in range(i + 1, len(node_ids)):
                v = node_ids[j]
                pos_v = all_positions[v]

                # Check 3D ray-building occlusion
                is_los, obs_count, obs_penalty = self.occlusion.test_link_occlusion(pos_u, pos_v)

                # Evaluate dual-band propagation
                link_24, link_915 = self.channel.evaluate_link(pos_u, pos_v, is_los, obs_penalty)
                link_24.node_i, link_24.node_j = u, v
                link_915.node_i, link_915.node_j = u, v

                # Determine active carrier band
                selected_link: Optional[LinkQuality] = None
                if link_24.is_connected:
                    selected_link = link_24
                elif link_915.is_connected:
                    selected_link = link_915

                if selected_link is not None:
                    active_links[(u, v)] = selected_link
                    active_links[(v, u)] = selected_link

                    # Base routing cost
                    dist_cost = self.alpha_dist * selected_link.distance_m
                    snr_cost = self.alpha_snr * max(0.0, 30.0 - selected_link.snr_db)
                    base_edge_cost = dist_cost + snr_cost

                    # Battery penalty on node v (when routing through v)
                    soc_v = drone_soc.get(v, 100.0)
                    penalty_v = self.battery_penalty if (v != 0 and soc_v <= 25.0) else 0.0

                    soc_u = drone_soc.get(u, 100.0)
                    penalty_u = self.battery_penalty if (u != 0 and soc_u <= 25.0) else 0.0

                    adj[u].append((v, base_edge_cost + penalty_v, selected_link.band))
                    adj[v].append((u, base_edge_cost + penalty_u, selected_link.band))

        # 2. Dijkstra shortest-path algorithm toward GCS (Node 0)
        # We compute shortest paths from Node 0 to all other nodes (symmetric in undirected graph)
        dist_map: Dict[int, float] = {node: float("inf") for node in node_ids}
        prev_map: Dict[int, Optional[int]] = {node: None for node in node_ids}
        dist_map[0] = 0.0

        pq = [(0.0, 0)]  # (cost, node)

        while pq:
            curr_dist, u = heapq.heappop(pq)
            if curr_dist > dist_map[u]:
                continue

            for v, weight, band in adj[u]:
                if dist_map[u] + weight < dist_map[v]:
                    dist_map[v] = dist_map[u] + weight
                    prev_map[v] = u
                    heapq.heappush(pq, (dist_map[v], v))

        # 3. Construct hop paths from each drone back to GCS (0)
        routes_to_gcs: Dict[int, List[int]] = {}
        for drone_id in drone_positions.keys():
            if dist_map[drone_id] < float("inf"):
                # Trace path from drone_id back to 0
                path = [drone_id]
                curr = drone_id
                while curr is not None and curr != 0:
                    curr = prev_map[curr]
                    if curr is not None:
                        path.append(curr)
                if path[-1] == 0:
                    routes_to_gcs[drone_id] = path

        return routes_to_gcs, active_links

    def transmit_telemetry(
        self,
        src_drone_id: int,
        payload_type: str,
        size_bytes: int,
        routes_to_gcs: Dict[int, List[int]],
        active_links: Dict[Tuple[int, int], LinkQuality],
        sim_time: float,
    ) -> Tuple[bool, Optional[TelemetryPacket]]:
        """Sends telemetry packet through FANET mesh or queues into DTN ring buffer."""
        self.register_drone(src_drone_id)
        self.total_packets_sent += 1

        pkt = TelemetryPacket(
            packet_id=self.total_packets_sent,
            src_id=src_drone_id,
            dst_id=0,
            payload_type=payload_type,
            payload_size_bytes=size_bytes,
            creation_time=sim_time,
        )

        # Check if connected route to GCS exists
        if src_drone_id in routes_to_gcs:
            route = routes_to_gcs[src_drone_id]  # e.g. [6, 2, 0]
            # Construct hop trace
            hop_labels = [f"UAV_{nid}" if nid != 0 else "GCS" for nid in route]
            pkt.hop_trace = hop_labels

            # Determine carrier band along first hop
            next_hop = route[1] if len(route) > 1 else 0
            if (src_drone_id, next_hop) in active_links:
                pkt.band_used = active_links[(src_drone_id, next_hop)].band

            # Latency = 3 ms per hop + propagation
            delivery_latency = 0.003 * (len(route) - 1)
            pkt.delivered_time = sim_time + delivery_latency

            self.total_packets_delivered += 1
            self.latency_samples.append(pkt.latency_seconds)

            # Flush any older DTN buffered packets upon reconnection
            dtn_buf = self.dtn_buffers[src_drone_id]
            if not dtn_buf.is_empty:
                flushed = dtn_buf.flush_all()
                for old_pkt in flushed:
                    old_pkt.hop_trace = hop_labels
                    old_pkt.delivered_time = sim_time + delivery_latency
                    self.total_packets_delivered += 1
                    self.latency_samples.append(old_pkt.latency_seconds)

            return True, pkt
        else:
            # Route broken / signal loss -> Store in DTN 250-packet FIFO ring buffer
            self.dtn_buffers[src_drone_id].push(pkt)
            return False, pkt

    def get_network_metrics(self) -> Dict[str, float]:
        """Calculates Packet Delivery Ratio (PDR), latency, and buffer occupancies."""
        pdr = (self.total_packets_delivered / max(1, self.total_packets_sent)) * 100.0
        mean_latency = float(np.mean(self.latency_samples)) if self.latency_samples else 0.0
        buffered_total = sum(len(buf) for buf in self.dtn_buffers.values())

        return {
            "pdr_percent": float(pdr),
            "mean_latency_ms": float(mean_latency * 1000.0),
            "total_sent": float(self.total_packets_sent),
            "total_delivered": float(self.total_packets_delivered),
            "total_buffered": float(buffered_total),
        }

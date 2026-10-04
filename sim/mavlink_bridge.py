"""MAVLink v2.0 UDP Bridge for UAV-X Swarm Architecture.

Integrates real-time swarm telemetry directly with ArduPilot/PX4 SITL and
Ground Control Stations (QGroundControl, Mission Planner) over UDP port :14550.

Emits standard MAVLink v2.0 packets:
- HEARTBEAT
- GLOBAL_POSITION_INT
- ATTITUDE
- RADIO_STATUS
"""

from __future__ import annotations

import io
import logging
import math
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Set, Tuple

try:
    from pymavlink.dialects.v20 import common as mavlink2
    PYMAVLINK_AVAILABLE = True
except ImportError:
    PYMAVLINK_AVAILABLE = False

logger = logging.getLogger("mavlink_bridge")


@dataclass
class DroneTelemetry:
    """Internal state container for a single swarm UAV."""
    sysid: int                          # System ID (1, 2, 3...)
    compid: int = 1                     # Component ID (default 1 = autopilot)
    lat_deg: float = 28.6139            # Latitude in degrees
    lon_deg: float = 77.2090            # Longitude in degrees
    alt_msl_m: float = 15.0             # Altitude above Mean Sea Level (m)
    alt_rel_m: float = 15.0             # Relative altitude above ground (m)
    vx: float = 0.0                     # Velocity X East (m/s)
    vy: float = 0.0                     # Velocity Y North (m/s)
    vz: float = 0.0                     # Velocity Z Up (m/s)
    roll_rad: float = 0.0               # Roll angle (radians)
    pitch_rad: float = 0.0              # Pitch angle (radians)
    yaw_rad: float = 0.0                # Yaw angle (radians)
    rollspeed: float = 0.0              # Roll rate (rad/s)
    pitchspeed: float = 0.0             # Pitch rate (rad/s)
    yawspeed: float = 0.0               # Yaw rate (rad/s)
    armed: bool = True                  # Safety armed state
    mode: str = "GUIDED"                # Flight mode: GUIDED, AUTO, RTL, LAND
    battery_pct: float = 95.0           # Battery state of charge (0-100%)
    rssi: int = 210                     # Signal strength (0-255)
    remrssi: int = 200                  # Remote signal strength (0-255)
    txbuf_pct: int = 90                 # Tx buffer free percentage
    noise: int = 15                     # Radio noise floor
    remnoise: int = 18                  # Remote radio noise floor


class MAVLinkBridge:
    """Bidirectional MAVLink v2.0 UDP Bridge connecting Swarm telemetry to GCS/SITL.
    
    Default port: 14550 (Standard QGroundControl / Mission Planner broadcast port).
    """

    def __init__(
        self,
        bind_host: str = "0.0.0.0",
        bind_port: int = 14550,
        gcs_target_host: str = "127.0.0.1",
        gcs_target_port: int = 14550,
        broadcast_rate_hz: float = 20.0,
    ):
        self.bind_host = bind_host
        self.bind_port = bind_port
        self.gcs_target_host = gcs_target_host
        self.gcs_target_port = gcs_target_port
        self.broadcast_rate_hz = broadcast_rate_hz
        self.dt = 1.0 / broadcast_rate_hz

        # Sockets
        self._sock: Optional[socket.socket] = None
        self._gcs_clients: Set[Tuple[str, int]] = { (gcs_target_host, gcs_target_port) }
        self._clients_lock = threading.Lock()

        # Telemetry storage: key = sysid
        self.drones: Dict[int, DroneTelemetry] = {}
        self._drones_lock = threading.Lock()

        # Command callback: callback(sysid, command_type, params_dict)
        self.on_command: Optional[Callable[[int, str, dict], None]] = None

        # Threads
        self._running = False
        self._tx_thread: Optional[threading.Thread] = None
        self._rx_thread: Optional[threading.Thread] = None

        # Custom MAVLink writers per sysid
        self._mav_encoders: Dict[int, Tuple[io.BytesIO, any]] = {}

        # Pre-initialize socket
        self._init_socket()

    def _init_socket(self) -> None:
        """Bind or configure UDP socket."""
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.settimeout(0.5)

        try:
            # Try binding to requested port
            self._sock.bind((self.bind_host, self.bind_port))
            logger.info(f"MAVLink UDP Bridge bound to {self.bind_host}:{self.bind_port}")
        except OSError:
            # If port 14550 is held by QGroundControl, bind to 0 (ephemeral)
            # and target 127.0.0.1:14550 directly
            self._sock.bind((self.bind_host, 0))
            ephemeral_port = self._sock.getsockname()[1]
            logger.info(
                f"MAVLink port {self.bind_port} occupied (e.g. by QGC). "
                f"Bridge bound to ephemeral port {ephemeral_port}, transmitting to {self.gcs_target_host}:{self.gcs_target_port}"
            )

    def _get_encoder(self, sysid: int, compid: int = 1):
        """Returns or creates a MAVLink v2 encoder for the given system ID."""
        if sysid not in self._mav_encoders:
            buf = io.BytesIO()
            if PYMAVLINK_AVAILABLE:
                mav = mavlink2.MAVLink(buf, srcSystem=sysid, srcComponent=compid)
                # Ensure MAVLink v2 protocol framing
                mav.robust_parsing = True
            else:
                mav = None
            self._mav_encoders[sysid] = (buf, mav)
        return self._mav_encoders[sysid]

    def register_drone(self, drone: DroneTelemetry) -> None:
        """Register or update a drone in the swarm."""
        with self._drones_lock:
            self.drones[drone.sysid] = drone

    def update_telemetry(self, sysid: int, **kwargs) -> None:
        """Thread-safe update of drone state parameters."""
        with self._drones_lock:
            if sysid in self.drones:
                d = self.drones[sysid]
                for k, v in kwargs.items():
                    if hasattr(d, k):
                        setattr(d, k, v)

    def encode_packets_for_drone(self, drone: DroneTelemetry, boot_ms: int, tick_count: int) -> bytes:
        """Encode standard MAVLink v2 packets for a drone."""
        if not PYMAVLINK_AVAILABLE:
            return b""

        buf, mav = self._get_encoder(drone.sysid, drone.compid)
        buf.seek(0)
        buf.truncate(0)

        # 1. HEARTBEAT (1 Hz)
        if tick_count % int(max(1, self.broadcast_rate_hz)) == 0:
            base_mode = (
                mavlink2.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
                | (mavlink2.MAV_MODE_FLAG_SAFETY_ARMED if drone.armed else 0)
            )
            # Custom mode: 4 for ArduPilot GUIDED
            custom_mode = 4 if drone.mode == "GUIDED" else 3  # 3: AUTO
            mav.heartbeat_send(
                type=mavlink2.MAV_TYPE_QUADROTOR,
                autopilot=mavlink2.MAV_AUTOPILOT_ARDUPILOTMEGA,
                base_mode=base_mode,
                custom_mode=custom_mode,
                system_status=mavlink2.MAV_STATE_ACTIVE if drone.armed else mavlink2.MAV_STATE_STANDBY,
            )

        # 2. GLOBAL_POSITION_INT (Emitted every frame)
        hdg_cdeg = int((math.degrees(drone.yaw_rad) % 360.0) * 100.0)
        mav.global_position_int_send(
            time_boot_ms=boot_ms,
            lat=int(drone.lat_deg * 1e7),
            lon=int(drone.lon_deg * 1e7),
            alt=int(drone.alt_msl_m * 1000.0),             # mm MSL
            relative_alt=int(drone.alt_rel_m * 1000.0),    # mm AGL
            vx=int(drone.vx * 100.0),                      # cm/s
            vy=int(drone.vy * 100.0),                      # cm/s
            vz=int(-drone.vz * 100.0),                     # cm/s (NED Down is positive)
            hdg=hdg_cdeg,
        )

        # 3. ATTITUDE (Emitted every frame)
        mav.attitude_send(
            time_boot_ms=boot_ms,
            roll=float(drone.roll_rad),
            pitch=float(drone.pitch_rad),
            yaw=float(drone.yaw_rad),
            rollspeed=float(drone.rollspeed),
            pitchspeed=float(drone.pitchspeed),
            yawspeed=float(drone.yawspeed),
        )

        # 4. RADIO_STATUS (2 Hz)
        if tick_count % int(max(1, self.broadcast_rate_hz / 2.0)) == 0:
            mav.radio_status_send(
                rssi=int(drone.rssi),
                remrssi=int(drone.remrssi),
                txbuf=int(drone.txbuf_pct),
                noise=int(drone.noise),
                remnoise=int(drone.remnoise),
                rxerrors=0,
                fixed=0,
            )

        return buf.getvalue()

    def start(self) -> None:
        """Start background broadcast and receiver threads."""
        if self._running:
            return
        self._running = True

        self._tx_thread = threading.Thread(target=self._tx_loop, name="mavlink_tx", daemon=True)
        self._rx_thread = threading.Thread(target=self._rx_loop, name="mavlink_rx", daemon=True)
        self._tx_thread.start()
        self._rx_thread.start()
        logger.info("MAVLink v2.0 UDP Bridge service started.")

    def stop(self) -> None:
        """Gracefully stop bridge service."""
        self._running = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
        if self._tx_thread and self._tx_thread.is_alive():
            self._tx_thread.join(timeout=1.0)
        if self._rx_thread and self._rx_thread.is_alive():
            self._rx_thread.join(timeout=1.0)
        logger.info("MAVLink v2.0 UDP Bridge service stopped.")

    def _tx_loop(self) -> None:
        """Periodic UDP packet transmission loop."""
        start_time = time.time()
        tick_count = 0

        while self._running:
            loop_start = time.time()
            boot_ms = int((loop_start - start_time) * 1000.0)
            tick_count += 1

            with self._drones_lock:
                drone_list = list(self.drones.values())

            with self._clients_lock:
                targets = list(self._gcs_clients)

            for drone in drone_list:
                payload = self.encode_packets_for_drone(drone, boot_ms, tick_count)
                if not payload or not self._sock:
                    continue

                for addr in targets:
                    try:
                        self._sock.sendto(payload, addr)
                    except OSError:
                        pass

            elapsed = time.time() - loop_start
            sleep_time = max(0.001, self.dt - elapsed)
            time.sleep(sleep_time)

    def _rx_loop(self) -> None:
        """Inbound UDP packet parser (listens for commands from QGC/Mission Planner)."""
        if not PYMAVLINK_AVAILABLE or not self._sock:
            return

        mav_decoder = mavlink2.MAVLink(None)
        mav_decoder.robust_parsing = True

        while self._running:
            try:
                data, addr = self._sock.recvfrom(4096)
                if not data:
                    continue

                # Auto-register client endpoint
                with self._clients_lock:
                    if addr not in self._gcs_clients:
                        self._gcs_clients.add(addr)
                        logger.info(f"Registered new GCS client at {addr[0]}:{addr[1]}")

                # Parse MAVLink stream
                msgs = mav_decoder.parse_buffer(data)
                if not msgs:
                    continue

                for msg in msgs:
                    self._handle_inbound_msg(msg, addr)

            except (socket.timeout, BlockingIOError):
                continue
            except OSError:
                break
            except Exception as e:
                logger.debug(f"MAVLink RX error: {e}")

    def _handle_inbound_msg(self, msg, addr: Tuple[str, int]) -> None:
        """Dispatch GCS commands and respond to param/mission queries."""
        msg_type = msg.get_type()

        # Handle PARAM_REQUEST_LIST (vital for QGroundControl connection handshake)
        if msg_type == "PARAM_REQUEST_LIST":
            target_sys = getattr(msg, "target_system", 1)
            self._send_dummy_param(target_sys, addr)

        # Handle COMMAND_LONG (Arm, Disarm, Takeoff, Land)
        elif msg_type == "COMMAND_LONG":
            cmd = getattr(msg, "command", 0)
            target_sys = getattr(msg, "target_system", 1)

            # MAV_CMD_COMPONENT_ARM_DISARM = 400
            if cmd == 400:
                arm_val = getattr(msg, "param1", 0) == 1.0
                self.update_telemetry(target_sys, armed=arm_val)
                if self.on_command:
                    self.on_command(target_sys, "ARM" if arm_val else "DISARM", {"armed": arm_val})
                self._send_command_ack(target_sys, cmd, mavlink2.MAV_RESULT_ACCEPTED, addr)

            # MAV_CMD_NAV_TAKEOFF = 22
            elif cmd == 22:
                target_alt = getattr(msg, "param7", 15.0)
                if self.on_command:
                    self.on_command(target_sys, "TAKEOFF", {"altitude": target_alt})
                self._send_command_ack(target_sys, cmd, mavlink2.MAV_RESULT_ACCEPTED, addr)

            # MAV_CMD_NAV_LAND = 21
            elif cmd == 21:
                if self.on_command:
                    self.on_command(target_sys, "LAND", {})
                self._send_command_ack(target_sys, cmd, mavlink2.MAV_RESULT_ACCEPTED, addr)

        # Handle SET_POSITION_TARGET_LOCAL_NED
        elif msg_type == "SET_POSITION_TARGET_LOCAL_NED":
            target_sys = getattr(msg, "target_system", 1)
            x = getattr(msg, "x", 0.0)
            y = getattr(msg, "y", 0.0)
            z = getattr(msg, "z", 0.0)
            if self.on_command:
                self.on_command(target_sys, "GOTO_LOCAL_NED", {"x": x, "y": y, "z": z})

    def _send_command_ack(self, sysid: int, cmd: int, result: int, addr: Tuple[str, int]) -> None:
        """Sends MAVLink COMMAND_ACK packet back to GCS."""
        if not PYMAVLINK_AVAILABLE or not self._sock:
            return
        buf, mav = self._get_encoder(sysid, 1)
        buf.seek(0)
        buf.truncate(0)
        mav.command_ack_send(command=cmd, result=result)
        try:
            self._sock.sendto(buf.getvalue(), addr)
        except OSError:
            pass

    def _send_dummy_param(self, sysid: int, addr: Tuple[str, int]) -> None:
        """Replies with a dummy SYSID_THISMAV parameter so GCS stops polling."""
        if not PYMAVLINK_AVAILABLE or not self._sock:
            return
        buf, mav = self._get_encoder(sysid, 1)
        buf.seek(0)
        buf.truncate(0)
        mav.param_value_send(
            param_id=b"SYSID_THISMAV\x00\x00\x00",
            param_value=float(sysid),
            param_type=mavlink2.MAV_PARAM_TYPE_REAL32,
            param_count=1,
            param_index=0,
        )
        try:
            self._sock.sendto(buf.getvalue(), addr)
        except OSError:
            pass

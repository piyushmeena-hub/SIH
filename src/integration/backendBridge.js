/**
 * Backend WebSocket Bridge & Telemetry Synchronizer for UAV-X Swarm.
 *
 * Connects directly to the FastAPI 30 Hz WebSocket telemetry stream at ws://localhost:8080/ws/telemetry.
 * Serializes and dispatches live telemetry into sharedSim (SimulationStore) for:
 *   - 6-DOF Quadrotor Dynamics with real roll/pitch/yaw tilt
 *   - Khatib APF collision avoidance & downwash avoidance
 *   - 4-Tier Altitude Corridor allocation (TIER_1..TIER_4)
 *   - Dual-Band FANET Links (2.4 GHz vs 915 MHz LoRa fallback) with multi-hop Dijkstra paths
 *   - 10-State MAVSDK Finite State Machine (IDLE..SURVEYING..RELAY..RTL)
 *   - OctoMap 3D Log-Odds voxel mapping & Shannon spatial entropy reduction
 *   - AI Vision & FLIR Thermal sensor fusion (36.8°C life verification & OpenCV hazards)
 *   - Bidirectional C2 command dispatching to backend
 */

import sharedSim from './simulationStore.js';
import { SIM_EVENTS } from './simulationEvents.js';

class BackendBridge {
  constructor() {
    this.ws = null;
    this.url = 'ws://localhost:8080/ws/telemetry';
    this.apiUrl = 'http://localhost:8080';
    this.connected = false;
    this.connecting = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 5000;

    // Telemetry rate tracking
    this.frameCount = 0;
    this.lastFpsCalcTime = performance.now();
    this.telemetryHz = 0;
    this.lastFrameSeq = 0;
    this.latestFrame = null;

    // Occupied voxels cache for OctoMap 3D visualization
    this.octomapVoxels = [];
    this.voxelFetchInterval = null;
  }

  init(customPort = 8080) {
    const host = typeof window !== 'undefined' ? window.location.hostname || 'localhost' : 'localhost';
    this.url = `ws://${host}:${customPort}/ws/telemetry`;
    this.apiUrl = `http://${host}:${customPort}`;
    this.connect();
    this.startVoxelPolling();
  }

  connect() {
    if (this.connecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;

    this.connecting = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.connected = true;
        this.connecting = false;
        this.reconnectAttempts = 0;
        sharedSim.state.backend = {
          connected: true,
          status: 'ONLINE',
          hz: 30,
          port: 8080,
          mavlinkActive: true,
          lastSeq: 0,
        };
        sharedSim.logSync('UAV-X Backend connected: 30 Hz Telemetry & MAVLink Bridge active');
        sharedSim.events.emit(SIM_EVENTS.STATE_SYNCED);
      };

      this.ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data);
          this.handleTelemetryFrame(frame);
        } catch {
          // Ignore occasional JSON parse errors on truncated sockets
        }
      };

      this.ws.onerror = () => {
        // Handled in onclose
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.connecting = false;
        this.telemetryHz = 0;
        sharedSim.state.backend.connected = false;
        sharedSim.state.backend.status = 'OFFLINE';
        sharedSim.state.backend.hz = 0;

        const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), this.maxReconnectDelay);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      };
    } catch {
      this.connecting = false;
      this.reconnectTimer = setTimeout(() => this.connect(), 2500);
    }
  }

  handleTelemetryFrame(frame) {
    if (!frame) return;
    this.frameCount++;
    this.latestFrame = frame;
    this.lastFrameSeq = frame.seq || 0;

    const now = performance.now();
    if (now - this.lastFpsCalcTime >= 1000) {
      this.telemetryHz = Math.round((this.frameCount * 1000) / (now - this.lastFpsCalcTime));
      this.frameCount = 0;
      this.lastFpsCalcTime = now;
      if (sharedSim.state.backend) {
        sharedSim.state.backend.hz = this.telemetryHz;
        sharedSim.state.backend.lastSeq = this.lastFrameSeq;
      }
    }

    // Sync telemetry directly into sharedSim
    sharedSim.syncBackendTelemetry(frame);
  }

  startVoxelPolling() {
    if (this.voxelFetchInterval) clearInterval(this.voxelFetchInterval);
    // Poll OctoMap occupied voxels every 2 seconds
    this.voxelFetchInterval = setInterval(async () => {
      if (!this.connected) return;
      try {
        const res = await fetch(`${this.apiUrl}/api/octomap_voxels`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.voxels)) {
            this.octomapVoxels = data.voxels;
            sharedSim.setOctomapVoxels(data.voxels, data.res || 1.0);
          }
        }
      } catch {
        // Backend busy or offline
      }
    }, 2000);
  }

  async sendCommand(action, droneId = null, extra = {}) {
    const payload = { action, drone_id: droneId, ...extra };
    // Try via WebSocket first
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
        return { success: true, transport: 'ws' };
      } catch {
        // Fall back to REST
      }
    }

    // Fallback to HTTP POST
    try {
      const res = await fetch(`${this.apiUrl}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  dispose() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.voxelFetchInterval) clearInterval(this.voxelFetchInterval);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}

export const backendBridge = new BackendBridge();
export default backendBridge;

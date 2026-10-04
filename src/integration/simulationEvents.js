/**
 * Centralized Event Types & Event Bus for 2D Swarm <-> 3D Disaster Simulation Integration
 */

export const SIM_EVENTS = {
  DISASTER_CHANGED: 'DISASTER_CHANGED',
  DISASTER_INTENSITY_CHANGED: 'DISASTER_INTENSITY_CHANGED',
  SIMULATION_PAUSED: 'SIMULATION_PAUSED',
  SIMULATION_TIME_CHANGED: 'SIMULATION_TIME_CHANGED',
  DRONE_UPDATED: 'DRONE_UPDATED',
  DRONE_SELECTED: 'DRONE_SELECTED',
  DRONE_DOWN: 'DRONE_DOWN',
  POI_CREATED: 'POI_CREATED',
  POI_UPDATED: 'POI_UPDATED',
  POI_ASSIGNED: 'POI_ASSIGNED',
  POI_COMPLETED: 'POI_COMPLETED',
  SURVIVOR_CREATED: 'SURVIVOR_CREATED',
  SURVIVOR_DETECTED: 'SURVIVOR_DETECTED',
  SURVIVOR_UPDATED: 'SURVIVOR_UPDATED',
  JAMMER_CHANGED: 'JAMMER_CHANGED',
  GPS_ZONE_CHANGED: 'GPS_ZONE_CHANGED',
  NETWORK_UPDATED: 'NETWORK_UPDATED',
  MISSION_TARGET_CHANGED: 'MISSION_TARGET_CHANGED',
  STATE_SYNCED: 'STATE_SYNCED',
};

export class SimulationEventBus {
  constructor() {
    this.listeners = new Map();
    this.logs = [];
    this.maxLogs = 120;
  }

  on(eventType, handler) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType).add(handler);
    return () => this.off(eventType, handler);
  }

  off(eventType, handler) {
    const set = this.listeners.get(eventType);
    if (set) set.delete(handler);
  }

  emit(eventType, payload = {}) {
    const set = this.listeners.get(eventType);
    if (set) {
      for (const fn of set) {
        try {
          fn(payload, eventType);
        } catch (err) {
          console.error(`[SYNC] Event handler error on ${eventType}:`, err);
        }
      }
    }
    const wildcard = this.listeners.get('*');
    if (wildcard) {
      for (const fn of wildcard) {
        try {
          fn(payload, eventType);
        } catch {
          // ignore wildcard errors
        }
      }
    }
  }

  logSync(message, payload = null) {
    const entry = {
      t: Date.now(),
      message: `[SYNC] ${message}`,
      payload,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    console.info(`[SYNC] ${message}`);
    return entry;
  }
}

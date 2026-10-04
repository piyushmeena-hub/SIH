// Canonical PoI Store and State Management Module
const POI_PRIORITY = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const POI_STATES = {
  UNASSIGNED: 'UNASSIGNED',
  ASSIGNED: 'ASSIGNED',
  IN_TRANSIT: 'IN_TRANSIT',
  SURVEYING: 'SURVEYING',
  DATA_CREATED: 'DATA_CREATED',
  UPLOADING: 'UPLOADING',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  SURVEYED: 'SURVEYED'
};

function createPoI(id, name, x, y, priority, surveyRadius = 45, surveyDuration = 10) {
  return {
    id,
    name,
    type: name,
    x,
    y,
    priority,
    surveyRadius,
    surveyDuration,
    assignedUavId: null,
    state: POI_STATES.UNASSIGNED,
    progress: 0,
    packetId: null,
    packetStatus: 'NOT_CREATED',
    evidence: null,
    route: null,
    isSurvivor: false,
    survivorId: null
  };
}

class CanonicalPoiStore {
  constructor() {
    this.pois = [];
    this.lastSurvivors = [];
    this.selectedPoiId = null;
    this.lastRenderedState = new Map();
    this.lastTableState = new Map();
    this.desyncCount = 0;
  }

  init(customPois) {
    if (customPois && Array.isArray(customPois) && customPois.length) {
      this.pois = customPois;
    } else {
      this.pois = [
        createPoI("POI-A", "Collapsed Bridge", 450, -80, "CRITICAL", 45, 8),
        createPoI("POI-B", "Hospital Wing", 510, -160, "HIGH", 45, 10),
        createPoI("POI-C", "School Building", 390, -180, "HIGH", 45, 10),
        createPoI("POI-D", "Residential Block", 560, -60, "MEDIUM", 45, 12),
        createPoI("POI-E", "Park Area", 590, -190, "LOW", 45, 12)
      ];
    }
    if (this.lastSurvivors && this.lastSurvivors.length > 0) {
      this.syncSurvivors(this.lastSurvivors);
    }
    this.lastRenderedState.clear();
    this.lastTableState.clear();
    return this.pois;
  }

  syncSurvivors(survivorsList = [], swarm = null) {
    this.lastSurvivors = survivorsList;
    const incomingIds = new Set(survivorsList.map(s => s.id));
    // Remove survivor PoIs that belong to an older disaster scatter
    for (let i = this.pois.length - 1; i >= 0; i--) {
      const p = this.pois[i];
      if (p.isSurvivor && !incomingIds.has(p.id)) {
        if (swarm && swarm.drones && p.assignedUavId) {
          const d = swarm.drones.find(u => u.id === p.assignedUavId);
          if (d && d.poiId === p.id) d.poiId = null;
        }
        this.pois.splice(i, 1);
      }
    }
    // Add or update incoming 3D survivors as rescue PoIs
    for (const s of survivorsList) {
      const x2d = s.position2D ? s.position2D.x : (s.x || 320);
      const y2d = s.position2D ? s.position2D.y : (s.y || -90);
      let existing = this.get(s.id);
      if (existing) {
        existing.x = x2d;
        existing.y = y2d;
        existing.isSurvivor = true;
        existing.survivorId = s.id;
      } else {
        const sp = createPoI(s.id, "Survivor Signal", x2d, y2d, "CRITICAL", 45, 9);
        sp.isSurvivor = true;
        sp.survivorId = s.id;
        this.pois.push(sp);
      }
    }
    if (swarm) {
      swarm.pois = this.pois;
      swarm.missionComplete = false;
    }
    return this.pois;
  }

  getAll() {
    return this.pois;
  }

  get(id) {
    return this.pois.find(p => p.id === id) || null;
  }

  addPoi(poi) {
    this.pois.push(poi);
  }

  assign(poiId, uavId, reason, time, swarm) {
    const poi = this.get(poiId);
    if (!poi) return;
    poi.assignedUavId = uavId;
    poi.state = POI_STATES.ASSIGNED;
    if (swarm && typeof logEvent === 'function') {
      logEvent(swarm, `${poi.id} assigned to ${uavId}. Reason: ${reason || poi.priority + ' priority'}`, 'info');
    }
  }

  setTransit(poiId) {
    const poi = this.get(poiId);
    if (!poi) return;
    if (poi.state === POI_STATES.ASSIGNED) {
      poi.state = POI_STATES.IN_TRANSIT;
    }
  }

  startSurvey(poiId, uavId, time, swarm) {
    const poi = this.get(poiId);
    if (!poi) return;
    if (poi.state === POI_STATES.ASSIGNED || poi.state === POI_STATES.IN_TRANSIT) {
      poi.state = POI_STATES.SURVEYING;
      if (swarm && typeof logEvent === 'function') {
        logEvent(swarm, `${uavId} arrived at ${poi.id} and started surveying`, 'info');
      }
    }
  }

  updateProgress(poiId, dt, uavId, time, swarm) {
    const poi = this.get(poiId);
    if (!poi || poi.state !== POI_STATES.SURVEYING) return;
    poi.progress += (dt / poi.surveyDuration) * 100;
    if (poi.progress >= 100) {
      poi.progress = 100;
      poi.state = POI_STATES.DATA_CREATED;
      poi.packetId = 'PKT-' + Math.floor(1000 + Math.random() * 9000);
      poi.packetStatus = 'PENDING';
      if (swarm && typeof logEvent === 'function') {
        logEvent(swarm, `${poi.id} survey completed by ${uavId}`, 'info');
        logEvent(swarm, `${poi.id} survey data packet ${poi.packetId} generated`, 'info');
      }
    }
  }

  setUploading(poiId) {
    const poi = this.get(poiId);
    if (!poi) return;
    if (poi.state === POI_STATES.DATA_CREATED) {
      poi.state = POI_STATES.UPLOADING;
    }
  }

  acknowledge(poiId, uavId, packetId, time, swarm) {
    const poi = this.get(poiId);
    if (!poi || poi.state === POI_STATES.SURVEYED) return;
    poi.state = POI_STATES.ACKNOWLEDGED;
    poi.packetStatus = 'DELIVERED';
    poi.evidence = `${uavId || 'UAV'} surveyed ${poi.id} at 50 m AGL. Packet ${packetId || poi.packetId} acknowledged by GCS.`;
    if (swarm && typeof logEvent === 'function') {
      logEvent(swarm, `${packetId || poi.packetId} acknowledged by GCS`, 'success');
      logEvent(swarm, `${poi.id} survey verified and evidence recorded`, 'success');
    }
    poi.state = POI_STATES.SURVEYED;
  }

  unassign(poiId, reason, time, swarm) {
    const poi = this.get(poiId);
    if (!poi) return;
    if (poi.state !== POI_STATES.SURVEYED && poi.state !== POI_STATES.ACKNOWLEDGED) {
      const oldUav = poi.assignedUavId;
      poi.assignedUavId = null;
      poi.state = POI_STATES.UNASSIGNED;
      poi.progress = 0;
      if (oldUav && swarm && typeof logEvent === 'function') {
        logEvent(swarm, `${poi.id} unassigned from ${oldUav}. Reason: ${reason || 'unfit/failsafe'}`, 'warn');
      }
    }
  }

  recordMapRender(poiId, state, assignedUavId, progress) {
    this.lastRenderedState.set(poiId, { state, assignedUavId, progress });
  }

  syncUi(swarm) {
    if (typeof document === 'undefined') return;
    const body = document.getElementById('poisBody');
    if (!body) return;

    let h = '';
    let surveyed = 0, active = 0, pending = 0, acked = 0;

    for (const p of this.pois) {
      if (p.state === POI_STATES.SURVEYED) surveyed++;
      else if (p.state === POI_STATES.UNASSIGNED) pending++;
      else active++;

      if (p.packetStatus === 'DELIVERED' || p.state === POI_STATES.SURVEYED) acked++;

      this.lastTableState.set(p.id, {
        state: p.state,
        assignedUavId: p.assignedUavId,
        progress: Math.floor(p.progress)
      });

      const selStyle = this.selectedPoiId === p.id ? ' style="outline:1px solid #38bdf8; background:rgba(56,189,248,0.12); cursor:pointer;"' : ' style="cursor:pointer;"';
      h += `<tr class="poi-row" data-poi-id="${p.id}"${selStyle}><td><b>${p.id}</b></td><td>${p.priority}</td><td>${p.assignedUavId || '-'}</td><td><span class="poi-tag state-${p.state}">${p.state}</span></td><td>${Math.floor(p.progress)}%</td><td>${p.packetId || '-'}</td><td style="font-size:10px">${p.evidence || '-'}</td></tr>`;
    }

    if (this._lastPoisHtml !== h) {
      body.innerHTML = h;
      this._lastPoisHtml = h;
    }

    // Mission status calculation
    const totalPois = this.pois.length;
    let airborne = 0, returning = 0, landed = 0, recharging = 0, failed = 0, activeRelays = 0;
    let isComplete = false;

    if (swarm && swarm.drones) {
      for (const d of swarm.drones) {
        if (d.mode === 'dead') failed++;
        else if (d.mode === 'landed') {
          landed++;
          if (d.role === 'RECHARGING') recharging++;
        } else if (d.mode === 'returning' || d.mode === 'landing') {
          airborne++;
          returning++;
        } else {
          airborne++;
        }
      }
      activeRelays = swarm.c2 && swarm.c2.relays ? swarm.c2.relays.length : 0;
      isComplete = !!swarm.missionComplete;
    }

    const statusBox = document.getElementById('missionStatusBox');
    if (statusBox) {
      statusBox.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:12px; font-weight:700;">MISSION STATUS: <span style="color:${isComplete ? '#4ade80' : '#38bdf8'}">${isComplete ? 'COMPLETE' : 'IN PROGRESS'}</span></span>
          <span style="font-size:11px;">SURVEYED: <b>${surveyed}/${totalPois}</b></span>
          <span style="font-size:11px;">ACKNOWLEDGED: <b>${acked}/${totalPois}</b></span>
        </div>
      `;
    }

    const uavMetrics = document.getElementById('uavFleetMetrics');
    if (uavMetrics) {
      uavMetrics.innerHTML = `
        <div style="display:flex; flex-wrap:wrap; gap:8px; font-size:11px; color:var(--text-dim);">
          <span>AIRBORNE: <b style="color:#38bdf8;">${airborne}</b></span>
          <span>RETURNING: <b style="color:#facc15;">${returning}</b></span>
          <span>LANDED: <b style="color:#4ade80;">${landed}</b></span>
          <span>RECHARGING: <b style="color:#fbbf24;">${recharging}</b></span>
          <span>ACTIVE RELAYS: <b>${activeRelays}</b></span>
        </div>
      `;
    }

    this.checkConsistency();
  }

  checkConsistency() {
    if (!this.lastRenderedState.size || !this.lastTableState.size) return true;

    for (const p of this.pois) {
      const mapItem = this.lastRenderedState.get(p.id);
      const tableItem = this.lastTableState.get(p.id);

      if (!mapItem || !tableItem) continue;

      if (mapItem.state !== tableItem.state || mapItem.assignedUavId !== tableItem.assignedUavId) {
        this.desyncCount++;
        const msg = `[PoI Consistency Error] Desync for ${p.id}: Map shows (state=${mapItem.state}, uav=${mapItem.assignedUavId}), Table shows (state=${tableItem.state}, uav=${tableItem.assignedUavId})`;
        console.error(msg);
        return false;
      }
    }
    return true;
  }
}

const PoiStore = new CanonicalPoiStore();
if (typeof window !== 'undefined') {
  window.PoiStore = PoiStore;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PoiStore, createPoI, POI_PRIORITY, POI_STATES };
}

function defaultPois() {
  return PoiStore.init();
}

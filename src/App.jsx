import { useEffect, useRef, useState, useCallback } from 'react';
import { createDisasterEngine, MODES_META } from './simulation/disasterEngine.js';
import sharedSim from './integration/simulationStore.js';
import { SIM_EVENTS } from './integration/simulationEvents.js';

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `T+${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function getRichterCategory(m) {
  if (m < 2.0) return 'Micro';
  if (m < 4.0) return 'Minor';
  if (m < 5.0) return 'Light';
  if (m < 6.0) return 'Moderate';
  if (m < 7.0) return 'Strong';
  if (m < 8.0) return 'Major';
  return 'Great';
}

function getDamageTierLabel(magnitude) {
  if (magnitude < 4.0) return { tier: 'Tier 1: No Damage', desc: 'Elastic sway only (intact)', className: 'tier-1' };
  if (magnitude < 5.5) return { tier: 'Tier 2: Minor Damage', desc: 'Hairline cracks & broken windows', className: 'tier-2' };
  if (magnitude < 7.0) return { tier: 'Tier 3: Moderate Damage', desc: 'Visible tilt, settling & dust', className: 'tier-3' };
  if (magnitude < 8.2) return { tier: 'Tier 4: Partial Collapse', desc: 'Upper shearing & severe tilt', className: 'tier-4' };
  return { tier: 'Tier 5: Catastrophic', desc: 'Pancake collapse into rubble piles', className: 'tier-5' };
}

export default function App() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const dockRef = useRef(null);
  const iframeRef = useRef(null);

  const [isLoading, setIsLoading] = useState(true);
  const [webglError, setWebglError] = useState(null);
  const [modeIndex, setModeIndex] = useState(0);
  const [viewMode, setViewMode] = useState('3d');
  const [intensity, setIntensity] = useState(1);
  const [showPeople, setShowPeople] = useState(true);
  const [autoRotate, setAutoRotate] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [paused, setPaused] = useState(false);
  const [timeScale, setTimeScale] = useState(5);
  const [infoOpen, setInfoOpen] = useState(() => window.innerWidth >= 640);
  const [hudStats, setHudStats] = useState({
    status: 'M7.0 event complete - Partial collapse: Upper-story shearing & tilt',
    waiting: 0,
  });

  // Single-burst Earthquake Event State (Initial state: post-M7.0 aftermath)
  const [earthquakeState, setEarthquakeState] = useState({
    active: false,
    elapsed: 10.0,
    duration: 10.0,
    magnitude: 7.0,
    pga: 0.08 * Math.pow(10, 0.28 * (7.0 - 5.0)),
  });

  const handleEarthquakeUpdate = useCallback(eq => {
    if (!eq) return;
    setEarthquakeState(prev => {
      if (
        prev.active === eq.active &&
        Math.abs(prev.elapsed - eq.elapsed) < 0.08 &&
        prev.magnitude === eq.magnitude &&
        Math.abs(prev.pga - eq.pga) < 0.005
      ) {
        return prev;
      }
      return {
        active: eq.active,
        elapsed: eq.elapsed,
        duration: eq.duration || 10.0,
        magnitude: eq.magnitude,
        pga: eq.pga,
      };
    });
  }, []);

  const handleTriggerEarthquake = useCallback(() => {
    engineRef.current?.triggerEarthquake();
  }, []);

  const handleResetEarthquakeBuildings = useCallback(() => {
    engineRef.current?.resetEarthquakeBuildings();
  }, []);

  const handleEarthquakeMagnitudeChange = useCallback(e => {
    const val = parseFloat(e.target.value);
    setEarthquakeState(prev => ({
      ...prev,
      magnitude: val,
      pga: 0.08 * Math.pow(10, 0.28 * (val - 5.0)),
    }));
    engineRef.current?.setEarthquakeMagnitude(val);
  }, []);

  // Throttled snapshot of SharedSimulationState for React HUD (5 Hz max)
  const [simSnapshot, setSimSnapshot] = useState(() => ({
    elapsedTime: 0,
    drones: [],
    pois: [],
    survivors: [],
    network: sharedSim.state.network,
    hazards: sharedSim.state.hazards,
    selectedDroneId: null,
    selectedPoiId: null,
  }));

  const syncSnapshotNow = useCallback(() => {
    const st = sharedSim.state;
    setPaused(st.mission.paused);
    setTimeScale(st.mission.timeScale);
    setSimSnapshot({
      elapsedTime: st.mission.elapsedTime,
      drones: st.drones.slice(),
      pois: st.pois.slice(),
      survivors: st.survivors.slice(),
      network: { ...st.network },
      hazards: {
        jammerCount: st.hazards.jammerZones.filter(j => j.on).length,
        gpsZoneCount: st.hazards.gpsDeniedZones.filter(z => z.on).length,
      },
      selectedDroneId: st.selection.selectedDroneId,
      selectedPoiId: st.selection.selectedPoiId,
    });
  }, []);

  useEffect(() => {
    let lastSyncMs = 0;
    const onStateSynced = () => {
      const now = performance.now();
      if (now - lastSyncMs < 180) return;
      lastSyncMs = now;
      syncSnapshotNow();
    };
    const unsubSync = sharedSim.on(SIM_EVENTS.STATE_SYNCED, onStateSynced);
    const unsubSelDrone = sharedSim.on(SIM_EVENTS.DRONE_SELECTED, syncSnapshotNow);
    const unsubSelPoi = sharedSim.on(SIM_EVENTS.POI_UPDATED, syncSnapshotNow);
    const unsubPause = sharedSim.on(SIM_EVENTS.SIMULATION_PAUSED, syncSnapshotNow);
    const unsubTime = sharedSim.on(SIM_EVENTS.SIMULATION_TIME_CHANGED, syncSnapshotNow);
    const unsubDown = sharedSim.on(SIM_EVENTS.DRONE_DOWN, syncSnapshotNow);
    return () => {
      unsubSync();
      unsubSelDrone();
      unsubSelPoi();
      unsubPause();
      unsubTime();
      unsubDown();
    };
  }, [syncSnapshotNow]);

  const handleStatsUpdate = useCallback(next => {
    setHudStats(prev => (prev.status === next.status && prev.waiting === next.waiting && prev.slide === next.slide ? prev : next));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let engine = null;
    try {
      engine = createDisasterEngine(canvas, {
        onStatsUpdate: handleStatsUpdate,
        onEarthquakeUpdate: handleEarthquakeUpdate,
      });
      engineRef.current = engine;
      setIsLoading(false);
    } catch (err) {
      setWebglError(err?.message || 'WebGL is unavailable in this browser. Please enable hardware acceleration.');
      setIsLoading(false);
    }

    return () => {
      if (engine) {
        engine.dispose();
        engineRef.current = null;
      }
    };
  }, [handleStatsUpdate, handleEarthquakeUpdate]);

  const handleViewDimension = useCallback(dim => {
    setViewMode(dim);
    engineRef.current?.setViewMode(dim);
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'SET_2D_ACTIVE', active: dim === '2d' }, '*');
    }
    syncSnapshotNow();
  }, [syncSnapshotNow]);

  useEffect(() => {
    const onMessage = e => {
      if (e.data && e.data.type === 'SWITCH_VIEW_DIMENSION' && (e.data.dim === '3d' || e.data.dim === '2d')) {
        handleViewDimension(e.data.dim);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [handleViewDimension]);

  const selectMode = useCallback(idx => {
    setModeIndex(idx);
    if (engineRef.current) {
      engineRef.current.setMode(idx);
    }
    if (dockRef.current && dockRef.current.children[idx]) {
      dockRef.current.children[idx].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, []);

  useEffect(() => {
    const onKeyDown = e => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= MODES_META.length) {
        selectMode(n - 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectMode]);

  const handleIntensityChange = e => {
    const val = parseFloat(e.target.value);
    setIntensity(val);
    engineRef.current?.setIntensity(val);
  };

  const handleTogglePeople = () => {
    setShowPeople(prev => {
      const next = !prev;
      engineRef.current?.setShowPeople(next);
      return next;
    });
  };

  const handleToggleRotate = () => {
    setAutoRotate(prev => {
      const next = !prev;
      engineRef.current?.setAutoRotate(next);
      return next;
    });
  };

  const handleTogglePause = () => {
    const next = !paused;
    setPaused(next);
    engineRef.current?.setPaused(next);
    sharedSim.setPaused(next, '3d');
  };

  const handleSpeedChange = scale => {
    setTimeScale(scale);
    setPaused(false);
    engineRef.current?.setPaused(false);
    sharedSim.setPaused(false, '3d');
    sharedSim.setTimeScale(scale, '3d');
  };

  const handleResetView = () => {
    engineRef.current?.resetView();
  };

  const handleSlide = action => {
    const slide = engineRef.current?.landslide(action);
    if (slide) setHudStats(prev => ({ ...prev, slide }));
  };

  const handleSelectDrone = id => {
    sharedSim.selectDrone(id, '3d');
    const d = sharedSim.state.drones.find(u => u.id === id);
    if (d && engineRef.current?.focusPosition) {
      engineRef.current.focusPosition(d.position.x, d.position.y, d.position.z);
    }
  };

  const handleSelectPoi = id => {
    sharedSim.selectPoi(id, '3d');
    const p = sharedSim.state.pois.find(x => x.id === id);
    if (p && engineRef.current?.focusPosition) {
      engineRef.current.focusPosition(p.position.x, p.position.y, p.position.z);
    }
  };

  const handleKillSelectedDrone = () => {
    if (simSnapshot.selectedDroneId) {
      sharedSim.killDrone(simSnapshot.selectedDroneId, '3d');
      syncSnapshotNow();
    }
  };

  const activeDrones = simSnapshot.drones.filter(d => d.mode !== 'dead');
  const availableDronePool = activeDrones.length > 0 ? activeDrones : simSnapshot.drones;
  const availableDronesCount = availableDronePool.length;

  const handleCycleDrone = (direction = 1) => {
    if (availableDronesCount <= 0) return;
    const currIdx = availableDronePool.findIndex(d => d.id === simSnapshot.selectedDroneId);
    let nextIdx = 0;
    if (currIdx !== -1) {
      nextIdx = (currIdx + direction + availableDronesCount) % availableDronesCount;
    }
    const targetDrone = availableDronePool[nextIdx];
    if (targetDrone) {
      handleSelectDrone(targetDrone.id);
    }
  };

  const currentMode = MODES_META[modeIndex] || MODES_META[0];
  const is3D = viewMode === '3d';

  const selectedDrone = simSnapshot.selectedDroneId
    ? simSnapshot.drones.find(d => d.id === simSnapshot.selectedDroneId) || null
    : null;
  const selectedPoi = simSnapshot.selectedPoiId
    ? simSnapshot.pois.find(p => p.id === simSnapshot.selectedPoiId) || null
    : null;

  const surveyedPoisCount = simSnapshot.pois.filter(p => p.status === 'SURVEYED' || p.status === 'ACKNOWLEDGED').length;
  const detectedSurvivorsCount = simSnapshot.survivors.filter(s => s.detected).length;

  return (
    <>
      {(isLoading || webglError) && (
        <div
          className="loading"
          id="loading"
          style={webglError ? { color: '#ff3b30' } : undefined}
          role={webglError ? 'alert' : 'status'}
        >
          {webglError || 'Building terrain…'}
        </div>
      )}

      <canvas
        id="c"
        ref={canvasRef}
        hidden={!is3D}
        aria-label="3D disaster terrain scene"
      />

      <div
        className="view-2d"
        id="view2d"
        hidden={is3D}
        aria-label="2D disaster terrain scene"
      >
        <iframe
          id="model2dFrame"
          ref={iframeRef}
          className="view-2d-frame"
          src="/model2d/index.html"
          title="2D Drone Swarm Relay Simulator"
          onLoad={() => {
            if (iframeRef.current?.contentWindow) {
              iframeRef.current.contentWindow.postMessage({ type: 'SET_2D_ACTIVE', active: !is3D }, '*');
            }
          }}
        />
      </div>

      <header className={`top${is3D ? '' : ' mode-2d'}`}>
        <section
          className={`card info${infoOpen ? '' : ' collapsed'}`}
          id="info"
          hidden={!is3D}
          aria-live="polite"
        >
          <div className="card-head">
            <span className="mode-icon" id="mIcon" aria-hidden="true">
              {currentMode.icon}
            </span>
            <div>
              <h1 id="mName">{currentMode.name}</h1>
              <p className="status" id="mStatus">
                {hudStats.status}
              </p>
            </div>
            <button
              className="ghost"
              id="toggleInfo"
              type="button"
              aria-expanded={infoOpen}
              aria-controls="infoBody"
              onClick={() => setInfoOpen(open => !open)}
            >
              {infoOpen ? 'Less' : 'More'}
            </button>
          </div>
          <div className="card-body" id="infoBody">
            <p id="mDesc">{currentMode.desc}</p>
            <p className="tip">
              <strong>If this happens:</strong> <span id="mTip">{currentMode.tip}</span>
            </p>
            <ul className="legend">
              <li>
                <i className="sw vic" />
                Survivor beacon (Red: Waiting · Amber: Assigned · Green: Surveyed)
              </li>
              <li>
                <i className="sw safe" />
                Mission UAV
              </li>
              <li>
                <i className="sw team" />
                Relay UAV
              </li>
            </ul>
            <p className="count">
              Unconscious survivors on the map: <b id="waiting">{hudStats.waiting}</b>
              {' · '}Detected by Swarm: <b id="detectedCount">{detectedSurvivorsCount}/{simSnapshot.survivors.length || hudStats.waiting}</b>
            </p>

            {/* Live Coordinated Swarm C2 Telemetry inside 3D HUD */}
            <div className="swarm-sync-box" id="swarmSyncBox">
              <div className="swarm-sync-head">
                <span className="sync-title">SWARM C2 TELEMETRY (LIVE 2D↔3D)</span>
                <span className={`sync-pill ${simSnapshot.network.connected ? 'ok' : simSnapshot.network.fleetConnected ? 'warn' : 'lost'}`}>
                  {simSnapshot.network.connected
                    ? `LINKED · ${simSnapshot.network.links?.length || 0} HOPS`
                    : simSnapshot.network.fleetConnected
                      ? 'EN ROUTE'
                      : 'RECONNECTING'}
                </span>
              </div>
              <div className="swarm-kpi-grid">
                <div><span>UAVs Alive</span><b>{simSnapshot.network.aliveCount}/{simSnapshot.drones.length}</b></div>
                <div><span>Relays / Mission</span><b>{simSnapshot.network.relayCount} / {simSnapshot.network.missionCount}</b></div>
                <div><span>PoIs Surveyed</span><b>{surveyedPoisCount}/{simSnapshot.pois.length}</b></div>
                <div><span>Packets</span><b>{(simSnapshot.network.deliveredPackets || 0).toLocaleString()}</b></div>
              </div>

              <div className="swarm-mini-label">Click Drone or Survivor/PoI (or click in 3D scene):</div>
              <div className="swarm-pill-list" id="dronePillList">
                {simSnapshot.drones.map(d => (
                  <button
                    key={d.id}
                    type="button"
                    className={`mini-pill role-${d.role}${simSnapshot.selectedDroneId === d.id ? ' selected' : ''}`}
                    onClick={() => handleSelectDrone(d.id)}
                    title={`${d.id} (${d.role}) · ${Math.round(d.battery)}%`}
                  >
                    {d.id}
                  </button>
                ))}
              </div>
              <div className="swarm-pill-list" id="poiPillList">
                {simSnapshot.pois.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    className={`mini-pill poi-${p.status}${simSnapshot.selectedPoiId === p.id ? ' selected' : ''}`}
                    onClick={() => handleSelectPoi(p.id)}
                    title={`${p.id}: ${p.status} (${Math.round(p.progress)}%)`}
                  >
                    {p.id}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div className="right-stack">
          <section className="card controls" aria-label="Scene controls">
            <div className="view-toggle" role="group" aria-label="Switch between 2D and 3D model">
              <button
                className="chip"
                type="button"
                id="bView3D"
                aria-pressed={is3D}
                onClick={() => handleViewDimension('3d')}
              >
                3D Disaster
              </button>
              <button
                className="chip"
                type="button"
                id="bView2D"
                aria-pressed={!is3D}
                onClick={() => handleViewDimension('2d')}
              >
                2D Tactical
              </button>
              <span className="clock-badge" id="sharedSimClock" title="Shared Mission Clock">
                {fmtClock(simSnapshot.elapsedTime)}
              </span>
            </div>
            {is3D && (
              <>
                <div className="speed-bar" role="group" aria-label="Simulation speed">
                  <span className="speed-lbl">Speed</span>
                  {[1, 5, 30, 120].map(sp => (
                    <button
                      key={sp}
                      type="button"
                      className="chip speed-chip"
                      id={`bSpeed${sp}`}
                      aria-pressed={!paused && timeScale === sp}
                      onClick={() => handleSpeedChange(sp)}
                    >
                      {sp}×
                    </button>
                  ))}
                </div>
                {currentMode.id === 'earthquake' && (
                  <div className="quake-controls-panel" id="quakeControlsPanel">
                    <div className="quake-header-row">
                      <button
                        className={`chip quake-trigger-btn ${earthquakeState.active ? 'quake-active' : ''}`}
                        type="button"
                        id="bTriggerEarthquake"
                        disabled={earthquakeState.active}
                        onClick={handleTriggerEarthquake}
                        title={earthquakeState.active ? `Earthquake active (${Math.max(0, earthquakeState.duration - earthquakeState.elapsed).toFixed(1)}s left)` : `Trigger 10s M${earthquakeState.magnitude.toFixed(1)} Earthquake`}
                      >
                        <span className="quake-pulse-dot" aria-hidden="true" />
                        {earthquakeState.active
                          ? `Shaking: ${Math.max(0, earthquakeState.duration - earthquakeState.elapsed).toFixed(1)}s left`
                          : 'Start Earthquake (10s)'}
                      </button>
                      <button
                        className="chip quake-reset-btn"
                        type="button"
                        id="bResetEarthquake"
                        disabled={earthquakeState.active}
                        onClick={handleResetEarthquakeBuildings}
                        title="Reset city buildings and rubble to pristine condition"
                      >
                        Reset City
                      </button>
                      <span className="pga-badge" title="Peak Ground Acceleration">
                        PGA: ~{earthquakeState.pga.toFixed(2)}g
                      </span>
                    </div>

                    <label className="range quake-magnitude-range">
                      <span>
                        Magnitude: <b>M {earthquakeState.magnitude.toFixed(1)}</b> <small>({getRichterCategory(earthquakeState.magnitude)})</small>
                      </span>
                      <input
                        type="range"
                        id="earthquakeMagnitude"
                        min="1.0"
                        max="9.0"
                        step="0.1"
                        value={earthquakeState.magnitude}
                        disabled={earthquakeState.active}
                        onChange={handleEarthquakeMagnitudeChange}
                      />
                    </label>

                    {(() => {
                      const tierInfo = getDamageTierLabel(earthquakeState.magnitude);
                      return (
                        <div className={`quake-tier-badge ${tierInfo.className}`} title={tierInfo.desc}>
                          <span className="tier-tag">{tierInfo.tier}</span>
                          <span className="tier-desc">{tierInfo.desc}</span>
                        </div>
                      );
                    })()}

                    {earthquakeState.active && (
                      <div className="quake-progress-track" role="progressbar" aria-valuenow={earthquakeState.elapsed} aria-valuemin={0} aria-valuemax={earthquakeState.duration}>
                        <div
                          className="quake-progress-fill"
                          style={{ width: `${Math.min(100, (earthquakeState.elapsed / earthquakeState.duration) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
                <label className="range">
                  <span>Intensity ({intensity.toFixed(2)}×)</span>
                  <input
                    type="range"
                    id="intensity"
                    min="0.3"
                    max="1.8"
                    step="0.05"
                    value={intensity}
                    onChange={handleIntensityChange}
                  />
                </label>
                <div className="btns">
                  <button
                    className="chip"
                    type="button"
                    id="bPeople"
                    aria-pressed={showPeople}
                    onClick={handleTogglePeople}
                  >
                    People
                  </button>
                  <button
                    className="chip"
                    type="button"
                    id="bRotate"
                    aria-pressed={autoRotate}
                    onClick={handleToggleRotate}
                  >
                    Auto-rotate
                  </button>
                  <button
                    className="chip"
                    type="button"
                    id="bPause"
                    aria-pressed={paused}
                    onClick={handleTogglePause}
                  >
                    {paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    className="chip"
                    type="button"
                    id="bReset"
                    onClick={handleResetView}
                  >
                    Reset view
                  </button>
                </div>
                {currentMode.id === 'landslide' && (
                  <div className="hazard-card">
                    <button
                      className="hazard-btn"
                      type="button"
                      id="bSlide"
                      aria-pressed={hudStats.slide === 'running'}
                      onClick={() => handleSlide(hudStats.slide === 'running' ? 'stop' : 'start')}
                    >
                      <span className="hazard-dot" aria-hidden="true" />
                      {hudStats.slide === 'running' ? 'Stop Landslide' : 'Start Landslide'}
                    </button>
                  </div>
                )}
                <div className="btns c2-actions">
                  <button
                    className="chip action-chip"
                    type="button"
                    id="btnAddPoi3D"
                    onClick={() => sharedSim.addCriticalPoi({}, '3d')}
                  >
                    + Critical PoI
                  </button>
                  <button
                    className="chip action-chip"
                    type="button"
                    id="btnAddJammer3D"
                    onClick={() => sharedSim.addJammer({}, '3d')}
                  >
                    + RF Jammer ({simSnapshot.hazards.jammerCount || 0})
                  </button>
                  <button
                    className="chip action-chip"
                    type="button"
                    id="btnAddGps3D"
                    onClick={() => sharedSim.addGpsZone({}, '3d')}
                  >
                    + GPS Denied ({simSnapshot.hazards.gpsZoneCount || 0})
                  </button>
                </div>
              </>
            )}
          </section>

          {/* Selected Drone / PoI Inspector Card in 3D */}
          {is3D && (selectedDrone || selectedPoi) && (
            <section className="card inspector-card" id="inspectorCard" aria-live="polite">
              {selectedDrone && (
                <div className="inspector-block" id="droneInspector">
                  <div className="inspector-head">
                    <button
                      type="button"
                      className="mini-nav-btn"
                      title="Previous UAV"
                      disabled={availableDronesCount <= 1}
                      onClick={() => handleCycleDrone(-1)}
                      aria-label="Previous UAV"
                    >
                      ‹
                    </button>
                    <strong>UAV {selectedDrone.id}</strong>
                    <button
                      type="button"
                      className="mini-nav-btn"
                      title="Next UAV"
                      disabled={availableDronesCount <= 1}
                      onClick={() => handleCycleDrone(1)}
                      aria-label="Next UAV"
                    >
                      ›
                    </button>
                    <span className={`role-badge role-${selectedDrone.role}`}>{selectedDrone.role.toUpperCase()}</span>
                    <button
                      type="button"
                      className="ghost mini-close"
                      onClick={() => sharedSim.selectDrone(null, '3d')}
                      title="Close"
                      aria-label="Close"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="inspector-grid">
                    <div><span>Battery:</span> <b>{selectedDrone.battery}%</b></div>
                    <div><span>Health:</span> <b>{selectedDrone.health}%</b></div>
                    <div><span>Comms:</span> <b>{selectedDrone.communicationStatus}</b></div>
                    <div><span>GPS:</span> <b style={{ color: selectedDrone.gpsDenied ? '#f43f5e' : '#4ade80' }}>{selectedDrone.gpsStatus}</b></div>
                    <div><span>Assigned PoI:</span> <b>{selectedDrone.targetPoi || 'None'}</b></div>
                    <div><span>Speed:</span> <b>{selectedDrone.velocity.speed} m/s</b></div>
                    <div><span>3D Pos:</span> <b>({selectedDrone.position.x}, {selectedDrone.position.y}, {selectedDrone.position.z})</b></div>
                    <div><span>2D Pos:</span> <b>({selectedDrone.position2D.x}m, {selectedDrone.position2D.y}m)</b></div>
                  </div>
                  <div className="btns" style={{ marginTop: '6px' }}>
                    <button
                      type="button"
                      className="chip"
                      onClick={() => engineRef.current?.focusPosition(selectedDrone.position.x, selectedDrone.position.y, selectedDrone.position.z)}
                    >
                      Focus Camera
                    </button>
                    <button
                      type="button"
                      className="chip"
                      id="btnNextDrone3D"
                      disabled={availableDronesCount <= 1}
                      onClick={() => handleCycleDrone(1)}
                      title={availableDronesCount <= 1 ? 'Only 1 UAV available' : 'Cycle to next active UAV'}
                    >
                      Next UAV →
                    </button>
                    <button
                      type="button"
                      className="chip danger-chip"
                      id="btnKillDrone3D"
                      disabled={selectedDrone.mode === 'dead'}
                      onClick={handleKillSelectedDrone}
                    >
                      {selectedDrone.mode === 'dead' ? `${selectedDrone.id} Down` : `Kill ${selectedDrone.id}`}
                    </button>
                  </div>
                </div>
              )}

              {selectedPoi && (
                <div className="inspector-block" id="poiInspector" style={selectedDrone ? { marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.12)' } : undefined}>
                  <div className="inspector-head">
                    <strong>{selectedPoi.type === 'survivor' ? `Survivor ${selectedPoi.id}` : `PoI ${selectedPoi.id}`}</strong>
                    <span className="role-badge">{selectedPoi.status}</span>
                    <button
                      type="button"
                      className="ghost mini-close"
                      onClick={() => sharedSim.selectPoi(null, '3d')}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="inspector-grid">
                    <div><span>Priority:</span> <b>{selectedPoi.priority}</b></div>
                    <div><span>Progress:</span> <b>{Math.round(selectedPoi.progress)}%</b></div>
                    <div><span>Assigned UAV:</span> <b>{selectedPoi.assignedDrone || 'Unassigned'}</b></div>
                    <div><span>3D Pos:</span> <b>({selectedPoi.position.x}, {selectedPoi.position.z})</b></div>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </header>

      <nav className="dock" hidden={!is3D} aria-label="Disaster type">
        <div className="dock-inner" id="dock" ref={dockRef}>
          {MODES_META.map((m, i) => (
            <button
              key={m.id}
              className="mode-btn"
              type="button"
              aria-current={i === modeIndex ? 'true' : 'false'}
              onClick={() => selectMode(i)}
            >
              <span className="ic" aria-hidden="true">
                {m.icon}
              </span>
              <span>{m.name}</span>
            </button>
          ))}
        </div>
      </nav>

      <p className="hint" hidden={!is3D}>
        Drag to look/orbit · WASD / Arrows to fly 3D · Space / Shift for altitude · Scroll / +/- to zoom · Press 1–7 for disasters
      </p>
    </>
  );
}

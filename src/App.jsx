import { useEffect, useRef, useState, useCallback } from 'react';
import { createDisasterEngine, MODES_META } from './simulation/disasterEngine.js';
import sharedSim from './integration/simulationStore.js';
import { SIM_EVENTS } from './integration/simulationEvents.js';
import backendBridge from './integration/backendBridge.js';
import { FLEET_CONFIG } from './simulation/fleetManager.js';
import { VerificationSuite } from './simulation/verificationSuite.js';

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
  const [autoRotate, setAutoRotate] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [paused, setPaused] = useState(false);
  const [timeScale, setTimeScale] = useState(5);
  const [infoOpen, setInfoOpen] = useState(() => window.innerWidth >= 640);
  const [hudStats, setHudStats] = useState({
    status: 'M7.0 event complete - Partial collapse: Upper-story shearing & tilt',
    waiting: 0,
  });

  // UAV-X Swarm Autonomy 3D Visual Layer Toggles
  const [apfVisible, setApfVisible] = useState(true);
  const [fanetVisible, setFanetVisible] = useState(true);
  const [octomapVisible, setOctomapVisible] = useState(true);
  const [aiVisible, setAiVisible] = useState(true);
  const [thermalView, setThermalView] = useState(false);
  const [gasView, setGasView] = useState(false);
  const [noNetworkZoneActive, setNoNetworkZoneActive] = useState(false);
  const [noNetworkRadius, setNoNetworkRadius] = useState(35);
  const [debugOverlayVisible, setDebugOverlayVisible] = useState(false);
  const [testResults, setTestResults] = useState(null);
  const [testRunning, setTestRunning] = useState(false);
  const [activeSubsystemTab, setActiveSubsystemTab] = useState('fleet'); // 'fleet', 'fanet', 'ai', 'octomap'

  // Initialize Backend WebSocket Bridge on port 8080
  useEffect(() => {
    backendBridge.init(8080);
    return () => backendBridge.dispose();
  }, []);

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

  // Snapshot of SharedSimulationState for React HUD (synchronized from backend at 30 Hz)
  const [simSnapshot, setSimSnapshot] = useState(() => ({
    elapsedTime: 0,
    coveragePercent: 0,
    totalSurvivors: 0,
    detectedSurvivors: 0,
    drones: [],
    pois: [],
    survivors: [],
    network: sharedSim.state.network,
    hazards: sharedSim.state.hazards,
    backend: sharedSim.state.backend,
    octomap: sharedSim.state.octomap,
    aiVision: sharedSim.state.aiVision,
    taggedHazards: sharedSim.state.hazards.taggedHazards || [],
    selectedDroneId: null,
    selectedPoiId: null,
  }));

  const syncSnapshotNow = useCallback(() => {
    const st = sharedSim.state;
    setPaused(st.mission.paused);
    setTimeScale(st.mission.timeScale);
    setSimSnapshot({
      elapsedTime: st.mission.elapsedTime,
      coveragePercent: st.mission.coveragePercent || 0,
      totalSurvivors: st.mission.totalSurvivors || 0,
      detectedSurvivors: st.mission.detectedSurvivors || 0,
      drones: st.drones.slice(),
      pois: st.pois.slice(),
      survivors: st.survivors.slice(),
      network: { ...st.network },
      hazards: {
        jammerCount: st.hazards.jammerZones.filter(j => j.on).length,
        gpsZoneCount: st.hazards.gpsDeniedZones.filter(z => z.on).length,
      },
      backend: { ...st.backend },
      octomap: { ...st.octomap },
      aiVision: { ...st.aiVision },
      taggedHazards: (st.hazards.taggedHazards || []).slice(),
      selectedDroneId: st.selection.selectedDroneId,
      selectedPoiId: st.selection.selectedPoiId,
    });
  }, []);

  // 3D Visual Layer Toggles
  const handleToggleApf = useCallback(() => {
    setApfVisible(prev => {
      const next = !prev;
      engineRef.current?.setApfBubblesVisible(next);
      return next;
    });
  }, []);

  const handleToggleFanet = useCallback(() => {
    setFanetVisible(prev => {
      const next = !prev;
      engineRef.current?.setFanetLinksVisible(next);
      return next;
    });
  }, []);

  const handleToggleOctomap = useCallback(() => {
    setOctomapVisible(prev => {
      const next = !prev;
      engineRef.current?.setOctomapVisible(next);
      return next;
    });
  }, []);

  const handleToggleAi = useCallback(() => {
    setAiVisible(prev => {
      const next = !prev;
      engineRef.current?.setAiDetectionsVisible(next);
      return next;
    });
  }, []);

  // Swarm Command Handlers
  const handleSwarmTakeoff = useCallback(() => {
    backendBridge.sendCommand('TAKEOFF_ALL');
  }, []);

  const handleSwarmSurvey = useCallback(() => {
    backendBridge.sendCommand('SURVEY_ALL');
  }, []);

  const handleSwarmRtl = useCallback(() => {
    backendBridge.sendCommand('RTL_ALL');
  }, []);

  const handleReconnectBackend = useCallback(() => {
    backendBridge.connect();
  }, []);

  useEffect(() => {
    let lastSyncMs = 0;
    const onStateSynced = () => {
      const now = performance.now();
      if (now - lastSyncMs < 60) return; // ~16 Hz React UI updates
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
    setHudStats(prev => (prev.status === next.status && prev.waiting === next.waiting ? prev : next));
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

  const handleToggleThermal = () => {
    setThermalView(prev => {
      const next = !prev;
      engineRef.current?.setThermalView(next);
      return next;
    });
  };

  const handleToggleGas = () => {
    setGasView(prev => {
      const next = !prev;
      engineRef.current?.setGasView(next);
      return next;
    });
  };

  const handleToggleNoNetworkZone = () => {
    setNoNetworkZoneActive(prev => {
      const next = !prev;
      sharedSim.toggleNoNetworkZone(next, 20, 10, noNetworkRadius, 'ui');
      return next;
    });
  };

  const handleNoNetworkRadiusChange = (e) => {
    const r = parseFloat(e.target.value);
    setNoNetworkRadius(r);
    if (noNetworkZoneActive) {
      sharedSim.toggleNoNetworkZone(true, 20, 10, r, 'ui');
    }
  };

  const handleResetSimulation = () => {
    engineRef.current?.resetSimulation();
  };

  const handleReviveDrone = (droneId = 4) => {
    sharedSim.reviveDrone(droneId, 'ui');
  };

  const handleRunVerification = useCallback(async () => {
    if (!engineRef.current || testRunning) return;
    setTestRunning(true);
    const suite = new VerificationSuite(engineRef.current, sharedSim);
    const report = await suite.runFullSuite();
    setTestResults(report);
    setTestRunning(false);
    setDebugOverlayVisible(true);
  }, [testRunning]);

  // Global keybindings for Debug Overlay (D or ~)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'd' || e.key === 'D' || e.key === '`' || e.key === '~') {
        setDebugOverlayVisible(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
            <div className="hud-metrics-grid">
              <div className="hud-metric-card">
                <span className="hud-metric-label">Fleet Integrity (N={FLEET_CONFIG.DRONE_COUNT})</span>
                <span className={`hud-metric-val ${simSnapshot.drones.filter(d => !d.killed).length === FLEET_CONFIG.DRONE_COUNT ? 'ok' : 'warn'}`}>
                  {simSnapshot.drones.filter(d => !d.killed).length} / {FLEET_CONFIG.DRONE_COUNT} Active
                  {simSnapshot.drones.length !== FLEET_CONFIG.DRONE_COUNT && (
                    <span className="fleet-warn-badge">⚠️ N-MISMATCH</span>
                  )}
                  {simSnapshot.drones.some(d => d.killed) && (
                    <span className="fleet-warn-badge">DR-DOWN</span>
                  )}
                </span>
              </div>
              <div className="hud-metric-card">
                <span className="hud-metric-label">Area Coverage</span>
                <span className="hud-metric-val ok">
                  {Math.round(simSnapshot.coveragePercent || 0)}%
                  <span style={{ fontSize: '10px', color: '#94a3b8', marginLeft: '4px' }}>
                    ({simSnapshot.detectedSurvivors || detectedSurvivorsCount}/{simSnapshot.totalSurvivors || simSnapshot.survivors.length || hudStats.waiting} Found)
                  </span>
                </span>
              </div>
              <div className="hud-metric-card">
                <span className="hud-metric-label">Mesh to Control Centre</span>
                <span className={`hud-metric-val ${simSnapshot.network?.allDronesLinked ? 'ok' : 'danger'}`}>
                  {simSnapshot.network?.allDronesLinked ? 'YES (100% Linked)' : 'NO (Unlinked UAVs)'}
                </span>
              </div>
              <div className="hud-metric-card">
                <span className="hud-metric-label">Mesh Topology</span>
                <span className="hud-metric-val">
                  CC: {simSnapshot.network?.connectedComponents ?? 1} · Max Hops: {simSnapshot.network?.maxHops ?? 0} · Relays: {simSnapshot.network?.relayCount ?? 0}
                </span>
              </div>
            </div>

            {/* UAV-X Autonomous Swarm & FANET Cockpit inside 3D HUD */}
            <div className="swarm-subsystems-panel" id="swarmCockpit">
              <div className="swarm-sync-head">
                <span className="sync-title">UAV-X SWARM AUTONOMY & FANET COCKPIT</span>
                <span className={`sync-pill ${simSnapshot.backend?.connected ? 'ok' : simSnapshot.network.connected ? 'warn' : 'lost'}`}>
                  {simSnapshot.backend?.connected
                    ? `LIVE ${simSnapshot.backend.hz || 30} Hz · ${simSnapshot.network.links?.length || 0} LINKS`
                    : simSnapshot.network.connected
                      ? `LINKED · ${simSnapshot.network.links?.length || 0} HOPS`
                      : 'OFFLINE'}
                </span>
              </div>

              {/* Subsystem Navigation Tabs */}
              <div className="swarm-tabs-bar" role="tablist">
                <button
                  type="button"
                  className={`tab-btn ${activeSubsystemTab === 'fleet' ? 'active' : ''}`}
                  onClick={() => setActiveSubsystemTab('fleet')}
                >
                  🛸 Fleet Kinematics
                </button>
                <button
                  type="button"
                  className={`tab-btn ${activeSubsystemTab === 'fanet' ? 'active' : ''}`}
                  onClick={() => setActiveSubsystemTab('fanet')}
                >
                  📡 FANET Mesh
                </button>
                <button
                  type="button"
                  className={`tab-btn ${activeSubsystemTab === 'ai' ? 'active' : ''}`}
                  onClick={() => setActiveSubsystemTab('ai')}
                >
                  🧠 AI & FLIR
                </button>
                <button
                  type="button"
                  className={`tab-btn ${activeSubsystemTab === 'octomap' ? 'active' : ''}`}
                  onClick={() => setActiveSubsystemTab('octomap')}
                >
                  🗺️ OctoMap 3D
                </button>
              </div>

              {/* Tab 1: Fleet Kinematics */}
              {activeSubsystemTab === 'fleet' && (
                <div className="tab-content">
                  <div className="fleet-table-wrap">
                    <table className="fleet-table">
                      <thead>
                        <tr>
                          <th>UAV</th>
                          <th>FSM State</th>
                          <th>Flight Tier</th>
                          <th>Alt</th>
                          <th>Vel</th>
                          <th>Battery</th>
                          <th>Route</th>
                          <th>EKF σ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {simSnapshot.drones.map(d => {
                          const isLowBat = (d.battery || 100) <= 20;
                          return (
                            <tr
                              key={d.id}
                              style={{ cursor: 'pointer', background: simSnapshot.selectedDroneId === d.id ? 'rgba(56,189,248,0.18)' : undefined }}
                              onClick={() => handleSelectDrone(d.id)}
                            >
                              <td><b>UAV_{d.id}</b></td>
                              <td><span className={`fsm-tag fsm-${d.fsm || 'SURV'}`}>{d.fsm || 'SURV'}</span></td>
                              <td><span className={`tier-tag-pill tier-${d.tier || 'TIER_2'}`}>{d.tier || 'TIER_2'}</span></td>
                              <td>{Math.round(d.position?.y || 15)}m</td>
                              <td>{d.velocity?.speed || 0}m/s</td>
                              <td>
                                <div className="bat-bar-wrap">
                                  <div className="bat-track">
                                    <div
                                      className="bat-fill"
                                      style={{
                                        width: `${d.battery || 100}%`,
                                        background: isLowBat ? '#ef4444' : d.battery < 50 ? '#f59e0b' : '#22c55e',
                                      }}
                                    />
                                  </div>
                                  <span style={{ color: isLowBat ? '#f87171' : undefined }}>{Math.round(d.battery || 100)}%</span>
                                </div>
                              </td>
                              <td style={{ color: '#38bdf8' }}>{d.route || `${d.id}->0`}</td>
                              <td>±{(d.uncertainty || 0.05).toFixed(2)}m</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="btns c2-actions" style={{ marginTop: '6px' }}>
                    <button type="button" className="chip action-chip" onClick={handleSwarmTakeoff}>
                      🚀 Swarm Takeoff
                    </button>
                    <button type="button" className="chip action-chip" onClick={handleSwarmSurvey}>
                      🗺️ Auto Survey (CBBA)
                    </button>
                    <button type="button" className="chip action-chip" onClick={handleSwarmRtl}>
                      🏠 Swarm RTL
                    </button>
                  </div>
                </div>
              )}

              {/* Tab 2: Resilient FANET Mesh & Dijkstra Routing */}
              {activeSubsystemTab === 'fanet' && (
                <div className="tab-content">
                  <div className="swarm-kpi-grid">
                    <div><span>PDR (Delivery)</span><b>{simSnapshot.network.pdr || 100}%</b></div>
                    <div><span>Hop Latency</span><b>{simSnapshot.network.latency || 12} ms</b></div>
                    <div><span>Active Links</span><b>{simSnapshot.network.links?.length || 0} Channels</b></div>
                    <div><span>DTN Ring Buffer</span><b>{simSnapshot.network.bufferedPackets || 0} Pkts</b></div>
                  </div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', margin: '4px 0 2px' }}>
                    Dual-Band Radio: <b style={{ color: '#00f0ff' }}>2.4 GHz Video</b> + <b style={{ color: '#f59e0b' }}>915 MHz LoRa Fallback</b>
                  </div>
                  <div className="fleet-table-wrap">
                    <table className="fleet-table">
                      <thead>
                        <tr>
                          <th>Link</th>
                          <th>Band</th>
                          <th>SNR</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(simSnapshot.network.links || []).map((lk, idx) => (
                          <tr key={idx}>
                            <td>{lk.fromId === 0 ? 'GCS' : `UAV_${lk.fromId}`} ↔ {lk.toId === 0 ? 'GCS' : `UAV_${lk.toId}`}</td>
                            <td style={{ color: lk.band === 'LORA' ? '#f59e0b' : '#00f0ff' }}>{lk.band || '2.4G'}</td>
                            <td>{lk.snr || 20} dB</td>
                            <td><span style={{ color: lk.state === 'ok' ? '#4ade80' : '#f59e0b' }}>{lk.state?.toUpperCase()}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Tab 3: AI Perception & FLIR Thermal Fusion */}
              {activeSubsystemTab === 'ai' && (
                <div className="tab-content" style={{ display: 'grid', gap: '6px' }}>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                    YOLOv8 Survivors & FLIR Thermal Fusion (31°C–38.5°C):
                  </div>
                  {(simSnapshot.survivors || []).filter(s => s.detected).length === 0 ? (
                    <div style={{ fontSize: '11.5px', color: 'var(--muted)', fontStyle: 'italic', padding: '4px' }}>
                      Surveying rubble field... AI model searching for heat signatures.
                    </div>
                  ) : (
                    (simSnapshot.survivors || []).filter(s => s.detected).slice(0, 4).map((s, idx) => (
                      <div key={idx} className="flir-survivor-item">
                        <div>
                          <strong>{s.id}</strong> · Conf: {Math.round((s.confidence || 0.9) * 100)}%
                        </div>
                        <span className="flir-badge-pill">
                          {s.lifeVerified ? `❤ VITAL ${s.temperature || 36.8}°C` : 'SURVEYING'}
                        </span>
                      </div>
                    ))
                  )}

                  {simSnapshot.taggedHazards && simSnapshot.taggedHazards.length > 0 && (
                    <>
                      <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                        OpenCV Tagged Hazards:
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {simSnapshot.taggedHazards.map((h, i) => (
                          <span key={i} className={`hazard-badge-pill hazard-${h.type}`}>
                            {h.type === 'FIRE' ? '🔥 ' : h.type === 'GAS' ? '☣ ' : '🚧 '}
                            {h.id}: {h.type} ({Math.round((h.confidence || 0.85) * 100)}%)
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Tab 4: OctoMap 3D Log-Odds Mapping & Spatial Entropy */}
              {activeSubsystemTab === 'octomap' && (
                <div className="tab-content">
                  <div className="entropy-box">
                    <div className="entropy-head">
                      <span>Shannon Spatial Entropy Reduction</span>
                      <b style={{ color: '#22c55e' }}>{simSnapshot.octomap?.entropyReduction || 0}%</b>
                    </div>
                    <div className="entropy-track" role="progressbar">
                      <div className="entropy-fill" style={{ width: `${Math.min(100, simSnapshot.octomap?.entropyReduction || 0)}%` }} />
                    </div>
                    <div className="swarm-kpi-grid" style={{ marginTop: '4px' }}>
                      <div><span>Mapped Volume</span><b>{simSnapshot.octomap?.mappedVolume || 0} m³</b></div>
                      <div><span>Occupied Voxels</span><b>{simSnapshot.octomap?.occupiedCount || 0}</b></div>
                      <div><span>Mean Entropy</span><b>{simSnapshot.octomap?.meanEntropy || 1.0} b/vox</b></div>
                      <div><span>LiDAR Beams</span><b>360° × 30°</b></div>
                    </div>
                  </div>
                </div>
              )}

              {/* Drone & PoI quick select pills */}
              <div className="swarm-mini-label" style={{ marginTop: '4px' }}>Select Drone / Target:</div>
              <div className="swarm-pill-list" id="dronePillList">
                {simSnapshot.drones.map(d => (
                  <button
                    key={d.id}
                    type="button"
                    className={`mini-pill role-${d.role}${simSnapshot.selectedDroneId === d.id ? ' selected' : ''}`}
                    onClick={() => handleSelectDrone(d.id)}
                    title={`${d.id} (${d.fsm || d.role}) · ${Math.round(d.battery)}%`}
                  >
                    UAV_{d.id}
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
              <button
                type="button"
                className={`backend-status-pill ${simSnapshot.backend?.connected ? 'online' : 'offline'}`}
                onClick={handleReconnectBackend}
                title={simSnapshot.backend?.connected ? `Backend Live: ${simSnapshot.backend?.hz || 30} Hz Telemetry | ws://localhost:8080` : 'Backend Disconnected: Click to retry ws://localhost:8080'}
              >
                <span className="live-pulse-dot" aria-hidden="true" />
                {simSnapshot.backend?.connected ? `LIVE ${simSnapshot.backend.hz || 30}Hz` : 'RECONNECT'}
              </button>
              <span className="sitl-badge" title="MAVLink v2.0 UDP SITL Bridge bound to port 14550">
                SITL :14550
              </span>
              <span className="clock-badge" id="sharedSimClock" title="Shared Mission Clock">
                {fmtClock(simSnapshot.elapsedTime)}
              </span>
            </div>
            {is3D && (
              <>
                {/* 3D Visual Layers Bar */}
                <div className="layer-toggle-bar" role="group" aria-label="3D Visual Layers">
                  <button
                    type="button"
                    className="chip layer-btn"
                    aria-pressed={apfVisible}
                    onClick={handleToggleApf}
                    title="Toggle Khatib APF Safety Clearance & Downwash Frustum Cones"
                  >
                    {apfVisible ? '✓ APF Safety' : '+ APF Safety'}
                  </button>
                  <button
                    type="button"
                    className="chip layer-btn"
                    aria-pressed={fanetVisible}
                    onClick={handleToggleFanet}
                    title="Toggle Dual-Band FANET Links & Dynamic Telemetry Packets"
                  >
                    {fanetVisible ? '✓ FANET Mesh' : '+ FANET Mesh'}
                  </button>
                  <button
                    type="button"
                    className="chip layer-btn"
                    aria-pressed={octomapVisible}
                    onClick={handleToggleOctomap}
                    title="Toggle OctoMap 3D Rubble Voxels Mapping"
                  >
                    {octomapVisible ? '✓ OctoMap 3D' : '+ OctoMap 3D'}
                  </button>
                  <button
                    type="button"
                    className="chip layer-btn"
                    aria-pressed={aiVisible}
                    onClick={handleToggleAi}
                    title="Toggle AI FLIR Thermal Life Signs & OpenCV Hazards"
                  >
                    {aiVisible ? '✓ AI Vision' : '+ AI Vision'}
                  </button>
                </div>

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
                    id="bResetSim"
                    title="Unified lifecycle reset: Re-create N drones and restart mission"
                    onClick={handleResetSimulation}
                  >
                    ↺ Reset Sim
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
                    className={`chip action-chip ${noNetworkZoneActive ? 'active' : ''}`}
                    type="button"
                    id="btnToggleNoNetwork"
                    onClick={handleToggleNoNetworkZone}
                  >
                    ⚡ No-Network Zone ({noNetworkZoneActive ? 'ON' : 'OFF'})
                  </button>
                  <button
                    className={`chip action-chip ${thermalView ? 'active' : ''}`}
                    type="button"
                    id="btnToggleThermal"
                    onClick={handleToggleThermal}
                  >
                    👁 Thermal
                  </button>
                  <button
                    className={`chip action-chip ${gasView ? 'active' : ''}`}
                    type="button"
                    id="btnToggleGas"
                    onClick={handleToggleGas}
                  >
                    💨 Gas Plume
                  </button>
                  <button
                    className="chip danger-chip"
                    type="button"
                    id="btnKillDR4"
                    onClick={() => simSnapshot.drones.find(d => d.id === 4)?.killed ? handleReviveDrone(4) : sharedSim.killDrone(4, 'ui')}
                  >
                    {simSnapshot.drones.find(d => d.id === 4)?.killed ? 'Revive DR4' : 'Kill DR4'}
                  </button>
                  <button
                    className={`chip action-chip ${debugOverlayVisible ? 'active' : ''}`}
                    type="button"
                    id="btnDebugOverlay"
                    onClick={() => setDebugOverlayVisible(prev => !prev)}
                  >
                    🛠 Debug [D]
                  </button>
                </div>
                {noNetworkZoneActive && (
                  <label className="range" style={{ marginTop: '6px' }}>
                    <span>No-Network Zone Radius ({noNetworkRadius}m)</span>
                    <input
                      type="range"
                      min="15"
                      max="60"
                      step="5"
                      value={noNetworkRadius}
                      onChange={handleNoNetworkRadiusChange}
                    />
                  </label>
                )}
              </>
            )}
          </section>

          {/* Selected Drone / PoI Inspector Card in 3D */}
          {is3D && (selectedDrone || selectedPoi) && (
            <section className="card inspector-card" id="inspectorCard" aria-live="polite">
              {selectedDrone && (
                <div className="inspector-block" id="droneInspector">
                  <div className="inspector-head">
                    <strong>UAV {selectedDrone.id}</strong>
                    <span className={`role-badge role-${selectedDrone.role}`}>{selectedDrone.role.toUpperCase()}</span>
                    <button
                      type="button"
                      className="ghost mini-close"
                      onClick={() => sharedSim.selectDrone(null, '3d')}
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
                      className="chip danger-chip"
                      id="btnKillDrone3D"
                      onClick={() => (selectedDrone.killed || selectedDrone.mode === 'dead') ? handleReviveDrone(selectedDrone.id) : handleKillSelectedDrone()}
                    >
                      {(selectedDrone.killed || selectedDrone.mode === 'dead') ? `Revive ${selectedDrone.id}` : `Kill ${selectedDrone.id}`}
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
        Drag to orbit · Scroll to zoom · Click any Drone or Survivor/PoI in 3D · Press 1–7 to switch disasters · Press [D] for Diagnostics
      </p>

      {/* SECTION I: Debug Overlay Modal & Automated Check Suite */}
      {debugOverlayVisible && (
        <aside className="debug-overlay" id="debugOverlay" role="dialog" aria-label="Simulation Diagnostics">
          <div className="debug-overlay-header">
            <span className="debug-overlay-title">🛠 UAV-X DIAGNOSTICS & VERIFICATION</span>
            <button
              type="button"
              className="debug-close-btn"
              onClick={() => setDebugOverlayVisible(false)}
            >
              ✕
            </button>
          </div>

          <div className="debug-grid">
            <div className="debug-item">
              <div className="debug-item-title">Fleet Integrity (A4)</div>
              <div className="debug-item-val" style={{ color: simSnapshot.drones.length === FLEET_CONFIG.DRONE_COUNT ? '#4ade80' : '#f87171' }}>
                {simSnapshot.drones.length} / {FLEET_CONFIG.DRONE_COUNT} ({simSnapshot.drones.filter(d => !d.killed).length} Alive)
              </div>
            </div>
            <div className="debug-item">
              <div className="debug-item-title">Mesh Connectivity (A3)</div>
              <div className="debug-item-val" style={{ color: simSnapshot.network?.allDronesLinked ? '#4ade80' : '#f87171' }}>
                {simSnapshot.network?.allDronesLinked ? '100% CC REACHABLE' : 'GRAPH PARTITIONED'}
              </div>
            </div>
            <div className="debug-item">
              <div className="debug-item-title">Mesh Components / Hops</div>
              <div className="debug-item-val">
                CC: {simSnapshot.network?.connectedComponents ?? 1} · Max Hops: {simSnapshot.network?.maxHops ?? 0}
              </div>
            </div>
            <div className="debug-item">
              <div className="debug-item-title">Active Relays</div>
              <div className="debug-item-val">
                {simSnapshot.network?.relayCount ?? 0} Relays Active
              </div>
            </div>
            <div className="debug-item">
              <div className="debug-item-title">Area Coverage (A5)</div>
              <div className="debug-item-val" style={{ color: '#38bdf8' }}>
                {Math.round(simSnapshot.coveragePercent || 0)}%
              </div>
            </div>
            <div className="debug-item">
              <div className="debug-item-title">Survivors Detected (B1/B3)</div>
              <div className="debug-item-val" style={{ color: '#4ade80' }}>
                {simSnapshot.detectedSurvivors || detectedSurvivorsCount} / {simSnapshot.totalSurvivors || simSnapshot.survivors.length}
              </div>
            </div>
          </div>

          <div style={{ margin: '8px 0' }}>
            <button
              type="button"
              className="chip action-chip"
              style={{ width: '100%', padding: '7px 10px', textAlign: 'center', background: '#0284c7', color: '#fff', fontWeight: 'bold' }}
              disabled={testRunning}
              onClick={handleRunVerification}
            >
              {testRunning ? '⏳ Running Suite Across All Scenarios...' : '▶ Run Automated Check Suite (Section I)'}
            </button>
          </div>

          {Array.isArray(testResults) && testResults.length > 0 && (
            <div style={{ marginTop: '8px' }}>
              <div style={{ fontWeight: 'bold', color: '#38bdf8', marginBottom: '4px' }}>
                Suite Results ({testResults.filter(r => r.status === 'PASS').length}/{testResults.length} Passed):
              </div>
              <table className="verify-table">
                <thead>
                  <tr>
                    <th>Scenario</th>
                    <th>Check</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {testResults.map((item, idx) => (
                    <tr key={idx}>
                      <td>{item.scenario}</td>
                      <td title={item.details}>{item.checkId}</td>
                      <td>
                        <span className={item.status === 'PASS' ? 'pass-tag' : 'fail-tag'}>
                          {item.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </aside>
      )}
    </>
  );
}

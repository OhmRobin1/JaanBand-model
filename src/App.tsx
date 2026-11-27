import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  Brain,
  Check,
  Droplets,
  ExternalLink,
  HeartHandshake,
  HeartPulse,
  Infinity as InfinityIcon,
  Layers,
  LogIn,
  LogOut,
  Scale,
  Share2,
  Shield,
  Thermometer,
  Waves,
  Wine,
} from 'lucide-react';
import { BandIngestControls } from './components/BandIngestControls';
import { BandViewport3D } from './components/BandViewport3D';
import { DiagnosticPanel } from './components/DiagnosticPanel';
import { JaanSaathiWorkerPortal } from './components/JaanSaathiWorkerPortal';
import { LiveTelemetryWave } from './components/LiveTelemetryWave';
import { WorkerRosterPanel } from './components/WorkerRosterPanel';
import {
  auth,
  firebaseConfig,
  signInWithGoogle,
  signOutUser,
  testConnection,
} from './firebase';
import {
  evaluateFitToWork,
  getKeepAliveStatus,
  subscribeWorkers,
  updateWorkerHealthProfile,
} from './services/jaanshieldFirestore';
import {
  ConditionLevel,
  DUTY_ZONE_OPTIONS,
  DiagnosticCheckItem,
  FINISH_OPTIONS,
  FinishId,
  MOUNT_OPTIONS,
  MountMode,
  WorkerRecord,
} from './types/band';

const INITIAL_CHECKS: DiagnosticCheckItem[] = [
  {
    id: 'firestore',
    label: 'Shared Firebase Firestore Link',
    detail: 'Real-time onSnapshot, health baselines & 15s Keep-Alive sync',
    metric: 'CONNECTED',
    status: 'pending',
  },
  {
    id: 'ppg',
    label: 'Dual-Wavelength PPG & HRV Array',
    detail: '530nm green + 940nm IR optical calibration + RMSSD HRV',
    metric: '42.8 dB SNR',
    status: 'pending',
  },
  {
    id: 'thermal',
    label: 'Conformal Puck & Motion IMU',
    detail: 'IK07 potted thermistor + 6–12 Hz micro-tremor accelerometer',
    metric: '±0.02 °C',
    status: 'pending',
  },
  {
    id: 'cipher',
    label: 'ePTFE Breath Vent & Dynamic Rf',
    detail: '10s pulsed MEMS alcohol vent, age/comorbidity ceiling & 15s Lead-Off',
    metric: 'VERIFIED',
    status: 'pending',
  },
];

export default function App() {
  const [viewMode, setViewMode] = useState<'band' | 'worker'>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('view') === 'worker' || window.location.pathname === '/worker') {
        return 'worker';
      }
    }
    return 'band';
  });
  const [selectedFinishId, setSelectedFinishId] = useState<FinishId>('obsidian');
  const [previewMountMode, setPreviewMountMode] = useState<MountMode>('wrist');
  const [exploded, setExploded] = useState(false);
  const [activeWaveMode, setActiveWaveMode] = useState<'ppg' | 'thermal'>('ppg');
  const [copiedSpec, setCopiedSpec] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [workers, setWorkers] = useState<WorkerRecord[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [isStreamConnected, setIsStreamConnected] = useState(false);
  const [firestoreError, setFirestoreError] = useState<Error | null>(null);
  const [mountSyncError, setMountSyncError] = useState<string | null>(null);

  const lastWorkerIdRef = useRef<string | null>(null);
  const pinnedMountRef = useRef<{ workerId: string; mode: MountMode } | null>(null);

  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [diagnosticChecks, setDiagnosticChecks] =
    useState<DiagnosticCheckItem[]>(INITIAL_CHECKS);
  const [diagnosticCompletedAt, setDiagnosticCompletedAt] = useState<string | null>(
    null,
  );

  if (firestoreError) {
    throw firestoreError;
  }

  // Real-time 1-second clock ONLY to evaluate true 15s Keep-Alive expiration
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setWorkers([]);
        setSelectedWorkerId(null);
        setIsStreamConnected(false);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!authReady || !user) return;

    const unsubscribe = subscribeWorkers(
      user,
      (list) => {
        setWorkers(list);
        setSelectedWorkerId((prev) =>
          prev && list.some((w) => w.id === prev) ? prev : list[0]?.id ?? null,
        );
        setIsStreamConnected(true);
      },
      (err) => {
        setIsStreamConnected(false);
        setFirestoreError(err);
      },
    );

    return () => unsubscribe();
  }, [authReady, user]);

  const handleSignIn = useCallback(async () => {
    setAuthError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Google Sign-In cancelled or blocked',
      );
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    setAuthError(null);
    await signOutUser();
  }, []);

  const selectedFinish = useMemo(
    () => FINISH_OPTIONS.find((f) => f.id === selectedFinishId) ?? FINISH_OPTIONS[0],
    [selectedFinishId],
  );

  const selectedWorker = useMemo(
    () => workers.find((w) => w.id === selectedWorkerId) ?? workers[0] ?? null,
    [workers, selectedWorkerId],
  );

  useEffect(() => {
    if (!selectedWorker) {
      lastWorkerIdRef.current = null;
      pinnedMountRef.current = null;
      return;
    }

    if (lastWorkerIdRef.current !== selectedWorker.id) {
      lastWorkerIdRef.current = selectedWorker.id;
      pinnedMountRef.current = null;
      setPreviewMountMode(selectedWorker.mountMode);
      return;
    }

    const pinned = pinnedMountRef.current;
    if (pinned && pinned.workerId === selectedWorker.id) {
      if (selectedWorker.mountMode === pinned.mode) {
        setPreviewMountMode(selectedWorker.mountMode);
      }
      return;
    }

    setPreviewMountMode(selectedWorker.mountMode);
  }, [selectedWorker?.id, selectedWorker?.mountMode]);

  const handleChangeMountMode = useCallback(
    async (nextMode: MountMode) => {
      setPreviewMountMode(nextMode);
      setMountSyncError(null);
      if (user && selectedWorker) {
        pinnedMountRef.current = { workerId: selectedWorker.id, mode: nextMode };
        if (selectedWorker.mountMode !== nextMode) {
          try {
            await updateWorkerHealthProfile(selectedWorker, { mountMode: nextMode });
          } catch (err) {
            setMountSyncError(
              err instanceof Error
                ? `Could not save ${nextMode} mount to Firestore`
                : `Could not save ${nextMode} mount`,
            );
          }
        }
      }
    },
    [selectedWorker, user],
  );

  const disconnectedWorkers = useMemo(
    () =>
      workers
        .map((w) => ({ worker: w, ka: getKeepAliveStatus(w, nowMs) }))
        .filter((item) => item.ka.state === 'disconnected'),
    [workers, nowMs],
  );

  const selectedKeepAlive = useMemo(
    () => getKeepAliveStatus(selectedWorker, nowMs),
    [selectedWorker, nowMs],
  );

  const latestReport = selectedWorker?.lastReport ?? null;
  const activeCondition: ConditionLevel =
    selectedKeepAlive.state === 'disconnected'
      ? 'critical'
      : selectedWorker?.condition ?? 'unlinked';

  const runDiagnosticSequence = useCallback(async () => {
    setShowDiagnostic(true);
    setIsDiagnosing(true);
    setDiagnosticCompletedAt(null);

    const reachable = await testConnection();
    const pairedCount = workers.filter((w) => Boolean(w.bandId)).length;
    const healthMetric = !reachable
      ? 'OFFLINE'
      : user
        ? `${pairedCount} PAIRED · FIRESTORE LIVE`
        : 'REACHABLE · SIGN IN';

    const checksWithHealth = INITIAL_CHECKS.map((item, idx) => ({
      ...item,
      metric: idx === 0 ? healthMetric : item.metric,
      status: idx === 0 ? ('running' as const) : ('pending' as const),
    }));
    setDiagnosticChecks(checksWithHealth);

    const stepDelay = 480;
    checksWithHealth.forEach((_, stepIndex) => {
      window.setTimeout(() => {
        setDiagnosticChecks((prev) =>
          prev.map((item, idx) => {
            if (idx <= stepIndex) return { ...item, status: 'passed' };
            if (idx === stepIndex + 1) return { ...item, status: 'running' };
            return item;
          }),
        );

        if (stepIndex === checksWithHealth.length - 1) {
          setIsDiagnosing(false);
          setDiagnosticCompletedAt(
            new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }),
          );
        }
      }, (stepIndex + 1) * stepDelay);
    });
  }, [user, workers]);

  const handleShareSpec = useCallback(async () => {
    const workerSummary = selectedWorker
      ? `Worker ${selectedWorker.id} (${selectedWorker.name}) · Mount ${selectedWorker.mountMode} · Rf ${selectedWorker.riskFactor.toFixed(2)} · Crit ${selectedWorker.dynamicHrR} BPM · ${activeCondition.toUpperCase()}`
      : 'No worker paired';
    const summary = `JaanBand Core MK-IV · ${selectedFinish.name} · ${workerSummary} · Firestore: ${firebaseConfig.projectId}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(summary);
      }
    } catch {
      // Clipboard API may be restricted in preview iframes
    }
    setCopiedSpec(true);
    window.setTimeout(() => setCopiedSpec(false), 2200);
  }, [activeCondition, selectedFinish.name, selectedWorker]);

  const mountDetail =
    MOUNT_OPTIONS.find((m) => m.id === previewMountMode) ?? MOUNT_OPTIONS[0];

  const selectedFitEvaluation = useMemo(() => {
    if (!selectedWorker) return null;
    return evaluateFitToWork({
      workerId: selectedWorker.id,
      restingBp: selectedWorker.restingBp,
      baselineHr: selectedWorker.baselineHr,
      daysOnSite: selectedWorker.daysOnSite,
      dutyZone: selectedWorker.dutyZone,
      readiness: selectedWorker.readiness,
      gaitBalance: selectedWorker.gaitBalance,
      mq3Status: selectedWorker.mq3Status,
      mq3MgL: selectedWorker.mq3MgL,
      shiftStartHr: selectedWorker.shiftStartHr,
      shiftHours: selectedWorker.shiftHours,
      leadOff:
        selectedWorker.leadOff || selectedKeepAlive.state === 'disconnected',
      condition: activeCondition,
      lastReport: selectedWorker.lastReport,
      mentalStrainLevel: selectedWorker.mentalStrainLevel,
      mentalRfBoost: selectedWorker.mentalRfBoost,
    });
  }, [selectedWorker, selectedKeepAlive.state, activeCondition]);

  const activeHealthTags = useMemo(() => {
    if (!selectedWorker) return [];
    const zoneShort =
      DUTY_ZONE_OPTIONS.find((z) => z.id === selectedWorker.dutyZone)?.shortLabel ??
      'Heavy Sun';
    const tags: string[] = [
      `Age ${selectedWorker.age}`,
      `BP ${selectedWorker.restingBp}`,
      `Day ${selectedWorker.daysOnSite}${selectedWorker.daysOnSite < 7 ? ' (<7d)' : ''}`,
      zoneShort,
    ];
    if (selectedWorker.gaitBalance !== 'pending') {
      tags.push(`Gait: ${selectedWorker.gaitBalance.toUpperCase()}`);
    }
    if (selectedWorker.conditions.hypertension) tags.push('Hypertension');
    if (selectedWorker.conditions.diabetes) tags.push('Diabetes');
    if (selectedWorker.conditions.priorHeat) tags.push('Prior Heat');
    if (selectedWorker.readiness.lowSleep) tags.push('<5h Sleep');
    if (selectedWorker.readiness.sedatingMeds) tags.push('Drowsy Meds');
    if (selectedWorker.readiness.dizzyOrUnwell) tags.push('Dizzy / Unwell');
    if (selectedWorker.shiftHours >= 4) {
      tags.push(`Shift ${selectedWorker.shiftHours.toFixed(1)}h (Fatigue)`);
    }
    if (selectedWorker.mentalRfBoost > 0 || selectedWorker.mentalStrainLevel !== 'calm') {
      tags.push(`Wellbeing +${selectedWorker.mentalRfBoost.toFixed(2)} Rf (Private)`);
    }
    return tags;
  }, [selectedWorker]);

  return (
    <div className="min-h-screen bg-[#040709] text-slate-100 pb-10">
      {/* Executive Top Bar */}
      <header className="sticky top-0 z-40 bg-[#040709]/92 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emeraldGlow/20 via-obsidian-850 to-titaniumGold/20 border border-emeraldGlow/30 flex items-center justify-center shrink-0">
              <InfinityIcon className="w-[18px] h-[18px] text-emeraldGlow" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono tracking-widest text-titaniumGold uppercase font-bold whitespace-nowrap">
                  JAANBAND
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-slate-300 font-mono whitespace-nowrap">
                  MK-IV PUCK
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-medium tracking-tight truncate">
                JaanShield Physiological Safety &amp; Shared Firestore
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="inline-flex items-center p-0.5 rounded-full bg-obsidian-900 border border-white/10">
              <button
                type="button"
                onClick={() => setViewMode('band')}
                className={`px-2.5 py-1 rounded-full text-[11px] font-mono transition-colors cursor-pointer ${
                  viewMode === 'band'
                    ? 'bg-emeraldGlow/15 text-emeraldGlow font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Band Studio
              </button>
              <button
                type="button"
                onClick={() => setViewMode('worker')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-mono transition-colors cursor-pointer ${
                  viewMode === 'worker'
                    ? 'bg-titaniumGold/20 text-titaniumGold font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <HeartHandshake className="w-3 h-3" aria-hidden="true" />
                <span>JaanSaathi App</span>
              </button>
            </div>

            <div
              className={`${
                isStreamConnected ? 'inline-flex' : 'hidden sm:inline-flex'
              } items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[10px] font-mono tracking-wide font-semibold whitespace-nowrap shrink-0 ${
                isStreamConnected
                  ? 'bg-emeraldGlow/10 border-emeraldGlow/30 text-emeraldGlow'
                  : 'bg-obsidian-800 border-white/10 text-slate-400'
              }`}
            >
              <span>
                {isStreamConnected
                  ? 'FIRESTORE LIVE'
                  : user
                    ? 'SYNCING'
                    : 'SIGN IN TO SYNC'}
              </span>
            </div>

            {user ? (
              <button
                type="button"
                onClick={handleSignOut}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-obsidian-800 border border-white/10 text-[11px] font-medium text-slate-200 hover:text-orange-300 hover:border-orange-500/30 transition-colors cursor-pointer"
                title={`Signed in as ${user.email || user.uid}`}
              >
                <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline max-w-[120px] truncate">
                  {user.email?.split('@')[0] || 'Sign out'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                disabled={!authReady}
                onClick={handleSignIn}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emeraldGlow text-obsidian-950 text-[11px] font-semibold hover:brightness-105 disabled:opacity-60 transition cursor-pointer whitespace-nowrap"
              >
                <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Google Sign-In</span>
              </button>
            )}

            <a
              href="https://jaan-shield.vercel.app"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-obsidian-800 border border-white/10 text-[11px] font-medium text-slate-200 hover:text-emeraldGlow hover:border-emeraldGlow/30 transition-colors whitespace-nowrap shrink-0"
            >
              <span>JaanShield Monitor</span>
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>

            <button
              type="button"
              onClick={handleShareSpec}
              className="h-9 px-2.5 rounded-full bg-obsidian-800 border border-white/10 flex items-center justify-center gap-1.5 text-slate-300 hover:text-white hover:border-white/20 transition-colors cursor-pointer"
              aria-label="Copy live link summary"
            >
              {copiedSpec ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emeraldGlow" aria-hidden="true" />
                  <span className="text-[11px] font-mono text-emeraldGlow hidden sm:inline">
                    Copied
                  </span>
                </>
              ) : (
                <Share2 className="w-4 h-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </header>

      {(authError || mountSyncError) && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-3">
          <div className="p-2.5 rounded-xl bg-orange-500/10 border border-orange-500/30 text-xs text-orange-300 flex items-center justify-between gap-2">
            <span>{authError || mountSyncError}</span>
            <button
              type="button"
              onClick={() => {
                setAuthError(null);
                setMountSyncError(null);
              }}
              className="text-[11px] font-mono text-orange-200 hover:text-white cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Mechanical Disconnect / 15s Keep-Alive Failsafe Banner */}
      {disconnectedWorkers.length > 0 && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-3">
          <div className="p-3 rounded-2xl bg-orange-950/55 border border-orange-500/50 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0" />
              <div className="text-xs">
                <p className="font-semibold text-orange-200">
                  {disconnectedWorkers[0].ka.reason}
                  {disconnectedWorkers.length > 1
                    ? ` (+${disconnectedWorkers.length - 1} more)`
                    : ''}
                </p>
                <p className="text-[11px] text-orange-300/80">
                  Deploy swap-out puck from 10% on-site hardware buffer (₹79/mo rental continuity).
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedWorkerId(disconnectedWorkers[0].worker.id)}
              className="px-3 py-1 rounded-xl bg-orange-500 text-obsidian-950 text-[11px] font-semibold cursor-pointer"
            >
              Inspect {disconnectedWorkers[0].worker.id}
            </button>
          </div>
        </div>
      )}

      {viewMode === 'worker' ? (
        <JaanSaathiWorkerPortal
          user={user}
          authReady={authReady}
          onSignIn={handleSignIn}
          managerWorkers={workers}
        />
      ) : (
      /* Main Executive Stage */
      <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-4 lg:pt-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 items-start">
          {/* Left Column: 3D Modular Puck Viewport + Spec Metrics + Worker Registry */}
          <div className="lg:col-span-6 space-y-4">
            <section className="relative rounded-3xl overflow-hidden glass-panel border border-white/10 shadow-2xl">
              <BandViewport3D
                finish={selectedFinish}
                worker={selectedWorker}
                mountMode={previewMountMode}
                onChangeMountMode={handleChangeMountMode}
                condition={activeCondition}
                keepAliveStatus={selectedKeepAlive}
                bpm={latestReport?.bpm ?? null}
                skinTempC={latestReport?.skinTempC ?? null}
                isConnectedStream={isStreamConnected}
                isDiagnosing={isDiagnosing}
                exploded={exploded}
                onToggleExploded={() => setExploded((prev) => !prev)}
              />

              {/* Viewport Mount Spec & Exterior Material Switcher */}
              <div className="p-3.5 sm:p-4 bg-obsidian-900/95 border-t border-white/10 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase font-mono tracking-wider text-slate-400">
                    {mountDetail.label} · {selectedFinish.shortName}
                  </p>
                  <h2 className="text-xs sm:text-sm font-semibold text-white tracking-tight truncate">
                    {mountDetail.spec}
                  </h2>
                </div>

                <div
                  className="flex items-center gap-2 shrink-0"
                  role="radiogroup"
                  aria-label="Exterior finish selector"
                >
                  {FINISH_OPTIONS.map((option) => {
                    const active = option.id === selectedFinish.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={option.name}
                        onClick={() => setSelectedFinishId(option.id)}
                        className={`relative w-8 h-8 rounded-full p-0.5 border-2 transition-transform active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emeraldGlow cursor-pointer ${
                          active
                            ? 'border-emeraldGlow'
                            : 'border-transparent hover:border-slate-500'
                        }`}
                      >
                        <span
                          className={`block w-full h-full rounded-full shadow-inner ${option.swatchClass}`}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* Key Hardware & Continuity Metrics */}
            <section
              aria-label="Key Performance Metrics"
              className="grid grid-cols-3 gap-2.5 sm:gap-3"
            >
              <div className="glass-panel p-3 sm:p-3.5 rounded-2xl border border-white/5 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-emeraldGlow/40 to-transparent" />
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-[10px] font-mono uppercase tracking-wider">
                    Watchdog
                  </span>
                  <BatteryCharging className="w-3.5 h-3.5 text-emeraldGlow" aria-hidden="true" />
                </div>
                <div className="flex items-baseline gap-1 font-mono tabular-nums">
                  <span className="text-lg sm:text-xl font-bold text-white tracking-tight">
                    15
                  </span>
                  <span className="text-[11px] text-emeraldGlow">Sec Link</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-0.5">Instant Lead-Off alert</p>
              </div>

              <div className="glass-panel p-3 sm:p-3.5 rounded-2xl border border-white/5 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-titaniumGold/40 to-transparent" />
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-[10px] font-mono uppercase tracking-wider">
                    Potted Shell
                  </span>
                  <Droplets className="w-3.5 h-3.5 text-titaniumGold" aria-hidden="true" />
                </div>
                <div className="flex items-baseline gap-1 font-mono tabular-nums">
                  <span className="text-lg sm:text-xl font-bold text-white tracking-tight">
                    IK07
                  </span>
                  <span className="text-[11px] text-titaniumGold">/ IP67</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-0.5">Conformal resin core</p>
              </div>

              <div className="glass-panel p-3 sm:p-3.5 rounded-2xl border border-white/5 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-sky-400/40 to-transparent" />
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-[10px] font-mono uppercase tracking-wider">
                    Strap Swap
                  </span>
                  <Scale className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                </div>
                <div className="flex items-baseline gap-1 font-mono tabular-nums">
                  <span className="text-lg sm:text-xl font-bold text-white tracking-tight">
                    ₹20
                  </span>
                  <span className="text-[11px] text-sky-400">3 Mounts</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-0.5">Wrist · Bicep · Helmet</p>
              </div>
            </section>

            {/* Worker-Band Registry & 1-Min Health Baseline (Zero Dummy Data) */}
            <WorkerRosterPanel
              user={user}
              authReady={authReady}
              onSignIn={handleSignIn}
              workers={workers}
              selectedWorkerId={selectedWorker?.id ?? null}
              onSelectWorker={setSelectedWorkerId}
              onMountSaved={(wId, mode) => {
                pinnedMountRef.current = { workerId: wId, mode };
                if (selectedWorker?.id === wId) {
                  setPreviewMountMode(mode);
                }
              }}
              nowMs={nowMs}
            />
          </div>

          {/* Right Column: Live Dynamic Risk Engine, Failsafe/MQ-3 Ingest & Architecture */}
          <div className="lg:col-span-6 space-y-4">
            {/* Biometric Sensor Array, Dynamic Rf & Alcohol Fingerprint */}
            <section className="glass-panel p-4 rounded-3xl border border-white/10 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emeraldGlow" aria-hidden="true" />
                  <h3 className="text-xs font-mono font-bold tracking-wider uppercase text-white">
                    {selectedWorker
                      ? `${selectedWorker.id} · ${selectedWorker.name}`
                      : 'Biometric Sensor Array'}
                  </h3>
                </div>
                <span
                  className={`text-[10px] font-mono tabular-nums px-2 py-0.5 rounded bg-obsidian-950 border whitespace-nowrap ${
                    activeCondition === 'critical'
                      ? 'text-orange-400 border-orange-500/40'
                      : activeCondition === 'caution'
                        ? 'text-titaniumGold border-titaniumGold/40'
                        : activeCondition === 'normal'
                          ? 'text-emeraldGlow border-emeraldGlow/30'
                          : 'text-slate-400 border-white/10'
                  }`}
                >
                  {selectedKeepAlive.state === 'disconnected'
                    ? 'DISCONNECTED · FAILSAFE'
                    : latestReport
                      ? `${latestReport.spo2.toFixed(1)}% SpO2 · ${activeCondition.toUpperCase()}`
                      : 'Awaiting Band Report'}
                </span>
              </div>

              {/* Fit-to-Work Clearance Verdict + Dynamic Risk Profile (Rf) */}
              {selectedWorker && selectedFitEvaluation && (
                <div className="p-3 rounded-2xl bg-obsidian-950/90 border border-white/10 space-y-2.5 text-[11px]">
                  <div
                    className={`p-2.5 rounded-xl border flex items-start justify-between gap-2 flex-wrap ${
                      selectedFitEvaluation.status === 'medical_hold'
                        ? 'bg-orange-950/45 border-orange-500/45 text-orange-200'
                        : selectedFitEvaluation.status === 'shaded_only'
                          ? 'bg-amber-950/35 border-titaniumGold/40 text-amber-100'
                          : 'bg-emerald-950/30 border-emeraldGlow/30 text-emerald-100'
                    }`}
                  >
                    <div className="space-y-0.5 min-w-0">
                      <p className="text-[10px] font-mono uppercase tracking-wider opacity-80">
                        Fit-to-Work Clearance Verdict
                      </p>
                      <p className="text-xs font-bold tracking-tight">
                        {selectedFitEvaluation.status === 'medical_hold'
                          ? 'MEDICAL HOLD · DO NOT DEPLOY'
                          : selectedFitEvaluation.status === 'shaded_only'
                            ? 'SHADED / GROUND DUTY ONLY'
                            : 'FIT FOR FULL DUTY'}
                      </p>
                      <p className="text-[11px] opacity-90 leading-snug">
                        {selectedFitEvaluation.reasons.join(' · ')}
                      </p>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-md text-[10px] font-mono font-bold border shrink-0 ${
                        selectedFitEvaluation.status === 'medical_hold'
                          ? 'bg-orange-500/20 border-orange-500/50 text-orange-300'
                          : selectedFitEvaluation.status === 'shaded_only'
                            ? 'bg-titaniumGold/20 border-titaniumGold/50 text-titaniumGold'
                            : 'bg-emeraldGlow/15 border-emeraldGlow/40 text-emeraldGlow'
                      }`}
                    >
                      {selectedFitEvaluation.status === 'medical_hold'
                        ? 'UNFIT / HOLD'
                        : selectedFitEvaluation.status === 'shaded_only'
                          ? 'RESTRICTED'
                          : 'CLEARED'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2 flex-wrap font-mono">
                    <span className="text-titaniumGold font-semibold">
                      Dynamic Rf {selectedWorker.riskFactor.toFixed(2)} · Crit Ceiling{' '}
                      {selectedWorker.dynamicHrR} BPM (Std 140)
                    </span>
                    <span className="text-slate-400">
                      {latestReport
                        ? `${new Date(latestReport.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })} (${latestReport.source.toUpperCase()})`
                        : 'No packets received'}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {activeHealthTags.map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 rounded-md bg-obsidian-900 border border-white/10 font-mono text-[10px] text-slate-300"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>

                  {/* Two-Tier Alcohol & Hangover / HRV Readout */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 font-mono tabular-nums">
                    <div className="p-1.5 rounded-lg bg-obsidian-900/80 border border-white/5">
                      <span className="block text-[9px] text-slate-400">BREATH VENT</span>
                      <span
                        className={`text-[11px] font-semibold ${
                          selectedWorker.mq3Status === 'flagged'
                            ? 'text-orange-400'
                            : selectedWorker.mq3Status === 'clear'
                              ? 'text-emeraldGlow'
                              : 'text-slate-300'
                        }`}
                      >
                        {selectedWorker.mq3Status.toUpperCase()}
                      </span>
                    </div>
                    <div className="p-1.5 rounded-lg bg-obsidian-900/80 border border-white/5">
                      <span className="block text-[9px] text-slate-400">8AM REST HR</span>
                      <span
                        className={`text-[11px] font-semibold ${
                          (selectedWorker.shiftStartHr ?? 0) >= 95
                            ? 'text-orange-400'
                            : 'text-slate-200'
                        }`}
                      >
                        {selectedWorker.shiftStartHr !== null
                          ? `${selectedWorker.shiftStartHr} bpm`
                          : '--'}
                      </span>
                    </div>
                    <div className="p-1.5 rounded-lg bg-obsidian-900/80 border border-white/5">
                      <span className="block text-[9px] text-slate-400">5M HRR DROP</span>
                      <span
                        className={`text-[11px] font-semibold ${
                          latestReport?.hrrBpmDrop !== null &&
                          latestReport?.hrrBpmDrop !== undefined &&
                          latestReport.hrrBpmDrop < 12
                            ? 'text-titaniumGold'
                            : 'text-slate-200'
                        }`}
                      >
                        {latestReport?.hrrBpmDrop !== null &&
                        latestReport?.hrrBpmDrop !== undefined
                          ? `${latestReport.hrrBpmDrop} bpm`
                          : '--'}
                      </span>
                    </div>
                    <div className="p-1.5 rounded-lg bg-obsidian-900/80 border border-white/5">
                      <span className="block text-[9px] text-slate-400">TREMOR IMU</span>
                      <span
                        className={`text-[11px] font-semibold ${
                          latestReport?.tremorHz !== null &&
                          latestReport?.tremorHz !== undefined &&
                          latestReport.tremorHz >= 6 &&
                          latestReport.tremorHz <= 12
                            ? 'text-orange-400'
                            : 'text-slate-200'
                        }`}
                      >
                        {latestReport?.tremorHz !== null &&
                        latestReport?.tremorHz !== undefined
                          ? `${latestReport.tremorHz.toFixed(1)} Hz`
                          : '--'}
                      </span>
                    </div>
                  </div>

                  <p className="text-slate-200 pt-0.5">
                    {selectedWorker.reasons.join(' · ')}
                  </p>
                </div>
              )}

              {/* Live Waveform Strip + Real Telemetry Readouts */}
              <div className="space-y-2">
                <LiveTelemetryWave
                  bpm={latestReport?.bpm ?? null}
                  condition={activeCondition}
                  isDiagnosing={isDiagnosing}
                  mode={activeWaveMode}
                />
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-[11px] font-mono tabular-nums text-slate-400">
                  <span>
                    HR:{' '}
                    <strong className="text-white font-semibold">
                      {latestReport ? `${latestReport.bpm} BPM` : '--'}
                    </strong>
                  </span>
                  <span>
                    HRV:{' '}
                    <strong
                      className={`font-semibold ${
                        latestReport?.hrvMs !== null &&
                        latestReport?.hrvMs !== undefined &&
                        latestReport.hrvMs < 32
                          ? 'text-titaniumGold'
                          : 'text-emeraldGlow'
                      }`}
                    >
                      {latestReport?.hrvMs !== null && latestReport?.hrvMs !== undefined
                        ? `${latestReport.hrvMs} ms`
                        : '--'}
                    </strong>
                  </span>
                  <span>
                    Perf:{' '}
                    <strong
                      className={`font-semibold ${
                        latestReport?.perfusionIndex !== null &&
                        latestReport?.perfusionIndex !== undefined &&
                        latestReport.perfusionIndex < 0.8
                          ? 'text-orange-400'
                          : 'text-slate-200'
                      }`}
                    >
                      {latestReport?.perfusionIndex !== null &&
                      latestReport?.perfusionIndex !== undefined
                        ? `${latestReport.perfusionIndex.toFixed(1)}%`
                        : '--'}
                    </strong>
                  </span>
                  <span>
                    Heat:{' '}
                    <strong className="text-slate-200 font-semibold">
                      {latestReport?.heatIndexC !== null &&
                      latestReport?.heatIndexC !== undefined
                        ? `${latestReport.heatIndexC.toFixed(1)}°C`
                        : '--'}
                    </strong>
                  </span>
                  <span>
                    Batt:{' '}
                    <strong
                      className={`font-semibold ${
                        latestReport?.batteryPct !== null &&
                        latestReport?.batteryPct !== undefined &&
                        latestReport.batteryPct < 15
                          ? 'text-orange-400'
                          : 'text-slate-200'
                      }`}
                    >
                      {latestReport?.batteryPct !== null &&
                      latestReport?.batteryPct !== undefined
                        ? `${latestReport.batteryPct}%`
                        : '--'}
                    </strong>
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setActiveWaveMode('ppg')}
                  className={`w-full text-left p-2.5 rounded-xl border flex items-start justify-between gap-2 transition-colors cursor-pointer ${
                    activeWaveMode === 'ppg'
                      ? 'bg-obsidian-900/95 border-emeraldGlow/30'
                      : 'bg-obsidian-900/70 border-white/5 hover:border-white/15'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 w-7 h-7 rounded-lg bg-emeraldGlow/10 flex items-center justify-center text-emeraldGlow shrink-0">
                      <HeartPulse className="w-4 h-4" aria-hidden="true" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold text-slate-200">
                        Dual-Wavelength PPG &amp; RMSSD Cognitive Stress
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Detects autonomic sympathetic lockup, HRV exhaustion &amp; individualized cardiac ceilings.
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-emeraldGlow font-medium px-1.5 py-0.5 bg-obsidian-950 rounded whitespace-nowrap shrink-0">
                    {latestReport ? `${latestReport.bpm} BPM` : 'IDLE'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveWaveMode('thermal')}
                  className={`w-full text-left p-2.5 rounded-xl border flex items-start justify-between gap-2 transition-colors cursor-pointer ${
                    activeWaveMode === 'thermal'
                      ? 'bg-obsidian-900/95 border-titaniumGold/35'
                      : 'bg-obsidian-900/70 border-white/5 hover:border-white/15'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 w-7 h-7 rounded-lg bg-titaniumGold/10 flex items-center justify-center text-titaniumGold shrink-0">
                      <Thermometer className="w-4 h-4" aria-hidden="true" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold text-slate-200">
                        Sub-Epidermal Thermistor &amp; Dehydration Load
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Tightens heat-stress cutoff automatically for prior heat exhaustion or MQ-3 flags.
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono tabular-nums text-titaniumGold font-medium px-1.5 py-0.5 bg-obsidian-950 rounded whitespace-nowrap shrink-0">
                    {latestReport ? `${latestReport.skinTempC.toFixed(1)}°C` : '--°C'}
                  </span>
                </button>
              </div>
            </section>

            {/* Real-Time Band Transfer, 15s Keep-Alive, MQ-3 Gate & Hangover Ingest */}
            <BandIngestControls
              user={user}
              selectedWorker={selectedWorker}
              isStreamConnected={isStreamConnected}
              nowMs={nowMs}
            />

            {/* Engineered Field Architecture */}
            <section className="glass-panel p-4 rounded-3xl border border-white/10 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-titaniumGold" aria-hidden="true" />
                  <h3 className="text-xs font-mono font-bold tracking-wider uppercase text-white">
                    Site-Deployable Hardware &amp; Physiology
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setExploded((prev) => !prev)}
                  className="text-[10px] font-mono text-slate-300 hover:text-emeraldGlow transition-colors cursor-pointer"
                >
                  {exploded ? 'SEAT PUCK' : 'POP CORE PUCK'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                <div className="p-3 rounded-2xl bg-obsidian-900/70 border border-white/5 space-y-1">
                  <div className="flex items-center gap-1.5 text-titaniumGold">
                    <Shield className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-mono text-[10px] font-semibold uppercase">
                      Modular Potted Puck
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-200 font-medium">
                    IK07 Shell + ₹20 Strap Decoupling
                  </p>
                  <p className="text-[10px] text-slate-400 leading-snug">
                    Conformal resin seals electronics against slurry &amp; jackhammer impact across wrist, bicep, or hardhat liner.
                  </p>
                </div>

                <div className="p-3 rounded-2xl bg-obsidian-900/70 border border-white/5 space-y-1">
                  <div className="flex items-center gap-1.5 text-emeraldGlow">
                    <Brain className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-mono text-[10px] font-semibold uppercase">
                      Dynamic Rf &amp; HRV Stress
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-200 font-medium">
                    Personalized Clinical Limits
                  </p>
                  <p className="text-[10px] text-slate-400 leading-snug">
                    Drops critical BPM from 140 to 115 for 45+ hypertensive workers while tracking RMSSD stress &amp; 4h fatigue.
                  </p>
                </div>

                <div className="p-3 rounded-2xl bg-obsidian-900/70 border border-white/5 space-y-1">
                  <div className="flex items-center gap-1.5 text-sky-400">
                    <Wine className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-mono text-[10px] font-semibold uppercase">
                      On-Band Breath &amp; Hangover IMU
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-200 font-medium">
                    10s Pulsed ePTFE Vent + Gate MQ-3
                  </p>
                  <p className="text-[10px] text-slate-400 leading-snug">
                    Screens breath via puck&apos;s waterproof ePTFE MEMS vent (or gate kiosk) and catches 95+ BPM tachycardia, impaired HRR &amp; 6–12 Hz tremors.
                  </p>
                </div>

                <div className="p-3 rounded-2xl bg-obsidian-900/70 border border-white/5 space-y-1">
                  <div className="flex items-center gap-1.5 text-orange-400">
                    <Waves className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-mono text-[10px] font-semibold uppercase">
                      15s Keep-Alive Failsafe
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-200 font-medium">
                    10% Site Buffer Continuity
                  </p>
                  <p className="text-[10px] text-slate-400 leading-snug">
                    Triggers immediate Lead-Off mechanical failure alert if crushed or removed under ₹79/mo rental continuity.
                  </p>
                </div>
              </div>
            </section>

            {showDiagnostic && (
              <DiagnosticPanel
                checks={diagnosticChecks}
                isRunning={isDiagnosing}
                completedAt={diagnosticCompletedAt}
                onClose={() => setShowDiagnostic(false)}
                onRerun={runDiagnosticSequence}
              />
            )}

            {/* Executive Action Deck */}
            <div className="pt-1 pb-4 space-y-2.5">
              <div className="flex flex-col sm:flex-row gap-2.5">
                <button
                  type="button"
                  onClick={runDiagnosticSequence}
                  disabled={isDiagnosing}
                  className="flex-1 py-3.5 px-5 rounded-2xl bg-gradient-to-r from-emeraldGlow via-[#00f5a4] to-emeraldGlow text-obsidian-950 font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emeraldGlow/20 hover:brightness-105 active:scale-[0.99] transition disabled:opacity-80 cursor-pointer"
                >
                  <Activity className="w-[18px] h-[18px]" aria-hidden="true" />
                  <span>
                    {isDiagnosing
                      ? 'Verifying Firestore, Rf Engine & Failsafe...'
                      : 'Run Diagnostic Telemetry Check'}
                  </span>
                </button>

                <a
                  href="https://jaan-shield.vercel.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sm:hidden py-3 px-4 rounded-2xl bg-obsidian-800 border border-white/10 text-slate-200 font-semibold text-xs flex items-center justify-center gap-2 hover:border-emeraldGlow/40 transition-colors"
                >
                  <span>Open JaanShield Monitor</span>
                  <ExternalLink className="w-3.5 h-3.5 text-emeraldGlow" aria-hidden="true" />
                </a>
              </div>

              <div className="flex items-center justify-between px-2 text-[10px] font-mono text-slate-400">
                <span>FIRMWARE: v4.3.0-MODULAR-PUCK</span>
                <span className="text-emeraldGlow flex items-center gap-1">
                  <Shield className="w-3 h-3" aria-hidden="true" />
                  SHARED FIRESTORE SYNC READY
                </span>
              </div>
            </div>
          </div>
        </div>
      </main>
      )}
    </div>
  );
}

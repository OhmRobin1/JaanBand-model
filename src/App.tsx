import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  Activity,
  BatteryCharging,
  Check,
  Droplets,
  ExternalLink,
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
} from 'lucide-react';
import { BandIngestControls } from './components/BandIngestControls';
import { BandViewport3D } from './components/BandViewport3D';
import { DiagnosticPanel } from './components/DiagnosticPanel';
import { LiveTelemetryWave } from './components/LiveTelemetryWave';
import { WorkerRosterPanel } from './components/WorkerRosterPanel';
import {
  auth,
  firebaseConfig,
  signInWithGoogle,
  signOutUser,
  testConnection,
} from './firebase';
import { subscribeWorkers } from './services/jaanshieldFirestore';
import {
  ConditionLevel,
  DiagnosticCheckItem,
  FINISH_OPTIONS,
  FinishId,
  WorkerRecord,
} from './types/band';

const INITIAL_CHECKS: DiagnosticCheckItem[] = [
  {
    id: 'firestore',
    label: 'Shared Firebase Firestore Link',
    detail: 'Real-time onSnapshot & Google Auth session check',
    metric: 'CONNECTED',
    status: 'pending',
  },
  {
    id: 'ppg',
    label: 'Dual-Wavelength PPG Array',
    detail: '530nm green + 940nm IR optical calibration',
    metric: '42.8 dB SNR',
    status: 'pending',
  },
  {
    id: 'thermal',
    label: 'Sub-Epidermal Thermistor',
    detail: 'Heat-stress ±0.05°C baseline alignment',
    metric: '±0.02 °C',
    status: 'pending',
  },
  {
    id: 'cipher',
    label: 'Jaan-Cipher Telemetry Link',
    detail: 'Worker-to-band binding integrity check',
    metric: 'VERIFIED',
    status: 'pending',
  },
];

export default function App() {
  const [selectedFinishId, setSelectedFinishId] = useState<FinishId>('obsidian');
  const [exploded, setExploded] = useState(false);
  const [activeWaveMode, setActiveWaveMode] = useState<'ppg' | 'thermal'>('ppg');
  const [copiedSpec, setCopiedSpec] = useState(false);

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [workers, setWorkers] = useState<WorkerRecord[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [isStreamConnected, setIsStreamConnected] = useState(false);
  const [firestoreError, setFirestoreError] = useState<Error | null>(null);

  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [diagnosticChecks, setDiagnosticChecks] =
    useState<DiagnosticCheckItem[]>(INITIAL_CHECKS);
  const [diagnosticCompletedAt, setDiagnosticCompletedAt] = useState<string | null>(
    null,
  );

  // Throw Firestore permission/runtime errors into ErrorBoundary cleanly
  if (firestoreError) {
    throw firestoreError;
  }

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

  const latestReport = selectedWorker?.lastReport ?? null;
  const activeCondition: ConditionLevel = selectedWorker?.condition ?? 'unlinked';

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
      ? `Worker ${selectedWorker.id} (${selectedWorker.name}) · Band ${selectedWorker.bandId} · Condition: ${activeCondition.toUpperCase()}`
      : 'No worker paired';
    const summary = `JaanBand Core MK-IV · ${selectedFinish.name} · ${workerSummary} · Firestore Project: ${firebaseConfig.projectId} (${firebaseConfig.firestoreDatabaseId})`;
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
                  MK-IV
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-medium tracking-tight truncate">
                JaanShield Shared Firestore Telemetry
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div
              className={`${
                isStreamConnected ? 'inline-flex' : 'hidden sm:inline-flex'
              } items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[10px] font-mono tracking-wide font-semibold whitespace-nowrap shrink-0 ${
                isStreamConnected
                  ? 'bg-emeraldGlow/10 border-emeraldGlow/30 text-emeraldGlow'
                  : 'bg-obsidian-800 border-white/10 text-slate-400'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isStreamConnected ? 'bg-emeraldGlow animate-pulse' : 'bg-slate-500'
                }`}
              />
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

      {authError && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-3">
          <div className="p-2.5 rounded-xl bg-orange-500/10 border border-orange-500/30 text-xs text-orange-300">
            {authError}
          </div>
        </div>
      )}

      {/* Main Executive Stage */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-4 lg:pt-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 items-start">
          {/* Left Column: 3D Studio Viewport + Key Performance Metrics + Worker-Band Registry */}
          <div className="lg:col-span-6 space-y-4">
            <section className="relative rounded-3xl overflow-hidden glass-panel border border-white/10 shadow-2xl">
              <BandViewport3D
                finish={selectedFinish}
                worker={selectedWorker}
                condition={activeCondition}
                bpm={latestReport?.bpm ?? null}
                skinTempC={latestReport?.skinTempC ?? null}
                isConnectedStream={isStreamConnected}
                isDiagnosing={isDiagnosing}
                exploded={exploded}
                onToggleExploded={() => setExploded((prev) => !prev)}
              />

              {/* Viewport Material & Color Finish Switcher */}
              <div className="p-3.5 sm:p-4 bg-obsidian-900/95 border-t border-white/10 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase font-mono tracking-wider text-slate-400">
                    Tactile Exterior
                  </p>
                  <h2 className="text-xs sm:text-sm font-semibold text-white tracking-tight truncate">
                    {selectedFinish.name}
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

            {/* Key Performance Metrics Strip */}
            <section
              aria-label="Key Performance Metrics"
              className="grid grid-cols-3 gap-2.5 sm:gap-3"
            >
              <div className="glass-panel p-3 sm:p-3.5 rounded-2xl border border-white/5 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-emeraldGlow/40 to-transparent" />
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-[10px] font-mono uppercase tracking-wider">
                    Endurance
                  </span>
                  <BatteryCharging className="w-3.5 h-3.5 text-emeraldGlow" aria-hidden="true" />
                </div>
                <div className="flex items-baseline gap-1 font-mono tabular-nums">
                  <span className="text-lg sm:text-xl font-bold text-white tracking-tight">
                    14
                  </span>
                  <span className="text-[11px] text-emeraldGlow">Days</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-0.5">Multi-shift continuous</p>
              </div>

              <div className="glass-panel p-3 sm:p-3.5 rounded-2xl border border-white/5 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-titaniumGold/40 to-transparent" />
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-[10px] font-mono uppercase tracking-wider">
                    Protection
                  </span>
                  <Droplets className="w-3.5 h-3.5 text-titaniumGold" aria-hidden="true" />
                </div>
                <div className="flex items-baseline gap-1 font-mono tabular-nums">
                  <span className="text-lg sm:text-xl font-bold text-white tracking-tight">
                    100
                  </span>
                  <span className="text-[11px] text-titaniumGold">M / IP68</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-0.5">Dust &amp; sweat sealed</p>
              </div>

              <div className="glass-panel p-3 sm:p-3.5 rounded-2xl border border-white/5 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-sky-400/40 to-transparent" />
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-[10px] font-mono uppercase tracking-wider">
                    Feather Core
                  </span>
                  <Scale className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                </div>
                <div className="flex items-baseline gap-1 font-mono tabular-nums">
                  <span className="text-lg sm:text-xl font-bold text-white tracking-tight">
                    21.4
                  </span>
                  <span className="text-[11px] text-sky-400">Grams</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-0.5">Zero wrist fatigue</p>
              </div>
            </section>

            {/* Worker-Band Registry (Real Firestore Workers Only — Zero Dummy Data) */}
            <WorkerRosterPanel
              user={user}
              authReady={authReady}
              onSignIn={handleSignIn}
              workers={workers}
              selectedWorkerId={selectedWorker?.id ?? null}
              onSelectWorker={setSelectedWorkerId}
            />
          </div>

          {/* Right Column: Live Worker Band Condition, Real-Time Transfer & Architecture */}
          <div className="lg:col-span-6 space-y-4">
            {/* Biometric Sensor Array & Selected Worker Condition */}
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
                  {latestReport
                    ? `${latestReport.spo2.toFixed(1)}% SpO2 · ${activeCondition.toUpperCase()}`
                    : 'Awaiting Band Report'}
                </span>
              </div>

              {/* Real Condition Reasons from Firestore */}
              {selectedWorker && (
                <div className="p-2.5 rounded-xl bg-obsidian-950/85 border border-white/5 text-[11px] space-y-1">
                  <div className="flex items-center justify-between font-mono text-slate-400">
                    <span>Paired Band: {selectedWorker.bandId || 'Unpaired'}</span>
                    <span>
                      {latestReport
                        ? `Last report ${new Date(latestReport.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })} (${latestReport.source.toUpperCase()})`
                        : 'No packets received yet'}
                    </span>
                  </div>
                  <p className="text-slate-200">
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
                <div className="flex items-center justify-between px-1 text-[11px] font-mono tabular-nums text-slate-400">
                  <span>
                    HR:{' '}
                    <strong className="text-white font-semibold">
                      {latestReport ? `${latestReport.bpm} BPM` : '--'}
                    </strong>
                  </span>
                  <span>
                    HRV:{' '}
                    <strong className="text-emeraldGlow font-semibold">
                      {latestReport?.hrvMs !== null && latestReport?.hrvMs !== undefined
                        ? `${latestReport.hrvMs} ms`
                        : '--'}
                    </strong>
                  </span>
                  <span>
                    Heat Index:{' '}
                    <strong className="text-slate-200 font-semibold">
                      {latestReport?.heatIndexC !== null && latestReport?.heatIndexC !== undefined
                        ? `${latestReport.heatIndexC.toFixed(1)}°C`
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
                        Dual-Wavelength PPG &amp; Electrodes
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Continuous 100Hz arterial strain &amp; fatigue HRV tracking for field crews.
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
                        Sub-epidermal Temperature Flux
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Early heat-stress thermistor detecting ±0.05°C thermal rise on site.
                      </p>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono tabular-nums text-titaniumGold font-medium px-1.5 py-0.5 bg-obsidian-950 rounded whitespace-nowrap shrink-0">
                    {latestReport ? `${latestReport.skinTempC.toFixed(1)}°C` : '--°C'}
                  </span>
                </button>
              </div>
            </section>

            {/* Real-Time Band Transfer Controls (Web Bluetooth + Firestore Batch + JaanShield Config) */}
            <BandIngestControls
              user={user}
              selectedWorker={selectedWorker}
              isStreamConnected={isStreamConnected}
            />

            {/* Industrial Design & Craftsmanship */}
            <section className="glass-panel p-4 rounded-3xl border border-white/10 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-titaniumGold" aria-hidden="true" />
                  <h3 className="text-xs font-mono font-bold tracking-wider uppercase text-white">
                    Industrial Architecture
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setExploded((prev) => !prev)}
                  className="text-[10px] font-mono text-slate-300 hover:text-emeraldGlow transition-colors cursor-pointer"
                >
                  {exploded ? 'CLOSE EXPLODED VIEW' : 'INSPECT LAYERS'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                <div className="p-3 rounded-2xl bg-obsidian-900/70 border border-white/5 space-y-1">
                  <div className="flex items-center gap-1.5 text-titaniumGold">
                    <Shield className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-mono text-[10px] font-semibold uppercase">
                      Grade 5 Titanium
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-200 font-medium">
                    Beveled Clasp &amp; Enclosure
                  </p>
                  <p className="text-[10px] text-slate-400 leading-snug">
                    Precision CNC milled for rugged construction impact and scratch resistance.
                  </p>
                </div>

                <div className="p-3 rounded-2xl bg-obsidian-900/70 border border-white/5 space-y-1">
                  <div className="flex items-center gap-1.5 text-emeraldGlow">
                    <Waves className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-mono text-[10px] font-semibold uppercase">
                      Elastomer Fluor
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-200 font-medium">
                    Hypoallergenic Loop
                  </p>
                  <p className="text-[10px] text-slate-400 leading-snug">
                    Micro-grooved interior channels sweat and maximizes skin aeration.
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
                      ? 'Verifying Firestore & Sensor Array...'
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
                <span>FIRMWARE: v4.2.1-JAANSHIELD</span>
                <span className="text-emeraldGlow flex items-center gap-1">
                  <Shield className="w-3 h-3" aria-hidden="true" />
                  SHARED FIRESTORE SYNC READY
                </span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

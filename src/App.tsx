import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BatteryCharging,
  Check,
  Droplets,
  ExternalLink,
  HeartPulse,
  Infinity as InfinityIcon,
  Layers,
  Scale,
  Share2,
  Shield,
  Thermometer,
  Waves,
} from 'lucide-react';
import { BandViewport3D } from './components/BandViewport3D';
import { DiagnosticPanel } from './components/DiagnosticPanel';
import { LiveTelemetryWave } from './components/LiveTelemetryWave';
import {
  DiagnosticCheckItem,
  FINISH_OPTIONS,
  FinishId,
  SafetyScenario,
  TelemetryReading,
} from './types/band';

const INITIAL_CHECKS: DiagnosticCheckItem[] = [
  {
    id: 'ppg',
    label: 'Dual-Wavelength PPG Array',
    detail: '530nm green + 940nm IR optical SNR lock',
    metric: '42.8 dB SNR',
    status: 'pending',
  },
  {
    id: 'spo2',
    label: 'Clinical SpO2 Calibration',
    detail: 'Arterial oxygen saturation curve alignment',
    metric: '99.4% LOCK',
    status: 'pending',
  },
  {
    id: 'thermal',
    label: 'Sub-Epidermal Thermistor',
    detail: 'Heat-stress ±0.05°C circadian drift check',
    metric: '±0.02 °C',
    status: 'pending',
  },
  {
    id: 'cipher',
    label: 'JaanShield Telemetry Link',
    detail: 'AES-256-GCM early risk alert handshake',
    metric: 'VERIFIED',
    status: 'pending',
  },
];

const SCENARIO_PRESETS: Record<
  SafetyScenario,
  {
    label: string;
    bpmRange: [number, number];
    hrvRange: [number, number];
    tempRange: [number, number];
    spo2: number;
    heatIndexC: number;
    alertSummary: string;
  }
> = {
  baseline: {
    label: 'Baseline Shift',
    bpmRange: [68, 76],
    hrvRange: [64, 74],
    tempRange: [36.6, 36.8],
    spo2: 99.4,
    heatIndexC: 31.2,
    alertSummary: 'Normal thermal & cardiovascular load',
  },
  heat_stress: {
    label: 'Heat Stress',
    bpmRange: [128, 138],
    hrvRange: [28, 35],
    tempRange: [38.2, 38.6],
    spo2: 97.6,
    heatIndexC: 42.8,
    alertSummary: 'Early heat strain alert dispatched to JaanShield',
  },
  fatigue: {
    label: 'Fatigue Risk',
    bpmRange: [94, 104],
    hrvRange: [34, 42],
    tempRange: [37.4, 37.7],
    spo2: 98.2,
    heatIndexC: 36.5,
    alertSummary: 'Elevated strain & HRV drop — break recommended',
  },
};

export default function App() {
  const [selectedFinishId, setSelectedFinishId] = useState<FinishId>('obsidian');
  const [scenario, setScenario] = useState<SafetyScenario>('baseline');
  const [isStreaming, setIsStreaming] = useState(true);
  const [exploded, setExploded] = useState(false);
  const [activeWaveMode, setActiveWaveMode] = useState<'ppg' | 'thermal'>('ppg');
  const [copiedSpec, setCopiedSpec] = useState(false);

  const [telemetry, setTelemetry] = useState<TelemetryReading>({
    bpm: 72,
    hrvMs: 68,
    spo2: 99.4,
    skinTempC: 36.7,
    perfusionIndex: 4.2,
    batteryPct: 94,
    heatIndexC: 31.2,
  });

  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [diagnosticChecks, setDiagnosticChecks] =
    useState<DiagnosticCheckItem[]>(INITIAL_CHECKS);
  const [diagnosticCompletedAt, setDiagnosticCompletedAt] = useState<string | null>(
    null,
  );

  const selectedFinish = useMemo(
    () => FINISH_OPTIONS.find((f) => f.id === selectedFinishId) ?? FINISH_OPTIONS[0],
    [selectedFinishId],
  );

  // Immediately align telemetry values when switching worker safety scenario
  const handleSelectScenario = (nextScenario: SafetyScenario) => {
    setScenario(nextScenario);
    const preset = SCENARIO_PRESETS[nextScenario];
    setTelemetry((prev) => ({
      ...prev,
      bpm: Math.round((preset.bpmRange[0] + preset.bpmRange[1]) / 2),
      hrvMs: Math.round((preset.hrvRange[0] + preset.hrvRange[1]) / 2),
      skinTempC: Number(((preset.tempRange[0] + preset.tempRange[1]) / 2).toFixed(1)),
      spo2: preset.spo2,
      heatIndexC: preset.heatIndexC,
    }));
  };

  // Subtle realistic live biometric telemetry jitter when stream is active
  useEffect(() => {
    if (!isStreaming) return;
    const preset = SCENARIO_PRESETS[scenario];
    const timer = window.setInterval(() => {
      setTelemetry((prev) => {
        const bpmDelta = Math.round((Math.random() - 0.5) * 3);
        const nextBpm = Math.min(
          preset.bpmRange[1],
          Math.max(preset.bpmRange[0], prev.bpm + bpmDelta),
        );
        const nextHrv = Math.min(
          preset.hrvRange[1],
          Math.max(preset.hrvRange[0], prev.hrvMs + Math.round((Math.random() - 0.5) * 3)),
        );
        const nextTemp = Number(
          Math.min(
            preset.tempRange[1],
            Math.max(preset.tempRange[0], prev.skinTempC + (Math.random() - 0.5) * 0.06),
          ).toFixed(2),
        );
        return {
          ...prev,
          bpm: nextBpm,
          hrvMs: nextHrv,
          skinTempC: nextTemp,
        };
      });
    }, 1600);

    return () => window.clearInterval(timer);
  }, [isStreaming, scenario]);

  const runDiagnosticSequence = useCallback(() => {
    setShowDiagnostic(true);
    setIsDiagnosing(true);
    setDiagnosticCompletedAt(null);
    setIsStreaming(true);

    const fresh = INITIAL_CHECKS.map((item, idx) => ({
      ...item,
      status: idx === 0 ? ('running' as const) : ('pending' as const),
    }));
    setDiagnosticChecks(fresh);

    const stepDelay = 520;
    INITIAL_CHECKS.forEach((_, stepIndex) => {
      window.setTimeout(() => {
        setDiagnosticChecks((prev) =>
          prev.map((item, idx) => {
            if (idx <= stepIndex) return { ...item, status: 'passed' };
            if (idx === stepIndex + 1) return { ...item, status: 'running' };
            return item;
          }),
        );

        if (stepIndex === INITIAL_CHECKS.length - 1) {
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
  }, []);

  const handleShareSpec = useCallback(async () => {
    const summary = `JaanBand Core MK-IV for JaanShield — ${selectedFinish.name} | 14-Day Endurance | 100M / 10ATM | 21.4g | ${telemetry.spo2.toFixed(1)}% SpO2 | Live BPM: ${telemetry.bpm} | https://jaan-shield.vercel.app`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(summary);
      }
    } catch {
      // Clipboard API may be restricted in preview iframes
    }
    setCopiedSpec(true);
    window.setTimeout(() => setCopiedSpec(false), 2200);
  }, [selectedFinish.name, telemetry.bpm, telemetry.spo2]);

  const activeScenarioMeta = SCENARIO_PRESETS[scenario];

  return (
    <div className="min-h-screen bg-[#040709] text-slate-100 pb-10">
      {/* Executive Top Bar */}
      <header className="sticky top-0 z-40 bg-[#040709]/92 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
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
                JaanShield Worker Safety Hardware
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setIsStreaming((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[10px] font-mono tracking-wide font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                isStreaming
                  ? 'bg-emeraldGlow/10 border-emeraldGlow/30 text-emeraldGlow'
                  : 'bg-obsidian-800 border-white/10 text-slate-400 hover:text-slate-200'
              }`}
              aria-pressed={isStreaming}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isStreaming ? 'bg-emeraldGlow animate-pulse' : 'bg-slate-500'
                }`}
              />
              <span>{isStreaming ? 'LIVE SENSOR STREAM' : 'STREAM PAUSED'}</span>
            </button>

            <a
              href="https://jaan-shield.vercel.app"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-obsidian-800 border border-white/10 text-[11px] font-medium text-slate-200 hover:text-emeraldGlow hover:border-emeraldGlow/30 transition-colors whitespace-nowrap shrink-0"
            >
              <span>JaanShield Monitor</span>
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>

            <button
              type="button"
              onClick={handleShareSpec}
              className="h-9 px-2.5 rounded-full bg-obsidian-800 border border-white/10 flex items-center justify-center gap-1.5 text-slate-300 hover:text-white hover:border-white/20 transition-colors cursor-pointer"
              aria-label="Copy specification summary"
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

      {/* Main Executive Stage */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-4 lg:pt-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 items-start">
          {/* Left Column: 3D Studio Viewport + Key Performance Metrics */}
          <div className="lg:col-span-6 space-y-4">
            <section className="relative rounded-3xl overflow-hidden glass-panel border border-white/10 shadow-2xl">
              <BandViewport3D
                finish={selectedFinish}
                bpm={telemetry.bpm}
                skinTempC={telemetry.skinTempC}
                scenario={scenario}
                isStreaming={isStreaming}
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
          </div>

          {/* Right Column: Biometric Sensor Array, Industrial Architecture & Diagnostic Deck */}
          <div className="lg:col-span-6 space-y-4">
            {/* Biometric Sensor Array Deep Dive */}
            <section className="glass-panel p-4 rounded-3xl border border-white/10 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emeraldGlow" aria-hidden="true" />
                  <h3 className="text-xs font-mono font-bold tracking-wider uppercase text-white">
                    Biometric Sensor Array
                  </h3>
                </div>
                <span className="text-[10px] font-mono tabular-nums text-emeraldGlow px-2 py-0.5 rounded bg-emeraldGlow/10 border border-emeraldGlow/20 whitespace-nowrap">
                  {telemetry.spo2.toFixed(1)}% Clinical SpO2
                </span>
              </div>

              {/* JaanShield Worksite Risk Simulation Switcher */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                  <span>JAANSHIELD WORKSITE SIMULATION</span>
                  <span
                    className={
                      scenario === 'heat_stress'
                        ? 'text-orange-400'
                        : scenario === 'fatigue'
                          ? 'text-titaniumGold'
                          : 'text-emeraldGlow'
                    }
                  >
                    Heat Index {telemetry.heatIndexC.toFixed(1)}°C
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-obsidian-950/90 border border-white/5">
                  {(Object.keys(SCENARIO_PRESETS) as SafetyScenario[]).map((key) => {
                    const isActive = scenario === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => handleSelectScenario(key)}
                        className={`px-2 py-1.5 rounded-lg text-[11px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                          isActive
                            ? key === 'heat_stress'
                              ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40'
                              : key === 'fatigue'
                                ? 'bg-titaniumGold/20 text-titaniumGold border border-titaniumGold/40'
                                : 'bg-emeraldGlow/15 text-emeraldGlow border border-emeraldGlow/35'
                            : 'text-slate-400 hover:text-slate-200 border border-transparent'
                        }`}
                      >
                        {SCENARIO_PRESETS[key].label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-400 px-1">
                  {activeScenarioMeta.alertSummary}
                </p>
              </div>

              {/* Live Waveform Strip + Telemetry Readouts */}
              <div className="space-y-2">
                <LiveTelemetryWave
                  bpm={telemetry.bpm}
                  isStreaming={isStreaming}
                  isDiagnosing={isDiagnosing}
                  mode={activeWaveMode}
                  scenario={scenario}
                />
                <div className="flex items-center justify-between px-1 text-[11px] font-mono tabular-nums text-slate-400">
                  <span>
                    HR:{' '}
                    <strong className="text-white font-semibold">{telemetry.bpm} BPM</strong>
                  </span>
                  <span>
                    HRV:{' '}
                    <strong className="text-emeraldGlow font-semibold">
                      {telemetry.hrvMs} ms
                    </strong>
                  </span>
                  <span>
                    PI:{' '}
                    <strong className="text-slate-200 font-semibold">
                      {telemetry.perfusionIndex.toFixed(1)}%
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
                    {isStreaming ? 'ACTIVE' : 'PAUSED'}
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
                    {telemetry.skinTempC.toFixed(1)}°C
                  </span>
                </button>
              </div>
            </section>

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

            {/* Optional Live Diagnostic Panel */}
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
                      ? 'Calibrating Biometric Array...'
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
                  ENCRYPTED VIA JAAN-CIPHER
                </span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

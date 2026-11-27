import { useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertOctagon,
  Bluetooth,
  BluetoothOff,
  Check,
  Code2,
  Copy,
  Radio,
  Send,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { firebaseConfig } from '../firebase';
import {
  KEEP_ALIVE_TIMEOUT_SECONDS,
  getKeepAliveStatus,
  recordKeepAliveHeartbeat,
  recordTelemetryReport,
  updateWorkerHealthProfile,
} from '../services/jaanshieldFirestore';
import {
  DUTY_ZONE_OPTIONS,
  DutyZone,
  GaitBalanceStatus,
  WorkerReadiness,
  WorkerRecord,
} from '../types/band';

interface BandIngestControlsProps {
  user: User | null;
  selectedWorker: WorkerRecord | null;
  isStreamConnected: boolean;
  nowMs: number;
}

interface BleNavigator extends Navigator {
  bluetooth?: {
    requestDevice(options: {
      filters?: Array<{ services: Array<number | string> }>;
      optionalServices?: Array<number | string>;
    }): Promise<BleDevice>;
  };
}

interface BleDevice {
  name?: string;
  gatt?: {
    connect(): Promise<BleServer>;
    disconnect(): void;
  };
  addEventListener(type: string, listener: () => void): void;
}

interface BleServer {
  getPrimaryService(service: number | string): Promise<BleService>;
}

interface BleService {
  getCharacteristic(char: number | string): Promise<BleCharacteristic>;
}

interface BleCharacteristic {
  startNotifications(): Promise<BleCharacteristic>;
  readValue(): Promise<DataView>;
  addEventListener(
    type: string,
    listener: (ev: { target: { value: DataView } }) => void,
  ): void;
}

function parseHeartRateMeasurement(value: DataView): number {
  const flags = value.getUint8(0);
  const is16Bit = (flags & 0x01) !== 0;
  return is16Bit ? value.getUint16(1, true) : value.getUint8(1);
}

export function BandIngestControls({
  user,
  selectedWorker,
  isStreamConnected,
  nowMs,
}: BandIngestControlsProps) {
  const [bleStatus, setBleStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [bleDeviceName, setBleDeviceName] = useState<string | null>(null);
  const [bleError, setBleError] = useState<string | null>(null);
  const bleDeviceRef = useRef<BleDevice | null>(null);

  // Biometric & Tier 2 Hangover / Shift / Perfusion / Battery inputs
  const [bpmInput, setBpmInput] = useState('78');
  const [spo2Input, setSpo2Input] = useState('98.5');
  const [tempInput, setTempInput] = useState('35.2');
  const [heatIndexInput, setHeatIndexInput] = useState('31.0');
  const [hrvInput, setHrvInput] = useState('62');
  const [perfusionInput, setPerfusionInput] = useState('2.4');
  const [batteryInput, setBatteryInput] = useState('88');
  const [shiftHoursInput, setShiftHoursInput] = useState('1.5');
  const [startHrInput, setStartHrInput] = useState('74');
  const [hrrDropInput, setHrrDropInput] = useState('18');
  const [tremorHzInput, setTremorHzInput] = useState('0');
  const [breakInput, setBreakInput] = useState('45');

  // Breath Alcohol Screening & Morning Gait/Readiness state
  const [breathChannel, setBreathChannel] = useState<'band-mems' | 'gate-mq3'>('band-mems');
  const [mq3Input, setMq3Input] = useState('0.00');
  const [sending, setSending] = useState(false);
  const [kaBusy, setKaBusy] = useState(false);
  const [mq3Busy, setMq3Busy] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<string | null>(null);

  const [showApiBridge, setShowApiBridge] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const keepAlive = getKeepAliveStatus(selectedWorker, nowMs);

  const handleConnectBle = async () => {
    if (!selectedWorker || !user) return;
    setBleError(null);
    const nav = navigator as BleNavigator;
    if (!nav.bluetooth) {
      setBleStatus('error');
      setBleError(
        'Web Bluetooth is unavailable in this browser. Use Chrome/Edge over HTTPS or transmit readings below.',
      );
      return;
    }

    setBleStatus('connecting');
    try {
      const device = await nav.bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }],
        optionalServices: ['health_thermometer', 'battery_service'],
      });
      bleDeviceRef.current = device;
      setBleDeviceName(device.name || selectedWorker.bandId || 'BLE Sensor');

      device.addEventListener('gattserverdisconnected', () => {
        setBleStatus('idle');
        setBleDeviceName(null);
        void recordKeepAliveHeartbeat(selectedWorker, true).catch(() => {});
      });

      const server = await device.gatt?.connect();
      if (!server) throw new Error('Could not open GATT server');

      let latestBattery: number | undefined;
      try {
        const battSvc = await server.getPrimaryService('battery_service');
        const battChar = await battSvc.getCharacteristic('battery_level');
        const battView = await battChar.readValue();
        latestBattery = battView.getUint8(0);
      } catch {
        // Battery service optional
      }

      const hrService = await server.getPrimaryService('heart_rate');
      const hrChar = await hrService.getCharacteristic('heart_rate_measurement');
      await hrChar.startNotifications();

      setBleStatus('connected');

      hrChar.addEventListener('characteristicvaluechanged', (ev) => {
        const measuredBpm = parseHeartRateMeasurement(ev.target.value);
        const fallbackTemp =
          selectedWorker.lastReport?.skinTempC ?? Number(tempInput || 35.0);
        const fallbackSpo2 =
          selectedWorker.lastReport?.spo2 ?? Number(spo2Input || 98.0);

        void recordTelemetryReport(user, selectedWorker, {
          bandId: selectedWorker.bandId || `JB-MK4-${selectedWorker.id}`,
          bpm: measuredBpm,
          spo2: fallbackSpo2,
          skinTempC: fallbackTemp,
          batteryPct: latestBattery,
          leadOff: false,
          source: 'ble',
        }).catch(() => {
          // Non-fatal single packet skip
        });
      });
    } catch (err) {
      setBleStatus('error');
      setBleError(
        err instanceof Error ? err.message : 'Bluetooth pairing cancelled or failed',
      );
    }
  };

  const handleDisconnectBle = () => {
    bleDeviceRef.current?.gatt?.disconnect();
    bleDeviceRef.current = null;
    setBleStatus('idle');
    setBleDeviceName(null);
  };

  const handleSendKeepAlive = async (leadOff: boolean) => {
    if (!selectedWorker || !user) return;
    setKaBusy(true);
    setSendFeedback(null);
    try {
      await recordKeepAliveHeartbeat(selectedWorker, leadOff);
      setSendFeedback(
        leadOff
          ? `Lead-Off / Mechanical Failure flagged for ${selectedWorker.id}`
          : `15s Keep-Alive packet verified for ${selectedWorker.id}`,
      );
      window.setTimeout(() => setSendFeedback(null), 2600);
    } catch (err) {
      setSendFeedback(err instanceof Error ? err.message : 'Keep-Alive update failed');
    } finally {
      setKaBusy(false);
    }
  };

  const handleMq3GateCheck = async (status: 'clear' | 'flagged') => {
    if (!selectedWorker || !user) return;
    setMq3Busy(true);
    setSendFeedback(null);
    try {
      const mgL = Number(mq3Input || (status === 'flagged' ? '0.45' : '0.00'));
      await updateWorkerHealthProfile(selectedWorker, {
        mq3Status: status,
        mq3MgL: Number.isFinite(mgL) ? mgL : status === 'flagged' ? 0.45 : 0,
      });
      const sourceLabel =
        breathChannel === 'band-mems' ? 'On-Band ePTFE MEMS Vent' : 'Morning Gate MQ-3';
      setSendFeedback(
        status === 'flagged'
          ? `${sourceLabel} Flagged (${mgL.toFixed(2)} mg/L): High Dehydration / Impairment Risk`
          : `${sourceLabel} Cleared for ${selectedWorker.id}${
              breathChannel === 'band-mems' ? ' (Heater asleep · 0 mA)' : ''
            }`,
      );
      window.setTimeout(() => setSendFeedback(null), 3200);
    } catch (err) {
      setSendFeedback(err instanceof Error ? err.message : 'Breath screening update failed');
    } finally {
      setMq3Busy(false);
    }
  };

  const handleQuickFitUpdate = async (
    patch: {
      gaitBalance?: GaitBalanceStatus;
      dutyZone?: DutyZone;
      readiness?: WorkerReadiness;
    },
    label: string,
  ) => {
    if (!selectedWorker || !user) return;
    setGateBusy(true);
    setSendFeedback(null);
    try {
      await updateWorkerHealthProfile(selectedWorker, patch);
      setSendFeedback(`${label} updated for ${selectedWorker.id}`);
      window.setTimeout(() => setSendFeedback(null), 2600);
    } catch (err) {
      setSendFeedback(err instanceof Error ? err.message : 'Gate check update failed');
    } finally {
      setGateBusy(false);
    }
  };

  const handleManualDispatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWorker || !user) return;
    setSending(true);
    setSendFeedback(null);
    try {
      await recordTelemetryReport(user, selectedWorker, {
        bandId: selectedWorker.bandId || `JB-MK4-${selectedWorker.id}`,
        bpm: Number(bpmInput),
        spo2: Number(spo2Input),
        skinTempC: Number(tempInput),
        heatIndexC: Number(heatIndexInput),
        hrvMs: Number(hrvInput),
        perfusionIndex: perfusionInput.trim() ? Number(perfusionInput) : null,
        batteryPct: batteryInput.trim() ? Number(batteryInput) : null,
        shiftHours: Number(shiftHoursInput),
        shiftStartHr: startHrInput.trim() ? Number(startHrInput) : null,
        hrrBpmDrop: hrrDropInput.trim() ? Number(hrrDropInput) : null,
        tremorHz: tremorHzInput.trim() ? Number(tremorHzInput) : null,
        minutesSinceBreak: Number(breakInput),
        leadOff: false,
        source: 'manual',
      });
      setSendFeedback(`Synced live report + Fit-to-Work for ${selectedWorker.id}`);
      window.setTimeout(() => setSendFeedback(null), 2600);
    } catch (err) {
      setSendFeedback(err instanceof Error ? err.message : 'Failed to sync report');
    } finally {
      setSending(false);
    }
  };

  const integrationSnippet = `// Shared Firebase Firestore + Fit-to-Work bridge for https://jaan-shield.vercel.app
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { collection, getFirestore, onSnapshot, query, where } from "firebase/firestore";

const firebaseConfig = ${JSON.stringify(
    {
      projectId: firebaseConfig.projectId,
      appId: firebaseConfig.appId,
      apiKey: firebaseConfig.apiKey,
      authDomain: firebaseConfig.authDomain,
      firestoreDatabaseId: firebaseConfig.firestoreDatabaseId,
      storageBucket: firebaseConfig.storageBucket,
      messagingSenderId: firebaseConfig.messagingSenderId,
    },
    null,
    2,
  )};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// JaanShield Fit-to-Work Fallback Evaluator (matches JaanBand MK-IV rules)
export function resolveFitToWork(w) {
  if (w.fitStatus) return { status: w.fitStatus, reasons: w.fitReasons || [] };
  const [sys = 120, dia = 80] = String(w.restingBp || "120/80").split("/").map(Number);
  const r = w.readiness || {};
  const rep = w.lastReport || null;
  if (w.leadOff || sys >= 160 || dia >= 100 || r.dizzyOrUnwell || (rep && rep.skinTempC >= 37.3) || w.condition === "critical") {
    return { status: "medical_hold", reasons: w.reasons || ["Medical Hold"] };
  }
  if (w.mq3Status === "flagged" || w.gaitBalance === "sway" || (w.daysOnSite ?? 14) < 7 || r.lowSleep || r.sedatingMeds || (rep?.perfusionIndex ?? 2) < 0.8 || (rep?.batteryPct ?? 100) < 15 || w.condition === "caution") {
    return { status: "shaded_only", reasons: w.reasons || ["Shaded Ground Duty Only"] };
  }
  return { status: "fit_full", reasons: ["Cleared for Full Duty"] };
}

// Stream workers with dynamic Rf, Fit-to-Work (BP, acclimatization, gait, readiness, PI, battery) & 15s keep-alive
const q = query(collection(db, "workers"), where("ownerUid", "==", auth.currentUser.uid));
onSnapshot(q, (snap) => {
  const workers = snap.docs.map((d) => {
    const data = d.data();
    return { ...data, clearance: resolveFitToWork(data) };
  });
  console.log("Live JaanShield Fit-to-Work sync:", workers);
});`;

  const handleCopySnippet = async () => {
    try {
      await navigator.clipboard.writeText(integrationSnippet);
      setCopiedSnippet(true);
      window.setTimeout(() => setCopiedSnippet(false), 2000);
    } catch {
      // Clipboard blocked in restricted iframe
    }
  };

  return (
    <section className="glass-panel p-4 rounded-3xl border border-white/10 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Radio
            className={`w-4 h-4 ${isStreamConnected ? 'text-emeraldGlow' : 'text-slate-400'}`}
            aria-hidden="true"
          />
          <h3 className="text-xs font-mono font-bold tracking-wider uppercase text-white">
            Hardware Failsafe, MQ-3 Gate &amp; Ingest
          </h3>
        </div>

        <button
          type="button"
          onClick={() => setShowApiBridge((v) => !v)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-obsidian-800 border border-white/10 text-[11px] font-mono text-slate-200 hover:border-emeraldGlow/40 transition-colors cursor-pointer"
        >
          <Code2 className="w-3.5 h-3.5 text-emeraldGlow" aria-hidden="true" />
          <span>{showApiBridge ? 'Hide Sync Config' : 'JaanShield Sync'}</span>
        </button>
      </div>

      {/* 15-Second Keep-Alive Failsafe & Optical Lead-Off Monitor */}
      {user && selectedWorker && (
        <div
          className={`p-3 rounded-2xl border space-y-2 ${
            keepAlive.state === 'disconnected'
              ? 'bg-orange-950/35 border-orange-500/45'
              : 'bg-obsidian-900/80 border-white/5'
          }`}
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              {keepAlive.state === 'disconnected' ? (
                <WifiOff className="w-4 h-4 text-orange-400 shrink-0" />
              ) : (
                <Wifi
                  className={`w-4 h-4 shrink-0 ${
                    keepAlive.state === 'alive' ? 'text-emeraldGlow' : 'text-slate-400'
                  }`}
                />
              )}
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white truncate">
                  15s Keep-Alive Watchdog ({selectedWorker.id})
                </p>
                <p
                  className={`text-[11px] font-mono tabular-nums truncate ${
                    keepAlive.state === 'disconnected'
                      ? 'text-orange-300'
                      : keepAlive.state === 'alive'
                        ? 'text-emeraldGlow'
                        : 'text-slate-400'
                  }`}
                >
                  {keepAlive.state === 'alive'
                    ? `OK · ${keepAlive.secondsRemaining}s remaining before failsafe (${KEEP_ALIVE_TIMEOUT_SECONDS}s window)`
                    : keepAlive.reason}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                disabled={kaBusy}
                onClick={() => handleSendKeepAlive(false)}
                className="px-2.5 py-1.5 rounded-xl bg-emeraldGlow/15 border border-emeraldGlow/35 text-emeraldGlow text-[11px] font-mono font-semibold hover:bg-emeraldGlow/20 cursor-pointer"
              >
                Ping Keep-Alive
              </button>
              <button
                type="button"
                disabled={kaBusy}
                onClick={() => handleSendKeepAlive(true)}
                className="px-2.5 py-1.5 rounded-xl bg-orange-500/15 border border-orange-500/35 text-orange-300 text-[11px] font-mono font-semibold hover:bg-orange-500/20 cursor-pointer"
              >
                Lead-Off Break
              </button>
            </div>
          </div>
        </div>
      )}

      {/* On-Band Pulsed MEMS ePTFE Breath Vent & Morning Gate Screening */}
      {user && selectedWorker && (
        <div className="p-3 rounded-2xl bg-obsidian-900/75 border border-white/5 space-y-2.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              {selectedWorker.mq3Status === 'flagged' ? (
                <ShieldAlert className="w-4 h-4 text-orange-400" />
              ) : (
                <ShieldCheck className="w-4 h-4 text-emeraldGlow" />
              )}
              <div>
                <p className="text-xs font-semibold text-slate-100">
                  Breath Alcohol Check · Band ePTFE Vent / Gate MQ-3
                </p>
                <p className="text-[11px] text-slate-400">
                  {selectedWorker.mq3Status === 'flagged'
                    ? 'FLAGGED: High Dehydration / Impairment Risk — Reassign to shaded task'
                    : selectedWorker.mq3Status === 'clear'
                      ? `CLEARED (${selectedWorker.mq3MgL?.toFixed(2) ?? '0.00'} mg/L)`
                      : breathChannel === 'band-mems'
                        ? 'Hold puck button & blow over side ePTFE vent (10s pulsed wake, 0 mA during shift)'
                        : 'Pending 2-second morning attendance kiosk blow check'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-obsidian-950 border border-white/10">
              <button
                type="button"
                onClick={() => setBreathChannel('band-mems')}
                className={`px-2 py-1 rounded-md text-[10px] font-mono whitespace-nowrap cursor-pointer transition-colors ${
                  breathChannel === 'band-mems'
                    ? 'bg-emeraldGlow/15 text-emeraldGlow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Band Breath Vent
              </button>
              <button
                type="button"
                onClick={() => setBreathChannel('gate-mq3')}
                className={`px-2 py-1 rounded-md text-[10px] font-mono whitespace-nowrap cursor-pointer transition-colors ${
                  breathChannel === 'gate-mq3'
                    ? 'bg-sky-500/15 text-sky-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Gate MQ-3
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[10px] font-mono text-slate-400">
              {breathChannel === 'band-mems'
                ? 'Pulsed MEMS VOC/Ethanol Die behind IP67 hydrophobic membrane'
                : 'Shared ₹150 MQ-3 attendance gate sensor'}
            </span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                step="0.01"
                min={0}
                max={2.5}
                value={mq3Input}
                onChange={(e) => setMq3Input(e.target.value)}
                aria-label="Breath alcohol mg/L"
                className="w-16 px-2 py-1 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white"
              />
              <span className="text-[10px] font-mono text-slate-400">mg/L</span>
              <button
                type="button"
                disabled={mq3Busy}
                onClick={() => {
                  setMq3Input('0.00');
                  void handleMq3GateCheck('clear');
                }}
                className="px-2.5 py-1 rounded-lg bg-emeraldGlow/15 border border-emeraldGlow/35 text-emeraldGlow text-[11px] font-mono cursor-pointer whitespace-nowrap"
              >
                Pass
              </button>
              <button
                type="button"
                disabled={mq3Busy}
                onClick={() => {
                  if (Number(mq3Input) < 0.2) setMq3Input('0.42');
                  void handleMq3GateCheck('flagged');
                }}
                className="px-2.5 py-1 rounded-lg bg-orange-500/15 border border-orange-500/40 text-orange-300 text-[11px] font-mono cursor-pointer whitespace-nowrap"
              >
                Flag
              </button>
            </div>
          </div>

          {selectedWorker.mq3Status === 'flagged' && (
            <div className="px-2.5 py-1.5 rounded-xl bg-orange-500/10 border border-orange-500/30 flex items-center gap-2 text-[11px] text-orange-200">
              <AlertOctagon className="w-3.5 h-3.5 text-orange-400 shrink-0" />
              <span>
                Supervisor Action: Keep off scaffolding &amp; 44°C radiant sun; assign shaded low-intensity duty.
              </span>
            </div>
          )}

          {/* Morning Fit-to-Work Gate: 5s IMU Balance, Duty Zone & Readiness */}
          <div className="pt-2 border-t border-white/5 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[10px] font-mono uppercase tracking-wider text-slate-300">
                Fit-to-Work Gate · 5s Gait IMU &amp; Readiness
              </span>
              <div className="flex items-center gap-1">
                {(['stable', 'sway'] as const).map((gState) => {
                  const active = selectedWorker.gaitBalance === gState;
                  return (
                    <button
                      key={gState}
                      type="button"
                      disabled={gateBusy}
                      onClick={() =>
                        void handleQuickFitUpdate(
                          { gaitBalance: gState },
                          `5s Gait (${gState})`,
                        )
                      }
                      className={`px-2 py-0.5 rounded-md text-[10px] font-mono border cursor-pointer transition-colors ${
                        active
                          ? gState === 'sway'
                            ? 'bg-orange-500/20 border-orange-500/45 text-orange-300'
                            : 'bg-emeraldGlow/15 border-emeraldGlow/40 text-emeraldGlow'
                          : 'bg-obsidian-950 border-white/10 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {gState === 'stable' ? 'Gait Stable' : 'Gait Sway'}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1">
                {DUTY_ZONE_OPTIONS.map((z) => {
                  const active = selectedWorker.dutyZone === z.id;
                  return (
                    <button
                      key={z.id}
                      type="button"
                      disabled={gateBusy}
                      onClick={() =>
                        void handleQuickFitUpdate(
                          { dutyZone: z.id },
                          `Zone ${z.shortLabel}`,
                        )
                      }
                      className={`px-2 py-0.5 rounded-md text-[10px] font-mono border cursor-pointer transition-colors ${
                        active
                          ? 'bg-sky-500/20 border-sky-400/45 text-sky-200'
                          : 'bg-obsidian-950 border-white/10 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {z.shortLabel}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-2 text-[10px] font-mono">
                <button
                  type="button"
                  disabled={gateBusy}
                  onClick={() =>
                    void handleQuickFitUpdate(
                      {
                        readiness: {
                          ...selectedWorker.readiness,
                          lowSleep: !selectedWorker.readiness.lowSleep,
                        },
                      },
                      'Sleep flag',
                    )
                  }
                  className={`px-2 py-0.5 rounded-md border cursor-pointer ${
                    selectedWorker.readiness.lowSleep
                      ? 'bg-titaniumGold/20 border-titaniumGold/50 text-titaniumGold'
                      : 'bg-obsidian-950 border-white/10 text-slate-400'
                  }`}
                >
                  &lt;5h Sleep
                </button>
                <button
                  type="button"
                  disabled={gateBusy}
                  onClick={() =>
                    void handleQuickFitUpdate(
                      {
                        readiness: {
                          ...selectedWorker.readiness,
                          sedatingMeds: !selectedWorker.readiness.sedatingMeds,
                        },
                      },
                      'Sedating meds',
                    )
                  }
                  className={`px-2 py-0.5 rounded-md border cursor-pointer ${
                    selectedWorker.readiness.sedatingMeds
                      ? 'bg-titaniumGold/20 border-titaniumGold/50 text-titaniumGold'
                      : 'bg-obsidian-950 border-white/10 text-slate-400'
                  }`}
                >
                  Drowsy Meds
                </button>
                <button
                  type="button"
                  disabled={gateBusy}
                  onClick={() =>
                    void handleQuickFitUpdate(
                      {
                        readiness: {
                          ...selectedWorker.readiness,
                          dizzyOrUnwell: !selectedWorker.readiness.dizzyOrUnwell,
                        },
                      },
                      'Dizziness flag',
                    )
                  }
                  className={`px-2 py-0.5 rounded-md border cursor-pointer ${
                    selectedWorker.readiness.dizzyOrUnwell
                      ? 'bg-orange-500/20 border-orange-500/50 text-orange-300'
                      : 'bg-obsidian-950 border-white/10 text-slate-400'
                  }`}
                >
                  Dizzy
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Physical BLE Hardware Connection */}
      <div className="p-3 rounded-2xl bg-obsidian-900/80 border border-white/5 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-200">
            {bleStatus === 'connected'
              ? `BLE Connected: ${bleDeviceName}`
              : 'Web Bluetooth Band Link (GATT 0x180D)'}
          </p>
          <p className="text-[11px] text-slate-400 truncate">
            {!user
              ? 'Sign in above to stream physical BLE band packets into Firestore'
              : selectedWorker
                ? `Streams live wrist heart-rate directly to ${selectedWorker.id} (${selectedWorker.bandId || 'unpaired'})`
                : 'Register and select a worker first to stream physical BLE band data'}
          </p>
        </div>

        {bleStatus === 'connected' ? (
          <button
            type="button"
            onClick={handleDisconnectBle}
            className="px-3 py-1.5 rounded-xl bg-orange-500/15 border border-orange-500/35 text-orange-300 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <BluetoothOff className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Disconnect BLE</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={!user || !selectedWorker || bleStatus === 'connecting'}
            onClick={handleConnectBle}
            className="px-3 py-1.5 rounded-xl bg-sky-500/15 border border-sky-400/35 text-sky-300 text-xs font-semibold inline-flex items-center gap-1.5 hover:bg-sky-500/20 disabled:opacity-50 cursor-pointer"
          >
            <Bluetooth className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{bleStatus === 'connecting' ? 'Pairing...' : 'Pair Hardware BLE'}</span>
          </button>
        )}
      </div>

      {bleError && (
        <p className="text-[11px] text-orange-300 bg-orange-500/10 border border-orange-500/20 rounded-xl px-3 py-2">
          {bleError}
        </p>
      )}

      {/* Direct Telemetry Report + Tier 2 Hangover/HRV Dispatch Form */}
      {user && selectedWorker && (
        <form
          onSubmit={handleManualDispatch}
          className="p-3 rounded-2xl bg-obsidian-900/70 border border-white/5 space-y-2.5"
        >
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-mono text-slate-300">
              Transmit Telemetry → <strong className="text-white">{selectedWorker.name}</strong> (
              {selectedWorker.mountMode.toUpperCase()})
            </span>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">BPM</span>
              <input
                type="number"
                min={25}
                max={240}
                required
                value={bpmInput}
                onChange={(e) => setBpmInput(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">SpO2 %</span>
              <input
                type="number"
                step="0.1"
                min={50}
                max={100}
                required
                value={spo2Input}
                onChange={(e) => setSpo2Input(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">Skin °C</span>
              <input
                type="number"
                step="0.1"
                min={25}
                max={45}
                required
                value={tempInput}
                onChange={(e) => setTempInput(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">Heat °C</span>
              <input
                type="number"
                step="0.1"
                min={-20}
                max={75}
                value={heatIndexInput}
                onChange={(e) => setHeatIndexInput(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">HRV ms</span>
              <input
                type="number"
                min={0}
                max={300}
                value={hrvInput}
                onChange={(e) => setHrvInput(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">Perf %</span>
              <input
                type="number"
                step="0.1"
                min={0}
                max={25}
                value={perfusionInput}
                onChange={(e) => setPerfusionInput(e.target.value)}
                title="Perfusion Index % (<0.8% flags dehydration/vasoconstriction)"
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>

            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">Shift Hrs</span>
              <input
                type="number"
                step="0.5"
                min={0}
                max={24}
                value={shiftHoursInput}
                onChange={(e) => setShiftHoursInput(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">8AM HR</span>
              <input
                type="number"
                min={30}
                max={200}
                value={startHrInput}
                onChange={(e) => setStartHrInput(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">5m HRR</span>
              <input
                type="number"
                min={0}
                max={80}
                value={hrrDropInput}
                onChange={(e) => setHrrDropInput(e.target.value)}
                title="5-minute break heart rate recovery drop (BPM)"
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">Tremor Hz</span>
              <input
                type="number"
                step="0.5"
                min={0}
                max={30}
                value={tremorHzInput}
                onChange={(e) => setTremorHzInput(e.target.value)}
                title="6-12 Hz flags withdrawal micro-tremors"
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">Work min</span>
              <input
                type="number"
                min={0}
                max={1440}
                value={breakInput}
                onChange={(e) => setBreakInput(e.target.value)}
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[10px] font-mono text-slate-400">Batt %</span>
              <input
                type="number"
                min={0}
                max={100}
                value={batteryInput}
                onChange={(e) => setBatteryInput(e.target.value)}
                title="<15% flags swap from 10% buffer"
                className="w-full px-2 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
              />
            </label>
          </div>

          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span className="text-[11px] font-mono text-emeraldGlow">
              {sendFeedback || ''}
            </span>
            <button
              type="submit"
              disabled={sending}
              className="px-3.5 py-1.5 rounded-xl bg-emeraldGlow text-obsidian-950 font-semibold text-xs inline-flex items-center gap-1.5 hover:brightness-105 disabled:opacity-60 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{sending ? 'Syncing...' : 'Transmit Band Report'}</span>
            </button>
          </div>
        </form>
      )}

      {/* Shared Firestore Integration Guide for JaanShield on Vercel */}
      {showApiBridge && (
        <div className="p-3 rounded-2xl bg-obsidian-950 border border-white/10 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-mono text-titaniumGold">
              Shared Firestore Sync ({firebaseConfig.projectId})
            </span>
            <button
              type="button"
              onClick={handleCopySnippet}
              className="inline-flex items-center gap-1 text-[11px] font-mono text-emeraldGlow hover:underline cursor-pointer"
            >
              {copiedSnippet ? (
                <>
                  <Check className="w-3 h-3" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>Copy JS</span>
                </>
              )}
            </button>
          </div>
          <pre className="text-[10px] leading-relaxed font-mono text-slate-300 overflow-x-auto p-2.5 rounded-xl bg-obsidian-900 border border-white/5">
            {integrationSnippet}
          </pre>
        </div>
      )}
    </section>
  );
}

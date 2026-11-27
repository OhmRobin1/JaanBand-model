import { useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Bluetooth,
  BluetoothOff,
  Check,
  Code2,
  Copy,
  Radio,
  Send,
} from 'lucide-react';
import { firebaseConfig } from '../firebase';
import { recordTelemetryReport } from '../services/jaanshieldFirestore';
import { WorkerRecord } from '../types/band';

interface BandIngestControlsProps {
  user: User | null;
  selectedWorker: WorkerRecord | null;
  isStreamConnected: boolean;
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
}: BandIngestControlsProps) {
  const [bleStatus, setBleStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [bleDeviceName, setBleDeviceName] = useState<string | null>(null);
  const [bleError, setBleError] = useState<string | null>(null);
  const bleDeviceRef = useRef<BleDevice | null>(null);

  const [bpmInput, setBpmInput] = useState('78');
  const [spo2Input, setSpo2Input] = useState('98.5');
  const [tempInput, setTempInput] = useState('35.2');
  const [heatIndexInput, setHeatIndexInput] = useState('31.0');
  const [hrvInput, setHrvInput] = useState('62');
  const [breakInput, setBreakInput] = useState('45');
  const [sending, setSending] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<string | null>(null);

  const [showApiBridge, setShowApiBridge] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

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
        minutesSinceBreak: Number(breakInput),
        source: 'manual',
      });
      setSendFeedback(`Synced live report for ${selectedWorker.id} to Firestore`);
      window.setTimeout(() => setSendFeedback(null), 2600);
    } catch (err) {
      setSendFeedback(err instanceof Error ? err.message : 'Failed to sync report');
    } finally {
      setSending(false);
    }
  };

  const integrationSnippet = `// Shared Firebase Firestore bridge for https://jaan-shield.vercel.app
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
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

// Sign in with your operator Google account, then stream all paired workers live:
const q = query(collection(db, "workers"), where("ownerUid", "==", auth.currentUser.uid));
onSnapshot(q, (snap) => {
  const workers = snap.docs.map((d) => d.data());
  // Each worker includes bandId, condition, reasons, and lastReport (bpm, spo2, skinTempC)
  console.log("Live JaanBand sync:", workers);
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
            Real-Time Band Transfer
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

      {/* Direct Telemetry Report Dispatch Form (Zero Dummy Data) */}
      {user && selectedWorker && (
        <form
          onSubmit={handleManualDispatch}
          className="p-3 rounded-2xl bg-obsidian-900/70 border border-white/5 space-y-2.5"
        >
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-mono text-slate-300">
              Transmit Report → <strong className="text-white">{selectedWorker.name}</strong> (
              {selectedWorker.bandId || selectedWorker.id})
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

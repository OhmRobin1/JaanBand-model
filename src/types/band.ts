export type FinishId = 'obsidian' | 'titanium' | 'gold';

export type CameraPreset = 'hero' | 'sensor' | 'clasp' | 'profile';

export interface FinishOption {
  id: FinishId;
  name: string;
  shortName: string;
  bandColor: number;
  bandRoughness: number;
  bandMetalness: number;
  chassisColor: number;
  chassisRoughness: number;
  chassisMetalness: number;
  claspColor: number;
  claspRoughness: number;
  claspMetalness: number;
  swatchClass: string;
  accentHex: string;
}

export const FINISH_OPTIONS: FinishOption[] = [
  {
    id: 'obsidian',
    name: 'Obsidian Noir / Fluro-Polymer',
    shortName: 'Obsidian Noir',
    bandColor: 0x171a1d,
    bandRoughness: 0.44,
    bandMetalness: 0.08,
    chassisColor: 0x0b0e12,
    chassisRoughness: 0.2,
    chassisMetalness: 0.84,
    claspColor: 0xd4af37,
    claspRoughness: 0.22,
    claspMetalness: 0.88,
    swatchClass: 'bg-[#171a1d]',
    accentHex: '#00e599',
  },
  {
    id: 'titanium',
    name: 'Brushed Aerospace Titanium',
    shortName: 'Aerospace Ti',
    bandColor: 0x2a313b,
    bandRoughness: 0.36,
    bandMetalness: 0.24,
    chassisColor: 0x9aa4b2,
    chassisRoughness: 0.18,
    chassisMetalness: 0.94,
    claspColor: 0xcbd5e1,
    claspRoughness: 0.16,
    claspMetalness: 0.95,
    swatchClass: 'bg-gradient-to-tr from-slate-500 to-slate-200',
    accentHex: '#38bdf8',
  },
  {
    id: 'gold',
    name: '18K Champagne Titanium Gold',
    shortName: 'Champagne Gold',
    bandColor: 0x1e1c18,
    bandRoughness: 0.4,
    bandMetalness: 0.14,
    chassisColor: 0xd8a83a,
    chassisRoughness: 0.18,
    chassisMetalness: 0.92,
    claspColor: 0xe3a72f,
    claspRoughness: 0.18,
    claspMetalness: 0.94,
    swatchClass: 'bg-gradient-to-tr from-[#d4af37] to-[#f3e5ab]',
    accentHex: '#e3a72f',
  },
];

export type ConditionLevel = 'unlinked' | 'normal' | 'caution' | 'critical';

export type TelemetrySource = 'ble' | 'api' | 'manual';

export interface ThresholdConfig {
  hrY: number;
  hrR: number;
  spY: number;
  spR: number;
  tY: number;
  tR: number;
  hiY: number;
  hiR: number;
  brk: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  hrY: 115,
  hrR: 140,
  spY: 94,
  spR: 90,
  tY: 35.5,
  tR: 37.0,
  hiY: 32.0,
  hiR: 41.0,
  brk: 150,
};

export interface TelemetryReport {
  id: string;
  workerId: string;
  bandId: string;
  bpm: number;
  spo2: number;
  skinTempC: number;
  hrvMs: number | null;
  heatIndexC: number | null;
  perfusionIndex: number | null;
  batteryPct: number | null;
  minutesSinceBreak: number;
  condition: Exclude<ConditionLevel, 'unlinked'>;
  reasons: string[];
  source: TelemetrySource;
  timestamp: string;
}

export interface WorkerRecord {
  id: string;
  name: string;
  role: string;
  bandId: string;
  baselineHr: number;
  loadFactor: number;
  condition: ConditionLevel;
  reasons: string[];
  lastReport: TelemetryReport | null;
  history?: TelemetryReport[];
  ownerUid?: string;
  updatedAt: string;
}

export interface DiagnosticCheckItem {
  id: string;
  label: string;
  detail: string;
  metric: string;
  status: 'pending' | 'running' | 'passed';
}

export type FinishId = 'obsidian' | 'titanium' | 'gold';

export type CameraPreset = 'hero' | 'sensor' | 'breath' | 'clasp' | 'profile';

export type MountMode = 'wrist' | 'bicep' | 'helmet';

export type Mq3Status = 'pending' | 'clear' | 'flagged';

export type DutyZone = 'height' | 'heavy_sun' | 'shaded';

export type GaitBalanceStatus = 'pending' | 'stable' | 'sway';

export type FitToWorkStatus = 'fit_full' | 'shaded_only' | 'medical_hold';

export type MentalStrainLevel = 'calm' | 'mild' | 'strained' | 'rest_advised';

export type BuddyMood = 'warm' | 'listening' | 'encouraging' | 'caring' | 'alert';

export interface WorkerPrivateCheckin {
  id: string;
  workerUid: string;
  workerId: string;
  languageCode: string;
  languageName: string;
  workerMessage: string;
  buddyReply: string;
  buddyMood: BuddyMood;
  mentalStrainLevel: MentalStrainLevel;
  mentalRfBoost: number;
  gentleCareTip: string;
  syncedToBand: boolean;
  createdAt: string;
}

export interface WorkerPrivateVault {
  workerUid: string;
  workerId: string;
  preferredLanguageCode: string;
  preferredState: string;
  lastMentalStrainLevel: MentalStrainLevel;
  lastMentalRfBoost: number;
  updatedAt: string;
}

export interface DutyZoneOption {
  id: DutyZone;
  label: string;
  shortLabel: string;
  spec: string;
}

export const DUTY_ZONE_OPTIONS: DutyZoneOption[] = [
  {
    id: 'height',
    label: 'Height / Scaffolding / Confined',
    shortLabel: 'Height',
    spec: 'Zero tolerance for tremors, sway, low sleep, or sedating meds',
  },
  {
    id: 'heavy_sun',
    label: 'Direct Radiant Sun / Heavy Load',
    shortLabel: 'Heavy Sun',
    spec: 'Requires heat acclimatization (7+ days), hydration PI >= 0.8%',
  },
  {
    id: 'shaded',
    label: 'Shaded / Ground Light Duty',
    shortLabel: 'Shaded',
    spec: 'Fallback zone for caution, MQ-3 flags, or Day 1–6 ramp-in',
  },
];

export interface MountOption {
  id: MountMode;
  label: string;
  shortLabel: string;
  spec: string;
}

export const MOUNT_OPTIONS: MountOption[] = [
  {
    id: 'wrist',
    label: 'Wrist Silicone Strap',
    shortLabel: 'Wrist',
    spec: '₹20 strap · IP67 conformal puck + ePTFE breath vent',
  },
  {
    id: 'bicep',
    label: 'Upper Bicep Armband',
    shortLabel: 'Bicep',
    spec: 'Low hammer shock · High capillary SNR',
  },
  {
    id: 'helmet',
    label: 'Hardhat Liner Clip',
    shortLabel: 'Helmet',
    spec: 'Temporal artery contact · Zero tool abrasion',
  },
];

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

export interface WorkerConditions {
  hypertension: boolean;
  diabetes: boolean;
  priorHeat: boolean;
}

export interface WorkerReadiness {
  lowSleep: boolean;
  sedatingMeds: boolean;
  dizzyOrUnwell: boolean;
}

export interface FitToWorkEvaluation {
  status: FitToWorkStatus;
  reasons: string[];
  bpSystolic: number;
  bpDiastolic: number;
  acclimatized: boolean;
}

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

export interface DynamicRiskProfile {
  riskFactor: number;
  thresholds: ThresholdConfig;
  fatigueMultiplierActive: boolean;
  riskTags: string[];
}

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
  tremorHz: number | null;
  hrrBpmDrop: number | null;
  shiftHours: number | null;
  leadOff: boolean;
  mq3Flag: boolean;
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
  age: number;
  conditions: WorkerConditions;
  restingBp: string;
  mountMode: MountMode;
  daysOnSite: number;
  dutyZone: DutyZone;
  readiness: WorkerReadiness;
  gaitBalance: GaitBalanceStatus;
  fitStatus: FitToWorkStatus;
  fitReasons: string[];
  mq3Status: Mq3Status;
  mq3MgL: number | null;
  mq3CheckedAt: string | null;
  shiftHours: number;
  shiftStartHr: number | null;
  lastKeepAliveAt: string | null;
  leadOff: boolean;
  riskFactor: number;
  dynamicHrY: number;
  dynamicHrR: number;
  mentalStrainLevel: MentalStrainLevel;
  mentalRfBoost: number;
  mentalAdjustedAt: string | null;
  workerUid: string | null;
  condition: ConditionLevel;
  reasons: string[];
  lastReport: TelemetryReport | null;
  history?: TelemetryReport[];
  ownerUid?: string;
  createdAtRaw?: unknown;
  updatedAt: string;
}

export interface KeepAliveStatus {
  state: 'standby' | 'alive' | 'disconnected';
  secondsElapsed: number | null;
  secondsRemaining: number | null;
  reason: string;
}

export interface DiagnosticCheckItem {
  id: string;
  label: string;
  detail: string;
  metric: string;
  status: 'pending' | 'running' | 'passed';
}

export type MentalStrainLevel = 'calm' | 'mild' | 'strained' | 'rest_advised';
export type BuddyMood = 'warm' | 'listening' | 'encouraging' | 'caring' | 'alert';
export type FitToWorkStatus = 'fit_full' | 'shaded_only' | 'medical_hold';

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

export interface AssignedWorkerSummary {
  id: string;
  name: string;
  bandId: string;
  age: number;
  baselineHr: number;
  loadFactor: number;
  restingBp: string;
  daysOnSite: number;
  dutyZone: 'height' | 'heavy_sun' | 'shaded';
  shiftHours: number;
  shiftStartHr: number | null;
  mq3Status: 'pending' | 'clear' | 'flagged';
  mq3MgL: number | null;
  gaitBalance: 'pending' | 'stable' | 'sway';
  leadOff: boolean;
  condition: 'unlinked' | 'normal' | 'caution' | 'critical';
  conditions: {
    hypertension: boolean;
    diabetes: boolean;
    priorHeat: boolean;
  };
  readiness: {
    lowSleep: boolean;
    sedatingMeds: boolean;
    dizzyOrUnwell: boolean;
  };
  riskFactor: number;
  dynamicHrY: number;
  dynamicHrR: number;
  fitStatus: FitToWorkStatus;
  mentalStrainLevel: MentalStrainLevel;
  mentalRfBoost: number;
  lastReport: Record<string, unknown> | null;
}

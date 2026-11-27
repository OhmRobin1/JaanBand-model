import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import {
  OperationType,
  auth,
  db,
  handleFirestoreError,
  isAdminUser,
} from '../firebase';
import {
  BuddyMood,
  ConditionLevel,
  DEFAULT_THRESHOLDS,
  DutyZone,
  DynamicRiskProfile,
  FitToWorkEvaluation,
  FitToWorkStatus,
  GaitBalanceStatus,
  KeepAliveStatus,
  MentalStrainLevel,
  MountMode,
  Mq3Status,
  TelemetryReport,
  TelemetrySource,
  ThresholdConfig,
  WorkerConditions,
  WorkerPrivateCheckin,
  WorkerPrivateVault,
  WorkerReadiness,
  WorkerRecord,
} from '../types/band';

export const KEEP_ALIVE_TIMEOUT_SECONDS = 15;

export function sanitizeId(raw: string, maxLen = 32): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

export function sanitizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .trim()
    .slice(0, maxLen);
}

export function sanitizeBp(raw: unknown): string {
  if (typeof raw !== 'string') return '120/80';
  const cleaned = raw.trim().replace(/[^0-9/]/g, '').slice(0, 16);
  return /^[0-9]{2,3}\/[0-9]{2,3}$/.test(cleaned) ? cleaned : '120/80';
}

export function sanitizeIsoTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 10 || trimmed.length > 40) return null;
  return trimmed;
}

export function clampFinite(
  raw: unknown,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.min(max, Math.max(min, num));
}

export function normalizeConditions(raw: unknown): WorkerConditions {
  if (!raw || typeof raw !== 'object') {
    return { hypertension: false, diabetes: false, priorHeat: false };
  }
  const obj = raw as Record<string, unknown>;
  return {
    hypertension: Boolean(obj.hypertension),
    diabetes: Boolean(obj.diabetes),
    priorHeat: Boolean(obj.priorHeat),
  };
}

export function parseRestingBp(raw: unknown): {
  systolic: number;
  diastolic: number;
} {
  const safe = sanitizeBp(raw);
  const [s, d] = safe.split('/').map((n) => Number(n));
  return {
    systolic: Number.isFinite(s) ? s : 120,
    diastolic: Number.isFinite(d) ? d : 80,
  };
}

export function normalizeReadiness(raw: unknown): WorkerReadiness {
  if (!raw || typeof raw !== 'object') {
    return { lowSleep: false, sedatingMeds: false, dizzyOrUnwell: false };
  }
  const obj = raw as Record<string, unknown>;
  return {
    lowSleep: Boolean(obj.lowSleep),
    sedatingMeds: Boolean(obj.sedatingMeds),
    dizzyOrUnwell: Boolean(obj.dizzyOrUnwell),
  };
}

export function normalizeMentalStrain(raw: unknown): MentalStrainLevel {
  if (raw === 'mild' || raw === 'strained' || raw === 'rest_advised') {
    return raw;
  }
  return 'calm';
}

export function computeDynamicRiskProfile(profile: {
  age?: number;
  conditions?: WorkerConditions;
  restingBp?: string;
  daysOnSite?: number;
  readiness?: WorkerReadiness;
  shiftHours?: number;
  mq3Status?: Mq3Status;
  baselineHr?: number;
  loadFactor?: number;
  mentalRfBoost?: number;
  mentalStrainLevel?: MentalStrainLevel;
}): DynamicRiskProfile {
  const age = clampFinite(profile.age, 18, 85) ?? 30;
  const conditions = profile.conditions ?? {
    hypertension: false,
    diabetes: false,
    priorHeat: false,
  };
  const readiness = profile.readiness ?? {
    lowSleep: false,
    sedatingMeds: false,
    dizzyOrUnwell: false,
  };
  const { systolic, diastolic } = parseRestingBp(profile.restingBp);
  const daysOnSite = clampFinite(profile.daysOnSite, 1, 3650) ?? 14;
  const shiftHours = clampFinite(profile.shiftHours, 0, 24) ?? 0;
  const loadFactor = clampFinite(profile.loadFactor, 0.1, 2.0) ?? 0.5;
  const mq3Status: Mq3Status = profile.mq3Status ?? 'pending';
  const mentalRfBoost = Number((clampFinite(profile.mentalRfBoost, 0, 0.25) ?? 0).toFixed(2));
  const mentalStrainLevel = normalizeMentalStrain(profile.mentalStrainLevel);

  let rf = 1.0;
  const riskTags: string[] = [];

  if (age >= 55) {
    rf += 0.14;
    riskTags.push(`Age ${age} (High CV Weight)`);
  } else if (age >= 45) {
    rf += 0.1;
    riskTags.push(`Age ${age} (45+ CV Weight)`);
  }

  if (conditions.hypertension) {
    rf += 0.12;
    riskTags.push('Hypertension');
  } else if (systolic >= 160 || diastolic >= 100) {
    rf += 0.12;
    riskTags.push(`Morning BP ${systolic}/${diastolic}`);
  } else if (systolic >= 140 || diastolic >= 90) {
    rf += 0.06;
    riskTags.push(`Elevated BP ${systolic}/${diastolic}`);
  }

  if (conditions.diabetes) {
    rf += 0.08;
    riskTags.push('Diabetes');
  }
  if (conditions.priorHeat) {
    rf += 0.08;
    riskTags.push('Prior Heat History');
  }

  if (daysOnSite < 7) {
    rf += 0.08;
    riskTags.push(`Day ${daysOnSite} Unacclimatized`);
  }

  if (readiness.lowSleep) {
    rf += 0.05;
    riskTags.push('<5h Sleep Debt');
  }

  if (loadFactor > 1.2) {
    rf += 0.04;
    riskTags.push('Heavy Load Tier');
  }

  const fatigueMultiplierActive = shiftHours >= 4;
  if (fatigueMultiplierActive) {
    rf += 0.07;
    riskTags.push(`${shiftHours.toFixed(1)}h Shift Fatigue`);
  }

  if (mq3Status === 'flagged') {
    rf += 0.1;
    riskTags.push('Breath Alcohol Flag');
  }

  if (mentalRfBoost > 0 || mentalStrainLevel !== 'calm') {
    const appliedBoost =
      mentalRfBoost > 0
        ? mentalRfBoost
        : mentalStrainLevel === 'rest_advised'
          ? 0.22
          : mentalStrainLevel === 'strained'
            ? 0.14
            : 0.06;
    rf += appliedBoost;
    riskTags.push(`Wellbeing Load +${appliedBoost.toFixed(2)}`);
  }

  const riskFactor = Number(Math.min(2.5, rf).toFixed(2));
  const hrR = Math.max(100, Math.round(DEFAULT_THRESHOLDS.hrR / riskFactor));
  const hrY = Math.min(
    hrR - 12,
    Math.max(88, Math.round(DEFAULT_THRESHOLDS.hrY / riskFactor)),
  );
  const tR = Number(
    (
      DEFAULT_THRESHOLDS.tR -
      (conditions.priorHeat ? 0.4 : 0) -
      (mq3Status === 'flagged' ? 0.3 : 0) -
      (daysOnSite < 7 ? 0.2 : 0)
    ).toFixed(1),
  );
  const tY = Number(
    (
      DEFAULT_THRESHOLDS.tY -
      (conditions.priorHeat ? 0.3 : 0) -
      (mq3Status === 'flagged' ? 0.2 : 0) -
      (daysOnSite < 7 ? 0.2 : 0)
    ).toFixed(1),
  );

  return {
    riskFactor,
    fatigueMultiplierActive,
    riskTags,
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      hrY,
      hrR,
      tY,
      tR,
      brk: fatigueMultiplierActive ? 90 : DEFAULT_THRESHOLDS.brk,
    },
  };
}

export function getKeepAliveStatus(
  worker: Pick<
    WorkerRecord,
    'id' | 'bandId' | 'leadOff' | 'lastKeepAliveAt' | 'lastReport'
  > | null,
  nowMs = Date.now(),
): KeepAliveStatus {
  if (!worker || !worker.bandId) {
    return {
      state: 'standby',
      secondsElapsed: null,
      secondsRemaining: null,
      reason: 'No JaanBand paired',
    };
  }

  if (worker.leadOff) {
    return {
      state: 'disconnected',
      secondsElapsed: null,
      secondsRemaining: 0,
      reason: `Worker #${worker.id}: Device Disconnected / Mechanical Failure (Optical Lead-Off)`,
    };
  }

  const refIso = worker.lastKeepAliveAt || worker.lastReport?.timestamp || null;
  if (!refIso) {
    return {
      state: 'standby',
      secondsElapsed: null,
      secondsRemaining: null,
      reason: 'Awaiting initial Keep-Alive packet',
    };
  }

  const parsedMs = Date.parse(refIso);
  if (!Number.isFinite(parsedMs)) {
    return {
      state: 'standby',
      secondsElapsed: null,
      secondsRemaining: null,
      reason: 'Awaiting initial Keep-Alive packet',
    };
  }

  const elapsedSec = Math.max(0, Math.floor((nowMs - parsedMs) / 1000));
  if (elapsedSec > KEEP_ALIVE_TIMEOUT_SECONDS) {
    return {
      state: 'disconnected',
      secondsElapsed: elapsedSec,
      secondsRemaining: 0,
      reason: `Worker #${worker.id}: Device Disconnected / Mechanical Failure (${elapsedSec}s since keep-alive)`,
    };
  }

  return {
    state: 'alive',
    secondsElapsed: elapsedSec,
    secondsRemaining: Math.max(0, KEEP_ALIVE_TIMEOUT_SECONDS - elapsedSec),
    reason: `Keep-Alive verified (${elapsedSec}s / ${KEEP_ALIVE_TIMEOUT_SECONDS}s window)`,
  };
}

export function evaluateCondition(
  report: {
    bpm: number;
    spo2: number;
    skinTempC: number;
    hrvMs?: number | null;
    heatIndexC: number | null;
    perfusionIndex?: number | null;
    batteryPct?: number | null;
    minutesSinceBreak: number;
    tremorHz?: number | null;
    hrrBpmDrop?: number | null;
    shiftHours?: number | null;
    leadOff?: boolean;
  },
  workerContext?: {
    workerId?: string;
    age?: number;
    conditions?: WorkerConditions;
    restingBp?: string;
    daysOnSite?: number;
    dutyZone?: DutyZone;
    readiness?: WorkerReadiness;
    gaitBalance?: GaitBalanceStatus;
    mq3Status?: Mq3Status;
    shiftStartHr?: number | null;
    shiftHours?: number;
    baselineHr?: number;
    loadFactor?: number;
    mentalRfBoost?: number;
    mentalStrainLevel?: MentalStrainLevel;
  },
): {
  condition: Exclude<ConditionLevel, 'unlinked'>;
  reasons: string[];
  thresholds: ThresholdConfig;
  riskFactor: number;
} {
  const effectiveShiftHours = report.shiftHours ?? workerContext?.shiftHours ?? 0;
  const baselineHr = workerContext?.baselineHr ?? 74;
  const daysOnSite = workerContext?.daysOnSite ?? 14;
  const dutyZone: DutyZone = workerContext?.dutyZone ?? 'heavy_sun';
  const readiness = workerContext?.readiness ?? {
    lowSleep: false,
    sedatingMeds: false,
    dizzyOrUnwell: false,
  };
  const gaitBalance: GaitBalanceStatus = workerContext?.gaitBalance ?? 'pending';
  const { systolic, diastolic } = parseRestingBp(workerContext?.restingBp);
  const mentalStrainLevel = normalizeMentalStrain(workerContext?.mentalStrainLevel);
  const mentalRfBoost = clampFinite(workerContext?.mentalRfBoost, 0, 0.25) ?? 0;

  const profile = computeDynamicRiskProfile({
    age: workerContext?.age,
    conditions: workerContext?.conditions,
    restingBp: workerContext?.restingBp,
    daysOnSite,
    readiness,
    shiftHours: effectiveShiftHours,
    mq3Status: workerContext?.mq3Status,
    baselineHr,
    loadFactor: workerContext?.loadFactor,
    mentalRfBoost,
    mentalStrainLevel,
  });
  const thresholds = profile.thresholds;
  const criticalReasons: string[] = [];
  const cautionReasons: string[] = [];

  if (report.leadOff) {
    criticalReasons.push(
      `Worker #${workerContext?.workerId || 'BAND'}: Device Disconnected / Mechanical Failure (Lead-Off)`,
    );
  }

  if (systolic >= 160 || diastolic >= 100) {
    criticalReasons.push(
      `Uncontrolled morning BP (${systolic}/${diastolic} >= 160/100 mmHg)`,
    );
  } else if (systolic >= 140 || diastolic >= 90) {
    cautionReasons.push(
      `Elevated resting BP (${systolic}/${diastolic} >= 140/90 mmHg)`,
    );
  }

  if (readiness.dizzyOrUnwell) {
    criticalReasons.push('Pre-shift dizziness / acute unwell flag — Medical Hold');
  }

  const hrDelta = report.bpm - baselineHr;
  if (report.bpm >= thresholds.hrR || hrDelta >= 75) {
    criticalReasons.push(
      `Heart rate critical (${report.bpm} bpm · +${Math.max(0, hrDelta)} over ${baselineHr} rest · Rf ${profile.riskFactor})`,
    );
  } else if (report.bpm >= thresholds.hrY || hrDelta >= 55) {
    cautionReasons.push(
      `Heart rate elevated (${report.bpm} bpm · +${Math.max(0, hrDelta)} over rest · Rf ${profile.riskFactor})`,
    );
  }

  if (report.spo2 <= thresholds.spR) {
    criticalReasons.push(
      `SpO2 critical (${report.spo2.toFixed(1)}% <= ${thresholds.spR}%)`,
    );
  } else if (report.spo2 <= thresholds.spY) {
    cautionReasons.push(
      `SpO2 caution (${report.spo2.toFixed(1)}% <= ${thresholds.spY}%)`,
    );
  }

  if (report.skinTempC >= 37.3) {
    criticalReasons.push(
      `Fever / acute thermal threshold (${report.skinTempC.toFixed(1)}°C >= 37.3°C)`,
    );
  } else if (report.skinTempC >= thresholds.tR) {
    criticalReasons.push(
      `Skin temp critical (${report.skinTempC.toFixed(1)}°C >= ${thresholds.tR}°C)`,
    );
  } else if (report.skinTempC >= thresholds.tY) {
    cautionReasons.push(
      `Thermal rise (${report.skinTempC.toFixed(1)}°C >= ${thresholds.tY}°C)`,
    );
  }

  if (report.heatIndexC !== null) {
    if (report.heatIndexC >= thresholds.hiR) {
      criticalReasons.push(
        `Heat stress critical (${report.heatIndexC.toFixed(1)}°C >= ${thresholds.hiR}°C)`,
      );
    } else if (report.heatIndexC >= thresholds.hiY) {
      cautionReasons.push(
        `Heat index caution (${report.heatIndexC.toFixed(1)}°C >= ${thresholds.hiY}°C)`,
      );
    }
  }

  // Perfusion Index peripheral dehydration / vasoconstriction check
  if (report.perfusionIndex !== null && report.perfusionIndex !== undefined) {
    if (report.perfusionIndex < 0.35) {
      criticalReasons.push(
        `Severe low perfusion / dehydration shock (PI ${report.perfusionIndex.toFixed(2)}% < 0.35%)`,
      );
    } else if (report.perfusionIndex < 0.8) {
      cautionReasons.push(
        `Low perfusion index / dehydration strain (PI ${report.perfusionIndex.toFixed(2)}% < 0.8%)`,
      );
    }
  }

  // Cognitive fatigue & mental stress via RMSSD HRV
  if (report.hrvMs !== null && report.hrvMs !== undefined) {
    if (report.hrvMs < 20) {
      criticalReasons.push(
        `Severe autonomic stress / low HRV (${report.hrvMs} ms RMSSD)`,
      );
    } else if (report.hrvMs < 32) {
      cautionReasons.push(
        `Mental stress & cognitive fatigue (HRV ${report.hrvMs} ms RMSSD)`,
      );
    }
  }

  if (daysOnSite < 7 && (dutyZone === 'heavy_sun' || (report.heatIndexC ?? 0) >= 35)) {
    cautionReasons.push(
      `Unacclimatized Day ${daysOnSite} (<7d) — restrict from direct sun / full load`,
    );
  }

  if (gaitBalance === 'sway') {
    if (dutyZone === 'height') {
      criticalReasons.push('IMU balance sway detected — disqualified from Height duty');
    } else {
      cautionReasons.push('5s IMU gait/postural sway detected — shaded ground only');
    }
  }

  if (readiness.lowSleep || readiness.sedatingMeds) {
    const flags = [
      readiness.lowSleep ? '<5h sleep' : '',
      readiness.sedatingMeds ? 'sedating meds' : '',
    ]
      .filter(Boolean)
      .join(' + ');
    if (dutyZone === 'height') {
      criticalReasons.push(`Readiness hold (${flags}) — unsafe for Height/Scaffolding`);
    } else {
      cautionReasons.push(`Morning readiness caution (${flags})`);
    }
  }

  if (report.batteryPct !== null && report.batteryPct !== undefined && report.batteryPct < 15) {
    cautionReasons.push(`Low puck battery (${report.batteryPct}% < 15%) — swap from buffer`);
  }

  if (effectiveShiftHours >= 4) {
    cautionReasons.push(
      `Continuous shift fatigue (${effectiveShiftHours.toFixed(1)}h >= 4h limit)`,
    );
  }

  if (report.minutesSinceBreak >= thresholds.brk) {
    cautionReasons.push(`Rest break overdue (${report.minutesSinceBreak} min)`);
  }

  // Tier 1: Breath Alcohol Screening Flag (Band ePTFE Vent / Gate MQ-3)
  if (workerContext?.mq3Status === 'flagged') {
    if (dutyZone === 'height') {
      criticalReasons.push('Breath alcohol flag — strictly barred from Height/Scaffold zone');
    } else {
      cautionReasons.push(
        'Breath Flag: High Dehydration / Impairment Risk — Assign shaded task',
      );
    }
  }

  // Tier 2: Physiological Hangover / Withdrawal Fingerprint
  const shiftStartHr = workerContext?.shiftStartHr ?? null;
  if (shiftStartHr !== null && (shiftStartHr >= 95 || shiftStartHr - baselineHr >= 20)) {
    cautionReasons.push(
      `Morning resting tachycardia (${shiftStartHr} BPM vs ${baselineHr} rest) — dehydration risk`,
    );
  }

  if (report.hrrBpmDrop !== null && report.hrrBpmDrop !== undefined && report.hrrBpmDrop < 12) {
    cautionReasons.push(
      `Abnormal 5m HR recovery (${report.hrrBpmDrop} BPM drop < 12 BPM)`,
    );
  }

  if (report.tremorHz !== null && report.tremorHz !== undefined && report.tremorHz >= 6 && report.tremorHz <= 12) {
    if (report.bpm >= thresholds.hrY || workerContext?.mq3Status === 'flagged' || dutyZone === 'height') {
      criticalReasons.push(
        `Withdrawal micro-tremors (${report.tremorHz.toFixed(1)} Hz) — Height/Load Medical Hold`,
      );
    } else {
      cautionReasons.push(
        `6–12 Hz wrist micro-tremors detected (${report.tremorHz.toFixed(1)} Hz)`,
      );
    }
  }

  if (mentalStrainLevel === 'rest_advised') {
    criticalReasons.push(
      'Wellbeing & Recovery Hold advised (private worker details withheld)',
    );
  } else if (mentalStrainLevel === 'strained' || mentalRfBoost >= 0.12) {
    cautionReasons.push(
      'Wellbeing pacing adjustment active (private worker details withheld)',
    );
  }

  if (criticalReasons.length > 0) {
    return {
      condition: 'critical',
      reasons: [...criticalReasons, ...cautionReasons].slice(0, 10),
      thresholds,
      riskFactor: profile.riskFactor,
    };
  }
  if (cautionReasons.length > 0) {
    return {
      condition: 'caution',
      reasons: cautionReasons.slice(0, 10),
      thresholds,
      riskFactor: profile.riskFactor,
    };
  }
  return {
    condition: 'normal',
    reasons: [
      `All vitals safe (Dynamic critical ceiling ${thresholds.hrR} BPM · Rf ${profile.riskFactor})`,
    ],
    thresholds,
    riskFactor: profile.riskFactor,
  };
}

export function evaluateFitToWork(input: {
  workerId?: string;
  restingBp?: string;
  baselineHr?: number;
  daysOnSite?: number;
  dutyZone?: DutyZone;
  readiness?: WorkerReadiness;
  gaitBalance?: GaitBalanceStatus;
  mq3Status?: Mq3Status;
  mq3MgL?: number | null;
  shiftStartHr?: number | null;
  shiftHours?: number;
  leadOff?: boolean;
  condition?: ConditionLevel;
  lastReport?: TelemetryReport | null;
  mentalStrainLevel?: MentalStrainLevel;
  mentalRfBoost?: number;
}): FitToWorkEvaluation {
  const { systolic, diastolic } = parseRestingBp(input.restingBp);
  const baselineHr = input.baselineHr ?? 74;
  const daysOnSite = clampFinite(input.daysOnSite, 1, 3650) ?? 14;
  const acclimatized = daysOnSite >= 7;
  const dutyZone: DutyZone = input.dutyZone ?? 'heavy_sun';
  const readiness = input.readiness ?? {
    lowSleep: false,
    sedatingMeds: false,
    dizzyOrUnwell: false,
  };
  const gaitBalance: GaitBalanceStatus = input.gaitBalance ?? 'pending';
  const report = input.lastReport ?? null;
  const mentalStrainLevel = normalizeMentalStrain(input.mentalStrainLevel);
  const mentalRfBoost = clampFinite(input.mentalRfBoost, 0, 0.25) ?? 0;

  const holdReasons: string[] = [];
  const shadedReasons: string[] = [];

  if (mentalStrainLevel === 'rest_advised') {
    holdReasons.push(
      'Wellbeing & Recovery Hold advised (private details withheld)',
    );
  } else if (mentalStrainLevel === 'strained' || mentalRfBoost >= 0.12) {
    shadedReasons.push(
      'Wellbeing pacing adjustment — shaded / light duty only (private details withheld)',
    );
  }

  if (input.leadOff) {
    holdReasons.push(
      `Band disconnected / Lead-Off on ${input.workerId || 'worker'} — swap puck before deployment`,
    );
  }
  if (systolic >= 160 || diastolic >= 100) {
    holdReasons.push(`Morning BP ${systolic}/${diastolic} >= 160/100 mmHg (Hypertensive Hold)`);
  } else if (systolic >= 140 || diastolic >= 90) {
    shadedReasons.push(`Resting BP ${systolic}/${diastolic} >= 140/90 — shaded ground duty only`);
  }

  if (readiness.dizzyOrUnwell) {
    holdReasons.push('Worker reports dizziness / acute unwellness');
  }

  if (report && report.skinTempC >= 37.3) {
    holdReasons.push(`Elevated skin temp / fever (${report.skinTempC.toFixed(1)}°C >= 37.3°C)`);
  }

  if (report && report.perfusionIndex !== null && report.perfusionIndex < 0.35) {
    holdReasons.push(`Severe low perfusion (${report.perfusionIndex.toFixed(2)}% < 0.35%) — shock/dehydration risk`);
  } else if (report && report.perfusionIndex !== null && report.perfusionIndex < 0.8) {
    shadedReasons.push(`Low perfusion (${report.perfusionIndex.toFixed(2)}% < 0.8%) — hydrate & shaded rotation`);
  }

  if (input.condition === 'critical' || report?.condition === 'critical') {
    holdReasons.push(
      report?.reasons?.[0] || 'Critical physiological telemetry alert active',
    );
  }

  const hasTremor =
    report?.tremorHz !== null &&
    report?.tremorHz !== undefined &&
    report.tremorHz >= 6 &&
    report.tremorHz <= 12;

  if (dutyZone === 'height') {
    if (input.mq3Status === 'flagged') {
      holdReasons.push('Height/Scaffold barred: Breath alcohol flag');
    }
    if (gaitBalance === 'sway') {
      holdReasons.push('Height/Scaffold barred: 5s IMU gait/balance sway');
    }
    if (readiness.lowSleep || readiness.sedatingMeds) {
      holdReasons.push('Height/Scaffold barred: <5h sleep or sedating medication');
    }
    if (hasTremor) {
      holdReasons.push(`Height/Scaffold barred: ${report?.tremorHz?.toFixed(1)} Hz micro-tremors`);
    }
  } else {
    if (input.mq3Status === 'flagged') {
      if ((input.mq3MgL ?? 0) >= 0.4) {
        holdReasons.push(`High breath alcohol (${(input.mq3MgL ?? 0).toFixed(2)} mg/L >= 0.40)`);
      } else {
        shadedReasons.push('Breath alcohol flagged — shaded low-intensity ground duty only');
      }
    }
    if (gaitBalance === 'sway') {
      shadedReasons.push('5s IMU gait sway — assign seated/ground shaded duty');
    }
    if (readiness.lowSleep) {
      shadedReasons.push('<5h sleep reported — no heavy machinery or sun duty');
    }
    if (readiness.sedatingMeds) {
      shadedReasons.push('Sedating/BP meds reported — avoid heavy heat & climb tasks');
    }
    if (hasTremor) {
      shadedReasons.push(`6–12 Hz micro-tremors (${report?.tremorHz?.toFixed(1)} Hz) — rest & monitor`);
    }
  }

  if (!acclimatized && (dutyZone === 'heavy_sun' || (report?.heatIndexC ?? 0) >= 35)) {
    shadedReasons.push(`Day ${daysOnSite} unacclimatized (<7d) — shaded ramp-in duty required`);
  }

  if (
    input.shiftStartHr !== null &&
    input.shiftStartHr !== undefined &&
    (input.shiftStartHr >= 95 || input.shiftStartHr - baselineHr >= 20)
  ) {
    shadedReasons.push(
      `Morning resting tachycardia (${input.shiftStartHr} BPM) — pre-shift hydration + shade`,
    );
  }

  if (report?.batteryPct !== null && report?.batteryPct !== undefined && report.batteryPct < 15) {
    shadedReasons.push(`Band battery ${report.batteryPct}% (<15%) — swap puck from 10% buffer`);
  }

  if (report?.hrrBpmDrop !== null && report?.hrrBpmDrop !== undefined && report.hrrBpmDrop < 12) {
    shadedReasons.push(`Slow 5m HR recovery (${report.hrrBpmDrop} < 12 BPM) — extend rest break`);
  }

  if (input.condition === 'caution' || report?.condition === 'caution') {
    if (shadedReasons.length === 0) {
      shadedReasons.push(report?.reasons?.[0] || 'Caution telemetry limit active — shaded duty');
    }
  }

  if (holdReasons.length > 0) {
    return {
      status: 'medical_hold',
      reasons: [...holdReasons, ...shadedReasons].slice(0, 10),
      bpSystolic: systolic,
      bpDiastolic: diastolic,
      acclimatized,
    };
  }

  if (shadedReasons.length > 0) {
    return {
      status: 'shaded_only',
      reasons: shadedReasons.slice(0, 10),
      bpSystolic: systolic,
      bpDiastolic: diastolic,
      acclimatized,
    };
  }

  const zoneText =
    dutyZone === 'height'
      ? 'Height/Scaffold'
      : dutyZone === 'heavy_sun'
        ? 'Direct Sun/Heavy'
        : 'Shaded Ground';

  return {
    status: 'fit_full',
    reasons: [
      `Cleared for ${zoneText} · BP ${systolic}/${diastolic} · Day ${daysOnSite} ${acclimatized ? 'acclimatized' : 'ramp'}`,
    ],
    bpSystolic: systolic,
    bpDiastolic: diastolic,
    acclimatized,
  };
}

function timestampToIso(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object' && 'toDate' in val) {
    try {
      return (val as Timestamp).toDate().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
  return new Date().toISOString();
}

function mapDocToWorker(
  docId: string,
  data: Record<string, unknown>,
): WorkerRecord {
  const lastRaw =
    data.lastReport && typeof data.lastReport === 'object'
      ? (data.lastReport as Record<string, unknown>)
      : null;

  const rawSource = String(lastRaw?.source || 'api');
  const safeSource: TelemetrySource =
    rawSource === 'ble' || rawSource === 'manual' ? rawSource : 'api';
  const resolvedWorkerId = sanitizeId(String(data.id || docId || ''), 32) || docId;
  const safeWorkerId =
    sanitizeId(String(lastRaw?.workerId || resolvedWorkerId), 32) || resolvedWorkerId;
  const safeRepBand =
    sanitizeId(String(lastRaw?.bandId || data.bandId || `JB-MK4-${safeWorkerId}`), 48) ||
    `JB-MK4-${safeWorkerId}`;
  const rawReasons = Array.isArray(lastRaw?.reasons)
    ? lastRaw.reasons.map((r) => sanitizeText(String(r), 160)).filter(Boolean).slice(0, 10)
    : [];

  const lastReport: TelemetryReport | null = lastRaw
    ? {
        id: sanitizeId(String(lastRaw.id || `rep-${Date.now()}`), 64) || `rep-${Date.now()}`,
        workerId: safeWorkerId,
        bandId: safeRepBand,
        bpm: clampFinite(lastRaw.bpm, 25, 240) ?? 74,
        spo2: clampFinite(lastRaw.spo2, 50, 100) ?? 98,
        skinTempC: clampFinite(lastRaw.skinTempC, 25, 45) ?? 35,
        hrvMs: clampFinite(lastRaw.hrvMs, 0, 300),
        heatIndexC: clampFinite(lastRaw.heatIndexC, -20, 75),
        perfusionIndex: clampFinite(lastRaw.perfusionIndex, 0, 25),
        batteryPct: clampFinite(lastRaw.batteryPct, 0, 100),
        tremorHz: clampFinite(lastRaw.tremorHz, 0, 30),
        hrrBpmDrop: clampFinite(lastRaw.hrrBpmDrop, 0, 80),
        shiftHours: clampFinite(lastRaw.shiftHours, 0, 24),
        leadOff: Boolean(lastRaw.leadOff),
        mq3Flag: Boolean(lastRaw.mq3Flag),
        minutesSinceBreak: Math.round(clampFinite(lastRaw.minutesSinceBreak, 0, 1440) ?? 0),
        condition:
          lastRaw.condition === 'caution' || lastRaw.condition === 'critical'
            ? lastRaw.condition
            : 'normal',
        reasons: rawReasons.length > 0 ? rawReasons : ['Live telemetry report'],
        source: safeSource,
        timestamp:
          typeof lastRaw.timestamp === 'string' && lastRaw.timestamp.length >= 10
            ? lastRaw.timestamp.slice(0, 40)
            : new Date().toISOString(),
      }
    : null;

  const age = clampFinite(data.age, 18, 85) ?? 30;
  const conditions = normalizeConditions(data.conditions);
  const restingBp = sanitizeBp(data.restingBp);
  const daysOnSite = Math.round(clampFinite(data.daysOnSite, 1, 3650) ?? 14);
  const dutyZone: DutyZone =
    data.dutyZone === 'height' || data.dutyZone === 'shaded'
      ? data.dutyZone
      : 'heavy_sun';
  const readiness = normalizeReadiness(data.readiness);
  const gaitBalance: GaitBalanceStatus =
    data.gaitBalance === 'stable' || data.gaitBalance === 'sway'
      ? data.gaitBalance
      : 'pending';
  const shiftHours = clampFinite(data.shiftHours, 0, 24) ?? 0;
  const loadFactor = clampFinite(data.loadFactor, 0.1, 2.0) ?? 0.5;
  const mq3Status: Mq3Status =
    data.mq3Status === 'clear' || data.mq3Status === 'flagged'
      ? data.mq3Status
      : 'pending';
  const mq3MgL = clampFinite(data.mq3MgL, 0, 2.5);
  const baselineHr = clampFinite(data.baselineHr, 40, 140) ?? 74;
  const shiftStartHr = clampFinite(data.shiftStartHr, 30, 200);
  const leadOff = Boolean(data.leadOff);
  const condition = (data.condition as ConditionLevel) || 'unlinked';
  const mentalStrainLevel = normalizeMentalStrain(data.mentalStrainLevel);
  const mentalRfBoost = clampFinite(data.mentalRfBoost, 0, 0.25) ?? 0;
  const mentalAdjustedAt = sanitizeIsoTimestamp(data.mentalAdjustedAt);
  const workerUid =
    typeof data.workerUid === 'string' && data.workerUid.trim()
      ? data.workerUid.trim().slice(0, 128)
      : null;

  const computedProfile = computeDynamicRiskProfile({
    age,
    conditions,
    restingBp,
    daysOnSite,
    readiness,
    shiftHours,
    mq3Status,
    baselineHr,
    loadFactor,
    mentalRfBoost,
    mentalStrainLevel,
  });

  const computedFit = evaluateFitToWork({
    workerId: resolvedWorkerId,
    restingBp,
    baselineHr,
    daysOnSite,
    dutyZone,
    readiness,
    gaitBalance,
    mq3Status,
    mq3MgL,
    shiftStartHr,
    shiftHours,
    leadOff,
    condition,
    lastReport,
    mentalStrainLevel,
    mentalRfBoost,
  });

  const fitStatus: FitToWorkStatus =
    data.fitStatus === 'fit_full' ||
    data.fitStatus === 'shaded_only' ||
    data.fitStatus === 'medical_hold'
      ? data.fitStatus
      : computedFit.status;

  const fitReasons = Array.isArray(data.fitReasons) && data.fitReasons.length > 0
    ? data.fitReasons.map((r) => String(r)).slice(0, 10)
    : computedFit.reasons;

  const mountMode: MountMode =
    data.mountMode === 'bicep' || data.mountMode === 'helmet'
      ? data.mountMode
      : 'wrist';

  return {
    id: resolvedWorkerId,
    name: String(data.name || resolvedWorkerId),
    role: String(data.role || 'Site Worker'),
    bandId: String(data.bandId || ''),
    baselineHr,
    loadFactor,
    age,
    conditions,
    restingBp,
    mountMode,
    daysOnSite,
    dutyZone,
    readiness,
    gaitBalance,
    fitStatus,
    fitReasons,
    mq3Status,
    mq3MgL,
    mq3CheckedAt: sanitizeIsoTimestamp(data.mq3CheckedAt),
    shiftHours,
    shiftStartHr,
    lastKeepAliveAt: sanitizeIsoTimestamp(data.lastKeepAliveAt),
    leadOff,
    riskFactor:
      clampFinite(data.riskFactor, 0.8, 2.5) ?? computedProfile.riskFactor,
    dynamicHrY:
      clampFinite(data.dynamicHrY, 70, 160) ?? computedProfile.thresholds.hrY,
    dynamicHrR:
      clampFinite(data.dynamicHrR, 85, 180) ?? computedProfile.thresholds.hrR,
    mentalStrainLevel,
    mentalRfBoost,
    mentalAdjustedAt,
    workerUid,
    condition,
    reasons: Array.isArray(data.reasons)
      ? data.reasons.map((r) => String(r)).slice(0, 10)
      : ['Band paired — awaiting live sensor report'],
    lastReport,
    ownerUid: typeof data.ownerUid === 'string' ? data.ownerUid : undefined,
    createdAtRaw:
      data.createdAt && typeof data.createdAt === 'object' && 'toDate' in data.createdAt
        ? data.createdAt
        : undefined,
    updatedAt: timestampToIso(data.updatedAt),
  };
}

function buildCanonicalWorkerPayload(
  worker: WorkerRecord,
  overrides: Partial<{
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
  }> = {},
): Record<string, unknown> {
  const safeBand = (overrides.bandId ?? worker.bandId)
    ? sanitizeId(overrides.bandId ?? worker.bandId, 48)
    : '';
  const rawReasons = overrides.reasons ?? worker.reasons;
  const safeReasons = rawReasons
    .map((r) => sanitizeText(r, 160))
    .filter(Boolean)
    .slice(0, 10);
  const rawFitReasons = overrides.fitReasons ?? worker.fitReasons;
  const safeFitReasons = rawFitReasons
    .map((r) => sanitizeText(r, 160))
    .filter(Boolean)
    .slice(0, 10);

  return {
    id: worker.id,
    name: sanitizeText(overrides.name ?? worker.name, 80) || worker.id,
    role: sanitizeText(overrides.role ?? worker.role, 60) || 'Site Worker',
    bandId: safeBand,
    baselineHr: Math.round(
      clampFinite(overrides.baselineHr ?? worker.baselineHr, 40, 140) ?? 74,
    ),
    loadFactor: clampFinite(overrides.loadFactor ?? worker.loadFactor, 0.1, 2.0) ?? 0.5,
    age: Math.round(clampFinite(overrides.age ?? worker.age, 18, 85) ?? 30),
    conditions: normalizeConditions(overrides.conditions ?? worker.conditions),
    restingBp: sanitizeBp(overrides.restingBp ?? worker.restingBp),
    mountMode: overrides.mountMode ?? worker.mountMode,
    daysOnSite: Math.round(
      clampFinite(overrides.daysOnSite ?? worker.daysOnSite, 1, 3650) ?? 14,
    ),
    dutyZone: overrides.dutyZone ?? worker.dutyZone,
    readiness: normalizeReadiness(overrides.readiness ?? worker.readiness),
    gaitBalance: overrides.gaitBalance ?? worker.gaitBalance,
    fitStatus: overrides.fitStatus ?? worker.fitStatus,
    fitReasons:
      safeFitReasons.length > 0 ? safeFitReasons : ['Fit-to-Work check initialized'],
    mq3Status: overrides.mq3Status ?? worker.mq3Status,
    mq3MgL: clampFinite(
      overrides.mq3MgL !== undefined ? overrides.mq3MgL : worker.mq3MgL,
      0,
      2.5,
    ),
    mq3CheckedAt: sanitizeIsoTimestamp(
      overrides.mq3CheckedAt !== undefined
        ? overrides.mq3CheckedAt
        : worker.mq3CheckedAt,
    ),
    shiftHours: Number(
      (clampFinite(overrides.shiftHours ?? worker.shiftHours, 0, 24) ?? 0).toFixed(1),
    ),
    shiftStartHr: clampFinite(
      overrides.shiftStartHr !== undefined
        ? overrides.shiftStartHr
        : worker.shiftStartHr,
      30,
      200,
    ),
    lastKeepAliveAt: sanitizeIsoTimestamp(
      overrides.lastKeepAliveAt !== undefined
        ? overrides.lastKeepAliveAt
        : worker.lastKeepAliveAt,
    ),
    leadOff: overrides.leadOff ?? worker.leadOff,
    riskFactor: clampFinite(overrides.riskFactor ?? worker.riskFactor, 0.8, 2.5) ?? 1.0,
    dynamicHrY: Math.round(
      clampFinite(overrides.dynamicHrY ?? worker.dynamicHrY, 70, 160) ?? 115,
    ),
    dynamicHrR: Math.round(
      clampFinite(overrides.dynamicHrR ?? worker.dynamicHrR, 85, 180) ?? 140,
    ),
    mentalStrainLevel: normalizeMentalStrain(
      overrides.mentalStrainLevel ?? worker.mentalStrainLevel,
    ),
    mentalRfBoost: Number(
      (
        clampFinite(
          overrides.mentalRfBoost !== undefined
            ? overrides.mentalRfBoost
            : worker.mentalRfBoost,
          0,
          0.25,
        ) ?? 0
      ).toFixed(2),
    ),
    mentalAdjustedAt: sanitizeIsoTimestamp(
      overrides.mentalAdjustedAt !== undefined
        ? overrides.mentalAdjustedAt
        : worker.mentalAdjustedAt,
    ),
    workerUid:
      overrides.workerUid !== undefined
        ? overrides.workerUid
          ? sanitizeText(overrides.workerUid, 128)
          : null
        : worker.workerUid ?? null,
    condition: overrides.condition ?? worker.condition,
    reasons: safeReasons.length > 0 ? safeReasons : ['Band paired'],
    lastReport:
      overrides.lastReport !== undefined ? overrides.lastReport : worker.lastReport,
    ownerUid: worker.ownerUid || auth.currentUser?.uid || '',
    createdAt: worker.createdAtRaw || serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export function subscribeWorkers(
  user: User,
  onWorkers: (workers: WorkerRecord[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const workersRef = collection(db, 'workers');
  const q = isAdminUser(user)
    ? workersRef
    : query(workersRef, where('ownerUid', '==', user.uid));

  return onSnapshot(
    q,
    (snapshot) => {
      const list = snapshot.docs
        .map((d) => mapDocToWorker(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => a.id.localeCompare(b.id));
      onWorkers(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'workers');
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );
}

export function subscribeAssignedWorkerForSaathi(
  user: User,
  onWorkers: (workers: WorkerRecord[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const workersRef = collection(db, 'workers');
  const q = query(workersRef, where('workerUid', '==', user.uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const list = snapshot.docs
        .map((d) => mapDocToWorker(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => a.id.localeCompare(b.id));
      onWorkers(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'workers');
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );
}

export async function upsertWorker(
  user: User,
  input: {
    id: string;
    name: string;
    role?: string;
    bandId?: string;
    baselineHr?: number;
    loadFactor?: number;
    age?: number;
    conditions?: WorkerConditions;
    restingBp?: string;
    mountMode?: MountMode;
    daysOnSite?: number;
    dutyZone?: DutyZone;
    readiness?: WorkerReadiness;
    gaitBalance?: GaitBalanceStatus;
    shiftHours?: number;
    shiftStartHr?: number | null;
  },
  existingWorkers: WorkerRecord[],
): Promise<string> {
  const id = sanitizeId(input.id, 32);
  const name = sanitizeText(input.name, 80);
  if (!id || !name) {
    throw new Error('Worker ID (alphanumeric/hyphen) and name are required.');
  }

  const role = sanitizeText(input.role, 60) || 'Site Worker';
  const bandId = input.bandId ? sanitizeId(input.bandId, 48) : `JB-MK4-${id}`;
  const baselineHr = clampFinite(input.baselineHr, 40, 140) ?? 74;
  const loadFactor = clampFinite(input.loadFactor, 0.1, 2.0) ?? 0.5;
  const age = Math.round(clampFinite(input.age, 18, 85) ?? 30);
  const conditions = input.conditions ?? {
    hypertension: false,
    diabetes: false,
    priorHeat: false,
  };
  const restingBp = sanitizeBp(input.restingBp);
  const mountMode: MountMode = input.mountMode ?? 'wrist';
  const daysOnSite = Math.round(clampFinite(input.daysOnSite, 1, 3650) ?? 14);
  const dutyZone: DutyZone = input.dutyZone ?? 'heavy_sun';
  const readiness = normalizeReadiness(input.readiness);
  const gaitBalance: GaitBalanceStatus = input.gaitBalance ?? 'pending';
  const shiftHours = Number((clampFinite(input.shiftHours, 0, 24) ?? 0).toFixed(1));
  const shiftStartHr = clampFinite(input.shiftStartHr, 30, 200);

  const existing = existingWorkers.find((w) => w.id === id);
  const mq3Status = existing?.mq3Status ?? 'pending';
  const dyn = computeDynamicRiskProfile({
    age,
    conditions,
    restingBp,
    daysOnSite,
    readiness,
    shiftHours,
    mq3Status,
    baselineHr,
    loadFactor,
    mentalRfBoost: existing?.mentalRfBoost,
    mentalStrainLevel: existing?.mentalStrainLevel,
  });

  const fit = evaluateFitToWork({
    workerId: id,
    restingBp,
    baselineHr,
    daysOnSite,
    dutyZone,
    readiness,
    gaitBalance,
    mq3Status,
    mq3MgL: existing?.mq3MgL ?? null,
    shiftStartHr,
    shiftHours,
    leadOff: existing?.leadOff ?? false,
    condition: existing?.lastReport ? existing.condition : 'unlinked',
    lastReport: existing?.lastReport ?? null,
    mentalStrainLevel: existing?.mentalStrainLevel,
    mentalRfBoost: existing?.mentalRfBoost,
  });

  const batch = writeBatch(db);

  if (bandId) {
    for (const w of existingWorkers) {
      if (w.id !== id && w.bandId.toUpperCase() === bandId) {
        const otherRef = doc(db, 'workers', w.id);
        batch.set(
          otherRef,
          buildCanonicalWorkerPayload(w, {
            bandId: '',
            condition: w.lastReport ? w.condition : 'unlinked',
            reasons: w.lastReport ? w.reasons.slice(0, 10) : ['No JaanBand paired'],
          }),
        );
      }
    }
  }

  const workerRef = doc(db, 'workers', id);

  if (existing) {
    batch.set(
      workerRef,
      buildCanonicalWorkerPayload(existing, {
        name,
        role,
        bandId,
        baselineHr,
        loadFactor,
        age,
        conditions,
        restingBp,
        mountMode,
        daysOnSite,
        dutyZone,
        readiness,
        gaitBalance,
        fitStatus: fit.status,
        fitReasons: fit.reasons,
        shiftHours,
        shiftStartHr,
        riskFactor: dyn.riskFactor,
        dynamicHrY: dyn.thresholds.hrY,
        dynamicHrR: dyn.thresholds.hrR,
        condition: existing.lastReport ? existing.condition : 'unlinked',
        reasons: existing.lastReport
          ? existing.reasons.slice(0, 10)
          : [bandId ? 'Band paired — awaiting live sensor report' : 'No JaanBand paired'],
      }),
    );
  } else {
    batch.set(workerRef, {
      id,
      name,
      role,
      bandId,
      baselineHr,
      loadFactor,
      age,
      conditions,
      restingBp,
      mountMode,
      daysOnSite,
      dutyZone,
      readiness,
      gaitBalance,
      fitStatus: fit.status,
      fitReasons: fit.reasons.map((r) => sanitizeText(r, 160)).filter(Boolean).slice(0, 10),
      mq3Status: 'pending',
      mq3MgL: null,
      mq3CheckedAt: null,
      shiftHours,
      shiftStartHr,
      lastKeepAliveAt: null,
      leadOff: false,
      riskFactor: dyn.riskFactor,
      dynamicHrY: dyn.thresholds.hrY,
      dynamicHrR: dyn.thresholds.hrR,
      mentalStrainLevel: 'calm',
      mentalRfBoost: 0,
      mentalAdjustedAt: null,
      workerUid: null,
      condition: 'unlinked',
      reasons: [bandId ? 'Band paired — awaiting live sensor report' : 'No JaanBand paired'],
      lastReport: null,
      ownerUid: user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `workers/${id}`);
  }
  return id;
}

export async function updateWorkerHealthProfile(
  worker: WorkerRecord,
  patch: {
    age?: number;
    conditions?: WorkerConditions;
    restingBp?: string;
    baselineHr?: number;
    mountMode?: MountMode;
    daysOnSite?: number;
    dutyZone?: DutyZone;
    readiness?: WorkerReadiness;
    gaitBalance?: GaitBalanceStatus;
    shiftHours?: number;
    shiftStartHr?: number | null;
    mq3Status?: Mq3Status;
    mq3MgL?: number | null;
    workerUid?: string | null;
  },
): Promise<void> {
  const age = Math.round(clampFinite(patch.age ?? worker.age, 18, 85) ?? 30);
  const conditions = patch.conditions ?? worker.conditions;
  const restingBp = sanitizeBp(patch.restingBp ?? worker.restingBp);
  const baselineHr =
    Math.round(clampFinite(patch.baselineHr ?? worker.baselineHr, 40, 140) ?? 74);
  const mountMode: MountMode = patch.mountMode ?? worker.mountMode;
  const daysOnSite = Math.round(
    clampFinite(patch.daysOnSite ?? worker.daysOnSite, 1, 3650) ?? 14,
  );
  const dutyZone: DutyZone = patch.dutyZone ?? worker.dutyZone;
  const readiness = normalizeReadiness(patch.readiness ?? worker.readiness);
  const gaitBalance: GaitBalanceStatus = patch.gaitBalance ?? worker.gaitBalance;
  const shiftHours = Number(
    (clampFinite(patch.shiftHours ?? worker.shiftHours, 0, 24) ?? 0).toFixed(1),
  );
  const shiftStartHr =
    patch.shiftStartHr !== undefined
      ? clampFinite(patch.shiftStartHr, 30, 200)
      : worker.shiftStartHr;
  const mq3Status: Mq3Status = patch.mq3Status ?? worker.mq3Status;
  const mq3MgL =
    patch.mq3MgL !== undefined
      ? clampFinite(patch.mq3MgL, 0, 2.5)
      : worker.mq3MgL;
  const workerUid =
    patch.workerUid !== undefined
      ? patch.workerUid
        ? sanitizeText(patch.workerUid, 128)
        : null
      : worker.workerUid;

  const dyn = computeDynamicRiskProfile({
    age,
    conditions,
    restingBp,
    daysOnSite,
    readiness,
    shiftHours,
    mq3Status,
    baselineHr,
    loadFactor: worker.loadFactor,
    mentalRfBoost: worker.mentalRfBoost,
    mentalStrainLevel: worker.mentalStrainLevel,
  });

  let nextCondition = worker.condition;
  let nextReasons = worker.reasons;
  if (worker.lastReport) {
    const reEval = evaluateCondition(worker.lastReport, {
      workerId: worker.id,
      age,
      conditions,
      restingBp,
      daysOnSite,
      dutyZone,
      readiness,
      gaitBalance,
      mq3Status,
      shiftStartHr,
      shiftHours,
      baselineHr,
      loadFactor: worker.loadFactor,
      mentalRfBoost: worker.mentalRfBoost,
      mentalStrainLevel: worker.mentalStrainLevel,
    });
    nextCondition = reEval.condition;
    nextReasons = reEval.reasons;
  } else if (mq3Status === 'flagged') {
    nextCondition = dutyZone === 'height' ? 'critical' : 'caution';
    nextReasons = [
      dutyZone === 'height'
        ? 'Breath Alcohol Flag — barred from Height/Scaffold zone'
        : 'Breath Alcohol Flag: High Dehydration / Impairment Risk — Assign shaded task',
    ];
  } else if (readiness.dizzyOrUnwell) {
    nextCondition = 'critical';
    nextReasons = ['Pre-shift dizziness / unwellness reported — Medical Hold'];
  } else if (shiftStartHr !== null && shiftStartHr >= 95) {
    nextCondition = 'caution';
    nextReasons = [
      `Morning resting tachycardia (${shiftStartHr} BPM) — pre-shift dehydration risk`,
    ];
  } else if (mq3Status === 'clear') {
    nextCondition = 'unlinked';
    nextReasons = [
      worker.bandId
        ? 'Breath check cleared — awaiting live sensor report'
        : 'Breath check cleared — no JaanBand paired',
    ];
  }

  const fit = evaluateFitToWork({
    workerId: worker.id,
    restingBp,
    baselineHr,
    daysOnSite,
    dutyZone,
    readiness,
    gaitBalance,
    mq3Status,
    mq3MgL,
    shiftStartHr,
    shiftHours,
    leadOff: worker.leadOff,
    condition: nextCondition,
    lastReport: worker.lastReport,
    mentalStrainLevel: worker.mentalStrainLevel,
    mentalRfBoost: worker.mentalRfBoost,
  });

  const payload = buildCanonicalWorkerPayload(worker, {
    baselineHr,
    age,
    conditions,
    restingBp,
    mountMode,
    daysOnSite,
    dutyZone,
    readiness,
    gaitBalance,
    fitStatus: fit.status,
    fitReasons: fit.reasons,
    mq3Status,
    mq3MgL,
    mq3CheckedAt:
      patch.mq3Status !== undefined
        ? new Date().toISOString()
        : worker.mq3CheckedAt,
    shiftHours,
    shiftStartHr,
    workerUid,
    riskFactor: dyn.riskFactor,
    dynamicHrY: dyn.thresholds.hrY,
    dynamicHrR: dyn.thresholds.hrR,
    condition: nextCondition,
    reasons: nextReasons,
  });

  try {
    await setDoc(doc(db, 'workers', worker.id), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `workers/${worker.id}`);
  }
}

export async function recordKeepAliveHeartbeat(
  worker: WorkerRecord,
  leadOff = false,
): Promise<void> {
  const nowIso = new Date().toISOString();
  let nextCondition = worker.condition;
  let nextReasons = worker.reasons;

  if (leadOff) {
    nextCondition = 'critical';
    nextReasons = [
      `Worker #${worker.id}: Device Disconnected / Mechanical Failure (Optical Lead-Off)`,
    ];
  } else if (worker.lastReport) {
    const reEval = evaluateCondition(
      { ...worker.lastReport, leadOff: false },
      {
        workerId: worker.id,
        age: worker.age,
        conditions: worker.conditions,
        restingBp: worker.restingBp,
        daysOnSite: worker.daysOnSite,
        dutyZone: worker.dutyZone,
        readiness: worker.readiness,
        gaitBalance: worker.gaitBalance,
        mq3Status: worker.mq3Status,
        shiftStartHr: worker.shiftStartHr,
        shiftHours: worker.shiftHours,
        baselineHr: worker.baselineHr,
        loadFactor: worker.loadFactor,
        mentalRfBoost: worker.mentalRfBoost,
        mentalStrainLevel: worker.mentalStrainLevel,
      },
    );
    nextCondition = reEval.condition;
    nextReasons = reEval.reasons;
  } else {
    nextCondition = worker.mq3Status === 'flagged' ? 'caution' : 'unlinked';
    nextReasons = [
      worker.mq3Status === 'flagged'
        ? 'MQ-3 Gate Flag: High Dehydration / Impairment Risk — Assign shaded task'
        : 'Keep-Alive verified — awaiting biometric report',
    ];
  }

  const fit = evaluateFitToWork({
    workerId: worker.id,
    restingBp: worker.restingBp,
    baselineHr: worker.baselineHr,
    daysOnSite: worker.daysOnSite,
    dutyZone: worker.dutyZone,
    readiness: worker.readiness,
    gaitBalance: worker.gaitBalance,
    mq3Status: worker.mq3Status,
    mq3MgL: worker.mq3MgL,
    shiftStartHr: worker.shiftStartHr,
    shiftHours: worker.shiftHours,
    leadOff,
    condition: nextCondition,
    lastReport: worker.lastReport,
    mentalStrainLevel: worker.mentalStrainLevel,
    mentalRfBoost: worker.mentalRfBoost,
  });

  const payload = buildCanonicalWorkerPayload(worker, {
    lastKeepAliveAt: nowIso,
    leadOff,
    fitStatus: fit.status,
    fitReasons: fit.reasons,
    condition: nextCondition,
    reasons: nextReasons,
  });

  try {
    await setDoc(doc(db, 'workers', worker.id), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `workers/${worker.id}`);
  }
}

export async function importWorkersBatch(
  user: User,
  rows: Array<{
    id: string;
    name: string;
    role?: string;
    bandId?: string;
    baselineHr?: number;
    loadFactor?: number;
    age?: number;
  }>,
  existingWorkers: WorkerRecord[],
): Promise<number> {
  const validRows = rows.slice(0, 200);
  const existingMap = new Map(existingWorkers.map((w) => [w.id, w]));
  const batch = writeBatch(db);
  const seenBands = new Set<string>();
  let count = 0;

  for (const row of validRows) {
    const id = sanitizeId(row.id, 32);
    const name = sanitizeText(row.name, 80);
    if (!id || !name) continue;

    const role = sanitizeText(row.role, 60) || 'Site Worker';
    let bandId = row.bandId ? sanitizeId(row.bandId, 48) : `JB-MK4-${id}`;
    if (bandId && seenBands.has(bandId)) {
      bandId = `JB-MK4-${id}`;
    }
    if (bandId) seenBands.add(bandId);

    const baselineHr = clampFinite(row.baselineHr, 40, 140) ?? 74;
    const loadFactor = clampFinite(row.loadFactor, 0.1, 2.0) ?? 0.5;
    const age = Math.round(clampFinite(row.age, 18, 85) ?? 30);
    const existing = existingMap.get(id);
    const dyn = computeDynamicRiskProfile({
      age,
      conditions: existing?.conditions,
      shiftHours: existing?.shiftHours,
      mq3Status: existing?.mq3Status,
      baselineHr,
      mentalRfBoost: existing?.mentalRfBoost,
      mentalStrainLevel: existing?.mentalStrainLevel,
    });

    const ref = doc(db, 'workers', id);

    if (existing) {
      batch.set(
        ref,
        buildCanonicalWorkerPayload(existing, {
          name,
          role,
          bandId,
          baselineHr,
          loadFactor,
          age,
          riskFactor: dyn.riskFactor,
          dynamicHrY: dyn.thresholds.hrY,
          dynamicHrR: dyn.thresholds.hrR,
          condition: existing.lastReport ? existing.condition : 'unlinked',
          reasons: existing.lastReport
            ? existing.reasons.slice(0, 10)
            : ['Band paired — awaiting live sensor report'],
        }),
      );
    } else {
      batch.set(ref, {
        id,
        name,
        role,
        bandId,
        baselineHr,
        loadFactor,
        age,
        conditions: { hypertension: false, diabetes: false, priorHeat: false },
        restingBp: '120/80',
        mountMode: 'wrist',
        daysOnSite: 14,
        dutyZone: 'heavy_sun',
        readiness: { lowSleep: false, sedatingMeds: false, dizzyOrUnwell: false },
        gaitBalance: 'pending',
        fitStatus: 'fit_full',
        fitReasons: ['Cleared for Direct Sun/Heavy · BP 120/80 · Day 14 acclimatized'],
        mq3Status: 'pending',
        mq3MgL: null,
        mq3CheckedAt: null,
        shiftHours: 0,
        shiftStartHr: null,
        lastKeepAliveAt: null,
        leadOff: false,
        riskFactor: dyn.riskFactor,
        dynamicHrY: dyn.thresholds.hrY,
        dynamicHrR: dyn.thresholds.hrR,
        mentalStrainLevel: 'calm',
        mentalRfBoost: 0,
        mentalAdjustedAt: null,
        workerUid: null,
        condition: 'unlinked',
        reasons: ['Band paired — awaiting live sensor report'],
        lastReport: null,
        ownerUid: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    count += 1;
  }

  if (count === 0) {
    throw new Error('No valid worker rows found (requires alphanumeric id and name).');
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'workers');
  }
  return count;
}

export async function updateWorkerBandPairing(
  worker: WorkerRecord,
  rawBandId: string,
  existingWorkers: WorkerRecord[],
): Promise<void> {
  const nextBandId = rawBandId.trim() ? sanitizeId(rawBandId, 48) : '';
  const batch = writeBatch(db);

  if (nextBandId) {
    for (const other of existingWorkers) {
      if (other.id !== worker.id && other.bandId.toUpperCase() === nextBandId) {
        batch.set(
          doc(db, 'workers', other.id),
          buildCanonicalWorkerPayload(other, {
            bandId: '',
            condition: other.lastReport ? other.condition : 'unlinked',
            reasons: other.lastReport
              ? other.reasons.slice(0, 10)
              : ['No JaanBand paired'],
          }),
        );
      }
    }
  }

  const ref = doc(db, 'workers', worker.id);
  batch.set(
    ref,
    buildCanonicalWorkerPayload(worker, {
      bandId: nextBandId,
      condition: worker.lastReport ? worker.condition : 'unlinked',
      reasons: worker.lastReport
        ? worker.reasons
        : [nextBandId ? 'Band paired — awaiting live sensor report' : 'No JaanBand paired'],
    }),
  );

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `workers/${worker.id}`);
  }
}

export async function deleteWorkerCascade(
  user: User,
  workerId: string,
): Promise<void> {
  const safeId = sanitizeId(workerId, 32);
  if (!safeId) return;

  const telemetryCol = collection(db, 'workers', safeId, 'telemetry');
  const tQuery = isAdminUser(user)
    ? telemetryCol
    : query(telemetryCol, where('ownerUid', '==', user.uid));

  try {
    const snap = await getDocs(tQuery);
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(doc(db, 'workers', safeId));
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `workers/${safeId}`);
  }
}

export async function recordTelemetryReport(
  user: User,
  worker: WorkerRecord,
  input: {
    bandId?: string;
    bpm: number;
    spo2: number;
    skinTempC: number;
    hrvMs?: number | null;
    heatIndexC?: number | null;
    perfusionIndex?: number | null;
    batteryPct?: number | null;
    tremorHz?: number | null;
    hrrBpmDrop?: number | null;
    shiftHours?: number | null;
    shiftStartHr?: number | null;
    leadOff?: boolean;
    minutesSinceBreak?: number;
    source: TelemetrySource;
  },
): Promise<TelemetryReport> {
  const bpm = clampFinite(input.bpm, 25, 240);
  const spo2 = clampFinite(input.spo2, 50, 100);
  const skinTempC = clampFinite(input.skinTempC, 25, 45);
  if (bpm === null || spo2 === null || skinTempC === null) {
    throw new Error(
      'Valid physiological values required: BPM (25–240), SpO2 (50–100), Skin Temp (25–45°C).',
    );
  }

  const hrvMs = clampFinite(input.hrvMs, 0, 300);
  const heatIndexC = clampFinite(input.heatIndexC, -20, 75);
  const perfusionIndex = clampFinite(input.perfusionIndex, 0, 25);
  const batteryPct = clampFinite(input.batteryPct, 0, 100);
  const tremorHz = clampFinite(input.tremorHz, 0, 30);
  const hrrBpmDrop = clampFinite(input.hrrBpmDrop, 0, 80);
  const shiftHours =
    clampFinite(input.shiftHours ?? worker.shiftHours, 0, 24) ?? 0;
  const shiftStartHr =
    input.shiftStartHr !== undefined
      ? clampFinite(input.shiftStartHr, 30, 200)
      : worker.shiftStartHr;
  const leadOff = Boolean(input.leadOff);
  const mq3Flag = worker.mq3Status === 'flagged';

  const minutesSinceBreak = Math.round(
    clampFinite(input.minutesSinceBreak, 0, 1440) ?? 0,
  );

  const resolvedBandId = sanitizeId(
    input.bandId || worker.bandId || `JB-MK4-${worker.id}`,
    48,
  );

  const { condition, reasons, thresholds, riskFactor } = evaluateCondition(
    {
      bpm: Math.round(bpm),
      spo2: Number(spo2.toFixed(1)),
      skinTempC: Number(skinTempC.toFixed(2)),
      hrvMs: hrvMs !== null ? Math.round(hrvMs) : null,
      heatIndexC: heatIndexC !== null ? Number(heatIndexC.toFixed(1)) : null,
      perfusionIndex:
        perfusionIndex !== null ? Number(perfusionIndex.toFixed(2)) : null,
      batteryPct: batteryPct !== null ? Math.round(batteryPct) : null,
      minutesSinceBreak,
      tremorHz: tremorHz !== null ? Number(tremorHz.toFixed(1)) : null,
      hrrBpmDrop: hrrBpmDrop !== null ? Math.round(hrrBpmDrop) : null,
      shiftHours: Number(shiftHours.toFixed(1)),
      leadOff,
    },
    {
      workerId: worker.id,
      age: worker.age,
      conditions: worker.conditions,
      restingBp: worker.restingBp,
      daysOnSite: worker.daysOnSite,
      dutyZone: worker.dutyZone,
      readiness: worker.readiness,
      gaitBalance: worker.gaitBalance,
      mq3Status: worker.mq3Status,
      shiftStartHr,
      shiftHours,
      baselineHr: worker.baselineHr,
      loadFactor: worker.loadFactor,
      mentalRfBoost: worker.mentalRfBoost,
      mentalStrainLevel: worker.mentalStrainLevel,
    },
  );

  const reportId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `rep-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const timestamp = new Date().toISOString();

  const snapshot: TelemetryReport = {
    id: reportId,
    workerId: worker.id,
    bandId: resolvedBandId,
    bpm: Math.round(bpm),
    spo2: Number(spo2.toFixed(1)),
    skinTempC: Number(skinTempC.toFixed(2)),
    hrvMs: hrvMs !== null ? Math.round(hrvMs) : null,
    heatIndexC: heatIndexC !== null ? Number(heatIndexC.toFixed(1)) : null,
    perfusionIndex:
      perfusionIndex !== null ? Number(perfusionIndex.toFixed(2)) : null,
    batteryPct: batteryPct !== null ? Math.round(batteryPct) : null,
    tremorHz: tremorHz !== null ? Number(tremorHz.toFixed(1)) : null,
    hrrBpmDrop: hrrBpmDrop !== null ? Math.round(hrrBpmDrop) : null,
    shiftHours: Number(shiftHours.toFixed(1)),
    leadOff,
    mq3Flag,
    minutesSinceBreak,
    condition,
    reasons,
    source: input.source,
    timestamp,
  };

  const fit = evaluateFitToWork({
    workerId: worker.id,
    restingBp: worker.restingBp,
    baselineHr: worker.baselineHr,
    daysOnSite: worker.daysOnSite,
    dutyZone: worker.dutyZone,
    readiness: worker.readiness,
    gaitBalance: worker.gaitBalance,
    mq3Status: worker.mq3Status,
    mq3MgL: worker.mq3MgL,
    shiftStartHr,
    shiftHours,
    leadOff,
    condition,
    lastReport: snapshot,
    mentalStrainLevel: worker.mentalStrainLevel,
    mentalRfBoost: worker.mentalRfBoost,
  });

  const ownerUid = worker.ownerUid || user.uid;
  const batch = writeBatch(db);
  const telemetryRef = doc(db, 'workers', worker.id, 'telemetry', reportId);
  const workerRef = doc(db, 'workers', worker.id);

  batch.set(telemetryRef, {
    ...snapshot,
    ownerUid,
    createdAt: serverTimestamp(),
  });

  batch.set(
    workerRef,
    buildCanonicalWorkerPayload(worker, {
      bandId: resolvedBandId,
      condition,
      reasons,
      fitStatus: fit.status,
      fitReasons: fit.reasons,
      lastReport: snapshot,
      lastKeepAliveAt: timestamp,
      leadOff,
      shiftHours: Number(shiftHours.toFixed(1)),
      shiftStartHr,
      riskFactor,
      dynamicHrY: thresholds.hrY,
      dynamicHrR: thresholds.hrR,
    }),
  );

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `workers/${worker.id}/telemetry/${reportId}`,
    );
  }

  return snapshot;
}

export async function touchWorkerUpdate(worker: WorkerRecord): Promise<void> {
  try {
    await setDoc(doc(db, 'workers', worker.id), buildCanonicalWorkerPayload(worker));
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `workers/${worker.id}`);
  }
}

export async function createSingleWorkerDirect(
  user: User,
  workerId: string,
  name: string,
  role: string,
  bandId: string,
): Promise<void> {
  const id = sanitizeId(workerId, 32);
  const safeBand = sanitizeId(bandId || `JB-MK4-${id}`, 48);
  const dyn = computeDynamicRiskProfile({ age: 30 });
  try {
    await setDoc(doc(db, 'workers', id), {
      id,
      name: sanitizeText(name, 80),
      role: sanitizeText(role, 60) || 'Site Worker',
      bandId: safeBand,
      baselineHr: 74,
      loadFactor: 0.5,
      age: 30,
      conditions: { hypertension: false, diabetes: false, priorHeat: false },
      restingBp: '120/80',
      mountMode: 'wrist',
      daysOnSite: 14,
      dutyZone: 'heavy_sun',
      readiness: { lowSleep: false, sedatingMeds: false, dizzyOrUnwell: false },
      gaitBalance: 'pending',
      fitStatus: 'fit_full',
      fitReasons: ['Cleared for Direct Sun/Heavy · BP 120/80 · Day 14 acclimatized'],
      mq3Status: 'pending',
      mq3MgL: null,
      mq3CheckedAt: null,
      shiftHours: 0,
      shiftStartHr: null,
      lastKeepAliveAt: null,
      leadOff: false,
      riskFactor: dyn.riskFactor,
      dynamicHrY: dyn.thresholds.hrY,
      dynamicHrR: dyn.thresholds.hrR,
      mentalStrainLevel: 'calm',
      mentalRfBoost: 0,
      mentalAdjustedAt: null,
      workerUid: null,
      condition: 'unlinked',
      reasons: ['Band paired — awaiting live sensor report'],
      lastReport: null,
      ownerUid: user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `workers/${id}`);
  }
}

// =============================================================================
// Worker-Only Zero-Leak Private Vault (JaanSaathi Companion)
// Strict Firestore Enforcement: ONLY request.auth.uid == workerUid can read/write.
// Private messages NEVER leave /worker_private/{uid}. Only anonymized Rf/Fit status syncs to workers/{id}.
// =============================================================================

export function subscribeWorkerPrivateVault(
  user: User,
  onVault: (vault: WorkerPrivateVault | null) => void,
  onCheckins: (checkins: WorkerPrivateCheckin[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const vaultRef = doc(db, 'worker_private', user.uid);
  const checkinsQ = query(
    collection(db, 'worker_private', user.uid, 'checkins'),
    orderBy('createdAt', 'desc'),
    limit(25),
  );

  const unsubVault = onSnapshot(
    vaultRef,
    (snap) => {
      if (!snap.exists()) {
        onVault(null);
        return;
      }
      const d = snap.data() as Record<string, unknown>;
      onVault({
        workerUid: user.uid,
        workerId: typeof d.workerId === 'string' ? d.workerId : '',
        preferredLanguageCode:
          typeof d.preferredLanguageCode === 'string' ? d.preferredLanguageCode : 'hi',
        preferredState: typeof d.preferredState === 'string' ? d.preferredState : 'Pan-India',
        lastMentalStrainLevel: normalizeMentalStrain(d.lastMentalStrainLevel),
        lastMentalRfBoost: clampFinite(d.lastMentalRfBoost, 0, 0.25) ?? 0,
        updatedAt: timestampToIso(d.updatedAt),
      });
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, `worker_private/${user.uid}`);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );

  const unsubCheckins = onSnapshot(
    checkinsQ,
    (snap) => {
      const list: WorkerPrivateCheckin[] = snap.docs.map((d) => {
        const raw = d.data() as Record<string, unknown>;
        const moodRaw = String(raw.buddyMood || 'warm');
        const buddyMood: BuddyMood =
          moodRaw === 'listening' ||
          moodRaw === 'encouraging' ||
          moodRaw === 'caring' ||
          moodRaw === 'alert'
            ? moodRaw
            : 'warm';
        return {
          id: d.id,
          workerUid: user.uid,
          workerId: typeof raw.workerId === 'string' ? raw.workerId : '',
          languageCode: typeof raw.languageCode === 'string' ? raw.languageCode : 'hi',
          languageName: typeof raw.languageName === 'string' ? raw.languageName : 'Hindi',
          workerMessage: typeof raw.workerMessage === 'string' ? raw.workerMessage : '',
          buddyReply: typeof raw.buddyReply === 'string' ? raw.buddyReply : '',
          buddyMood,
          mentalStrainLevel: normalizeMentalStrain(raw.mentalStrainLevel),
          mentalRfBoost: clampFinite(raw.mentalRfBoost, 0, 0.25) ?? 0,
          gentleCareTip: typeof raw.gentleCareTip === 'string' ? raw.gentleCareTip : '',
          syncedToBand: Boolean(raw.syncedToBand),
          createdAt: timestampToIso(raw.createdAt),
        };
      });
      onCheckins(list);
    },
    (error) => {
      try {
        handleFirestoreError(
          error,
          OperationType.LIST,
          `worker_private/${user.uid}/checkins`,
        );
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );

  return () => {
    unsubVault();
    unsubCheckins();
  };
}

export async function saveWorkerLanguagePref(
  user: User,
  params: {
    workerId?: string;
    preferredLanguageCode: string;
    preferredState: string;
  },
): Promise<void> {
  const ref = doc(db, 'worker_private', user.uid);
  try {
    await setDoc(
      ref,
      {
        workerUid: user.uid,
        workerId: sanitizeId(params.workerId || '', 64),
        preferredLanguageCode: sanitizeText(params.preferredLanguageCode, 16) || 'hi',
        preferredState: sanitizeText(params.preferredState, 64) || 'Pan-India',
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `worker_private/${user.uid}`);
  }
}

export async function recordPrivateCheckinAndSyncAnonymizedRf(
  user: User,
  params: {
    worker: WorkerRecord | null;
    preferredState: string;
    languageCode: string;
    languageName: string;
    workerMessage: string;
    buddyReply: string;
    buddyMood: BuddyMood;
    mentalStrainLevel: MentalStrainLevel;
    mentalRfBoost: number;
    gentleCareTip: string;
    recommendShadedDuty?: boolean;
    recommendMedicalHold?: boolean;
  },
): Promise<void> {
  const checkinId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `chk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const boost = Number((clampFinite(params.mentalRfBoost, 0, 0.25) ?? 0).toFixed(2));
  const strain: MentalStrainLevel = normalizeMentalStrain(
    params.recommendMedicalHold
      ? 'rest_advised'
      : params.recommendShadedDuty && params.mentalStrainLevel === 'calm'
        ? 'strained'
        : params.mentalStrainLevel,
  );
  const effectiveBoost =
    strain === 'rest_advised'
      ? Math.max(0.2, boost)
      : strain === 'strained'
        ? Math.max(0.12, boost)
        : boost;

  const vaultRef = doc(db, 'worker_private', user.uid);
  const checkinRef = doc(db, 'worker_private', user.uid, 'checkins', checkinId);
  const workerId = params.worker?.id || '';

  const batch = writeBatch(db);
  batch.set(
    vaultRef,
    {
      workerUid: user.uid,
      workerId,
      preferredLanguageCode: sanitizeText(params.languageCode, 16) || 'hi',
      preferredState: sanitizeText(params.preferredState, 64) || 'Pan-India',
      lastMentalStrainLevel: strain,
      lastMentalRfBoost: effectiveBoost,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  batch.set(checkinRef, {
    id: checkinId,
    workerUid: user.uid,
    workerId,
    languageCode: sanitizeText(params.languageCode, 16) || 'hi',
    languageName: sanitizeText(params.languageName, 64) || 'Hindi',
    workerMessage: sanitizeText(params.workerMessage, 2000) || 'Check-in',
    buddyReply: sanitizeText(params.buddyReply, 2500) || 'Stay safe and hydrated.',
    buddyMood: params.buddyMood,
    mentalStrainLevel: strain,
    mentalRfBoost: effectiveBoost,
    gentleCareTip: sanitizeText(params.gentleCareTip, 400),
    syncedToBand: Boolean(params.worker),
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `worker_private/${user.uid}/checkins/${checkinId}`,
    );
  }

  if (params.worker) {
    const w = params.worker;
    const dyn = computeDynamicRiskProfile({
      age: w.age,
      conditions: w.conditions,
      restingBp: w.restingBp,
      daysOnSite: w.daysOnSite,
      readiness: w.readiness,
      shiftHours: w.shiftHours,
      mq3Status: w.mq3Status,
      baselineHr: w.baselineHr,
      loadFactor: w.loadFactor,
      mentalRfBoost: effectiveBoost,
      mentalStrainLevel: strain,
    });
    const fit = evaluateFitToWork({
      workerId: w.id,
      restingBp: w.restingBp,
      baselineHr: w.baselineHr,
      daysOnSite: w.daysOnSite,
      dutyZone: w.dutyZone,
      readiness: w.readiness,
      gaitBalance: w.gaitBalance,
      mq3Status: w.mq3Status,
      mq3MgL: w.mq3MgL,
      shiftStartHr: w.shiftStartHr,
      shiftHours: w.shiftHours,
      leadOff: w.leadOff,
      condition: w.condition,
      lastReport: w.lastReport,
      mentalStrainLevel: strain,
      mentalRfBoost: effectiveBoost,
    });

    const workerRef = doc(db, 'workers', w.id);
    // Anonymized update ONLY: zero private words or health disclosures sent to workers/{id}
    try {
      await setDoc(
        workerRef,
        {
          mentalStrainLevel: strain,
          mentalRfBoost: effectiveBoost,
          mentalAdjustedAt: new Date().toISOString(),
          fitStatus: fit.status,
          fitReasons: fit.reasons.map((r) => sanitizeText(r, 160)).filter(Boolean).slice(0, 10),
          riskFactor: dyn.riskFactor,
          dynamicHrY: dyn.thresholds.hrY,
          dynamicHrR: dyn.thresholds.hrR,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } catch {
      // Non-fatal if worker profile isn't paired via workerUid yet; private checkin is still safely saved
    }
  }
}

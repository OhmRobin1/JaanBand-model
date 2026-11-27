import {
  collection,
  doc,
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
import { db } from '../firebase';
import {
  AssignedWorkerSummary,
  BuddyMood,
  FitToWorkStatus,
  MentalStrainLevel,
  WorkerPrivateCheckin,
  WorkerPrivateVault,
} from '../types';

function clamp(raw: unknown, min: number, max: number): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function sanitizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, maxLen);
}

function normalizeStrain(raw: unknown): MentalStrainLevel {
  if (raw === 'mild' || raw === 'strained' || raw === 'rest_advised') return raw;
  return 'calm';
}

function tsToIso(val: unknown): string {
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

function computeCombinedThresholds(
  w: AssignedWorkerSummary,
  mentalStrain: MentalStrainLevel,
  mentalBoost: number,
) {
  const [sys = 120, dia = 80] = String(w.restingBp || '120/80').split('/').map(Number);
  let rf = 1.0;
  if (w.age >= 55) rf += 0.14;
  else if (w.age >= 45) rf += 0.1;
  if (w.conditions.hypertension || sys >= 160 || dia >= 100) rf += 0.12;
  else if (sys >= 140 || dia >= 90) rf += 0.06;
  if (w.conditions.diabetes) rf += 0.08;
  if (w.conditions.priorHeat) rf += 0.08;
  if (w.daysOnSite < 7) rf += 0.08;
  if (w.readiness.lowSleep) rf += 0.05;
  if (w.loadFactor > 1.2) rf += 0.04;
  if (w.shiftHours >= 4) rf += 0.07;
  if (w.mq3Status === 'flagged') rf += 0.1;
  rf += mentalBoost;

  const riskFactor = Number(Math.min(2.5, rf).toFixed(2));
  const dynamicHrR = Math.max(100, Math.round(140 / riskFactor));
  const dynamicHrY = Math.min(dynamicHrR - 12, Math.max(88, Math.round(115 / riskFactor)));

  const holdReasons: string[] = [];
  const shadedReasons: string[] = [];

  if (mentalStrain === 'rest_advised') {
    holdReasons.push('Wellbeing & Recovery Hold advised (private details withheld)');
  } else if (mentalStrain === 'strained' || mentalBoost >= 0.12) {
    shadedReasons.push('Wellbeing pacing adjustment — shaded / light duty only (private details withheld)');
  }

  if (w.leadOff || w.condition === 'critical') holdReasons.push('Active hardware or vital hold');
  if (sys >= 160 || dia >= 100) holdReasons.push(`Morning BP ${sys}/${dia} >= 160/100`);
  else if (sys >= 140 || dia >= 90) shadedReasons.push(`Resting BP ${sys}/${dia} >= 140/90`);
  if (w.readiness.dizzyOrUnwell) holdReasons.push('Dizziness / unwellness active');
  if (w.mq3Status === 'flagged') shadedReasons.push('Breath alcohol flag active');
  if (w.gaitBalance === 'sway') shadedReasons.push('IMU balance sway active');
  if (w.readiness.lowSleep || w.readiness.sedatingMeds) shadedReasons.push('Readiness caution active');

  let fitStatus: FitToWorkStatus = 'fit_full';
  let fitReasons = ['Cleared for Duty · Wellbeing & Vitals steady'];
  if (holdReasons.length > 0) {
    fitStatus = 'medical_hold';
    fitReasons = [...holdReasons, ...shadedReasons].slice(0, 10);
  } else if (shadedReasons.length > 0) {
    fitStatus = 'shaded_only';
    fitReasons = shadedReasons.slice(0, 10);
  }

  return { riskFactor, dynamicHrY, dynamicHrR, fitStatus, fitReasons };
}

export function subscribeAssignedWorker(
  user: User,
  onWorkers: (workers: AssignedWorkerSummary[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const q = query(collection(db, 'workers'), where('workerUid', '==', user.uid));
  return onSnapshot(
    q,
    (snap) => {
      const list: AssignedWorkerSummary[] = snap.docs.map((d) => {
        const raw = d.data() as Record<string, unknown>;
        const conds = (raw.conditions || {}) as Record<string, unknown>;
        const read = (raw.readiness || {}) as Record<string, unknown>;
        return {
          id: d.id,
          name: String(raw.name || d.id),
          bandId: String(raw.bandId || ''),
          age: clamp(raw.age, 18, 85) ?? 30,
          baselineHr: clamp(raw.baselineHr, 40, 140) ?? 74,
          loadFactor: clamp(raw.loadFactor, 0.1, 2.0) ?? 0.5,
          restingBp: String(raw.restingBp || '120/80'),
          daysOnSite: clamp(raw.daysOnSite, 1, 3650) ?? 14,
          dutyZone:
            raw.dutyZone === 'height' || raw.dutyZone === 'shaded'
              ? raw.dutyZone
              : 'heavy_sun',
          shiftHours: clamp(raw.shiftHours, 0, 24) ?? 0,
          shiftStartHr: clamp(raw.shiftStartHr, 30, 200),
          mq3Status:
            raw.mq3Status === 'clear' || raw.mq3Status === 'flagged'
              ? raw.mq3Status
              : 'pending',
          mq3MgL: clamp(raw.mq3MgL, 0, 2.5),
          gaitBalance:
            raw.gaitBalance === 'stable' || raw.gaitBalance === 'sway'
              ? raw.gaitBalance
              : 'pending',
          leadOff: Boolean(raw.leadOff),
          condition: (raw.condition as AssignedWorkerSummary['condition']) || 'unlinked',
          conditions: {
            hypertension: Boolean(conds.hypertension),
            diabetes: Boolean(conds.diabetes),
            priorHeat: Boolean(conds.priorHeat),
          },
          readiness: {
            lowSleep: Boolean(read.lowSleep),
            sedatingMeds: Boolean(read.sedatingMeds),
            dizzyOrUnwell: Boolean(read.dizzyOrUnwell),
          },
          riskFactor: clamp(raw.riskFactor, 0.8, 2.5) ?? 1.0,
          dynamicHrY: clamp(raw.dynamicHrY, 70, 160) ?? 115,
          dynamicHrR: clamp(raw.dynamicHrR, 85, 180) ?? 140,
          fitStatus:
            raw.fitStatus === 'shaded_only' || raw.fitStatus === 'medical_hold'
              ? raw.fitStatus
              : 'fit_full',
          mentalStrainLevel: normalizeStrain(raw.mentalStrainLevel),
          mentalRfBoost: clamp(raw.mentalRfBoost, 0, 0.25) ?? 0,
          lastReport: (raw.lastReport as Record<string, unknown>) || null,
        };
      });
      onWorkers(list);
    },
    (err) => onError(err),
  );
}

export function subscribePrivateVault(
  user: User,
  onVault: (vault: WorkerPrivateVault | null) => void,
  onCheckins: (checkins: WorkerPrivateCheckin[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const unsubV = onSnapshot(
    doc(db, 'worker_private', user.uid),
    (snap) => {
      if (!snap.exists()) {
        onVault(null);
        return;
      }
      const d = snap.data() as Record<string, unknown>;
      onVault({
        workerUid: user.uid,
        workerId: String(d.workerId || ''),
        preferredLanguageCode: String(d.preferredLanguageCode || 'hi'),
        preferredState: String(d.preferredState || 'All States / Union Territories'),
        lastMentalStrainLevel: normalizeStrain(d.lastMentalStrainLevel),
        lastMentalRfBoost: clamp(d.lastMentalRfBoost, 0, 0.25) ?? 0,
        updatedAt: tsToIso(d.updatedAt),
      });
    },
    (err) => onError(err),
  );

  const q = query(
    collection(db, 'worker_private', user.uid, 'checkins'),
    orderBy('createdAt', 'desc'),
    limit(25),
  );
  const unsubC = onSnapshot(
    q,
    (snap) => {
      const items: WorkerPrivateCheckin[] = snap.docs.map((d) => {
        const raw = d.data() as Record<string, unknown>;
        const mood = String(raw.buddyMood || 'warm') as BuddyMood;
        return {
          id: d.id,
          workerUid: user.uid,
          workerId: String(raw.workerId || ''),
          languageCode: String(raw.languageCode || 'hi'),
          languageName: String(raw.languageName || 'Hindi'),
          workerMessage: String(raw.workerMessage || ''),
          buddyReply: String(raw.buddyReply || ''),
          buddyMood: mood,
          mentalStrainLevel: normalizeStrain(raw.mentalStrainLevel),
          mentalRfBoost: clamp(raw.mentalRfBoost, 0, 0.25) ?? 0,
          gentleCareTip: String(raw.gentleCareTip || ''),
          syncedToBand: Boolean(raw.syncedToBand),
          createdAt: tsToIso(raw.createdAt),
        };
      });
      onCheckins(items);
    },
    (err) => onError(err),
  );

  return () => {
    unsubV();
    unsubC();
  };
}

export async function saveLanguagePref(
  user: User,
  params: { workerId?: string; preferredLanguageCode: string; preferredState: string },
) {
  await setDoc(
    doc(db, 'worker_private', user.uid),
    {
      workerUid: user.uid,
      workerId: sanitizeText(params.workerId || '', 64),
      preferredLanguageCode: sanitizeText(params.preferredLanguageCode, 16) || 'hi',
      preferredState: sanitizeText(params.preferredState, 64) || 'Pan-India',
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function saveCheckinAndSyncAnonymized(
  user: User,
  params: {
    worker: AssignedWorkerSummary | null;
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
) {
  const checkinId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `chk-${Date.now()}`;

  const strain = normalizeStrain(
    params.recommendMedicalHold
      ? 'rest_advised'
      : params.recommendShadedDuty && params.mentalStrainLevel === 'calm'
        ? 'strained'
        : params.mentalStrainLevel,
  );
  const rawBoost = Number((clamp(params.mentalRfBoost, 0, 0.25) ?? 0).toFixed(2));
  const boost =
    strain === 'rest_advised'
      ? Math.max(0.2, rawBoost)
      : strain === 'strained'
        ? Math.max(0.12, rawBoost)
        : rawBoost;

  const batch = writeBatch(db);
  batch.set(
    doc(db, 'worker_private', user.uid),
    {
      workerUid: user.uid,
      workerId: params.worker?.id || '',
      preferredLanguageCode: sanitizeText(params.languageCode, 16) || 'hi',
      preferredState: sanitizeText(params.preferredState, 64) || 'Pan-India',
      lastMentalStrainLevel: strain,
      lastMentalRfBoost: boost,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  batch.set(doc(db, 'worker_private', user.uid, 'checkins', checkinId), {
    id: checkinId,
    workerUid: user.uid,
    workerId: params.worker?.id || '',
    languageCode: sanitizeText(params.languageCode, 16) || 'hi',
    languageName: sanitizeText(params.languageName, 64) || 'Hindi',
    workerMessage: sanitizeText(params.workerMessage, 2000),
    buddyReply: sanitizeText(params.buddyReply, 2500),
    buddyMood: params.buddyMood,
    mentalStrainLevel: strain,
    mentalRfBoost: boost,
    gentleCareTip: sanitizeText(params.gentleCareTip, 400),
    syncedToBand: Boolean(params.worker),
    createdAt: serverTimestamp(),
  });

  await batch.commit();

  if (params.worker) {
    const computed = computeCombinedThresholds(params.worker, strain, boost);
    try {
      await setDoc(
        doc(db, 'workers', params.worker.id),
        {
          mentalStrainLevel: strain,
          mentalRfBoost: boost,
          mentalAdjustedAt: new Date().toISOString(),
          fitStatus: computed.fitStatus,
          fitReasons: computed.fitReasons,
          riskFactor: computed.riskFactor,
          dynamicHrY: computed.dynamicHrY,
          dynamicHrR: computed.dynamicHrR,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } catch {
      // Non-fatal if worker profile isn't linked yet
    }
  }
}

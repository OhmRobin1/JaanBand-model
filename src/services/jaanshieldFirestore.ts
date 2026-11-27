import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import {
  OperationType,
  db,
  handleFirestoreError,
  isAdminUser,
} from '../firebase';
import {
  ConditionLevel,
  DEFAULT_THRESHOLDS,
  TelemetryReport,
  TelemetrySource,
  ThresholdConfig,
  WorkerRecord,
} from '../types/band';

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

export function evaluateCondition(
  report: {
    bpm: number;
    spo2: number;
    skinTempC: number;
    heatIndexC: number | null;
    minutesSinceBreak: number;
  },
  thresholds: ThresholdConfig = DEFAULT_THRESHOLDS,
): { condition: Exclude<ConditionLevel, 'unlinked'>; reasons: string[] } {
  const criticalReasons: string[] = [];
  const cautionReasons: string[] = [];

  if (report.bpm >= thresholds.hrR) {
    criticalReasons.push(
      `Heart rate critical (${report.bpm} >= ${thresholds.hrR} bpm)`,
    );
  } else if (report.bpm >= thresholds.hrY) {
    cautionReasons.push(
      `Heart rate elevated (${report.bpm} >= ${thresholds.hrY} bpm)`,
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

  if (report.skinTempC >= thresholds.tR) {
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

  if (report.minutesSinceBreak >= thresholds.brk) {
    cautionReasons.push(`Rest break overdue (${report.minutesSinceBreak} min)`);
  }

  if (criticalReasons.length > 0) {
    return {
      condition: 'critical',
      reasons: [...criticalReasons, ...cautionReasons].slice(0, 10),
    };
  }
  if (cautionReasons.length > 0) {
    return { condition: 'caution', reasons: cautionReasons.slice(0, 10) };
  }
  return {
    condition: 'normal',
    reasons: ['All biometric thresholds within safe limits'],
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

function mapDocToWorker(data: Record<string, unknown>): WorkerRecord {
  const lastRaw =
    data.lastReport && typeof data.lastReport === 'object'
      ? (data.lastReport as Record<string, unknown>)
      : null;

  const lastReport: TelemetryReport | null = lastRaw
    ? {
        id: String(lastRaw.id || ''),
        workerId: String(lastRaw.workerId || data.id || ''),
        bandId: String(lastRaw.bandId || data.bandId || ''),
        bpm: Number(lastRaw.bpm || 0),
        spo2: Number(lastRaw.spo2 || 0),
        skinTempC: Number(lastRaw.skinTempC || 0),
        hrvMs: lastRaw.hrvMs !== null && lastRaw.hrvMs !== undefined ? Number(lastRaw.hrvMs) : null,
        heatIndexC:
          lastRaw.heatIndexC !== null && lastRaw.heatIndexC !== undefined
            ? Number(lastRaw.heatIndexC)
            : null,
        perfusionIndex:
          lastRaw.perfusionIndex !== null && lastRaw.perfusionIndex !== undefined
            ? Number(lastRaw.perfusionIndex)
            : null,
        batteryPct:
          lastRaw.batteryPct !== null && lastRaw.batteryPct !== undefined
            ? Number(lastRaw.batteryPct)
            : null,
        minutesSinceBreak: Number(lastRaw.minutesSinceBreak || 0),
        condition: (lastRaw.condition as TelemetryReport['condition']) || 'normal',
        reasons: Array.isArray(lastRaw.reasons)
          ? lastRaw.reasons.map((r) => String(r)).slice(0, 10)
          : ['Live telemetry report'],
        source: (lastRaw.source as TelemetrySource) || 'api',
        timestamp: String(lastRaw.timestamp || new Date().toISOString()),
      }
    : null;

  return {
    id: String(data.id || ''),
    name: String(data.name || ''),
    role: String(data.role || 'Site Worker'),
    bandId: String(data.bandId || ''),
    baselineHr: Number(data.baselineHr || 74),
    loadFactor: Number(data.loadFactor || 0.5),
    condition: (data.condition as ConditionLevel) || 'unlinked',
    reasons: Array.isArray(data.reasons)
      ? data.reasons.map((r) => String(r)).slice(0, 10)
      : ['Band paired — awaiting live sensor report'],
    lastReport,
    ownerUid: typeof data.ownerUid === 'string' ? data.ownerUid : undefined,
    updatedAt: timestampToIso(data.updatedAt),
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
        .map((d) => mapDocToWorker(d.data() as Record<string, unknown>))
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

  const batch = writeBatch(db);

  // Release conflicting bandId from any other worker owned by this user/admin
  if (bandId) {
    for (const w of existingWorkers) {
      if (w.id !== id && w.bandId.toUpperCase() === bandId) {
        const otherRef = doc(db, 'workers', w.id);
        batch.update(otherRef, {
          bandId: '',
          condition: w.lastReport ? w.condition : 'unlinked',
          reasons: w.lastReport ? w.reasons.slice(0, 10) : ['No JaanBand paired'],
          updatedAt: serverTimestamp(),
        });
      }
    }
  }

  const existing = existingWorkers.find((w) => w.id === id);
  const workerRef = doc(db, 'workers', id);

  if (existing) {
    batch.update(workerRef, {
      name,
      role,
      bandId,
      baselineHr,
      loadFactor,
      condition: existing.lastReport ? existing.condition : 'unlinked',
      reasons: existing.lastReport
        ? existing.reasons.slice(0, 10)
        : [bandId ? 'Band paired — awaiting live sensor report' : 'No JaanBand paired'],
      updatedAt: serverTimestamp(),
    });
  } else {
    batch.set(workerRef, {
      id,
      name,
      role,
      bandId,
      baselineHr,
      loadFactor,
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

export async function importWorkersBatch(
  user: User,
  rows: Array<{
    id: string;
    name: string;
    role?: string;
    bandId?: string;
    baselineHr?: number;
    loadFactor?: number;
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

    const existing = existingMap.get(id);
    const ref = doc(db, 'workers', id);

    if (existing) {
      batch.update(ref, {
        name,
        role,
        bandId,
        baselineHr,
        loadFactor,
        condition: existing.lastReport ? existing.condition : 'unlinked',
        reasons: existing.lastReport
          ? existing.reasons.slice(0, 10)
          : ['Band paired — awaiting live sensor report'],
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(ref, {
        id,
        name,
        role,
        bandId,
        baselineHr,
        loadFactor,
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
        batch.update(doc(db, 'workers', other.id), {
          bandId: '',
          updatedAt: serverTimestamp(),
        });
      }
    }
  }

  const ref = doc(db, 'workers', worker.id);
  const payload: Record<string, unknown> = {
    bandId: nextBandId,
    updatedAt: serverTimestamp(),
  };
  if (!worker.lastReport) {
    payload.condition = 'unlinked';
    payload.reasons = [
      nextBandId ? 'Band paired — awaiting live sensor report' : 'No JaanBand paired',
    ];
  }

  batch.update(ref, payload);

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
  const minutesSinceBreak = Math.round(
    clampFinite(input.minutesSinceBreak, 0, 1440) ?? 0,
  );

  const resolvedBandId = sanitizeId(
    input.bandId || worker.bandId || `JB-MK4-${worker.id}`,
    48,
  );

  const { condition, reasons } = evaluateCondition({
    bpm: Math.round(bpm),
    spo2: Number(spo2.toFixed(1)),
    skinTempC: Number(skinTempC.toFixed(2)),
    heatIndexC: heatIndexC !== null ? Number(heatIndexC.toFixed(1)) : null,
    minutesSinceBreak,
  });

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
      perfusionIndex !== null ? Number(perfusionIndex.toFixed(1)) : null,
    batteryPct: batteryPct !== null ? Math.round(batteryPct) : null,
    minutesSinceBreak,
    condition,
    reasons,
    source: input.source,
    timestamp,
  };

  const ownerUid = worker.ownerUid || user.uid;
  const batch = writeBatch(db);
  const telemetryRef = doc(db, 'workers', worker.id, 'telemetry', reportId);
  const workerRef = doc(db, 'workers', worker.id);

  batch.set(telemetryRef, {
    ...snapshot,
    ownerUid,
    createdAt: serverTimestamp(),
  });

  batch.update(workerRef, {
    bandId: resolvedBandId,
    condition,
    reasons,
    lastReport: snapshot,
    updatedAt: serverTimestamp(),
  });

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
    await updateDoc(doc(db, 'workers', worker.id), {
      updatedAt: serverTimestamp(),
    });
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
  try {
    await setDoc(doc(db, 'workers', id), {
      id,
      name: sanitizeText(name, 80),
      role: sanitizeText(role, 60) || 'Site Worker',
      bandId: safeBand,
      baselineHr: 74,
      loadFactor: 0.5,
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

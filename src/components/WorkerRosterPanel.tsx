import { useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  Check,
  HeartPulse,
  Link2,
  LogIn,
  Plus,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  computeDynamicRiskProfile,
  deleteWorkerCascade,
  evaluateFitToWork,
  getKeepAliveStatus,
  importWorkersBatch,
  sanitizeId,
  updateWorkerBandPairing,
  updateWorkerHealthProfile,
  upsertWorker,
} from '../services/jaanshieldFirestore';
import {
  ConditionLevel,
  DUTY_ZONE_OPTIONS,
  DutyZone,
  FitToWorkStatus,
  GaitBalanceStatus,
  MOUNT_OPTIONS,
  MountMode,
  WorkerConditions,
  WorkerReadiness,
  WorkerRecord,
} from '../types/band';

interface WorkerRosterPanelProps {
  user: User | null;
  authReady: boolean;
  onSignIn: () => void;
  workers: WorkerRecord[];
  selectedWorkerId: string | null;
  onSelectWorker: (workerId: string) => void;
  onMountSaved?: (workerId: string, mode: MountMode) => void;
  nowMs: number;
}

const CONDITION_STYLES: Record<
  ConditionLevel,
  { label: string; textClass: string; borderClass: string }
> = {
  normal: {
    label: 'NORMAL',
    textClass: 'text-emeraldGlow',
    borderClass: 'border-emeraldGlow/30',
  },
  caution: {
    label: 'CAUTION',
    textClass: 'text-titaniumGold',
    borderClass: 'border-titaniumGold/40',
  },
  critical: {
    label: 'CRITICAL',
    textClass: 'text-orange-400',
    borderClass: 'border-orange-500/40',
  },
  unlinked: {
    label: 'AWAITING',
    textClass: 'text-slate-400',
    borderClass: 'border-white/10',
  },
};

const FIT_BADGE_STYLES: Record<
  FitToWorkStatus,
  { label: string; badgeClass: string }
> = {
  fit_full: {
    label: 'FIT · FULL',
    badgeClass: 'bg-emeraldGlow/10 border-emeraldGlow/30 text-emeraldGlow',
  },
  shaded_only: {
    label: 'SHADED ONLY',
    badgeClass: 'bg-titaniumGold/15 border-titaniumGold/40 text-titaniumGold',
  },
  medical_hold: {
    label: 'MED HOLD',
    badgeClass: 'bg-orange-500/20 border-orange-500/50 text-orange-300',
  },
};

function parseCsvOrJsonWorkers(
  rawText: string,
): Array<{
  id: string;
  name: string;
  role?: string;
  bandId?: string;
  baselineHr?: number;
  age?: number;
}> {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { workers?: unknown[] }).workers)
        ? (parsed as { workers: unknown[] }).workers
        : [];
    return list
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        id: String(item.id || item.workerId || '').trim(),
        name: String(item.name || '').trim(),
        role: item.role ? String(item.role).trim() : undefined,
        bandId: item.bandId ? String(item.bandId).trim() : undefined,
        baselineHr: item.baselineHr !== undefined ? Number(item.baselineHr) : undefined,
        age: item.age !== undefined ? Number(item.age) : undefined,
      }))
      .filter((w) => w.id && w.name);
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const firstCells = lines[0].split(',').map((c) => c.trim().toLowerCase());
  const hasHeader = firstCells.includes('id') || firstCells.includes('name');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const idIdx = hasHeader ? Math.max(0, firstCells.indexOf('id')) : 0;
  const nameIdx = hasHeader ? Math.max(1, firstCells.indexOf('name')) : 1;
  const roleIdx = hasHeader ? firstCells.indexOf('role') : 2;
  const bandIdx = hasHeader ? firstCells.indexOf('bandid') : 3;

  return dataLines
    .map((line) => {
      const cells = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
      return {
        id: cells[idIdx] || '',
        name: cells[nameIdx] || '',
        role: roleIdx >= 0 ? cells[roleIdx] : undefined,
        bandId: bandIdx >= 0 ? cells[bandIdx] : undefined,
      };
    })
    .filter((w) => w.id && w.name);
}

export function WorkerRosterPanel({
  user,
  authReady,
  onSignIn,
  workers,
  selectedWorkerId,
  onSelectWorker,
  onMountSaved,
  nowMs,
}: WorkerRosterPanelProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImportBox, setShowImportBox] = useState(false);
  const [editingBandFor, setEditingBandFor] = useState<string | null>(null);
  const [editingProfileFor, setEditingProfileFor] = useState<string | null>(null);
  const [bandDraft, setBandDraft] = useState('');

  // Registration state (includes 1-min baseline health profile & fit-for-duty fields)
  const [workerId, setWorkerId] = useState('');
  const [workerName, setWorkerName] = useState('');
  const [workerRole, setWorkerRole] = useState('');
  const [bandId, setBandId] = useState('');
  const [ageInput, setAgeInput] = useState('32');
  const [restingBpInput, setRestingBpInput] = useState('120/80');
  const [baselineHrInput, setBaselineHrInput] = useState('74');
  const [mountInput, setMountInput] = useState<MountMode>('wrist');
  const [daysOnSiteInput, setDaysOnSiteInput] = useState('14');
  const [dutyZoneInput, setDutyZoneInput] = useState<DutyZone>('heavy_sun');
  const [gaitInput, setGaitInput] = useState<GaitBalanceStatus>('stable');
  const [shiftHoursInput, setShiftHoursInput] = useState('1.5');
  const [shiftStartHrInput, setShiftStartHrInput] = useState('');
  const [conditionsInput, setConditionsInput] = useState<WorkerConditions>({
    hypertension: false,
    diabetes: false,
    priorHeat: false,
  });
  const [readinessInput, setReadinessInput] = useState<WorkerReadiness>({
    lowSleep: false,
    sedatingMeds: false,
    dizzyOrUnwell: false,
  });

  // Inline health profile editor state
  const [pAge, setPAge] = useState('32');
  const [pBp, setPBp] = useState('120/80');
  const [pBaselineHr, setPBaselineHr] = useState('74');
  const [pMount, setPMount] = useState<MountMode>('wrist');
  const [pDaysOnSite, setPDaysOnSite] = useState('14');
  const [pDutyZone, setPDutyZone] = useState<DutyZone>('heavy_sun');
  const [pGait, setPGait] = useState<GaitBalanceStatus>('pending');
  const [pShiftHrs, setPShiftHrs] = useState('0');
  const [pStartHr, setPStartHr] = useState('');
  const [pWorkerUid, setPWorkerUid] = useState('');
  const [pConds, setPConds] = useState<WorkerConditions>({
    hypertension: false,
    diabetes: false,
    priorHeat: false,
  });
  const [pReadiness, setPReadiness] = useState<WorkerReadiness>({
    lowSleep: false,
    sedatingMeds: false,
    dizzyOrUnwell: false,
  });

  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const regPreview = useMemo(
    () =>
      computeDynamicRiskProfile({
        age: Number(ageInput || 30),
        conditions: conditionsInput,
        restingBp: restingBpInput,
        daysOnSite: Number(daysOnSiteInput || 14),
        readiness: readinessInput,
        shiftHours: Number(shiftHoursInput || 0),
        baselineHr: Number(baselineHrInput || 74),
      }),
    [ageInput, conditionsInput, restingBpInput, daysOnSiteInput, readinessInput, shiftHoursInput, baselineHrInput],
  );

  const regFitPreview = useMemo(
    () =>
      evaluateFitToWork({
        restingBp: restingBpInput,
        baselineHr: Number(baselineHrInput || 74),
        daysOnSite: Number(daysOnSiteInput || 14),
        dutyZone: dutyZoneInput,
        readiness: readinessInput,
        gaitBalance: gaitInput,
        shiftStartHr: shiftStartHrInput.trim() ? Number(shiftStartHrInput) : null,
      }),
    [restingBpInput, baselineHrInput, daysOnSiteInput, dutyZoneInput, readinessInput, gaitInput, shiftStartHrInput],
  );

  const editPreview = useMemo(
    () =>
      computeDynamicRiskProfile({
        age: Number(pAge || 30),
        conditions: pConds,
        restingBp: pBp,
        daysOnSite: Number(pDaysOnSite || 14),
        readiness: pReadiness,
        shiftHours: Number(pShiftHrs || 0),
        baselineHr: Number(pBaselineHr || 74),
      }),
    [pAge, pConds, pBp, pDaysOnSite, pReadiness, pShiftHrs, pBaselineHr],
  );

  const openHealthEditor = (w: WorkerRecord) => {
    if (editingProfileFor === w.id) {
      setEditingProfileFor(null);
      return;
    }
    setEditingProfileFor(w.id);
    setEditingBandFor(null);
    setPAge(String(w.age));
    setPBp(w.restingBp);
    setPBaselineHr(String(w.baselineHr));
    setPMount(w.mountMode);
    setPDaysOnSite(String(w.daysOnSite));
    setPDutyZone(w.dutyZone);
    setPGait(w.gaitBalance);
    setPShiftHrs(String(w.shiftHours));
    setPStartHr(w.shiftStartHr !== null ? String(w.shiftStartHr) : '');
    setPWorkerUid(w.workerUid || '');
    setPConds({ ...w.conditions });
    setPReadiness({ ...w.readiness });
  };

  const handleSaveHealthProfile = async (w: WorkerRecord) => {
    setErrorMsg(null);
    setBusy(true);
    try {
      await updateWorkerHealthProfile(w, {
        age: Number(pAge),
        restingBp: pBp,
        baselineHr: Number(pBaselineHr),
        mountMode: pMount,
        daysOnSite: Number(pDaysOnSite),
        dutyZone: pDutyZone,
        gaitBalance: pGait,
        readiness: pReadiness,
        shiftHours: Number(pShiftHrs),
        shiftStartHr: pStartHr.trim() ? Number(pStartHr) : null,
        workerUid: pWorkerUid.trim() ? pWorkerUid.trim() : null,
        conditions: pConds,
      });
      onMountSaved?.(w.id, pMount);
      setEditingProfileFor(null);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to update clinical health profile',
      );
    } finally {
      setBusy(false);
    }
  };

  const handleAddWorker = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setErrorMsg(null);
    setBusy(true);
    try {
      const savedId = await upsertWorker(
        user,
        {
          id: workerId,
          name: workerName,
          role: workerRole,
          bandId,
          age: Number(ageInput),
          restingBp: restingBpInput,
          baselineHr: Number(baselineHrInput),
          mountMode: mountInput,
          daysOnSite: Number(daysOnSiteInput),
          dutyZone: dutyZoneInput,
          gaitBalance: gaitInput,
          readiness: readinessInput,
          shiftHours: Number(shiftHoursInput),
          shiftStartHr: shiftStartHrInput.trim()
            ? Number(shiftStartHrInput)
            : null,
          conditions: conditionsInput,
        },
        workers,
      );
      onSelectWorker(savedId);
      setWorkerId('');
      setWorkerName('');
      setWorkerRole('');
      setBandId('');
      setAgeInput('32');
      setRestingBpInput('120/80');
      setBaselineHrInput('74');
      setMountInput('wrist');
      setDaysOnSiteInput('14');
      setDutyZoneInput('heavy_sun');
      setGaitInput('stable');
      setShiftHoursInput('1.5');
      setShiftStartHrInput('');
      setConditionsInput({
        hypertension: false,
        diabetes: false,
        priorHeat: false,
      });
      setReadinessInput({
        lowSleep: false,
        sedatingMeds: false,
        dizzyOrUnwell: false,
      });
      setShowAddForm(false);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not register worker in Firestore',
      );
    } finally {
      setBusy(false);
    }
  };

  const handleImportSubmit = async (rawText: string) => {
    if (!user) return;
    setErrorMsg(null);
    let parsed: ReturnType<typeof parseCsvOrJsonWorkers> = [];
    try {
      parsed = parseCsvOrJsonWorkers(rawText);
    } catch {
      setErrorMsg('Invalid JSON or CSV format');
      return;
    }

    if (parsed.length === 0) {
      setErrorMsg('No valid rows found (expected id, name, role, bandId)');
      return;
    }

    setBusy(true);
    try {
      await importWorkersBatch(user, parsed, workers);
      const firstId = sanitizeId(parsed[0].id, 32);
      if (firstId) onSelectWorker(firstId);
      setImportText('');
      setShowImportBox(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Firestore import failed');
    } finally {
      setBusy(false);
    }
  };

  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImportText(text);
    setShowImportBox(true);
    e.target.value = '';
  };

  const handleSaveBandPair = async (worker: WorkerRecord) => {
    setErrorMsg(null);
    setBusy(true);
    try {
      await updateWorkerBandPairing(worker, bandDraft, workers);
      setEditingBandFor(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update band pairing');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (targetWorkerId: string) => {
    if (!user) return;
    setErrorMsg(null);
    try {
      await deleteWorkerCascade(user, targetWorkerId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to remove worker');
    }
  };

  return (
    <section className="glass-panel p-4 rounded-3xl border border-white/10 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-emeraldGlow" aria-hidden="true" />
          <h3 className="text-xs font-mono font-bold tracking-wider uppercase text-white">
            Worker-Band Registry &amp; Health Baseline
          </h3>
          <span className="text-[11px] font-mono tabular-nums text-slate-400">
            ({workers.length})
          </span>
        </div>

        {user && (
          <div className="flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json,text/csv,application/json"
              className="hidden"
              onChange={handleFilePicked}
            />
            <button
              type="button"
              onClick={() => {
                setShowImportBox((v) => !v);
                setShowAddForm(false);
                setErrorMsg(null);
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-obsidian-800 border border-white/10 text-[11px] font-medium text-slate-200 hover:border-white/20 transition-colors cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-titaniumGold" aria-hidden="true" />
              <span>Import CSV/JSON</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setShowAddForm((v) => !v);
                setShowImportBox(false);
                setErrorMsg(null);
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-emeraldGlow/15 border border-emeraldGlow/35 text-[11px] font-medium text-emeraldGlow hover:bg-emeraldGlow/20 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Register Worker</span>
            </button>
          </div>
        )}
      </div>

      {errorMsg && (
        <div className="p-2.5 rounded-xl bg-orange-500/10 border border-orange-500/30 text-xs text-orange-300 flex items-center justify-between gap-2">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-orange-300 hover:text-white cursor-pointer"
            aria-label="Dismiss error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {!user ? (
        <div className="p-5 rounded-2xl bg-obsidian-900/75 border border-dashed border-emeraldGlow/25 text-center space-y-3">
          <LogIn className="w-6 h-6 text-emeraldGlow mx-auto" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-xs font-semibold text-white">
              {authReady
                ? 'Sign in to connect shared Firestore sync'
                : 'Initializing Firebase Auth...'}
            </p>
            <p className="text-[11px] text-slate-400 max-w-sm mx-auto leading-relaxed">
              Sign in with Google to sync real JaanShield workers, baseline health
              profiles, MQ-3 gate checks, and live JaanBand telemetry.
            </p>
          </div>
          {authReady && (
            <button
              type="button"
              onClick={onSignIn}
              className="px-4 py-2 rounded-xl bg-emeraldGlow text-obsidian-950 font-semibold text-xs inline-flex items-center gap-2 hover:brightness-105 cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Sign in with Google</span>
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Single Worker Registration + 1-Minute Baseline Health Check */}
          {showAddForm && (
            <form
              onSubmit={handleAddWorker}
              className="p-3 rounded-2xl bg-obsidian-950/95 border border-white/10 space-y-2.5"
            >
              <div className="flex items-center justify-between text-[11px] flex-wrap gap-1">
                <span className="font-mono uppercase tracking-wider text-emeraldGlow">
                  1-Min Onboarding &amp; Fit-to-Work Gate
                </span>
                <span className="font-mono tabular-nums text-titaniumGold">
                  Rf {regPreview.riskFactor.toFixed(2)} · Crit {regPreview.thresholds.hrR} BPM ·{' '}
                  {FIT_BADGE_STYLES[regFitPreview.status].label}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  required
                  maxLength={32}
                  value={workerId}
                  onChange={(e) => setWorkerId(e.target.value)}
                  placeholder="Worker ID (e.g. W14)"
                  className="w-full px-3 py-2 rounded-xl bg-obsidian-900 border border-white/10 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-emeraldGlow"
                />
                <input
                  type="text"
                  required
                  maxLength={80}
                  value={workerName}
                  onChange={(e) => setWorkerName(e.target.value)}
                  placeholder="Worker Full Name"
                  className="w-full px-3 py-2 rounded-xl bg-obsidian-900 border border-white/10 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-emeraldGlow"
                />
                <input
                  type="text"
                  maxLength={60}
                  value={workerRole}
                  onChange={(e) => setWorkerRole(e.target.value)}
                  placeholder="Site Role (e.g. Mason, Scaffolder)"
                  className="w-full px-3 py-2 rounded-xl bg-obsidian-900 border border-white/10 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-emeraldGlow"
                />
                <input
                  type="text"
                  maxLength={48}
                  value={bandId}
                  onChange={(e) => setBandId(e.target.value)}
                  placeholder="Band ID (e.g. JB-MK4-W14)"
                  className="w-full px-3 py-2 rounded-xl bg-obsidian-900 border border-white/10 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-emeraldGlow"
                />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <label className="space-y-1">
                  <span className="block text-[10px] font-mono text-slate-400">Age</span>
                  <input
                    type="number"
                    min={18}
                    max={85}
                    value={ageInput}
                    onChange={(e) => setAgeInput(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[10px] font-mono text-slate-400">Rest BP</span>
                  <input
                    type="text"
                    value={restingBpInput}
                    onChange={(e) => setRestingBpInput(e.target.value)}
                    placeholder="120/80"
                    className="w-full px-2.5 py-1.5 rounded-lg bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[10px] font-mono text-slate-400">Rest BPM</span>
                  <input
                    type="number"
                    min={40}
                    max={140}
                    value={baselineHrInput}
                    onChange={(e) => setBaselineHrInput(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[10px] font-mono text-slate-400">8AM HR</span>
                  <input
                    type="number"
                    min={30}
                    max={200}
                    value={shiftStartHrInput}
                    onChange={(e) => setShiftStartHrInput(e.target.value)}
                    placeholder="e.g. 74"
                    className="w-full px-2.5 py-1.5 rounded-lg bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[10px] font-mono text-slate-400">Mount</span>
                  <select
                    value={mountInput}
                    onChange={(e) => setMountInput(e.target.value as MountMode)}
                    className="w-full px-2 py-1.5 rounded-lg bg-obsidian-900 border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-emeraldGlow"
                  >
                    {MOUNT_OPTIONS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.shortLabel}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-[10px] font-mono text-slate-400">Duty Zone</span>
                  <select
                    value={dutyZoneInput}
                    onChange={(e) => setDutyZoneInput(e.target.value as DutyZone)}
                    className="w-full px-2 py-1.5 rounded-lg bg-obsidian-900 border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-emeraldGlow"
                  >
                    {DUTY_ZONE_OPTIONS.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.shortLabel}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-[10px] font-mono text-slate-400">Site Days</span>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={daysOnSiteInput}
                    onChange={(e) => setDaysOnSiteInput(e.target.value)}
                    title="<7 days triggers OSHA/NIOSH heat acclimatization guard"
                    className="w-full px-2.5 py-1.5 rounded-lg bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white focus:outline-none focus:border-emeraldGlow"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[10px] font-mono text-slate-400">5s Gait IMU</span>
                  <select
                    value={gaitInput}
                    onChange={(e) => setGaitInput(e.target.value as GaitBalanceStatus)}
                    className="w-full px-2 py-1.5 rounded-lg bg-obsidian-900 border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-emeraldGlow"
                  >
                    <option value="stable">Stable</option>
                    <option value="pending">Pending</option>
                    <option value="sway">Sway</option>
                  </select>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-slate-300">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={conditionsInput.hypertension}
                    onChange={(e) =>
                      setConditionsInput((c) => ({ ...c, hypertension: e.target.checked }))
                    }
                    className="accent-emeraldGlow"
                  />
                  <span>Hypertension</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={conditionsInput.diabetes}
                    onChange={(e) =>
                      setConditionsInput((c) => ({ ...c, diabetes: e.target.checked }))
                    }
                    className="accent-emeraldGlow"
                  />
                  <span>Diabetes</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={conditionsInput.priorHeat}
                    onChange={(e) =>
                      setConditionsInput((c) => ({ ...c, priorHeat: e.target.checked }))
                    }
                    className="accent-emeraldGlow"
                  />
                  <span>Prior Heat</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-sky-300">
                  <input
                    type="checkbox"
                    checked={readinessInput.lowSleep}
                    onChange={(e) =>
                      setReadinessInput((r) => ({ ...r, lowSleep: e.target.checked }))
                    }
                    className="accent-sky-400"
                  />
                  <span>&lt;5h Sleep</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-sky-300">
                  <input
                    type="checkbox"
                    checked={readinessInput.sedatingMeds}
                    onChange={(e) =>
                      setReadinessInput((r) => ({ ...r, sedatingMeds: e.target.checked }))
                    }
                    className="accent-sky-400"
                  />
                  <span>Sedating Meds</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer text-orange-300">
                  <input
                    type="checkbox"
                    checked={readinessInput.dizzyOrUnwell}
                    onChange={(e) =>
                      setReadinessInput((r) => ({ ...r, dizzyOrUnwell: e.target.checked }))
                    }
                    className="accent-orange-400"
                  />
                  <span>Dizzy / Unwell</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="px-3 py-1.5 rounded-xl text-xs text-slate-400 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-3.5 py-1.5 rounded-xl bg-emeraldGlow text-obsidian-950 font-semibold text-xs hover:brightness-105 disabled:opacity-60 cursor-pointer"
                >
                  {busy ? 'Saving...' : 'Save & Pair Band'}
                </button>
              </div>
            </form>
          )}

          {/* Bulk CSV / JSON Import Box */}
          {showImportBox && (
            <div className="p-3 rounded-2xl bg-obsidian-950/90 border border-white/10 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-slate-300">
                  Paste CSV (<code className="font-mono text-emeraldGlow">id,name,role,bandId</code>) or JSON exported from JaanShield
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-[11px] font-mono text-titaniumGold hover:underline cursor-pointer shrink-0"
                >
                  Choose File
                </button>
              </div>
              <textarea
                rows={4}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={'id,name,role,bandId\nW01,Ramesh Patel,Mason,JB-MK4-W01'}
                className="w-full px-3 py-2 rounded-xl bg-obsidian-900 border border-white/10 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-emeraldGlow"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowImportBox(false)}
                  className="px-3 py-1.5 rounded-xl text-xs text-slate-400 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || !importText.trim()}
                  onClick={() => handleImportSubmit(importText)}
                  className="px-3.5 py-1.5 rounded-xl bg-titaniumGold text-obsidian-950 font-semibold text-xs hover:brightness-105 disabled:opacity-60 cursor-pointer"
                >
                  {busy ? 'Importing...' : 'Import & Pair Bands'}
                </button>
              </div>
            </div>
          )}

          {/* Empty State — Zero Dummy Data */}
          {workers.length === 0 ? (
            <div className="p-5 rounded-2xl bg-obsidian-900/70 border border-dashed border-white/10 text-center space-y-2">
              <UserPlus className="w-6 h-6 text-slate-400 mx-auto" aria-hidden="true" />
              <p className="text-xs font-semibold text-slate-200">
                No workers synced in Firestore yet
              </p>
              <p className="text-[11px] text-slate-400 max-w-sm mx-auto leading-relaxed">
                Register a worker above, import a CSV/JSON roster, or write workers to
                Firestore collection <code className="font-mono text-emeraldGlow">workers</code>{' '}
                from JaanShield.
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[340px] overflow-y-auto pr-0.5">
              {workers.map((w) => {
                const isSelected = w.id === selectedWorkerId;
                const cond = CONDITION_STYLES[w.condition];
                const fitBadge = FIT_BADGE_STYLES[w.fitStatus];
                const isEditingBand = editingBandFor === w.id;
                const isEditingProfile = editingProfileFor === w.id;
                const ka = getKeepAliveStatus(w, nowMs);
                const isDisc = ka.state === 'disconnected';
                const zoneLabel =
                  DUTY_ZONE_OPTIONS.find((z) => z.id === w.dutyZone)?.shortLabel ??
                  'Heavy Sun';

                return (
                  <div
                    key={w.id}
                    className={`p-2.5 rounded-xl border transition-colors ${
                      isDisc
                        ? 'bg-orange-950/30 border-orange-500/50'
                        : isSelected
                          ? 'bg-obsidian-900 border-emeraldGlow/40'
                          : 'bg-obsidian-900/70 border-white/5 hover:border-white/15'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onSelectWorker(w.id)}
                        className="flex-1 text-left min-w-0 cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-mono font-bold text-white">
                            {w.id}
                          </span>
                          <span className="text-xs font-semibold text-slate-100 truncate">
                            {w.name}
                          </span>
                          <span className="text-[11px] text-slate-400 truncate">
                            · {w.role} · {w.age}y
                          </span>
                          <span
                            className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${fitBadge.badgeClass}`}
                          >
                            {fitBadge.label}
                          </span>
                          {w.daysOnSite < 7 && (
                            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-400/35 text-sky-300">
                              DAY {w.daysOnSite} (&lt;7D)
                            </span>
                          )}
                          {w.mq3Status === 'flagged' && (
                            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-orange-500/15 border border-orange-500/40 text-orange-300">
                              BREATH FLAG
                            </span>
                          )}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-mono tabular-nums text-slate-400">
                          <span className="text-slate-300">
                            {w.mountMode.toUpperCase()} · {zoneLabel} · {w.bandId || 'Unpaired'}
                          </span>
                          <span className="text-titaniumGold">
                            Crit {w.dynamicHrR} bpm (Rf {w.riskFactor.toFixed(2)})
                          </span>
                          {w.lastReport ? (
                            <span>
                              {w.lastReport.bpm} bpm · {w.lastReport.spo2.toFixed(0)}% ·{' '}
                              {w.lastReport.skinTempC.toFixed(1)}°C
                            </span>
                          ) : (
                            <span>No report yet</span>
                          )}
                        </div>
                      </button>

                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.5 rounded bg-obsidian-950 border ${
                            isDisc
                              ? 'border-orange-500/60 text-orange-300'
                              : `${cond.borderClass} ${cond.textClass}`
                          }`}
                        >
                          {isDisc ? 'DISC FAIL' : cond.label}
                        </span>

                        <button
                          type="button"
                          onClick={() => openHealthEditor(w)}
                          className={`w-7 h-7 rounded-lg bg-obsidian-950 border flex items-center justify-center cursor-pointer ${
                            isEditingProfile
                              ? 'border-emeraldGlow/50 text-emeraldGlow'
                              : 'border-white/10 text-slate-400 hover:text-emeraldGlow'
                          }`}
                          title="Edit Health Baseline Profile & Mount"
                          aria-label={`Edit health profile for ${w.name}`}
                        >
                          <HeartPulse className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setEditingBandFor(isEditingBand ? null : w.id);
                            setEditingProfileFor(null);
                            setBandDraft(w.bandId);
                          }}
                          className="w-7 h-7 rounded-lg bg-obsidian-950 border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer"
                          title="Edit paired JaanBand ID"
                          aria-label={`Pair band for ${w.name}`}
                        >
                          <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDelete(w.id)}
                          className="w-7 h-7 rounded-lg bg-obsidian-950 border border-white/10 flex items-center justify-center text-slate-400 hover:text-orange-400 cursor-pointer"
                          title="Remove worker"
                          aria-label={`Remove ${w.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    {isDisc && (
                      <div className="mt-2 px-2 py-1 rounded-lg bg-orange-500/15 border border-orange-500/40 flex items-center gap-1.5 text-[11px] font-mono text-orange-200">
                        <AlertTriangle className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                        <span className="truncate">{ka.reason}</span>
                      </div>
                    )}

                    {isEditingBand && (
                      <div className="mt-2 pt-2 border-t border-white/5 flex items-center gap-2">
                        <input
                          type="text"
                          maxLength={48}
                          value={bandDraft}
                          onChange={(e) => setBandDraft(e.target.value)}
                          placeholder="Enter JaanBand ID"
                          className="flex-1 px-2.5 py-1.5 rounded-lg bg-obsidian-950 border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-emeraldGlow"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleSaveBandPair(w)}
                          className="px-2.5 py-1.5 rounded-lg bg-emeraldGlow text-obsidian-950 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Pair</span>
                        </button>
                      </div>
                    )}

                    {/* Inline Health Profile, Duty Zone & Fit-to-Work Editor Drawer */}
                    {isEditingProfile && (
                      <div className="mt-2 pt-2.5 border-t border-white/10 space-y-2 bg-obsidian-950/75 p-2.5 rounded-xl">
                        <div className="flex items-center justify-between text-[10px] font-mono">
                          <span className="text-emeraldGlow uppercase">
                            Health &amp; Fit-to-Work · {w.id}
                          </span>
                          <span className="text-titaniumGold tabular-nums">
                            Rf {editPreview.riskFactor.toFixed(2)} · Crit{' '}
                            {editPreview.thresholds.hrR} BPM
                          </span>
                        </div>

                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                          <label className="space-y-0.5">
                            <span className="block text-[9px] font-mono text-slate-400">
                              Age
                            </span>
                            <input
                              type="number"
                              min={18}
                              max={85}
                              value={pAge}
                              onChange={(e) => setPAge(e.target.value)}
                              className="w-full px-2 py-1 rounded bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white"
                            />
                          </label>
                          <label className="space-y-0.5">
                            <span className="block text-[9px] font-mono text-slate-400">
                              Rest BP
                            </span>
                            <input
                              type="text"
                              value={pBp}
                              onChange={(e) => setPBp(e.target.value)}
                              className="w-full px-2 py-1 rounded bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white"
                            />
                          </label>
                          <label className="space-y-0.5">
                            <span className="block text-[9px] font-mono text-slate-400">
                              Rest BPM
                            </span>
                            <input
                              type="number"
                              min={40}
                              max={140}
                              value={pBaselineHr}
                              onChange={(e) => setPBaselineHr(e.target.value)}
                              className="w-full px-2 py-1 rounded bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white"
                            />
                          </label>
                          <label className="space-y-0.5">
                            <span className="block text-[9px] font-mono text-slate-400">
                              Shift Hr
                            </span>
                            <input
                              type="number"
                              step="0.5"
                              min={0}
                              max={24}
                              value={pShiftHrs}
                              onChange={(e) => setPShiftHrs(e.target.value)}
                              className="w-full px-2 py-1 rounded bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white"
                            />
                          </label>
                          <label className="space-y-0.5">
                            <span className="block text-[9px] font-mono text-slate-400">
                              8AM HR
                            </span>
                            <input
                              type="number"
                              min={30}
                              max={200}
                              value={pStartHr}
                              onChange={(e) => setPStartHr(e.target.value)}
                              placeholder="--"
                              className="w-full px-2 py-1 rounded bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white"
                            />
                          </label>
                          <label className="space-y-0.5">
                            <span className="block text-[9px] font-mono text-slate-400">
                              Mount
                            </span>
                            <select
                              value={pMount}
                              onChange={(e) => setPMount(e.target.value as MountMode)}
                              className="w-full px-1.5 py-1 rounded bg-obsidian-900 border border-white/10 text-xs font-mono text-white"
                            >
                              {MOUNT_OPTIONS.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.shortLabel}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="space-y-0.5">
                            <span className="block text-[9px] font-mono text-slate-400">
                              Duty Zone
                            </span>
                            <select
                              value={pDutyZone}
                              onChange={(e) => setPDutyZone(e.target.value as DutyZone)}
                              className="w-full px-1.5 py-1 rounded bg-obsidian-900 border border-white/10 text-xs font-mono text-white"
                            >
                              {DUTY_ZONE_OPTIONS.map((z) => (
                                <option key={z.id} value={z.id}>
                                  {z.shortLabel}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="space-y-0.5">
                            <span className="block text-[9px] font-mono text-slate-400">
                              Site Days
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={3650}
                              value={pDaysOnSite}
                              onChange={(e) => setPDaysOnSite(e.target.value)}
                              className="w-full px-2 py-1 rounded bg-obsidian-900 border border-white/10 text-xs font-mono tabular-nums text-white"
                            />
                          </label>
                          <label className="space-y-0.5 col-span-2">
                            <span className="block text-[9px] font-mono text-slate-400">
                              5s Gait IMU
                            </span>
                            <select
                              value={pGait}
                              onChange={(e) => setPGait(e.target.value as GaitBalanceStatus)}
                              className="w-full px-1.5 py-1 rounded bg-obsidian-900 border border-white/10 text-xs font-mono text-white"
                            >
                              <option value="pending">Pending</option>
                              <option value="stable">Stable (Pass)</option>
                              <option value="sway">Postural Sway (Flag)</option>
                            </select>
                          </label>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            maxLength={128}
                            value={pWorkerUid}
                            onChange={(e) => setPWorkerUid(e.target.value)}
                            placeholder="Optional JaanSaathi Worker UID (for private wellbeing Rf sync)"
                            className="flex-1 px-2 py-1 rounded bg-obsidian-900 border border-white/10 text-[11px] font-mono text-white placeholder:text-slate-500"
                          />
                          {user && (
                            <button
                              type="button"
                              onClick={() => setPWorkerUid(user.uid)}
                              className="px-2 py-1 rounded bg-obsidian-900 border border-white/10 text-[10px] font-mono text-emeraldGlow hover:border-emeraldGlow/40 cursor-pointer shrink-0"
                            >
                              Use My UID
                            </button>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-slate-300">
                            <label className="inline-flex items-center gap-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={pConds.hypertension}
                                onChange={(e) =>
                                  setPConds((c) => ({
                                    ...c,
                                    hypertension: e.target.checked,
                                  }))
                                }
                                className="accent-emeraldGlow"
                              />
                              <span>HTN</span>
                            </label>
                            <label className="inline-flex items-center gap-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={pConds.diabetes}
                                onChange={(e) =>
                                  setPConds((c) => ({
                                    ...c,
                                    diabetes: e.target.checked,
                                  }))
                                }
                                className="accent-emeraldGlow"
                              />
                              <span>DM</span>
                            </label>
                            <label className="inline-flex items-center gap-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={pConds.priorHeat}
                                onChange={(e) =>
                                  setPConds((c) => ({
                                    ...c,
                                    priorHeat: e.target.checked,
                                  }))
                                }
                                className="accent-emeraldGlow"
                              />
                              <span>Prior Heat</span>
                            </label>
                            <label className="inline-flex items-center gap-1 cursor-pointer text-sky-300">
                              <input
                                type="checkbox"
                                checked={pReadiness.lowSleep}
                                onChange={(e) =>
                                  setPReadiness((r) => ({
                                    ...r,
                                    lowSleep: e.target.checked,
                                  }))
                                }
                                className="accent-sky-400"
                              />
                              <span>&lt;5h Sleep</span>
                            </label>
                            <label className="inline-flex items-center gap-1 cursor-pointer text-sky-300">
                              <input
                                type="checkbox"
                                checked={pReadiness.sedatingMeds}
                                onChange={(e) =>
                                  setPReadiness((r) => ({
                                    ...r,
                                    sedatingMeds: e.target.checked,
                                  }))
                                }
                                className="accent-sky-400"
                              />
                              <span>Drowsy Meds</span>
                            </label>
                            <label className="inline-flex items-center gap-1 cursor-pointer text-orange-300">
                              <input
                                type="checkbox"
                                checked={pReadiness.dizzyOrUnwell}
                                onChange={(e) =>
                                  setPReadiness((r) => ({
                                    ...r,
                                    dizzyOrUnwell: e.target.checked,
                                  }))
                                }
                                className="accent-orange-400"
                              />
                              <span>Dizzy</span>
                            </label>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditingProfileFor(null)}
                              className="px-2 py-1 rounded text-[11px] text-slate-400 hover:text-white cursor-pointer"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleSaveHealthProfile(w)}
                              className="px-2.5 py-1 rounded-lg bg-emeraldGlow text-obsidian-950 text-[11px] font-semibold cursor-pointer"
                            >
                              Save Profile
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

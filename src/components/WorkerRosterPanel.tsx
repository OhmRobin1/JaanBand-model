import { useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Check,
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
  deleteWorkerCascade,
  importWorkersBatch,
  sanitizeId,
  updateWorkerBandPairing,
  upsertWorker,
} from '../services/jaanshieldFirestore';
import { ConditionLevel, WorkerRecord } from '../types/band';

interface WorkerRosterPanelProps {
  user: User | null;
  authReady: boolean;
  onSignIn: () => void;
  workers: WorkerRecord[];
  selectedWorkerId: string | null;
  onSelectWorker: (workerId: string) => void;
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

function parseCsvOrJsonWorkers(
  rawText: string,
): Array<{ id: string; name: string; role?: string; bandId?: string; baselineHr?: number }> {
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
}: WorkerRosterPanelProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImportBox, setShowImportBox] = useState(false);
  const [editingBandFor, setEditingBandFor] = useState<string | null>(null);
  const [bandDraft, setBandDraft] = useState('');

  const [workerId, setWorkerId] = useState('');
  const [workerName, setWorkerName] = useState('');
  const [workerRole, setWorkerRole] = useState('');
  const [bandId, setBandId] = useState('');
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
        },
        workers,
      );
      onSelectWorker(savedId);
      setWorkerId('');
      setWorkerName('');
      setWorkerRole('');
      setBandId('');
      setShowAddForm(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not register worker in Firestore');
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
            Worker-Band Registry
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
              {authReady ? 'Sign in to connect shared Firestore sync' : 'Initializing Firebase Auth...'}
            </p>
            <p className="text-[11px] text-slate-400 max-w-sm mx-auto leading-relaxed">
              Sign in with Google to sync real JaanShield workers and live JaanBand readings across both JaanBand and JaanShield.
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
          {/* Single Worker Registration & Band Pairing Form */}
          {showAddForm && (
            <form
              onSubmit={handleAddWorker}
              className="p-3 rounded-2xl bg-obsidian-950/90 border border-white/10 space-y-2.5"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  required
                  maxLength={32}
                  value={workerId}
                  onChange={(e) => setWorkerId(e.target.value)}
                  placeholder="Worker ID (e.g. W01)"
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
                  placeholder="Site Role (e.g. Mason, Welder)"
                  className="w-full px-3 py-2 rounded-xl bg-obsidian-900 border border-white/10 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-emeraldGlow"
                />
                <input
                  type="text"
                  maxLength={48}
                  value={bandId}
                  onChange={(e) => setBandId(e.target.value)}
                  placeholder="Band ID (e.g. JB-MK4-W01)"
                  className="w-full px-3 py-2 rounded-xl bg-obsidian-900 border border-white/10 text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none focus:border-emeraldGlow"
                />
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
                Register a worker above, import a CSV/JSON roster, or write workers to Firestore collection{' '}
                <code className="font-mono text-emeraldGlow">workers</code> from JaanShield.
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[260px] overflow-y-auto pr-0.5">
              {workers.map((w) => {
                const isSelected = w.id === selectedWorkerId;
                const cond = CONDITION_STYLES[w.condition];
                const isEditingBand = editingBandFor === w.id;

                return (
                  <div
                    key={w.id}
                    className={`p-2.5 rounded-xl border transition-colors ${
                      isSelected
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
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-mono font-bold text-white">
                            {w.id}
                          </span>
                          <span className="text-xs font-semibold text-slate-100 truncate">
                            {w.name}
                          </span>
                          <span className="text-[11px] text-slate-400 truncate">
                            · {w.role}
                          </span>
                        </div>

                        <div className="mt-1 flex items-center gap-3 text-[11px] font-mono tabular-nums text-slate-400">
                          <span className="text-slate-300">
                            Band: {w.bandId || 'Unpaired'}
                          </span>
                          {w.lastReport ? (
                            <span>
                              {w.lastReport.bpm} bpm · {w.lastReport.spo2.toFixed(0)}% ·{' '}
                              {w.lastReport.skinTempC.toFixed(1)}°C
                            </span>
                          ) : (
                            <span>No report received</span>
                          )}
                        </div>
                      </button>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.5 rounded bg-obsidian-950 border ${cond.borderClass} ${cond.textClass}`}
                        >
                          {cond.label}
                        </span>

                        <button
                          type="button"
                          onClick={() => {
                            setEditingBandFor(isEditingBand ? null : w.id);
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

import { CheckCircle2, Loader2, ShieldCheck, X } from 'lucide-react';
import { DiagnosticCheckItem } from '../types/band';

interface DiagnosticPanelProps {
  checks: DiagnosticCheckItem[];
  isRunning: boolean;
  completedAt: string | null;
  onClose: () => void;
  onRerun: () => void;
}

export function DiagnosticPanel({
  checks,
  isRunning,
  completedAt,
  onClose,
  onRerun,
}: DiagnosticPanelProps) {
  return (
    <section
      aria-label="Diagnostic Telemetry Check Results"
      className="glass-panel rounded-3xl p-4 border border-emeraldGlow/25 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emeraldGlow" aria-hidden="true" />
          <h4 className="text-xs font-mono font-bold tracking-wider uppercase text-white">
            {isRunning ? 'Running Telemetry Calibration' : 'Diagnostic Verification Passed'}
          </h4>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-7 h-7 rounded-full bg-obsidian-800 border border-white/10 flex items-center justify-center text-slate-400 hover:text-white transition-colors cursor-pointer"
          aria-label="Close diagnostic panel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-2">
        {checks.map((item) => (
          <div
            key={item.id}
            className="p-2.5 rounded-xl bg-obsidian-900/80 border border-white/5 flex items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {item.status === 'passed' ? (
                <CheckCircle2 className="w-4 h-4 text-emeraldGlow shrink-0" aria-hidden="true" />
              ) : item.status === 'running' ? (
                <Loader2 className="w-4 h-4 text-sky-400 animate-spin shrink-0" aria-hidden="true" />
              ) : (
                <span className="w-4 h-4 rounded-full border border-slate-600 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-200 truncate">{item.label}</p>
                <p className="text-[11px] text-slate-400 truncate">{item.detail}</p>
              </div>
            </div>

            <span
              className={`text-[10px] font-mono tabular-nums px-2 py-0.5 rounded bg-obsidian-950 whitespace-nowrap shrink-0 ${
                item.status === 'passed'
                  ? 'text-emeraldGlow'
                  : item.status === 'running'
                    ? 'text-sky-400'
                    : 'text-slate-400'
              }`}
            >
              {item.status === 'pending' ? 'QUEUED' : item.metric}
            </span>
          </div>
        ))}
      </div>

      {!isRunning && completedAt && (
        <div className="flex items-center justify-between pt-1 text-[11px] font-mono text-slate-400">
          <span>Verified at {completedAt}</span>
          <button
            type="button"
            onClick={onRerun}
            className="text-emeraldGlow hover:underline cursor-pointer"
          >
            Re-run Check
          </button>
        </div>
      )}
    </section>
  );
}

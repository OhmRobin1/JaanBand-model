import { useEffect, useRef } from 'react';
import { ConditionLevel } from '../types/band';

interface LiveTelemetryWaveProps {
  bpm: number | null;
  condition: ConditionLevel;
  isDiagnosing: boolean;
  mode: 'ppg' | 'thermal';
}

export function LiveTelemetryWave({
  bpm,
  condition,
  isDiagnosing,
  mode,
}: LiveTelemetryWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({ bpm, condition, isDiagnosing, mode });
  propsRef.current = { bpm, condition, isDiagnosing, mode };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    let rafId = 0;
    let phase = 0;
    let lastTime = performance.now();

    const draw = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      const {
        bpm: curBpm,
        condition: curCondition,
        isDiagnosing: diagnosing,
        mode: curMode,
      } = propsRef.current;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.clientWidth || 320;
      const height = canvas.clientHeight || 68;
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      // Subtle reference grid
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      for (let x = 0; x < width; x += 28) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(0, height * 0.58);
      ctx.lineTo(width, height * 0.58);
      ctx.stroke();

      const hasSignal = curBpm !== null && curBpm > 0;

      if (hasSignal && !prefersReducedMotion) {
        const beatHz = curBpm / 60;
        phase += dt * beatHz * (diagnosing ? 1.45 : 1.0);
      }

      const strokeColor = !hasSignal
        ? '#475569'
        : diagnosing
          ? '#38bdf8'
          : curCondition === 'critical'
            ? '#f97316'
            : curCondition === 'caution' || curMode === 'thermal'
              ? '#e3a72f'
              : '#00e599';

      ctx.beginPath();
      const samples = 120;
      const midY = height * 0.58;

      for (let i = 0; i <= samples; i++) {
        const u = i / samples;
        const x = u * width;
        let y = midY;

        if (hasSignal) {
          if (curMode === 'ppg') {
            const t = (u * 2.4 - phase) % 1;
            const cyc = t < 0 ? t + 1 : t;
            const systolic = Math.exp(-Math.pow((cyc - 0.22) / 0.048, 2)) * 22;
            const dicrotic = Math.exp(-Math.pow((cyc - 0.38) / 0.065, 2)) * 9;
            const pWave = Math.exp(-Math.pow((cyc - 0.11) / 0.04, 2)) * 4;
            const baseline = Math.sin(u * Math.PI * 4 + phase * 2) * 1.4;
            y = midY - systolic - dicrotic + pWave + baseline;
          } else {
            const drift =
              Math.sin(u * Math.PI * 3.2 - phase * 1.8) * 10 +
              Math.cos(u * Math.PI * 7.5 - phase * 0.9) * 4;
            y = height * 0.5 + drift;
          }
        }

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = hasSignal ? 2 : 1.25;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();

      if (hasSignal) {
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(
          0,
          diagnosing
            ? 'rgba(56, 189, 248, 0.20)'
            : curCondition === 'critical'
              ? 'rgba(249, 115, 22, 0.22)'
              : curCondition === 'caution' || curMode === 'thermal'
                ? 'rgba(227, 167, 47, 0.18)'
                : 'rgba(0, 229, 153, 0.20)',
        );
        grad.addColorStop(1, 'rgba(4, 7, 9, 0.0)');
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.restore();

      if (hasSignal && !prefersReducedMotion) {
        rafId = requestAnimationFrame(draw);
      }
    };

    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [bpm, condition, isDiagnosing, mode]);

  return (
    <div className="relative w-full h-[68px] rounded-xl bg-obsidian-950/90 border border-white/5 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full block"
        aria-label={
          bpm === null
            ? 'Flat baseline awaiting live biometric report'
            : mode === 'ppg'
              ? 'Live arterial PPG biometric waveform'
              : 'Sub-epidermal temperature circadian flux graph'
        }
      />
      <div className="pointer-events-none absolute top-1.5 right-2 text-[10px] font-mono tabular-nums text-slate-400">
        {bpm === null ? 'NO SIGNAL' : mode === 'ppg' ? '100 Hz PPG' : '±0.05 °C'}
      </div>
    </div>
  );
}

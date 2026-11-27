import { Volume2, VolumeX } from 'lucide-react';
import { BuddyMood } from '../types';

interface CartoonWorkerBuddyProps {
  mood: BuddyMood;
  isThinking: boolean;
  message: string;
  languageName: string;
  speechEnabled: boolean;
  onToggleSpeech: () => void;
  onSpeakCurrent: () => void;
}

const MOOD_COLORS: Record<
  BuddyMood,
  { ring: string; glow: string; badge: string; label: string }
> = {
  warm: {
    ring: 'border-emeraldGlow/40',
    glow: 'from-emeraldGlow/20 via-amber-400/10 to-transparent',
    badge: 'bg-emeraldGlow/15 text-emeraldGlow border-emeraldGlow/35',
    label: 'Friendly Saathi',
  },
  listening: {
    ring: 'border-sky-400/45',
    glow: 'from-sky-400/20 via-emeraldGlow/10 to-transparent',
    badge: 'bg-sky-500/15 text-sky-300 border-sky-400/35',
    label: 'Listening Closely',
  },
  encouraging: {
    ring: 'border-emeraldGlow/55',
    glow: 'from-emeraldGlow/25 via-teal-400/10 to-transparent',
    badge: 'bg-emeraldGlow/15 text-emeraldGlow border-emeraldGlow/40',
    label: 'Cheering You On',
  },
  caring: {
    ring: 'border-titaniumGold/55',
    glow: 'from-titaniumGold/25 via-amber-500/10 to-transparent',
    badge: 'bg-titaniumGold/15 text-titaniumGold border-titaniumGold/40',
    label: 'Here For You',
  },
  alert: {
    ring: 'border-orange-500/55',
    glow: 'from-orange-500/25 via-amber-500/10 to-transparent',
    badge: 'bg-orange-500/20 text-orange-300 border-orange-500/45',
    label: 'Rest & Care Advised',
  },
};

export function CartoonWorkerBuddy({
  mood,
  isThinking,
  message,
  languageName,
  speechEnabled,
  onToggleSpeech,
  onSpeakCurrent,
}: CartoonWorkerBuddyProps) {
  const palette = MOOD_COLORS[mood] ?? MOOD_COLORS.warm;

  const mouthPath =
    mood === 'encouraging' || mood === 'warm'
      ? 'M 69 78 Q 80 87 91 78'
      : mood === 'caring'
        ? 'M 71 80 Q 80 83 89 80'
        : mood === 'alert'
          ? 'M 71 82 Q 80 77 89 82'
          : 'M 73 79 Q 80 81 87 79';

  const leftBrowY = mood === 'caring' || mood === 'alert' ? 54 : 56;
  const rightBrowY = mood === 'caring' || mood === 'alert' ? 54 : 56;

  return (
    <div
      className={`relative rounded-3xl p-4 sm:p-5 bg-gradient-to-br ${palette.glow} bg-obsidian-900/90 border ${palette.ring} shadow-xl overflow-hidden`}
    >
      <style>{`
        @keyframes buddyFloat {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-4px); }
        }
        @keyframes buddyBlink {
          0%, 44%, 48%, 94%, 98%, 100% { transform: scaleY(1); }
          46%, 96% { transform: scaleY(0.12); }
        }
        @keyframes buddyWaveHand {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(-10deg); }
        }
      `}</style>

      <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4">
        <div className="relative shrink-0 flex flex-col items-center">
          <div
            style={{ animation: 'buddyFloat 3.4s ease-in-out infinite' }}
            className="w-32 h-32 sm:w-36 sm:h-36 rounded-3xl bg-obsidian-950/90 border border-white/10 flex items-center justify-center shadow-inner"
          >
            <svg viewBox="0 0 160 160" className="w-full h-full" role="img" aria-label="JaanSaathi buddy">
              <defs>
                <linearGradient id="helmetGradStandalone" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#facc15" />
                  <stop offset="100%" stopColor="#eab308" />
                </linearGradient>
                <linearGradient id="vestGradStandalone" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f97316" />
                  <stop offset="100%" stopColor="#ea580c" />
                </linearGradient>
              </defs>

              <circle
                cx="80"
                cy="82"
                r="64"
                fill="none"
                stroke={mood === 'alert' ? '#fb923c' : mood === 'caring' ? '#e3a72f' : '#00e599'}
                strokeOpacity="0.24"
                strokeWidth="2"
                strokeDasharray={isThinking ? '6 5' : 'none'}
              />
              <path d="M 42 146 C 42 114, 58 104, 80 104 C 102 104, 118 114, 118 146 Z" fill="#1e293b" />
              <path d="M 52 108 L 68 108 L 68 146 L 46 146 C 47 125 50 115 52 108 Z" fill="url(#vestGradStandalone)" />
              <path d="M 108 108 L 92 108 L 92 146 L 114 146 C 113 125 110 115 108 108 Z" fill="url(#vestGradStandalone)" />
              <rect x="52" y="122" width="14" height="5" rx="2" fill="#e2e8f0" opacity="0.9" />
              <rect x="94" y="122" width="14" height="5" rx="2" fill="#e2e8f0" opacity="0.9" />

              <g style={{ transformOrigin: '42px 124px', animation: 'buddyWaveHand 2.4s ease-in-out infinite' }}>
                <path d="M 44 122 Q 26 106 24 88" stroke="#d99b6c" strokeWidth="12" strokeLinecap="round" fill="none" />
                <rect x="19" y="93" width="13" height="8" rx="3" fill="#0f172a" stroke="#00e599" strokeWidth="1.5" />
                <circle cx="25.5" cy="97" r="2" fill="#00e599" />
                <circle cx="24" cy="85" r="7" fill="#e2a87b" />
              </g>
              <path d="M 116 122 Q 130 132 126 146" stroke="#d99b6c" strokeWidth="12" strokeLinecap="round" fill="none" />
              <rect x="70" y="92" width="20" height="16" rx="7" fill="#d99b6c" />
              <circle cx="51" cy="68" r="6.5" fill="#d99b6c" />
              <circle cx="109" cy="68" r="6.5" fill="#d99b6c" />
              <rect x="52" y="42" width="56" height="54" rx="26" fill="#e2a87b" />
              <ellipse cx="62" cy="74" rx="5.5" ry="3" fill="#f43f5e" opacity="0.22" />
              <ellipse cx="98" cy="74" rx="5.5" ry="3" fill="#f43f5e" opacity="0.22" />

              <g style={{ transformOrigin: '80px 64px', animation: 'buddyBlink 4.6s infinite' }}>
                <circle cx="67" cy="64" r="4.5" fill="#0f172a" />
                <circle cx="93" cy="64" r="4.5" fill="#0f172a" />
                <circle cx="68.5" cy="62.5" r="1.5" fill="#ffffff" />
                <circle cx="94.5" cy="62.5" r="1.5" fill="#ffffff" />
              </g>
              <path d={`M 60 ${leftBrowY} Q 67 ${leftBrowY - 3} 74 ${leftBrowY}`} stroke="#334155" strokeWidth="2.5" strokeLinecap="round" fill="none" />
              <path d={`M 86 ${rightBrowY} Q 93 ${rightBrowY - 3} 100 ${rightBrowY}`} stroke="#334155" strokeWidth="2.5" strokeLinecap="round" fill="none" />
              <path d={mouthPath} stroke="#451a03" strokeWidth="3" strokeLinecap="round" fill="none" />
              <path d="M 46 49 C 46 25, 62 18, 80 18 C 98 18, 114 25, 114 49 Z" fill="url(#helmetGradStandalone)" />
              <path d="M 74 19 L 86 19 L 84 46 L 76 46 Z" fill="#fef08a" opacity="0.65" />
              <path d="M 41 48 Q 80 54 119 48 Q 121 53 116 54 Q 80 59 44 54 Q 39 53 41 48 Z" fill="#ca8a04" />
              <circle cx="80" cy="35" r="6" fill="#040709" />
              <circle cx="80" cy="35" r="3.2" fill="#00e599" />
            </svg>
          </div>
          <span className={`mt-2 px-2.5 py-0.5 rounded-full text-[10px] font-mono border ${palette.badge}`}>
            {isThinking ? 'Thinking gently...' : palette.label}
          </span>
        </div>

        <div className="flex-1 min-w-0 space-y-2.5 w-full">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <p className="text-[11px] font-mono uppercase tracking-wider text-emeraldGlow">
                JaanSaathi Buddy · {languageName}
              </p>
              <p className="text-[11px] text-slate-400">Your private health, stress &amp; life friend</p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={onSpeakCurrent}
                className="px-2.5 py-1 rounded-xl bg-obsidian-950/90 border border-white/10 text-[11px] font-mono text-slate-200 hover:border-emeraldGlow/40 inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Volume2 className="w-3.5 h-3.5 text-emeraldGlow" />
                <span>Listen</span>
              </button>
              <button
                type="button"
                onClick={onToggleSpeech}
                className={`p-1.5 rounded-xl border cursor-pointer ${
                  speechEnabled
                    ? 'bg-emeraldGlow/15 border-emeraldGlow/35 text-emeraldGlow'
                    : 'bg-obsidian-950 border-white/10 text-slate-400'
                }`}
              >
                {speechEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          <div className="relative p-3.5 sm:p-4 rounded-2xl bg-obsidian-950/90 border border-white/10 text-sm sm:text-[15px] leading-relaxed text-slate-100 shadow-lg">
            {isThinking ? (
              <div className="flex items-center gap-2 text-slate-300 text-xs font-mono">
                <span className="w-2 h-2 rounded-full bg-emeraldGlow animate-pulse" />
                <span>JaanSaathi is listening with care...</span>
              </div>
            ) : (
              <p>{message}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

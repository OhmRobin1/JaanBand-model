import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  Check,
  Copy,
  EyeOff,
  HeartHandshake,
  Languages,
  Lock,
  LogIn,
  LogOut,
  Mic,
  MicOff,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { CartoonWorkerBuddy } from './components/CartoonWorkerBuddy';
import {
  INDIA_STATES_FILTER,
  INDIAN_STATE_LANGUAGES,
  getLanguageByCode,
} from './data/indianStateLanguages';
import { auth, signInWithGoogle, signOutUser } from './firebase';
import {
  saveCheckinAndSyncAnonymized,
  saveLanguagePref,
  subscribeAssignedWorker,
  subscribePrivateVault,
} from './services/workerVaultService';
import {
  AssignedWorkerSummary,
  BuddyMood,
  MentalStrainLevel,
  WorkerPrivateCheckin,
  WorkerPrivateVault,
} from './types';

interface SpeechRec {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

const STRAIN_LABELS: Record<
  MentalStrainLevel,
  { label: string; badgeClass: string; desc: string }
> = {
  calm: {
    label: 'CALM & STEADY',
    badgeClass: 'bg-emeraldGlow/15 border-emeraldGlow/35 text-emeraldGlow',
    desc: 'Standard physical thresholds active (+0.00 Rf)',
  },
  mild: {
    label: 'MILD FATIGUE / STRESS',
    badgeClass: 'bg-sky-500/15 border-sky-400/35 text-sky-300',
    desc: 'Gentle safety margin added to JaanBand alert ceiling',
  },
  strained: {
    label: 'HIGH STRAIN · SHADED PACING',
    badgeClass: 'bg-titaniumGold/20 border-titaniumGold/45 text-titaniumGold',
    desc: 'Anonymized pacing sent — shaded ground duty advised',
  },
  rest_advised: {
    label: 'RECOVERY HOLD ADVISED',
    badgeClass: 'bg-orange-500/20 border-orange-500/50 text-orange-300',
    desc: 'Anonymized recovery hold triggered (reason hidden from manager)',
  },
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [selectedState, setSelectedState] = useState('All States / Union Territories');
  const [languageCode, setLanguageCode] = useState('hi');
  const [vault, setVault] = useState<WorkerPrivateVault | null>(null);
  const [checkins, setCheckins] = useState<WorkerPrivateCheckin[]>([]);
  const [assignedWorkers, setAssignedWorkers] = useState<AssignedWorkerSummary[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState('');

  const [messageInput, setMessageInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [careTip, setCareTip] = useState<string | null>(null);
  const [buddyMood, setBuddyMood] = useState<BuddyMood>('warm');
  const [buddyMessage, setBuddyMessage] = useState('');
  const [speechEnabled, setSpeechEnabled] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [copiedUid, setCopiedUid] = useState(false);

  const currentLanguage = useMemo(() => getLanguageByCode(languageCode), [languageCode]);
  const activeWorker = useMemo(
    () =>
      assignedWorkers.find((w) => w.id === selectedWorkerId) ??
      assignedWorkers[0] ??
      null,
    [assignedWorkers, selectedWorkerId],
  );

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authReady || !user) {
      setVault(null);
      setCheckins([]);
      setAssignedWorkers([]);
      return;
    }

    const unsubVault = subscribePrivateVault(
      user,
      (v) => {
        setVault(v);
        if (v?.preferredLanguageCode) setLanguageCode(v.preferredLanguageCode);
        if (v?.preferredState) setSelectedState(v.preferredState);
        if (v?.workerId) setSelectedWorkerId((prev) => prev || v.workerId);
      },
      (list) => {
        setCheckins(list);
        if (list.length > 0) {
          setBuddyMessage(list[0].buddyReply);
          setBuddyMood(list[0].buddyMood);
          setCareTip(list[0].gentleCareTip || null);
        }
      },
      (err) => setErrorMsg(err.message),
    );

    const unsubWorkers = subscribeAssignedWorker(
      user,
      (list) => setAssignedWorkers(list),
      () => {},
    );

    return () => {
      unsubVault();
      unsubWorkers();
    };
  }, [authReady, user]);

  useEffect(() => {
    if (checkins.length === 0) {
      setBuddyMessage(currentLanguage.greeting);
      setBuddyMood('warm');
      setCareTip(null);
    }
  }, [currentLanguage, checkins.length]);

  const speakText = useCallback((text: string, locale: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = locale;
      utter.rate = 0.95;
      window.speechSynthesis.speak(utter);
    } catch {
      // Ignore speech errors
    }
  }, []);

  const handleSelectState = async (stateName: string) => {
    setSelectedState(stateName);
    const match = INDIA_STATES_FILTER.find((s) => s.state === stateName);
    const nextCode = match?.defaultLangCode || languageCode;
    setLanguageCode(nextCode);
    setBuddyMessage(getLanguageByCode(nextCode).greeting);
    if (user) {
      await saveLanguagePref(user, {
        workerId: activeWorker?.id || '',
        preferredLanguageCode: nextCode,
        preferredState: stateName,
      }).catch(() => {});
    }
  };

  const handleSelectLanguage = async (nextCode: string) => {
    setLanguageCode(nextCode);
    if (checkins.length === 0) setBuddyMessage(getLanguageByCode(nextCode).greeting);
    if (user) {
      await saveLanguagePref(user, {
        workerId: activeWorker?.id || '',
        preferredLanguageCode: nextCode,
        preferredState: selectedState,
      }).catch(() => {});
    }
  };

  const handleSendCheckin = async (textOverride?: string) => {
    const rawMsg = (textOverride ?? messageInput).trim();
    if (!rawMsg || isSending) return;
    setErrorMsg(null);
    setIsSending(true);
    setBuddyMood('listening');

    try {
      const historyPayload = checkins
        .slice(0, 4)
        .reverse()
        .flatMap((c) => [
          { role: 'worker', text: c.workerMessage },
          { role: 'buddy', text: c.buddyReply },
        ]);

      const resp = await fetch('/api/jaansaathi-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: rawMsg,
          languageCode: currentLanguage.code,
          languageName: currentLanguage.name,
          nativeScript: currentLanguage.nativeName,
          stateCoverage: currentLanguage.stateSummary,
          workerFirstName:
            activeWorker?.name?.split(' ')[0] ||
            user?.displayName?.split(' ')[0] ||
            'Saathi',
          history: historyPayload,
        }),
      });

      const data = (await resp.json()) as Record<string, unknown>;
      if (!resp.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : 'AI check-in failed');
      }

      const reply = String(data.replyInLanguage || currentLanguage.greeting);
      const nextMood = (String(data.buddyMood || 'warm') as BuddyMood) || 'warm';
      const strain = (String(data.mentalStrainLevel || 'calm') as MentalStrainLevel) || 'calm';
      const boost = Number(data.mentalRfBoost ?? 0);
      const tip = String(data.gentleCareTip || '');

      setBuddyMessage(reply);
      setBuddyMood(nextMood);
      setCareTip(tip || null);
      setMessageInput('');

      if (speechEnabled) speakText(reply, currentLanguage.speechLocale);

      if (user) {
        await saveCheckinAndSyncAnonymized(user, {
          worker: activeWorker,
          preferredState: selectedState,
          languageCode: currentLanguage.code,
          languageName: `${currentLanguage.nativeName} (${currentLanguage.name})`,
          workerMessage: rawMsg,
          buddyReply: reply,
          buddyMood: nextMood,
          mentalStrainLevel: strain,
          mentalRfBoost: boost,
          gentleCareTip: tip,
          recommendShadedDuty: Boolean(data.recommendShadedDuty),
          recommendMedicalHold: Boolean(data.recommendMedicalHold),
        });
      }
    } catch (err) {
      setBuddyMood('caring');
      setErrorMsg(err instanceof Error ? err.message : 'Unable to send check-in.');
    } finally {
      setIsSending(false);
    }
  };

  const handleVoiceCapture = () => {
    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const RecCtor = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!RecCtor) {
      setErrorMsg('Voice input unavailable in this browser. Type or tap a quick card.');
      return;
    }
    if (isListening) return;
    const rec = new RecCtor();
    rec.lang = currentLanguage.speechLocale;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setIsListening(true);
    setBuddyMood('listening');
    rec.onresult = (ev) => {
      const t = ev.results?.[0]?.[0]?.transcript || '';
      if (t.trim()) setMessageInput((prev) => (prev ? `${prev} ${t}` : t));
    };
    rec.onerror = () => setIsListening(false);
    rec.onend = () => setIsListening(false);
    rec.start();
  };

  const handleCopyUid = async () => {
    if (!user?.uid) return;
    try {
      await navigator.clipboard.writeText(user.uid);
      setCopiedUid(true);
      window.setTimeout(() => setCopiedUid(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  const visibleLanguages = useMemo(() => {
    if (selectedState === 'All States / Union Territories') return INDIAN_STATE_LANGUAGES;
    const m = INDIAN_STATE_LANGUAGES.filter((l) => l.states.includes(selectedState));
    return m.length > 0 ? m : INDIAN_STATE_LANGUAGES;
  }, [selectedState]);

  const activeStrain: MentalStrainLevel =
    activeWorker?.mentalStrainLevel ?? vault?.lastMentalStrainLevel ?? 'calm';
  const activeBoost = activeWorker?.mentalRfBoost ?? vault?.lastMentalRfBoost ?? 0;
  const strainStyle = STRAIN_LABELS[activeStrain];

  return (
    <div className="min-h-screen bg-[#040709] text-slate-100 pb-12">
      <header className="sticky top-0 z-40 bg-[#040709]/92 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-emeraldGlow/15 border border-emeraldGlow/35 flex items-center justify-center">
              <HeartHandshake className="w-4 h-4 text-emeraldGlow" />
            </div>
            <div>
              <span className="text-xs font-mono tracking-widest text-titaniumGold uppercase font-bold block">
                JAANSAATHI
              </span>
              <span className="text-[11px] text-slate-400">
                Private Worker Wellbeing App
              </span>
            </div>
          </div>

          {user ? (
            <button
              type="button"
              onClick={() => void signOutUser()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-obsidian-800 border border-white/10 text-[11px] text-slate-200 hover:text-orange-300 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>{user.email?.split('@')[0] || 'Sign out'}</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={!authReady}
              onClick={() => void signInWithGoogle()}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-emeraldGlow text-obsidian-950 text-[11px] font-semibold cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Worker Sign-In</span>
            </button>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 pt-5 space-y-5">
        <section className="rounded-3xl p-4 sm:p-5 bg-obsidian-900/90 border border-emeraldGlow/25 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-2xl bg-emeraldGlow/15 border border-emeraldGlow/35 flex items-center justify-center shrink-0">
                <Lock className="w-5 h-5 text-emeraldGlow" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-sm sm:text-base font-bold text-white">
                    Private Health &amp; Mind Check-In
                  </h1>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emeraldGlow/10 border border-emeraldGlow/30 text-[10px] font-mono text-emeraldGlow">
                    <EyeOff className="w-3 h-3" />
                    <span>HIDDEN FROM MANAGERS</span>
                  </span>
                </div>
                <p className="text-xs text-slate-300 mt-1">{currentLanguage.privacyLine}</p>
              </div>
            </div>

            {user && (
              <span className={`px-2.5 py-1 rounded-xl border text-[10px] font-mono font-semibold ${strainStyle.badgeClass}`}>
                {strainStyle.label} (+{activeBoost.toFixed(2)} Rf)
              </span>
            )}
          </div>

          {user && (
            <div className="pt-2.5 border-t border-white/10 flex items-center justify-between gap-2 flex-wrap text-[11px]">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emeraldGlow" />
                {activeWorker ? (
                  <span className="text-slate-200 font-mono">
                    Synced Band: {activeWorker.id} ({activeWorker.bandId || 'Unpaired'}) · Rf{' '}
                    {activeWorker.riskFactor.toFixed(2)} · Crit {activeWorker.dynamicHrR} BPM
                  </span>
                ) : (
                  <span className="text-slate-300">
                    Share your Worker UID with your supervisor once to auto-tune your JaanBand limits.
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={handleCopyUid}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-obsidian-950 border border-white/10 font-mono text-[10px] text-slate-300 cursor-pointer"
              >
                {copiedUid ? (
                  <>
                    <Check className="w-3 h-3 text-emeraldGlow" />
                    <span className="text-emeraldGlow">UID Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>UID: {user.uid.slice(0, 10)}...</span>
                  </>
                )}
              </button>
            </div>
          )}
        </section>

        <section className="glass-panel rounded-3xl p-4 sm:p-5 border border-white/10 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Languages className="w-4 h-4 text-titaniumGold" />
              <h2 className="text-xs font-mono uppercase tracking-wider font-bold text-white">
                State &amp; Language Picker (All India)
              </h2>
            </div>
            <select
              value={selectedState}
              onChange={(e) => void handleSelectState(e.target.value)}
              className="px-3 py-1.5 rounded-xl bg-obsidian-950 border border-white/15 text-xs text-white"
            >
              {INDIA_STATES_FILTER.map((item) => (
                <option key={item.state} value={item.state}>
                  {item.state}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2 max-h-56 overflow-y-auto pr-1">
            {visibleLanguages.map((lang) => (
              <button
                key={lang.code}
                type="button"
                onClick={() => void handleSelectLanguage(lang.code)}
                className={`p-2 rounded-xl border text-left cursor-pointer ${
                  lang.code === languageCode
                    ? 'bg-emeraldGlow/15 border-emeraldGlow/50 text-white'
                    : 'bg-obsidian-950/80 border-white/10 text-slate-300 hover:border-white/25'
                }`}
              >
                <p className="text-xs font-bold truncate">{lang.nativeName}</p>
                <p className="text-[10px] font-mono text-slate-400 truncate">{lang.name}</p>
              </button>
            ))}
          </div>
        </section>

        <CartoonWorkerBuddy
          mood={buddyMood}
          isThinking={isSending}
          message={buddyMessage || currentLanguage.greeting}
          languageName={`${currentLanguage.nativeName} (${currentLanguage.name})`}
          speechEnabled={speechEnabled}
          onToggleSpeech={() => setSpeechEnabled((v) => !v)}
          onSpeakCurrent={() =>
            speakText(buddyMessage || currentLanguage.greeting, currentLanguage.speechLocale)
          }
        />

        {careTip && (
          <div className="p-3.5 rounded-2xl bg-titaniumGold/10 border border-titaniumGold/35 flex items-start gap-2.5 text-xs text-amber-100">
            <Sparkles className="w-4 h-4 text-titaniumGold shrink-0 mt-0.5" />
            <p>{careTip}</p>
          </div>
        )}

        <section className="glass-panel rounded-3xl p-4 sm:p-5 border border-white/10 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {currentLanguage.quickPrompts.map((chip) => (
              <button
                key={chip.label}
                type="button"
                disabled={isSending}
                onClick={() => void handleSendCheckin(chip.text)}
                className="p-2.5 rounded-2xl bg-obsidian-950/90 border border-white/10 text-left hover:border-emeraldGlow/40 cursor-pointer"
              >
                <span className="text-xs font-semibold text-white block">{chip.label}</span>
                <span className="text-[11px] text-slate-400 line-clamp-2 mt-0.5">{chip.text}</span>
              </button>
            ))}
          </div>

          {errorMsg && (
            <div className="p-2.5 rounded-xl bg-orange-500/10 border border-orange-500/35 text-xs text-orange-300">
              {errorMsg}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSendCheckin();
            }}
            className="flex items-center gap-2"
          >
            <button
              type="button"
              onClick={handleVoiceCapture}
              className={`h-11 w-11 rounded-2xl border flex items-center justify-center shrink-0 cursor-pointer ${
                isListening
                  ? 'bg-orange-500/20 border-orange-500/50 text-orange-300'
                  : 'bg-obsidian-950 border-white/10 text-slate-300'
              }`}
            >
              {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
            <input
              type="text"
              maxLength={1500}
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              placeholder={currentLanguage.placeholder}
              className="flex-1 h-11 px-4 rounded-2xl bg-obsidian-950 border border-white/15 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-emeraldGlow"
            />
            <button
              type="submit"
              disabled={isSending || !messageInput.trim()}
              className="h-11 px-4 sm:px-5 rounded-2xl bg-emeraldGlow text-obsidian-950 font-semibold text-xs inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Send className="w-4 h-4" />
              <span className="hidden sm:inline">{isSending ? 'Sharing...' : 'Share Privately'}</span>
            </button>
          </form>
        </section>

        <section className="glass-panel rounded-3xl p-4 sm:p-5 border border-white/10 space-y-2.5">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-emeraldGlow" />
            <h2 className="text-xs font-mono uppercase tracking-wider font-bold text-white">
              Your Private Wellbeing Journal ({checkins.length})
            </h2>
          </div>

          {checkins.map((entry) => (
            <div key={entry.id} className="p-3 rounded-2xl bg-obsidian-950/90 border border-white/10 space-y-1 text-xs">
              <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-slate-400">
                <span>{new Date(entry.createdAt).toLocaleString()} · {entry.languageName}</span>
                <span className="text-emeraldGlow">+{entry.mentalRfBoost.toFixed(2)} Rf</span>
              </div>
              <p className="text-slate-200">{entry.workerMessage}</p>
              <p className="text-slate-300 bg-obsidian-900/80 p-2 rounded-xl border border-white/5">
                {entry.buddyReply}
              </p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}

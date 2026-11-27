import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Check,
  Copy,
  EyeOff,
  HeartHandshake,
  Languages,
  Lock,
  LogIn,
  Mic,
  MicOff,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  INDIA_STATES_FILTER,
  INDIAN_STATE_LANGUAGES,
  getLanguageByCode,
} from '../data/indianStateLanguages';
import {
  recordPrivateCheckinAndSyncAnonymizedRf,
  saveWorkerLanguagePref,
  subscribeAssignedWorkerForSaathi,
  subscribeWorkerPrivateVault,
} from '../services/jaanshieldFirestore';
import {
  BuddyMood,
  MentalStrainLevel,
  WorkerPrivateCheckin,
  WorkerPrivateVault,
  WorkerRecord,
} from '../types/band';
import { CartoonWorkerBuddy } from './CartoonWorkerBuddy';

interface JaanSaathiWorkerPortalProps {
  user: User | null;
  authReady: boolean;
  onSignIn: () => void;
  managerWorkers: WorkerRecord[];
}

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

export function JaanSaathiWorkerPortal({
  user,
  authReady,
  onSignIn,
  managerWorkers,
}: JaanSaathiWorkerPortalProps) {
  const [selectedState, setSelectedState] = useState<string>('All States / Union Territories');
  const [languageCode, setLanguageCode] = useState<string>('hi');
  const [vault, setVault] = useState<WorkerPrivateVault | null>(null);
  const [checkins, setCheckins] = useState<WorkerPrivateCheckin[]>([]);
  const [assignedWorkers, setAssignedWorkers] = useState<WorkerRecord[]>([]);
  const [selectedAssignedId, setSelectedAssignedId] = useState<string>('');

  const [messageInput, setMessageInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [careTip, setCareTip] = useState<string | null>(null);

  const [buddyMood, setBuddyMood] = useState<BuddyMood>('warm');
  const [buddyMessage, setBuddyMessage] = useState<string>('');
  const [localTurns, setLocalTurns] = useState<
    Array<{ role: 'worker' | 'buddy'; text: string }>
  >([]);
  const lastHydratedCheckinIdRef = useRef<string | null>(null);
  const recognitionRef = useRef<SpeechRec | null>(null);
  const [speechEnabled, setSpeechEnabled] = useState<boolean>(false);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [copiedUid, setCopiedUid] = useState<boolean>(false);

  const currentLanguage = useMemo(
    () => getLanguageByCode(languageCode),
    [languageCode],
  );

  // Merge workers where user is either workerUid OR ownerUid (seamless for both worker login & owner testing)
  const linkableWorkers = useMemo(() => {
    const map = new Map<string, WorkerRecord>();
    for (const w of assignedWorkers) map.set(w.id, w);
    for (const w of managerWorkers) map.set(w.id, w);
    return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
  }, [assignedWorkers, managerWorkers]);

  const activeWorker = useMemo(() => {
    if (selectedAssignedId) {
      return linkableWorkers.find((w) => w.id === selectedAssignedId) ?? null;
    }
    return linkableWorkers[0] ?? null;
  }, [linkableWorkers, selectedAssignedId]);

  useEffect(() => {
    if (!authReady || !user) {
      setVault(null);
      setCheckins([]);
      setAssignedWorkers([]);
      lastHydratedCheckinIdRef.current = null;
      return;
    }

    const unsubVault = subscribeWorkerPrivateVault(
      user,
      (v) => {
        setVault(v);
        if (v?.preferredLanguageCode) {
          setLanguageCode(v.preferredLanguageCode);
        }
        if (v?.preferredState) {
          setSelectedState(v.preferredState);
        }
        if (v?.workerId) {
          setSelectedAssignedId((prev) => prev || v.workerId);
        }
      },
      (list) => {
        setCheckins(list);
        if (list.length > 0 && lastHydratedCheckinIdRef.current !== list[0].id) {
          lastHydratedCheckinIdRef.current = list[0].id;
          setBuddyMessage(list[0].buddyReply);
          setBuddyMood(list[0].buddyMood);
          setCareTip(list[0].gentleCareTip || null);
        }
      },
      (err) => setVaultError(err.message),
    );

    const unsubAssigned = subscribeAssignedWorkerForSaathi(
      user,
      (list) => setAssignedWorkers(list),
      () => {
        // Non-fatal if worker isn't bound via workerUid yet
      },
    );

    return () => {
      unsubVault();
      unsubAssigned();
    };
  }, [authReady, user]);

  useEffect(() => {
    if (checkins.length === 0 && localTurns.length === 0) {
      setBuddyMessage(currentLanguage.greeting);
      setBuddyMood('warm');
      setCareTip(null);
    }
  }, [currentLanguage, checkins.length, localTurns.length]);

  const speakText = useCallback(
    (text: string, locale: string) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) {
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = locale;
        utter.rate = 0.95;
        window.speechSynthesis.speak(utter);
      } catch {
        // Ignore browser speech synthesis failures
      }
    },
    [],
  );

  const handleSelectState = async (stateName: string) => {
    setSelectedState(stateName);
    const match = INDIA_STATES_FILTER.find((s) => s.state === stateName);
    const nextCode = match?.defaultLangCode || languageCode;
    setLanguageCode(nextCode);
    setBuddyMessage(getLanguageByCode(nextCode).greeting);
    setBuddyMood('warm');
    if (user) {
      await saveWorkerLanguagePref(user, {
        workerId: activeWorker?.id || '',
        preferredLanguageCode: nextCode,
        preferredState: stateName,
      }).catch(() => {});
    }
  };

  const handleSelectLanguage = async (nextCode: string) => {
    setLanguageCode(nextCode);
    const langObj = getLanguageByCode(nextCode);
    if (checkins.length === 0) {
      setBuddyMessage(langObj.greeting);
    }
    if (user) {
      await saveWorkerLanguagePref(user, {
        workerId: activeWorker?.id || '',
        preferredLanguageCode: nextCode,
        preferredState: selectedState,
      }).catch(() => {});
    }
  };

  const handleSendCheckin = async (textOverride?: string) => {
    const rawMsg = (textOverride ?? messageInput).trim();
    if (!rawMsg || isSending) return;
    setChatError(null);
    setIsSending(true);
    setBuddyMood('listening');

    try {
      const historyPayload =
        checkins.length > 0
          ? checkins
              .slice(0, 4)
              .reverse()
              .flatMap((c) => [
                { role: 'worker', text: c.workerMessage },
                { role: 'buddy', text: c.buddyReply },
              ])
          : localTurns.slice(-6);

      const firstName =
        activeWorker?.name?.split(' ')[0] ||
        user?.displayName?.split(' ')[0] ||
        'Saathi';

      const resp = await fetch('/api/jaansaathi-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: rawMsg,
          languageCode: currentLanguage.code,
          languageName: currentLanguage.name,
          nativeScript: currentLanguage.nativeName,
          stateCoverage: currentLanguage.stateSummary,
          workerFirstName: firstName,
          history: historyPayload,
        }),
      });

      const rawText = await resp.text();
      let data: Record<string, unknown> = {};
      try {
        data = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
      } catch {
        data = {};
      }
      if (!resp.ok) {
        throw new Error(
          typeof data.error === 'string'
            ? data.error
            : `Unable to reach JaanSaathi AI service (HTTP ${resp.status}).`,
        );
      }

      const reply = String(data.replyInLanguage || currentLanguage.greeting);
      const nextMood = (String(data.buddyMood || 'warm') as BuddyMood) || 'warm';
      const strain = (String(data.mentalStrainLevel || 'calm') as MentalStrainLevel) || 'calm';
      const boost = Number(data.mentalRfBoost ?? 0);
      const tip = String(data.gentleCareTip || '');
      const recommendShaded = Boolean(data.recommendShadedDuty);
      const recommendHold = Boolean(data.recommendMedicalHold);

      setBuddyMessage(reply);
      setBuddyMood(nextMood);
      setCareTip(tip || null);
      setMessageInput('');
      setLocalTurns((prev) => [
        ...prev.slice(-6),
        { role: 'worker', text: rawMsg },
        { role: 'buddy', text: reply },
      ]);

      if (speechEnabled) {
        speakText(reply, currentLanguage.speechLocale);
      }

      if (user) {
        try {
          await recordPrivateCheckinAndSyncAnonymizedRf(user, {
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
            recommendShadedDuty: recommendShaded,
            recommendMedicalHold: recommendHold,
          });
        } catch (vaultErr) {
          setVaultError(
            vaultErr instanceof Error
              ? vaultErr.message
              : 'Private journal save is temporarily delayed.',
          );
        }
      }
    } catch (err) {
      setBuddyMood('caring');
      setChatError(
        err instanceof Error ? err.message : 'Check-in could not be processed.',
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleVoiceCapture = () => {
    if (isListening && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore stop errors
      }
      setIsListening(false);
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const RecCtor = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!RecCtor) {
      setChatError('Voice dictation is unavailable in this browser. Type or tap a mood card.');
      return;
    }

    setChatError(null);
    const rec = new RecCtor();
    recognitionRef.current = rec;
    rec.lang = currentLanguage.speechLocale;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setIsListening(true);
    setBuddyMood('listening');

    rec.onresult = (ev) => {
      const transcript = ev.results?.[0]?.[0]?.transcript || '';
      if (transcript.trim()) {
        setMessageInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
      }
    };
    rec.onerror = () => {
      recognitionRef.current = null;
      setIsListening(false);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);
    };
    rec.start();
  };

  const handleCopyUid = async () => {
    if (!user?.uid) return;
    try {
      await navigator.clipboard.writeText(user.uid);
      setCopiedUid(true);
      window.setTimeout(() => setCopiedUid(false), 2000);
    } catch {
      // Clipboard blocked in iframe
    }
  };

  const activeStrain: MentalStrainLevel =
    activeWorker?.mentalStrainLevel ?? vault?.lastMentalStrainLevel ?? 'calm';
  const activeBoost =
    activeWorker?.mentalRfBoost ?? vault?.lastMentalRfBoost ?? 0;
  const strainStyle = STRAIN_LABELS[activeStrain];

  const visibleLanguages = useMemo(() => {
    if (selectedState === 'All States / Union Territories') {
      return INDIAN_STATE_LANGUAGES;
    }
    const matched = INDIAN_STATE_LANGUAGES.filter((l) =>
      l.states.includes(selectedState),
    );
    return matched.length > 0 ? matched : INDIAN_STATE_LANGUAGES;
  }, [selectedState]);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-5 pb-12 space-y-5">
      {/* Zero-Leak Privacy Promise & Worker Auth Card */}
      <section className="rounded-3xl p-4 sm:p-5 bg-obsidian-900/90 border border-emeraldGlow/25 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-2xl bg-emeraldGlow/15 border border-emeraldGlow/35 flex items-center justify-center shrink-0">
              <Lock className="w-5 h-5 text-emeraldGlow" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm sm:text-base font-bold text-white tracking-tight">
                  JaanSaathi Private Worker Companion
                </h2>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emeraldGlow/10 border border-emeraldGlow/30 text-[10px] font-mono text-emeraldGlow">
                  <EyeOff className="w-3 h-3" />
                  <span>ZERO MANAGER ACCESS</span>
                </span>
              </div>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                {currentLanguage.privacyLine}
              </p>
            </div>
          </div>

          {!user ? (
            <button
              type="button"
              disabled={!authReady}
              onClick={onSignIn}
              className="px-4 py-2 rounded-2xl bg-emeraldGlow text-obsidian-950 font-semibold text-xs inline-flex items-center gap-2 hover:brightness-105 cursor-pointer shrink-0"
            >
              <LogIn className="w-4 h-4" />
              <span>Worker Google Sign-In</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`px-2.5 py-1 rounded-xl border text-[10px] font-mono font-semibold ${strainStyle.badgeClass}`}
              >
                {strainStyle.label} (+{activeBoost.toFixed(2)} Rf)
              </span>
            </div>
          )}
        </div>

        {/* Paired JaanBand Sync Status & Supervisor Link */}
        {user && (
          <div className="pt-2.5 border-t border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-[11px]">
            <div className="flex items-center gap-2 flex-wrap">
              <ShieldCheck className="w-4 h-4 text-emeraldGlow shrink-0" />
              {linkableWorkers.length > 0 ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-slate-300">Synced Band Profile:</span>
                  <select
                    value={activeWorker?.id || ''}
                    onChange={(e) => setSelectedAssignedId(e.target.value)}
                    className="px-2.5 py-1 rounded-lg bg-obsidian-950 border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-emeraldGlow"
                  >
                    {linkableWorkers.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.id} · {w.name} ({w.bandId || 'Unpaired'})
                      </option>
                    ))}
                  </select>
                  {activeWorker && (
                    <span className="font-mono text-titaniumGold">
                      Rf {activeWorker.riskFactor.toFixed(2)} · Crit{' '}
                      {activeWorker.dynamicHrR} BPM ·{' '}
                      {activeWorker.fitStatus.replace('_', ' ').toUpperCase()}
                    </span>
                  )}
                </div>
              ) : (
                <span className="text-slate-300">
                  Private Vault Active. Share your Worker UID with your site supervisor once to sync anonymized fitness limits to your JaanBand.
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={handleCopyUid}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-obsidian-950 border border-white/10 font-mono text-[10px] text-slate-300 hover:border-emeraldGlow/40 cursor-pointer shrink-0"
              title="Copy your private Worker Account UID for band linking"
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

      {/* All Indian States & Languages Picker */}
      <section className="glass-panel rounded-3xl p-4 sm:p-5 border border-white/10 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Languages className="w-4 h-4 text-titaniumGold" />
            <h3 className="text-xs font-mono uppercase tracking-wider font-bold text-white">
              Choose Your State &amp; Mother Tongue (All Indian States &amp; UTs)
            </h3>
          </div>

          <select
            value={selectedState}
            onChange={(e) => void handleSelectState(e.target.value)}
            aria-label="Filter language by Indian State or Union Territory"
            className="px-3 py-1.5 rounded-xl bg-obsidian-950 border border-white/15 text-xs text-white focus:outline-none focus:border-emeraldGlow"
          >
            {INDIA_STATES_FILTER.map((item) => (
              <option key={item.state} value={item.state}>
                {item.state}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2 max-h-56 overflow-y-auto pr-1">
          {visibleLanguages.map((lang) => {
            const active = lang.code === languageCode;
            return (
              <button
                key={lang.code}
                type="button"
                onClick={() => void handleSelectLanguage(lang.code)}
                className={`p-2 rounded-xl border text-left transition-colors cursor-pointer ${
                  active
                    ? 'bg-emeraldGlow/15 border-emeraldGlow/50 text-white'
                    : 'bg-obsidian-950/80 border-white/10 text-slate-300 hover:border-white/25'
                }`}
              >
                <p className="text-xs font-bold truncate">{lang.nativeName}</p>
                <p className="text-[10px] font-mono text-slate-400 truncate">
                  {lang.name}
                </p>
              </button>
            );
          })}
        </div>
        <p className="text-[10px] font-mono text-slate-400">
          Active Region Coverage: {currentLanguage.stateSummary} · Voice Locale:{' '}
          {currentLanguage.speechLocale}
        </p>
      </section>

      {/* Expressive Cartoonish Worker Buddy Stage */}
      <CartoonWorkerBuddy
        mood={buddyMood}
        isThinking={isSending}
        message={buddyMessage || currentLanguage.greeting}
        languageName={`${currentLanguage.nativeName} (${currentLanguage.name})`}
        speechEnabled={speechEnabled}
        onToggleSpeech={() => setSpeechEnabled((v) => !v)}
        onSpeakCurrent={() =>
          speakText(
            buddyMessage || currentLanguage.greeting,
            currentLanguage.speechLocale,
          )
        }
      />

      {careTip && (
        <div className="p-3.5 rounded-2xl bg-titaniumGold/10 border border-titaniumGold/35 flex items-start gap-2.5 text-xs text-amber-100">
          <Sparkles className="w-4 h-4 text-titaniumGold shrink-0 mt-0.5" />
          <div>
            <span className="font-mono text-[10px] uppercase tracking-wider text-titaniumGold block">
              JaanSaathi Self-Care Tip
            </span>
            <p className="mt-0.5">{careTip}</p>
          </div>
        </div>
      )}

      {/* Check-in Mood Chips & Chat Input */}
      <section className="glass-panel rounded-3xl p-4 sm:p-5 border border-white/10 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
            <HeartHandshake className="w-3.5 h-3.5 text-emeraldGlow" />
            <span>{currentLanguage.askHealthLabel}</span>
          </span>
          <span className="text-[10px] font-mono text-slate-400">
            {strainStyle.desc}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {currentLanguage.quickPrompts.map((chip) => (
            <button
              key={chip.label}
              type="button"
              disabled={isSending}
              onClick={() => void handleSendCheckin(chip.text)}
              className="p-2.5 rounded-2xl bg-obsidian-950/90 border border-white/10 text-left hover:border-emeraldGlow/40 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <span className="text-xs font-semibold text-white block">
                {chip.label}
              </span>
              <span className="text-[11px] text-slate-400 line-clamp-2 mt-0.5">
                {chip.text}
              </span>
            </button>
          ))}
        </div>

        {(chatError || vaultError) && (
          <div className="p-2.5 rounded-xl bg-orange-500/10 border border-orange-500/35 text-xs text-orange-300">
            {chatError || vaultError}
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
            className={`h-11 w-11 rounded-2xl border flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
              isListening
                ? 'bg-orange-500/20 border-orange-500/50 text-orange-300 animate-pulse'
                : 'bg-obsidian-950 border-white/10 text-slate-300 hover:border-emeraldGlow/40'
            }`}
            title="Speak in your language"
            aria-label="Dictate message in your selected language"
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
            className="h-11 px-4 sm:px-5 rounded-2xl bg-emeraldGlow text-obsidian-950 font-semibold text-xs inline-flex items-center gap-1.5 hover:brightness-105 disabled:opacity-50 cursor-pointer shrink-0"
          >
            <Send className="w-4 h-4" />
            <span className="hidden sm:inline">
              {isSending ? 'Sharing...' : 'Share Privately'}
            </span>
          </button>
        </form>
      </section>

      {/* Worker-Only Encrypted-Access Check-In History */}
      <section className="glass-panel rounded-3xl p-4 sm:p-5 border border-white/10 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-emeraldGlow" />
            <h3 className="text-xs font-mono uppercase tracking-wider font-bold text-white">
              Your Private Wellbeing Journal ({checkins.length})
            </h3>
          </div>
          <span className="text-[10px] font-mono text-slate-400">
            Locked to UID {user ? `${user.uid.slice(0, 8)}...` : 'Sign-In Required'}
          </span>
        </div>

        {!user ? (
          <p className="text-xs text-slate-400">
            Sign in with your Google account above so JaanSaathi saves your private check-ins in your personal Firebase vault and adjusts your JaanBand sensitivity safely.
          </p>
        ) : checkins.length === 0 ? (
          <p className="text-xs text-slate-400">
            No private check-ins saved yet. Talk to JaanSaathi above in your mother tongue!
          </p>
        ) : (
          <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
            {checkins.map((entry) => {
              const badge = STRAIN_LABELS[entry.mentalStrainLevel];
              return (
                <div
                  key={entry.id}
                  className="p-3 rounded-2xl bg-obsidian-950/90 border border-white/10 space-y-1.5 text-xs"
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[10px] font-mono text-slate-400">
                      {new Date(entry.createdAt).toLocaleString()} · {entry.languageName}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-md border text-[9px] font-mono ${badge.badgeClass}`}
                    >
                      {badge.label} (+{entry.mentalRfBoost.toFixed(2)} Rf)
                    </span>
                  </div>
                  <p className="text-slate-200">
                    <strong className="text-emeraldGlow font-mono text-[10px] mr-1.5">
                      YOU:
                    </strong>
                    {entry.workerMessage}
                  </p>
                  <p className="text-slate-300 bg-obsidian-900/80 p-2 rounded-xl border border-white/5">
                    <strong className="text-titaniumGold font-mono text-[10px] mr-1.5">
                      SAATHI:
                    </strong>
                    {entry.buddyReply}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

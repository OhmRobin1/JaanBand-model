import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const ALLOWED_MOODS = new Set(['warm', 'listening', 'encouraging', 'caring', 'alert']);
const ALLOWED_STRAIN = new Set(['calm', 'mild', 'strained', 'rest_advised']);

function sanitizeInput(val: unknown, maxLen: number): string {
  if (typeof val !== 'string') return '';
  return val.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLen);
}

function getHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string {
  if (!headers) return '';
  const raw = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
}

function isOriginAllowed(
  originHeader: string,
  hostHeader: string,
  forwardedHostHeader: string,
): boolean {
  if (!originHeader) return true;
  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false;
  }
  const originHost = parsed.host.toLowerCase();
  const originUrl = `${parsed.protocol}//${originHost}`;
  const currentHost = (forwardedHostHeader || hostHeader).toLowerCase();

  if (currentHost && originHost === currentHost) {
    return true;
  }
  if (
    originHost === 'jaanband3dmodel.vercel.app' ||
    /^jaanband3dmodel-[a-z0-9-]+\.vercel\.app$/.test(originHost) ||
    /^[a-z0-9-]+\.run\.app$/.test(originHost) ||
    originHost.startsWith('localhost:') ||
    originHost.startsWith('127.0.0.1:')
  ) {
    return true;
  }

  const extraOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return extraOrigins.includes(originUrl) || extraOrigins.includes(originHost);
}

const checkInResponseSchema = {
  type: Type.OBJECT,
  properties: {
    replyInLanguage: {
      type: Type.STRING,
      description:
        'Warm, caring, conversational reply written strictly in the worker selected language/script asking gently about their body, stress, sleep, or life.',
    },
    buddyMood: {
      type: Type.STRING,
      description: 'Facial expression mood for the cartoon worker buddy',
      enum: ['warm', 'listening', 'encouraging', 'caring', 'alert'],
    },
    mentalStrainLevel: {
      type: Type.STRING,
      description: 'Anonymized holistic strain classification',
      enum: ['calm', 'mild', 'strained', 'rest_advised'],
    },
    mentalRfBoost: {
      type: Type.NUMBER,
      description:
        'Anonymized JaanBand sensitivity boost between 0.0 and 0.25 (0=calm, 0.06=mild, 0.14=strained, 0.22=rest_advised).',
    },
    recommendShadedDuty: {
      type: Type.BOOLEAN,
      description: 'True if worker should get lighter shaded ground tasks today.',
    },
    recommendMedicalHold: {
      type: Type.BOOLEAN,
      description:
        'True ONLY if severe physical distress, chest pain, fainting, acute fever, or overwhelming mental crisis warrants rest hold.',
    },
    gentleCareTip: {
      type: Type.STRING,
      description:
        'Short 1-sentence practical self-care tip written in the worker selected language (hydration, breathing, shade, or rest).',
    },
  },
  required: [
    'replyInLanguage',
    'buddyMood',
    'mentalStrainLevel',
    'mentalRfBoost',
    'recommendShadedDuty',
    'recommendMedicalHold',
    'gentleCareTip',
  ],
};

interface ServerlessReq {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface ServerlessRes {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => {
    json: (payload: unknown) => void;
    end: () => void;
  };
}

export default async function handler(req: ServerlessReq, res: ServerlessRes) {
  const origin = getHeader(req.headers, 'origin');
  const host = getHeader(req.headers, 'host');
  const forwardedHost = getHeader(req.headers, 'x-forwarded-host');

  if (!isOriginAllowed(origin, host, forwardedHost)) {
    res.status(403).json({ error: 'Origin not allowed.' });
    return;
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error:
        'Server GEMINI_API_KEY is not configured. Add GEMINI_API_KEY in Vercel Project Settings -> Environment Variables and redeploy.',
    });
    return;
  }

  let bodyObj: Record<string, unknown> = {};
  if (typeof req.body === 'string') {
    try {
      const parsedBody = JSON.parse(req.body) as unknown;
      if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
        bodyObj = parsedBody as Record<string, unknown>;
      }
    } catch {
      res.status(400).json({ error: 'Invalid JSON request body.' });
      return;
    }
  } else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    bodyObj = req.body as Record<string, unknown>;
  }

  const message = sanitizeInput(bodyObj.message, 1500);
  const languageCode = sanitizeInput(bodyObj.languageCode, 16) || 'hi';
  const languageName = sanitizeInput(bodyObj.languageName, 64) || 'Hindi';
  const nativeScript = sanitizeInput(bodyObj.nativeScript, 64) || 'हिन्दी';
  const stateCoverage = sanitizeInput(bodyObj.stateCoverage, 160) || 'India';
  const workerFirstName = sanitizeInput(bodyObj.workerFirstName, 40) || 'Saathi';
  const historyRaw = Array.isArray(bodyObj.history) ? bodyObj.history.slice(-6) : [];

  if (!message) {
    res.status(400).json({ error: 'Please share a short message or tap a mood option.' });
    return;
  }

  const formattedHistory = historyRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const rec = item as Record<string, unknown>;
      const role = rec.role === 'buddy' ? 'JaanSaathi' : 'Worker';
      const text = sanitizeInput(rec.text, 500);
      return text ? `${role}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const systemInstruction = `You are JaanSaathi, a friendly, warm, cartoonish worker companion created ONLY for the construction/industrial worker's private wellbeing.
Strict rules:
1. Respond ENTIRELY in ${languageName} (${nativeScript}, code: ${languageCode}, spoken in ${stateCoverage}). Use simple, respectful, everyday spoken words that an Indian site worker feels comfortable with—never stiff medical textbook prose.
2. You are like a caring elder sibling / site buddy checking how their body feels (aches, fever, dizziness, sleep, dehydration) AND how their mind/life feels (home tension, money stress, sadness, exhaustion).
3. Never judge. Reassure them warmly when needed that their private words stay 100% locked from supervisors/JaanShield—only anonymized fitness pacing is adjusted to keep them safe.
4. Compute an honest anonymized mental/physical wellbeing adjustment:
   - calm -> mentalRfBoost 0.00..0.03
   - mild (tired, slight stress, poor sleep) -> mentalRfBoost 0.05..0.09
   - strained (heavy stress, sadness, body pain, headache, sleeplessness) -> mentalRfBoost 0.12..0.18, recommendShadedDuty: true
   - rest_advised (dizzy, chest discomfort, severe exhaustion, severe distress) -> mentalRfBoost 0.20..0.25, recommendShadedDuty: true, recommendMedicalHold: true
5. End replyInLanguage with ONE gentle, caring follow-up question in ${languageName} about their health, sleep, or life.`;

    const userPrompt = `Worker first name: ${workerFirstName}
Selected language: ${languageName} (${nativeScript})
${formattedHistory ? `Recent private conversation:\n${formattedHistory}\n` : ''}
Latest worker message: "${message}"`;

    const attempts: Array<{
      model: string;
      useLowThinking: boolean;
      timeoutMs: number;
      delayMs: number;
    }> = [
      { model: 'gemini-4-hydrogen', useLowThinking: true, timeoutMs: 4500, delayMs: 0 },
      { model: 'gemini-3.1-flash-lite', useLowThinking: false, timeoutMs: 4500, delayMs: 150 },
    ];

    let text: string | undefined;
    let lastError: unknown = null;

    for (const attempt of attempts) {
      if (attempt.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, attempt.delayMs));
      }
      try {
        const config: Record<string, unknown> = {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: checkInResponseSchema,
        };
        if (attempt.useLowThinking) {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
        }

        const response = await Promise.race([
          ai.models.generateContent({
            model: attempt.model,
            contents: userPrompt,
            config,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Model response timed out')), attempt.timeoutMs),
          ),
        ]);

        if (response.text) {
          text = response.text;
          break;
        }
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient =
          msg.includes('503') ||
          msg.includes('429') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('timed out');
        if (!isTransient) break;
      }
    }

    if (!text) {
      throw lastError instanceof Error
        ? lastError
        : new Error('JaanSaathi AI service is temporarily busy. Please try again in a moment.');
    }

    const parsed = JSON.parse(text) as Record<string, unknown>;
    const rawMood = String(parsed.buddyMood || 'warm');
    const rawStrain = String(parsed.mentalStrainLevel || 'calm');
    const rawBoost = Number(parsed.mentalRfBoost);

    res.status(200).json({
      replyInLanguage:
        sanitizeInput(parsed.replyInLanguage, 2000) ||
        'Take care of yourself today. Let us take things gently.',
      buddyMood: ALLOWED_MOODS.has(rawMood) ? rawMood : 'warm',
      mentalStrainLevel: ALLOWED_STRAIN.has(rawStrain) ? rawStrain : 'calm',
      mentalRfBoost: Number.isFinite(rawBoost)
        ? Number(Math.min(0.25, Math.max(0, rawBoost)).toFixed(2))
        : 0,
      recommendShadedDuty: Boolean(parsed.recommendShadedDuty),
      recommendMedicalHold: Boolean(parsed.recommendMedicalHold),
      gentleCareTip: sanitizeInput(parsed.gentleCareTip, 350),
    });
  } catch (err) {
    console.error('JaanSaathi Gemini API error:', err);
    const rawMsg =
      err instanceof Error ? err.message : 'Could not reach JaanSaathi AI service right now.';
    const friendlyMsg =
      rawMsg.includes('503') || rawMsg.includes('UNAVAILABLE')
        ? 'JaanSaathi AI is experiencing a brief traffic spike. Please tap Send again in a few seconds.'
        : rawMsg.includes('429') || rawMsg.includes('RESOURCE_EXHAUSTED')
          ? 'JaanSaathi AI rate limit reached temporarily. Please wait a moment and try again.'
          : rawMsg;
    res.status(502).json({ error: friendlyMsg });
  }
}

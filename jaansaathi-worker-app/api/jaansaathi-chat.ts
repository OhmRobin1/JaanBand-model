import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const ALLOWED_MOODS = new Set(['warm', 'listening', 'encouraging', 'caring', 'alert']);
const ALLOWED_STRAIN = new Set(['calm', 'mild', 'strained', 'rest_advised']);

function sanitizeInput(val: unknown, maxLen: number): string {
  if (typeof val !== 'string') return '';
  return val.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLen);
}

const checkInResponseSchema = {
  type: Type.OBJECT,
  properties: {
    replyInLanguage: { type: Type.STRING },
    buddyMood: {
      type: Type.STRING,
      enum: ['warm', 'listening', 'encouraging', 'caring', 'alert'],
    },
    mentalStrainLevel: {
      type: Type.STRING,
      enum: ['calm', 'mild', 'strained', 'rest_advised'],
    },
    mentalRfBoost: { type: Type.NUMBER },
    recommendShadedDuty: { type: Type.BOOLEAN },
    recommendMedicalHold: { type: Type.BOOLEAN },
    gentleCareTip: { type: Type.STRING },
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

export default async function handler(
  req: { method?: string; body?: Record<string, unknown> },
  res: {
    status: (code: number) => { json: (payload: unknown) => void };
  },
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: 'Server GEMINI_API_KEY is missing in Vercel/environment variables.',
    });
    return;
  }

  const body = req.body || {};
  const message = sanitizeInput(body.message, 1500);
  const languageCode = sanitizeInput(body.languageCode, 16) || 'hi';
  const languageName = sanitizeInput(body.languageName, 64) || 'Hindi';
  const nativeScript = sanitizeInput(body.nativeScript, 64) || 'हिन्दी';
  const stateCoverage = sanitizeInput(body.stateCoverage, 160) || 'India';
  const workerFirstName = sanitizeInput(body.workerFirstName, 40) || 'Saathi';
  const historyRaw = Array.isArray(body.history) ? body.history.slice(-6) : [];

  if (!message) {
    res.status(400).json({ error: 'Please share how you feel today.' });
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

    const systemInstruction = `You are JaanSaathi, a friendly cartoonish worker companion built ONLY for an Indian site worker's private physical & emotional wellbeing.
Rules:
1. Reply ENTIRELY in ${languageName} (${nativeScript}, code: ${languageCode}, regions: ${stateCoverage}) using warm, simple everyday words.
2. Ask empathetically about physical symptoms, sleep, heat fatigue, stress, and personal life worries.
3. Reassure them that managers/JaanShield NEVER see their private messages—only anonymized fitness pacing adjustments.
4. Score mentalStrainLevel (calm / mild / strained / rest_advised) and mentalRfBoost (0.00 to 0.25). End replyInLanguage with ONE gentle follow-up question.`;

    const userPrompt = `Worker: ${workerFirstName}
Language: ${languageName} (${nativeScript})
${formattedHistory ? `Recent private chat:\n${formattedHistory}\n` : ''}
Message: "${message}"`;

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: userPrompt,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: checkInResponseSchema,
      },
    });

    if (!response.text) throw new Error('Empty Gemini response');
    const parsed = JSON.parse(response.text) as Record<string, unknown>;
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
    res.status(502).json({
      error: err instanceof Error ? err.message : 'JaanSaathi AI service unavailable',
    });
  }
}

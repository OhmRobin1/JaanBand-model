import 'dotenv/config';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const app = express();
app.use(express.json({ limit: '1mb' }));

const ALLOWED_MOODS = new Set(['warm', 'listening', 'encouraging', 'caring', 'alert']);
const ALLOWED_STRAIN = new Set(['calm', 'mild', 'strained', 'rest_advised']);

function sanitizeInput(val: unknown, maxLen: number): string {
  if (typeof val !== 'string') return '';
  return val.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLen);
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

app.post('/api/jaansaathi-chat', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error:
        'Server GEMINI_API_KEY is not configured. Add GEMINI_API_KEY in AI Studio Secrets / environment variables.',
    });
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const message = sanitizeInput(body.message, 1500);
  const languageCode = sanitizeInput(body.languageCode, 16) || 'hi';
  const languageName = sanitizeInput(body.languageName, 64) || 'Hindi';
  const nativeScript = sanitizeInput(body.nativeScript, 64) || 'हिन्दी';
  const stateCoverage = sanitizeInput(body.stateCoverage, 160) || 'India';
  const workerFirstName = sanitizeInput(body.workerFirstName, 40) || 'Saathi';
  const historyRaw = Array.isArray(body.history) ? body.history.slice(-6) : [];

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

    const text = response.text;
    if (!text) {
      throw new Error('Empty response from Gemini API.');
    }

    const parsed = JSON.parse(text) as Record<string, unknown>;
    const rawMood = String(parsed.buddyMood || 'warm');
    const rawStrain = String(parsed.mentalStrainLevel || 'calm');
    const rawBoost = Number(parsed.mentalRfBoost);

    res.json({
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
    res.status(502).json({
      error:
        err instanceof Error
          ? err.message
          : 'Could not reach JaanSaathi AI service right now.',
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`JaanBand & JaanSaathi server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();

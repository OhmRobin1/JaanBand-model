# JaanSaathi — Private Worker Wellbeing Companion (All Indian State Languages)

A dedicated, worker-first companion app paired to **JaanBand Core MK-IV** and **JaanShield** through the same Firebase project (`thinking-airway-t01dl`, Firestore DB `ai-studio-jaanbandcoremkiv-70021240-1a25-48a5-9641-54bb740133e2`).

## Privacy Architecture (Zero-Leak Vault)
- **Worker-only vault (`/worker_private/{workerUid}` and `/worker_private/{workerUid}/checkins/{id}`)**: Protected by `firestore.rules` so **ONLY `request.auth.uid == workerUid`** can read or write private conversations about physical pain, stress, sleep, or personal/family matters. Site managers and JaanShield admin accounts are strictly blocked.
- **Anonymized Fitness Adjustment (`workers/{workerId}`)**: JaanSaathi's AI buddy updates **only** `mentalStrainLevel`, `mentalRfBoost` (`0.00–0.25`), `dynamicHrY`, `dynamicHrR`, `riskFactor`, and anonymized `fitStatus`/`fitReasons` (`"Wellbeing & Recovery Hold advised (private details withheld)"`).

## Supported Indian State Languages
Covers **24 languages across all 28 States & 8 Union Territories**: Hindi, Bengali, Marathi, Telugu, Tamil, Gujarati, Kannada, Malayalam, Odia, Punjabi, Assamese, Urdu, Maithili, Santali, Konkani, Kashmiri, Dogri, Manipuri (Meiteilon), Nepali, Mizo, Khasi, Kokborok, Ladakhi/Bhoti, and English/Hinglish.

## Push to GitHub & Deploy on Vercel
1. Initialize a new Git repository inside `jaansaathi-worker-app/`:
   ```bash
   cd jaansaathi-worker-app
   git init
   git add .
   git commit -m "Initial JaanSaathi Worker Companion"
   git branch -M main
   git remote add origin https://github.com/<YOUR_USERNAME>/jaansaathi-worker-app.git
   git push -u origin main
   ```
2. Import the repository on **Vercel**:
   - Add Environment Variable `GEMINI_API_KEY` in Vercel Project Settings.
   - Add your deployed Vercel domain (`your-app.vercel.app`) to **Firebase Console -> Authentication -> Settings -> Authorized domains** so Google Sign-In works seamlessly.
3. Link a worker's Google UID once in JaanBand Manager Registry (`Edit Health Profile -> Optional JaanSaathi Worker UID`) so their private check-ins automatically tune their JaanBand thresholds and Fit-to-Work pacing.

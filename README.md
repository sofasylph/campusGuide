# Campus Guide: scaffold

`public/index.html` is the design team's Campus Guide v2 screens (the only change: the Read/Listen choice is removed, the guide is always text). Added on top: a typing box that talks to an AI, a "What's here" resources screen, and a small server that keeps the API key out of the browser.

## Run
1. Install Node 18+ (no npm install needed).
2. Copy `.env.example` to `.env` and paste your Anthropic API key.
3. `node server.js`, then open http://localhost:3000

Without a key the guide still runs with its original buttons; the typing box simply doesn't appear.

## Change things without touching code
- `resources.json`: add a resource (title, blurb, url, tags). The AI can only recommend items from this list.
- `prompt.md`: what the AI is told. Counsellors should own this.
- `safety-rules.json`: phrases that skip the AI and open the Urgent screen. Starter list only.

## Know before showing anyone
- The Urgent screen wording is still the design team's placeholder; counsellors must write it, and nobody is notified yet.
- This app does not store what students type. Anthropic's own retention terms still apply to what is sent to the API.
- Hindi/Marathi are not handled by the safety rules yet.

## Counsellor dashboard
Set `COUNSELLOR_KEY` in `.env`, restart, and open http://localhost:3000/counsellor.html. Notes sent by students and safety flags are stored in `data/store.json` (kept out of Git). Demo-grade login only: real student data needs FLAME IT and ethics sign-off. Some hosts wipe files on redeploy.

## Questionnaires, survey and languages
- `scales.json` holds the questionnaires, thresholds and the survey. `placement` decides where they appear (`pathwayEnd` or `off`); change it when the journey map is final. Wording and thresholds are marked unverified until counsellors approve them. ISI is disabled until its rights holder gives permission.
- Scores are calculated by `public/scoring.js`, used by both the browser and the server. Students only see a score and plain wording; colours appear only on the counsellor dashboard.
- Languages: pick हिंदी or मराठी on the intro, or add `?lang=hi` to the address. Reviewed translations go in `public/lang/hi.json` and `mr.json`; anything else is translated by the AI and cached in `data/`. Questionnaire text and the Urgent screen use reviewed translations only. `lang-glossary.json` holds the Cultural Dictionary phrases.

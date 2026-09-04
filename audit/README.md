# AIListings — AI Visibility Lead Audit (MVP)

Measures whether the normal **consumer ChatGPT website** surfaces a local business at three fixed
commercial layers, then identifies the genuine competitors ChatGPT puts forward instead and drafts a
short outreach message. Every measurement is taken from the live chatgpt.com UI in a real browser
window; screenshots, prompts, displayed responses, timestamps and conversation URLs are retained as
evidence.

| Layer | Meaning | Test |
|---|---|---|
| **VISIBLE** | ChatGPT knows the company exists | `Roofing companies in Southampton` |
| **RECOMMENDED** | ChatGPT puts it forward when asked who to use | `Who would you recommend for roof repairs in Southampton?` |
| **CONVERSATIONAL** | It appears when a real problem is described, then "who should I speak to?" | multi-turn, same conversation, up to 3 follow-ups |

Commercial priority: CONVERSATIONAL > RECOMMENDED > VISIBLE. `Visible: YES / Recommended: NO /
Conversational: NO` is a valid and important result. A technical failure is never reported as NO.

## Run it (on your own machine, with your own Chrome)

Requirements: Node 22.18+ and Google Chrome (falls back to Playwright's bundled Chromium).

```bash
cd audit
npm install
npm start                 # http://localhost:3210
```

1. Open http://localhost:3210, enter Business Name, Website, Location and click **RUN AI VISIBILITY AUDIT**.
2. If ChatGPT asks for a sign-in the audit returns `SIGN_IN_REQUIRED` and a **CONNECT CHATGPT** button
   appears. Click it: a normal Chrome window opens on chatgpt.com. Sign in as you usually would. The app
   never sees or stores your password; it only reuses the browser profile in `.data/chrome-profile/`.
3. Run the audit again. Each layer runs in its own **Temporary Chat** so memories and history do not
   influence results.

CLI equivalents: `npm run connect`, `npm run audit -- "SPP Roofing" https://www.spproofing.co.uk/ Southampton`.

Environment variables: `PORT` (3210), `AUDIT_HEADLESS=1` (no visible window; only for servers with a
display or xvfb), `AUDIT_BROWSER_CHANNEL=chrome|msedge|chromium` (default `chrome`), `AUDIT_DATA_DIR`,
`AUDIT_PROFILE_DIR`, `AUDIT_TEMPORARY_CHAT=0`, `AUDIT_RESPONSE_TIMEOUT_MS` (180000).

## API (shape reserved for the later CRM integration)

```
POST /api/audits            { business_name, website, location, lead_id?, include_brand_diagnostic? }  -> 202 { id }
GET  /api/audits/:id        { summary, record }   summary = VISIBLE / RECOMMENDED / CONVERSATIONAL / topCompetitors / outreachMessage / evidence
GET  /api/audits            list of summaries
GET  /api/chatgpt/status    connect state (add ?check=1 to probe the live sign-in state)
POST /api/chatgpt/connect   opens the browser for a one-time normal sign-in
GET  /evidence/:id/:file    screenshot PNGs
```

States: `YES`, `NO`, `NOT_TESTED`, `ERROR`, `SIGN_IN_REQUIRED`. Audit status: `COMPLETE`,
`INCOMPLETE` (any layer not YES/NO; no outreach message is generated), `SIGN_IN_REQUIRED`.

## Modules

```
src/business/      understand.ts, catalogue.ts   what the business sells, market, requirement, problem
src/prompts/       generate.ts                   one prompt per layer + contextual follow-ups + separate brand diagnostic
src/chatgpt/       provider.ts (interface), playwrightProvider.ts (live chatgpt.com), mockProvider.ts (tests only)
src/evidence/      capture.ts                    screenshots per turn
src/analysis/      extract.ts, normalise.ts      business names from the rendered response; name-variant normalisation
src/competitors/   classify.ts                   prospect / competitor / directory / review site / marketplace / informational / unrelated / uncertain; ranking
src/audit/         decide.ts, engine.ts          layer + audit decisions; orchestration
src/outreach/      generate.ts                   evidence-bound outreach message
src/persistence/   store.ts                      one JSON file per audit under .data/audits
src/ui/            index.html                    the two-page UI
src/server.ts, src/cli.ts, src/config.ts
```

The browser is isolated behind `ChatGptProvider`; commercial logic never touches Playwright.
If chatgpt.com changes its markup, update `SELECTORS` in `src/chatgpt/playwrightProvider.ts`.

## Tests

```bash
npm run typecheck
npm test            # 27 logic scenarios (mock provider) + 4 adapter plumbing tests against a local DOM double
npm run build
```

The DOM double in `test/browser/` only proves the Playwright plumbing (typing, sending, waiting for
streaming to stop, reading the answer, screenshots, sign-in walls, stalled responses). It is not
ChatGPT and does not replace the live acceptance run.

Nothing under `.data/` (audits, screenshots, browser profile) is committed.

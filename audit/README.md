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

### What YES means

A layer is `YES` only when the **prospect itself** is visibly named in ChatGPT's displayed answer for
that layer. Each layer stores two independent facts:

- `prospectPresent` — YES/NO for the prospect alone;
- `businessesSurfaced[]` — every genuine, user-visible named business in that layer's responses.

`CONVERSATIONAL prospectPresent = NO` with `businessesSurfaced = [Limartra Tiling and Restoration,
SDB Tiling, Signature Tiling & Carpentry]` is a normal, correct result: ChatGPT recommended others.

Every `YES` carries `prospectMatchEvidence[]`: the exact visible snippet, its surrounding text, where it
was found (bold / heading / list / link text / prose) and how it matched (`business_name`,
`name_alias`, `visible_domain`). Admissible evidence is the business name or a defensible alias, or the
prospect's own domain shown as text. Hidden hrefs, map/citation infrastructure, generic trade words
("Tiling", "Wendover Tilers") and approximate resemblance never count. Raw hrefs are never candidates,
so Mapbox / OpenStreetMap / Google Maps / ChatGPT links cannot become competitors.

### Prospect-facing report

Every `COMPLETE` audit receives a random 256-bit token and a public page at `GET /a/:token` (also in the
summary as `publicUrl`). Incomplete, errored or sign-in-required audits never get one. The page shows
the business name, what was tested, the three verdicts, the strongest three genuine competitors, why
visible differs from recommended, expandable evidence screenshots and a CTA. It contains no internal
ids, provider details, classification data, paths, errors or ChatGPT transcripts. Screenshots are
served only at `/a/:token/evidence/:file` for files that belong to that audit.

Tracking per report, in two separate tiers:

- **Requests (diagnostics):** `pageRequestCount`, `firstRequestedAt`, `lastRequestedAt` on every valid
  `GET /a/:token`, including link-preview bots, messaging clients and scanners.
- **Engagement (use this for the CRM):** `firstEngagedAt`, `lastEngagedAt`, `engagedViewCount`. The page
  carries a per-render session nonce and posts a first-party beacon to `POST /a/:token/engaged` only
  after the document has loaded and stayed visible for about 2 seconds. A nonce the server did not
  issue is rejected; a nonce that already counted is ignored, so one rendered page counts once while a
  refresh or a new visit counts again. No third-party analytics.
- **CTA:** `ctaClickedAt`, `ctaClickCount` on `GET /a/:token/cta`, which redirects to `PUBLIC_CTA_URL`.

`GET /api/audits/:id/tracking` returns all of it. GoHighLevel notification must key off
`firstEngagedAt` / `engagedViewCount`, never `pageRequestCount`.

Set `PUBLIC_BASE_URL` to the externally reachable origin (default `http://localhost:<PORT>`).

### Re-interpreting a stored audit

```bash
npm run reanalyse -- <auditId>     # re-runs extraction, classification, decisions, competitors, outreach
```

Uses the responses and screenshots already captured; the browser is not opened. Useful after an
interpretation fix, and for checking a past verdict against its screenshots.

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
npm test            # 49 logic tests (mock provider, incl. the LS-Tiling regression fixture) + 6 real-browser tests (adapter plumbing against a local DOM double, engagement beacon)
npm run build
```

The DOM double in `test/browser/` only proves the Playwright plumbing (typing, sending, waiting for
streaming to stop, reading the answer, screenshots, sign-in walls, stalled responses). It is not
ChatGPT and does not replace the live acceptance run.

Nothing under `.data/` (audits, screenshots, browser profile) is committed.

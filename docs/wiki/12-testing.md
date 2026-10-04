# Testing

> **Last verified:** 2026-10-05 · **Part of:** [Classroom-survivors Repo Wiki](README.md)

**Owner files:** `package.json` (`test` script), `test_*.js` (root), `api/test_auth.js`, plus the out-of-chain `vs_*` test family.

`npm test` (root) is the **required-green gate before any commit**. It chains 18 Node scripts
(`package.json:7`). Verified 2026-10-05: **589 assertions, 0 failures** (counts per file below;
the stamp guard prints no summary line).

```text
test_deploy_stamp_sync.js          # GUARD — runs FIRST, fails run on stamp drift   (— )
test_widgets_regression.js         # jsdom — scramble + handwriting answer row, real scripts (82)
test_handwriting.js                # pure Node — handwriting mask maths, synthetic rings (40)
test_handwriting_browser.js        # Playwright + real Chrome — Fredoka glyph masks + trace flow (30)
test_sr_once_per_session.js        # SR spaced-repetition invariants (sr_engine)      (22)
test_round_e_dedup.js              # Round E sub-round pair selection rules           (16)
test_session_flush_deadline.js     # flush deadline + queue/SR sync contracts (vm)    (84)
test_auto_archive_analytics.js     # saveAnalytics pure helpers (archive + acks)      (15)
test_archive_merge_dashboard.js    # teacher_dashboard mergeAnalytics/getAnalyticsInRange (7)
test_speech_hygiene.js             # Recorder AudioContext teardown + sp* breadcrumbs (10)
test_td_gate.js                    # Tower Defense live/preview URL gate (jsdom)      (11)
test_td_core.js                    # Tower Defense core behaviors (Playwright + real Chrome) (23)
test_asset_manifest.js             # sprite/music/sfx lists + 3-way vocab naming contract (171)
test_geo_events.js                 # saveAnalytics geo v2: diversion, samples, consensus (15)
test_geo_capture.js                # client capture gate/rounding/flags (vm)          (15)
test_geo_export.js                 # geo_export: conversion, CSV, map HTML, escaping  (23)
test_geo_map.js                    # geo_map: GCJ points, haversine, ranking, Gaode links (18)
test_dashboard_security.js         # sanitizeAvatar allowlist + authorizeClearGeo     (7)
```

Two extra aliases: `npm run test:td` = `test_td_gate.js && test_td_core.js`. The backend has its own suite: `cd api && npm test` → `api/test_auth.js` (requires the local Functions runtime on `:7072` + an isolated test container — see [Backend API](10-backend-api.md)).

## The stamp guard must stay first

`test_deploy_stamp_sync.js` asserts the three deploy stamps are byte-identical (`version.json` version == `frontend_auth.js` `APP_VERSION` == `index.html` `frontend_auth.js?v=`). It is intentionally the first command in the chain so drift fails the whole run. Never reorder, never bypass. (Why: red update banner for all users — see [Auth/Versioning](04-auth-versioning.md).)

## Harness styles (know which one you're extending)

| Harness | Files | How it works |
|---|---|---|
| **Pure Node** (no DOM) | stamp guard, auto-archive, archive-merge, sr tests (VM-loaded pure logic), `test_handwriting.js` | `node -e` style asserts; some load real source into a `vm` context with fixture data. `test_handwriting.js` `require`s `handwriting.js` (it exports its pure functions under a `module.exports` guard that is inert in the browser) and drives the mask maths with synthetic rings. |
| **jsdom, real scripts** | `test_widgets_regression.js`, `test_sr_once_per_session.js`, `test_td_gate.js`, `test_round_e_dedup.js` | Loads `index.html` into JSDOM, strips remote `<script src>`, evals the REAL project scripts in index.html order into one blob (so top-level bindings are visible), stubs only externals (Phaser, Web Audio, Firebase, matchMedia). Asserts real widget behavior (placements, freezes, depleting banks). **jsdom has no 2D canvas**, so the handwriting trace box cannot run there — only its answer row can. |
| **Playwright + real Chrome** | `test_td_core.js`, `test_handwriting_browser.js` (and the standalone `vs_*` device/gameplay tests) | `playwright-core` driving `C:\Program Files\Google\Chrome\Application\chrome.exe` against `file:///<repo>/index.html`. Network-dependent environment (jsdom can't run Phaser, and only a real browser can rasterise the Fredoka glyph masks). |
| **HTTP integration** | `api/test_auth.js` | Starts from a running `func start` on `:7072`; exercises login/token/save flows against the test Cosmos container. |

jsdom harness details that bite: the script order list inside each test **must mirror index.html** — adding a new production script means updating the tests' `order` arrays; tests eval scripts as one concatenated blob so cross-file top-level bindings resolve; `file://` URL is used so relative asset paths resolve.

## Contract tests that pin cross-layer promises

These exist because their contracts were broken in production; treat failures as regressions, not flakiness:

- `test_session_flush_deadline.js` — the completion-time flush (`flushAnalyticsWithDeadline`) must resolve true when drained and **never hang past the deadline**; cached-profile writer must survive quota errors. Also pins the 2026-09-03a **ack discipline**: full-ack drains the queue / silent-200 keeps the queue / partial-ack keeps the queue.
- `test_auto_archive_analytics.js` — `splitAnalyticsForArchive` (700-trigger, 90-day sessions, 500-recent retention), fail-safe archive-then-trim, and `applyEventsWithAck` (added vs duplicate ack lists) — the server-side contract the client relies on.
- `test_sr_once_per_session.js` — SR state written ONCE per session at first check; failure interval rules; leech handling; 1-in-5 new material.
- `test_round_e_dedup.js` — due-status beats new material; E1 favors current page / E2-E3 avoid it; no repeat pairs in a session. Since 2026-09-08a also pins **Rule5 (cooldown floor: all-cooldown pool still serves 3 least-overdue pairs, never null)** and **Rule6 (`normMatchText` whitespace/case normalization)**.
- Since 2026-09-08a `test_session_flush_deadline.js` additionally pins the **sticky page-advance** (`csPendingPageAdvance` persists, `reapplyPendingPageAdvance()` restores pre-check, `updateStudent` re-sent until confirmed) and the **`queueDrain` login report** (backlog counts + oldest timestamp + pending SR/increment flags; silent on a clean device).
- `test_session_flush_deadline.js` is numbered by **block**, and blocks 7–9 pin the three 2026-09-16 sync rounds (test file :597, :639, :659):
  - **Block 7 — blocker-era hardening:** the 500-event backpressure cap, the 200-event flush chunk, the stringify guard, foreign-`ownerId` dropping, and the save-blocked banner trigger.
  - **Block 8 — session-first ordering:** session events must reach the head of the batch so a session ack never starves behind an exercise pile (two assertions).
  - **Block 9 — SR delta sync:** `extractSRDelta` selects only `lastSession === currentSession` entries, the `srDelta` flag rides the body, and a single-entry delta survives — the guard against the 64KB keepalive failure returning.
- `test_auto_archive_analytics.js` gained the **delta-merge contract** in 2026-09-16c (server merges a flagged delta onto stored state; an absent flag still means full replace).
- `test_speech_hygiene.js` (2026-09-04) pins that `Recorder.stop()` closes its `AudioContext` and releases references — each sentence gate builds a fresh Recorder, and leaked contexts hit iPadOS Safari's hard limit, killing the WebContent process ~5 min into a session (the "forced refresh" that looked like a network bug). Also pins `csPageHeartbeat` merging `sp*` speech breadcrumbs and carrying them through the restart diagnostic.
- **Three-way vocab filename contract** (added 2026-09-25a, in `test_asset_manifest.js`): the vocab-image naming rule exists as three *independent copies* that never call each other — `slice_vocab_sheet.js` `fileFor()` (the generator, which decides what is on disk), `asset_cache.js` `vocabImagePath()` (the prefetcher), and `game.js` `showVocabImage()` (the display). The block extracts all three expressions, evaluates them over every vocab string in the content packs, and fails if any disagrees with the generator. It exists because 2026-09-16a patched only the display copy and silently broke two images that worked.

## Out-of-chain test families (not in `npm test`)

- **`vs_*` tests** (device matrix, hitbox, boss, timer, DPR, charselect, uno-transition, promo lifecycle, …): standalone Playwright/Node scripts run ad-hoc via `node vs_<name>_test.js`. They are NOT part of the required gate — the full picture is in [Vampire Survivors](07-vampire-survivors.md). When touching VS code, run the relevant ones manually.
- **`api/` forensics & regression scripts** (`test_scorer_regression.js`, `tune_scorer.js`, `whatif_scorer.js`, …): operator tools, some requiring live DB access; never wire them into the required gate. See [Backend API](10-backend-api.md).

## Conventions

- Tests live at repo root (frontend) or `api/` (backend) — no `test/` dir. Names: `test_<topic>.js`; VS tests prefix `vs_`.
- Every new regression ships with a test that fails before the fix and passes after (this is how the stamp guard, ack discipline, and widget rules got locked in).
- No test framework — plain `node` + `assert`, PASS/FAIL lines, non-zero exit on fail (that's what makes the `&&` chain a gate).
- Playwright tests need real Chrome at the hardcoded path; jsdom tests need only `npm install` at root.

## Update discipline

Any agent that adds/changes a test file, changes the `test` script chain, or changes a pinned contract must update this page in the same commit. The wiki is the single source of truth; skills/memory hold only behavior rules and point here.

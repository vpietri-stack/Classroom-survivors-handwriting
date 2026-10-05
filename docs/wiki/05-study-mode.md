# Study Mode (UI Rounds A–D + Match; internal functions A/C/D/E/F)

> **Last verified:** 2026-09-04 · **Part of:** [Classroom-survivors Repo Wiki](README.md)

**Owner files:** `study_mode.js` (1360 lines — the whole subsystem), `index.html` (`#studyModeOverlay`, `#study-game-area`, exit X ~line 327), `style.css` (`.study-*` classes), `sr_engine.js` (content/pair selection helpers called from here), `game.js` (`playTTS`, `goBackFromGameSelection`, the global keydown guard).

Study Mode is the structured practice flow: 5 SR-selected words and 5 SR-selected sentences, drilled through five rounds of increasing production difficulty, plus three sub-rounds of sentence matching. Everything lives in one global `STUDY_STATE` and a set of top-level functions; there is no class.

## 🔴 The naming is off by one — trust code, not names

The **function names are shifted by one round relative to the UI labels**. `startRoundC` implements UI "Round B", `startRoundD` implements UI "Round C", and so on. The internal round keys also skip `'B'` (`STUDY_ROUNDS = ['A','C','D','E','F']`, `study_mode.js ~1265`). All freeze flags and timers follow the *internal* key (`_roundCFrozen` guards UI Round B).

| UI label (what the student sees) | Internal round key | Entry function | What it actually does |
|---|---|---|---|
| "Round A: Word Recognition" | `'A'` | `startRoundA (study_mode.js ~100)` | Listen to TTS, click the matching word |
| "Round B: Word Scramble" | `'C'` | `startRoundC (study_mode.js ~193)` | Letter bank → slots (depleting bank) |
| "Round C: Handwriting" | `'D'` | `startRoundD (study_mode.js ~470)` | Handwrite up to 6 random gaps on a trace canvas; the other letters are given |
| "Round D: Sentence Scramble" | `'E'` | `startRoundE (study_mode.js ~724)` | Word tiles → sentence slots (depleting bank) |
| "Round E1–E3: Sentence Matching" | `'F'` | `startRoundF (study_mode.js ~973)` | Match question tiles to answer slots, 3 sub-rounds |

Progress-bar labels (`STUDY_ROUND_LABELS`, ~1266) are `A:'Listen', C:'Scramble', D:'Write', E:'Sentence', F:'Match'` — also keyed by the internal names.

## Lifecycle

```mermaid
flowchart TD
    INIT[initStudyMode<br/>~29: SR-pick 5 words + 5 sentences] --> A["UI Round A — Listen & click<br/>startRoundA ~100"]
    A -->|"finishRoundA ~185"| B["UI Round B — Word Scramble<br/>startRoundC ~193<br/>(depleting bank)"]
    B -->|"finishRoundC ~464"| C["UI Round C — Handwriting<br/>startRoundD ~470<br/>(trace canvas, mask verification)"]
    C -->|"finishRoundD ~718"| D["UI Round D — Sentence Scramble<br/>startRoundE ~724<br/>(depleting bank + speech gate)"]
    D -->|"finishRoundE ~719 → startRoundF"| E["UI Round E1–E3 — Sentence Matching<br/>startRoundF ~973"]
    E -->|"subRound > 3 (~981)"| FIN[finishStudySession ~1200]
    E -->|"no unseen pairs (~1003)"| FIN
    FIN --> DONE["completion screen + awaited flush"]
    X["✕ exitStudyMode ~1250<br/>(any time)"] --> BACK["goBackFromGameSelection<br/>(game.js ~2336)"]
```

`initStudyMode (~29)`: reads `selectedClassContent` (book/unit/page), pulls content via `getStudyContentSR(book, unit, page, 'vocab'|'sentences', 5)` (sr_engine.js). Fewer than 5 of a kind shows a non-blocking notice (`showStudyNotice ~20`, replaces `alert()`) and runs a shorter session; zero of either aborts. It then sets `active=true`, resets SR tracking (`srStudyResults=[]`, `srUsedPairKeys=new Set()`), hides the start screen and every other overlay, **stops the Phaser scenes** (`MainScene`, `UnoScene`), hides the canvas, clears `minigameCountdownInterval`, hides the VS HUD buttons, sets `activeGameMode = null`, and shows `#studyModeOverlay`.

## STUDY_STATE shape

Declared at `study_mode.js ~2`; behavior fields are added dynamically by the rounds:

| Field | Meaning |
|---|---|
| `active` | Study Mode running. **Must be reset to `false` on exit** (see [exit pitfall](#exit-path--the-study_stateactive-trap)) |
| `words`, `sentences` | The 5 SR-picked words / sentences for this session |
| `remainingWordsRoundA` | Round A: words not yet recognized |
| `currentWordIndex` | Shared cursor for UI Rounds B and C |
| `currentSentenceIndex` | Cursor for UI Round D |
| `round` | Internal key `'A'…'F'` (drives the keydown router, ~1311) |
| `startTime`, `timerInterval` | Session timing |
| `isTransitioning` | Blocks ALL input during the 1–1.5s success advance (and the Round F 2s reset) |
| `srFinalized` | Set in `finishStudySession`/exit so results aren't double-finalized |
| `_roundCFrozen` / `_roundEFrozen` | Per-round freeze during wrong-answer reveal (UI Rounds B / D) |
| `roundDSlots`, `roundDGapOrder`, `roundDCursor`, `roundDAttempts`, `roundDGuided`, `roundDTrace` | UI Round C handwriting state: 1:1 slot model, the gap indices, the gap being written, failures on it, whether the outline has faded in, and the trace-box widget |
| `subRound`, `sentencePairs`, `pairAttempts[]`, `pairQueued[]` | UI Round E matching state |

Module-level globals: `srStudyResults` (per-item `{type, key, firstAttempt}` records, ~16) and `srUsedPairKeys` (pairs already shown in UI Round E this session, ~17).

## Round reference

### UI Round A — Word Recognition (`'A'`)
`renderRoundAWords (~122)` renders the 5 words as buttons (shuffled, removed on success — no re-layout). `playRoundAPrompt (~147)` picks a random *remaining* word, sets the global `currentTTSWord`, and plays TTS after 500ms (translation hint + vocab image via `showTranslation`/`showVocabImage`, game.js). `checkRoundA (~160)`: correct → scale-out animation, remove from list, next prompt; wrong → `synthError()`, red shake, replay TTS after 600ms. Guards on `isTransitioning`.

### UI Round B — Word Scramble (`'C'`) — **depleting bank**
Containers: `#scramble-slots` (answer) + `#scramble-bank` (source), built by `nextRoundCWord (~201)`.

- **Slots**: one `.study-slot` per character. Letter slots are wrapped in `.word-group` divs; separators (` `, `-`, `.`, `?`, `!`) are direct flex items with `dataset.fixed="true"` (space is invisible; the other four render their glyph).
- **Bank**: the word's letters minus separators, shuffled, as `.study-letter-btn` buttons. **The bank DEPLETES**: `addLetterToSlot (~304)` places into the earliest empty non-fixed slot and **removes the clicked button** (~321). Clicking a placed letter (`removeLetterFromSlot ~324`) clears the slot and appends a **fresh** bank button — the gap stays (no reflow).
- `roundCSlots (~300)` is the ONLY way to enumerate slots: `querySelectorAll('#scramble-slots .study-slot')`. `#scramble-slots.children` are the `.word-group` wrappers — indexing them silently corrupts state (see [.word-group convention](#the-word-group-dom-convention)).
- `checkRoundC (~354)`: incomplete → soft `synthError()` nudge, no reset. Grades every non-fixed slot against `targetWord[i]` (full-string index; fixed slots occupy their own positions). Correct → freeze + `isTransitioning`, SR success push, `queueExerciseEvent('wordScramble','study',word)`, advance after 1s. Wrong → freeze, SR failure recorded **at the first wrong check** (`exerciseAttempts === 1`), `incrementExerciseAttempts()`, and a 5s reset that returns EVERY letter to the bank before unfreezing. Quirk: this widget stores the reset timer **per slot** (`slot._resetTimer`), not on `STUDY_STATE`.
- `clearRoundC (~438)`: blocked only during the 1s success transition. Clears every slot's `_resetTimer`, returns letters to the bank, unfreezes — **CLEAR must stay live during the reveal**.

### UI Round C — Handwriting (`'D'`) — write the missing letters
`nextRoundDWord (~478)`: one slot per character; `hwPickGaps(word, ROUND_D_MAX_GAPS=6)` (handwriting.js) picks up to **6 random letter positions** as gaps the student must handwrite, left-to-right. The remaining letters render as given context (`.hw-slot-given`, dashed border), so a 20-letter item costs the same as a 6-letter one. Separators (`[' ',"'",'-','.','?','!',',']`) render as `.hw-slot-fixed` — no box at all; the kid theme forces a background onto every `.study-slot` with `!important`, so `.hw-slot-fixed` needs its own kid-mode `!important` override or a ghost box appears where the space is.

- **Verification, not classification.** The target letter is always known, so the student's ink is compared against a mask rendered from that one glyph in Fredoka (`hwGlyphMask`, 128×128; `hwEnsureFont()` is awaited in `startRoundD` so the mask is never a fallback font's shape). `hwVerify` returns *precision* (ink inside the dilated guide), *recall* (guide covered by dilated ink), *missingPart* and extent ratios; `hwAccept` applies the active profile's bars. All maths runs in a fixed 128×128 mask space, so thresholds are independent of canvas size and devicePixelRatio.
- **Four bars, because coverage alone is blind to missing strokes.** A crossbar is ~2% of a t's ink and a dot ~15% of an i's, so precision/recall happily accept a bare stem for t, i or j. Backing them up: (1) `missingPart` — the largest *stroke-thick* connected piece of the guide left unwritten (`hwMissingPart`, erosion drops wobble slivers); (2) `HW_MIN_EXTENT` — after normalisation the ink must be ≥70% as wide and tall as the glyph; (3) `minStrokes` — a glyph the font draws in separate pieces (`hwGuideComponents`: i, j) cannot be written in one unbroken stroke, counted against the target's own case so a bare stem cannot hide behind capital I; (4) `overfilled` — a solid fill of an over-large box is not a letter. `hwNormalise` anchors the ink's baseline to the guide's and clamps scale to [0.75, 1.35]: children drift in size far more than a tight clamp allows and read a size refusal as "it wasn't centred". The pen (`HW_PEN` 9) is deliberately NARROWER than a glyph stem (~11) — a fat pen blankets neighbouring letters' ink, which is what let c-for-a and a-for-g through.
- **Start and end anchors.** `hwGlyphAnchors` derives two points per letter from the mask (centre of its topmost and bottommost ink row) and the widget paints them as a green start dot and a red end ring, over the ink, in both stages — the workbook cue for where a letter begins and finishes.
- **Pen lifts are legal.** A lift that does not complete the letter is not judged: the widget waits `HW_STROKE_GAP_MS` (1.5s) for the next stroke before the attempt counts (`pendingReject` in `hwCreateTraceBox`). A lift that DOES complete it accepts immediately, so multi-stroke letters need no "done" button. Either case is accepted; capitalisation is not this round's battle.
- **Scaffold ladder** (`roundDRejectLetter`): attempts 1–2 are a blank box at the `free` profile; from attempt 3 the outline fades in (`roundDTrace.setGuided(true)`) at the `guided` profile — looser on fill and on missing parts (a trace over the outline that stops short must still pass) but STRICTER on cover, because with the outline visible, stray ink off the letter is a worse signal; at attempt 5 (`ROUND_D_GIVE_UP_AFTER`) the letter is revealed as `.hw-slot-revealed` so a child can never dead-end. Erase (`clearRoundD`, or Backspace via `handleRoundDKeyDown`) is free — it does not count as an attempt.
- Accept → `synthGem`, slot turns `.bg-green-500`, 420ms, next gap. Word complete → `queueExerciseEvent('handwriting','study',word)` and the 1s advance. **Like the old spelling round, this round pushes no `srStudyResults` record** — it affects analytics only, never spaced repetition.
- `hwCreateTraceBox` owns the canvas and the Pointer Events (`touch-action: none` stops the page scrolling mid-trace) and registers window resize/orientation listeners — `exitStudyMode` destroys the widget or the listeners accumulate across sessions. It also writes `window.__hwLast` (target, verdict, precision, recall, missingPart, stroke counts, extent ratios, the bars in force) after every judgement.
- **Known limitation, do not "fix" blindly:** in Fredoka the t crossbar is ~2% of the glyph and a single-story a's stem sits where a c's tips flare, so "l for t" and "c for a" cannot be refused by any geometric bar that still accepts good letters. The bars are therefore field-tunable: the handwriting test repo's `hw_dev_entry.js` accepts `?prec= ?recall= ?miss=` and shows the `__hwLast` readout, so the numbers come from real handwriting rather than from synthetic pen paths (which proved unable to represent either good or bad letters faithfully — see `test_handwriting_browser.js`'s header).
- `test_handwriting.js` covers the pure mask maths; `test_handwriting_browser.js` draws pen paths derived from the glyph masks themselves and pins acceptance, the grace window, the stroke-count rule, the scaffold and the dead-end reveal.

### UI Round D — Sentence Scramble (`'E'`) — **depleting bank + speech gate**
`nextRoundESentence (~732)`: one `.sentence-slot` per token in `#sentence-drop-zone` (`dataset.expected`), shuffled `.study-word-tile` buttons in `#sentence-word-bank`. Array-wrapped sentence entries are unwrapped (`sentence[0]`).

- **Delegated listeners only** (~784, ~790): `bank.onclick` → `placeWordTile` for `e.target.closest('.study-word-tile')`; `dropZone.onclick` → `deleteWordTile` for `.study-word-tile.placed`. **Never add per-tile `onclick`** — the same click then fires twice (double-place / double-return).
- `placeWordTile (~812)` moves a **copy** into the earliest empty slot and removes the bank tile (depletes). `deleteWordTile (~829)` re-creates a bank button.
- `checkRoundE (~866)`: per-slot compare vs `dataset.expected`; tiles get `!bg-green-500`/`!bg-red-500`. Correct → SR success (`type:'sentences'`), `queueExerciseEvent('sentenceScramble','study',…)`, then the **speech gate**: if `window.SpeechStatus.isReady() && window.SpeechUI.makeSentenceGate`, the CHECK/CLEAR row is hidden and the gate is rendered *into the bank's space*; `onDone` advances. If speech isn't ready the skip reason is logged via `window.__speechLog` (~930 — "without this the skip is invisible in the field") and a 1s timer advances. The gate never affects SR state.
- Wrong → `_roundEFrozen = true` (not `isTransitioning`, so **CLEAR still works**), border flashes red, SR failure at first wrong check, `_roundEResetTimer` 5s: all tiles returned to the bank, unfreeze. `clearRoundE (~841)` does the same immediately and cancels the timer.

### UI Round E1–E3 — Sentence Matching (`'F'`) — **not depleting**
`nextRoundFSubRound (~980)`: 3 sub-rounds; pairs come from `getStudySentencePairsSubRoundSR(book, unit, page, srUsedPairKeys, preferPrevious = subRound > 1)` (sr_engine.js) — due pairs always win; E1 favors the current page, E2/E3 review earlier pages. If no unseen pairs exist anywhere up to the current page, Round F ends cleanly. Shown pairs are recorded in `srUsedPairKeys` so later sub-rounds pull fresh ones.

- `renderRoundF (~1017)`: question rows (`.sentence-a` + `.sentence-b-slot`), shuffled answer dock `#sentence-b-dock`. Tiles MOVE between dock and slots (same DOM node) — the dock never depletes.
- `selectBTile (~1061)` selects (yellow ring); `handleSlotClick (~1071)` places into a slot or returns a placed tile via `returnTileToDock (~1092)`.
- `checkRoundF (~1099)`: text-match per slot; each pair's SR result is queued once (`pairQueued`) with `firstAttempt = pairAttempts === 1`; failures recorded at the first wrong check per pair. All correct → 1.5s advance to the next sub-round; else 2s `resetRoundF (~1183)`.

## CHECK → reveal → reset (shared anti-cheese pattern)

Every drill round uses the same loop: **CHECK** → grade → color green/red → (wrong) **freeze editing for ~5s** → auto-reset to a clean board → (or CLEAR to skip the wait). Rules that were all ship-breaking bugs once:

1. Editing handlers (`addLetterToSlot`, `typeRoundD`, `placeWordTile`, …) early-return while frozen/transitioning.
2. **CLEAR stays live during the wrong-answer reveal** (only the 1s success transition blocks it). It cancels the pending reset, restores the source, and unfreezes.
3. The 5s reset must **restore depleting sources** (fresh bank buttons appended), never a bare `.remove()` — the 2026-07 "words vanish after 5 seconds" regression.

## Static palette vs depleting source

| Widget | Source | Behavior |
|---|---|---|
| UI Round B bank (`#scramble-bank`) | **DEPLETES** | Click bank letter → moves into earliest empty slot, bank tile removed; click placed letter → fresh tile back in bank |
| UI Round C trace box (`.hw-trace-canvas`) | n/a (ink, not tiles) | Pen strokes accumulate; acceptance is per-letter and immediate, so there is no CHECK button and no whole-word reveal |
| UI Round D bank (`#sentence-word-bank`) | **DEPLETES** | Tile moves to slot; placed tile returns as a fresh button |
| UI Round E dock (`#sentence-b-dock`) | STATIC (moves) | Same tile node shuttles dock ↔ slot |

Because three sources deplete, any reset/CLEAR path must rebuild the source from the placed tiles. Never "fix" a depleting source back to static (user-locked UX).

## Fixed-character (pinned) slots

In UI Round B, characters in `[' ', '-', '.', '?', '!']` render as **pinned** slots (`dataset.fixed="true"`, `nextRoundCWord ~237–257`): pre-filled, not clickable, never moved into the bank by reset/CLEAR, skipped by grading.

**Deliberately NOT pinned (draggable tiles the student must place):** apostrophe `'`, comma `,`, curly apostrophe `'`. This is a user decision — students must manually place apostrophes in contractions (`doesn't`, `I'm`); comma stays a tile in `yes, it is`. UI Round B and the game-mode word scramble must behave identically for separators (game.js mirrors this with its own `punct` array — change BOTH together, see [Game Modes](06-game-modes.md)).

**Policy: when the user points at a word whose separator is outside the pinned set, tell them — don't auto-extend the list.**

## The `.word-group` DOM convention

Letter slots in the answer rows are wrapped in `.word-group` divs so a word (e.g. `danced`) never breaks across lines; separators sit between groups so wrapping only happens at word boundaries. Consequence: **never index slots via `container.children[i]`** — the direct children are groups. Always use a `.study-slot` descendant query (`roundCSlots()` in production). UI Round C's row is rendered as HTML strings with `<span class="word-group">` (`renderRoundDSlots ~560`). `fitAnswerArea` (game.js ~1371) shrinks `--answer-font`/`--slot-size` when a long word would overflow narrow phones.

## Keyboard support

`study_mode.js` registers one global `keydown` listener (~1311): `if (!STUDY_STATE.active) return;` then routes by `STUDY_STATE.round`:

- Internal `'C'` (UI Round B) → `handleRoundCKeyDown (~1321)`: Backspace removes the last filled letter-slot; letter keys click the first matching bank button; Enter = CHECK.
- Internal `'D'` (UI Round C) → `handleRoundDKeyDown (~1330)`: Backspace = `clearRoundD` (wipe the current letter's strokes). No letter typing — input is the trace canvas.

## SR recording rules

- Success: `{type:'vocab'|'sentences'|'sentencePairs', key: itemKey(item), firstAttempt: exerciseAttempts === 1}` pushed at the successful check; `queueExerciseEvent(...)` fires the analytics event.
- Failure: pushed **at the first wrong check** per item (UI Rounds B, D, E), so quitting after a mistake still marks the item due next session. `finalizeSession` collapses first-failure + later-success.
- Partial sessions: `exitStudyMode` finalizes non-committed results with `finalizeSession(srStudyResults, false)` (~1254); completed sessions are finalized in `finishStudySession`.

## Session end, exit, and the two big pitfalls

`finishStudySession (~1200)`: sets `srFinalized`, calls `finalizeSession(srStudyResults)`, queues the `study` session event, then **awaits `flushAnalyticsWithDeadline(4000)`** before showing the completion screen — the 2026-08-25 "Doris refresh" fix (iOS WebKit can restart the page within ~1s; a fire-and-forget flush lost the session).

### Cooldown floor — a null pool must never dead-end a session (2026-09-08)

Success doubles SR intervals, so a long-term successful student eventually has EVERYTHING on cooldown (proven on live data: 148/148 pairs, E1 returned null → session fell back to menu). The floor, in `sr_engine.js` + `teaching_content.js`:

- `sortPoolBySR` drops group-4 from pick order but keeps it on `sorted._cooldown`.
- `pickWithNewQuota` serves least-overdue cooldown items when pickable runs short.
- The study pair selector reports group 4 (not 6-"empty") for all-cooldown pages and tops up to 3 pairs — a null now means TRULY no pairs exist.
- Rule: practice beats a dead session. Pinned by Rule5 in `test_round_e_dedup.js`.

### Sticky page-advance (2026-09-08)

`checkAndAdvancePageIfAllOnCooldown` (frontend_auth.js ~1722) moves a fully-cooled student up one page — but the decision used to evaporate when `updateStudent` failed, then re-decide "stay" at an incremented sessionCount. The pending page now persists in `csPendingPageAdvance`, re-applies at login BEFORE the normal check (`reapplyPendingPageAdvance`), and clears only on server confirm.

### CHECK comparison: `normMatchText` (2026-09-08)

Tile text is interpolated into HTML with surrounding whitespace, so strict equality could fail a visually-correct placement forever. Both `checkRoundF` (study) and `checkSentenceMatch` (game) compare via `normMatchText()` (`sr_engine.js`: collapse whitespace runs incl. NBSP → trim → lowercase). Display-text only — `itemKey` stays the storage key. Pinned by Rule6.

### Exit path & the `STUDY_STATE.active` trap

`exitStudyMode (~1250)` must do exactly three things, all load-bearing:

1. Finalize any observed-but-unfinalized results (partial credit).
2. **`STUDY_STATE.active = false`** — the game-mode global keydown listener (`game.js ~2253`) early-returns while this flag is true. If it is left `true`, physical-keyboard typing dies in the game-mode spelling minigame after any study session (shipped bug).
3. Hide `#studyModeOverlay` and call **`goBackFromGameSelection()`** (`game.js ~2336`) — the same function the 返回 (Back) button uses — which reveals `#startScreen` (the **main dashboard**) and hides `#gameSelectionOverlay`.

Wrong directions that shipped: routing the X through an undefined `triggerStartGame()` (froze the game on the VS HUD) and returning to `gameSelectionOverlay` (a submenu, not the main menu).

```mermaid
flowchart TD
    SS["startScreen — MAIN DASHBOARD<br/>(hello/avatar, practice + play buttons)"] -->|"initStudyMode"| SMO["studyModeOverlay — Study Mode"]
    SS -->|"'我想边学边玩' → showGameSelection (game.js ~803)"| GSO["gameSelectionOverlay — SUBMENU<br/>(VS / 五子棋 / UNO / Tower Defense)"]
    GSO -->|"返回 → goBackFromGameSelection"| SS
    SMO -->|"✕ → exitStudyMode ~1250"| BACK["goBackFromGameSelection (game.js ~2336)"]
    BACK --> SS
```

`startScreen` is the main dashboard; `gameSelectionOverlay` is a submenu; `studyModeOverlay` is the study surface. The exit X is wired at `index.html ~327`.

## Which tests cover this

- `test_widgets_regression.js` — jsdom harness loading the REAL scripts in index.html order; asserts the depleting bank, delete-preserves-gap, and freeze behaviors across the scramble widgets, plus the handwriting answer row (given/gap/active/revealed slots, invisible separators, ERASE safety).
- `test_handwriting.js` — pure Node tests of the mask maths in `handwriting.js` (rasterise, dilate, bbox, normalise, score, accept, gap picking) with synthetic rings; no canvas, no browser.
- `test_handwriting_browser.js` — Playwright + real Chrome: glyph masks read from actual Fredoka pixels, the pointer-driven trace flow, reject → scaffold → accept → reveal, and the 6-gap cap.
- `test_round_e_dedup.js` — VM test of the UI-Round-E sub-round pair-selection rules (due-first, page preference, no repeats) by loading `sr_engine.js` + `teaching_content.js`.

Both are in the `npm test` chain — see [Testing](12-testing.md). Related live behavior (speech gate) is covered in [Speech Recognition](08-speech.md); historic bug lore in [Gotchas & History](15-gotchas-and-history.md).

## Update discipline

Any agent that changes code covered by this page must update this page in the same commit. The wiki is the single source of truth; skills/memory hold only behavior rules and point here.

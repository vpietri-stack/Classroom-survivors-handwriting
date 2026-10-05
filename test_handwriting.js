// ============================================================
// HANDWRITING ROUND (study Round C) — the pure mask maths.
//
// The round VERIFIES a letter it already knows rather than classifying an
// unknown one, so all of the correctness lives in the geometry:
//   rasterise pen strokes -> normalise against the glyph -> score precision/recall
//
// These tests drive that pipeline with synthetic guide and ink masks, so they
// run in plain Node with no canvas and no browser. The glyph mask itself
// (hwGlyphMask, which reads real Fredoka pixels) and the pointer plumbing are
// browser-only and are covered by manual testing on the preview deploy.
//
// Run: node test_handwriting.js   (part of npm test)
// ============================================================
const path = require('path');
const HW = require(path.join(__dirname, 'handwriting.js'));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('PASS: ' + msg); }
  else { fail++; console.error('FAIL: ' + msg); }
}

const S = HW.HW_SIZE;

// --- synthetic stand-ins for a lowercase 'o': a ring guide and a pen path ---
function ringMask(cx, cy, radius, thickness) {
  const m = new Uint8Array(S * S);
  const half = thickness / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (Math.abs(Math.hypot(x - cx, y - cy) - radius) <= half) m[y * S + x] = 1;
    }
  }
  return m;
}

function ringStroke(cx, cy, radius, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
  }
  return [pts];
}

// A guide ring the size a real glyph would be: font is 0.62 * 128 = 79px, so an
// 'o' is roughly 57px tall with an ~11px stem.
const GUIDE = ringMask(64, 64, 30, 11);

function score(strokes, guide, normalise) {
  if (normalise) return HW.hwScoreStrokes(strokes, guide, S, HW.HW_PEN, HW.HW_TOL);
  const ink = HW.hwRasterise(strokes, S, HW.HW_PEN);
  const s = HW.hwScore(guide, ink, S, HW.HW_TOL);
  const raw = HW.hwBbox(ink, S);
  s.rawInkCount = raw ? raw.count : 0;
  return s;
}

// ---------------------------------------------------------------------------
// mask primitives
// ---------------------------------------------------------------------------
ok(HW.hwBbox(new Uint8Array(S * S), S) === null, 'bbox: an empty mask has no bbox');

const gb = HW.hwBbox(GUIDE, S);
ok(!!gb && gb.x0 < 40 && gb.x1 > 88 && gb.y0 < 40 && gb.y1 > 88,
  'bbox: the guide ring is centred and roughly 70px across (got ' +
  (gb ? [gb.x0, gb.y0, gb.x1, gb.y1].join(',') : 'null') + ')');

ok(HW.hwDilate(GUIDE, S, 0).length === GUIDE.length &&
  HW.hwDilate(GUIDE, S, 0).every((v, i) => v === GUIDE[i]),
  'dilate: radius 0 is a copy, not a mutation');

const d3 = HW.hwDilate(GUIDE, S, 3);
const d6 = HW.hwDilate(GUIDE, S, 6);
ok(d3.reduce((a, b) => a + b, 0) > gb.count, 'dilate: radius 3 grows the mask');
ok(d6.reduce((a, b) => a + b, 0) > d3.reduce((a, b) => a + b, 0), 'dilate: radius 6 grows it further');

const dot = HW.hwRasterise([[{ x: 64, y: 64 }]], S, HW.HW_PEN);
const dotArea = dot.reduce((a, b) => a + b, 0);
const expected = Math.PI * Math.pow(HW.HW_PEN / 2, 2);
ok(dotArea > expected * 0.7 && dotArea < expected * 1.3,
  'rasterise: a single tap stamps roughly one pen disc (' + dotArea + ' px, expected ~' +
  Math.round(expected) + ')');

// ---------------------------------------------------------------------------
// scoring: what must pass and what must not
// ---------------------------------------------------------------------------
const faithful = score(ringStroke(64, 64, 30, 90), GUIDE, true);
ok(HW.hwAccept(faithful, HW.HW_PROFILE.free),
  'score: a faithful trace of the ring passes (p=' + faithful.precision.toFixed(2) +
  ' r=' + faithful.recall.toFixed(2) + ')');
ok(faithful.precision > 0.8 && faithful.recall > 0.85,
  'score: a faithful trace scores well above the bar, leaving headroom for messy writing');

const line = score([[{ x: 8, y: 64 }, { x: 120, y: 64 }]], GUIDE, true);
ok(!HW.hwAccept(line, HW.HW_PROFILE.free), 'score: a straight line through the ring is rejected');
ok(line.recall < 0.5, 'score: a straight line misses most of the ring (r=' + line.recall.toFixed(2) + ')');

const scribble = [];
for (let y = 14; y < S - 14; y += 5) scribble.push([{ x: 14, y }, { x: S - 14, y }]);
const blob = score(scribble, GUIDE, true);
ok(!HW.hwAccept(blob, HW.HW_PROFILE.free), 'score: a filled-in blob is rejected');
ok(blob.precision < 0.5, 'score: a blob fails on precision, not recall (p=' + blob.precision.toFixed(2) + ')');

const tap = score([[{ x: 64, y: 40 }]], GUIDE, true);
ok(!HW.hwAccept(tap, HW.HW_PROFILE.free) && tap.rawInkCount < HW.HW_MIN_INK,
  'score: a single tap is rejected by the minimum-ink guard');
// The guard reads the ink the student actually drew; normalisation is allowed to
// rescale it, so the guarded quantity must be the pre-normalisation count.
ok(tap.rawInkCount < HW.HW_MIN_INK && tap.inkCount > 0,
  'guard: min-ink is judged on raw ink (' + tap.rawInkCount + ' px), not the rescaled copy (' +
  tap.inkCount + ' px)');

// ---------------------------------------------------------------------------
// normalisation: position is forgiven, size only within ~10%
// ---------------------------------------------------------------------------
// Horizontal placement must not matter...
const offCentre = ringStroke(40, 64, 29, 90);
ok(HW.hwAccept(score(offCentre, GUIDE, true), HW.HW_PROFILE.free),
  'normalise: a correctly-sized ring written off to one side still passes');

// ...but size is part of handwriting, and vertical stretching is what used to
// hide missing dots and crossbars, so the scale clamp is deliberately narrow.
const smallStrokes = ringStroke(34, 88, 18, 90);
const smallRaw = score(smallStrokes, GUIDE, false);
const smallNorm = score(smallStrokes, GUIDE, true);
ok(!HW.hwAccept(smallRaw, HW.HW_PROFILE.free),
  'normalise: a small off-centre ring fails when scored as-is (r=' + smallRaw.recall.toFixed(2) + ')');
ok(!HW.hwAccept(smallNorm, HW.HW_PROFILE.free),
  'normalise: a half-size ring is refused rather than stretched onto the guide');

const huge = score(ringStroke(64, 64, 58, 90), GUIDE, true);
ok(!HW.hwAccept(huge, HW.HW_PROFILE.free),
  'normalise: the scale clamp stops a letter drawn right to the box edge from passing');

// ---------------------------------------------------------------------------
// the scaffold must be a safety net, never a harder test
// ---------------------------------------------------------------------------
ok(HW.HW_PROFILE.guided.precision <= HW.HW_PROFILE.free.precision &&
  HW.HW_PROFILE.guided.recall <= HW.HW_PROFILE.free.recall,
  'profile: the guided thresholds are looser than writing from memory');

const borderline = {
  precision: HW.HW_PROFILE.free.precision,
  recall: HW.HW_PROFILE.free.recall,
  rawInkCount: HW.HW_MIN_INK
};
ok(HW.hwAccept(borderline, HW.HW_PROFILE.free) && HW.hwAccept(borderline, HW.HW_PROFILE.guided),
  'profile: a trace that just clears the free bar also clears the guided bar');

// ---------------------------------------------------------------------------
// case folding
// ---------------------------------------------------------------------------
ok(HW.hwOtherCase('a') === 'A' && HW.hwOtherCase('A') === 'a', 'case: a <-> A');
ok(HW.hwOtherCase('1') === null && HW.hwOtherCase(' ') === null, 'case: non-letters have no other case');

// ---------------------------------------------------------------------------
// gap selection: which letters of the word the student actually handwrites
// ---------------------------------------------------------------------------
function lcg(seed) {
  let s = seed;
  return function () { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}
const PUNCT = HW.HW_PUNCT;

function checkGaps(word, maxGaps, seed, label) {
  const gaps = HW.hwPickGaps(word, maxGaps, lcg(seed));
  const letters = [];
  for (let i = 0; i < word.length; i++) if (PUNCT.indexOf(word[i]) === -1) letters.push(i);
  const expectedCount = Math.min(maxGaps, letters.length);
  ok(gaps.length === expectedCount, label + ': picks ' + expectedCount + ' gaps for ' + JSON.stringify(word));
  ok(gaps.every(i => PUNCT.indexOf(word[i]) === -1), label + ': no gap ever lands on punctuation or a space');
  ok(new Set(gaps).size === gaps.length, label + ': gaps are distinct');
  ok(gaps.every((v, i) => i === 0 || v > gaps[i - 1]), label + ': gaps come back left-to-right');
  return gaps;
}

checkGaps('cat', 6, 1, 'gaps');
checkGaps('swimming pool', 6, 2, 'gaps');
checkGaps("you haven't got", 6, 3, 'gaps');
checkGaps('angry - angrier than', 6, 4, 'gaps');

const long = HW.hwPickGaps('internationalisation', 6, lcg(5));
ok(long.length === 6, 'gaps: a 20-letter word is capped at 6 handwritten letters');

const seen = new Set();
for (let seed = 0; seed < 200; seed++) HW.hwPickGaps('dolphin', 3, lcg(seed)).forEach(i => seen.add(i));
ok(seen.size === 7, 'gaps: over 200 shuffles every letter of "dolphin" can be picked (saw ' + seen.size + '/7)');

const a = HW.hwPickGaps('kangaroo', 4, lcg(42));
const b = HW.hwPickGaps('kangaroo', 4, lcg(42));
ok(JSON.stringify(a) === JSON.stringify(b), 'gaps: the same rng seed gives the same gaps');

console.log('\n--- HANDWRITING ---');
console.log(pass + ' passed, ' + fail + ' failed');
console.log('RESULT: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);

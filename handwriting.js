// handwriting.js
// =============================================================================
// Study mode Round C (Handwriting) — "write the missing letters".
//
// This is VERIFICATION, not classification: the round always knows which letter
// it is asking for, so the student's ink is only ever compared against a mask
// rendered from that one glyph. Two numbers decide acceptance:
//
//   precision — how much of their ink lands inside the letter  (stray scribble)
//   recall    — how much of the letter their ink covers        (incomplete)
//
// Ink accumulates across pen lifts, so multi-stroke letters (i, j, t, f, x and
// the capitals) need no "done" button — the letter simply fills in and passes.
//
// All mask maths runs in a fixed 128x128 space, which keeps the thresholds
// independent of canvas size and devicePixelRatio. Everything above the "BROWSER"
// banner is pure (no DOM) and covered by test_handwriting.js.
// =============================================================================

var HW_SIZE = 128;              // normalised mask space
var HW_PEN = 9;                 // pen width in mask units: NARROWER than a glyph
                                // stem (~11). A fat pen blankets neighbouring
                                // letters' ink — an "a" trace covering a "g" —
                                // which is what let confusable letters through.
var HW_TOL = 4;                 // dilation radius = the tolerance band
var HW_MIN_INK = 200;           // a single tap can never pass

// Glyph geometry, expressed as fractions of the box so the visible outline and
// the scoring mask are always the same shape in the same place.
var HW_FONT_STACK = 'Fredoka, Nunito, sans-serif';
var HW_FONT_SCALE = 0.62;       // font size  = scale * box
var HW_BASELINE = 0.80;         // baseline y  = frac  * box

// The guided stage is the safety net that lets a stuck child succeed, so it is
// looser on coverage and does not demand every part of the letter — a trace over
// the outline that stops a little short must still pass. The free stage does
// demand it: maxMissing is the largest connected piece of the letter that may go
// unwritten. That is what stops a "c" passing for a/g/d (missing stem, ascender,
// descender) and an "l" passing for t/i/j (missing crossbar, dot, hook), which
// precision and recall cannot see — those parts are too small a share of the ink
// to move either total much. It must stay above the biggest optional flourish
// (Fredoka's l tail, ~13% of the glyph).
var HW_PROFILE = {
    free: { precision: 0.65, recall: 0.90, maxMissing: 0.08 },
    guided: { precision: 0.70, recall: 0.85, maxMissing: 0.20 }
};

// Must match the round's own punctuation list in study_mode.js.
var HW_PUNCT = [' ', "'", '-', '.', '?', '!', ','];

// A trace is refused when a whole part of the letter was never written: the
// largest connected piece of the guide left uncovered, as a fraction of the
// guide's ink, must stay under this. This is what stops a "c" passing for a/g/d
// (missing stem / ascender / descender) and an "l" passing for t/i/j (missing
// crossbar / dot / hook), which coverage totals alone cannot see — those parts
// are too small a share of the ink to move precision or recall much.
// It must stay above the biggest optional flourish (Fredoka's l tail, ~13%).
var HW_MAX_MISSING = 0.10;

// After normalisation (which fixes height), the ink's width and height must each
// be at least this fraction of the glyph's. Catches stems offered for wide
// letters and x-height blobs offered for tall ones.
var HW_MIN_EXTENT = 0.7;

// Position is forgiven completely (the ink is recentred onto the guide), and
// size is forgiven within this range: a letter written somewhat too big or too
// small still matches on shape. The range stays bounded because beyond it a
// HALF-drawn stem stretches enough to impersonate a complete letter and would be
// accepted mid-stroke; extremes outside it fall through to the outline scaffold,
// which is the right place for a child whose letter is the wrong size.
var HW_SCALE_MIN = 0.75;
var HW_SCALE_MAX = 1.35;

// After a pen lift that does NOT complete the letter, wait this long for the
// next stroke before judging the attempt. Letters like t, i, f, x need the pen
// to leave the paper between strokes; judging on the first lift made them
// impossible to write.
var HW_STROKE_GAP_MS = 1500;


// ---------------------------------------------------------------------------
// PURE MASK MATHS
// ---------------------------------------------------------------------------

/** Bounding box + ink count of a mask, or null when it is blank. */
function hwBbox(mask, size) {
    var x0 = size, y0 = size, x1 = -1, y1 = -1, count = 0;
    for (var y = 0; y < size; y++) {
        var row = y * size;
        for (var x = 0; x < size; x++) {
            if (mask[row + x]) {
                count++;
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
    }
    return count ? { x0: x0, y0: y0, x1: x1, y1: y1, count: count } : null;
}

/** Square (Chebyshev) dilation via the sliding-window trick: O(size^2). */
function hwDilate(mask, size, radius) {
    var r = Math.max(0, Math.round(radius));
    if (!r) return mask.slice();
    var tmp = new Uint8Array(size * size);
    var out = new Uint8Array(size * size);
    var x, y, runEnd;
    for (y = 0; y < size; y++) {
        var row = y * size;
        runEnd = -1;
        for (x = 0; x < size; x++) {
            if (mask[row + x]) runEnd = x + r;
            if (x <= runEnd) tmp[row + x] = 1;
        }
    }
    for (x = 0; x < size; x++) {
        runEnd = -1;
        for (y = 0; y < size; y++) {
            if (tmp[y * size + x]) runEnd = y + r;
            if (y <= runEnd) out[y * size + x] = 1;
        }
    }
    return out;
}

/**
 * Rasterise pen strokes into a mask.
 * @param strokes array of strokes; each stroke is an array of {x,y} in mask units
 */
function hwRasterise(strokes, size, pen) {
    var mask = new Uint8Array(size * size);
    var width = pen === undefined ? HW_PEN : pen;
    var r = Math.max(1, Math.round(width / 2));
    var offs = [];
    for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy <= r * r) offs.push([dx, dy]);
        }
    }
    function stamp(fx, fy) {
        var bx = Math.round(fx), by = Math.round(fy);
        for (var i = 0; i < offs.length; i++) {
            var px = bx + offs[i][0], py = by + offs[i][1];
            if (px >= 0 && px < size && py >= 0 && py < size) mask[py * size + px] = 1;
        }
    }
    for (var s = 0; s < strokes.length; s++) {
        var pts = strokes[s];
        if (!pts || !pts.length) continue;
        for (var i = 0; i < pts.length; i++) {
            var a = pts[i], b = pts[i + 1];
            if (!b) { stamp(a.x, a.y); break; }
            var dist = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
            var steps = Math.max(1, Math.ceil(dist));
            for (var k = 0; k <= steps; k++) {
                stamp(a.x + (b.x - a.x) * k / steps, a.y + (b.y - a.y) * k / steps);
            }
        }
    }
    return mask;
}

/** Centre of mass of a mask. */
function hwCentroid(mask, size) {
    var sx = 0, sy = 0, n = 0;
    for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
            if (mask[y * size + x]) { sx += x; sy += y; n++; }
        }
    }
    return n ? { x: sx / n, y: sy / n, count: n } : null;
}

/**
 * Place the student's ink onto the guide: same baseline (ink bbox bottom onto
 * guide bbox bottom), same horizontal centre of mass, and a scale clamped to
 * +-10%.
 *
 * Baseline anchoring (not centroid or bbox centre) is what keeps a missing dot
 * or ascender VISIBLE to the missing-part check: centroid alignment plus a free
 * scale would stretch a bare stem up over the dot of an i and hide the fact that
 * it was never written. The narrow scale clamp is safe because the coverage
 * bars tolerate size through their tolerance dilation; what they must not
 * tolerate is a missing stroke.
 */
function hwNormalise(ink, guide, size) {
    var ib = hwBbox(ink, size), gb = hwBbox(guide, size);
    if (!ib || !gb) return ink;
    var ic = hwCentroid(ink, size), gc = hwCentroid(guide, size);
    if (!ic || !gc) return ink;
    var ih = Math.max(1, ib.y1 - ib.y0), gh = Math.max(1, gb.y1 - gb.y0);
    var scale = gh / ih;
    scale = Math.max(HW_SCALE_MIN, Math.min(HW_SCALE_MAX, scale));
    var icx = ic.x, icy = ib.y1;
    var gcx = gc.x, gcy = gb.y1;
    var out = new Uint8Array(size * size);
    var m = Math.ceil(size * 0.06);
    var y0 = Math.max(0, gb.y0 - m), y1 = Math.min(size - 1, gb.y1 + m);
    var x0 = Math.max(0, gb.x0 - m), x1 = Math.min(size - 1, gb.x1 + m);
    for (var dy = y0; dy <= y1; dy++) {
        for (var dx = x0; dx <= x1; dx++) {
            var sx = Math.round((dx - gcx) / scale + icx);
            var sy = Math.round((dy - gcy) / scale + icy);
            if (sx >= 0 && sx < size && sy >= 0 && sy < size && ink[sy * size + sx]) {
                out[dy * size + dx] = 1;
            }
        }
    }
    return out;
}

/** precision / recall of the ink against the guide, both within the tolerance band. */
function hwScore(guide, ink, size, tol) {
    var radius = tol === undefined ? HW_TOL : tol;
    var g = hwDilate(guide, size, radius);
    var i = hwDilate(ink, size, radius);
    var inkCount = 0, inside = 0, guideCount = 0, covered = 0;
    for (var p = 0; p < size * size; p++) {
        if (ink[p]) { inkCount++; if (g[p]) inside++; }
        if (guide[p]) { guideCount++; if (i[p]) covered++; }
    }
    return {
        precision: inkCount ? inside / inkCount : 0,
        recall: guideCount ? covered / guideCount : 0,
        inkCount: inkCount,
        guideCount: guideCount
    };
}

/**
 * The whole pipeline the trace box runs on pen-up: raw strokes -> raster ->
 * normalise -> score.
 *
 * rawInkCount is carried through from BEFORE normalisation, because rescaling
 * enlarges a stray dot far enough to clear the minimum-ink guard on its own.
 * "Did they actually draw something" has to be asked of what they really drew.
 */
function hwScoreStrokes(strokes, guide, size, pen, tol) {
    var s = size === undefined ? HW_SIZE : size;
    var ink = hwRasterise(strokes, s, pen === undefined ? HW_PEN : pen);
    var raw = hwBbox(ink, s);
    var scores = hwScore(guide, hwNormalise(ink, guide, s), s, tol === undefined ? HW_TOL : tol);
    scores.rawInkCount = raw ? raw.count : 0;
    return scores;
}

function hwAccept(scores, profile) {
    var p = profile || HW_PROFILE.free;
    var drawn = scores.rawInkCount === undefined ? scores.inkCount : scores.rawInkCount;
    var maxMissing = p.maxMissing === undefined ? HW_MAX_MISSING : p.maxMissing;
    return !scores.overfilled &&
        (scores.missingPart === undefined || scores.missingPart <= maxMissing) &&
        (scores.strokeCount === undefined || scores.minStrokes === undefined ||
            scores.strokeCount >= scores.minStrokes) &&
        (scores.widthRatio === undefined || scores.widthRatio >= HW_MIN_EXTENT) &&
        (scores.heightRatio === undefined || scores.heightRatio >= HW_MIN_EXTENT) &&
        drawn >= HW_MIN_INK &&
        scores.precision >= p.precision &&
        scores.recall >= p.recall;
}

var _hwGuideDilCache = {};

function hwGuideDilated(letter, tol) {
    var key = letter + '@' + tol;
    if (!_hwGuideDilCache[key]) {
        _hwGuideDilCache[key] = hwDilate(hwGlyphMask(letter), HW_SIZE, tol);
    }
    return _hwGuideDilCache[key];
}

/** Square erosion (sliding-window min). Removes structures thinner than 2r+1. */
function hwErode(mask, size, radius) {
    var r = Math.max(0, Math.round(radius));
    if (!r) return mask.slice();
    var tmp = new Uint8Array(size * size);
    var out = new Uint8Array(size * size);
    var x, y;
    for (y = 0; y < size; y++) {
        var row = y * size;
        var zeros = 0;
        for (x = -r; x <= r; x++) if (x >= 0 && x < size && !mask[row + x]) zeros++;
        for (x = 0; x < size; x++) {
            tmp[row + x] = zeros === 0 ? 1 : 0;
            if (x - r >= 0 && !mask[row + x - r]) zeros--;
            if (x + r + 1 < size && !mask[row + x + r + 1]) zeros++;
        }
    }
    for (x = 0; x < size; x++) {
        var zeros2 = 0;
        for (y = -r; y <= r; y++) if (y >= 0 && y < size && !tmp[y * size + x]) zeros2++;
        for (y = 0; y < size; y++) {
            out[y * size + x] = zeros2 === 0 ? 1 : 0;
            if (y - r >= 0 && !tmp[(y - r) * size + x]) zeros2--;
            if (y + r + 1 < size && !tmp[(y + r + 1) * size + x]) zeros2++;
        }
    }
    return out;
}

var _hwGuideCompCache = {};

/** How many separate pieces the glyph is written from (i and j are 2: dot + stem). */
function hwGuideComponents(letter) {
    if (_hwGuideCompCache[letter] !== undefined) return _hwGuideCompCache[letter];
    var mask = hwGlyphMask(letter);
    var seen = new Uint8Array(HW_SIZE * HW_SIZE);
    var stack = [];
    var comps = 0;
    for (var s = 0; s < HW_SIZE * HW_SIZE; s++) {
        if (!mask[s] || seen[s]) continue;
        comps++;
        stack.length = 0;
        stack.push(s);
        seen[s] = 1;
        while (stack.length) {
            var q = stack.pop();
            var x = q % HW_SIZE, y = (q - x) / HW_SIZE;
            for (var dy = -1; dy <= 1; dy++) {
                var ny = y + dy;
                if (ny < 0 || ny >= HW_SIZE) continue;
                for (var dx = -1; dx <= 1; dx++) {
                    var nx = x + dx;
                    if (nx < 0 || nx >= HW_SIZE) continue;
                    var nq = ny * HW_SIZE + nx;
                    if (mask[nq] && !seen[nq]) { seen[nq] = 1; stack.push(nq); }
                }
            }
        }
    }
    _hwGuideCompCache[letter] = comps;
    return comps;
}

/**
 * Largest connected piece of the guide that the ink never reached, as a fraction
 * of the guide's ink, after eroding away anything thinner than a stroke.
 *
 * The erosion is the point: ordinary wobble leaves thin slivers of the guide
 * uncovered, while a stroke that was never written (crossbar, dot, stem,
 * descender) leaves a stroke-thick piece. Counting slivers would reject good
 * letters; not counting thickness would let a missing dot slide.
 */
function hwMissingPart(guide, inkDil, size, erode) {
    var r = erode === undefined ? 1 : erode;
    var remain = new Uint8Array(size * size);
    var guideCount = 0;
    for (var p = 0; p < size * size; p++) {
        if (guide[p]) {
            guideCount++;
            if (!inkDil[p]) remain[p] = 1;
        }
    }
    if (!guideCount) return 0;
    remain = hwErode(remain, size, r);
    var seen = new Uint8Array(size * size);
    var stack = [];
    var largest = 0;
    for (var s = 0; s < size * size; s++) {
        if (!remain[s] || seen[s]) continue;
        var count = 0;
        stack.length = 0;
        stack.push(s);
        seen[s] = 1;
        while (stack.length) {
            var q = stack.pop();
            count++;
            var x = q % size, y = (q - x) / size;
            for (var dy = -1; dy <= 1; dy++) {
                var ny = y + dy;
                if (ny < 0 || ny >= size) continue;
                for (var dx = -1; dx <= 1; dx++) {
                    var nx = x + dx;
                    if (nx < 0 || nx >= size) continue;
                    var nq = ny * size + nx;
                    if (remain[nq] && !seen[nq]) { seen[nq] = 1; stack.push(nq); }
                }
            }
        }
        if (count > largest) largest = count;
    }
    return largest / guideCount;
}

/** Score raw ink against one letter, normalised to that letter's own shape. */
function hwScoreLetter(letter, ink, tol, pen) {
    var width = pen === undefined ? HW_PEN : pen;
    var guide = hwGlyphMask(letter);
    var norm = hwNormalise(ink, guide, HW_SIZE);
    // Rescaling changes the pen's effective thickness: shrinking a big letter
    // thins its ink, which would look like "failed to cover the letter", and
    // enlarging a small one fattens it, which would look like stray ink. Give
    // back exactly the thickness the scaling took away (or gave).
    var ib = hwBbox(ink, HW_SIZE), gb = hwBbox(guide, HW_SIZE);
    var sc = 1;
    if (ib && gb) {
        sc = (gb.y1 - gb.y0 + 1) / (ib.y1 - ib.y0 + 1);
        sc = Math.max(HW_SCALE_MIN, Math.min(HW_SCALE_MAX, sc));
    }
    var inkDil = hwDilate(norm, HW_SIZE, tol + Math.max(0, (1 - sc) * width / 2));
    var guideDil = hwGuideDilated(letter, tol + Math.max(0, (sc - 1) * width / 2));
    var inkCount = 0, inside = 0, guideCount = 0, covered = 0;
    for (var p = 0; p < HW_SIZE * HW_SIZE; p++) {
        if (norm[p]) { inkCount++; if (guideDil[p]) inside++; }
        if (guide[p]) { guideCount++; if (inkDil[p]) covered++; }
    }
    return {
        letter: letter,
        precision: inkCount ? inside / inkCount : 0,
        recall: guideCount ? covered / guideCount : 0,
        inkCount: inkCount,
        nb: hwBbox(norm, HW_SIZE),
        missingPart: hwMissingPart(guide, inkDil, HW_SIZE)
    };
}

function hwBetterOf(a, b) {
    return (a.precision + a.recall) >= (b.precision + b.recall) ? a : b;
}

/**
 * Verify a finished trace against its target letter.
 * Returns { scores }, where scores carries precision, recall, missingPart (the
 * largest part of the letter left unwritten), rawInkCount and overfilled.
 * hwAccept applies the profile's bars to them.
 */
function hwVerify(strokes, target, pen, tol) {
    var t = tol === undefined ? HW_TOL : tol;
    var ink = hwRasterise(strokes, HW_SIZE, pen === undefined ? HW_PEN : pen);
    var raw = hwBbox(ink, HW_SIZE);
    var targetLetter = target.toLowerCase();
    var scores = hwBetterOf(
        hwScoreLetter(targetLetter, ink, t, pen === undefined ? HW_PEN : pen),
        hwScoreLetter(targetLetter.toUpperCase(), ink, t, pen === undefined ? HW_PEN : pen)
    );
    scores.rawInkCount = raw ? raw.count : 0;
    // A letter built from separate pieces (i, j: dot + stem) cannot be written
    // without lifting the pen, so a single unbroken stroke cannot be one. This
    // is a property of the glyph, not of the trace, which keeps it honest where
    // coverage totals are not: an ascender-height stem covers an i's dot region
    // however the ink is aligned.
    var strokeCount = 0;
    for (var sc = 0; sc < strokes.length; sc++) if (strokes[sc] && strokes[sc].length) strokeCount++;
    scores.strokeCount = strokeCount;
    // The piece count of the letter the WORD actually uses, not of whichever case
    // scored better: a bare stem matches capital I perfectly, which would otherwise
    // let a one-stroke scribble pass for a lowercase i and its separate dot.
    scores.minStrokes = hwGuideComponents(target);
    // A letter's proportions are part of the letter: a bare vertical stem is a
    // third as wide as a t, and an x-height blob is two thirds as tall as a d.
    // Coverage cannot see this (the missing crossbar is ~2% of a t's ink).
    var gb2 = hwBbox(hwGlyphMask(scores.letter), HW_SIZE);
    if (scores.nb && gb2) {
        scores.widthRatio = (scores.nb.x1 - scores.nb.x0 + 1) / (gb2.x1 - gb2.x0 + 1);
        scores.heightRatio = (scores.nb.y1 - scores.nb.y0 + 1) / (gb2.y1 - gb2.y0 + 1);
    }
    // Anti-blob: a letter is an outline, so its ink leaves most of its own
    // bounding box empty. A solid fill of a much-larger box is not a letter, and
    // shrinking (which normalise allows) would otherwise make it cover the guide
    // convincingly.
    var rawArea = raw ? (raw.x1 - raw.x0 + 1) * (raw.y1 - raw.y0 + 1) : 0;
    var gb = hwBbox(hwGlyphMask(targetLetter), HW_SIZE);
    var guideArea = gb ? (gb.x1 - gb.x0 + 1) * (gb.y1 - gb.y0 + 1) : 1;
    scores.overfilled = rawArea > 2 * guideArea && (raw.count / rawArea) > 0.85;
    return { scores: scores };
}

/**
 * Which letter positions the student must handwrite.
 * Returns up to maxGaps distinct letter indices (never punctuation/space),
 * left-to-right. rng is injectable so tests are deterministic.
 */
function hwPickGaps(word, maxGaps, rng, punct) {
    var r = rng || Math.random;
    var P = punct || HW_PUNCT;
    var letters = [];
    for (var i = 0; i < word.length; i++) {
        if (P.indexOf(word[i]) === -1) letters.push(i);
    }
    var k = Math.min(maxGaps, letters.length);
    for (var j = 0; j < k; j++) {
        var swap = j + Math.floor(r() * (letters.length - j));
        var t = letters[j]; letters[j] = letters[swap]; letters[swap] = t;
    }
    return letters.slice(0, k).sort(function (a, b) { return a - b; });
}


// ---------------------------------------------------------------------------
// BROWSER: glyph masks + the trace box widget
// ---------------------------------------------------------------------------

var _hwFontPromise = null;
var _hwGlyphCache = {};

/** Fredoka is self-hosted; make sure it is ready before the first glyph mask. */
function hwEnsureFont() {
    if (_hwFontPromise) return _hwFontPromise;
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) {
        _hwFontPromise = Promise.resolve(false);
        return _hwFontPromise;
    }
    var px = Math.round(HW_SIZE * HW_FONT_SCALE) + 'px Fredoka';
    _hwFontPromise = Promise.all([
        document.fonts.load(px, 'a'),
        document.fonts.load(px, 'A')
    ]).then(function () { return true; }).catch(function () { return false; });
    return _hwFontPromise;
}

/** Alpha-threshold a rendered glyph into a mask. canvasFactory is injectable. */
function hwGlyphMask(ch, canvasFactory) {
    if (_hwGlyphCache[ch]) return _hwGlyphCache[ch];
    var cv = canvasFactory ? canvasFactory(HW_SIZE) : (function () {
        var c = document.createElement('canvas');
        c.width = HW_SIZE; c.height = HW_SIZE;
        return c;
    })();
    var ctx = cv.getContext('2d');
    hwPaintGlyph(ctx, ch, HW_SIZE);
    var data = ctx.getImageData(0, 0, HW_SIZE, HW_SIZE).data;
    var mask = new Uint8Array(HW_SIZE * HW_SIZE);
    for (var p = 0; p < mask.length; p++) mask[p] = data[p * 4 + 3] > 90 ? 1 : 0;
    _hwGlyphCache[ch] = mask;
    return mask;
}

/** Draw a glyph so it exactly fills a box of `size` — used for mask AND outline. */
function hwPaintGlyph(ctx, ch, size) {
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    ctx.font = Math.round(size * HW_FONT_SCALE) + 'px ' + HW_FONT_STACK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(ch, size / 2, size * HW_BASELINE);
    ctx.restore();
}

function hwOtherCase(ch) {
    if (!ch || ch.length !== 1) return null;
    var lower = ch.toLowerCase(), upper = ch.toUpperCase();
    return (lower !== upper) ? (ch === lower ? upper : lower) : null;
}

/**
 * The square writing box. Owns the canvas, the pointer plumbing and the ink;
 * the round owns the scaffold ladder and calls onAccept / onReject.
 *
 * opts: { onAccept(char, scores), onReject(char, scores) }
 * returns { el, measure, setTarget, setGuided, clearInk, freeze, unfreeze, destroy }
 */
function hwCreateTraceBox(opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'hw-trace-wrap';
    var cv = document.createElement('canvas');
    cv.className = 'hw-trace-canvas';
    cv.style.touchAction = 'none';
    wrap.appendChild(cv);
    var ctx = cv.getContext('2d');

    var cssSize = 0, dpr = 1;
    var target = null, guided = false, frozen = false;
    var strokes = [], drawing = null;
    var pendingReject = null;   // timer judging a lifted-pen trace as finished

    function cancelPending() {
        if (pendingReject) { clearTimeout(pendingReject); pendingReject = null; }
    }

    function measure() {
        var rect = cv.getBoundingClientRect();
        cssSize = Math.max(64, Math.round(rect.width));
        dpr = window.devicePixelRatio || 1;
        cv.width = Math.round(cssSize * dpr);
        cv.height = Math.round(cssSize * dpr);
        redraw();
    }

    function redraw() {
        if (!cssSize) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssSize, cssSize);
        drawRuling();
        if (guided && target) drawOutline();
        drawInk();
    }

    // Faint ruled lines, on the same baseline the glyph is drawn to.
    function drawRuling() {
        ctx.save();
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.30)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cssSize * 0.08, cssSize * HW_BASELINE);
        ctx.lineTo(cssSize * 0.92, cssSize * HW_BASELINE);
        ctx.stroke();
        ctx.setLineDash([4, 5]);
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.22)';
        ctx.beginPath();
        ctx.moveTo(cssSize * 0.08, cssSize * 0.47);
        ctx.lineTo(cssSize * 0.92, cssSize * 0.47);
        ctx.stroke();
        ctx.restore();
    }

    function drawOutline() {
        ctx.save();
        // 0.5 alpha composites #64748b down to roughly rgb(178,186,197) on the
        // paper background: clearly visible to trace over, still unmistakably
        // lighter than the student's own ink. At 0.3 it measured ~208/255, which
        // is invisible on a tablet in a bright room.
        ctx.globalAlpha = 0.5;
        ctx.font = Math.round(cssSize * HW_FONT_SCALE) + 'px ' + HW_FONT_STACK;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#64748b';
        ctx.fillText(target, cssSize / 2, cssSize * HW_BASELINE);
        ctx.restore();
    }

    function drawInk() {
        if (!strokes.length) return;
        ctx.save();
        var unit = cssSize / HW_SIZE;
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = HW_PEN * unit;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (var s = 0; s < strokes.length; s++) {
            var pts = strokes[s];
            if (!pts.length) continue;
            ctx.beginPath();
            ctx.moveTo(pts[0].x * unit, pts[0].y * unit);
            for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * unit, pts[i].y * unit);
            if (pts.length === 1) ctx.lineTo(pts[0].x * unit + 0.1, pts[0].y * unit);
            ctx.stroke();
        }
        ctx.restore();
    }

    function toMask(e) {
        var rect = cv.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / rect.width * HW_SIZE,
            y: (e.clientY - rect.top) / rect.height * HW_SIZE
        };
    }

    function onDown(e) {
        if (frozen || !target) return;
        e.preventDefault();
        cancelPending();   // a new stroke means the previous lift was mid-letter
        if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (err) { } }
        drawing = [toMask(e)];
        strokes.push(drawing);
        redraw();
    }

    function onMove(e) {
        if (!drawing) return;
        e.preventDefault();
        var p = toMask(e);
        var last = drawing[drawing.length - 1];
        if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 0.8) return;
        drawing.push(p);
        redraw();
    }

    function onUp() {
        if (!drawing) return;
        drawing = null;
        if (evaluate(false)) return;
        // Not a letter yet. The pen may simply be between strokes (t, i, f, x),
        // so wait for the next one before this counts as a failed attempt.
        cancelPending();
        pendingReject = setTimeout(function () {
            pendingReject = null;
            evaluate(true);
        }, HW_STROKE_GAP_MS);
    }

    // final=false only ever accepts; final=true judges the attempt (accept or
    // reject). Returns true when the letter was accepted.
    function evaluate(final) {
        if (!target || frozen) return false;
        var profile = guided ? HW_PROFILE.guided : HW_PROFILE.free;
        var scores = hwVerify(strokes, target, HW_PEN, HW_TOL).scores;
        var accepted = hwAccept(scores, profile);
        // Readout for tuning against real handwriting (the dev harness shows it;
        // production ignores it).
        if (typeof window !== 'undefined') {
            window.__hwLast = {
                target: target, guided: guided, accepted: accepted, judged: !!final,
                precision: +scores.precision.toFixed(2), recall: +scores.recall.toFixed(2),
                missing: +scores.missingPart.toFixed(2), overfilled: !!scores.overfilled,
                strokes: scores.strokeCount, minStrokes: scores.minStrokes,
                width: scores.widthRatio === undefined ? null : +scores.widthRatio.toFixed(2),
                height: scores.heightRatio === undefined ? null : +scores.heightRatio.toFixed(2),
                bars: profile
            };
        }
        if (accepted) {
            cancelPending();
            frozen = true;
            if (opts.onAccept) opts.onAccept(target, scores);
            return true;
        }
        if (final && opts.onReject) opts.onReject(target, scores);
        return false;
    }

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);

    return {
        el: wrap,
        measure: measure,
        setTarget: function (ch) {
            target = ch;
            strokes = [];
            drawing = null;
            frozen = false;
            cancelPending();
            redraw();
        },
        setGuided: function (on) { guided = !!on; redraw(); },
        clearInk: function () { strokes = []; drawing = null; cancelPending(); redraw(); },
        freeze: function () { frozen = true; cancelPending(); },
        unfreeze: function () { frozen = false; },
        destroy: function () {
            cancelPending();
            cv.removeEventListener('pointerdown', onDown);
            cv.removeEventListener('pointermove', onMove);
            cv.removeEventListener('pointerup', onUp);
            cv.removeEventListener('pointercancel', onUp);
            window.removeEventListener('resize', measure);
            window.removeEventListener('orientationchange', measure);
            if (wrap.parentElement) wrap.parentElement.removeChild(wrap);
        }
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        HW_SIZE: HW_SIZE, HW_PEN: HW_PEN, HW_TOL: HW_TOL, HW_MIN_INK: HW_MIN_INK,
        HW_PROFILE: HW_PROFILE, HW_PUNCT: HW_PUNCT,
        HW_MAX_MISSING: HW_MAX_MISSING, HW_MIN_EXTENT: HW_MIN_EXTENT,
        HW_STROKE_GAP_MS: HW_STROKE_GAP_MS,
        hwBbox: hwBbox, hwCentroid: hwCentroid, hwDilate: hwDilate, hwErode: hwErode,
        hwRasterise: hwRasterise,
        hwNormalise: hwNormalise, hwScore: hwScore, hwScoreStrokes: hwScoreStrokes,
        hwScoreLetter: hwScoreLetter, hwMissingPart: hwMissingPart, hwVerify: hwVerify,
        hwAccept: hwAccept,
        hwPickGaps: hwPickGaps, hwOtherCase: hwOtherCase
    };
}

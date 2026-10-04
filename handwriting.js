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
var HW_PEN = 14;                // pen width in mask units (~11% of the box)
var HW_TOL = 5;                 // dilation radius = the tolerance band
var HW_MIN_INK = 200;           // a single tap can never pass

// Glyph geometry, expressed as fractions of the box so the visible outline and
// the scoring mask are always the same shape in the same place.
var HW_FONT_STACK = 'Fredoka, Nunito, sans-serif';
var HW_FONT_SCALE = 0.62;       // font size  = scale * box
var HW_BASELINE = 0.80;         // baseline y  = frac  * box

// The guided stage is the fallback that lets a stuck child succeed, so it must
// be LOOSER than writing from memory, never stricter. Both profiles were picked
// as sane starting points and are expected to need classroom tuning.
var HW_PROFILE = {
    free: { precision: 0.55, recall: 0.68 },
    guided: { precision: 0.45, recall: 0.58 }
};

// Must match the round's own punctuation list in study_mode.js.
var HW_PUNCT = [' ', "'", '-', '.', '?', '!', ','];


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

/**
 * Centre the student's ink on the guide's ink and rescale it to the guide's
 * height, so a child who writes small or off to one side is not penalised for
 * placement.
 *
 * The scale clamp is deliberately ASYMMETRIC — it enlarges freely (1.8x) but
 * barely shrinks (0.9x). Shrinking is what would let a big filled-in blob pass:
 * resized down to letter proportions, a blob covers the glyph and scores well on
 * precision. Ink that overflows the guide stays oversized and is rejected, which
 * is the right verdict for a letter drawn far outside the box.
 */
function hwNormalise(ink, guide, size) {
    var ib = hwBbox(ink, size), gb = hwBbox(guide, size);
    if (!ib || !gb) return ink;
    var ih = Math.max(1, ib.y1 - ib.y0), gh = Math.max(1, gb.y1 - gb.y0);
    var scale = gh / ih;
    scale = Math.max(0.9, Math.min(1.8, scale));
    var icx = (ib.x0 + ib.x1) / 2, icy = (ib.y0 + ib.y1) / 2;
    var gcx = (gb.x0 + gb.x1) / 2, gcy = (gb.y0 + gb.y1) / 2;
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
    return drawn >= HW_MIN_INK &&
        scores.precision >= p.precision &&
        scores.recall >= p.recall;
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
    var target = null, altCase = null, guided = false, frozen = false;
    var strokes = [], drawing = null;

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
        evaluate();
    }

    function evaluate() {
        if (!target || frozen) return;
        var profile = guided ? HW_PROFILE.guided : HW_PROFILE.free;
        var best = hwScoreStrokes(strokes, hwGlyphMask(target), HW_SIZE, HW_PEN, HW_TOL);
        // Either case is accepted: capitalisation is not this round's battle.
        if (altCase && !hwAccept(best, profile)) {
            var alt = hwScoreStrokes(strokes, hwGlyphMask(altCase), HW_SIZE, HW_PEN, HW_TOL);
            if (alt.precision + alt.recall > best.precision + best.recall) best = alt;
        }
        if (hwAccept(best, profile)) {
            frozen = true;
            if (opts.onAccept) opts.onAccept(target, best);
        } else if (opts.onReject) {
            opts.onReject(target, best);
        }
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
            altCase = hwOtherCase(ch);
            strokes = [];
            drawing = null;
            frozen = false;
            redraw();
        },
        setGuided: function (on) { guided = !!on; redraw(); },
        clearInk: function () { strokes = []; drawing = null; redraw(); },
        freeze: function () { frozen = true; },
        unfreeze: function () { frozen = false; },
        destroy: function () {
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
        hwBbox: hwBbox, hwDilate: hwDilate, hwRasterise: hwRasterise,
        hwNormalise: hwNormalise, hwScore: hwScore, hwScoreStrokes: hwScoreStrokes,
        hwAccept: hwAccept,
        hwPickGaps: hwPickGaps, hwOtherCase: hwOtherCase
    };
}

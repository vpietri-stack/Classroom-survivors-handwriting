// ============================================================
// HANDWRITING ROUND — browser verification.
//
// test_handwriting.js covers the pure mask maths with synthetic rings. This
// covers the half that only a real browser can: glyph masks read from actual
// Fredoka pixels, the pointer plumbing, and the round flow (accept -> slot fills
// -> next gap, and the blank -> outline scaffold).
//
// It also guards the thresholds against a real letterform, which is the part
// most likely to be wrong: a synthetic ring is not a lowercase 'o'.
//
// Run:  node test_handwriting_browser.js   (part of npm test)
// ============================================================
const { chromium } = require('playwright-core');
const path = require('path');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fileUrl = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS: ' + m); } else { fail++; console.error('FAIL: ' + m); } }

// Pen paths in fractions of the trace box, so they scale with the canvas.
// Metrics follow handwriting.js: font = 0.62 * box, baseline at 0.80 * box.
const BASE = 0.80, XTOP = 0.47, TOP = 0.35;

function vLine(x, y0, y1, n) {
  const pts = []; const steps = n || 24;
  for (let i = 0; i <= steps; i++) pts.push([x, y0 + (y1 - y0) * i / steps]);
  return pts;
}
function hLine(y, x0, x1, n) {
  const pts = []; const steps = n || 16;
  for (let i = 0; i <= steps; i++) pts.push([x0 + (x1 - x0) * i / steps, y]);
  return pts;
}
function arc(cx, cy, rx, ry, a0, a1, n) {
  const pts = []; const steps = n || 40;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * i / steps;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

// Hand-written approximations of what a child's pen would do.
const PATHS = {
  o: () => [arc(0.50, 0.635, 0.155, 0.165, -Math.PI / 2, Math.PI * 1.5)],
  l: () => [vLine(0.50, TOP, BASE)],
  c: () => [arc(0.53, 0.635, 0.150, 0.165, -Math.PI * 0.25, -Math.PI * 1.75)],
  t: () => [vLine(0.50, TOP, BASE), hLine(XTOP, 0.38, 0.63)],
  i: () => [vLine(0.50, XTOP, BASE), [[0.50, 0.40]]]
};

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--font-render-hinting=none']
  });
  const page = await browser.newPage({ viewport: { width: 480, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(fileUrl, { waitUntil: 'load' });
  await page.waitForTimeout(600);

  // --- glyph masks come from real Fredoka pixels -----------------------------
  const glyph = await page.evaluate(async () => {
    await hwEnsureFont();
    const out = {};
    for (const ch of ['a', 'o', 'l', 'i', 't', 'z', 'A', 'Q']) {
      const m = hwGlyphMask(ch);
      const b = hwBbox(m, HW_SIZE);
      out[ch] = b ? { count: b.count, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } : null;
    }
    out._sameOZ = (() => {
      const O = hwGlyphMask('o'), Z = hwGlyphMask('z');
      let diff = 0;
      for (let p = 0; p < O.length; p++) if (O[p] !== Z[p]) diff++;
      return diff;
    })();
    out._fontLoaded = !!(document.fonts && document.fonts.check('10px Fredoka'));
    return out;
  });

  ok(glyph._fontLoaded, 'font: Fredoka is actually loaded before the masks are built');
  for (const ch of ['a', 'o', 'l', 'i', 't', 'z', 'A', 'Q']) {
    const b = glyph[ch];
    ok(!!b && b.count > 100, 'glyph: ' + ch + ' renders ink (' + (b ? b.count : 0) + ' px)');
  }
  const lowerOk = ['a', 'o', 'l', 'i', 't', 'z'].every(ch => glyph[ch] && glyph[ch].y1 <= 127 && glyph[ch].y0 >= 0);
  ok(lowerOk, 'glyph: lowercase masks fit inside the box (nothing clipped)');
  ok(glyph['A'] && glyph['A'].count > glyph['a'].count * 0.5, 'glyph: a capital renders too');
  ok(glyph._sameOZ > 500, 'glyph: different letters produce different masks (' + glyph._sameOZ + ' px differ)');

  // --- drive the real round --------------------------------------------------
  // "ox" gives two gaps, so the accept -> advance flow is exercised.
  const setup = await page.evaluate(() => {
    window.playTTS = function () { };
    window.synthGem = function () { };
    window.synthError = function () { };
    window.queueExerciseEvent = function () { window.__events = (window.__events || []); window.__events.push([].slice.call(arguments)); };
    window.showTranslation = function () { };
    window.showVocabImage = function () { };
    STUDY_STATE.active = true;
    STUDY_STATE.words = ['ox'];
    STUDY_STATE.currentWordIndex = 0;
    STUDY_STATE.isTransitioning = false;
    document.getElementById('studyModeOverlay').classList.remove('hidden');
    startRoundD();
    return new Promise(res => setTimeout(() => {
      const cv = document.querySelector('.hw-trace-canvas');
      res({
        mounted: !!cv,
        gaps: roundDGapOrder.slice(),
        word: roundDWord,
        slots: roundDSlots.map(s => s.type === 'fixed' ? '#' : (s.gap ? '_' : s.char)),
        box: cv ? (() => { const r = cv.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() : null
      });
    }, 300));
  });

  ok(setup.mounted, 'round: the trace canvas mounts');
  ok(setup.word === 'ox' && setup.gaps.length === 2, 'round: a 2-letter word gets 2 gaps (got ' + setup.gaps.length + ')');
  ok(setup.slots.join('') === '__', 'round: both letters are gaps, nothing is given (got "' + setup.slots.join('') + '")');
  ok(setup.box && setup.box.w > 60, 'round: the canvas is laid out with a real size (' + (setup.box ? Math.round(setup.box.w) : 0) + 'px)');

  // Draw a pen path with real pointer events.
  async function draw(strokes) {
    const box = setup.box;
    for (const stroke of strokes) {
      for (let i = 0; i < stroke.length; i++) {
        const cx = box.x + stroke[i][0] * box.w;
        const cy = box.y + stroke[i][1] * box.h;
        const type = i === 0 ? 'pointerdown' : 'pointermove';
        await page.evaluate(([t, x, y]) => {
          document.querySelector('.hw-trace-canvas').dispatchEvent(new PointerEvent(t, {
            clientX: x, clientY: y, pointerId: 7, bubbles: true, cancelable: true,
            isPrimary: true, button: 0, buttons: t === 'pointerdown' ? 1 : 1, pointerType: 'touch'
          }));
        }, [type, cx, cy]);
      }
      const last = stroke[stroke.length - 1];
      await page.evaluate(([x, y]) => {
        document.querySelector('.hw-trace-canvas').dispatchEvent(new PointerEvent('pointerup', {
          clientX: x, clientY: y, pointerId: 7, bubbles: true, cancelable: true,
          isPrimary: true, button: 0, buttons: 0, pointerType: 'touch'
        }));
      }, [box.x + last[0] * box.w, box.y + last[1] * box.h]);
    }
    await page.waitForTimeout(120);
  }

  const state = () => page.evaluate(() => ({
    slots: roundDSlots.map(s => s.type === 'fixed' ? '#' : (s.filled ? (s.given ? '?' : s.char.toUpperCase()) : '_')).join(''),
    cursor: roundDCursor,
    attempts: roundDAttempts,
    guided: roundDGuided,
    target: roundDCursor < roundDGapOrder.length ? roundDSlots[roundDGapOrder[roundDCursor]].char : null,
    events: window.__events || []
  }));

  // --- the wrong letter must be rejected ------------------------------------
  let s = await state();
  ok(s.target === 'o' && s.cursor === 0 && s.slots === '__',
    'round: the leftmost gap is the first target ("o")');

  await draw(PATHS.l());
  s = await state();
  ok(s.cursor === 0 && s.attempts === 1 && s.slots === '__',
    'reject: an "l" drawn for the target "o" does not fill the slot (attempts=' + s.attempts + ')');
  ok(!s.guided, 'scaffold: still no outline after one rejection');

  // --- second rejection fades the outline in --------------------------------
  await draw(PATHS.l());
  s = await state();
  ok(s.guided === true && s.attempts === 2, 'scaffold: the outline fades in after 2 rejections');

  // Measured as a delta so the ruled baseline/midline (present either way) cannot
  // flatter it. "Marked" = anything that departs from the paper colour, which is
  // how a child would see it — a faint-but-real outline still counts.
  const painted = await page.evaluate(() => {
    const cv = document.querySelector('.hw-trace-canvas');
    const marked = () => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let p = 0; p < d.length; p += 4) {
        if (d[p + 3] > 10 && (Math.abs(d[p] - 255) > 20 || Math.abs(d[p + 1] - 253) > 20 || Math.abs(d[p + 2] - 247) > 20)) n++;
      }
      return n;
    };
    const withGuide = marked();
    roundDTrace.setGuided(false);
    const without = marked();
    roundDTrace.setGuided(true);
    return { withGuide, without };
  });
  ok(painted.withGuide - painted.without > 500,
    'scaffold: the outline is actually painted, and visible against the paper (+' +
    (painted.withGuide - painted.without) + ' px)');

  // --- the right letter is accepted and the round advances -------------------
  await page.evaluate(() => clearRoundD());
  await draw(PATHS.o());
  s = await state();
  ok(s.cursor === 1 && s.slots === 'O_', 'accept: a hand-drawn "o" fills the first gap (slots="' + s.slots + '")');
  await page.waitForTimeout(500);   // the round waits ~420ms before showing the next gap
  s = await state();
  ok(s.target === 'x' && s.attempts === 0 && !s.guided,
    'accept: the round advances to "x" with the attempts and the outline reset');

  // --- running out of attempts reveals the letter and never dead-ends --------
  const giveUp = await page.evaluate(async () => {
    roundDAttempts = ROUND_D_GIVE_UP_AFTER - 1;   // one more rejection triggers the reveal
    roundDRejectLetter();
    return new Promise(res => setTimeout(() => res({
      slots: roundDSlots.map(x => x.type === 'fixed' ? '#' : (x.filled ? (x.given ? '?' : x.char.toUpperCase()) : '_')).join(''),
      given: roundDSlots[roundDGapOrder[1]].given === true,
      cursor: roundDCursor,
      events: window.__events || []
    }), 1200));
  });
  ok(giveUp.given && giveUp.slots === 'O?', 'dead end: the last letter is revealed rather than blocking the child');
  ok(giveUp.events.length === 1 && giveUp.events[0][0] === 'handwriting' && giveUp.events[0][2] === 'ox',
    'telemetry: one "handwriting" exercise event for the word (got ' + JSON.stringify(giveUp.events[0] || null) + ')');

  // --- a long word is capped, and ERASE is free ------------------------------
  const cap = await page.evaluate(() => new Promise(res => {
    STUDY_STATE.words = ['angry - angrier than'];
    STUDY_STATE.currentWordIndex = 0;
    STUDY_STATE.isTransitioning = false;
    nextRoundDWord();
    setTimeout(() => {
      const before = roundDAttempts;
      clearRoundD();
      res({
        letters: roundDSlots.filter(x => x.type === 'letter').length,
        gaps: roundDGapOrder.length,
        given: roundDSlots.filter(x => x.type === 'letter' && !x.gap).length,
        fixed: roundDSlots.filter(x => x.type === 'fixed').length,
        eraseCostAnAttempt: roundDAttempts !== before
      });
    }, 250);
  }));
  ok(cap.letters === 16 && cap.fixed === 4, 'layout: "angry - angrier than" keeps its 3 spaces + dash visible');
  ok(cap.gaps === 6, 'pacing: a 16-letter item is capped at 6 handwritten letters (got ' + cap.gaps + ')');
  ok(cap.given === 10, 'pacing: the other 10 letters are given as context');
  ok(!cap.eraseCostAnAttempt, 'erase: wiping a slip does not count as a failed attempt');

  await browser.close();

  const realErrors = errors.filter(t => !/net::ERR_|Failed to load resource|ERR_FILE_NOT_FOUND|favicon/i.test(t));
  ok(realErrors.length === 0, 'runtime: no JS errors (' + (realErrors.length ? realErrors.join(' | ') : 'clean') + ')');

  console.log('\n--- HANDWRITING (browser) ---');
  console.log(pass + ' passed, ' + fail + ' failed');
  console.log('RESULT: ' + (fail === 0 ? 'PASS' : 'FAIL'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('CRASH:', e); process.exit(2); });

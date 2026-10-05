// ============================================================
// HANDWRITING ROUND — browser verification.
//
// test_handwriting.js covers the pure mask maths with synthetic rings. This
// covers the half that only a real browser can: glyph masks read from actual
// Fredoka pixels, the pointer plumbing, and the round flow.
//
// Pen paths are derived FROM the glyph masks (row-centreline dots), so a
// "complete" trace really is the letter. Hand-guessed pen paths proved unable
// to represent letters faithfully.
//
// Pinned here:
//   - a complete letter is accepted, including multi-stroke letters written
//     with a real pause between strokes (t, i, x);
//   - a lift that does not complete the letter is not judged until the grace
//     window (HW_STROKE_GAP_MS) passes;
//   - letters made of separate pieces (i, j) cannot be written in one stroke;
//   - blank box first, outline after two refusals, reveal after five;
//   - a completed word queues one "handwriting" exercise event;
//   - the tuning readout (__hwLast) ships with every field the field-tuning
//     workflow needs.
//
// NOT pinned here, on purpose: refusing confusable pairs such as "l for t" or
// "c for a". In Fredoka the t crossbar is ~2% of the glyph's ink and a
// single-story a's stem sits where a c's tips flare, so no geometric bar
// refuses those without also refusing good letters. They are tunable in the
// field via ?miss= / ?recall= / ?prec= on the test site, and the readout line
// reports the numbers needed to choose the bars from real handwriting.
//
// Run:  node test_handwriting_browser.js   (part of npm test)
// ============================================================
const { chromium } = require('playwright-core');
const path = require('path');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fileUrl = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS: ' + m); } else { fail++; console.error('FAIL: ' + m); } }

const SETTLE = 1900;   // > HW_STROKE_GAP_MS: long enough for a lift to be judged
const ADVANCE = 600;   // > the round's 420ms wait before showing the next gap

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
    for (const ch of ['a', 'o', 'l', 'i', 't', 'x', 'z', 'A', 'Q']) {
      const b = hwBbox(hwGlyphMask(ch), HW_SIZE);
      out[ch] = b ? b.count : 0;
    }
    out._fontLoaded = !!(document.fonts && document.fonts.check('10px Fredoka'));
    out._iPieces = hwGuideComponents('i');
    out._tPieces = hwGuideComponents('t');
    return out;
  });
  ok(glyph._fontLoaded, 'font: Fredoka is actually loaded before the masks are built');
  for (const ch of ['a', 'o', 'l', 'i', 't', 'x', 'z', 'A', 'Q']) {
    ok(glyph[ch] > 100, 'glyph: ' + ch + ' renders ink (' + glyph[ch] + ' px)');
  }
  ok(glyph._iPieces === 2, 'glyph: "i" is two separate pieces (dot + stem), so it needs two strokes');
  ok(glyph._tPieces === 1, 'glyph: "t" is one piece, so stroke count does not gate it');

  // --- harness ----------------------------------------------------------------
  await page.evaluate(() => {
    window.playTTS = function () { };
    window.synthGem = function () { };
    window.synthError = function () { };
    window.queueExerciseEvent = function () { (window.__events = window.__events || []).push([].slice.call(arguments)); };
    window.showTranslation = function () { };
    window.showVocabImage = function () { };
    // The harness never selects content, and a completed word would otherwise
    // fall through into Round E and throw, leaving isTransitioning stuck true.
    window.selectedClassContent = { book: 1, unit: 1, page: 1 };
    window.startRoundE = function () { };
    STUDY_STATE.active = true;
    document.getElementById('studyModeOverlay').classList.remove('hidden');

    // A "pen path" for a letter: one dot per ink run per row, i.e. the letter's
    // own centreline. `skip` is DATA (functions cannot cross into the page):
    //   { xGt } / { xLt } / { yLt }   omit one side of a cut line
    window.__hwPath = function (letter, skip) {
      const omit = (p) => {
        if (!skip) return false;
        if (skip.xGt !== undefined) return p.x > skip.xGt;
        if (skip.xLt !== undefined) return p.x < skip.xLt;
        if (skip.yLt !== undefined) return p.y < skip.yLt;
        return false;
      };
      const mask = hwGlyphMask(letter);
      const strokes = [];
      for (let y = 0; y < HW_SIZE; y += 3) {
        let x = 0;
        while (x < HW_SIZE) {
          if (!mask[y * HW_SIZE + x] || omit({ x, y })) { x++; continue; }
          let x2 = x;
          while (x2 + 1 < HW_SIZE && mask[y * HW_SIZE + x2 + 1] && !omit({ x: x2 + 1, y })) x2++;
          strokes.push([{ x: (x + x2) / 2, y: y }]);
          x = x2 + 1;
        }
      }
      if (skip && skip.mirrorX) {
        for (const st of strokes) for (const p of st) p.x = HW_SIZE - 1 - p.x;
      }
      return strokes;
    };
    // One unbroken vertical stroke, for the stroke-count rule.
    window.__hwLine = function (x, y0, y1) {
      const pts = [];
      for (let y = y0; y <= y1; y += 3) pts.push({ x: x, y: y });
      return [pts];
    };
    // Dispatch strokes as real pointer events, each stroke a down/move.../up.
    window.__hwDraw = function (strokes) {
      const r = document.querySelector('.hw-trace-canvas').getBoundingClientRect();
      const at = (p) => [r.x + p.x / HW_SIZE * r.width, r.y + p.y / HW_SIZE * r.height];
      const fire = (type, p, buttons) => {
        const c = at(p);
        document.querySelector('.hw-trace-canvas').dispatchEvent(new PointerEvent(type, {
          clientX: c[0], clientY: c[1], pointerId: 7, bubbles: true, cancelable: true,
          isPrimary: true, button: 0, buttons: buttons, pointerType: 'touch'
        }));
      };
      for (const st of strokes) {
        for (let i = 0; i < st.length; i++) fire(i === 0 ? 'pointerdown' : 'pointermove', st[i], 1);
        fire('pointerup', st[st.length - 1], 0);
      }
    };
  });

  async function loadWord(word, gaps) {
    await page.evaluate(([w, g]) => {
      STUDY_STATE.round = 'D';   // the harness skips startRoundD, which sets this
      STUDY_STATE.words = [w];
      STUDY_STATE.currentWordIndex = 0;
      STUDY_STATE.isTransitioning = false;
      nextRoundDWord();
      roundDGapOrder.forEach(i => { roundDSlots[i].gap = false; });
      roundDGapOrder = g.slice();
      roundDGapOrder.forEach(i => { roundDSlots[i].gap = true; });
      roundDCursor = 0;
      renderRoundDSlots();
      roundDShowTarget();
    }, [word, gaps]);
    await page.waitForTimeout(250);
  }

  // Draw a whole letter in one synchronous burst; judgement lands ~1.5s later.
  async function drawLetter(letter, skip) {
    await page.evaluate(([l, k]) => window.__hwDraw(window.__hwPath(l, k)), [letter, skip || null]);
    await page.waitForTimeout(SETTLE);
  }

  const state = () => page.evaluate(() => ({
    slots: roundDSlots.map(s => s.type === 'fixed' ? '#' : (s.filled ? (s.given ? '?' : s.char.toUpperCase()) : '_')).join(''),
    cursor: roundDCursor,
    attempts: roundDAttempts,
    guided: roundDGuided,
    target: roundDCursor < roundDGapOrder.length ? roundDSlots[roundDGapOrder[roundDCursor]].char : null,
    last: window.__hwLast || null,
    events: window.__events || []
  }));

  // --- a complete letter is accepted -----------------------------------------
  await loadWord('cat', [0, 1, 2]);
  let s = await state();
  ok(s.target === 'c' && s.slots === '___', 'round: three gaps, first target "c"');
  await drawLetter('c');
  s = await state();
  ok(s.cursor === 1 && s.slots === 'C__', 'accept: a complete "c" is accepted (slots="' + s.slots + '")');
  ok(s.last && s.last.strokes !== undefined && s.last.width !== undefined && s.last.minStrokes !== undefined,
    'readout: the tuning readout reports strokes, minStrokes and extent ratios');

  await loadWord('log', [0]);
  await drawLetter('l');
  s = await state();
  ok(s.cursor === 1 && s.slots === 'L__', 'accept: a drawn "l" fills an "l" gap');

  // Good letters across shapes still accept with the narrow pen.
  for (const [word, gap, letter, shown] of [
    ['dig', 0, 'd', 'D'], ['pig', 2, 'g', 'G'], ['box', 0, 'b', 'B'], ['tap', 0, 't', 'T']
  ]) {
    await loadWord(word, [gap]);
    await drawLetter(letter);
    s = await state();
    ok(s.cursor === 1 && s.slots.indexOf(shown) !== -1,
      'accept: a drawn "' + letter + '" fills its gap in "' + word + '"');
  }

  // --- the slips the classroom reported, now refused ---------------------------
  for (const [draw, mirror, word, gap, target] of [
    ['l', false, 'tap', 0, 't'],        // bare stem offered for t
    ['c', false, 'cat', 1, 'a'],        // open c offered for a
    ['c', false, 'dig', 0, 'd'],        // open c offered for d
    ['a', false, 'pig', 2, 'g'],        // a offered for g (no descender)
    ['c', true, 'box', 0, 'b']          // backwards c offered for b
  ]) {
    await loadWord(word, [gap]);
    await drawLetter(draw, mirror ? { mirrorX: true } : null);
    s = await state();
    ok(s.cursor === 0,
      'refuse: a drawn "' + (mirror ? 'backwards ' : '') + draw + '" is refused for "' + target +
      '" (missing=' + (s.last ? s.last.missing : '?') + ')');
  }

  // --- start / end anchors are derived and painted -----------------------------
  const anchors = await page.evaluate(() => {
    const a = hwGlyphAnchors('l');
    return a && a.start && a.end ? { sy: a.start.y, ey: a.end.y } : null;
  });
  ok(anchors && anchors.sy < 60 && anchors.ey > 90,
    'anchors: the "l" start point is at the top and the end point at the bottom');
  const anchorPixels = await page.evaluate(() => {
    const cv = document.querySelector('.hw-trace-canvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let green = 0;
    for (let p = 0; p < d.length; p += 4) if (d[p + 1] > 120 && d[p] < 90 && d[p + 2] < 110) green++;
    return green;
  });
  ok(anchorPixels > 50, 'anchors: the green start dot is actually painted on the paper (' + anchorPixels + ' px)');

  // --- letters in separate pieces need separate strokes -----------------------
  const iDotCut = await page.evaluate(() => hwBbox(hwGlyphMask('i'), HW_SIZE).y0 + 16);
  await loadWord('tip', [1]);
  await page.evaluate((d) => window.__hwDraw(window.__hwLine(64, d.from, d.to)), { from: iDotCut + 4, to: 102 });
  await page.waitForTimeout(SETTLE);
  s = await state();
  ok(s.cursor === 0,
    'refuse: one unbroken stroke is refused for "i" (strokes=' + (s.last ? s.last.strokes : '?') +
    ', needed=' + (s.last ? s.last.minStrokes : '?') + ')');

  // --- the pen may leave the paper between strokes ----------------------------
  await loadWord('tip', [1]);
  await page.evaluate((d) => window.__hwDraw(window.__hwLine(64, d.from, d.to)), { from: iDotCut + 4, to: 102 });
  await page.waitForTimeout(400);
  s = await state();
  ok(s.attempts === 0 && s.cursor === 0,
    'strokes: lifting the pen after the stem is NOT judged as a failed attempt');
  await page.evaluate((d) => window.__hwDraw(window.__hwPath('i', { yLt: d.cut })), { cut: iDotCut });  // the dot, after a real pause
  await page.waitForTimeout(SETTLE);
  s = await state();
  ok(s.cursor === 1,
    'strokes: the dot after a pause completes the "i" and is accepted (slots="' + s.slots + '")');

  // --- scaffold: blank, then the outline, then the reveal ---------------------
  await loadWord('in', [0, 1]);
  s = await state();
  ok(s.target === 'i' && s.slots === '__', 'round: both letters of "in" are gaps');

  await page.evaluate((d) => window.__hwDraw(window.__hwLine(64, d.from, d.to)), { from: iDotCut + 4, to: 102 });
  await page.waitForTimeout(SETTLE);
  s = await state();
  ok(s.attempts === 1 && !s.guided, 'scaffold: still no outline after one refusal');

  await page.evaluate((d) => window.__hwDraw(window.__hwLine(64, d.from, d.to)), { from: iDotCut + 4, to: 102 });
  await page.waitForTimeout(SETTLE);
  s = await state();
  ok(s.guided === true && s.attempts === 2, 'scaffold: the outline fades in after 2 refusals');

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

  await page.evaluate(() => clearRoundD());
  await drawLetter('i');
  s = await state();
  ok(s.cursor === 1 && s.slots === 'I_', 'scaffold: tracing the outline completes the letter (slots="' + s.slots + '")');
  await page.waitForTimeout(ADVANCE);
  s = await state();
  ok(s.target === 'n' && s.attempts === 0 && !s.guided,
    'accept: the round advances to "n" with the attempts and the outline reset');

  const giveUp = await page.evaluate(async () => {
    roundDAttempts = ROUND_D_GIVE_UP_AFTER - 1;   // one more refusal triggers the reveal
    roundDRejectLetter();
    return new Promise(res => setTimeout(() => res({
      slots: roundDSlots.map(x => x.type === 'fixed' ? '#' : (x.filled ? (x.given ? '?' : x.char.toUpperCase()) : '_')).join(''),
      given: roundDSlots[roundDGapOrder[1]].given === true,
      events: window.__events || []
    }), 1400));
  });
  ok(giveUp.given && giveUp.slots === 'I?', 'dead end: the last letter is revealed rather than blocking the child');
  ok(giveUp.events.length >= 1 && giveUp.events[giveUp.events.length - 1][0] === 'handwriting',
    'telemetry: a "handwriting" exercise event is queued when the word completes (' +
    JSON.stringify(giveUp.events.map(e => e[2])) + ')');

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

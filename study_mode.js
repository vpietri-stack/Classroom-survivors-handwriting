
const STUDY_STATE = {
    active: false,
    words: [],      // The 5 selected words
    sentences: [],  // The 5 selected sentences
    remainingWordsRoundA: [], // Words left to find in Round A
    currentWordIndex: 0, // For Rounds B and C (0 to 4)
    currentSentenceIndex: 0, // For Round E (0 to 4)
    round: 'A',     // 'A', 'B', 'C', 'D'
    startTime: 0,
    timerInterval: null,
    isTransitioning: false
};

// SR result tracking for this study session
var srStudyResults = [];  // [{ type, key, firstAttempt }, ...]
var srUsedPairKeys = new Set();    // sentence-pair keys already shown in Round F this session

// Non-blocking notice (replaces alert(): kids shouldn't hit a modal on start).
function showStudyNotice(msg) {
    const n = document.createElement('div');
    n.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[9999] bg-amber-500 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-bold';
    n.innerText = msg;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 4000);
}

// Entry point
function initStudyMode() {
    // Determine book/unit/page from current selection
    let book = "PU1", unit = "0", page = "5";
    if (typeof selectedClassContent !== 'undefined' && selectedClassContent) {
        book = selectedClassContent.book;
        unit = selectedClassContent.unit;
        page = selectedClassContent.page;
    }

    // Get Spaced Repetition Content (SR-aware)
    const SR_WORDS = getStudyContentSR(book, unit, page, 'vocab', 5);
    const SR_SENTENCES = getStudyContentSR(book, unit, page, 'sentences', 5);

    if (SR_WORDS.length < 5 || SR_SENTENCES.length < 5) {
        if (SR_WORDS.length === 0 || SR_SENTENCES.length === 0) {
            showStudyNotice("Not enough content for Study Mode on this page yet.");
            return;
        }
        showStudyNotice("Fewer than 5 words/sentences available — running a shorter session.");
    }

    STUDY_STATE.active = true;
    STUDY_STATE.startTime = Date.now();
    STUDY_STATE.round = 'A';
    STUDY_STATE.isTransitioning = false;
    STUDY_STATE.srFinalized = false;

    // Reset SR tracking for this session
    srStudyResults = [];
    srUsedPairKeys = new Set();

    // Pick exactly 5 (SR logic already tries to do this, but let's be sure)
    STUDY_STATE.words = SR_WORDS.slice(0, 5);
    STUDY_STATE.sentences = SR_SENTENCES.slice(0, 5);

    // Hide Start Screen
    document.getElementById('startScreen').classList.add('hidden');

    // Hide game-over screens and stop active game scenes when entering study mode
    ['gameOverScreen', 'gameSelectionOverlay', 'gomokuGameOverScreen', 'unoGameOverScreen', 'gameIntroOverlay'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    if (typeof game !== 'undefined' && game && game.scene) {
        if (game.scene.isActive('MainScene')) game.scene.stop('MainScene');
        if (game.scene.isActive('UnoScene')) game.scene.stop('UnoScene');
    }
    if (typeof game !== 'undefined' && game && game.canvas) {
        game.canvas.style.display = 'none';
    }
    if (typeof minigameCountdownInterval !== 'undefined' && minigameCountdownInterval) {
        clearInterval(minigameCountdownInterval);
        minigameCountdownInterval = null;
    }
    // Hide VS exit button + mute toggle
    const vsExitBtn = document.getElementById('vsExitBtn');
    if (vsExitBtn) vsExitBtn.classList.add('hidden');
    const vsMuteBtn = document.getElementById('vsMuteBtn');
    if (vsMuteBtn) vsMuteBtn.classList.add('hidden');
    const vsMusicBtn = document.getElementById('vsMusicBtn');
    if (vsMusicBtn) vsMusicBtn.classList.add('hidden');
    activeGameMode = null;

    // Show Study Overlay
    const overlay = document.getElementById('studyModeOverlay');
    overlay.classList.remove('hidden');

    startRoundA();
}

// --- ROUND A: Word Recognition ---
function startRoundA() {
    STUDY_STATE.round = 'A';
    STUDY_STATE.remainingWordsRoundA = [...STUDY_STATE.words];

    updateStudyUI("Round A: Word Recognition", "Listen and click the correct word.");

    const container = document.getElementById('study-game-area');
    container.innerHTML = `
        <div class="flex flex-col items-center gap-3 w-full">
            <button onclick="playTTS()" aria-label="Play Audio" class="audio-play-btn"><i class="fas fa-volume-up"></i></button>
            <div id="roundA-translation" class="translation-hint hidden"></div>
            <img id="roundA-image" class="vocab-image hidden" alt="Vocabulary Image">
            <div id="roundA-container" class="flex flex-wrap justify-center gap-3 w-full px-2">
                <!-- Words injected here -->
            </div>
        </div>
    `;

    renderRoundAWords();
    playRoundAPrompt();
}

function renderRoundAWords() {
    const container = document.getElementById('roundA-container');
    container.innerHTML = '';

    // Display all remaining words (randomized order on screen? or fixed positions? 
    // "5 words picked randomly... are displayed... word disappears". 
    // Keep positions? Randomize? Let's randomize initially, then just remove.
    // Actually, let's keep them in a stable set but hide found ones? Or just remove DOM elements?
    // If I re-render, they might jump around. I'll just render once and remove element on success.

    // Wait, if I render once, I need to know which ones are there. 
    // Let's render STUDY_STATE.remainingWordsRoundA.
    // But then they jump.
    // Let's render the initial 5 words, and hide the ones NOT in remainingWordsRoundA if we wanted stable positions.
    // But the requirements imply "that word disappears". Removing DOM element is fine.

    STUDY_STATE.remainingWordsRoundA.sort(() => 0.5 - Math.random()).forEach(word => {
        const btn = document.createElement('button');
        btn.className = "game-btn bg-indigo-500 hover:bg-indigo-400 text-xl sm:text-2xl px-6 py-4 rounded-xl shadow-lg transform transition-all active:scale-95 w-full sm:w-auto";
        btn.innerText = word;
        btn.onclick = () => checkRoundA(word, btn);
        container.appendChild(btn);
    });
}

function playRoundAPrompt() {
    if (STUDY_STATE.remainingWordsRoundA.length === 0) {
        finishRoundA();
        return;
    }
    // "sound of one of the word is played" -> Pick random from remaining
    const target = STUDY_STATE.remainingWordsRoundA[Math.floor(Math.random() * STUDY_STATE.remainingWordsRoundA.length)];
    currentTTSWord = target; // Global from game.js for playTTS()
    showTranslation('roundA-translation', target);
    showVocabImage('roundA-image', target);
    setTimeout(playTTS, 500); // Small delay
}

function checkRoundA(word, btnElement) {
    if (STUDY_STATE.isTransitioning) return;
    if (word === currentTTSWord) {
        STUDY_STATE.isTransitioning = true;
        // Correct
        playHappySound(); // Need to implement or reuse
        btnElement.classList.add('scale-0', 'transition-transform', 'duration-300'); // Animate out

        // Remove from list
        STUDY_STATE.remainingWordsRoundA = STUDY_STATE.remainingWordsRoundA.filter(w => w !== word);

        setTimeout(() => {
            btnElement.remove();
            STUDY_STATE.isTransitioning = false;
            playRoundAPrompt();
        }, 500);
    } else {
        // Wrong
        synthError(); // Reuse game.js
        btnElement.classList.add('bg-red-500', 'shake');
        setTimeout(() => btnElement.classList.remove('bg-red-500', 'shake'), 500);
        setTimeout(playTTS, 600); // Replay correct sound
    }
}

function finishRoundA() {
    // Round A (word recognition) completed → straight into Word Scramble.
    // (Word-level pronunciation was removed; speech now happens on sentences.)
    startRoundC();
}


// --- ROUND B: Word Scramble ---
function startRoundC() {
    STUDY_STATE.round = 'C';
    STUDY_STATE.currentWordIndex = 0;
    updateStudyUI("Round B: Word Scramble", "Unscramble the letters.");
    startExerciseTracking();
    nextRoundCWord();
}

function nextRoundCWord() {
    if (STUDY_STATE.currentWordIndex >= STUDY_STATE.words.length) {
        finishRoundC();
        return;
    }

    const word = STUDY_STATE.words[STUDY_STATE.currentWordIndex];
    currentTTSWord = word;

    const container = document.getElementById('study-game-area');
    container.innerHTML = `
        <div class="flex flex-col items-center gap-3 w-full">
            <button onclick="playTTS()" aria-label="Play Audio" class="audio-play-btn"><i class="fas fa-volume-up"></i></button>
            <div id="roundC-translation" class="translation-hint hidden"></div>
            <img id="roundC-image" class="vocab-image hidden" alt="Vocabulary Image">
            
            <div id="scramble-slots" class="flex flex-wrap justify-center gap-[var(--gap-sm)] min-h-[54px] w-full px-2"></div>
            
            <div id="scramble-bank" class="flex flex-wrap justify-center gap-[var(--gap-sm)] w-full px-2"></div>

            <div class="flex gap-3 w-full justify-center">
                <button onclick="checkRoundC()" class="game-btn bg-green-500 py-3 px-6 flex-1 max-w-[160px]">CHECK</button>
                <button onclick="clearRoundC()" class="game-btn bg-gray-500 py-3 px-6 flex-1 max-w-[160px]">CLEAR</button>
            </div>
        </div>
    `;
    showTranslation('roundC-translation', word);
    showVocabImage('roundC-image', word);

    // Setup Slots — group consecutive LETTER slots into one .word-group so a word
    // (e.g. "danced") never breaks across lines; separators stay individual flex
    // items so wrapping can occur only at space/-/./?/!.
    const slotsDiv = document.getElementById('scramble-slots');
    slotsDiv.innerHTML = '';
    let groupEl = null;
    const flushGroup = () => { if (groupEl && groupEl.children.length) slotsDiv.appendChild(groupEl); groupEl = null; };
    for (let i = 0; i < word.length; i++) {
        if (word[i] === ' ') {
            flushGroup();
            const slot = document.createElement('div');
            slot.className = "study-slot";
            slot.innerText = ' ';
            slot.classList.add('border-transparent');
            slot.style.borderColor = "transparent";
            slot.style.background = "transparent";
            slot.dataset.fixed = "true";
            slotsDiv.appendChild(slot);
        } else if (word[i] === "-" || word[i] === "." || word[i] === "?" || word[i] === "!") {
            flushGroup();
            const slot = document.createElement('div');
            slot.className = "study-slot";
            slot.innerText = word[i];
            slot.classList.add('border-transparent', 'flex', 'items-end', 'pb-2', 'text-2xl', 'font-bold', 'text-white');
            slot.style.borderColor = "transparent";
            slot.style.background = "transparent";
            slot.dataset.fixed = "true";
            slotsDiv.appendChild(slot);
        } else {
            if (!groupEl) {
                groupEl = document.createElement('div');
                groupEl.className = 'word-group';
            }
            const slot = document.createElement('div');
            slot.className = "study-slot";
            slot.onclick = () => removeLetterFromSlot(i, word);
            groupEl.appendChild(slot);
        }
    }
    flushGroup();
    if (typeof fitAnswerArea === 'function') fitAnswerArea(slotsDiv);

    // Setup Bank (Scrambled letters, excluding spaces). This bank DEPLETES:
    // clicking a bank letter moves it into the earliest empty slot and removes it
    // from the bank, so it's clear which letters remain (mirrors Round E / game-mode).
    const bankDiv = document.getElementById('scramble-bank');
    const punctuation = [' ', "-", ".", "?", "!"];
    const letters = word.split('').filter(c => !punctuation.includes(c)).sort(() => 0.5 - Math.random());

    bankDiv.innerHTML = '';
    letters.forEach((char) => {
        const btn = document.createElement('button');
        btn.className = "study-letter-btn";
        btn.innerText = char;
        btn.dataset.char = char;
        btn.onclick = () => addLetterToSlot(char, btn, word);
        bankDiv.appendChild(btn);
    });

    STUDY_STATE._roundCFrozen = false;
    playTTS();
}

// Round C State
let roundCInput = []; // Array of chars

// Slots are grouped into .word-group wrappers (so a word like "danced" never
// breaks across lines), so the live slot elements are .study-slot descendants —
// in the same document order as the original flat layout. Use this everywhere
// instead of scramble-slots.children (whose direct children are now groups).
function roundCSlots() {
    return Array.from(document.querySelectorAll('#scramble-slots .study-slot'));
}

function addLetterToSlot(char, btnElement, targetWord) {
    if (STUDY_STATE.isTransitioning || STUDY_STATE._roundCFrozen) return;
    const slots = roundCSlots();
    // Place into the earliest EMPTY letter-slot (fixed slots skipped). The gap
    // stays (no reflow) so positions remain stable for the learner.
    let placedSlot = null;
    for (let i = 0; i < slots.length; i++) {
        if (slots[i].dataset.fixed === "true") continue;
        if (!slots[i].innerText) {
            slots[i].innerText = char;
            placedSlot = slots[i];
            break;
        }
    }
    if (!placedSlot) return; // no empty slot
    // Bank DEPLETES: remove the exact tile that was clicked so it's clear which
    // letters remain.
    if (btnElement && btnElement.parentElement) btnElement.remove();
}

function removeLetterFromSlot(index, targetWord) {
    if (STUDY_STATE.isTransitioning || STUDY_STATE._roundCFrozen) return;
    const slots = roundCSlots();
    const slot = slots[index];
    if (slot.innerText) {
        const char = slot.innerText;
        slot.innerText = '';
        // Return the letter to the bank (it depletes on placement, so delete restores it).
        const bank = document.getElementById('scramble-bank');
        const btn = document.createElement('button');
        btn.className = "study-letter-btn";
        btn.innerText = char;
        btn.dataset.char = char;
        btn.onclick = () => addLetterToSlot(char, btn, targetWord);
        bank.appendChild(btn);
        // Cancel any pending reveal/reset so colours clear immediately on edit.
        if (slot._resetTimer) { clearTimeout(slot._resetTimer); slot._resetTimer = null; }
        resetSlotColors();
    }
}

function resetSlotColors() {
    const slots = roundCSlots();
    for (let s of slots) {
        s.classList.remove('bg-green-500', 'bg-red-500');
        s.classList.add('bg-gray-800');
    }
}

// CHECK button: reveal correct (green) / wrong (red) for ~5s, then reset all to bank.
function checkRoundC() {
    if (STUDY_STATE.isTransitioning) return;
    const slots = roundCSlots();
    const targetWord = currentTTSWord;

    // Fill state: every non-fixed slot must have a letter.
    let isFull = true;
    for (let s of slots) {
        if (s.dataset.fixed === "true") continue;
        if (!s.innerText) isFull = false;
    }
    if (!isFull) {
        // Nothing to grade yet — give a soft nudge but do not reset.
        synthError();
        return;
    }

    let allCorrect = true;
    const correctChars = targetWord.split('');
    for (let i = 0; i < slots.length; i++) {
        if (slots[i].dataset.fixed === "true") continue;
        const char = slots[i].innerText;
        if (char === correctChars[i]) {
            slots[i].classList.remove('bg-gray-800', 'bg-red-500');
            slots[i].classList.add('bg-green-500');
        } else {
            slots[i].classList.remove('bg-gray-800', 'bg-green-500');
            slots[i].classList.add('bg-red-500');
            allCorrect = false;
        }
    }

    if (allCorrect) {
        STUDY_STATE.isTransitioning = true;
        STUDY_STATE._roundCFrozen = true;
        playHappySound();
        srStudyResults.push({ type: 'vocab', key: itemKey(targetWord), firstAttempt: exerciseAttempts === 1 });
        queueExerciseEvent('wordScramble', 'study', targetWord);
        setTimeout(() => {
            STUDY_STATE.currentWordIndex++;
            startExerciseTracking();
            STUDY_STATE.isTransitioning = false;
            STUDY_STATE._roundCFrozen = false;
            nextRoundCWord();
        }, 1000);
        return;
    }

    // Wrong: reveal for ~5s (frozen), then clear all slots AND return every letter
    // to the bank (it depletes on placement, so a wrong check must restore them).
    STUDY_STATE._roundCFrozen = true;
    synthError();
    // Record SR failure at the FIRST wrong check (parity with game mode): the
    // item is due next session even if the student quits before succeeding.
    // The canonical collapse in finalizeSession keeps this first record even
    // after the later success push.
    if (exerciseAttempts === 1) {
        srStudyResults.push({ type: 'vocab', key: itemKey(targetWord), firstAttempt: false });
    }
    incrementExerciseAttempts();
    const slotsArr = Array.from(slots);
    slotsArr.forEach(s => {
        if (s._resetTimer) clearTimeout(s._resetTimer);
        s._resetTimer = setTimeout(() => {
            const bank = document.getElementById('scramble-bank');
            for (let slot of slots) {
                if (slot.dataset.fixed === "true") continue; // never move fixed chars (space / - / . ) into the bank
                if (slot.innerText) {
                    const char = slot.innerText;
                    const btn = document.createElement('button');
                    btn.className = "study-letter-btn";
                    btn.innerText = char;
                    btn.dataset.char = char;
                    btn.onclick = () => addLetterToSlot(char, btn, targetWord);
                    bank.appendChild(btn);
                    slot.innerText = '';
                }
                resetSlotColors();
            }
            STUDY_STATE._roundCFrozen = false;
        }, 5000);
    });
}

function clearRoundC() {
    // Allow CLEAR during the wrong-answer reveal (so the player can skip the 5s
    // wait), but not during the 1s success transition to the next word.
    if (STUDY_STATE.isTransitioning) return;
    const slots = roundCSlots();
    const bank = document.getElementById('scramble-bank');
    for (let slot of slots) {
        if (slot._resetTimer) { clearTimeout(slot._resetTimer); slot._resetTimer = null; }
        if (slot.dataset.fixed === "true") continue; // never move fixed chars (space / - / . ) into the bank
        if (slot.innerText) {
            // Return the letter to the bank (it depletes on placement).
            const char = slot.innerText;
            const btn = document.createElement('button');
            btn.className = "study-letter-btn";
            btn.innerText = char;
            btn.dataset.char = char;
            btn.onclick = () => addLetterToSlot(char, btn, currentTTSWord);
            bank.appendChild(btn);
            slot.innerText = '';
        }
        resetSlotColors();
    }
    // Cancel any pending reveal reset and unfreeze so editing resumes immediately.
    STUDY_STATE._roundCFrozen = false;
}

function finishRoundC() {
    startRoundD();
}


// --- ROUND C: Handwriting (write the missing letters) ---
// Internal round 'D' renders as "Round C" — the same offset convention the rest
// of this file uses (internal 'C' renders as "Round B").
function startRoundD() {
    STUDY_STATE.round = 'D';
    STUDY_STATE.currentWordIndex = 0;
    updateStudyUI("Round C: Handwriting", "Write the missing letters.");
    startExerciseTracking();
    // Fredoka must be loaded before the first glyph mask is built, otherwise the
    // outline (and so the scoring target) would be a fallback font's shape.
    hwEnsureFont().then(() => nextRoundDWord());
}

function nextRoundDWord() {
    if (STUDY_STATE.currentWordIndex >= STUDY_STATE.words.length) {
        finishRoundD();
        return;
    }

    const word = STUDY_STATE.words[STUDY_STATE.currentWordIndex];
    currentTTSWord = word;

    const container = document.getElementById('study-game-area');
    container.innerHTML = `
        <div class="flex flex-col items-center gap-3 w-full">
            <button onclick="playTTS()" aria-label="Play Audio" class="audio-play-btn"><i class="fas fa-volume-up"></i></button>
            <div id="roundD-translation" class="translation-hint hidden"></div>
            <img id="roundD-image" class="vocab-image hidden" alt="Vocabulary Image">

            <div id="handwriting-slots" class="flex flex-wrap justify-center gap-[var(--gap-xs)] min-h-[60px] w-full px-4 text-white"></div>

            <div id="handwriting-trace" class="flex flex-col items-center"></div>

            <button onclick="clearRoundD()" aria-label="Erase what you wrote" class="game-btn bg-gray-500 py-2 px-6">
                <i class="fas fa-eraser"></i> ERASE
            </button>
        </div>
    `;
    showTranslation('roundD-translation', word);
    showVocabImage('roundD-image', word);

    // Slots are 1:1 with the word's characters. Punctuation and spaces stay
    // visible and fixed; a RANDOM subset of the letters (max ROUND_D_MAX_GAPS)
    // become gaps the student handwrites, and the rest are given as context —
    // so a 29-letter item costs the same as a 6-letter one.
    const punct = [' ', "'", "-", ".", "?", "!", ","];
    roundDWord = word;
    roundDSlots = word.split('').map(ch => punct.includes(ch)
        ? { type: 'fixed', char: ch }
        : { type: 'letter', char: ch, gap: false, filled: false, given: false });
    roundDGapOrder = hwPickGaps(word, ROUND_D_MAX_GAPS);
    roundDGapOrder.forEach(i => { roundDSlots[i].gap = true; });
    roundDCursor = 0;

    renderRoundDSlots();

    const mount = document.getElementById('handwriting-trace');
    if (roundDTrace) roundDTrace.destroy();
    roundDTrace = hwCreateTraceBox({ onAccept: roundDAcceptLetter, onReject: roundDRejectLetter });
    mount.appendChild(roundDTrace.el);
    roundDTrace.measure();

    roundDShowTarget();
    playTTS();
}

let roundDWord = '';
let roundDSlots = [];      // 1:1 with the word's characters
let roundDGapOrder = [];   // gap slot indices, left-to-right
let roundDCursor = 0;      // index into roundDGapOrder: the gap being written
let roundDAttempts = 0;    // rejected traces on the CURRENT gap
let roundDGuided = false;  // has the outline faded in yet?
let roundDTrace = null;    // the hwCreateTraceBox widget

const ROUND_D_MAX_GAPS = 6;      // cap per word, so a 29-letter item stays quick
const ROUND_D_GUIDE_AFTER = 2;   // rejected traces before the outline fades in
const ROUND_D_GIVE_UP_AFTER = 5; // rejected traces before we reveal and move on

// Re-render the answer row: given letters, gaps already written, and the one
// active gap. Consecutive letters are wrapped in .word-group so a word never
// breaks across lines; separators stay individual flex items (same convention
// as the scramble round).
function renderRoundDSlots() {
    const disp = document.getElementById('handwriting-slots');
    if (!disp) return;
    const activeIdx = roundDCursor < roundDGapOrder.length ? roundDGapOrder[roundDCursor] : -1;
    let html = "";
    let groupBuf = "";
    const flushGroup = () => {
        if (groupBuf) { html += `<span class="word-group">${groupBuf}</span>`; groupBuf = ""; }
    };
    roundDSlots.forEach((slot, i) => {
        if (slot.type === 'fixed') {
            flushGroup();
            html += `<div class="study-slot hw-slot-fixed select-none" style="color:#94a3b8">${slot.char}</div>`;
            return;
        }
        let cls = "study-slot ";
        if (!slot.gap) cls += "hw-slot-given";
        else if (slot.filled) cls += slot.given ? "hw-slot-revealed" : "bg-green-500";
        else cls += "bg-gray-800" + (i === activeIdx ? " hw-slot-active" : "");
        const text = (slot.gap && !slot.filled) ? "" : slot.char;
        groupBuf += `<div class="${cls}">${text}</div>`;
    });
    flushGroup();
    disp.innerHTML = html;
    // Shrink the row if a long no-separator word is too wide for the screen.
    if (typeof fitAnswerArea === 'function') fitAnswerArea(disp);
}

// Point the trace box at the next gap, or finish the word when none are left.
function roundDShowTarget() {
    if (roundDCursor >= roundDGapOrder.length) { roundDWordComplete(); return; }
    roundDAttempts = 0;
    roundDGuided = false;
    roundDTrace.setGuided(false);
    roundDTrace.setTarget(roundDSlots[roundDGapOrder[roundDCursor]].char);
    renderRoundDSlots();
}

function roundDAcceptLetter() {
    if (STUDY_STATE.isTransitioning) return;
    const slot = roundDSlots[roundDGapOrder[roundDCursor]];
    slot.filled = true;
    slot.given = false;
    roundDCursor++;
    synthGem();
    renderRoundDSlots();
    setTimeout(() => {
        if (STUDY_STATE.round === 'D') roundDShowTarget();
    }, 420);
}

function roundDRejectLetter() {
    if (STUDY_STATE.isTransitioning) return;
    roundDAttempts++;
    incrementExerciseAttempts();
    roundDTrace.clearInk();
    const wrap = roundDTrace.el;
    wrap.classList.remove('hw-shake');
    void wrap.offsetWidth;                 // reflow so the animation restarts
    wrap.classList.add('hw-shake');
    synthError();

    if (roundDAttempts >= ROUND_D_GIVE_UP_AFTER) {
        // Dead end: reveal the letter so a child can never get stuck. It is
        // marked as given, so it reads differently from one they wrote.
        const slot = roundDSlots[roundDGapOrder[roundDCursor]];
        slot.filled = true;
        slot.given = true;
        roundDCursor++;
        renderRoundDSlots();
        setTimeout(() => {
            if (STUDY_STATE.round === 'D') roundDShowTarget();
        }, 900);
        return;
    }
    // Second failure on this letter: fade the outline in and loosen the bar.
    if (!roundDGuided && roundDAttempts >= ROUND_D_GUIDE_AFTER) {
        roundDGuided = true;
        roundDTrace.setGuided(true);
    }
}

function roundDWordComplete() {
    STUDY_STATE.isTransitioning = true;
    roundDTrace.freeze();
    renderRoundDSlots();
    playHappySound();
    queueExerciseEvent('handwriting', 'study', roundDWord);
    setTimeout(() => {
        STUDY_STATE.currentWordIndex++;
        startExerciseTracking();
        STUDY_STATE.isTransitioning = false;
        nextRoundDWord();
    }, 1000);
}

function clearRoundD() {
    // Erasing a slip is free — it must not count as a failed attempt.
    if (STUDY_STATE.isTransitioning || !roundDTrace) return;
    roundDTrace.clearInk();
}

function finishRoundD() {
    startRoundE();
}


// --- ROUND D: Sentence Scramble ---
function startRoundE() {
    STUDY_STATE.round = 'E';
    STUDY_STATE.currentSentenceIndex = 0;
    updateStudyUI("Round D: Sentence Scramble", "Order the words.");
    startExerciseTracking();
    nextRoundESentence();
}

function nextRoundESentence() {
    if (STUDY_STATE.currentSentenceIndex >= STUDY_STATE.sentences.length) {
        startRoundF();
        return;
    }

    let sentence = STUDY_STATE.sentences[STUDY_STATE.currentSentenceIndex];
    if (Array.isArray(sentence)) sentence = sentence[0];

    const container = document.getElementById('study-game-area');
    container.innerHTML = `
        <div class="flex flex-col gap-3 w-full max-w-2xl mx-auto px-2">
             <div id="roundE-translation" class="translation-hint hidden"></div>
             <div id="sentence-drop-zone" class="bg-gray-800/50 p-4 rounded-xl min-h-[80px] flex flex-wrap gap-[var(--gap-sm)] items-center justify-center border-2 border-dashed border-gray-500">
                <!-- Word slots -->
             </div>
             
             <div id="sentence-word-bank" class="bg-gray-700/50 p-3 rounded-xl flex flex-wrap gap-[var(--gap-sm)] justify-center min-h-[70px]">
                <!-- Source words -->
             </div>
             
             <div class="flex justify-center gap-3">
                <button onclick="checkRoundE()" class="game-btn bg-green-500 py-3 px-8 flex-1 max-w-[160px]">CHECK</button>
                <button onclick="clearRoundE()" class="game-btn bg-gray-500 py-3 px-8 flex-1 max-w-[160px]">CLEAR</button>
             </div>
        </div>
    `;
    showTranslation('roundE-translation', sentence);

    // Build fixed word-slots (one per token, in order).
    const tokens = sentence.split(' ');
    const dropZone = document.getElementById('sentence-drop-zone');
    dropZone.innerHTML = '';
    tokens.forEach((word, idx) => {
        const slot = document.createElement('div');
        slot.className = 'sentence-slot';
        slot.dataset.index = idx;
        slot.dataset.expected = word;
        dropZone.appendChild(slot);
    });

    // Shuffled bank — DEPLETES on placement: clicking a word moves it into the
    // earliest empty slot and removes it from the bank so it's clear which words
    // remain. (Mirrors the game-mode sentence-scramble fix.)
    const shuffled = [...tokens].sort(() => 0.5 - Math.random());
    const bank = document.getElementById('sentence-word-bank');
    bank.innerHTML = '';
    shuffled.forEach((word, id) => {
        bank.appendChild(createWordTile(word, id));
    });
    // Delegated listener: one handler for the whole bank (avoids per-tile binding
    // and double-placement). Only the placed tile is removed from the bank.
    bank.onclick = (e) => {
        const tile = e.target.closest('.study-word-tile');
        if (tile) placeWordTile(tile);
    };
    // Delegated listener on the drop-zone: clicking a placed tile returns it to
    // the bank (consistent with the bank handler). No per-tile onclick.
    dropZone.onclick = (e) => {
        const placed = e.target.closest('.study-word-tile.placed');
        if (placed) deleteWordTile(placed);
    };

    STUDY_STATE._roundEFrozen = false;
}

function createWordTile(word, id) {
    const btn = document.createElement('button');
    btn.className = "study-word-tile";
    btn.innerText = word;
    btn.dataset.word = word;
    btn.dataset.id = id;
    // Placement is handled by the delegated #sentence-word-bank listener
    // (placeWordTile), which also depletes the tile. No per-tile onclick.
    return btn;
}

// Bank DEPLETES on placement: move the clicked tile into the earliest empty slot
// and remove it from the bank so it's clear which words remain. Clicking a placed
// tile (via the delegated drop-zone listener) returns it to the bank.
function placeWordTile(sourceEl) {
    if (STUDY_STATE.isTransitioning || STUDY_STATE._roundEFrozen) return;
    const dropZone = document.getElementById('sentence-drop-zone');
    const empty = Array.from(dropZone.children).find(s => !s.firstChild);
    if (!empty) return; // no empty slot
    const word = sourceEl.dataset.word;
    const tile = document.createElement('div');
    tile.className = 'study-word-tile placed';
    tile.innerText = word;
    tile.dataset.word = word;
    // Removal is handled by the delegated drop-zone listener (consistent with the
    // bank). No per-tile onclick (avoids double-removal / double-return).
    empty.appendChild(tile);
    if (sourceEl.parentElement) sourceEl.remove();
}

// Remove a placed word and RETURN its tile to the bank so it can be reused.
function deleteWordTile(item) {
    if (STUDY_STATE.isTransitioning || STUDY_STATE._roundEFrozen) return;
    const word = item.dataset.word;
    if (item.parentElement) item.remove();
    const bank = document.getElementById('sentence-word-bank');
    const tile = document.createElement('button');
    tile.className = "study-word-tile";
    tile.innerText = word;
    tile.dataset.word = word;
    bank.appendChild(tile);
}

function clearRoundE() {
    // Allow CLEAR during the wrong-answer reveal (skip the 5s wait). BLOCKED only
    // during the 1s success transition to the next sentence (handled by isTransitioning).
    if (STUDY_STATE.isTransitioning) return;
    const dropZone = document.getElementById('sentence-drop-zone');
    if (STUDY_STATE._roundEResetTimer) { clearTimeout(STUDY_STATE._roundEResetTimer); STUDY_STATE._roundEResetTimer = null; }
    // Remove all placed tiles and RETURN every tile to the bank (this widget
    // depletes on placement, so "clear" must restore the full set).
    const bank = document.getElementById('sentence-word-bank');
    Array.from(dropZone.children).forEach(slot => {
        const p = slot.firstChild;
        if (p) {
            const tile = document.createElement('button');
            tile.className = "study-word-tile";
            tile.innerText = p.dataset.word;
            tile.dataset.word = p.dataset.word;
            bank.appendChild(tile);
            p.remove();
        }
    });
    // Cancel the reveal reset and unfreeze so editing resumes immediately.
    dropZone.classList.remove('border-red-500');
    STUDY_STATE._roundEFrozen = false;
}

function checkRoundE() {
    if (STUDY_STATE.isTransitioning || STUDY_STATE._roundEFrozen) return;
    const dropZone = document.getElementById('sentence-drop-zone');
    const slots = Array.from(dropZone.children);
    const targetWords = slots.map(s => s.dataset.expected);
    const currentWords = slots.map(s => s.firstChild ? s.firstChild.dataset.word : null);

    let allCorrect = currentWords.length === targetWords.length &&
                    currentWords.every((w, i) => w === targetWords[i]);

    slots.forEach((slot, index) => {
        const tile = slot.firstChild;
        if (!tile) return;
        tile.classList.remove('!bg-green-500', '!bg-red-500');
        if (tile.dataset.word === targetWords[index]) {
            tile.classList.add('!bg-green-500');
        } else {
            tile.classList.add('!bg-red-500');
        }
    });

    if (allCorrect) {
        STUDY_STATE.isTransitioning = true;
        STUDY_STATE._roundEFrozen = true;
        playHappySound();
        srStudyResults.push({ type: 'sentences', key: itemKey(STUDY_STATE.sentences[STUDY_STATE.currentSentenceIndex]), firstAttempt: exerciseAttempts === 1 });
        queueExerciseEvent('sentenceScramble', 'study', STUDY_STATE.sentences[STUDY_STATE.currentSentenceIndex]);

        const advance = () => {
            STUDY_STATE.currentSentenceIndex++;
            startExerciseTracking();
            STUDY_STATE.isTransitioning = false;
            STUDY_STATE._roundEFrozen = false;
            nextRoundESentence();
        };

        // Speech step: now that the sentence is built correctly, ask the student
        // to say it aloud (Whisper). Skipped silently if the model isn't ready
        // yet, so it never blocks progression or shows a spinner.
        if (window.SpeechStatus && window.SpeechStatus.isReady() && window.SpeechUI && window.SpeechUI.makeSentenceGate) {
            const sentenceText = targetWords.join(' ');
            // Hide the CHECK/CLEAR controls and the now-empty word bank;
            // place the speech gate INTO the bank's space so the user doesn't scroll.
            const controls = dropZone.parentElement.lastElementChild;
            if (controls) controls.style.display = 'none';
            const bank = document.getElementById('sentence-word-bank');
            if (bank) {
                bank.innerHTML = '';  // clear any residual tiles
                bank.classList.remove('bg-gray-700/50');
                bank.classList.add('bg-transparent');
            }
            const gate = window.SpeechUI.makeSentenceGate({
                target: sentenceText,
                level: 2,
                onDone: advance
            });
            if (bank) {
                bank.appendChild(gate);
            } else {
                dropZone.parentElement.appendChild(gate);
            }
        } else {
            // Log WHY the gate was skipped — without this the skip is invisible
            // in the field ("speech isn't being prompted") and undebuggable.
            if (window.__speechLog) {
                const st = window.SpeechStatus;
                window.__speechLog('Gate skipped: ' + (
                    !st ? 'SpeechStatus missing'
                    : !st.isReady() ? 'state=' + st.state + (st.message ? ' (' + st.message + ')' : '')
                    : !window.SpeechUI ? 'SpeechUI missing'
                    : 'makeSentenceGate missing'));
            }
            setTimeout(advance, 1000);
        }
    } else {
        STUDY_STATE._roundEFrozen = true; // freeze during reveal (not a transition, so CLEAR still works)
        synthError();
        // Record SR failure at the FIRST wrong check (parity with game mode).
        if (exerciseAttempts === 1) {
            srStudyResults.push({ type: 'sentences', key: itemKey(STUDY_STATE.sentences[STUDY_STATE.currentSentenceIndex]), firstAttempt: false });
        }
        incrementExerciseAttempts();
        dropZone.classList.add('border-red-500');
        if (STUDY_STATE._roundEResetTimer) clearTimeout(STUDY_STATE._roundEResetTimer);
        STUDY_STATE._roundEResetTimer = setTimeout(() => {
            dropZone.classList.remove('border-red-500');
            STUDY_STATE.isTransitioning = false;
            STUDY_STATE._roundEFrozen = false;
            // Return all placed tiles to the bank (it depletes on placement).
            const bank = document.getElementById('sentence-word-bank');
            Array.from(dropZone.children).forEach(slot => {
                const p = slot.firstChild;
                if (p) {
                    const tile = document.createElement('button');
                    tile.className = "study-word-tile";
                    tile.innerText = p.dataset.word;
                    tile.dataset.word = p.dataset.word;
                    bank.appendChild(tile);
                    p.remove();
                }
            });
        }, 5000);
    }
}


// --- ROUND E: Sentence Matching ---
function startRoundF() {
    STUDY_STATE.round = 'F';
    STUDY_STATE.subRound = 1; // Initialize sub-round counter
    startExerciseTracking();
    nextRoundFSubRound();
}

function nextRoundFSubRound() {
    if (STUDY_STATE.subRound > 3) {
        finishStudySession();
        return;
    }

    updateStudyUI(`Round E${STUDY_STATE.subRound}: Sentence Matching`, "Match each question with its answer.");

    // Get sentence pairs using SR-aware same-page selection, excluding pairs
    // already shown in an earlier Round F sub-round this session.
    const { book, unit, page } = selectedClassContent;

    // E1 favors today's page; E2/E3 review previous pages when only new material
    // is available (due items still take precedence from any page).
    const preferPrevious = STUDY_STATE.subRound > 1;
    const result = getStudySentencePairsSubRoundSR(book, unit, page, srUsedPairKeys, preferPrevious);
    let pairs = [];

    if (result && result.pairs && result.pairs.length > 0) {
        pairs = result.pairs;
    } else {
        // COOLDOWN FALLBACK (2026-09-08, "Doris all-cooldown"): every pair up
        // to this page is on SR cooldown. Practice beats a dead session — the
        // engine now floors with the least-overdue cooldown pairs, so a null
        // here means TRULY no pairs exist (not merely all-cooldown). Only then
        // end Round F cleanly.
        // No unseen pairs left anywhere up to the current page (rare: a first page
        // with only 3 pairs). Don't repeat already-seen pairs — end Round F cleanly.
        STUDY_STATE.subRound = 4;
        finishStudySession();
        return;
    }

    // Record which pairs we're about to show so later sub-rounds pull FRESH pairs.
    pairs.forEach(p => srUsedPairKeys.add(itemKey(p)));

    STUDY_STATE.sentencePairs = pairs;
    STUDY_STATE.pairAttempts = pairs.map(() => 1);
    STUDY_STATE.pairQueued = pairs.map(() => false);
    renderRoundF();
}

function renderRoundF() {
    const pairs = STUDY_STATE.sentencePairs;

    // Create shuffled array of B sentences for the dock
    const bSentences = pairs.map((p, i) => ({ text: p.b, correctIndex: i }));
    bSentences.sort(() => 0.5 - Math.random());

    const container = document.getElementById('study-game-area');
    container.innerHTML = `
        <div class="flex flex-col gap-3 w-full max-w-3xl mx-auto px-2">
            <div id="match-pairs-container" class="flex flex-col gap-2">
                ${pairs.map((pair, index) => `
                    <div class="match-pair-row flex flex-col sm:flex-row gap-2 items-stretch">
                        <div class="sentence-a flex-1 bg-indigo-900/60 p-3 rounded-lg text-white font-medium text-sm sm:text-base" data-index="${index}">
                            ${pair.a}
                        </div>
                        <div class="sentence-b-slot flex-1 bg-gray-700/50 p-3 rounded-lg min-h-[48px] border-2 border-dashed border-gray-500 flex items-center justify-center cursor-pointer" 
                             data-target-index="${index}" 
                             onclick="handleSlotClick(${index})">
                            <span class="text-gray-400 text-sm">Tap to place</span>
                        </div>
                    </div>
                `).join('')}
            </div>
            
            <div id="sentence-b-dock" class="bg-gray-800/50 p-3 rounded-xl flex flex-wrap gap-2 justify-center min-h-[60px]">
                ${bSentences.map(item => `
                    <button class="sentence-b-tile bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer min-h-[44px]"
                            data-correct-index="${item.correctIndex}"
                            onclick="selectBTile(this)">
                        ${item.text}
                    </button>
                `).join('')}
            </div>
            
            <div class="flex justify-center gap-3">
                <button onclick="checkRoundF()" class="game-btn bg-green-500 py-3 px-8">CHECK</button>
            </div>
        </div>
    `;
}

let selectedBTile = null;

function selectBTile(tile) {
    if (STUDY_STATE.isTransitioning) return;
    // Clear previous selection
    document.querySelectorAll('.sentence-b-tile').forEach(t => t.classList.remove('ring-4', 'ring-yellow-400'));

    // Select this tile
    selectedBTile = tile;
    tile.classList.add('ring-4', 'ring-yellow-400');
}

function handleSlotClick(slotIndex) {
    if (STUDY_STATE.isTransitioning) return;
    const slot = document.querySelector(`.sentence-b-slot[data-target-index="${slotIndex}"]`);

    // If clicking a slot that already has a tile, return it to dock
    const existingTile = slot.querySelector('.sentence-b-tile');
    if (existingTile) {
        returnTileToDock(existingTile);
        slot.innerHTML = '<span class="text-gray-400 text-sm">Tap to place</span>';
        return;
    }

    // If a tile is selected, place it in this slot
    if (selectedBTile) {
        slot.innerHTML = '';
        slot.appendChild(selectedBTile);
        selectedBTile.classList.remove('ring-4', 'ring-yellow-400');
        selectedBTile = null;
    }
}

function returnTileToDock(tile) {
    const dock = document.getElementById('sentence-b-dock');
    tile.classList.remove('ring-4', 'ring-yellow-400', 'correct-match', 'wrong-match');
    tile.style.backgroundColor = '';
    dock.appendChild(tile);
}

function checkRoundF() {
    if (STUDY_STATE.isTransitioning) return;
    const pairs = STUDY_STATE.sentencePairs;
    const slots = document.querySelectorAll('.sentence-b-slot');
    let allCorrect = true;
    let anyPlaced = false;

    slots.forEach((slot, index) => {
        const tile = slot.querySelector('.sentence-b-tile');

        if (tile) {
            anyPlaced = true;
            const targetIndex = parseInt(slot.dataset.targetIndex);

            // CHECK HARDENING (2026-09-08, "Doris stuck CHECK"): tile text is
            // interpolated into HTML with surrounding whitespace/newlines, so a
            // visually-correct placement can carry invisible characters and fail
            // strict equality FOREVER (20+ min stuck, no error shown). Compare
            // on whitespace-collapsed text instead.
            const placedText = normMatchText(tile.innerText);
            const expectedText = normMatchText(pairs[targetIndex].b);

            if (placedText === expectedText) {
                // Correct match
                tile.classList.remove('wrong-match');
                tile.classList.add('correct-match');
                tile.style.backgroundColor = '#10b981'; // green
                
                // Record analytics for this pair if not already recorded
                if (!STUDY_STATE.pairQueued[targetIndex]) {
                    const itemDetails = `A: ${pairs[targetIndex].a} | B: ${pairs[targetIndex].b}`;
                    // SR: first attempt = pairAttempts still at 1
                    srStudyResults.push({ type: 'sentencePairs', key: itemKey(pairs[targetIndex]), firstAttempt: STUDY_STATE.pairAttempts[targetIndex] === 1 });
                    queueExerciseEvent('sentenceMatch', 'study', itemDetails, STUDY_STATE.pairAttempts[targetIndex]);
                    STUDY_STATE.pairQueued[targetIndex] = true;
                }
            } else {
                // Incorrect match
                tile.classList.remove('correct-match');
                tile.classList.add('wrong-match');
                tile.style.backgroundColor = '#ef4444'; // red
                allCorrect = false;
                // Record SR failure at the FIRST wrong check for this pair
                // (parity with game mode; collapse keeps it over a later success).
                if (STUDY_STATE.pairAttempts[targetIndex] === 1 && !STUDY_STATE.pairQueued[targetIndex]) {
                    srStudyResults.push({ type: 'sentencePairs', key: itemKey(pairs[targetIndex]), firstAttempt: false });
                }
            }
        } else {
            allCorrect = false;
        }
    });

    if (!anyPlaced) {
        // No tiles placed, do nothing
        return;
    }

    if (allCorrect) {
        STUDY_STATE.isTransitioning = true;
        playHappySound();
        // Note: The individual pairs were already queued during the check above.
        setTimeout(() => {
            STUDY_STATE.subRound++;
            startExerciseTracking();
            STUDY_STATE.isTransitioning = false;
            nextRoundFSubRound();
        }, 1500);
    } else {
        STUDY_STATE.isTransitioning = true;
        synthError();
        incrementExerciseAttempts();
        
        // Increment attempts for any pairs that have not yet been successfully matched
        for (let i = 0; i < pairs.length; i++) {
            if (!STUDY_STATE.pairQueued[i]) {
                STUDY_STATE.pairAttempts[i]++;
            }
        }

        // Reset after 2 seconds
        setTimeout(() => {
            resetRoundF();
            STUDY_STATE.isTransitioning = false;
        }, 2000);
    }
}

function resetRoundF() {
    // Return all tiles to dock
    const tiles = document.querySelectorAll('.sentence-b-tile');
    tiles.forEach(tile => {
        returnTileToDock(tile);
    });

    // Reset all slots
    const slots = document.querySelectorAll('.sentence-b-slot');
    slots.forEach(slot => {
        slot.innerHTML = '<span class="text-gray-400 text-sm">Tap to place</span>';
    });

    selectedBTile = null;
}


async function finishStudySession() {
    const durationMs = Date.now() - STUDY_STATE.startTime;
    const durationSec = Math.floor(durationMs / 1000);
    const mm = Math.floor(durationSec / 60);
    const ss = durationSec % 60;
    const timeStr = `${mm}m ${ss}s`;

    const player = selectedStudent || "Student";

    // Track session completion
    // Finalize SR state for this session before flushing
    STUDY_STATE.srFinalized = true;
    finalizeSession(srStudyResults);

    queueSessionEvent('study', {
        durationMs: durationMs,
        durationFormatted: timeStr
    });
    // FIX (2026-08-25, "Doris refresh"): AWAIT the delivery of the session
    // record + SR state BEFORE showing the completion screen. On iPad/iOS the
    // page process can restart within ~1s of completion (WeChat/Safari WebKit
    // recycle, or the student switching away to send the result screenshot),
    // and a fire-and-forget flush loses the session. The deadline keeps the
    // UI responsive even on a bad network (worst case the events stay in the
    // persisted queue for the next-login drain).
    if (typeof flushAnalyticsWithDeadline === 'function') await flushAnalyticsWithDeadline(4000);
    else flushAnalyticsOnGameOver(); // Reliable flush with retry on session end

    const targetText = typeof getActiveTargetText === 'function' ? getActiveTargetText() : null;
    const messageHtml = targetText 
        ? `<div class="mb-8 py-3 px-6 bg-indigo-900/50 border border-indigo-400/50 rounded-xl inline-block"><p class="study-text-xl text-indigo-200 font-bold tracking-wide">${targetText}</p></div>`
        : `<p class="study-text-xl text-yellow-400 mb-8 font-bold">记得发图片在群里给Val看看！!</p>`;

    const container = document.getElementById('study-game-area');
    container.innerHTML = `
        <div class="text-center px-4 w-full max-w-md mx-auto">
            <div class="text-6xl mb-4">🎉</div>
            <h2 class="study-text-2xl text-green-400 font-bold mb-3">Great job ${player}!</h2>
            <p class="study-text-lg text-white mb-2">You completed this session in <span class="text-yellow-400 font-bold">${timeStr}</span></p>
            ${messageHtml}
            
            <div class="flex flex-col gap-3 items-center w-full">
                <button onclick="initStudyMode()" class="game-btn bg-blue-600 text-lg sm:text-xl w-full">再学习一下</button>
                <button onclick="showGameSelection()" class="game-btn bg-orange-500 text-lg sm:text-xl w-full">边玩边学</button>
            </div>
        </div>
    `;
    updateStudyUI("Session Complete", "");
}

function exitStudyMode() {
    // Abandoning mid-session must not lose observed results (failures are
    // recorded at the first wrong check). Partial sessions don't advance the
    // session counter; the completed case is handled by finishStudySession.
    if (STUDY_STATE.active && !STUDY_STATE.srFinalized && srStudyResults.length > 0) {
        finalizeSession(srStudyResults, false);
        srStudyResults = [];
    }
    STUDY_STATE.active = false; // so the game-mode keydown listener resumes
    // The trace box registers window resize/orientation listeners, so tear it
    // down here or they accumulate across study sessions.
    if (roundDTrace) { roundDTrace.destroy(); roundDTrace = null; }
    document.getElementById('studyModeOverlay').classList.add('hidden');
    goBackFromGameSelection(); // back to the main dashboard (also shows startScreen)
}


// --- Helper UI ---
const STUDY_ROUNDS = ['A', 'C', 'D', 'E', 'F'];
const STUDY_ROUND_LABELS = { A: 'Listen', C: 'Scramble', D: 'Write', E: 'Sentence', F: 'Match' };

function updateStudyUI(title, subtitle) {
    document.getElementById('study-title').innerText = title;
    document.getElementById('study-instruction').innerText = subtitle;
    // Restart telemetry (2026-08-26a): keep the kill-surviving breadcrumb
    // current so a WebKit process restart can be correlated with the round
    // the student was on. Best-effort, no-op if unavailable.
    if (typeof csPageHeartbeat === 'function') csPageHeartbeat({ mode: 'study', round: STUDY_STATE.round });
    updateStudyProgress();
}

function updateStudyProgress() {
    const currentRound = STUDY_STATE.round;
    const currentIdx = STUDY_ROUNDS.indexOf(currentRound);
    let bar = document.getElementById('study-progress-indicator');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'study-progress-indicator';
        bar.className = 'w-full flex items-center justify-center gap-1 mb-2 px-4';
        const titleEl = document.getElementById('study-title');
        if (titleEl && titleEl.parentElement) {
            titleEl.parentElement.insertBefore(bar, titleEl);
        }
    }
    bar.innerHTML = STUDY_ROUNDS.map((r, i) => {
        const isActive = i === currentIdx;
        const isDone = i < currentIdx;
        const label = STUDY_ROUND_LABELS[r] || r;
        let classes = 'flex-1 h-2 rounded-full transition-all duration-300';
        if (isDone) classes += ' bg-green-400';
        else if (isActive) classes += ' bg-yellow-400 animate-pulse';
        else classes += ' bg-gray-600';
        return `<div class="${classes}" title="${label}"></div>`;
    }).join('');
}

function playHappySound() {
    initAudio(); // Ensure audio context is ready
    if (typeof synthLevelUp === 'function') {
        synthLevelUp();
    }
}

// --- KEYBOARD SUPPORT ---
window.addEventListener('keydown', (e) => {
    if (!STUDY_STATE.active) return;

    if (STUDY_STATE.round === 'C') {
        handleRoundCKeyDown(e.key);
    } else if (STUDY_STATE.round === 'D') {
        handleRoundDKeyDown(e.key);
    }
});

function handleRoundCKeyDown(key) {
    if (key === 'Backspace') {
        const slots = roundCSlots();
        // Find last filled letter-slot and remove it.
        for (let i = slots.length - 1; i >= 0; i--) {
            if (slots[i].innerText && slots[i].dataset.fixed !== "true") {
                removeLetterFromSlot(i, currentTTSWord);
                break;
            }
        }
    } else if (key.length === 1 && key.match(/[a-z0-9]/i)) {
        const bank = document.getElementById('scramble-bank').children;
        for (let btn of bank) {
            if (btn.innerText.toLowerCase() === key.toLowerCase() && btn.style.visibility !== 'hidden') {
                addLetterToSlot(btn.innerText, btn, currentTTSWord);
                break;
            }
        }
    } else if (key === 'Enter') {
        checkRoundC();
    }
}

// Desktop convenience: Backspace wipes the current letter's strokes.
function handleRoundDKeyDown(key) {
    if (key === 'Backspace') clearRoundD();
}

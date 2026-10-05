// hw_dev_entry.js — TEST HARNESS ONLY. Lives in the Classroom-survivors-handwriting
// repo so the handwriting round can be tried without playing Rounds A and B.
//
// Inert unless the URL carries ?hw= :
//   index.html?hw=                  default word list
//   index.html?hw=cat,happy%20face  your own comma-separated list
//
// The tag for this file exists ONLY in that repo's index.html. If this file ever
// reaches preview or production, the ?hw= gate keeps it inert — but the tag
// should still be removed before merging the feature for real.
(function () {
    if (typeof location === 'undefined' || typeof URLSearchParams === 'undefined') return;
    var params = new URLSearchParams(location.search);
    if (!params.has('hw')) return;

    var words = (params.get('hw') || 'cat, swim, happy, swimming pool, angry - angrier than')
        .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

    // Live strictness knobs, so thresholds can be tuned against real handwriting
    // without a redeploy: ?prec=0.6&recall=0.8&miss=0.1 (free stage) and
    // ?gprec=&grecall= (outline stage). The panel shows the current bars.
    var freeBars = HW_PROFILE.free, guidedBars = HW_PROFILE.guided;
    if (params.get('prec')) freeBars.precision = +params.get('prec');
    if (params.get('recall')) freeBars.recall = +params.get('recall');
    if (params.get('miss')) freeBars.maxMissing = +params.get('miss');
    if (params.get('gprec')) guidedBars.precision = +params.get('gprec');
    if (params.get('grecall')) guidedBars.recall = +params.get('grecall');

    function panel(list) {
        var old = document.getElementById('hw-dev-panel');
        if (old) old.remove();
        var box = document.createElement('div');
        box.id = 'hw-dev-panel';
        box.style.cssText = 'position:fixed;bottom:64px;left:8px;z-index:9999;background:#111827ee;' +
            'color:#e5e7eb;border:1px solid #4b5563;border-radius:10px;padding:8px 10px;' +
            'font:12px/1.5 sans-serif;display:flex;gap:6px;align-items:center;max-width:92vw;flex-wrap:wrap';
        var input = document.createElement('input');
        input.id = 'hw-dev-word';
        input.type = 'text';
        input.value = list.join(', ');
        input.style.cssText = 'width:220px;max-width:60vw;background:#1f2937;color:#f9fafb;' +
            'border:1px solid #6b7280;border-radius:6px;padding:4px 6px;font:12px sans-serif';
        var btn = document.createElement('button');
        btn.textContent = 'Load word(s)';
        btn.style.cssText = 'background:#f59e0b;color:#111827;border:none;border-radius:6px;' +
            'padding:5px 10px;font:700 12px sans-serif;cursor:pointer';
        var hint = document.createElement('span');
        hint.textContent = 'restarts the round with what you typed';
        hint.style.cssText = 'color:#9ca3af';
        var readout = document.createElement('span');
        readout.id = 'hw-dev-last';
        readout.style.cssText = 'width:100%;color:#93c5fd';
        box.appendChild(input); box.appendChild(btn); box.appendChild(hint); box.appendChild(readout);
        document.body.appendChild(box);
        btn.onclick = function () {
            var next = input.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
            if (next.length) launch(next);
        };
        setInterval(function () {
            var l = window.__hwLast;
            if (!l) {
                readout.textContent = 'bars: cover>=' + freeBars.precision + ' fill>=' + freeBars.recall +
                    ' missing<=' + freeBars.maxMissing + '  |  write a letter to see its scores';
                return;
            }
            readout.textContent = 'target "' + l.target + '"' + (l.guided ? ' (outline)' : '') + ' -> ' +
                (l.accepted ? 'ACCEPTED' : (l.judged ? 'REJECTED' : 'not a letter yet')) +
                ' | cover ' + l.precision + ' fill ' + l.recall + ' missing ' + l.missing +
                ' | strokes ' + l.strokes + '/' + l.minStrokes + ' width ' + l.width + ' height ' + l.height +
                (l.overfilled ? ' OVERFILLED' : '') +
                ' | bars: cover>=' + l.bars.precision + ' fill>=' + l.bars.recall + ' missing<=' + l.bars.maxMissing;
        }, 250);
    }

    function launch(list) {
        var ss = document.getElementById('startScreen');
        if (ss) ss.classList.add('hidden');
        var steps = document.querySelectorAll('.step-container');
        for (var i = 0; i < steps.length; i++) steps[i].classList.add('hidden');
        var gso = document.getElementById('gameSelectionOverlay');
        if (gso) gso.classList.add('hidden');
        var ov = document.getElementById('studyModeOverlay');
        if (ov) ov.classList.remove('hidden');
        STUDY_STATE.active = true;
        STUDY_STATE.words = list.slice();
        STUDY_STATE.currentWordIndex = 0;
        STUDY_STATE.isTransitioning = false;
        startRoundD();
        panel(list);
    }

    function ready() {
        // Let the page's own boot finish first, so we hide the overlays it showed.
        setTimeout(function () { launch(words); }, 900);
    }
    if (document.readyState === 'complete') ready();
    else window.addEventListener('load', ready);
})();

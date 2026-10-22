/* Optional local QuickTime bridge. Explicit window sharing; no game log. */
(function () {
  'use strict';

  // Compare a low-resolution game region, tolerating a tiny moving cursor.
  // Keep an anchor rather than the preceding frame so slow changes accumulate.
  // A screen that never stands still (an animated popup) is read anyway once
  // it has been changing for longest: restless says so.
  class FrameGate {
    constructor(wait, longest) { this.wait = wait || 900; this.longest = longest || 3000; this.version = 0; this.anchor = null; this.since = 0; this.moving = null; this.accepted = -1; }
    update(pixels, now) {
      let changed = !this.anchor || this.anchor.length !== pixels.length;
      if (!changed) {
        let large = 0;
        for (let i = 0; i < pixels.length; i++) if (Math.abs(pixels[i] - this.anchor[i]) > 24) large++;
        changed = large / pixels.length > 0.006;
      }
      if (changed) { this.anchor = pixels.slice(); this.since = now; this.version++; if (this.moving == null) this.moving = now; }
      const settled = now - this.since >= this.wait;
      const restless = !settled && this.moving != null && now - this.moving >= this.longest;
      return { changed, version: this.version, ready: (settled || restless) && this.accepted !== this.version, restless };
    }
    accept() { this.accepted = this.version; this.moving = null; }
  }
  // A deadline changes the UI, never releases a still-mutating analyzer.
  // Its result is discarded after timeout; another stage waits for the drain.
  class RecognitionLane {
    constructor(schedule, cancel) {
      this.schedule = schedule || ((...args) => setTimeout(...args));
      this.cancel = cancel || ((...args) => clearTimeout(...args));
      this.busy = false; this.generation = 0;
    }
    async run(operation, milliseconds, onTimeout) {
      if (this.busy) throw new Error('The reader is still busy with the previous frame');
      this.busy = true;
      const generation = ++this.generation;
      let expired = false;
      const alarm = this.schedule(() => {
        if (!this.busy || this.generation !== generation) return;
        expired = true; onTimeout();
      }, milliseconds);
      try {
        const value = await operation();
        return expired ? { expired: true } : { expired: false, value };
      } finally {
        this.cancel(alarm);
        if (this.generation === generation) { this.busy = false; this.generation++; }
      }
    }
  }
  function boardReadiness(read, state) {
    if (!read || !read.ok || !state) return 'Screen not recognized.';
    if (!state.controls && !read.statusView) return 'The action buttons were not read. Close any menu and check the game is in English.';
    if (!state.daysRead) return 'Days until the Riot were not read: check the board below.';
    if (!state.wardenRead) return 'The warden’s cell was not read: check the board below.';
    if (read.statusView && state.giftPicksUncertain) return 'Opulence: the picks left can’t be read. Stop the capture and set Picks Left by hand.';
    if (state.step === 'event') return 'An event: check its kind and terms below.';
    if (state.toolsToConfirm) return 'Confirm your instruments below: check the list and press These are right, then Recheck.';
    if (state.checks || (state.checks == null && read.unsure)) return 'Some cells were read with doubt. Fix the board below and press Recheck.';
    return '';
  }
  // A Treasure without View Prison Status: guess the gift on the last board
  // read, once per Treasure. Opulence's later picks change the board, so
  // they still need the eye view. after: what led to the Treasure.
  function treasurePlan(s) {
    if (!s || !s.boardSeen || s.guessed) return { use: false };
    const t = s.lastAction;
    return { use: true, after: t === 'swap' ? 'swap' : (t === 'devour' || t === 'chain' || t === 'stopchain') ? 'consume' : undefined };
  }
  // The picture inside the black bars around it: AirPlay on the whole Mac
  // screen shows the iPad's 4:3 in the middle of a wider one. lum: grey
  // levels of a small copy of the frame (w by h). The bars are centred, so a
  // side's margin is the smaller of the two; a measure that doesn't look like
  // an iPad (a dark scene, another window) gives the whole frame (null).
  function contentRect(lum, w, h) {
    const bar = Math.max(lum[0] || 0, lum[w - 1] || 0, lum[(h - 1) * w] || 0, lum[h * w - 1] || 0);
    const lit = (v) => (v || 0) > bar + 12;
    let left = w, right = -1, top = h, bottom = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!lit(lum[y * w + x])) continue;
      if (x < left) left = x; if (x > right) right = x;
      if (y < top) top = y; if (y > bottom) bottom = y;
    }
    if (right < 0) return null;
    const mx = Math.min(left, w - 1 - right), my = Math.min(top, h - 1 - bottom);
    if (mx <= 1 && my <= 1) return null;
    const rect = { x: mx / w, y: my / h, w: (w - 2 * mx) / w, h: (h - 2 * my) / h };
    return rect.w * rect.h >= 0.3 ? rect : null;
  }
  // A session's record for the local site (tools/serve.js, ?record=1): one
  // line an event, posted one after another in the order they happened. A
  // run is named by its start. data may be a promise (a picture still being
  // encoded): its line keeps its place. A failure is reported once until a
  // line is written again, and never stops the capture.
  class Recorder {
    constructor(o = {}) {
      this.post = o.post; this.now = o.now || (() => Date.now()); this.onError = o.onError || (() => {});
      this.run = ''; this.seq = 0; this.failed = false; this.tail = Promise.resolve();
    }
    start(data) {
      this.run = new Date(this.now()).toISOString().replace(/[:.]/g, '-').slice(0, 23); this.seq = 0;
      return this.event('connect', data);
    }
    event(type, data) {
      if (!this.run) return Promise.resolve();
      const head = { run: this.run, seq: ++this.seq, at: new Date(this.now()).toISOString(), type };
      this.tail = this.tail.then(async () => {
        try {
          await this.post(Object.assign(head, await data));
          this.failed = false;
        } catch (e) {
          if (!this.failed) { this.failed = true; this.onError(`Record not written: ${e.message || e}`); }
        }
      });
      return this.tail;
    }
  }
  function endText(state) { return state && state.chain ? 'Cancel the consume, then End the day.' : 'Press End.'; }
  window.TartarusQuickTime = { FrameGate, RecognitionLane, Recorder, boardReadiness, contentRect, endText, treasurePlan };
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return;
  const params = new URLSearchParams(location.search);
  const A = window.TartarusAnalyzer;
  const scan = document.getElementById('az-scan');
  // A window share needs a desktop Chromium (Chrome, Edge and the like):
  // Safari and Firefox have getDisplayMedia, but can't pick the QuickTime window.
  const chromium = !!(navigator.userAgentData && (navigator.userAgentData.brands || []).some((b) => /Chromium/.test(b.brand)));
  if (!A || !scan || !chromium || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return;
  const T = window.Tartarus;
  // Tabs on the screenshot panel: the author's screenshot reader, or the
  // iPad's live screen through QuickTime. The advice stays in the board.
  const tabs = document.createElement('div');
  tabs.className = 'qt-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Where to read the game from');
  tabs.innerHTML = `<button type="button" role="tab" id="qt-tab-shot" aria-controls="qt-pane-shot">Screenshot</button><button type="button" role="tab" id="qt-tab-ipad" aria-controls="qt-pane-ipad"><span class="qt-dot" aria-hidden="true"></span>iPad · live</button>`;
  const shotPane = document.createElement('div');
  shotPane.id = 'qt-pane-shot'; shotPane.setAttribute('role', 'tabpanel'); shotPane.setAttribute('aria-labelledby', 'qt-tab-shot');
  while (scan.firstChild) shotPane.appendChild(scan.firstChild);
  const panel = document.createElement('div');
  panel.id = 'qt-pane-ipad'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'qt-tab-ipad');
  panel.innerHTML = `<div class="qt-preview" id="qt-preview"><p class="qt-empty" id="qt-empty">The iPad’s screen shows here</p><span class="qt-live" id="qt-live" hidden>Live</span><span class="qt-frame" id="qt-frame" hidden></span></div>
    <div class="qt-side">
      <h2 class="az-h2">iPad: QuickTime or AirPlay</h2>
      <p class="az-scan-lede"><strong>By cable:</strong> open <strong>New Movie Recording</strong> in QuickTime with the iPad as its camera, press Connect and pick the <strong>Movie Recording</strong> window. <strong>Over Wi‑Fi:</strong> on the iPad, Control Centre → Screen Mirroring → this Mac, press Connect and pick the <strong>Entire Screen</strong> the iPad shows on. Play in English. The board is read by itself once the picture settles.</p>
      <div class="qt-buttons"><button type="button" class="btn btn-primary" id="qt-start">Connect</button><label class="btn qt-voice" title="Say each move out loud, so your eyes can stay on the iPad"><input type="checkbox" id="qt-speak"><span class="qt-voice-icon" aria-hidden="true"></span>Voice</label><button type="button" class="btn" id="qt-stop" disabled>Stop</button><button type="button" class="btn" id="qt-rescan" disabled>Read again</button><button type="button" class="btn" id="qt-reload" hidden>Restart the helper</button></div>
      <p class="az-scan-status" id="qt-status" role="status">No window connected yet.</p>
      <p class="qt-advice" id="qt-advice" aria-live="polite"></p>
      <label class="qt-check"><input type="checkbox" id="qt-fresh" checked> The next instrument offer starts a new run</label>
      <details class="qt-help"><summary>If the reading went wrong</summary><p>Enlarge the QuickTime window, move its recording controls away and wait for animations to end. The Screenshot tab takes a picture instead, and the board below can be fixed: cells, instruments and objective. Don’t follow advice on a misread board. For exact Warden’s Treasure advice, open View Prison Status (the eye).</p></details>
    </div>`;
  scan.prepend(tabs);
  scan.append(shotPane, panel);
  scan.classList.add('qt-tabbed');
  function selectTab(which) {
    const ipad = which === 'ipad';
    document.getElementById('qt-tab-shot').setAttribute('aria-selected', String(!ipad));
    document.getElementById('qt-tab-ipad').setAttribute('aria-selected', String(ipad));
    shotPane.hidden = ipad; panel.hidden = !ipad;
    try { localStorage.setItem('qt-tab', which); } catch (e) { /* private mode */ }
  }
  tabs.addEventListener('click', (event) => { const b = event.target.closest('[role=tab]'); if (b) selectTab(b.id === 'qt-tab-ipad' ? 'ipad' : 'shot'); });
  let savedTab = null;
  try { savedTab = localStorage.getItem('qt-tab'); } catch (e) { /* private mode */ }
  selectTab(params.get('quicktime') === '1' || savedTab === 'ipad' ? 'ipad' : 'shot');
  const $ = (id) => document.getElementById(id);
  const recording = params.get('record') === '1' && ['localhost', '127.0.0.1'].includes(location.hostname);
  const recorder = recording ? new Recorder({
    post: async (entry) => {
      const r = await fetch('/__record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
      if (!r.ok) throw new Error(`the local site answered ${r.status}`);
    },
    onError: (m) => { $('qt-status').textContent = m; },
  }) : null;
  const record = (type, data) => { if (recorder) recorder.event(type, data); };
  // The picture of a read, encoded off the main thread where the browser can;
  // a picture that can't be encoded is recorded without one.
  const pictureOf = (canvas) => new Promise((resolve) => {
    const failed = (e) => resolve({ pictureError: String(e && e.message || e) });
    try {
      if (!canvas.toBlob || typeof FileReader === 'undefined') { resolve({ png: canvas.toDataURL('image/png') }); return; }
      canvas.toBlob((blob) => {
        if (!blob) { failed('no picture'); return; }
        const reader = new FileReader();
        reader.onload = () => resolve({ png: reader.result });
        reader.onerror = () => failed(reader.error);
        reader.readAsDataURL(blob);
      }, 'image/png');
    } catch (e) { failed(e); }
  });
  const status = (s) => { if (s && s !== $('qt-status').textContent) record('status', { text: s }); $('qt-status').textContent = s; };
  const advice = (s) => { if (s && s !== $('qt-advice').textContent) record('advice', { text: s }); $('qt-advice').textContent = s; };
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  video.className = 'qt-video'; video.hidden = true;
  $('qt-preview').prepend(video);
  // The preview's corner label: what the reader is doing with this frame.
  const frame = (s) => { $('qt-frame').textContent = s || ''; $('qt-frame').hidden = !s; };
  const sample = document.createElement('canvas'); sample.width = 144; sample.height = 100;
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
  const capture = document.createElement('canvas');
  // The iPad's picture inside the frame (fractions), measured every 2 s.
  const probe = document.createElement('canvas'); probe.width = 160; probe.height = 100;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  let view = { x: 0, y: 0, w: 1, h: 1 }, measured = 0, surface = 'window';
  const pixels = new Uint8Array(sample.width * sample.height);
  function measureView() {
    probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
    const data = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
    const lum = new Uint8Array(probe.width * probe.height);
    for (let i = 0; i < lum.length; i++) lum[i] = ((data[i * 4] || 0) + (data[i * 4 + 1] || 0) + (data[i * 4 + 2] || 0)) / 3;
    view = contentRect(lum, probe.width, probe.height) || { x: 0, y: 0, w: 1, h: 1 };
  }
  // adviceId counts the boards and Treasures: each is said once per text.
  let adviceId = 0;
  function announce(text) { say(text, `${adviceId}|${text}`); }
  // Spoken advice: each new move once, without its prefix.
  let spoken = '';
  function say(text, key) {
    if (!text || key === spoken || !$('qt-speak') || !$('qt-speak').checked || typeof speechSynthesis === 'undefined') return;
    spoken = key;
    // "cell 04" is shown padded but said "cell 4", not "zero four".
    // Chrome can drop an utterance spoken right after a cancel: cancel only a running one.
    try { if (speechSynthesis.speaking) speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text.replace(/\bcell 0(\d)\b/g, 'cell $1')); u.lang = 'en-US'; speechSynthesis.speak(u); } catch (e) { /* no voice */ }
  }
  let savedSpeak = null;
  try { savedSpeak = localStorage.getItem('qt-speak'); } catch (e) { /* private mode */ }
  if ($('qt-speak')) {
    // On unless turned off: the voice lets the player keep their eyes on the iPad.
    $('qt-speak').checked = savedSpeak !== '0';
    $('qt-speak').addEventListener('change', (e) => { try { localStorage.setItem('qt-speak', e.target.checked ? '1' : '0'); } catch (err) { /* private mode */ } });
  }
  let gate = new FrameGate();
  let stream = null, timer = null, busy = false, session = 0, adviceVersion = -1, advicePoll = null, lastSignature = '';
  let activeRead = null;
  // Treasure guess: a board read since the last Treasure, the last move advised.
  // treasureOpen: a Treasure (or the eye view behind it) seen since the last
  // board with the Treasure closed.
  let boardSeen = false, treasureGuessed = false, lastAction = null, provisional = false, treasureOpen = false;
  const lane = new RecognitionLane();
  function clearAdvice() { document.documentElement.classList.add('qt-stale'); adviceVersion = -1; clearInterval(advicePoll); advicePoll = null; advice(''); frame('Screen changing…'); }
  function stop() {
    if (stream) record('stop', {});
    session++;
    document.documentElement.classList.remove('qt-capturing', 'qt-stale');
    if (timer && timer.terminate) timer.terminate(); else clearInterval(timer);
    timer = null; clearInterval(advicePoll); advicePoll = null;
    try { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); } catch (e) { /* no voice */ } spoken = '';
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null; video.srcObject = null;
    boardSeen = false; treasureGuessed = false; lastAction = null; provisional = false; treasureOpen = false;
    $('qt-start').disabled = false; $('qt-stop').disabled = true; $('qt-rescan').disabled = true;
    $('qt-reload').hidden = !lane.busy;
    video.hidden = true; $('qt-empty').hidden = false; $('qt-live').hidden = true; frame('');
    adviceVersion = -1; advice(''); status('Capture stopped.');
  }
  function moveText(rec) {
    if (!rec || !rec.action) return '';
    const a = rec.action;
    const cell = (n) => Number(n) === T.OFFICE ? 'the office' : `cell ${String(Number(n) + 1).padStart(2, '0')}`;
    switch (a.type) {
      case 'patrol': return `Go to ${cell(a.cell)}.`;
      case 'devour': case 'chain': return `Consume the inmate in ${cell(a.to)}.`;
      case 'swap': return 'Press Replace.';
      case 'end': return endText(A.quickTimeState && A.quickTimeState());
      case 'stopchain': return 'Press Cancel to stop the chain.';
      case 'office': return a.choice === 'bestow' ? 'Choose Bestow.' : a.choice === 'instigate' ? 'Choose Instigate.' : `Office: ${a.choice}.`;
      case 'event': return a.accept ? 'Accept the event.' : 'Skip the event.';
      case 'choose': return `Take ${T.TOOLS && T.TOOLS[a.id] ? T.TOOLS[a.id].name : T.GIFTS && T.GIFTS[a.id] ? T.GIFTS[a.id].name : a.id}.`;
      case 'reroll': return 'Re-roll the instrument offer.';
      case 'hunt': return `Mark the prey in ${cell(a.to)}.`;
      default: return '';
    }
  }
  // version null: advice for whatever frame is shown (a restless screen).
  function showRecommendation(version, mine) {
    clearInterval(advicePoll);
    const show = () => {
      if (!stream || session !== mine || (version != null && gate.version !== version)) return;
      const state = A.quickTimeState && A.quickTimeState();
      if (activeRead && boardReadiness(activeRead, state)) {
        document.documentElement.classList.add('qt-stale');
        adviceVersion = -1;
        advice('Advice hidden: check the board and press Recheck.');
        return;
      }
      const full = A.recommendation();
      const rec = full || (A.quickRecommendation && A.quickRecommendation());
      const text = moveText(rec);
      if (text) {
        document.documentElement.classList.remove('qt-stale');
        if (provisional) { advice(`Provisional: ${text} For exact advice, open View Prison Status.`); announce(text); }
        else {
          advice(`${full ? 'Advice' : 'Quick advice'}: ${text}`);
          if (full) announce(text);
          if (rec.action.type !== 'choose') lastAction = rec.action.type;
          // A Recheck after a fix clears the problem the last read reported.
          if (activeRead && adviceVersion !== version) status('Board read.');
        }
        adviceVersion = version; frame('');
      }
      else { document.documentElement.classList.add('qt-stale'); adviceVersion = -1; advice('Still working it out. If you fixed the board, press Recheck.'); }
    };
    show(); advicePoll = setInterval(show, 180);
  }
  // restless: the screen never stood still (an animated popup), so what is
  // read stays good while the frame keeps changing, and its advice too.
  async function recognize(version, mine, restless) {
    busy = true;
    provisional = false;
    frame('Reading…');
    status('Reading the screen…');
    let bitmap;
    const current = () => !!stream && session === mine && (restless || gate.version === version);
    // An overlay without the board (the Warden's Treasure, an instrument
    // offer) can be animated: the frame keeps changing while it is checked.
    // The picture checked is still the one taken, so its check runs to the end.
    const live = () => !!stream && session === mine;
    let expired = false;
    const stage = async (label, operation, milliseconds, still = current) => {
      if (!still()) return null;
      status(label);
      const outcome = await lane.run(operation, milliseconds, () => {
        expired = true;
        if (!stream || session !== mine) return;
        document.documentElement.classList.add('qt-stale');
        clearInterval(advicePoll); advicePoll = null;
        status('The reading is taking long. Waiting for the previous frame; no new check until it ends.');
        advice('If the Warden’s Treasure is open, press View Prison Status (the eye). If the reading doesn’t recover, restart the helper.');
        $('qt-reload').hidden = false;
      });
      if (outcome.expired) return null;
      return outcome.value;
    };
    try {
      // Only the iPad's picture, without the bars around it.
      const sx = video.videoWidth * view.x, sy = video.videoHeight * view.y, sw = video.videoWidth * view.w, sh = video.videoHeight * view.h;
      const scale = Math.min(1, 1400 / sw);
      capture.width = Math.round(sw * scale); capture.height = Math.round(sh * scale);
      capture.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, capture.width, capture.height);
      bitmap = await createImageBitmap(capture);
      if (recorder) {
        const info = { version, view, video: [video.videoWidth, video.videoHeight] };
        record('frame', pictureOf(capture).then((picture) => Object.assign(info, picture)));
      }
      const started = performance.now();
      const read = await stage('Reading the board and the action buttons…', () => A.readFrame(bitmap), 8000);
      if (recorder) {
        const seen = read && read.ok && A.quickTimeState ? A.quickTimeState() : null;
        record('reading', { version, ms: Math.round(performance.now() - started), expired: !read, ok: !!(read && read.ok), statusView: !!(read && read.statusView), readiness: read ? boardReadiness(read, seen) : '', signature: seen ? seen.signature || '' : '', summary: A.readingSummary ? A.readingSummary() : '' });
      }
      if (!current() || !read) return;
      if (read.ok) {
        activeRead = read;
        const seen = A.quickTimeState && A.quickTimeState();
        // Load an actionable read for correction, but never turn a modal or an
        // unknown action row into a patrol. Manual Recheck can recover advice.
        if (seen && (seen.controls || read.statusView)) {
          // The same screen read again (a cursor, a notification, the
          // recording toolbar): the board loaded from it stays as the player
          // fixed it. Only a new screen replaces it.
          const same = !!seen.signature && seen.signature === lastSignature && !!A.keepReading && A.keepReading();
          if (!same) {
            adviceId++;
            A.useReading();
            lastSignature = seen.signature || '';
            if (!read.statusView) lastAction = null;
          }
          if (read.statusView) { boardSeen = false; treasureOpen = true; } else { treasureOpen = false; if (!same) { boardSeen = true; treasureGuessed = false; } }
          const state = A.quickTimeState && A.quickTimeState();
          const problem = boardReadiness(read, state);
          if (problem) {
            status(problem); advice('Check the reading below: advice hidden.'); announce('Check the board on the Mac: the reading needs a fix.');
            showRecommendation(restless ? null : version, mine); return;
          }
          $('qt-fresh').checked = false;
          const gift = A.giftState && A.giftState();
          let asked;
          if (same && read.statusView && gift && gift.open && gift.seen) asked = true;
          else if (same && !read.statusView && A.quickRecommendation && A.quickRecommendation()) asked = true;
          else asked = read.statusView ? A.useTreasure('view') : A.ask();
          if (!asked) { status('Check the settings below and press Recheck.'); advice('Advice hidden until the board is checked.'); showRecommendation(restless ? null : version, mine); return; }
          status(same ? 'Same board: no new check needed.' : read.statusView ? 'Fresh board behind the Treasure read.' : 'Board read. Check the instruments and objective below.');
          showRecommendation(restless ? null : version, mine); return;
        }
        if (read.statusView) { boardSeen = false; treasureOpen = true; } else { boardSeen = true; treasureGuessed = false; treasureOpen = false; }
        status(boardReadiness(read, seen)); advice('The screen needs checking: advice hidden.'); return;
      }
      activeRead = null;
      // Give the player useful routing immediately, before slow card-name OCR.
      advice('If the Warden’s Treasure is open, press View Prison Status (the eye) and keep the board open.');
      const treasure = A.readTreasure ? await stage('No board: checking for the Warden’s Treasure…', () => A.readTreasure(bitmap), 6000, live) : { ok: false };
      if (!live() || !treasure) return;
      // Its advice goes with the frame shown now: an animated overlay has
      // moved on a frame or two since the picture was taken.
      if (treasure.ok) {
        // The same Treasure, still open, with one pick: its advice holds,
        // the exact one after View Prison Status or the guess before it.
        // Opulence's offers can follow one another without the board
        // showing, so each of them still needs the eye view.
        const gift = A.giftState && A.giftState();
        if (treasureOpen && gift && gift.open && !gift.wait && !gift.opulence && !gift.picked && (gift.seen || treasureGuessed)) {
          provisional = !gift.seen;
          if (gift.seen && A.useTreasure) A.useTreasure();
          status(gift.seen ? 'Warden’s Treasure: advice on the board seen behind it.' : 'Warden’s Treasure: advice on the last board read. For exact advice, open View Prison Status.');
          showRecommendation(restless ? null : gate.version, mine); return;
        }
        // A board read before this Treasure isn't the board after it.
        lastSignature = '';
        if (!treasureOpen) adviceId++;
        treasureOpen = true;
        const plan = treasurePlan({ boardSeen, guessed: treasureGuessed, lastAction });
        if (plan.use && A.treasureGuess) {
          treasureGuessed = true; boardSeen = false;
          if (A.treasureGuess(plan.after)) {
            provisional = true;
            status('Warden’s Treasure: advice on the last board read. For exact advice, open View Prison Status.');
            showRecommendation(restless ? null : gate.version, mine); return;
          }
        }
        // Without the game log, a second offer can mean either returning
        // from the eye view or a newly confirmed Opulence pick. Never reuse
        // the previous gift board/count here: advise only on a fresh eye view.
        document.documentElement.classList.add('qt-stale');
        status('Warden’s Treasure: for EACH pick, open View Prison Status (the eye) and keep the board open.');
        announce('Warden’s Treasure: open View Prison Status (the eye) for the advice.');
        advice('The Treasure needs a fresh board: the last advice is hidden.');
        return;
      }
      const pick = await stage('Checking for an instrument offer: reading the three cards…', () => A.readPick(bitmap), 10000, live);
      if (!live() || !pick) return;
      if (pick.ok && pick.cards.length >= 2 && pick.cards.every((card) => card.conf >= 0.65) && !pick.unsure) {
        if (!A.usePick(pick, $('qt-fresh').checked)) { status('Check the instrument names below and press Recheck.'); advice('The instruments need confirming by hand.'); showRecommendation(restless ? null : gate.version, mine); return; }
        status('Instrument offer read. Check the three names below.');
        showRecommendation(restless ? null : gate.version, mine); return;
      }
      status('Screen not recognized. For the Warden’s Treasure press View Prison Status (the eye); otherwise check the game is in English, or use the Screenshot tab.');
      advice('No automatic advice for this screen.');
    } catch (error) {
      record('error', { message: String(error && error.message || error), stack: error && error.stack ? String(error.stack) : '' });
      if (current()) { status(`Couldn’t read the screen: ${error.message || error}`); advice('Advice hidden. Read the screen again, or use the Screenshot tab.'); }
    } finally {
      if (bitmap) bitmap.close();
      busy = false;
      // A timed-out analyzer has now drained, so it is safe to take the
      // newest window frame. Never reset a gate belonging to a new session.
      if (expired && stream && session === mine) {
        gate = new FrameGate(); gate.version = Date.now();
        status('The previous reading ended. Reading the current screen…');
        $('qt-reload').hidden = true;
      }
    }
  }
  function tick() {
    if (!stream || !video.videoWidth || video.readyState < 2) return;
    // Exclude window borders, the iPad home indicator and QuickTime's floating
    // recording toolbar. Recognition still receives the complete game frame.
    const now = performance.now();
    if (now - measured > 2000) { measured = now; measureView(); }
    const W = video.videoWidth * view.w, H = video.videoHeight * view.h, X = video.videoWidth * view.x, Y = video.videoHeight * view.y;
    const part = (x, y, w, h, dx, dy, dw, dh) => sampleCtx.drawImage(video, X + W * x, Y + H * y, W * w, H * h, dx, dy, dw, dh);
    sampleCtx.clearRect(0, 0, sample.width, sample.height);
    // Sample the board and action row, excluding the torches at both edges.
    part(0.21, 0.17, 0.58, 0.43, 0, 0, 144, 64);
    part(0.22, 0.63, 0.56, 0.16, 0, 64, 144, 24);
    part(0.35, 0, 0.35, 0.05, 0, 88, 72, 12);
    part(0.82, 0.07, 0.15, 0.45, 72, 88, 72, 12);
    const data = sampleCtx.getImageData(0, 0, sample.width, sample.height).data;
    for (let i = 0; i < pixels.length; i++) pixels[i] = Math.round(((data[i * 4] || 0) + (data[i * 4 + 1] || 0) + (data[i * 4 + 2] || 0)) / 3);
    const state = gate.update(pixels, now);
    if (state.changed) { clearAdvice(); if (busy) status('The screen changed. Waiting for the previous reading to end…'); }
    if (state.ready && !busy && !lane.busy) {
      if (state.restless) record('restless', { version: state.version });
      gate.accept(); recognize(state.version, session, state.restless);
    }
  }
  function startTimer(fn, ms) {
    try {
      if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || !URL.createObjectURL) throw new Error('no worker');
      const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = fn;
      return worker;
    } catch (e) { return setInterval(fn, ms); }
  }
  async function connect(auto) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { status('Needs Chrome, Edge or another Chromium browser on a computer.'); return; }
    $('qt-start').disabled = true;
    try {
      const chosen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false, selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'include', surfaceSwitching: 'exclude' });
      const track = chosen.getVideoTracks()[0];
      surface = track.getSettings().displaySurface || 'window';
      if (surface !== 'window' && surface !== 'monitor') {
        chosen.getTracks().forEach((t) => t.stop());
        throw new Error('Pick the QuickTime window, or the Entire Screen with the iPad’s AirPlay picture: a browser tab isn’t used.');
      }
      view = { x: 0, y: 0, w: 1, h: 1 }; measured = 0;
      if (recorder) recorder.start({ surface, settings: track.getSettings() });
      stream = chosen; session++; gate = new FrameGate(); lastSignature = ''; activeRead = null;
      document.documentElement.classList.add('qt-capturing', 'qt-stale');
      video.srcObject = stream; await video.play();
      video.hidden = false; $('qt-empty').hidden = true; $('qt-live').hidden = false;
      track.addEventListener('ended', stop, { once: true });
      if (A.setGameLang) A.setGameLang('en', false);
      $('qt-stop').disabled = false; $('qt-rescan').disabled = false;
      status(surface === 'monitor' ? 'Screen connected: keep the iPad’s AirPlay picture on it. Wait for animations to end.' : 'Window connected. Wait for animations to end.');
      // A page out of sight has its timers slowed down; a worker's aren't.
      timer = startTimer(tick, 250); tick();
    } catch (error) {
      stop();
      // Without a click the browser may refuse the window picker: wait for one.
      if (auto && error && (error.name === 'InvalidStateError' || error.name === 'NotAllowedError')) {
        status('Press Connect and pick the QuickTime window or the screen with the AirPlay picture.');
        $('qt-start').focus();
        return;
      }
      status(`Capture not started: ${error.message || error}`);
    }
  }
  $('qt-start').addEventListener('click', () => connect(false));
  if (params.get('autostart') === '1') connect(true);
  $('qt-stop').addEventListener('click', stop);
  $('qt-reload').addEventListener('click', () => { stop(); location.reload(); });
  $('qt-rescan').addEventListener('click', () => { record('action', { name: 'read again' }); lastSignature = ''; gate = new FrameGate(); gate.version = Date.now(); clearAdvice(); tick(); });
  // A manual file/paste takes precedence; do not race it with captured frames.
  // Its reading shows on the Screenshot tab, so that tab comes up.
  const manual = () => { if (stream) stop(); selectTab('shot'); };
  document.addEventListener('change', (event) => { if (event.target.type === 'file' && event.target.files.length) manual(); }, true);
  document.addEventListener('paste', (event) => { if (event.clipboardData && [...event.clipboardData.items].some((item) => item.type.startsWith('image/'))) manual(); }, true);
  document.addEventListener('drop', (event) => { if (event.dataTransfer && event.dataTransfer.files.length) manual(); }, true);
  window.addEventListener('pagehide', stop);
})();

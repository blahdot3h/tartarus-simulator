/* Tartarus Simulator: live board sharing.
 * The board analyzer records every board a player asks about. Boards asked
 * about in a row from the same game (the same day or the next) make a run.
 * Once a run has two boards, they're a confirmed record of what happened in
 * between, so the run is sent, anonymously, to the collector (worker/). The
 * odds the simulator uses are then tuned on what live really does.
 * Only boards entered by hand are sent: never the example or a simulator
 * run. The player can turn sharing off. */
(function () {
  'use strict';

  // The collector. Empty turns sending off everywhere. A copy of the site run
  // on this PC (tools/serve.js) never sends, so test runs stay out of the
  // odds study.
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const ENDPOINT = LOCAL ? '' : 'https://tartarus-live.blahdot3h.workers.dev';
  const KEY = 'tartarus-sim:live:v1';
  const BATCH = 10; // snapshots per upload
  const QUEUE_MAX = 300;
  const HISTORY_MAX = 100;
  const SEND_DELAY = 20000; // ms after a board before an upload, unless a batch fills
  const RETRY_MIN = 5000;
  const RETRY_MAX = 300000;

  // This script's version tag, sent with each snapshot.
  const APP = (() => {
    const src = document.currentScript ? document.currentScript.src : '';
    const m = /[?&]v=([\w.-]{1,24})/.exec(src);
    return m ? m[1] : '';
  })();

  const store = {
    get() {
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    set(value) {
      try {
        localStorage.setItem(KEY, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  function randomId() {
    const bytes = new Uint8Array(12);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const newRun = (source) => ({ id: randomId(), source, seq: 0, day: 0, sig: '', last: '', ended: false, held: null });

  const saved = store.get();
  const state = {
    client: saved && typeof saved.client === 'string' ? saved.client : randomId(),
    share: saved ? saved.share !== false : true,
    run: saved && saved.run && saved.run.id ? saved.run : newRun('manual'),
    queue: saved && Array.isArray(saved.queue) ? saved.queue : [],
    history: saved && Array.isArray(saved.history) ? saved.history : [],
    sent: saved && Number.isInteger(saved.sent) ? saved.sent : 0,
  };
  const listeners = [];

  function save() {
    // If the browser is out of room, drop the oldest history first.
    while (!store.set(state) && state.history.length) state.history.splice(0, Math.ceil(state.history.length / 2));
  }

  function changed() {
    save();
    for (const fn of listeners) fn();
  }

  // ---------- Recording ----------

  // Starts a new run, for a board that doesn't follow on from the last one.
  // `source` is 'manual' for boards entered by hand, or 'example' / 'sim',
  // which are never sent.
  function reset(source) {
    state.run = newRun(source || 'manual');
    changed();
  }

  // A board from the player's own game, such as a screenshot: if the run so
  // far came from the example or the simulator, start a new one.
  function markManual() {
    if (state.run.source !== 'manual') reset('manual');
  }

  // Records the board the player just asked about. `via` says how it was
  // reached, when the player pressed "Do it here": the move, which parts the
  // simulator's dice filled in, and which of those the player then set or
  // confirmed against their game.
  function record(board, via) {
    const snap = JSON.parse(JSON.stringify(board));
    const text = JSON.stringify(snap);
    const sig = [snap.mode, snap.chain, snap.rewards ? 1 : 0, snap.maxDays].join('|');
    let run = state.run;
    if (run.seq > 0 && run.last === text) return; // asked again about the same board
    const follows = run.seq === 0 || (run.sig === sig && !run.ended && snap.day >= run.day && snap.day <= run.day + 1);
    if (!follows) run = state.run = newRun('manual');
    const item = {
      uid: randomId(),
      client: state.client,
      run: run.id,
      seq: run.seq,
      app: APP,
      t: Date.now(),
      board: snap,
      via: via || null,
    };
    run.seq += 1;
    run.day = snap.day;
    run.sig = sig;
    run.last = text;
    run.ended = !!snap.ended;
    if (run.source === 'manual' && state.share) {
      // A run's first board waits for a second one: alone it shows nothing.
      if (run.seq === 1) run.held = item;
      else {
        const ready = run.held ? [run.held, item] : [item];
        run.held = null;
        state.queue.push(...ready);
        if (state.queue.length > QUEUE_MAX) state.queue.splice(0, state.queue.length - QUEUE_MAX);
        state.history.push(...ready);
        if (state.history.length > HISTORY_MAX) state.history.splice(0, state.history.length - HISTORY_MAX);
      }
    }
    changed();
    if (state.queue.length >= BATCH) flush();
    else if (state.queue.length) schedule(SEND_DELAY);
  }

  // ---------- Sending ----------

  let busy = false;
  let retry = RETRY_MIN;
  let timer = 0;

  // Uploads wait a little, so a few boards go together.
  function schedule(delay) {
    if (!timer) timer = setTimeout(flush, delay);
  }

  function flush() {
    clearTimeout(timer);
    timer = 0;
    if (busy || !ENDPOINT || !state.share || !state.queue.length || typeof fetch !== 'function') return;
    busy = true;
    const batch = state.queue.slice(0, BATCH);
    const body = JSON.stringify({ items: batch });
    // Plain text keeps it a simple request, with no preflight.
    fetch(`${ENDPOINT}/v1/snapshots`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body, keepalive: body.length < 60000 })
      .then((res) => {
        // A 400 means the collector can't use these, so don't send them again.
        if (!res.ok && res.status !== 400 && res.status !== 413) throw new Error(`HTTP ${res.status}`);
        const done = new Set(batch.map((s) => s.uid));
        state.queue = state.queue.filter((s) => !done.has(s.uid));
        if (res.ok) state.sent += batch.length;
        retry = RETRY_MIN;
        busy = false;
        changed();
        if (state.queue.length) flush();
      })
      .catch(() => {
        busy = false;
        schedule(retry);
        retry = Math.min(RETRY_MAX, retry * 2);
      });
  }

  function setSharing(on) {
    state.share = !!on;
    if (!state.share) {
      state.queue = [];
      state.run.held = null;
    }
    changed();
  }

  // Everything this browser has shared (or is about to), for the player to see.
  function download() {
    const data = { about: 'Boards this browser shared with the Tartarus Simulator odds study.', client: state.client, snapshots: state.history };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tartarus-shared-boards.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.TartarusLive = {
    record,
    reset,
    markManual,
    setSharing,
    download,
    flush,
    onChange: (fn) => listeners.push(fn),
    get sharing() {
      return state.share;
    },
    get sent() {
      return state.sent;
    },
    get waiting() {
      return state.queue.length;
    },
    get shared() {
      return state.history.length;
    },
  };

  // Send what's waiting when the player leaves the tab, and anything a closed
  // tab left behind.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  schedule(1500);
})();

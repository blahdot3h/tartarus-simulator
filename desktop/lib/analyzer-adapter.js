/* Tartarus Overlay: put into analyze.html by the app, after the page's own
 * scripts. The analyzer itself is the site's code: it reads each picture
 * Auto Screenshot Mode sends, loads the board and gives its advice, shares boards
 * and sends reports exactly as on the website. This only copies what its
 * results panel says to the overlay, and presses its buttons for the
 * overlay's.
 *
 * The advice is TartarusAnalyzer.recommendation() (null until the check is
 * done, and for a changed board). The rest it reads from the page by these
 * ids and words, so keep them in step with analyze.html and js/analyze.js:
 * az-results (class is-stale), az-res-move ("Working it out…" while the
 * check runs, "Nothing to decide…"), az-res-status ("X of Y games played"
 * while it runs), az-res-body (paragraphs "Expected: …" and "After this
 * first bite…"),
 * az-res-list (rows .solver-text, .solver-value, class is-best), az-res-note,
 * az-res-shot, az-res-shot-text, az-fix, az-recheck, az-go, az-problems,
 * az-riot, az-dayof, az-step (aria-pressed), az-report-reading,
 * az-scan-report, az-tools-confirm, az-tools-confirm-text, az-tools-ok; and
 * window.TartarusReport.open. */
(function () {
  'use strict';

  const D = window.TartarusDesktop;
  if (!D || window.__tartarusDesktop) return;
  window.__tartarusDesktop = true;

  const $ = (id) => document.getElementById(id);
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const shown = (el) => !!el && !el.hidden;

  // #region record
  // ---------- The test record ----------
  // While testing, the app keeps a record of each step to review later
  // (tray: Review the record): every picture as the analyzer got it, what
  // the reader made of it, the board it loaded, the advice with every move
  // it weighed, and the player's fixes. The app writes it on this PC only.
  const boardNow = () => {
    try {
      const s = JSON.parse(localStorage.getItem('tartarus-sim:analyzer:v1') || 'null');
      return s && s.model ? s.model : null;
    } catch (e) {
      return null;
    }
  };
  // Instrument names for the review, as the site prints them.
  const namesOf = (board) => {
    const T = window.Tartarus;
    const name = (id) => {
      try {
        return (T && typeof T.toolName === 'function' && T.toolName(id)) || id;
      } catch (e) {
        return id;
      }
    };
    return board ? { tools: (board.tools || []).map(name), choice: ((board.choice && board.choice.options) || []).map(name) } : null;
  };
  // What the reader made of the picture: every cell with how sure it was,
  // the doors or buttons, the riot counter, the instruments and its notes
  // (TartarusAnalyzer.readingSummary); on an older site, its summary list.
  const summaryNow = () => {
    const A = window.TartarusAnalyzer;
    const full = A && typeof A.readingSummary === 'function' ? A.readingSummary() : '';
    if (full) return full.split('\n').filter(Boolean);
    return [...document.querySelectorAll('#az-scan-summary li')].map(text).filter(Boolean);
  };
  const record = (entry, bytes) => {
    if (typeof D.record === 'function') D.record(entry, bytes || null);
  };
  let recorded = ''; // the board last put in the record
  let loadedAt = 0;
  const keep = (board) => {
    recorded = JSON.stringify(board);
  };
  // Each picture takes its place in the record at once; its file is made
  // once the analyzer has read it (or after 8 s), so saving it never slows
  // the reading down.
  const waitingPictures = new Map(); // id -> { blob, timer }
  function recordPicture(m) {
    // Auto Screenshot Mode hands over raw pixels (m.pixels), or a PNG (m.blob)
    // to an analyzer from before that.
    const has = !!(m.blob || (m.pixels && m.pixels.buffer));
    record({ type: 'picture', id: m.id, kind: m.kind, fresh: !!m.fresh, after: m.after || null, pending: has });
    if (!has) return;
    const w = { blob: m.blob, pixels: m.pixels, timer: setTimeout(() => savePicture(m.id), 8000) };
    waitingPictures.set(m.id, w);
  }
  async function savePicture(id) {
    const w = waitingPictures.get(id);
    if (!w) return;
    waitingPictures.delete(id);
    clearTimeout(w.timer);
    let bytes = null;
    try {
      let canvas;
      if (w.pixels && w.pixels.buffer) {
        const p = w.pixels;
        canvas = new OffscreenCanvas(p.width, p.height);
        canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.buffer), p.width, p.height), 0, 0);
      } else {
        const bmp = await createImageBitmap(w.blob);
        canvas = new OffscreenCanvas(bmp.width, bmp.height);
        canvas.getContext('2d').drawImage(bmp, 0, 0);
      }
      bytes = await (await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })).arrayBuffer();
    } catch (e) {
      bytes = null;
    }
    if (bytes) record({ type: 'picture-file', id }, bytes);
  }

  // Auto Screenshot Mode's pictures, as they come in and as they're read.
  let reading = null; // { kind, at }
  let lastRead = null;
  if (typeof BroadcastChannel === 'function') {
    const channel = new BroadcastChannel('tartarus-follow');
    channel.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'frame') {
        reading = { kind: m.kind, at: Date.now() };
        recordPicture(m);
      } else if (m.type === 'read' && m.read) {
        reading = null;
        const r = m.read;
        lastRead = { at: Date.now(), ok: !!r.ok, reason: r.reason || '', day: r.day, unsure: r.unsure || 0, pick: !!r.pick, names: r.names || [], objective: !!r.objective, name: r.name || '', treasure: !!r.treasure };
        if (!r.ok) record({ type: 'read', id: m.id, ok: false, reason: r.reason || '', summary: summaryNow() });
        setTimeout(() => savePicture(m.id), 1500); // after the advice's check has started
      } else if (m.type === 'read' && m.state === 'used') {
        // The reading is the board now.
        setTimeout(() => {
          const board = boardNow();
          keep(board);
          loadedAt = Date.now();
          record({ type: 'loaded', id: m.id, read: lastRead, summary: summaryNow(), board, names: namesOf(board) });
        }, 50);
      }
      soon();
    });
  }

  // #endregion
  function snapshot() {
    const res = $('az-results');
    const body = $('az-res-body');
    const paras = body ? [...body.querySelectorAll('p')].map(text) : [];
    const options = [...(($('az-res-list') || {}).children || [])].slice(0, 4).map((li) => ({
      label: text(li.querySelector('.solver-text')),
      value: text(li.querySelector('.solver-value')),
      best: li.classList.contains('is-best'),
    }));
    const shotText = text($('az-res-shot-text'));
    const flagged = Number((/(\d+) cells? marked Check/.exec(shotText) || [])[1] || 0);
    const step = $('az-step') && $('az-step').querySelector('button[aria-pressed="true"]');
    const riot = $('az-riot');
    if (reading && Date.now() - reading.at > 30000) reading = null;
    // The advice itself comes from the analyzer, which gives it only once
    // every move has been played out (so it doesn't change), and only for
    // the board as it is. Until then its panel says "Working it out…", and
    // the status line how many games are played.
    const A = window.TartarusAnalyzer;
    const rec = A && typeof A.recommendation === 'function' ? A.recommendation() : null;
    const move = text($('az-res-move'));
    const working = shown(res) && /Working it out/.test(move);
    const status = text($('az-res-status'));
    const played = /([\d,]+) of ([\d,]+) games played/.exec(status);
    const num = (s) => Number(String(s).replace(/,/g, ''));
    return {
      has: shown(res),
      move: rec ? rec.label : '',
      why: rec ? rec.why || '' : '',
      working,
      progress: working && played ? Math.round((100 * num(played[1])) / Math.max(1, num(played[2]))) : null,
      nothing: shown(res) && !working && !rec && /^Nothing to decide/.test(move),
      stale: !!res && res.classList.contains('is-stale'),
      expect: rec ? paras.find((p) => /^Expected:/.test(p)) || '' : '',
      chain: rec ? paras.find((p) => /^After this first bite/.test(p)) || '' : '',
      status: rec ? status : '',
      options,
      close: /margin of error/.test(text($('az-res-note'))),
      shot: shown($('az-res-shot')),
      shotText,
      flagged,
      canFix: shown($('az-fix')),
      canReportReading: shown($('az-report-reading')) || shown($('az-scan-report')),
      problems: shown($('az-problems')) ? [...$('az-problems').children].map(text).slice(0, 3) : [],
      // The analyzer asks the player to confirm the run's instruments.
      toolsConfirm: shown($('az-tools-confirm')) ? text($('az-tools-confirm-text')) : '',
      // A Warden's Treasure waits for the board behind it (View Prison Status).
      treasureWait: shown($('az-treasure-wait')),
      // A screen the reader didn't recognize on a game client not in English
      // ({ what, at, lang }): its screenshot can be sent from the analyzer.
      langMiss: A && typeof A.langMiss === 'function' ? A.langMiss() : null,
      riot: riot && riot.value !== '' ? Number(riot.value) : null,
      dayof: text($('az-dayof')),
      step: text(step),
      reading,
      lastRead,
    };
  }

  // Sent when something changed, at most a few times a second.
  let last = '';
  let timer = 0;
  let advised = ''; // the advice last put in the record, with its board
  function post() {
    timer = 0;
    const s = snapshot();
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    D.advice(s);
    // Each advice once it's final, a board problem, or instruments to
    // confirm, with the exact board it's for.
    if (s.move || s.problems.length || s.toolsConfirm || s.treasureWait) {
      const board = boardNow();
      const what = JSON.stringify([s.move, s.problems, s.toolsConfirm, s.treasureWait, board]);
      if (what !== advised) {
        advised = what;
        keep(board);
        record({
          type: 'advice',
          board,
          names: namesOf(board),
          advice: { treasureWait: s.treasureWait, move: s.move, why: s.why, expect: s.expect, chain: s.chain, status: s.status, options: s.options, close: s.close, flagged: s.flagged, shotText: s.shotText, problems: s.problems, toolsConfirm: s.toolsConfirm, step: s.step, riot: s.riot, dayof: s.dayof },
        });
      }
    }
  }

  // The player's own changes to the board (a fix, a recheck's edits, Do it
  // here), once it has stayed the same for a moment.
  let pending = null; // { json, timer }: a change waiting to settle
  setInterval(() => {
    if (reading || Date.now() - loadedAt < 2500) return;
    const board = boardNow();
    const json = board ? JSON.stringify(board) : '';
    if (!board || !recorded || json === recorded) return;
    if (pending && pending.json === json) return;
    if (pending) clearTimeout(pending.timer);
    pending = {
      json,
      timer: setTimeout(() => {
        const was = pending;
        pending = null;
        const now = boardNow();
        const j = now ? JSON.stringify(now) : '';
        if (!now || !was || j !== was.json || j === recorded) return;
        keep(now);
        record({ type: 'edit', board: now, names: namesOf(now) });
      }, 1500),
    };
  }, 1000);
  function soon() {
    if (!timer) timer = setTimeout(post, 150);
  }
  const watch = new MutationObserver(soon);
  for (const id of ['az-results', 'az-problems', 'az-step', 'az-dayof', 'az-scan-status', 'az-scan-report', 'az-tools-confirm', 'az-treasure-wait']) {
    const el = $(id);
    if (el) watch.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
  }
  document.addEventListener('input', soon, true);
  document.addEventListener('change', soon, true);
  setInterval(soon, 2000);
  soon();

  const click = (id) => {
    const el = $(id);
    if (!el || el.hidden || el.disabled) return false;
    el.click();
    return true;
  };
  // A debug report from the app: the Report form, filled in, for the player
  // to add what they saw and send.
  if (typeof D.onDebugReport === 'function') {
    D.onDebugReport((r) => {
      if (window.TartarusReport && r) window.TartarusReport.open('other', { name: String(r.name || '').slice(0, 80), text: String(r.text || '').slice(0, 2000), outcome: String(r.outcome || '').slice(0, 1000) });
    });
  }
  D.onCommand((cmd) => {
    if (cmd === 'fix') {
      if (!click('az-fix')) {
        const target = shown($('az-problems')) ? $('az-problems') : $('az-game');
        if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } else if (cmd === 'recheck') {
      if (!click('az-recheck')) click('az-go');
    } else if (cmd === 'report') {
      // A wrong reading goes with its screenshot; anything else is new.
      if (!click('az-report-reading') && !click('az-scan-report') && window.TartarusReport) window.TartarusReport.open('other');
    } else if (cmd === 'run-over') {
      // The run is over: a clean board for the next one (Clear the board
      // asks for a second click, so it gets two). The finished run's board
      // stays in its record; the clean one isn't a change to record.
      click('az-clear');
      click('az-clear');
      setTimeout(() => keep(boardNow()), 300);
    } else if (cmd === 'treasure-now') {
      click('az-treasure-now');
    } else if (cmd === 'tools-ok') {
      click('az-tools-ok');
    } else if (cmd === 'report-new') {
      if (window.TartarusReport) window.TartarusReport.open('other');
    }
    soon();
  });
})();

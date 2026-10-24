/* Tartarus Simulator: interface.
 * Renders the engine state, turns clicks into engine actions, and keeps the
 * undo history, saves and preferences. All rules live in engine.js. */
(function () {
  'use strict';

  const T = window.Tartarus;
  const Sound = window.TartarusSound;
  // This script's version tag, so the solver worker loads matching files.
  const SCRIPT_QUERY = (() => {
    const src = document.currentScript ? document.currentScript.src : '';
    const q = src.indexOf('?');
    return q >= 0 ? src.slice(q) : '';
  })();
  // The published single-file build sets this; its viewer cannot download files.
  const EMBEDDED = !!window.TARTARUS_EMBEDDED;

  const KEYS = { save: 'tartarus-sim:save:v2', prefs: 'tartarus-sim:prefs:v1', params: 'tartarus-sim:params:v8' };
  const HISTORY_LIMIT = 40;
  const DEFAULT_PREFS = { advisor: false, quick: false, motion: true, sound: true, volume: 60, immersive: false };

  // The ring layout, portraits and cell faces come from js/board.js.
  const { RING, PORTRAITS, LANTERN, FANGS, OFFICE_ART, CELL_HTML, cellParts } = window.TartarusBoard;

  const $ = (id) => document.getElementById(id);
  const L = (n) => T.cellLabel(n);
  // The day's swap is still open: a day has a devour or a swap, not both.
  // (An engine cached from before that rule has no canSwapNow.)
  const canSwapNow = (st) => (T.canSwapNow ? T.canSwapNow(st) : st.used.swap < st.params.swapsPerDay);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const store = {
    get(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* Storage can be full or blocked; the run still works in memory. */
      }
    },
  };

  const ui = {
    state: null,
    history: [],
    selected: null,
    pending: null,
    hover: null,
    screen: 'title',
    prefs: Object.assign({}, DEFAULT_PREFS, store.get(KEYS.prefs) || {}),
    labParams: loadLabParams(),
    labCell: 1,
    actedOn: null,
    trainer: null,
    labTab: 'scene',
    toastTimer: 0,
    endArmed: 0,
  };

  const cellEls = [];

  // Practice values. Older saved values keep everything except what the live
  // game has since shown: three doors every morning (unless an instrument or
  // event takes one away), the six-cell patrol, and a pick of three
  // instruments to start.
  function loadLabParams() {
    const saved = store.get(KEYS.params);
    if (saved) return T.normalizeParams(saved);
    // 30,000 runs' boards (2026-10-22): the Replace odds and the special
    // events' chances give way to the live ones; the rest carries over.
    const stale = ['swapWeights', 'eventMorningChance', 'eventWalkChance', 'eventActionChance'];
    const v7 = store.get('tartarus-sim:params:v7');
    if (v7 && typeof v7 === 'object') {
      for (const key of stale) delete v7[key];
      return T.normalizeParams(v7);
    }
    // Second meals at every rarity, as players' games show (2026-10-17):
    // the saved Legendary-and-up gives way; the rest carries over.
    const v6 = store.get('tartarus-sim:params:v6');
    if (v6 && typeof v6 === 'object') {
      delete v6.doubleEatTier;
      for (const key of stale) delete v6[key];
      return T.normalizeParams(v6);
    }
    // The live door odds replace the old defaults (2026-10-16); the rest of
    // the Lab's settings carry over.
    const v5 = store.get('tartarus-sim:params:v5');
    if (v5 && typeof v5 === 'object') {
      delete v5.tierWeights;
      delete v5.doubleEatTier;
      for (const key of stale) delete v5[key];
      return T.normalizeParams(v5);
    }
    let old = store.get('tartarus-sim:params:v4') || store.get('tartarus-sim:params:v3');
    const drop = ['destinations', 'fewerDoorsChance', 'eventTwoDoors', 'patrolRange', 'startTools', 'tierWeights', 'doubleEatTier'];
    if (!old) old = store.get('tartarus-sim:params:v2');
    if (old && typeof old === 'object') for (const key of drop.concat(stale)) delete old[key];
    return T.normalizeParams(old);
  }

  // ---------- Small helpers ----------

  function setHTML(el, html) {
    if (el.__html !== html) {
      el.innerHTML = html;
      el.__html = html;
    }
  }

  function makeButton(label, onClick, kind, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (kind === 'primary' ? ' btn-primary' : kind === 'danger' ? ' btn-danger' : '');
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function modeName(st) {
    return st.scenario === 'empty' ? 'Rules drill' : T.SCENARIOS[st.scenario].name;
  }

  const blocked = (st) => !st || st.phase === 'ended' || st.pending.length > 0 || st.phase === 'event' || st.phase === 'office' || !!st.chaining;

  // An error stays long enough to be read and caught (the user, 2026-10-24);
  // an info note goes sooner.
  const TOAST_ERROR_MS = 6000, TOAST_INFO_MS = 3400;
  function toast(text, info) {
    const el = $('toast');
    el.textContent = text;
    el.classList.toggle('is-info', !!info);
    if (typeof el.showPopover === 'function') {
      try {
        if (el.matches(':popover-open')) el.hidePopover();
        el.showPopover();
      } catch (e) {
        el.hidden = false;
      }
    } else {
      el.hidden = false;
    }
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      if (typeof el.hidePopover === 'function' && el.matches(':popover-open')) el.hidePopover();
      else el.hidden = true;
    }, info ? TOAST_INFO_MS : TOAST_ERROR_MS);
  }

  function persist() {
    if (ui.state) store.set(KEYS.save, { app: 'tartarus-sim', v: T.VERSION, state: ui.state });
  }

  // ---------- Running moves ----------

  // Applies one engine action with undo, autosave, effects and sound.
  function run(action, opts) {
    const options = opts || {};
    if (!ui.state) return false;
    const snapshot = T.serialize(ui.state);
    let result;
    try {
      result = action(ui.state);
    } catch (err) {
      console.error(err);
      result = { ok: false, reason: 'That move hit an error and was not applied.' };
    }
    if (!result || !result.ok) {
      ui.state = T.deserialize(snapshot);
      toast(result ? result.reason : 'That move is not allowed.');
      Sound.play('error');
      render();
      return false;
    }
    ui.history.push(snapshot);
    if (ui.history.length > HISTORY_LIMIT) ui.history.shift();
    gradeMove(snapshot);
    if (!options.keepPending) ui.pending = null;
    if ('select' in options) ui.selected = options.select;
    tidySelection();
    persist();
    render();
    playEvents(result.events || []);
    followUp(ui.prefs.motion ? 600 : 0);
    return true;
  }

  // Opens whatever the run is now waiting on: a choice or the roster.
  function followUp(delay) {
    setTimeout(() => {
      const st = ui.state;
      if (!st || ui.screen !== 'game') return;
      if (st.phase === 'ended') {
        if (!$('dlg-results').open) openResults();
      } else if (st.pending.length) {
        openChoice();
      }
    }, delay);
  }

  function tidySelection() {
    const st = ui.state;
    if (ui.selected === null || !st) return;
    const cell = st.cells[ui.selected];
    if (!cell || (!cell.sealed && !cell.inmate)) ui.selected = null;
  }

  function undo() {
    if (!ui.history.length) {
      toast('Nothing to undo yet.', true);
      return;
    }
    ui.state = T.deserialize(ui.history.pop());
    ui.selected = null;
    ui.pending = null;
    if (ui.trainer) ui.trainer.last = null;
    persist();
    closeRunDialogs();
    if (ui.screen !== 'game') showScreen('game');
    else render();
    toast('Undid the last move.', true);
  }

  function cancel() {
    ui.pending = null;
    ui.selected = null;
    render();
  }

  const SOUND_ORDER = ['end', 'rainbow', 'devour', 'hatch', 'open', 'swap', 'nest', 'promote', 'tool', 'day', 'move'];
  const SOUND_ALIAS = { move: 'select' };

  function playEvents(events) {
    // The bites of a chain flash one after another, so you can follow it.
    let bites = 0;
    for (const ev of events) {
      if (ev.type === 'open') fx(ev.cell, 'fx-open');
      else if (ev.type === 'move') fx(ev.to, 'fx-move');
      else if (ev.type === 'devour') {
        const show = () => {
          fx(ev.to, 'fx-devour');
          fx(ev.from, 'fx-promote');
        };
        if (bites++ && ui.prefs.motion) setTimeout(show, (bites - 1) * 380);
        else show();
      } else if (ev.type === 'promote') fx(ev.cell, 'fx-promote');
      else if (ev.type === 'rainbow') fx(ev.cell, 'fx-rainbow');
      else if (ev.type === 'swap') fx(ev.cell, 'fx-swap');
      else if (ev.type === 'hatch') fx(ev.cell, 'fx-hatch');
      else if (ev.type === 'nest') fx(ev.cell, 'fx-nest');
    }
    const types = new Set(events.map((e) => e.type));
    const name = SOUND_ORDER.find((t) => types.has(t));
    if (name) Sound.play(SOUND_ALIAS[name] || name);
  }

  function fx(n, cls) {
    if (!ui.prefs.motion || n === null || n === undefined || !cellEls[n]) return;
    const el = cellEls[n].fx;
    el.className = 'cell-fx';
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // ---------- Asking before acting ----------

  function askPatrol(n) {
    if (ui.prefs.quick) {
      run((st) => T.patrol(st, n), { select: n });
      return;
    }
    ui.selected = n;
    ui.pending = { kind: 'patrol', cell: n };
    render();
  }

  function askSwap(n) {
    if (n === null || n === undefined) return;
    if (ui.prefs.quick) {
      run((st) => T.swap(st, n));
      return;
    }
    ui.selected = n;
    ui.pending = { kind: 'swap', cell: n };
    render();
  }

  // Targets open to today's devour, which only the warden's cell can start.
  function devoursAvailable(st) {
    return T.startOptions(st).length;
  }

  function askEndDay() {
    const st = ui.state;
    if (!st || blocked(st) || st.phase !== 'manage') return;
    const warnings = [];
    if (devoursAvailable(st)) warnings.push('You haven’t used today’s consume yet.');
    const last = st.day >= st.maxDays;
    if (!ui.prefs.quick && (warnings.length || last)) {
      ui.pending = { kind: 'end', warnings, last };
      render();
      return;
    }
    run((s) => T.endDay(s), { select: null });
  }

  // `clicks` is the click count, so the second click of a double-click acts at
  // once: it goes to a destination or devours a target, and on any other cell
  // it keeps the cell selected instead of toggling it off.
  function onCell(n, clicks) {
    const st = ui.state;
    if (!st) return;
    const double = clicks >= 2;
    // The first click may already have acted (quick decisions); a double-click
    // then has nothing left to do.
    const acted = ui.actedOn === n;
    ui.actedOn = null;
    if (double && acted) return;
    const act = (action, opts) => {
      ui.actedOn = n;
      run(action, opts);
    };
    const inspect = () => {
      ui.pending = null;
      ui.selected = ui.selected === n && !double ? null : n;
      render();
    };
    // A chain waiting for its next meal: a click previews the bite and a
    // second click takes it; a double-click takes it at once.
    if (st.chaining && !st.pending.length && T.chainOptions(st).some((o) => o.cell === n)) {
      const again = ui.pending && ui.pending.kind === 'chain' && ui.pending.to === n;
      if (double || again || ui.prefs.quick) act((s) => T.chainBite(s, n), { select: st.position });
      else {
        ui.pending = { kind: 'chain', to: n };
        render();
      }
      return;
    }
    if (blocked(st)) {
      inspect();
      return;
    }
    if (st.phase === 'patrol') {
      if (T.patrolOptions(st).includes(n)) {
        // Clicking the chosen destination again goes there.
        const again = ui.pending && ui.pending.kind === 'patrol' && ui.pending.cell === n;
        if (double || again || ui.prefs.quick) act((s) => T.patrol(s, n), { select: n });
        else askPatrol(n);
        return;
      }
      inspect();
      return;
    }
    // Only the warden's cell can start today's devour. With it selected, a
    // click previews a target and a second click devours it; a double-click
    // devours whatever is selected.
    const option = T.startOptions(st).find((o) => o.cell === n);
    if (option && (double || ui.selected === st.position)) {
      const from = st.position;
      const again = ui.pending && ui.pending.kind === 'devour' && ui.pending.to === n;
      if (double || again || ui.prefs.quick) act((s) => T.devour(s, from, n), { select: from });
      else {
        ui.selected = from;
        ui.pending = { kind: 'devour', from, to: n };
        render();
      }
      return;
    }
    inspect();
    if (ui.selected !== null && !double) Sound.play('select');
  }

  // ---------- Rendering: cells ----------

  function buildBoard() {
    const board = $('board');
    for (let n = 0; n < T.CELL_COUNT; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.style.gridRow = RING[n][0];
      b.style.gridColumn = RING[n][1];
      b.innerHTML = CELL_HTML;
      b.children[2].textContent = L(n);
      b.addEventListener('click', (e) => onCell(n, e.detail));
      b.addEventListener('mouseenter', () => {
        if (ui.state && ui.state.chain && ui.state.phase === 'patrol') {
          ui.hover = n;
          renderBoard();
        }
      });
      b.addEventListener('mouseleave', () => {
        if (ui.hover === n) {
          ui.hover = null;
          if (ui.state) renderBoard();
        }
      });
      board.appendChild(b);
      cellEls[n] = { btn: b, body: b.children[0], hint: b.children[3], badges: b.children[4], tag: b.children[5], warden: b.children[6], fx: b.children[7] };
    }
  }

  function renderBoard() {
    const st = ui.state;
    const free = !blocked(st);
    const sel = ui.selected !== null ? st.cells[ui.selected] : null;
    // Only the inmate in the warden's cell can start the day's devour. A
    // chain waiting for its next meal shows that meal's choices.
    const chaining = !!st.chaining && !st.pending.length;
    const hunter = chaining ? st.cells[st.position] : free && st.phase === 'manage' && T.canDevourNow(st) && sel && sel.n === st.position && !sel.sealed && sel.inmate ? sel : null;
    const hunting = !!hunter;
    const targets = new Map();
    if (hunter) for (const o of chaining ? T.chainOptions(st) : T.devourOptions(st, hunter.n)) targets.set(o.cell, o);
    const victims = new Set(st.phase === 'event' && st.event && st.event.kind === 'execution' ? T.executionVictims(st, st.event.cell).map((c) => c.n) : []);
    const dests = free && st.phase === 'patrol' ? new Set(T.patrolOptions(st)) : new Set();
    $('board').classList.toggle('is-patrolling', dests.size > 0);
    const aim = ui.pending && ui.pending.kind === 'patrol' ? ui.pending.cell : ui.hover;
    const path = st.chain && st.phase === 'patrol' && dests.has(aim) ? new Set(T.clockwisePath(st, aim)) : new Set();
    const pendingTarget = ui.pending && (ui.pending.kind === 'devour' || ui.pending.kind === 'chain') ? ui.pending.to : null;
    for (const cell of st.cells) {
      const el = cellEls[cell.n];
      const p = cellParts(cell, st);
      let tag = '';
      if (ui.selected === cell.n || pendingTarget === cell.n || (st.phase === 'event' && st.event && st.event.cell === cell.n)) p.cls.push('is-selected');
      if (targets.has(cell.n)) {
        p.cls.push('is-target');
        tag = `Eat +${T.gainFor(st, hunter.n, targets.get(cell.n)).gain}`;
      } else if (hunting && targets.size && hunter.n !== cell.n) {
        p.cls.push('is-dim');
      }
      if (victims.has(cell.n)) p.cls.push('is-victim');
      if (dests.has(cell.n)) {
        p.cls.push('is-dest');
        if (ui.hover === cell.n) p.cls.push('is-aim');
        if (st.chain) {
          const opens = T.clockwisePath(st, cell.n).filter((k) => st.cells[k].sealed).length;
          tag = `Go +${opens}`;
        } else {
          tag = cell.sealed ? 'Go' : 'Walk';
        }
      }
      if (path.has(cell.n)) p.cls.push('on-path');
      el.btn.className = p.cls.join(' ');
      setHTML(el.body, p.body);
      setHTML(el.hint, p.hint);
      setHTML(el.badges, p.badges);
      setHTML(el.warden, p.warden ? LANTERN : '');
      el.tag.textContent = tag;
      el.btn.setAttribute('aria-label', p.label + (tag ? `. ${tag}` : ''));
      el.btn.setAttribute('aria-pressed', String(ui.selected === cell.n));
    }
    $('emblem-text').textContent = st.phase === 'ended' ? 'Run complete' : `Warden ${wardenAt(st)} · clockwise`;
  }

  function wardenAt(st) {
    return st.position === T.OFFICE ? 'in the office' : `at cell ${L(st.position)}`;
  }

  // The morning's destination doors as cards under the ring.
  function renderDestBar() {
    const st = ui.state;
    const show = st.phase === 'patrol' && !blocked(st);
    $('dest-bar').hidden = !show;
    if (!show) return;
    const options = T.patrolOptions(st);
    const chosen = ui.pending && ui.pending.kind === 'patrol' ? ui.pending.cell : null;
    setHTML($('dest-cards'), st.destinations
      .map((n) => {
        const c = st.cells[n];
        const usable = options.includes(n);
        let meta;
        if (st.chain) meta = `Chain opens ${T.plural(T.clockwisePath(st, n).filter((k) => st.cells[k].sealed).length, 'door')}`;
        else if (!c.sealed && c.inmate) {
          const count = T.devourOptions(st, n).length;
          meta = `${T.describe(c.inmate)} · ${count ? T.plural(count, 'target') : 'no target'}`;
        } else if (n === T.OFFICE) meta = "Warden's office · Instigate or Bestow";
        else if (!c.sealed) meta = 'Empty cell';
        else if (c.nest) meta = `Rat nest · hatches day ${c.nest.due}`;
        else if (c.known === 2) meta = `${T.describe(c.hidden)} inside`;
        else if (c.known === 1) meta = `${T.tierName(c.hidden.tier)} inside`;
        else meta = 'Locked · unknown inside';
        const event = c.sealed && c.event && c.seen && !st.chain ? '<span class="dest-event">Event</span>' : '';
        // A known inmate shows its portrait; a locked cell shows its door.
        const face = !c.sealed && c.inmate
          ? `<span class="dest-face t${c.inmate.tier}" aria-hidden="true">${PORTRAITS[c.inmate.beast]}</span>`
          : `<span class="dest-door${c.sealed ? '' : ' is-open'}" aria-hidden="true"></span>`;
        const here = n === st.position ? ' (warden here)' : '';
        return `<button type="button" class="dest-card${chosen === n ? ' is-selected' : ''}" data-dest="${n}"${usable ? '' : ' disabled'}>${face}<span class="dest-label">${n === T.OFFICE ? 'Go to Interrogation Room' : `Go to cell ${L(n)}`}</span><span class="dest-meta">${esc(meta + here)}</span>${event}</button>`;
      })
      .join(''));
  }

  function renderSample() {
    const make = (id, beast, tier) => ({ id, beast, tier });
    const base = (n) => ({ n, sealed: true, inmate: null, hidden: null, known: 0, scratch: false, nest: null, event: null, ivory: false });
    const spec = [
      { sealed: false },
      { event: 'chain' },
      { sealed: false, inmate: make(3, 'wolf', 1), ivory: true },
      { hidden: make(4, 'rat', 3), known: 1 },
      { sealed: false, inmate: make(5, 'mammoth', 4) },
      {},
      { sealed: false, inmate: make(7, 'rat', 0) },
      { nest: { due: 10 } },
      { sealed: false, inmate: make(9, 'rat', 3) },
      { event: 'execution' },
      { hidden: make(11, 'mammoth', 1), known: 1, scratch: true },
      { sealed: false, inmate: make(12, 'rat', 2) },
      { sealed: false, inmate: make(13, 'mammoth', 1) },
      {},
      { sealed: false, inmate: make(15, 'lion', 0) },
      { sealed: false, inmate: make(2, 'lion', 2) },
    ];
    const cells = spec.map((s, n) => Object.assign(base(n), s));
    const sample = { day: 9, position: 6, cells, prey: [{ lion: 2, prey: 12, rounds: 2 }] };
    // Three of the six cells just ahead of the warden, as on a real morning.
    const dests = new Set([8, 9, 10]);
    const html = cells
      .map((cell) => {
        const p = cellParts(cell, sample);
        const tag = dests.has(cell.n) ? (cell.sealed ? 'Go' : 'Walk') : '';
        if (tag) p.cls.push('is-dest');
        const [row, col] = RING[cell.n];
        return `<div class="${p.cls.join(' ')}" style="grid-row:${row};grid-column:${col}"><span class="cell-body">${p.body}</span><span class="door"></span><span class="cell-no">${L(cell.n)}</span><span class="cell-hint">${p.hint}</span><span class="cell-badges">${p.badges}</span><span class="cell-tag">${tag}</span><span class="cell-warden">${p.warden ? LANTERN : ''}</span></div>`;
      })
      .join('');
    $('sample-board').classList.add('is-patrolling');
    $('sample-board').innerHTML = `${html}<div class="board-center"><div class="decision"><div class="decision-text"><p class="decision-title">Patrol: pick a destination</p><p class="decision-detail">Day 9. The glowing cells are today's destinations, all within six steps clockwise of the warden. Open a locked door, or walk to an inmate you already know.</p></div></div></div>`;
  }

  // ---------- Rendering: decision panel ----------

  function setDecision(title, detail, actions, pending) {
    $('decision-title').textContent = title;
    $('decision-detail').textContent = detail || '';
    $('decision-actions').replaceChildren(...actions.map((a) => makeButton(a[0], a[1], a[2], a[3])));
    $('decision').classList.toggle('is-pending', !!pending);
  }

  function renderDecision() {
    const st = ui.state;
    if (st.phase === 'ended') {
      setDecision('Run complete', 'The handoff roster is ready. Undo the last move to keep playing, or start a new run.', [
        ['Handoff roster', openResults, 'primary'],
        ['New run', () => openNewRun()],
      ]);
      return;
    }
    if (st.pending.length) {
      const kind = st.pending[0].kind;
      const start = !!st.pending[0].start;
      const title = kind === 'gift' ? "Warden's Treasure" : start ? 'Starting instrument' : 'Objective met';
      const detail = kind === 'gift' ? 'A Rainbow reached the vault. Pick one gift; it takes effect at once.' : start ? 'The run begins: pick one of three instruments to keep for the whole run.' : `${T.OBJECTIVES[st.objective.id].name} is complete. Pick a tool for the rest of the run.`;
      setDecision(title, detail, [['Choose', openChoice, 'primary']], true);
      return;
    }
    if (st.phase === 'event' && st.event) {
      renderEvent(st);
      return;
    }
    if (st.phase === 'office') {
      setDecision("The warden's office", `Choose one. Instigate: a new special event appears on a random cell, a locked door or an inmate's (2 when the board has none). Bestow: 1 random inmate on the block rises a tier.`, [
        ['Instigate', () => run((s) => T.officeAct(s, 'instigate')), 'primary'],
        ['Bestow', () => run((s) => T.officeAct(s, 'bestow')), 'primary'],
      ], true);
      return;
    }
    if (st.chaining && !(ui.pending && ui.pending.kind === 'chain')) {
      const eater = st.cells[st.position].inmate;
      const count = T.chainOptions(st).length;
      const stop = !!T.canStopChain && T.canStopChain(st);
      const pick = `Click ${count > 1 ? 'one' : 'it'} on the board to preview the bite, or double-click to take it.`;
      setDecision(
        'Consume chain: pick the next meal',
        stop
          ? `The ${T.describe(eater)} in cell ${L(st.position)} has ${T.plural(count, 'meal')} to eat. ${pick} Or stop the chain here, as the game's Cancel does: the eater keeps what it gained, and its meals stay on the block.`
          : `The ${T.describe(eater)} in cell ${L(st.position)} must keep eating, and it has ${count} meals to choose from. ${pick} The chain ends when it has nothing left to eat.`,
        stop ? [['Stop the chain', () => run((s) => T.stopChain(s), { select: st.position })]] : [],
        true,
      );
      return;
    }
    if (ui.pending) {
      renderPending(ui.pending);
      return;
    }
    if (ui.selected !== null) {
      renderSelection(st.cells[ui.selected]);
      return;
    }
    if (st.phase === 'patrol') {
      const options = T.patrolOptions(st);
      const parts = st.ratway
        ? [`Sewer Ratway: the warden can move to any cell but the office. Double-click one on the ring, or pick it below. A locked door there opens as on a patrol, and whichever inmate the warden ends up with makes today's consume.`]
        : [`The warden stands ${wardenAt(st)}. Pick one of the ${T.plural(options.length, 'cell')} below, or double-click a glowing cell on the ring. Whichever inmate the warden ends up with makes today's consume.`];
      if (st.chain) parts.push('Chain reaction armed: every sealed door on the clockwise walk opens.');
      setDecision('Patrol: select a destination', parts.join(' '), []);
      return;
    }
    const devours = devoursAvailable(st);
    const warden = st.cells[st.position];
    let lead;
    // A day has a devour or a swap, not both.
    if (st.used.swap > 0) lead = `You replaced an inmate today, so there is no consume: a day has a Replace or a consume, not both. ${canSwapNow(st) ? 'Replace again or end' : 'End'} the day.`;
    else if (!T.canDevourNow(st)) lead = 'Today’s consume is used, and with it the Replace: a day has one or the other. End the day.';
    else if (st.position === T.OFFICE) lead = 'The warden is in the office, so there is no consume today. Replace or end the day.';
    else if (!warden.inmate || warden.sealed) lead = `The warden's cell (${L(st.position)}) is empty, so there is no consume today. Replace or end the day.`;
    else if (devours) lead = `The ${T.describe(warden.inmate)} in the warden's cell (${L(st.position)}) can make today's consume. Select it to see its ${T.plural(devours, 'target')}, or double-click a target to consume it. ${T.canStopChain && T.canStopChain(st) ? 'It then goes on eating: you pick each next meal, or stop the chain, as the game’s Cancel does.' : 'It then must keep eating while it can: a single meal is taken at once, and you pick when there’s a choice.'}`;
    else lead = `The ${T.describe(warden.inmate)} in the warden's cell (${L(st.position)}) has no target today. Replace or end the day.`;
    setDecision('Manage the block', lead, []);
  }

  function renderEvent(st) {
    const { kind, cell: n } = st.event;
    if (kind === 'chain') {
      setDecision('Chain reaction', `Accept to arm it. Your next patrol walks clockwise from the warden to its destination and opens every sealed door on the way. Doors opened this way trigger nothing else.`, [
        ['Accept', () => run((s) => T.resolveEvent(s, true)), 'primary'],
        ['Skip', () => run((s) => T.resolveEvent(s, false))],
      ], true);
      return;
    }
    if (kind === 'trickster') {
      const who = st.cells[n].inmate;
      const scarce = T.scarceBeasts(st).map(T.beastName);
      const into = scarce.length === 1 ? `a Supreme ${scarce[0]}, the scarcest beast on the block` : `a Supreme ${scarce.join(' or ')} (the scarcest beasts on the block, one at random)`;
      setDecision('Behind Closed Doors', `Accept to turn the ${T.describe(who)} in cell ${L(n)} into ${into}. It triggers no other effects.`, [
        ['Accept', () => run((s) => T.resolveEvent(s, true)), 'primary'],
        ['Skip', () => run((s) => T.resolveEvent(s, false))],
      ], true);
      return;
    }
    if (kind === 'hunt') {
      // The card has only Confirm.
      setDecision(T.eventName(kind), 'Every locked cell holding a Normal or Magic shows its rarity (its beast stays hidden), so the doors left dark hold Rare or better.', [
        ['Confirm', () => run((s) => T.resolveEvent(s, true)), 'primary'],
      ], true);
      return;
    }
    if (['appetite', 'convict', 'crow', 'freedom', 'usurp1', 'usurp2', 'usurp3', 'usurp4', 'ratway', 'portion'].includes(kind)) {
      let detail;
      if (kind === 'appetite') {
        const low = T.lowestInmates(st);
        const who = low.length === 1 ? `the ${T.describe(low[0])} in cell ${L(T.cellOf(st, low[0].id).n)}` : `one of the ${low.length} ${T.tierName(low[0].tier)} inmates, at random`;
        detail = `Accept to give ${who} ${T.APPETITE_TRIES} tries at +1 tier, each with a ${Math.round(100 * T.APPETITE_ODDS)}% chance.`;
      } else if (kind === 'crow') detail = `Accept to see the rarity behind the next ${T.CROW_CELLS} locked cells clockwise from the warden. Their beasts stay hidden.`;
      else if (kind === 'freedom') detail = `Accept to open ${T.FREEDOM_CELLS} random locked cells. They trigger no other effects.`;
      else if (kind === 'portion') detail = `Accept to raise up to ${T.PORTION_INMATES} random inmates a tier each.`;
      else if (kind === 'usurp1') detail = 'Accept to raise 1 random inmate a tier. Usurpation I then leaves the special events, Usurpation II joins them, and one appears behind a random locked door.';
      else if (kind === 'usurp2') detail = 'Accept to raise 2 random inmates a tier each. Usurpation II then leaves the special events, and Usurpation III joins them.';
      else if (kind === 'usurp3') detail = 'Accept to raise 2 random inmates 2 tiers each. Usurpation III then leaves the special events, and Usurpation IV joins them.';
      else if (kind === 'usurp4') detail = 'Accept to raise every inmate on the block 2 tiers. Usurpation IV then leaves the special events.';
      else if (kind === 'ratway') detail = 'Accept to move the warden to any cell but the office. A locked door there opens as on a patrol, with any event behind it. The move isn’t a walk, so it adds no tiles.';
      else detail = 'Accept to open a random locked cell with a Legendary or better inmate inside. It triggers no other effects.';
      setDecision(T.eventName(kind), detail, [
        ['Accept', () => run((s) => T.resolveEvent(s, true)), 'primary'],
        ['Skip', () => run((s) => T.resolveEvent(s, false))],
      ], true);
      return;
    }
    const exec = st.cells[n].inmate;
    const victims = T.executionVictims(st, n);
    const rule = st.params.executionSameTier ? 'same-rarity' : 'lower-rarity';
    const detail = victims.length
      ? `The ${T.describe(exec)} in cell ${L(n)} removes ${victims.map((c) => `${T.describe(c.inmate)} (${L(c.n)})`).join(', ')} and rises to ${T.tierName(Math.min(T.RAINBOW, exec.tier + victims.length))}.`
      : `The ${T.describe(exec)} in cell ${L(n)} has no ${rule} prey on the block, so accepting does nothing.`;
    setDecision('Execution', detail, [
      ['Accept', () => run((s) => T.resolveEvent(s, true)), 'primary'],
      ['Skip', () => run((s) => T.resolveEvent(s, false))],
    ], true);
  }

  function renderPending(p) {
    const st = ui.state;
    const back = () => {
      ui.pending = null;
      render();
    };
    if (p.kind === 'patrol') {
      const c = st.cells[p.cell];
      const parts = [];
      if (st.chain) {
        const opens = T.clockwisePath(st, p.cell).filter((k) => st.cells[k].sealed).length;
        parts.push(`Chain reaction: the walk from cell ${L(st.position)} opens ${T.plural(opens, 'sealed door')}, including this one.`);
      } else if (!c.sealed && c.inmate) {
        const count = T.devourOptions(st, p.cell).length;
        parts.push(`The warden walks to the ${T.describe(c.inmate)} in cell ${L(p.cell)}. It then makes today's consume${count ? ` (${T.plural(count, 'target')} from there)` : ', but it has no target from there'}.`);
      } else if (p.cell === T.OFFICE) parts.push(`The warden's office: there you choose Instigate (a new special event (2 when the board has none) on a random cell) or Bestow (1 random inmate rises a tier).`);
      else if (!c.sealed) parts.push('An empty cell: the warden walks there.');
      else if (c.nest) parts.push(`This destroys the rat nest due on day ${c.nest.due}.`);
      else if (c.known === 2) parts.push(`A ${T.describe(c.hidden)} waits inside.`);
      else if (c.known === 1) parts.push(`A ${T.tierName(c.hidden.tier)} inmate waits inside. Its beast is unknown.`);
      else parts.push('The occupant stays unknown until the door opens.');
      if (c.sealed && c.event && c.seen && !st.chain) parts.push('A special event waits behind this door.');
      if (st.tools.includes('keys') && c.sealed && !st.chain) parts.push('Lost Ring of Keys: 80% chance the neighbors open too.');
      const steps = T.stepsBetween(st.position, p.cell);
      if (st.tools.includes('shackles') && steps >= 4) parts.push(`Long-Chained Shackles: a ${steps}-cell walk, so 40% chance a random inmate rises a tier.`);
      if (st.objective.id === 'walk' && !st.milestone) parts.push(`Prison Walk: ${Math.min(T.OBJECTIVES.walk.need, st.objective.progress + steps)}/${T.OBJECTIVES.walk.need} tiles after this walk.`);
      const actions = [[c.sealed || st.chain ? 'Open door' : 'Walk here', () => run((s) => T.patrol(s, p.cell), { select: p.cell }), 'primary']];
      actions.push(['Cancel', cancel]);
      setDecision(`Patrol to cell ${L(p.cell)}?`, parts.join(' '), actions, true);
      return;
    }
    if (p.kind === 'devour') {
      const eater = st.cells[p.from].inmate;
      const option = eater ? T.devourOptions(st, p.from).find((o) => o.cell === p.to) : null;
      if (!option) {
        ui.pending = null;
        renderDecision();
        return;
      }
      const target = st.cells[p.to];
      const { gain, notes, saw, revenge } = T.gainFor(st, p.from, option);
      const to = Math.min(T.RAINBOW, eater.tier + gain);
      const meal = target.sealed ? `the ${T.tierName(target.hidden.tier)} inmate behind the scratched door` : `the ${T.describe(target.inmate)}`;
      const extras = [];
      if (notes.length) extras.push(`Bonus: ${notes.join(', ')}.`);
      extras.push(`This is today’s consume${canSwapNow(st) ? ', and it uses up today’s Replace' : ''}. ${T.canStopChain && T.canStopChain(st) ? 'Afterwards the eater goes on eating: you pick each next meal, or stop the chain, as the game’s Cancel does.' : 'Afterwards the eater must keep eating while it can: a single meal is taken at once, and you pick when there’s a choice.'} Click the target again to consume.`);
      if (saw) extras.push('Rusty Saw may add +1.');
      if (st.tools.includes('whip')) extras.push('Barbed Whip: 35% chance of +1.');
      if (st.tools.includes('collar')) extras.push('Barbed Collar: each bite after this one has an 80% chance of +1.');
      if (revenge) extras.push("Avenger's Casket may open a new meal.");
      if (T.linkOf(st, eater.id) && to < T.RAINBOW && !(T.cageFight && T.cageFight(st))) extras.push('If its beast changes, its prey mark ends.');
      const outcome = to === T.RAINBOW ? 'reaches Rainbow and leaves for the vault' : T.cageFight && T.cageFight(st) ? `rises to ${T.tierName(to)} and stays a ${T.beastName(eater.beast)} (Cage Fight)` : `rises to ${T.tierName(to)}, then its beast re-rolls`;
      setDecision(`Consume, +${gain}?`, `The ${T.describe(eater)} in cell ${L(p.from)} eats ${meal} in cell ${L(p.to)}. It ${outcome}. ${extras.join(' ')}`.trim(), [
        ['Consume', () => run((s) => T.devour(s, p.from, p.to)), 'primary'],
        ['Cancel', back],
      ], true);
      return;
    }
    if (p.kind === 'chain') {
      const eater = st.cells[st.position].inmate;
      const option = st.chaining ? T.chainOptions(st).find((o) => o.cell === p.to) : null;
      if (!option || !eater) {
        ui.pending = null;
        renderDecision();
        return;
      }
      const target = st.cells[p.to];
      const { gain, notes } = T.gainFor(st, st.position, option);
      const to = Math.min(T.RAINBOW, eater.tier + gain);
      const meal = target.sealed ? `the ${T.tierName(target.hidden.tier)} inmate behind the scratched door` : `the ${T.describe(target.inmate)}`;
      const extras = [];
      if (notes.length) extras.push(`Bonus: ${notes.join(', ')}.`);
      if (st.tools.includes('saw')) extras.push('Rusty Saw may add +1.');
      if (st.tools.includes('whip')) extras.push('Barbed Whip: 35% chance of +1.');
      if (st.tools.includes('collar')) extras.push('Barbed Collar: 80% chance of +1.');
      const outcome = to === T.RAINBOW ? 'reaches Rainbow and leaves for the vault' : T.cageFight && T.cageFight(st) ? `rises to ${T.tierName(to)} and stays a ${T.beastName(eater.beast)} (Cage Fight)` : `rises to ${T.tierName(to)}, then its beast re-rolls`;
      setDecision(`Next bite, +${gain}?`, `The ${T.describe(eater)} eats ${meal} in cell ${L(p.to)}. It ${outcome}. ${extras.join(' ')}`.trim(), [
        ['Eat it', () => run((s) => T.chainBite(s, p.to), { select: st.position }), 'primary'],
        ...(T.canStopChain && T.canStopChain(st) ? [['Stop the chain', () => run((s) => T.stopChain(s), { select: st.position })]] : []),
        ['Back', back],
      ], true);
      return;
    }
    if (p.kind === 'swap') {
      const cell = st.cells[p.cell];
      if (!cell.inmate) {
        ui.pending = null;
        renderDecision();
        return;
      }
      const kin = st.tools.includes('pestle') ? ' of the same beast (Iron Pestle)' : st.params.swapNewBeast ? ' of another beast' : '';
      const parts = [`A brand-new random inmate${kin} replaces the ${T.describe(cell.inmate)}. It can come out stronger or weaker.`];
      if (st.tools.includes('rope')) parts.push("Hangman's Noose: never Normal or Magic.");
      if (st.tools.includes('axe')) parts.push(`Gaoler's Execution Axe: if it comes out above ${T.tierName(cell.inmate.tier)}, 2 random sealed cells open.`);
      if (cell.ivory) parts.push(`Tusk cell: ${T.plural(st.params.ivoryCount, 'inmate')} then gain a tier.`);
      if (T.canDevourNow(st)) parts.push('It uses up today’s consume: a day has a Replace or a consume, not both.');
      setDecision(`Replace the inmate in cell ${L(p.cell)}?`, parts.join(' '), [
        ['Replace', () => run((s) => T.swap(s, p.cell)), 'primary'],
        ['Cancel', back],
      ], true);
      return;
    }
    if (p.kind === 'hunt') {
      const targets = T.huntTargets(st);
      if (!targets.length) {
        ui.pending = null;
        renderDecision();
        return;
      }
      setDecision('Hunt: which inmate gets the Prey mark?', `The Lion in cell ${L(st.position)} and its prey each rise a tier every morning for ${T.plural(st.params.preyRounds, 'morning')}, while both stay on the block and keep their beasts. It uses up today’s consume or Replace.`, [
        ...targets.map((n) => [`The ${T.describe(st.cells[n].inmate)} in ${L(n)}`, () => run((s) => T.hunt(s, n), { select: st.position }), 'primary']),
        ['Cancel', back],
      ], true);
      return;
    }
    if (p.kind === 'end') {
      const lead = p.last ? `Day ${st.day} is the last day. Ending it closes the run.` : '';
      setDecision(p.last ? 'Finish the run?' : `End day ${st.day}?`, [lead, ...p.warnings].filter(Boolean).join(' '), [
        [p.last ? 'Finish run' : 'End day', () => run((s) => T.endDay(s), { select: null }), 'primary'],
        ['Cancel', cancel],
      ], true);
    }
  }

  function renderSelection(cell) {
    const st = ui.state;
    const actions = [];
    const free = !blocked(st);
    if (cell.n === T.OFFICE) {
      setDecision(`Cell ${L(cell.n)}: the warden's office`, `Every run starts here, and no inmate, marker or event is ever held in it. It can be one of the morning's destinations: walking here, you choose Instigate (a new special event (2 when the board has none) on a random cell) or Bestow (1 random inmate rises a tier).`, [['Deselect', cancel]]);
      return;
    }
    if (cell.sealed) {
      const parts = [];
      if (cell.nest) parts.push(`A rat nest. It hatches a ${T.tierName(st.params.nestTier)} Rat on the morning of day ${cell.nest.due}. Opening it earlier destroys it.`);
      else if (cell.known === 2) parts.push(`A ${T.describe(cell.hidden)} waits inside.`);
      else if (cell.known === 1) parts.push(`A ${T.tierName(cell.hidden.tier)} inmate waits inside. Its beast is unknown.`);
      else parts.push('The occupant is unknown.');
      if (cell.scratch) parts.push(`A ${T.tierName(cell.hidden.tier)} Wolf can consume it through the scratched door.`);
      if (cell.event && cell.seen) parts.push('A special event waits behind this door. It triggers only when a patrol opens it.');
      if (free && st.phase === 'patrol' && !st.destinations.includes(cell.n)) parts.push('It is not one of today’s destinations.');
      actions.push(['Deselect', cancel]);
      setDecision(`Cell ${L(cell.n)}: sealed`, parts.join(' '), actions);
      return;
    }
    if (!cell.inmate) {
      setDecision(`Cell ${L(cell.n)}: empty`, 'This cell stays empty for the rest of the run.', [['Deselect', cancel]]);
      return;
    }
    const inmate = cell.inmate;
    // Mammoths and Lions also eat their second meal (from the Lab's rarity up).
    const eats = T.eatsOf(st, inmate.beast, inmate.tier).map(T.beastName);
    if (inmate.beast === 'rat' && st.tools.includes('skewer')) eats.push('Rat');
    const parts = [`Eats ${eats.join(' and ')} of the same rarity.`];
    if (inmate.beast === 'wolf') parts.push('Can also consume through scratched doors.');
    if (st.phase === 'patrol') parts.push('Patrol first. Then the inmate in the warden’s cell can consume.');
    else if (st.phase === 'manage') {
      const options = T.devourOptions(st, cell.n);
      if (cell.n !== st.position) parts.push(`Only the inmate in the warden's cell (${L(st.position)}) can start today's consume.`);
      else if (!T.canDevourNow(st)) parts.push(st.used.swap > 0 ? 'You replaced an inmate today, so there is no consume: a day has one or the other.' : 'Today’s consume is used.');
      else parts.push(options.length ? `It stands in the warden's cell: ${T.plural(options.length, 'target')} highlighted. Double-click one to consume it, or click once to preview the bite.` : 'It stands in the warden’s cell but has no target right now.');
    }
    if (cell.ivory) parts.push(`Tusk cell: replacing the inmate here raises ${T.plural(st.params.ivoryCount, 'inmate')} a tier.`);
    const link = T.linkOf(st, inmate.id);
    if (link) {
      const hunter = link.lion === inmate.id;
      const other = T.cellOf(st, hunter ? link.prey : link.lion);
      parts.push(`${hunter ? `Hunting cell ${other ? L(other.n) : '--'}` : `Prey of the Lion in cell ${other ? L(other.n) : '--'}`}: both rise a tier on each of the next ${T.plural(link.rounds, 'morning')}.`);
    }
    if (free && st.phase === 'manage' && cell.n === st.position) {
      const left = canSwapNow(st) ? st.params.swapsPerDay - st.used.swap : 0;
      actions.push([`Replace (${Math.max(0, left)} left)`, () => askSwap(cell.n), null, left <= 0]);
    } else if (st.phase === 'manage') parts.push("Only the inmate in the warden's cell can be replaced.");
    actions.push(['Deselect', cancel]);
    setDecision(`Cell ${L(cell.n)}: ${T.describe(inmate)}`, parts.join(' '), actions);
  }

  // ---------- Rendering: frame and ledger ----------

  function renderTop() {
    const st = ui.state;
    $('mode-chip').textContent = `${modeName(st)} · ${st.seed}`;
    $('day-num').textContent = String(st.day).padStart(2, '0');
    $('day-of').textContent = `/ ${st.maxDays}`;
    const pill = $('phase-pill');
    const phase = st.phase === 'ended' ? 'Handed off' : st.phase === 'patrol' ? 'Patrol' : st.phase === 'event' ? 'Event' : 'Manage';
    pill.textContent = phase;
    pill.className = 'phase' + (st.phase === 'ended' ? ' is-ended' : st.phase === 'patrol' ? '' : ' is-manage');
    const left = st.maxDays - st.day;
    $('handoff').textContent = st.phase === 'ended' ? 'Run complete' : left === 0 ? 'Last day' : `${T.plural(left, 'day')} after today`;
  }

  function renderActions() {
    const st = ui.state;
    const free = !blocked(st);
    const swapBtn = $('btn-swap');
    // A day has a devour or a swap, not both.
    const left = canSwapNow(st) ? Math.max(0, st.params.swapsPerDay - st.used.swap) : 0;
    const here = st.cells[st.position];
    const canSwap = free && st.phase === 'manage' && left > 0 && !here.sealed && !!here.inmate;
    swapBtn.textContent = `Replace (${left})`;
    swapBtn.disabled = !canSwap;
    swapBtn.title = canSwap ? `Replace the inmate in the warden's cell (${L(st.position)}).${T.canDevourNow(st) ? " It uses up today's consume." : ''}` : st.used.devour > 0 ? 'You consumed today: a day has a consume or a Replace, not both.' : "Only the inmate in the warden's cell can be replaced, after the patrol.";
    // The Blood-Stained Trap's Hunt, the day's third choice on a Lion.
    const huntBtn = $('btn-hunt');
    const canHunt = free && !!T.canHuntNow && T.canHuntNow(st);
    huntBtn.hidden = !st.tools.includes('trap');
    huntBtn.disabled = !canHunt;
    huntBtn.title = canHunt ? "Blood-Stained Trap: the Lion in the warden's cell puts a Prey mark on an inmate it can consume. It uses up today's consume or Replace." : "With the Blood-Stained Trap, a Hunt works when the warden stands on a Lion that has an inmate to consume, before today's consume or Replace.";

    $('btn-undo').disabled = !ui.history.length;
    const endBtn = $('btn-end');
    endBtn.disabled = !free || st.phase !== 'manage';
    endBtn.textContent = st.day >= st.maxDays ? 'Finish run' : 'End day';
  }

  function renderLog() {
    const st = ui.state;
    const list = $('log');
    const last = st.log[st.log.length - 1];
    const key = `${st.log.length}|${last ? last.t : ''}|${st.seed}`;
    if (list.dataset.key === key) return;
    list.dataset.key = key;
    const items = [];
    let day = null;
    for (let i = st.log.length - 1; i >= 0; i--) {
      const e = st.log[i];
      if (e.d !== day) {
        day = e.d;
        items.push(`<li class="log-day">Day ${String(e.d).padStart(2, '0')}</li>`);
      }
      // A devour also shows its bites as icons; the text says the same.
      const icons = e.x && e.x.type === 'devour' ? `<span class="log-icons" aria-hidden="true">${chainStrip(e.x)}</span>` : '';
      items.push(`<li class="log-entry k-${esc(e.k)}"><span class="log-text">${esc(e.t)}${icons}</span></li>`);
    }
    list.innerHTML = items.join('') || '<li class="log-empty">Nothing logged yet.</li>';
  }

  // ---------- Beast icons and the day recap ----------

  // A small portrait in its rarity color. Meals are struck through, and a
  // Rainbow gets the rainbow ring.
  function tok(who, opts) {
    const o = opts || {};
    const cls = ['tok', `t${who.tier}`];
    if (o.eaten) cls.push('is-eaten');
    if (who.tier >= T.RAINBOW) cls.push('is-rainbow');
    const title = `${T.describe(who)}${o.cell !== undefined ? `, cell ${L(o.cell)}` : ''}${o.eaten ? ', eaten' : ''}`;
    return `<span class="${cls.join(' ')}" title="${esc(title)}">${PORTRAITS[who.beast]}</span>`;
  }

  // A devour as icons: each bite is the eater, its fangs with the tiers it
  // gained, and the meal. Every bite re-rolls the eater, so the next bite
  // starts from its new form, and the strip ends with how it finished.
  function chainStrip(x) {
    const then = '<span class="then">›</span>';
    const bites = x.bites.map((b) => `<span class="bite">${tok(b.eater, { cell: b.from })}<span class="fang">${FANGS}<b>+${b.gain}</b></span>${tok(b.meal, { cell: b.cell, eaten: true })}</span>`);
    const end = x.bites[x.bites.length - 1].after;
    return `<span class="chain-strip">${bites.join(then)}${then}${tok(end)}${end.tier >= T.RAINBOW ? '<span class="vault-note">Vault</span>' : ''}</span>`;
  }

  // Each morning the recap under the ring looks back at yesterday; after the
  // patrol it follows today. On day 1 the patrol hint has the space.
  function renderRecap() {
    const st = ui.state;
    const day = st.phase === 'patrol' ? st.day - 1 : st.day;
    const items = day >= 1 ? recapItems(st, day) : [];
    const box = $('day-recap');
    box.hidden = !items.length;
    $('dest-hint').hidden = items.length > 0;
    if (!items.length) return;
    $('recap-title').textContent = st.phase === 'patrol' || st.phase === 'ended' ? `Day ${String(day).padStart(2, '0')} recap` : 'Today so far';
    setHTML($('recap-items'), items.join(''));
  }

  function recapItems(st, day) {
    const item = (label, body, cls) => `<li class="recap-item${cls ? ` ${cls}` : ''}"><span class="recap-label">${esc(label)}</span>${body}</li>`;
    const records = st.log.filter((e) => e.d === day && e.x).map((e) => e.x);
    const out = [];
    for (let i = 0; i < records.length; i++) {
      const x = records[i];
      if (x.type === 'open' && x.side) {
        // Doors opened together (Ring of Keys, a chain reaction) share one item.
        const group = [x];
        while (records[i + 1] && records[i + 1].type === 'open' && records[i + 1].side) group.push(records[++i]);
        out.push(item(group.length === 1 ? `Also opened ${L(x.cell)}` : `${group.length} extra doors`, group.map((g) => tok(g.who, { cell: g.cell })).join('')));
      } else if (x.type === 'open') out.push(item(`Opened ${L(x.cell)}`, tok(x.who, { cell: x.cell })));
      else if (x.type === 'walk') out.push(item(`Walked to ${L(x.cell)}`, x.who ? tok(x.who, { cell: x.cell }) : ''));
      else if (x.type === 'sweep') out.push(item(`Chain walk ${L(x.from)} to ${L(x.cell)}`, ''));
      else if (x.type === 'armed') out.push(item('Chain reaction armed', ''));
      else if (x.type === 'trickster') out.push(item('Behind Closed Doors', `${tok(x.who, { cell: x.cell })}<span class="then">›</span>${tok(x.after, { cell: x.cell })}`));
      else if (x.type === 'shackles') out.push(item('Shackles +1', tok(x.who, { cell: x.cell })));
      else if (x.type === 'appetite') out.push(item(`Ravenous Appetite +${x.gain}`, `${tok(x.who, { cell: x.cell })}<span class="then">›</span>${tok(x.after, { cell: x.cell })}`));
      else if (x.type === 'convict') out.push(item('High-Risk Convict', x.cell === null ? '<span class="recap-note">no cell left</span>' : `<span class="recap-note">cell ${L(x.cell)}</span>`));
      else if (x.type === 'crow') out.push(item('Crow Whispers', `<span class="recap-note">${x.cells.length ? `rarity shown at ${x.cells.map(L).join(', ')}` : 'nothing left to show'}</span>`));
      else if (x.type === 'hunt') out.push(item(T.eventName('hunt'), `<span class="recap-note">${[x.cells.length ? `low rarity shown at ${x.cells.map(L).join(', ')}` : '', x.high.length ? `Rare or better at ${x.high.map(L).join(', ')}` : ''].filter(Boolean).join('; ') || 'no locked cell left'}</span>`));
      else if (x.type === 'usurp1' || x.type === 'usurp2' || x.type === 'portion') out.push(item(T.eventName(x.type), x.raised.length ? x.raised.map((r) => tok(r.who, { cell: r.cell })).join('') : '<span class="recap-note">no one</span>'));
      else if (x.type === 'freedom') out.push(item('Taste of Freedom', `<span class="recap-note">${x.cells.length ? `opened ${x.cells.map(L).join(', ')}` : 'no locked cell left'}</span>`));
      else if (x.type === 'instigate') out.push(item('Instigate', `<span class="recap-note">${x.cells.length ? `events at ${x.cells.map(L).join(', ')}` : 'no free door'}</span>`));
      else if (x.type === 'bestow') out.push(item('Bestow +1', x.who ? tok(x.who, { cell: x.cell }) : '<span class="recap-note">no one</span>'));
      else if (x.type === 'objective') out.push(item('Objective met', `<span class="recap-note">${esc(T.OBJECTIVES[x.id].name)}</span>`));
      else if (x.type === 'skipped') out.push(item(`Skipped ${x.name}`, ''));
      else if (x.type === 'execution') {
        const took = x.victims.length ? `<span class="fang">${FANGS}<b>×${x.victims.length}</b></span>${x.victims.map((v) => tok(v, { eaten: true })).join('')}` : '<span class="recap-note">no one</span>';
        out.push(item('Execution', `${tok(x.who, { cell: x.cell })}${took}`, 'is-devour'));
      } else if (x.type === 'devour') out.push(item(x.bites.length > 1 ? `Chain ×${x.bites.length}` : 'Consume', chainStrip(x), 'is-devour'));
      else if (x.type === 'swap') out.push(item(`Replace ${L(x.cell)}`, `${tok(x.old, { cell: x.cell, eaten: true })}<span class="then">›</span>${tok(x.fresh, { cell: x.cell })}`));
      else if (x.type === 'rainbow') out.push(item('Rainbow', tok(x.who), 'is-rainbow'));
      else if (x.type === 'tool') out.push(item('Tool', `<span class="recap-note">${esc(T.toolName(x.id))}</span>`));
      else if (x.type === 'gift') out.push(item('Treasure', `<span class="recap-note">${esc(T.toolName(x.id))}</span>`));
      else if (x.type === 'ivory') out.push(item('Tusk', `<span class="recap-note">${T.plural(x.count, 'inmate')} +1</span>`));
    }
    return out;
  }

  function facts(pairs) {
    return pairs.map(([k, v, text]) => `<div><dt>${esc(k)}</dt><dd${text ? ' class="is-text"' : ''}>${esc(v)}</dd></div>`).join('');
  }

  function renderGoal() {
    const st = ui.state;
    const board = T.boardInmates(st);
    renderObjective(st);
    $('goal-title').textContent = st.scenario === 'empty' ? 'Rules drill' : T.SCENARIOS[st.scenario].name;
    $('goal-text').textContent = `Raise as many inmates to Rainbow as you can before the run ends on day ${st.maxDays}. Seed ${st.seed}.`;
    const best = Math.max(st.vault.length ? T.RAINBOW : 0, ...board.map((i) => i.tier), 0);
    $('goal-facts').innerHTML = facts([
      ['Rainbows', st.vault.length],
      ['Best now', board.length || st.vault.length ? T.tierName(best) : '—', true],
      ['On block', board.length],
    ]);
  }

  // The run's objective, as the live game shows it, with its progress.
  function renderObjective(st) {
    const o = st.objective;
    const def = T.OBJECTIVES[o.id];
    const done = st.milestone;
    const status = done ? 'Done' : o.id === 'walk' ? `${o.progress}/${def.need}` : 'Not yet';
    const reward = !st.params.rewards ? 'Rewards are off for this drill.' : done ? 'Its tool is earned.' : 'Meeting it earns a tool.';
    const bar = o.id === 'walk' ? `<span class="objective-bar${done ? ' is-done' : ''}"><span style="width:${Math.round((100 * o.progress) / def.need)}%"></span></span>` : '';
    // A card shown before the run (Cage Fight, Iron Law), besides its objective.
    const card = st.startEvent && T.START_EVENTS ? T.START_EVENTS[st.startEvent] : null;
    const cardHTML = card ? `<p class="objective-head"><span class="objective-tag">Start of run</span><span class="objective-name">${esc(card.name)}</span></p><p class="objective-text">${esc(card.text)}.</p>` : '';
    setHTML($('goal-objective'), `<p class="objective-head"><span class="objective-tag">Objective</span><span class="objective-name">${esc(def.name)}</span><span class="objective-status${done ? ' is-done' : ''}">${esc(status)}</span></p><p class="objective-text">${esc(def.text)}. ${esc(reward)}</p>${bar}${cardHTML}`);
  }

  function renderVault() {
    const st = ui.state;
    const slots = Math.max(5, st.vault.length + 1);
    let html = '';
    for (let i = 0; i < slots; i++) {
      const v = st.vault[i];
      html += v
        ? `<span class="vault-slot is-filled" title="Rainbow ${esc(T.beastName(v.beast))}, contained on day ${v.day}"><span>${PORTRAITS[v.beast]}</span></span>`
        : '<span class="vault-slot" aria-hidden="true"></span>';
    }
    $('vault').innerHTML = html;
    const cache = st.params.rewards ? `Warden's Treasure gifts earned: ${st.cache}.` : `Warden's Treasure claims: ${st.cache}.`;
    $('vault-note').textContent = st.vault.length
      ? `${T.plural(st.vault.length, 'Rainbow')} in the vault. ${cache}`
      : st.params.rewards
        ? "Inmates that reach Rainbow leave the block and wait here. Each one opens the Warden's Treasure, where you pick a gift."
        : "Inmates that reach Rainbow leave the block and wait here. Each one adds a Warden's Treasure claim.";
  }

  function renderTools() {
    const st = ui.state;
    const list = $('tool-list');
    if (!st.tools.length) {
      const empty = st.params.rewards ? 'No tools yet. Meeting the objective earns one. The Lab can add more, or change the starting picks.' : 'Rewards are off for this drill. Add tools in the Lab to test them.';
      list.innerHTML = `<li class="tool-text">${empty}</li>`;
      return;
    }
    list.innerHTML = st.tools.map((id) => `<li class="tool"><span class="tool-name">${esc(T.toolName(id))}</span><span class="tool-text">${esc(T.toolText(id))}</span></li>`).join('');
  }

  function tipAction(tip) {
    switch (tip.kind) {
      case 'patrol':
        return ['Go', () => run((s) => T.patrol(s, tip.cell), { select: tip.cell })];
      case 'devour':
        return ['Consume', () => run((s) => T.devour(s, tip.from, tip.to), { select: tip.from })];
      case 'chain':
        return ['Eat', () => run((s) => T.chainBite(s, tip.to), { select: tip.from })];
      case 'stopchain':
        return ['Stop', () => run((s) => T.stopChain(s), { select: tip.from })];
      case 'office':
        return [tip.choice === 'bestow' ? 'Bestow' : 'Instigate', () => run((s) => T.officeAct(s, tip.choice))];
      case 'swap':
        return ['Replace', () => run((s) => T.swap(s, tip.cell))];
      case 'event':
        return [ui.state && ui.state.event && ui.state.event.kind === 'hunt' ? 'Confirm' : tip.accept ? 'Accept' : 'Skip', () => run((s) => T.resolveEvent(s, tip.accept))];
      case 'choose':
        return ['Take', () => run((s) => T.choose(s, tip.id))];
      case 'end':
        return ['End day', askEndDay];
      default:
        return null;
    }
  }

  // ---------- Trainer ----------

  // The trainer panel: the recommended move right away (the trained strategy's
  // pick), then a live check that plays every option out many times from the
  // current position with js/solver.js, and a grade for each move you make.
  // The playouts run in a Web Worker when the page allows one, and on this
  // thread otherwise. Moves are scored by the Rainbows vaulted by the end of
  // the run.
  const SOLVER_ROLLOUTS = 800;
  const SOLVER_ROLLOUTS_HERE = 300;
  const LIVE_MIN = 150; // playouts per option before the live check leads
  const SWITCH_MIN = 0.05; // Rainbows a live pick must gain over the strategy's to replace it
  const solver = { worker: null, failed: false, id: 0, key: '', stateKey: '', result: null, instantKey: '', instant: null };

  const solverKey = (st) => {
    const last = st.log[st.log.length - 1];
    return [st.seed, st.day, st.phase, st.position, st.log.length, last ? last.t : '', st.pending.length, st.used.swap, st.used.devour, st.vault.length].join('|');
  };

  const solverFits = (st) => st && st.phase !== 'ended';

  // A stable name for an action, for lists that update in place.
  const actionKey = (a) => [a.type, a.cell, a.to, a.id, a.accept, a.choice].join('|');

  // What the training found for each kind of decision. When the run uses the
  // same food chain as the guide's data (js/guide-data.js), lessons quote
  // its numbers; otherwise they give the advice without numbers.
  const LESSONS = {
    patrol: 'Training: opening doors and walking further vaulted more Rainbows than walking to an inmate with nothing to eat.',
    devour: 'Training: consume every day you can, unless it breaks a prey mark. Waiting for a bigger chain cost Rainbows.',
    swap: 'Training: replace a low-tier inmate in the warden’s cell when no consume there is worth more, since a day has one or the other. Never replacing cost Rainbows.',
    end: 'Training: end the day once nothing here gains.',
    chain: 'Training: accepting Chain reactions vaulted more Rainbows than skipping them.',
    execution: 'Training: accept an Execution only when it gains more than it removes.',
    trickster: 'Behind Closed Doors makes a Supreme for free: accept it unless the inmate already is one.',
    appetite: 'Ravenous Appetite only adds tiers: accept it.',
    convict: 'High-Risk Convict opens a cell on a Legendary for free: accept it.',
    crow: 'Crow Whispers costs nothing: accept it, then aim your patrols at the higher rarities it shows.',
    freedom: 'Taste of Freedom opens 3 doors for free: accept it.',
    portion: 'Extra Portion raises up to 3 inmates for free: accept it.',
    usurp1: 'Usurpation I raises an inmate for free, and brings Usurpation II: accept it.',
    usurp2: 'Usurpation II raises two inmates for free, and brings Usurpation III: accept it.',
    usurp3: 'Usurpation III raises two inmates 2 tiers each, and brings Usurpation IV: accept it.',
    usurp4: 'Usurpation IV raises every inmate 2 tiers: accept it.',
    ratway: 'The Sewer Ratway is a free move to any cell but the office: accept it, then take the best door or inmate on the whole block.',
    hunt: 'The "Treasure" Hunt costs nothing: confirm it, then aim your patrols at the doors it leaves dark, which hold Rare or better.',
    office: 'At the office, Bestow when a raise helps now, and Instigate when the block needs new doors with events.',
    chainPick: 'You pick each meal of a chain, or stop it with Cancel: take the meal that keeps the chain fed at the next tier, and stop only when every meal would cost more than it gains.',
    gift: 'Training: picking the gift that fits the board beat always taking the same one.',
  };

  function guideFor(st) {
    const g = window.TARTARUS_GUIDE;
    return g || null;
  }

  function lessonFor(st, action) {
    const g = guideFor(st);
    const habit = (id) => (g ? g.habits.find((h) => h.id === id) : null);
    const full = habit('full');
    const vs = (id, text) => {
      const h = habit(id);
      return full && h ? `${text} (${h.value.toFixed(2)} Rainbows per run, against ${full.value.toFixed(2)})` : null;
    };
    if (st.pending.length) {
      if (st.pending[0].kind === 'gift') return LESSONS.gift;
      const names = window.TartarusSolver.paramsFor(st).toolRank.map((id) => T.toolName(id));
      return `Training: take the instrument that adds the most to the ones you hold, measured over millions of runs with each pair and set. On its own, the order is ${names.join(', ')}.`;
    }
    if (st.phase === 'event' && st.event) {
      if (st.event.kind === 'chain') return (vs('skipChain', 'Training: skipping Chain reactions cost Rainbows') || LESSONS.chain) + (g ? '.' : '');
      return LESSONS[st.event.kind] || LESSONS.execution;
    }
    if (st.phase === 'office') return LESSONS.office;
    if (st.chaining) return LESSONS.chainPick;
    if (st.phase === 'patrol') return LESSONS.patrol;
    if (!action) return '';
    if (action.type === 'devour') return (vs('wait2', 'Training: consume every day you can, unless it breaks a prey mark. Waiting for a bigger chain cost Rainbows') || LESSONS.devour) + (g ? '.' : '');
    if (action.type === 'swap') {
      // Without tools, never swapping can come out about even.
      const never = habit('neverSwap');
      if (full && never && full.value - never.value < 0.01) return `Training: replace a low-tier inmate in the warden’s cell when no consume there is worth more, since a day has one or the other. Without tools it came out about even with never replacing (${never.value.toFixed(2)} Rainbows per run, against ${full.value.toFixed(2)}), but Replaces are what the Severed Iron Maiden, the Scapegoat’s Guillotine and the Burning Stake work on.`;
      // "The most" only while the guide's data still has never swapping as
      // the costliest habit.
      const worst = g ? g.habits.filter((h) => h.id !== 'simple' && h.id !== 'random').sort((a, b) => a.value - b.value)[0] : null;
      const text = `Training: replace a low-tier inmate in the warden’s cell when no consume there is worth more, since a day has one or the other. Never replacing cost ${worst && worst.id === 'neverSwap' ? 'the most' : 'Rainbows'}`;
      return (vs('neverSwap', text) || LESSONS.swap) + (g ? '.' : '');
    }
    return LESSONS[action.type] || '';
  }

  function startSolver() {
    const st = ui.state;
    const key = solverKey(st);
    if (key === solver.key) return;
    solver.key = key;
    solver.stateKey = key;
    solver.id += 1;
    solver.result = null;
    const id = solver.id;
    const state = Object.assign({}, st, { log: [] });
    if (!solver.worker && !solver.failed) {
      try {
        solver.worker = new Worker(`js/solver-worker.js${SCRIPT_QUERY}`);
        solver.worker.onmessage = (e) => {
          if (e.data.id !== solver.id) return;
          solver.result = e.data.result;
          renderSolver();
          renderHints();
        };
        solver.worker.onerror = () => {
          // Fall back to this thread, and redo the current position.
          solver.failed = true;
          solver.worker = null;
          solver.key = '';
          if (ui.prefs.advisor && solverFits(ui.state)) startSolver();
        };
      } catch (e) {
        solver.failed = true;
        solver.worker = null;
      }
    }
    if (solver.worker) solver.worker.postMessage({ id, state: JSON.parse(JSON.stringify(state)), rollouts: SOLVER_ROLLOUTS });
    else solveHere(id, state);
  }

  function solveHere(id, state) {
    const job = window.TartarusSolver.solve(JSON.parse(JSON.stringify(state)), { rollouts: SOLVER_ROLLOUTS_HERE, seed: (id * 7919 + 1) >>> 0 });
    const tick = () => {
      if (id !== solver.id) return;
      solver.result = job.step(12);
      renderSolver();
      renderHints();
      if (!solver.result.done) setTimeout(tick, 16);
    };
    setTimeout(tick, 0);
  }

  // The live check's result for this position, if it has one.
  const liveResult = (st) => (solver.stateKey === solverKey(st) ? solver.result : null);

  // The trained strategy's pick for this position, worked out once.
  function instantPick(st) {
    const key = solverKey(st);
    if (solver.instantKey !== key) {
      solver.instantKey = key;
      try {
        solver.instant = window.TartarusSolver.instant(st);
      } catch (e) {
        solver.instant = null;
      }
    }
    return solver.instant;
  }

  // The move to recommend: the strategy's instant pick, unless the live check
  // finds a clearly better move (by more than its paired margin of error), so
  // the recommendation doesn't flicker between near-equal options.
  function recommendation(st) {
    if (!ui.prefs.advisor || !solverFits(st)) return null;
    const S = window.TartarusSolver;
    const pick = instantPick(st);
    const r = liveResult(st);
    const ranked = r ? r.options : [];
    const live = r && ranked.length > 1 && (r.done || r.rounds >= LIVE_MIN) ? ranked[0] : null;
    if (!live) return pick ? Object.assign({ live: false }, pick) : null;
    const mine = pick && ranked.find((o) => S.sameAction(o.action, pick.action));
    // A better move must also win by a margin worth playing for: shared dice
    // make the paired margin narrow, and a near tie flips the advice.
    if (mine && (mine === live || live.mean - mine.mean <= Math.max(1.96 * mine.gapSe, SWITCH_MIN))) {
      const why = mine === live ? pick.why : `${pick.why} The live check rates it about equal to the best.`;
      return Object.assign({ live: true, rounds: r.rounds }, pick, { label: mine.label, why, option: mine });
    }
    return { action: live.action, label: live.label, why: `The playouts found a better move than the strategy’s pick${pick ? ` (${pick.label})` : ''}.`, live: true, rounds: r.rounds, option: live };
  }

  function playSolverMove(action) {
    const st = ui.state;
    if (!action || !st) return;
    if (action.type === 'patrol') run((s) => window.TartarusSolver.apply(s, action), { select: action.cell });
    else if (action.type === 'devour' || action.type === 'chain' || action.type === 'stopchain' || action.type === 'swap') run((s) => window.TartarusSolver.apply(s, action), { select: st.position });
    else if (action.type === 'end') run((s) => T.endDay(s), { select: null });
    else run((s) => window.TartarusSolver.apply(s, action));
  }

  // ---------- Grading your moves ----------

  function trainerFor(st) {
    if (!ui.trainer || ui.trainer.seed !== st.seed) ui.trainer = { seed: st.seed, moves: 0, good: 0, lost: 0, last: null };
    return ui.trainer;
  }

  // Grades the move just made against the live check of the position before
  // it. Called by run() after a move succeeds.
  function gradeMove(snapshot) {
    if (!ui.prefs.advisor) return;
    const before = T.deserialize(snapshot);
    if (!solverFits(before)) return;
    const move = window.TartarusSolver.moveBetween(before, ui.state);
    if (!move) return;
    const t = trainerFor(ui.state);
    const r = solver.stateKey === solverKey(before) ? solver.result : null;
    if (!r || r.options.length < 2 || r.rounds < 60) {
      t.last = r && r.options.length < 2 ? null : { verdict: 'pending' };
      return;
    }
    const best = r.options[0];
    const chosen = r.options.find((o) => window.TartarusSolver.sameAction(o.action, move));
    if (!chosen) {
      t.last = null;
      return;
    }
    const loss = Math.max(0, best.mean - chosen.mean);
    const verdict = window.TartarusSolver.sameAction(chosen.action, best.action) ? 'best' : loss <= Math.max(1.96 * chosen.gapSe, SWITCH_MIN) ? 'close' : 'costly';
    t.moves += 1;
    if (verdict === 'costly') t.lost += loss;
    else t.good += 1;
    t.last = { verdict, loss, chosen: chosen.label, best: best.label, chosenOpt: chosen, bestOpt: best };
  }

  // An option's expected Rainbows, with its 95% margin.
  function fmtOption(o) {
    return `${o.mean.toFixed(2)}${o.n > 1 ? ` ±${(1.96 * o.se).toFixed(2)}` : ''}`;
  }

  function renderGrade(st) {
    const box = $('trainer-grade');
    const t = ui.trainer && ui.trainer.seed === st.seed ? ui.trainer : null;
    box.hidden = !t || (!t.last && !t.moves);
    if (box.hidden) return;
    let html = '';
    const last = t.last;
    if (last && last.verdict === 'pending') {
      html += '<p class="trainer-eyebrow">Your last move</p><p class="trainer-verdict">Not graded: the trainer was still checking that position.</p>';
    } else if (last) {
      const title = last.verdict === 'best' ? 'The best move ✓' : last.verdict === 'close' ? 'Close to the best ✓' : `Cost about ${last.loss.toFixed(2)} Rainbows`;
      const detail = last.verdict === 'best'
        ? `${esc(last.chosen)}: ${esc(fmtOption(last.chosenOpt))} expected.`
        : `You chose ${esc(last.chosen)} (${esc(fmtOption(last.chosenOpt))}). The trainer preferred ${esc(last.best)} (${esc(fmtOption(last.bestOpt))}).${last.verdict === 'close' ? ' That’s within the margin of error.' : ''}`;
      html += `<p class="trainer-eyebrow">Your last move</p><p class="trainer-verdict is-${last.verdict}">${esc(title)}</p><p class="trainer-detail">${detail}</p>`;
    }
    if (t.moves) {
      const given = t.lost > 0.005 ? `, about ${t.lost.toFixed(2)} expected Rainbows given up` : '';
      html += `<p class="trainer-session">This run: ${t.good} of ${T.plural(t.moves, 'graded move')} best or close${given}.</p>`;
    }
    setHTML(box, html);
  }

  // Updates a list in place: rows are kept by key, so a button under the
  // pointer survives the many refreshes of a live check.
  function syncRows(list, items, keyOf, make, fill) {
    const old = new Map();
    for (const li of list.children) old.set(li.dataset.key, li);
    const keep = new Set();
    items.forEach((item, i) => {
      const key = keyOf(item);
      let li = old.get(key);
      if (!li) {
        li = make(item);
        li.dataset.key = key;
      }
      fill(li, item);
      keep.add(key);
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    });
    for (const [key, li] of old) if (!keep.has(key)) li.remove();
  }

  function renderSolver() {
    const st = ui.state;
    if (!ui.prefs.advisor || !solverFits(st)) return;
    const S = window.TartarusSolver;
    const r = liveResult(st);
    const options = r ? r.options : [];

    // The recommendation, then the lesson from training for this decision.
    // The box and its button stay put; only their contents change.
    const rec = recommendation(st);
    const pickBox = $('trainer-pick');
    if (rec) {
      pickBox.hidden = false;
      const source = rec.live ? `Checked by ${rec.rounds.toLocaleString()} playouts per option` : 'Instant pick from training · checking…';
      // The move and its button come first, so the button holds still while
      // the live check's numbers below it change.
      setHTML($('trainer-pick-head'), `<p class="trainer-eyebrow">Recommended</p><p class="trainer-move">${esc(rec.label)}</p>`);
      setHTML($('trainer-pick-body'), `<p class="trainer-source">${esc(source)}</p>${rec.why ? `<p class="trainer-why">${esc(rec.why)}</p>` : ''}<p class="trainer-lesson">${esc(lessonFor(st, rec.action))}</p>`);
    } else {
      pickBox.hidden = true;
    }
    renderGrade(st);

    // The live check: every option with its expected result.
    const status = $('solver-status');
    if (!r) status.textContent = 'Live check: starting…';
    else if (options.length <= 1) status.textContent = options.length ? 'Only one move here.' : 'Nothing to decide right now.';
    else status.textContent = r.done ? `Live check: ${r.rounds.toLocaleString()} playouts per option` : `Live check: ${r.rounds.toLocaleString()} playouts per option so far…`;
    const top = options[0];
    const second = options[1];
    const max = Math.max(0.01, ...options.map((o) => o.mean));
    const close = top && second && top.mean - second.mean < Math.max(1.96 * second.gapSe, SWITCH_MIN);
    const shown = options.length > 1 ? options : [];
    syncRows(
      $('solver-list'),
      shown,
      (o) => actionKey(o.action),
      () => {
        const li = document.createElement('li');
        li.className = 'solver-row';
        li.innerHTML = '<span class="solver-label"><span class="solver-text"></span><span class="solver-tag" title="The trained strategy picks this move without simulating." hidden>strategy</span></span><span class="solver-value" title="Expected Rainbows vaulted by the end of the run, with a 95% margin"></span><span class="solver-meter"><span></span></span><span class="solver-sub" hidden></span>';
        li.btn = makeButton('Play this', () => playSolverMove(li.option && li.option.action));
        li.appendChild(li.btn);
        return li;
      },
      (li, o) => {
        li.option = o;
        const chosen = rec ? S.sameAction(o.action, rec.action) : o === top;
        li.classList.toggle('is-best', chosen);
        li.querySelector('.solver-text').textContent = o.label;
        li.querySelector('.solver-tag').hidden = !o.policy;
        li.querySelector('.solver-value').textContent = fmtOption(o);
        li.querySelector('.solver-meter span').style.width = `${Math.max(2, (100 * o.mean) / max).toFixed(1)}%`;
        // A devour also shows its exact chain odds.
        const sub = li.querySelector('.solver-sub');
        let subText = '';
        if (o.action.type === 'devour') {
          const odds = S.chainOdds(st, st.position, o.action.to);
          subText = `chain: ${odds.bites.toFixed(1)} bites on average, ${(100 * odds.rainbow).toFixed(0)}% to Rainbow`;
        }
        sub.hidden = !subText;
        sub.textContent = subText;
        li.btn.hidden = chosen || shown.length > 6;
      },
    );
    $('solver-note').textContent = shown.length < 2
      ? ''
      : close
        ? 'The top moves are within the margin of error: either is fine.'
        : 'Each option is played out from here with everything you can’t see re-rolled, and the trained strategy making every later choice. Scores are Rainbows vaulted by the end of the run.';
  }

  // Marks the recommended move on the board and the action bar.
  function renderHints() {
    const st = ui.state;
    if (!st) return;
    const rec = recommendation(st);
    const a = rec ? rec.action : null;
    const cell = a && a.type === 'patrol' ? a.cell : a && (a.type === 'devour' || a.type === 'chain') ? a.to : null;
    cellEls.forEach((el, n) => el.btn.classList.toggle('is-hint', n === cell));
    for (const card of document.querySelectorAll('#dest-cards [data-dest]')) card.classList.toggle('is-hint', Number(card.dataset.dest) === cell);
    $('btn-swap').classList.toggle('is-hint', !!a && a.type === 'swap');
    $('btn-hunt').classList.toggle('is-hint', !!a && a.type === 'hunt');
    $('btn-end').classList.toggle('is-hint', !!a && a.type === 'end');
  }

  function renderAdvisor() {
    const panel = $('panel-advisor');
    panel.hidden = !ui.prefs.advisor;
    $('btn-advisor').setAttribute('aria-pressed', String(ui.prefs.advisor));
    if (!ui.prefs.advisor) {
      renderHints();
      return;
    }
    const st = ui.state;
    const fits = solverFits(st);
    $('solver-box').hidden = !fits;
    $('advisor-list').hidden = fits;
    if (fits) {
      startSolver();
      renderSolver();
      renderHints();
      return;
    }
    renderHints();
    const t = ui.trainer && ui.trainer.seed === st.seed && ui.trainer.moves ? ui.trainer : null;
    $('advisor-list').innerHTML = `<li class="tip"><span>The run is over. Open the handoff roster to review it.${t ? ` You made ${t.good} of ${T.plural(t.moves, 'graded move')} best or close.` : ''}</span></li>`;
  }

  function render() {
    if (!ui.state || ui.screen !== 'game') return;
    renderTop();
    renderBoard();
    renderDestBar();
    renderRecap();
    renderDecision();
    renderActions();
    renderLog();
    renderGoal();
    renderAdvisor();
    renderVault();
    renderTools();
    $('screen-game').classList.toggle('is-immersive', !!ui.prefs.immersive);
    $('btn-sound').setAttribute('aria-pressed', String(ui.prefs.sound));
    $('btn-sound').textContent = ui.prefs.sound ? 'Sound on' : 'Sound off';
  }

  // ---------- Screens and runs ----------

  function showScreen(name) {
    ui.screen = name === 'game' && ui.state ? 'game' : 'title';
    $('screen-title').hidden = ui.screen !== 'title';
    $('screen-game').hidden = ui.screen !== 'game';
    if (ui.screen === 'title') renderTitle();
    else render();
  }

  function renderTitle() {
    const st = ui.state;
    $('btn-continue').hidden = !st;
    if (st) $('continue-meta').textContent = st.phase === 'ended' ? `${modeName(st)} · finished` : `${modeName(st)} · day ${st.day} of ${st.maxDays}`;
    $('btn-title-sound').textContent = `Sound: ${ui.prefs.sound ? 'on' : 'off'}`;
  }

  // Dialogs that belong to one run close whenever the run is replaced.
  function closeRunDialogs() {
    for (const id of ['dlg-choice', 'dlg-results']) closeDialog(id);
  }

  function startRun(opts) {
    ui.state = T.newGame(Object.assign({ params: ui.labParams }, opts));
    ui.trainer = null;
    ui.history = [];
    ui.selected = null;
    ui.pending = null;
    closeRunDialogs();
    persist();
    showScreen('game');
    Sound.play('open');
  }

  function routeFromTitle(route) {
    const unfinished = ui.state && ui.state.phase !== 'ended';
    if (route === 'drill' && !unfinished) startRun({ scenario: 'empty' });
    else if (route === 'drill') openNewRun({ scenario: 'empty' });
    else openNewRun({ scenario: 'events' });
  }

  function openNewRun(preset) {
    const p = preset || {};
    const scenario = p.scenario || (ui.state && ui.state.scenario) || 'empty';
    $('scenario-options').innerHTML = Object.entries(T.SCENARIOS)
      .map(([key, s]) => `<label class="option"><input type="radio" name="scenario" value="${key}"${key === scenario ? ' checked' : ''}><strong>${esc(s.name)}</strong><small>${esc(s.text)}</small></label>`)
      .join('');
    $('new-seed').value = T.randomSeed();
    $('new-replace').hidden = !(ui.state && ui.state.phase !== 'ended');
    openDialog('dlg-new');
  }

  // ---------- Dialogs ----------

  const onOpen = {
    'dlg-run': fillRunDialog,
    'dlg-prefs': fillPrefs,
    'dlg-lab': fillLab,
  };

  function openDialog(id) {
    const d = $(id);
    if (onOpen[id]) onOpen[id]();
    if (d.open) return;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }

  function closeDialog(id) {
    const d = $(id);
    if (!d.open) return;
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
  }

  function fillRunDialog() {
    const st = ui.state;
    const runButtons = ['btn-run-undo', 'btn-run-export', 'btn-run-end'];
    if (!st) {
      $('run-facts').innerHTML = facts([['Run', 'No run yet', true]]);
      $('run-inmates').innerHTML = '<li>Start a run from the title screen.</li>';
      runButtons.forEach((id) => ($(id).disabled = true));
      return;
    }
    $('run-facts').innerHTML = facts([
      ['Mode', modeName(st), true],
      ['Seed', st.seed, true],
      ['Day', `${st.day} / ${st.maxDays}`],
      ['Warden at', L(st.position)],
      ['Rainbows', st.vault.length],
      ['Moves to undo', ui.history.length],
    ]);
    const cells = st.cells.filter((c) => !c.sealed && c.inmate).sort((a, b) => b.inmate.tier - a.inmate.tier || a.n - b.n);
    $('run-inmates').innerHTML = cells.length
      ? cells.map((c) => `<li class="t${c.inmate.tier}"><b>${T.tierName(c.inmate.tier)}</b> ${T.beastName(c.inmate.beast)} · cell ${L(c.n)}${c.ivory ? ' · Tusk' : ''}</li>`).join('')
      : '<li>No inmates on the block.</li>';
    $('btn-run-undo').disabled = !ui.history.length;
    $('btn-run-export').disabled = false;
    $('btn-run-end').disabled = st.phase === 'ended';
    $('btn-run-end').textContent = 'End run now';
    ui.endArmed = 0;
  }

  function fillPrefs() {
    $('pref-advisor').checked = !!ui.prefs.advisor;
    $('pref-quick').checked = !!ui.prefs.quick;
    $('pref-motion').checked = !!ui.prefs.motion;
    $('pref-immersive').checked = !!ui.prefs.immersive;
    $('pref-sound').checked = !!ui.prefs.sound;
    $('pref-volume').value = ui.prefs.volume;
  }

  function setPref(key, value) {
    ui.prefs[key] = value;
    store.set(KEYS.prefs, ui.prefs);
    applyPrefs();
  }

  function applyPrefs() {
    document.documentElement.classList.toggle('no-motion', !ui.prefs.motion);
    Sound.setEnabled(ui.prefs.sound);
    Sound.setVolume(ui.prefs.volume / 100);
    renderTitle();
    render();
  }

  function openExport() {
    if (!ui.state) {
      toast('There is no run to export yet.');
      return;
    }
    $('save-title').textContent = 'Export save';
    $('save-export').hidden = false;
    $('save-import').hidden = true;
    $('save-out').value = JSON.stringify({ app: 'tartarus-sim', v: T.VERSION, savedAt: new Date().toISOString(), state: ui.state });
    $('btn-save-download').hidden = EMBEDDED;
    $('btn-save-copy').textContent = 'Copy save';
    openDialog('dlg-save');
  }

  function openImport() {
    $('save-title').textContent = 'Import save';
    $('save-export').hidden = true;
    $('save-import').hidden = false;
    $('save-in').value = '';
    $('save-file').value = '';
    $('save-error').hidden = true;
    openDialog('dlg-save');
  }

  function copySave() {
    const area = $('save-out');
    const done = () => {
      $('btn-save-copy').textContent = 'Copied';
      setTimeout(() => ($('btn-save-copy').textContent = 'Copy save'), 2000);
    };
    const fallback = () => {
      area.focus();
      area.select();
      $('btn-save-copy').textContent = 'Press Ctrl+C to copy';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(area.value).then(done, fallback);
    else fallback();
  }

  function downloadSave() {
    const st = ui.state;
    const blob = new Blob([$('save-out').value], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tartarus-${st.seed.replace(/[^A-Z0-9-]/gi, '')}-day${st.day}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function loadSave() {
    const text = $('save-in').value.trim();
    const error = $('save-error');
    if (!text) {
      error.textContent = 'Choose a save file or paste save text first.';
      error.hidden = false;
      return;
    }
    try {
      ui.state = T.deserialize(text);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      return;
    }
    ui.history = [];
    ui.selected = null;
    ui.pending = null;
    closeRunDialogs();
    persist();
    closeDialog('dlg-save');
    showScreen('game');
    toast(`Loaded ${modeName(ui.state)}, day ${ui.state.day}.`, true);
    followUp(0);
  }

  // ---------- Choices and results ----------

  function openChoice() {
    const st = ui.state;
    const choice = st && st.pending[0];
    if (!choice) {
      closeDialog('dlg-choice');
      return;
    }
    const goal = T.OBJECTIVES[st.objective.id].name;
    const copy = {
      tool: choice.start
        ? ['Starting instrument', 'Choose an instrument', 'Your run begins with one of these three instruments. It lasts the whole run.']
        : ['Objective met', 'Choose a tool', `${goal} is complete. Take one tool for the rest of the run.`],
      gift: ["Warden's Treasure", 'Choose a gift', 'A Rainbow reached the vault. Pick one gift; it takes effect at once.'],
    }[choice.kind];
    $('choice-eyebrow').textContent = copy[0];
    $('choice-title').textContent = copy[1];
    $('choice-note').textContent = copy[2];
    $('choice-options').innerHTML = choice.options
      .map((id) => `<div class="refit-card"><strong>${esc(T.toolName(id))}</strong><p>${esc(T.toolText(id))}</p><button type="button" class="btn btn-primary" data-take="${id}">Take</button></div>`)
      .join('');
    openDialog('dlg-choice');
  }

  function openResults() {
    const st = ui.state;
    if (!st || !st.result) return;
    const r = st.result;
    $('results-eyebrow').textContent = `${modeName(st)} · seed ${st.seed}`;
    $('results-facts').innerHTML = facts([
      ['Rainbows', r.roster.byTier[T.RAINBOW]],
      [st.params.rewards ? 'Treasure gifts' : 'Treasure claims', r.cache],
      ['Best rarity', T.tierName(r.best), true],
      ['Inmates', r.roster.rows.length],
      ['Patrols', r.stats.patrols],
      ['Consumes', r.stats.devours],
      ['Replaces', r.stats.swaps],
      ['Executions', r.stats.executions],
    ]);
    let roster = '';
    for (let t = T.RAINBOW; t >= 0; t--) {
      const rows = r.roster.rows.filter((x) => x.tier === t);
      if (!rows.length) continue;
      roster += `<div class="roster-row t${t}"><span class="tier-name">${T.TIERS[t]} ×${rows.length}</span><span class="names">${rows.map((x) => `${esc(T.beastName(x.beast))} <small>(${esc(x.where)})</small>`).join(', ')}</span></div>`;
    }
    $('results-roster').innerHTML = roster || '<p class="roster-empty">Nobody was left to hand off.</p>';
    openDialog('dlg-results');
  }

  function summaryText() {
    const st = ui.state;
    const r = st.result;
    const lines = [`Tartarus Simulator · ${modeName(st)} · seed ${st.seed}`, `Day ${r.day} of ${st.maxDays}${r.early ? ' (closed early)' : ''}`];
    lines.push(`Rainbows: ${st.cache} · Best: ${T.tierName(r.best)}`);
    for (let t = T.RAINBOW; t >= 0; t--) {
      const rows = r.roster.rows.filter((x) => x.tier === t);
      if (rows.length) lines.push(`${T.TIERS[t]} ×${rows.length}: ${rows.map((x) => T.beastName(x.beast)).join(', ')}`);
    }
    lines.push(`Moves: ${r.stats.patrols} patrols, ${r.stats.devours} consumes, ${r.stats.swaps} Replaces, ${r.stats.executions} executions`);
    return lines.join('\n');
  }

  function copySummary() {
    const button = $('btn-results-copy');
    const done = () => {
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = 'Copy summary'), 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(summaryText()).then(done, () => toast('Copying is blocked here. Use Export save instead.'));
    else toast('Copying is blocked here. Use Export save instead.');
  }

  // ---------- Lab ----------

  function fillLab() {
    const st = ui.state;
    const locked = !st || st.phase === 'ended';
    const note = $('lab-locked');
    note.hidden = !locked;
    note.textContent = st ? 'This run is over. Start a new drill to edit scenes.' : 'Start a drill to use the scene editor.';
    $('lab-editor').hidden = locked;
    if (!locked) {
      renderLabGrid();
      fillLabForm();
      renderLabTools();
    }
    renderParamsForm();
    selectLabTab(ui.labTab);
  }

  function selectLabTab(tab) {
    ui.labTab = tab;
    const scene = tab === 'scene';
    $('tab-scene').setAttribute('aria-selected', String(scene));
    $('tab-params').setAttribute('aria-selected', String(!scene));
    $('lab-scene').hidden = !scene;
    $('lab-params').hidden = scene;
    $('btn-params-reset').hidden = scene;
    $('btn-params-save').hidden = scene;
  }

  function renderLabGrid() {
    const st = ui.state;
    $('lab-grid').replaceChildren(
      ...st.cells.map((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        const open = !c.sealed && c.inmate;
        const office = c.n === T.OFFICE;
        b.className = 'mini' + (open ? ` t${c.inmate.tier}` : '') + (office ? ' is-office' : '') + (st.position === c.n ? ' is-warden' : '');
        b.style.gridRow = RING[c.n][0];
        b.style.gridColumn = RING[c.n][1];
        b.setAttribute('aria-pressed', String(c.n === ui.labCell));
        const mark = office ? '·' : c.nest ? 'N' : open ? T.beastName(c.inmate.beast)[0] : c.sealed ? '#' : '·';
        const sub = office ? 'Office' : c.nest ? 'Nest' : open ? T.tierName(c.inmate.tier).slice(0, 4) : c.sealed ? (c.event ? 'Event' : 'Sealed') : 'Empty';
        b.innerHTML = `<b>${mark}</b>${L(c.n)}<br>${sub}`;
        b.setAttribute('aria-label', office ? "Cell 01, the warden's office" : `Edit cell ${L(c.n)}`);
        b.addEventListener('click', () => {
          ui.labCell = c.n;
          renderLabGrid();
          fillLabForm();
        });
        return b;
      }),
    );
  }

  function fillLabForm() {
    const st = ui.state;
    const c = st.cells[ui.labCell];
    // The office takes no contents; the warden can still be moved there.
    const office = c.n === T.OFFICE;
    $('lab-cell-label').textContent = `Cell ${L(c.n)}${office ? " · the warden's office" : ''}${st.position === c.n ? ' · warden here' : ''}`;
    $('lab-contents').hidden = office;
    $('lab-office-note').hidden = !office;
    $('btn-lab-apply').hidden = office;
    $('btn-lab-apply').textContent = `Apply to cell ${L(c.n)}`;
    // A sealed occupant stays hidden here too, so the editor never spoils a door.
    let kind = 'open';
    if (c.nest) kind = 'nest';
    else if (c.sealed) kind = 'unknown';
    else if (!c.inmate) kind = 'empty';
    $('lab-kind').value = kind;
    const shown = !c.sealed && c.inmate;
    $('lab-beast').value = shown ? c.inmate.beast : 'mammoth';
    $('lab-tier').value = String(shown ? c.inmate.tier : 0);
    $('lab-ivory').checked = !!c.ivory;
    $('lab-scratch').checked = false;
    $('lab-event').value = c.event || 'none';
    syncLabKind();
    const lion = shown && c.inmate.beast === 'lion' && !T.linkOf(st, c.inmate.id);
    $('lab-prey-wrap').hidden = !lion;
    if (lion) {
      const options = st.cells.filter((o) => !o.sealed && o.inmate && T.canEat(st, c.inmate, o.inmate) && !T.linkOf(st, o.inmate.id));
      $('lab-prey').innerHTML = options.length ? options.map((o) => `<option value="${o.n}">Cell ${L(o.n)}: ${T.describe(o.inmate)}</option>`).join('') : '<option value="">No same-rarity meal on the block</option>';
      $('btn-lab-prey').disabled = !options.length;
    }
  }

  function syncLabKind() {
    const kind = $('lab-kind').value;
    $('lab-inmate-fields').hidden = !(kind === 'open' || kind === 'hidden');
    $('lab-ivory-wrap').hidden = kind !== 'open';
    $('lab-scratch-wrap').hidden = kind !== 'hidden';
    $('lab-event-wrap').hidden = !(kind === 'hidden' || kind === 'unknown');
  }

  function renderLabTools() {
    const st = ui.state;
    const free = T.TOOL_IDS.filter((id) => !st.tools.includes(id));
    $('lab-tool').innerHTML = free.map((id) => `<option value="${id}">${esc(T.toolName(id))}</option>`).join('') || '<option value="">All tools added</option>';
    $('btn-lab-tool').disabled = !free.length;
    $('lab-tools').innerHTML = st.tools.map((id) => `<li>${esc(T.toolName(id))}<button type="button" data-remove-tool="${id}" aria-label="Remove ${esc(T.toolName(id))}">×</button></li>`).join('');
  }

  function refreshLab() {
    renderLabGrid();
    fillLabForm();
    renderLabTools();
  }

  function applyLabCell() {
    const spec = {
      kind: $('lab-kind').value,
      beast: $('lab-beast').value,
      tier: Number($('lab-tier').value),
      ivory: $('lab-ivory').checked,
      scratch: $('lab-scratch').checked,
      event: $('lab-event').value,
    };
    if (run((s) => T.editCell(s, ui.labCell, spec), { select: null })) refreshLab();
  }

  function paramField(f, value) {
    const id = `param-${f.key}`;
    const label = `<span>${esc(f.label)}</span>`;
    if (f.type === 'int') return `<label class="param" for="${id}">${label}<input type="number" id="${id}" min="${f.min}" max="${f.max}" step="1" value="${value}"></label>`;
    if (f.type === 'bool') return `<label class="param" for="${id}">${label}<input type="checkbox" id="${id}"${value ? ' checked' : ''}></label>`;
    if (f.type === 'tier') {
      return `<label class="param" for="${id}">${label}<select id="${id}">${T.TIERS.slice(0, 5).map((t, i) => `<option value="${i}"${i === value ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
    }
    return `<div class="param">${label}<div class="list">${f.names
      .map((name, i) => `<label for="${id}-${i}">${esc(name)}<input type="number" id="${id}-${i}" min="0" max="1000" step="0.5" value="${value[i]}"></label>`)
      .join('')}</div></div>`;
  }

  function renderParamsForm() {
    const groups = new Map();
    for (const f of T.PARAM_FIELDS) {
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group).push(f);
    }
    $('form-params').innerHTML = [...groups]
      .map(([name, fields]) => `<fieldset class="param-group"><legend>${esc(name)}</legend>${fields.map((f) => paramField(f, ui.labParams[f.key])).join('')}</fieldset>`)
      .join('');
  }

  function readParamsForm() {
    const out = {};
    for (const f of T.PARAM_FIELDS) {
      const id = `param-${f.key}`;
      if (f.type === 'bool') out[f.key] = $(id).checked;
      else if (f.type === 'list') out[f.key] = f.names.map((_, i) => Number($(`${id}-${i}`).value));
      else out[f.key] = Number($(id).value);
    }
    return T.normalizeParams(out);
  }

  // ---------- Fullscreen ----------

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) {
      toast('Fullscreen is not available here.');
    }
  }

  // ---------- Wiring ----------

  function bind() {
    document.querySelectorAll('[data-route]').forEach((b) => b.addEventListener('click', () => routeFromTitle(b.dataset.route)));
    $('btn-continue').addEventListener('click', () => {
      showScreen('game');
      followUp(0);
    });
    $('btn-title-import').addEventListener('click', openImport);
    $('btn-title-sound').addEventListener('click', () => {
      setPref('sound', !ui.prefs.sound);
      if (ui.prefs.sound) Sound.play('tool');
    });

    document.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-open]');
      if (opener) {
        const parent = opener.closest('dialog');
        if (parent) parent.close();
        openDialog(opener.dataset.open);
        return;
      }
      const closer = e.target.closest('[data-close]');
      if (closer) {
        const d = closer.closest('dialog');
        if (d) d.close();
      }
    });

    document.querySelectorAll('dialog').forEach((d) => {
      d.addEventListener('click', (e) => {
        if (e.target === d) d.close();
      });
    });

    $('btn-home').addEventListener('click', () => showScreen('title'));
    $('btn-menu').addEventListener('click', () => openDialog('dlg-menu'));
    $('btn-full').addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      $('btn-full').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    });
    $('btn-advisor').addEventListener('click', () => setPref('advisor', !ui.prefs.advisor));
    $('btn-sound').addEventListener('click', () => {
      setPref('sound', !ui.prefs.sound);
      if (ui.prefs.sound) Sound.play('tool');
    });

    // A card click chooses that door; clicking the chosen card again goes there.
    $('dest-cards').addEventListener('click', (e) => {
      const b = e.target.closest('[data-dest]');
      if (!b || b.disabled) return;
      const n = Number(b.dataset.dest);
      if (ui.pending && ui.pending.kind === 'patrol' && ui.pending.cell === n) run((s) => T.patrol(s, n), { select: n });
      else askPatrol(n);
    });
    $('dest-cards').addEventListener('mouseover', (e) => {
      const b = e.target.closest('[data-dest]');
      const n = b ? Number(b.dataset.dest) : null;
      if (n !== null && ui.hover !== n && ui.state) {
        ui.hover = n;
        renderBoard();
      }
    });
    $('dest-cards').addEventListener('mouseleave', () => {
      if (ui.hover !== null && ui.state) {
        ui.hover = null;
        renderBoard();
      }
    });
    $('btn-swap').addEventListener('click', () => askSwap(ui.state && ui.state.position));
    $('btn-hunt').addEventListener('click', () => {
      if (!ui.state || !T.canHuntNow || !T.canHuntNow(ui.state)) return;
      ui.pending = { kind: 'hunt' };
      render();
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-end').addEventListener('click', askEndDay);

    $('btn-menu-new').addEventListener('click', () => {
      closeDialog('dlg-menu');
      openNewRun();
    });
    $('btn-menu-title').addEventListener('click', () => {
      closeDialog('dlg-menu');
      showScreen('title');
    });

    $('btn-reseed').addEventListener('click', () => ($('new-seed').value = T.randomSeed()));
    $('form-new').addEventListener('submit', (e) => {
      e.preventDefault();
      const data = new FormData(e.target);
      closeDialog('dlg-new');
      startRun({ scenario: data.get('scenario'), seed: $('new-seed').value });
    });

    $('btn-run-undo').addEventListener('click', () => {
      undo();
      fillRunDialog();
    });
    $('btn-run-export').addEventListener('click', () => {
      closeDialog('dlg-run');
      openExport();
    });
    $('btn-run-import').addEventListener('click', () => {
      closeDialog('dlg-run');
      openImport();
    });
    $('btn-run-end').addEventListener('click', () => {
      const b = $('btn-run-end');
      if (Date.now() - ui.endArmed > 4000) {
        ui.endArmed = Date.now();
        b.textContent = 'Click again to end the run';
        setTimeout(() => {
          if (Date.now() - ui.endArmed >= 4000) b.textContent = 'End run now';
        }, 4100);
        return;
      }
      ui.endArmed = 0;
      closeDialog('dlg-run');
      run((s) => T.endRun(s), { select: null });
    });

    $('btn-save-copy').addEventListener('click', copySave);
    $('btn-save-download').addEventListener('click', downloadSave);
    $('btn-save-load').addEventListener('click', loadSave);
    $('save-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        $('save-in').value = String(reader.result || '');
        $('save-error').hidden = true;
      };
      reader.onerror = () => {
        $('save-error').textContent = 'That file could not be read.';
        $('save-error').hidden = false;
      };
      reader.readAsText(file);
    });

    const prefInputs = { 'pref-advisor': 'advisor', 'pref-quick': 'quick', 'pref-motion': 'motion', 'pref-immersive': 'immersive', 'pref-sound': 'sound' };
    for (const [id, key] of Object.entries(prefInputs)) $(id).addEventListener('change', (e) => setPref(key, e.target.checked));
    $('pref-volume').addEventListener('input', (e) => setPref('volume', Number(e.target.value)));
    $('btn-sound-test').addEventListener('click', () => {
      if (!ui.prefs.sound) setPref('sound', true);
      $('pref-sound').checked = true;
      Sound.play('rainbow');
    });

    $('form-params').addEventListener('submit', (e) => e.preventDefault());
    $('tab-scene').addEventListener('click', () => selectLabTab('scene'));
    $('tab-params').addEventListener('click', () => selectLabTab('params'));
    $('lab-beast').innerHTML = T.BEASTS.map((b) => `<option value="${b}">${T.beastName(b)}</option>`).join('');
    $('lab-tier').innerHTML = T.TIERS.slice(0, 5).map((t, i) => `<option value="${i}">${t}</option>`).join('');
    $('lab-kind').addEventListener('change', syncLabKind);
    $('btn-lab-apply').addEventListener('click', applyLabCell);
    $('btn-lab-warden').addEventListener('click', () => {
      if (run((s) => T.moveWarden(s, ui.labCell))) refreshLab();
    });
    $('btn-lab-prey').addEventListener('click', () => {
      const target = Number($('lab-prey').value);
      if (Number.isInteger(target) && run((s) => T.markPrey(s, ui.labCell, target))) refreshLab();
    });
    $('btn-lab-tool').addEventListener('click', () => {
      const id = $('lab-tool').value;
      if (id && run((s) => T.addTool(s, id))) renderLabTools();
    });
    $('lab-tools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove-tool]');
      if (b && run((s) => T.removeTool(s, b.dataset.removeTool))) renderLabTools();
    });
    $('btn-params-reset').addEventListener('click', () => {
      ui.labParams = T.normalizeParams(null);
      renderParamsForm();
    });
    $('btn-params-save').addEventListener('click', () => {
      ui.labParams = readParamsForm();
      store.set(KEYS.params, ui.labParams);
      closeDialog('dlg-lab');
      startRun({ scenario: ui.state ? ui.state.scenario : 'empty' });
      toast('Practice values saved. A new drill has started.', true);
    });

    $('choice-options').addEventListener('click', (e) => {
      const b = e.target.closest('[data-take]');
      if (!b) return;
      run((s) => T.choose(s, b.dataset.take));
      // Shows the next waiting choice, or closes when none is left.
      openChoice();
    });

    $('btn-trainer-play').addEventListener('click', () => {
      const rec = ui.state && recommendation(ui.state);
      if (rec) playSolverMove(rec.action);
    });

    $('btn-results-copy').addEventListener('click', copySummary);
    $('btn-results-new').addEventListener('click', () => {
      closeDialog('dlg-results');
      openNewRun();
    });

    document.addEventListener('keydown', (e) => {
      if (ui.screen !== 'game' || document.querySelector('dialog[open]')) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (e.key === 'Escape') {
        cancel();
      } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        const primary = $('decision-actions').querySelector('.btn-primary');
        if (primary && $('decision').classList.contains('is-pending')) {
          e.preventDefault();
          primary.click();
        }
      }
    });
  }

  function fillHandbookTools() {
    const tools = T.TOOL_IDS.map((id) => `<dt>${esc(T.toolName(id))}</dt><dd>${esc(T.toolText(id))}</dd>`);
    const gifts = T.GIFT_IDS.map((id) => `<dt class="m-gift">${esc(T.toolName(id))}</dt><dd>Warden's Treasure gift. ${esc(T.toolText(id))}</dd>`);
    $('hb-tools').innerHTML = [...tools, ...gifts].join('');
  }

  function boot(hotData) {
    const data = hotData || {};
    const toastEl = $('toast');
    if (typeof toastEl.showPopover !== 'function') toastEl.hidden = true;
    buildBoard();
    renderSample();
    fillHandbookTools();
    bind();
    const saved = data.save || store.get(KEYS.save);
    let lost = '';
    if (saved) {
      try {
        ui.state = T.deserialize(saved);
        ui.history = Array.isArray(data.history) ? data.history.filter((h) => typeof h === 'string').slice(-HISTORY_LIMIT) : [];
      } catch (e) {
        ui.state = null;
        // A contract challenge saved before that mode was removed can't load
        // any more, so the engine's message says why the run is gone.
        const raw = saved.app === 'tartarus-sim' ? saved.state : saved;
        if (raw && raw.mode === 'challenge') lost = e.message;
      }
    }
    applyPrefs();
    showScreen(data.screen === 'game' ? 'game' : 'title');
    if (lost) toast(lost);
    requestAnimationFrame(() => $('board').classList.add('is-live'));
  }

  const hot = window.claude && window.claude.hot;
  if (hot && typeof hot.snapshot === 'function') {
    hot.snapshot(() => ({
      save: ui.state ? { app: 'tartarus-sim', v: T.VERSION, state: ui.state } : null,
      history: ui.history,
      screen: ui.screen,
    }));
  }
  if (hot && typeof hot.ready === 'function') hot.ready(boot);
  else boot((hot && hot.data) || {});
})();

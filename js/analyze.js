/* Tartarus Simulator: board analyzer.
 * The player sets up their board by hand: every cell, the warden, today's
 * doors, tools and vault. The page turns that into an engine state
 * and asks js/solver.js for the best move: the trained strategy's pick right
 * away, then a live check that plays every option out many times. "Do it here"
 * plays the move with the simulator's dice, so the player only has to fix what
 * came out differently in their game. Each board the player asks about is
 * handed to js/live.js, which shares runs of them to measure live's odds. */
(function () {
  'use strict';

  const T = window.Tartarus;
  const S = window.TartarusSolver;
  const B = window.TartarusBoard;
  const SHARE = window.TartarusLive || null;
  // The event kinds and steps the live collector (worker/) accepts.
  const COLLECTOR_EVENTS = ['unknown', 'chain', 'execution'];
  const COLLECTOR_STEPS = ['patrol', 'manage', 'event', 'choice'];
  // The moves "Do it here" can record that the deployed collector knows.
  const COLLECTOR_ACTIONS = ['patrol', 'devour', 'swap', 'end', 'event', 'choose'];
  const $ = (id) => document.getElementById(id);
  const L = (n) => T.cellLabel(n);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Short notes on playing the run's instruments, the pairs among them the
  // lab found worth more or less together, and its start card (js/tips.js;
  // the user, 2026-10-22).
  function renderPlayNotes() {
    const box = document.getElementById('az-play-notes');
    const tips = window.TartarusTips;
    if (!box || !tips) return;
    const names = {};
    for (const id of T.TOOL_IDS) names[id] = T.toolName(id).split(':')[0];
    for (const id of Object.keys(T.START_EVENTS || {})) names[id] = T.START_EVENTS[id].name;
    const notes = tips.notesFor(model.tools || [], model.startEvent, names);
    box.hidden = !notes.length;
    document.getElementById('az-play-notes-list').innerHTML = notes.map((n) => `<li class="az-play-note az-play-${n.kind}"><b>${esc(n.title)}.</b> ${esc(n.text)}</li>`).join('');
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const toInt = (v, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : fallback;
  };
  // This script's version tag, so the solver worker loads matching files.
  const SCRIPT_QUERY = (() => {
    const src = document.currentScript ? document.currentScript.src : '';
    const q = src.indexOf('?');
    return q >= 0 ? src.slice(q) : '';
  })();

  const KEY = 'tartarus-sim:analyzer:v1';
  // Whether a screenshot opens after it's read. Off (the default), it's
  // read into the board and stays hidden until the player opens it.
  const SHOTS_KEY = 'tartarus-sim:analyzer:show-screenshots';
  let showShots = false;
  try {
    showShots = localStorage.getItem(SHOTS_KEY) === '1';
  } catch (e) {
    // Without storage, screenshots stay hidden.
  }
  const SAVE_KEY = 'tartarus-sim:save:v2';
  const PLAYOUT_BUDGET = 9600; // playouts per check, shared across the options
  const LIVE_MIN = 150; // playouts per option before the live check can lead
  const SWITCH_MIN = 0.05; // Rainbows a live pick must gain over the strategy's to replace it
  // The check ends early once the leader is ahead of every other move by
  // CLEAR_SE of its paired margins (after LIVE_MIN playouts each), and in any
  // case after CHECK_MS, with what it has then. The user: a decision within a
  // second of the picture, "faster is way better".
  const CLEAR_SE = 3;
  const CHECK_MS = 700;
  const STEPS = ['patrol', 'manage', 'office', 'chain', 'event', 'ratway', 'choice'];
  const STEP_NAMES = { patrol: 'Which door to patrol', manage: 'After the patrol', office: 'Instigate or Bestow', chain: 'A meal to pick, or Cancel', event: 'A special event', ratway: 'Sewer Ratway: any cell', choice: 'A tool or gift' };
  const BEAST_KEYS = { m: 'mammoth', l: 'lion', w: 'wolf', r: 'rat' };
  const TOP_TIER = T.SUPREME; // Rainbows leave for the vault, so cells hold Normal to Supreme

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
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  // ---------- The board model ----------
  // What the player entered, in their terms. buildState() turns it into an
  // engine state, and modelFrom() turns an engine state back into a model.

  const officeCell = () => ({ kind: 'office' });
  const sealedCell = () => ({ kind: 'sealed', event: null });

  // What a cell holds, ignoring leftover fields and their order, so cells
  // from the reader or older edits compare equal when they hold the same.
  function cellSig(c) {
    switch (c.kind) {
      case 'inmate': return ['inmate', c.beast, toInt(c.tier, 0), !!c.ivory, c.prey ? [c.prey.cell, c.prey.rounds] : null, c.event || ''].join('|');
      case 'scratch': return ['scratch', toInt(c.tier, 0), c.event || ''].join('|');
      case 'revealed': return ['revealed', toInt(c.tier, 0), c.event || ''].join('|');
      case 'scouted': return ['scouted', c.beast, toInt(c.tier, 0), c.event || ''].join('|');
      case 'sealed': return ['sealed', c.event || '', toInt(c.atLeast, 0)].join('|');
      case 'nest': return ['nest', toInt(c.due, 0)].join('|');
      default: return c.kind;
    }
  }

  function blankModel() {
    return {
      v: 1,
      mode: 'drill',
      // The game has one food chain. Shared boards still say which.
      chain: 'single',
      rewards: true,
      day: 1,
      maxDays: T.DEFAULT_PARAMS.drillDays,
      step: 'patrol',
      warden: T.OFFICE,
      dest: [],
      devourUsed: false,
      swapUsed: false,
      // The game offers a consume after today's swap (it shows the button,
      // or Follow my game saw it in the log): only then is one advised.
      consumeOffered: false,
      // A Warden's Treasure waiting for the board behind it (treasureWait),
      // and the board seen since it opened (treasureSeen).
      treasureWait: false,
      treasureSeen: false,
      // Set when a screenshot's instrument panel disagrees with the run's
      // instruments: the player is asked to confirm them. Once confirmed
      // (toolsLocked), they stay for the run and aren't asked about again.
      toolsToConfirm: '',
      toolsLocked: false,
      // The panel's count at the last confirmation (toolsSeen) and in the
      // last picture (toolsPanel): only a panel showing more asks again.
      toolsSeen: 0,
      toolsPanel: 0,
      // Days of this run whose morning offered a door short (see scanToModel).
      shortDays: [],
      // The game shows no Replace / Consume card now (read from a screenshot):
      // that move isn't advised, and the other one still can be. noHunt: no
      // Hunt (the Blood-Stained Trap) on offer either.
      noSwap: false,
      noDevour: false,
      noHunt: false,
      // The cells the game framed on the Hunt's pick (only those can be
      // marked), while it's open.
      huntOnly: null,
      // The office shows one card only (read from a screenshot): 'bestow' or
      // 'instigate'.
      officeOnly: null,
      // The meals the game framed on a meal pick (only those can be eaten).
      mealOnly: null,
      eventKind: 'chain',
      // rerolls: a pet's re-rolls left on an instrument offer. picks: the
      // Warden's Treasure picks waiting, this one included (3 a Treasure
      // with Opulence).
      choice: { kind: 'tool', options: [], rerolls: 0, picks: 1 },
      chainArmed: false,
      // Until the player sets it, no objective's tool is assumed.
      objective: 'other',
      // A card shown before the run, besides its objective (T.START_EVENTS).
      startEvent: 'none',
      walkTiles: 0,
      milestone: false,
      tools: [],
      vault: [],
      cells: Array.from({ length: T.CELL_COUNT }, (_, n) => (n === T.OFFICE ? officeCell() : sealedCell())),
    };
  }

  // Fills in anything a saved model lacks, so older saves keep working.
  function normalize(m) {
    const base = blankModel();
    if (!m || typeof m !== 'object' || !Array.isArray(m.cells) || m.cells.length !== T.CELL_COUNT) return base;
    const out = Object.assign(base, m);
    // Every board is a drill: the contract challenge is gone (it isn't in
    // the live game), and a board saved in it goes on as a drill.
    out.mode = 'drill';
    delete out.ch;
    delete out.windowKind;
    out.choice = Object.assign(blankModel().choice, m.choice || {});
    out.choice.rerolls = clamp(toInt(out.choice.rerolls, 0), 0, 9);
    out.choice.picks = clamp(toInt(out.choice.picks, 1), 1, 30);
    out.cells = m.cells.map((c, n) => (n === T.OFFICE ? officeCell() : Object.assign(sealedCell(), c)));
    out.dest = Array.isArray(m.dest) ? m.dest.filter((n) => Number.isInteger(n) && n >= 0 && n < T.CELL_COUNT) : [];
    if (!STEPS.includes(out.step)) out.step = 'patrol';
    if (out.objective === 'cagefight') {
      out.startEvent = 'cagefight';
      out.objective = 'other';
    }
    if (!T.START_EVENTS || !T.START_EVENTS[out.startEvent]) out.startEvent = 'none';
    if (!T.OBJECTIVES[out.objective]) out.objective = 'other';
    // Progress on an objective counted to a number (tiles, consumes, ...).
    out.walkTiles = clamp(toInt(out.walkTiles, 0), 0, T.OBJECTIVES[out.objective].need || 0);
    out.chain = 'single';
    return out;
  }

  // The engine state for a model, and anything that stops it from being
  // analyzed. Events the player can't name get a kind the solver re-rolls.
  function buildState(m) {
    const problems = [];
    const params = { rewards: !!m.rewards, drillDays: clamp(toInt(m.maxDays, 20), 5, 60) };
    const st = T.newGame({ params, seed: 'ANALYZER' });
    st.rng = (Math.random() * 4294967296) >>> 0;
    st.log = [];
    st.day = clamp(toInt(m.day, 1), 1, st.maxDays);
    st.nextId = 1;
    const make = (beast, tier) => ({ id: st.nextId++, beast: T.BEASTS.includes(beast) ? beast : 'mammoth', tier: clamp(toInt(tier, 0), 0, TOP_TIER) });
    st.cells = m.cells.map((c, n) => {
      const cell = { n, sealed: n !== T.OFFICE, inmate: null, hidden: null, known: 0, scratch: false, nest: null, event: null, ivory: false };
      if (n === T.OFFICE) return cell;
      // Doors marked with an event ("!") have been passed; the rest may still
      // hide one the player can't see.
      const setEvent = () => {
        cell.seen = !!c.event;
        if (!c.event) return;
        cell.event = T.EVENTS[c.event] ? c.event : 'chain';
        if (c.event === 'unknown') cell.eventKnown = false;
      };
      if (c.kind === 'empty') cell.sealed = false;
      else if (c.kind === 'inmate') {
        cell.sealed = false;
        cell.inmate = make(c.beast, c.tier);
        if (c.marked) cell.inmate.marked = true;
        cell.ivory = !!c.ivory;
        // An event can wait in an open cell ("Can trigger Prison Incident").
        setEvent();
      } else if (c.kind === 'nest') {
        // A nest due today hatched this morning, so a sealed one is due later.
        cell.nest = { due: Math.max(st.day + 1, toInt(c.due, st.day + 1)) };
      } else if (c.kind === 'scouted') {
        cell.known = 2;
        cell.hidden = make(c.beast, c.tier);
        setEvent();
      } else if (c.kind === 'scratch' || c.kind === 'revealed') {
        // The rarity shows; the beast stays hidden (re-rolled by the solver).
        cell.scratch = c.kind === 'scratch';
        cell.known = 1;
        cell.hidden = make(T.BEASTS[Math.floor(Math.random() * 4)], c.tier);
        setEvent();
      } else {
        // A door the "Treasure" Hunt left dark holds Rare or better.
        cell.atLeast = c.kind === 'sealed' ? clamp(toInt(c.atLeast, 0), 0, TOP_TIER) : 0;
        setEvent();
      }
      return cell;
    });

    // Prey marks: a Lion and the same-rarity meal it marked.
    st.prey = [];
    m.cells.forEach((c, n) => {
      if (c.kind !== 'inmate' || c.beast !== 'lion' || !c.prey) return;
      const lion = st.cells[n].inmate;
      const target = st.cells[c.prey.cell];
      if (!target || !target.inmate || !T.canEat(st, lion, target.inmate)) {
        problems.push(`The prey mark from cell ${L(n)} needs a same-rarity meal for the Lion in cell ${L(c.prey.cell)}.`);
        return;
      }
      if (st.prey.some((l) => [l.lion, l.prey].includes(target.inmate.id) || [l.lion, l.prey].includes(lion.id))) {
        problems.push(`Cell ${L(c.prey.cell)} already has a prey mark.`);
        return;
      }
      st.prey.push({ lion: lion.id, prey: target.inmate.id, preyBeast: target.inmate.beast, rounds: clamp(toInt(c.prey.rounds, 1), 1, 9), next: st.day + 1 });
    });

    st.vault = m.vault.filter((b) => T.BEASTS.includes(b)).map((beast) => ({ id: st.nextId++, beast, day: 1 }));
    st.cache = st.vault.length;
    st.tools = T.TOOL_IDS.filter((id) => m.tools.includes(id));
    st.position = clamp(toInt(m.warden, 0), 0, T.CELL_COUNT - 1);
    st.chain = !!m.chainArmed;
    const need = (T.OBJECTIVES[m.objective] && T.OBJECTIVES[m.objective].need) || 0;
    st.objective = { id: m.objective, progress: need ? clamp(toInt(m.walkTiles, 0), 0, need) : 0 };
    st.startEvent = m.startEvent !== 'none' ? m.startEvent : null;
    st.milestone = !!m.milestone || (need > 0 && st.objective.progress >= need);
    st.stats.best = Math.max(0, ...st.cells.filter((c) => c.inmate).map((c) => c.inmate.tier), st.vault.length ? T.RAINBOW : 0);
    st.used = { swap: 0, devour: 0 };
    st.destinations = [];
    st.event = null;
    st.pending = [];
    st.phase = 'manage';

    const usedToday = () => {
      st.used = { swap: m.swapUsed ? 1 : 0, devour: m.devourUsed ? 1 : 0, devourAfterSwap: !!m.consumeOffered, noSwap: !!m.noSwap, noDevour: !!m.noDevour, noHunt: !!m.noHunt, huntOnly: Array.isArray(m.huntOnly) ? m.huntOnly.slice() : null, officeOnly: m.officeOnly || null, mealOnly: Array.isArray(m.mealOnly) ? m.mealOnly.slice() : null };
    };
    switch (m.step) {
      case 'patrol': {
        st.phase = 'patrol';
        st.destinations = [...new Set(m.dest)]
          .filter((n) => Number.isInteger(n) && n >= 0 && n < T.CELL_COUNT && n !== st.position)
          .sort((a, b) => T.stepsBetween(st.position, a) - T.stepsBetween(st.position, b));
        if (!st.destinations.length) problems.push("Mark today's doors: tick them under “Which door to patrol”, or select a cell and press Today's door.");
        // Doors are always among the cells just ahead of the warden, clockwise.
        // One outside them means the warden (or the door) is in the wrong
        // cell, and the advice would send the warden most of the way round.
        const range = st.params.patrolRange;
        const reach = (w, n) => T.stepsBetween(w, n) >= 1 && T.stepsBetween(w, n) <= range;
        const doors = [...new Set(m.dest)].filter((n) => Number.isInteger(n) && n >= 0 && n < T.CELL_COUNT);
        const outside = doors.filter((n) => !reach(st.position, n));
        // The game's tutorial run scripts its doors: the warden in 05 with
        // doors 06, 08 and 14, seen on dozens of players' boards (report 34).
        // No other run has shown a door past the six cells ahead.
        const tutorial = st.position === 4 && doors.length === 3 && [5, 7, 13].every((n) => doors.includes(n));
        if (outside.length && !tutorial) {
          const fits = [];
          for (let w = 0; w < T.CELL_COUNT; w++) if (doors.every((n) => reach(w, n))) fits.push(L(w));
          const where = fits.length > 1 ? `${fits.slice(0, -1).join(', ')} or ${fits[fits.length - 1]}` : fits[0];
          problems.push(`Doors are always among the ${range} cells clockwise ahead of the warden, and ${outside.length === 1 ? `cell ${L(outside[0])} isn't` : `cells ${outside.map(L).join(' and ')} aren't`}: the warden is set in cell ${L(st.position)}. ${fits.length ? `Check the warden's cell: with these doors it's in cell ${where}.` : "No single cell has all these doors in reach, so check the doors too."}`);
        }
        break;
      }
      case 'ratway': {
        // The Sewer Ratway's "Select an Objective": any cell but the office,
        // after the day's patrol.
        st.phase = 'patrol';
        st.ratway = true;
        st.destinations = st.cells.filter((c) => c.n !== T.OFFICE).map((c) => c.n);
        break;
      }
      case 'event': {
        const here = st.cells[st.position];
        if (!here || here.sealed || !here.inmate) problems.push("An event needs the inmate that came out of the door in the warden's cell: put the warden there and set its inmate.");
        st.phase = 'event';
        st.event = { kind: T.EVENTS[m.eventKind] ? m.eventKind : 'chain', cell: st.position };
        break;
      }
      case 'choice': {
        usedToday();
        const kind = m.choice.kind === 'gift' ? 'gift' : 'tool';
        const options = kind === 'gift' ? T.GIFT_IDS.slice() : [...new Set(m.choice.options)].filter((id) => T.TOOLS[id] && !st.tools.includes(id));
        if (!options.length) problems.push('Pick the tools on offer.');
        st.pending = [{ kind, options, rerolls: kind === 'tool' ? m.choice.rerolls || 0 : 0 }];
        // The Treasure's picks still waiting after this one (Opulence).
        if (kind === 'gift') for (let k = 1; k < clamp(toInt(m.choice.picks, 1), 1, 30); k++) st.pending.push({ kind, options: options.slice(), rerolls: 0 });
        break;
      }
      case 'chain': {
        // The warden's inmate has eaten and has a meal again: the game asks
        // which to eat, even with only one, and its Cancel stops the chain.
        usedToday();
        st.used.devour = 1;
        const here = st.cells[st.position];
        if (!here || here.sealed || !here.inmate) {
          problems.push("A chain needs its eater in the warden's cell: put the warden there and set the inmate as it is now.");
          break;
        }
        st.chaining = { eater: here.inmate.id, at: 0, bites: [] };
        if (!T.chainOptions(st).length) {
          problems.push("Your game asks for a meal only when the chaining inmate has one to eat. Check the board: it can't find a meal for it.");
        }
        break;
      }
      case 'office': {
        // Only when the game shows the Instigate and Bestow buttons. Standing
        // in the office isn't enough: the run starts there without them, and
        // they're gone once one is taken.
        usedToday();
        if (st.position !== T.OFFICE) problems.push('Instigate and Bestow come with the warden in the office: put the warden in cell 01.');
        st.phase = 'office';
        break;
      }
      default:
        usedToday();
    }
    return { st, problems };
  }

  // A model for an engine state: a saved simulator run, or the state after
  // "Do it here". `prev` keeps what the player knew about event kinds.
  function modelFrom(st, prev) {
    const m = blankModel();
    m.rewards = !!st.params.rewards;
    m.day = st.day;
    m.maxDays = st.maxDays;
    m.warden = st.position;
    m.chainArmed = !!st.chain;
    m.objective = st.objective ? st.objective.id : 'other';
    m.startEvent = st.startEvent || 'none';
    m.walkTiles = st.objective ? st.objective.progress : 0;
    m.milestone = !!st.milestone;
    m.tools = st.tools.slice();
    m.vault = st.vault.map((v) => v.beast);
    m.cells = st.cells.map((c) => {
      if (c.n === T.OFFICE) return officeCell();
      const before = prev ? prev.cells[c.n] : null;
      // The simulator only shows that a door hides an event, not which kind.
      let event = null;
      if (c.event && c.seen !== false) event = c.eventKnown === false || !before || !before.event ? 'unknown' : before.event;
      if (c.sealed) {
        if (c.nest) return { kind: 'nest', due: c.nest.due };
        if (c.scratch && c.hidden && c.known) return { kind: 'scratch', tier: Math.min(TOP_TIER, c.hidden.tier), event };
        if (c.hidden && c.known === 1) return { kind: 'revealed', tier: Math.min(TOP_TIER, c.hidden.tier), event };
        if (c.hidden && c.known >= 2) return { kind: 'scouted', beast: c.hidden.beast, tier: Math.min(TOP_TIER, c.hidden.tier), event };
        return c.atLeast ? { kind: 'sealed', event, atLeast: c.atLeast } : { kind: 'sealed', event };
      }
      if (!c.inmate) return { kind: 'empty' };
      const link = T.linkOf(st, c.inmate.id);
      const preyCell = link && link.lion === c.inmate.id ? T.cellOf(st, link.prey) : null;
      return { kind: 'inmate', beast: c.inmate.beast, tier: Math.min(TOP_TIER, c.inmate.tier), ivory: !!c.ivory, prey: preyCell ? { cell: preyCell.n, rounds: link.rounds } : null, marked: !!c.inmate.marked, event };
    });
    if (st.pending.length) {
      m.step = 'choice';
      m.choice = { kind: st.pending[0].kind, options: st.pending[0].options.slice(), rerolls: st.pending[0].rerolls || 0, picks: st.pending[0].kind === 'gift' ? st.pending.filter((p) => p.kind === 'gift').length : 1 };
    } else if (st.phase === 'event' && st.event) {
      m.step = 'event';
      m.eventKind = st.event.kind;
    } else if (st.chaining) m.step = 'chain';
    // The simulator offers Instigate or Bestow on walking into the office, but
    // the analyzer waits for the player (or a screenshot) to say the game does.
    else m.step = st.phase === 'patrol' ? (st.ratway ? 'ratway' : 'patrol') : 'manage';
    m.dest = st.phase === 'patrol' && !st.ratway ? st.destinations.slice() : [];
    // A Hunt (the Blood-Stained Trap) used the day's action, as a consume does.
    m.devourUsed = st.used.devour > 0 || !!st.used.hunt;
    m.swapUsed = st.used.swap > 0;
    m.consumeOffered = !!st.used.devourAfterSwap;
    m.noSwap = !!st.used.noSwap;
    m.noDevour = !!st.used.noDevour;
    m.noHunt = !!st.used.noHunt;
    m.huntOnly = Array.isArray(st.used.huntOnly) ? st.used.huntOnly.slice() : null;
    m.officeOnly = st.phase === 'office' && st.used.officeOnly ? st.used.officeOnly : null;
    m.mealOnly = Array.isArray(st.used.mealOnly) ? st.used.mealOnly.slice() : null;
    m.ended = st.phase === 'ended';
    return m;
  }

  // ---------- Page state ----------

  const saved = store.get(KEY);
  let model = normalize(saved && saved.model);
  let selected = saved && Number.isInteger(saved.selected) ? clamp(saved.selected, 0, T.CELL_COUNT - 1) : 1;
  let flags = new Set(); // cells the simulator's dice decided, for the player to check
  let applied = null; // what "Do it here" just played
  // How the board got here since the last one asked about: a move played
  // here, or a screenshot. `filled` lists what the dice or the reader decided
  // (cells as c<n>, plus dest, event and choice), `touched` what the player
  // has since set or confirmed against their game. It's saved with the board,
  // so a reload can't pass the dice's guesses off as the player's.
  let via = saved && saved.via && Array.isArray(saved.via.filled) ? Object.assign({}, saved.via, { touched: new Set(saved.via.touched || []) }) : null;
  // Cells still to check survive a reload too.
  if (via) flags = new Set(via.filled.filter((k) => /^c\d+$/.test(k) && !via.touched.has(k)).map((k) => Number(k.slice(1))));
  // The board came from a screenshot (or a Follow my game picture) and was
  // checked straight away. The reader can get something wrong, so its Check
  // marks stay after the advice, for the player to fix and recheck.
  let shot = !!(saved && saved.shot);
  // That board is shared only once the player moves on (the next picture, a
  // move played here, another board), so a board they fixed is shared as
  // fixed, not as a misreading followed by a step that never happened.
  let held = null;
  // Instruments on that screenshot the reader wasn't sure of, to check too.
  let shotTools = [];
  // An instrument read below this is shown as one to check. On the labeled
  // boards, correct reads are 1.00 at their own size and drop to about 0.56
  // when the screenshot is resized.
  const TOOL_SURE = 0.9;
  const undo = [];
  const modelKey = () => JSON.stringify(model);

  function save() {
    store.set(KEY, { model, selected, shot, via: via && Object.assign({}, via, { touched: [...via.touched] }) });
  }

  function shareHeld() {
    if (held && SHARE) SHARE.record(held.board, held.via);
    held = null;
  }

  // The player moves on from a screenshot's board.
  function leaveShot() {
    shareHeld();
    shot = false;
    shotTools = [];
  }

  // "the Rusty Saw" or "the Rusty Saw and the Forged Key", for the notes
  // after a screenshot.
  const unsureTools = () => (shotTools.length ? ` The reader wasn’t sure of ${shotTools.map((n) => `the ${n}`).join(' and ')}: check your instruments too.` : '');

  function changed() {
    save();
    render();
  }

  function notice(text) {
    $('az-notice').textContent = text;
  }

  // ---------- Analysis ----------

  const solver = { workers: null, failed: false, id: 0, st: null, key: '', instant: null, result: null, shares: null, meta: null, goal: '' };
  // The live check runs on a worker for every core but one, or on fewer when
  // the page is told (setCores: the desktop app's processor setting), each
  // playing its share of the rounds with its own dice. It runs for a few
  // seconds after each board. A minute after the last check the workers are
  // let go, and their memory with them; the next check starts new ones.
  const MOST_WORKERS = Math.max(1, (navigator.hardwareConcurrency || 2) - 1);
  const WORKERS_IDLE_MS = 60000;
  let coreCap = 0; // 0: every core but one
  const workerCount = () => (coreCap ? Math.min(MOST_WORKERS, coreCap) : MOST_WORKERS);
  let idleTimer = 0;
  const poolBusy = () => !!(solver.workers && solver.shares && !solver.shares.every((s) => s.done));
  function releaseWorkers() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    if (!solver.workers) return;
    for (const w of solver.workers) w.terminate();
    solver.workers = null;
    solver.shares = null;
  }
  // Let the workers go once they've been idle a minute; a check still
  // playing keeps them.
  function idleLater() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (poolBusy() ? idleLater() : releaseWorkers()), WORKERS_IDLE_MS);
  }
  // How many workers the live check may use (0: every core but one). A
  // check under way starts over on the new number.
  function setCores(n) {
    coreCap = Math.max(0, Math.floor(Number(n) || 0));
    if (solver.workers && solver.workers.length !== workerCount()) {
      const again = poolBusy() && solver.st ? { id: solver.id, st: solver.st, rollouts: solver.target } : null;
      releaseWorkers();
      if (again) startCheck(again.id, again.st, again.rollouts);
    }
    return workerCount();
  }

  // fresh: a new run's instrument offer (usePick). The last run's board is
  // done with, and this one, not seen yet, isn't shared: the next board
  // starts a new run.
  function ask(quiet, fresh) {
    // A Warden's Treasure waiting for the board behind it: no advice yet.
    if (model.treasureWait) {
      solver.st = null;
      render();
      return false;
    }
    const { st, problems } = buildState(model);
    showProblems(problems);
    if (problems.length) return false;
    if (SHARE && (fresh || (model.runStart && model.step === 'choice'))) {
      shareHeld();
      SHARE.reset('manual');
    } else if (SHARE) {
      // The collector rejects what it doesn't know yet: the newer event
      // kinds, the office as a door, a chain's pick, doors that show a
      // rarity without a scratch, and moves it can't record (a re-roll, the
      // office's choice, a chain's pick). Until it learns
      // them, such a board isn't shared, and the next board starts a new
      // run, so no shared step spans it.
      const kinds = [...model.cells.map((c) => c.event).filter(Boolean), ...(model.step === 'event' ? [model.eventKind] : [])];
      const how = via && Object.assign({}, via, { touched: [...via.touched] });
      const known = kinds.every((k) => COLLECTOR_EVENTS.includes(k)) && !model.dest.includes(T.OFFICE) && COLLECTOR_STEPS.includes(model.step) && !model.cells.some((c) => c.kind === 'revealed') && !(how && how.action && !COLLECTOR_ACTIONS.includes(how.action.type));
      if (!known) {
        held = null;
        SHARE.reset('manual');
      } else if (shot) held = { board: JSON.parse(JSON.stringify(model)), via: how };
      else {
        shareHeld();
        SHARE.record(model, how);
      }
    }
    // A screenshot's board keeps its Check marks through a recheck.
    if (!shot) {
      via = null;
      flags = new Set();
    }
    applied = null;
    solver.id += 1;
    solver.st = st;
    solver.key = modelKey();
    solver.result = null;
    try {
      solver.instant = S.instant(st);
    } catch (e) {
      solver.instant = null;
    }
    const options = S.candidates(st).length;
    const rollouts = clamp(Math.round(PLAYOUT_BUDGET / Math.max(1, options)), 400, 1600);
    solver.target = rollouts;
    solver.startedAt = Date.now();
    startCheck(solver.id, st, rollouts);
    render();
    if (quiet !== true) $('az-results').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return true;
  }

  function startCheck(id, st, rollouts) {
    const state = JSON.parse(JSON.stringify(st));
    if (!solver.workers && !solver.failed) {
      try {
        solver.workers = Array.from({ length: workerCount() }, (_, k) => {
          const worker = new Worker(`js/solver-worker.js${SCRIPT_QUERY}`);
          worker.onmessage = (e) => onShare(k, e.data);
          worker.onerror = () => {
            // Fall back to this page's thread, and redo the check.
            if (!solver.workers) return;
            for (const w of solver.workers) w.terminate();
            solver.workers = null;
            solver.shares = null;
            solver.failed = true;
            if (solver.st) startCheck(solver.id, solver.st, Math.min(rollouts, 300));
          };
          return worker;
        });
      } catch (e) {
        solver.failed = true;
        solver.workers = null;
      }
    }
    if (solver.workers) {
      // Each worker's share of the rounds: together they make `rollouts`.
      const n = solver.workers.length;
      solver.meta = null;
      solver.shares = solver.workers.map((w, k) => ({ target: Math.floor(rollouts / n) + (k < rollouts % n ? 1 : 0), rounds: 0, done: false, rows: null }));
      solver.workers.forEach((w, k) => w.postMessage({ id, state, rollouts: solver.shares[k].target, stream: k, raw: true }));
      idleLater();
      return;
    }
    const job = S.solve(state, { rollouts: Math.min(rollouts, 300), seed: (id * 7919 + 1) >>> 0 });
    const tick = () => {
      if (id !== solver.id) return;
      solver.result = job.step(12);
      renderResults();
      renderBoard();
      renderCourt();
      if (!solver.result.done) setTimeout(tick, 16);
    };
    setTimeout(tick, 0);
  }

  // A worker's new rounds for the current check. Its rows grow, and the
  // merged result is redrawn at most every 100 ms, and once all are done.
  let mergeTimer = 0;
  function onShare(k, m) {
    // A check that settled early keeps its answer: late rounds are dropped.
    if (m.id !== solver.id || !solver.shares || (solver.result && solver.result.early)) return;
    const share = solver.shares[k];
    if (m.meta && !solver.meta) solver.meta = m.meta;
    if (!share.rows) share.rows = m.rows.map(() => ({ vals: [], best: 0 }));
    m.rows.forEach((r, i) => {
      const row = share.rows[i];
      for (const v of r.vals) row.vals.push(v);
      row.best = r.best;
    });
    share.rounds = m.rounds;
    share.done = m.done;
    solver.goal = m.goal;
    if (solver.shares.every((s) => s.done)) {
      clearTimeout(mergeTimer);
      merge();
      idleLater();
    } else if (!mergeTimer) mergeTimer = setTimeout(merge, 100);
  }

  // The workers' rows as one: each share's rounds keep their common dice
  // across the moves, so the paired margins hold (TartarusSolver.summarize).
  function merge() {
    mergeTimer = 0;
    if (!solver.shares || !solver.meta) return;
    const rows = solver.meta.map((meta, i) => {
      const row = Object.assign({ vals: [], best: 0 }, meta);
      for (const s of solver.shares) {
        const r = s.rows && s.rows[i];
        if (!r) continue;
        for (const v of r.vals) row.vals.push(v);
        row.best += r.best;
      }
      return row;
    });
    const rounds = solver.shares.reduce((sum, s) => sum + s.rounds, 0);
    solver.result = Object.assign(S.summarize(rows, rounds, solver.target, solver.goal), { done: solver.shares.every((s) => s.done) });
    // Settled early: the workers stop, and their share of the processor with them.
    if (!solver.result.done && settled() && solver.workers) {
      for (const w of solver.workers) w.postMessage({ stop: true });
      for (const share of solver.shares) share.done = true;
      solver.result.done = true;
      solver.result.early = true;
      idleLater();
    }
    renderResults();
    renderBoard();
    renderCourt();
  }

  const fresh = () => !!solver.st && solver.key === modelKey();
  // Whether the advice is final: the live check has finished, or there's
  // nothing to compare. Until then no move is advised, so the advice never
  // changes its mind a moment after it's shown.
  function settled() {
    const r = solver.result;
    if (!r) return false;
    if (r.done || r.options.length <= 1) return true;
    const [top, ...rest] = r.options;
    if (r.rounds >= LIVE_MIN && rest.every((o) => o.gapSe > 0 && top.mean - o.mean > CLEAR_SE * o.gapSe)) return true;
    // Out of time: the advice is the check's leader once it has LIVE_MIN
    // playouts each, else the strategy's own pick (recommendation()).
    return Date.now() - solver.startedAt >= CHECK_MS;
  }
  // A picture being read (the reader shows it on the board's card).
  let reading = 0;
  function setReading(on) {
    reading = Math.max(0, reading + (on ? 1 : -1));
    renderCourt();
  }
  const SPIN = '<span class="az-spin" aria-hidden="true"></span>';
  // The moves being played out, in a steady order while the check runs.
  function checking() {
    const r = solver.result;
    const moves = r ? r.options.slice() : solver.st ? S.candidates(solver.st) : [];
    moves.sort((a, b) => a.label.localeCompare(b.label));
    const each = solver.target || 0;
    const done = r ? Math.min(each, r.rounds) : 0;
    return { moves, each, done, total: each * moves.length, played: done * moves.length };
  }
  // How far the live check has got, 0 to 1.
  const progress = () => (solver.result && solver.target ? Math.min(1, solver.result.rounds / solver.target) : 0);

  // On a meal pick ("Select an Inmate to Consume") the choices are a meal or
  // Cancel. When the best move there is not to consume, the advice says
  // Cancel, which ends a chain or leaves the day's first consume (report
  // 323: "recommended to End day instead of cancel consume").
  function recommendation() {
    const rec = bestMove();
    const rd = reader.reading;
    if (!rec || !rec.action || rec.action.type !== 'end' || !rd || !rd.chain || model.step !== 'manage') return rec;
    return Object.assign({}, rec, { label: 'Cancel the consume, then end the day', why: `Your game shows a meal pick, where a meal or Cancel are the choices. ${rec.why || ''}`.trim() });
  }

  // The strategy's instant pick, unless the live check finds a clearly better
  // move (by more than its paired margin), so the advice doesn't flicker.
  function bestMove() {
    if (!solver.st) return null;
    const pick = solver.instant;
    const r = solver.result;
    const ranked = r ? r.options : [];
    // A check cut short by the time cap (early) leads only with LIVE_MIN
    // playouts each; with fewer, the strategy's own pick stands (f5's review).
    const live = r && ranked.length > 1 && ((r.done && !r.early) || r.rounds >= LIVE_MIN) ? ranked[0] : null;
    const mine = pick && ranked.find((o) => S.sameAction(o.action, pick.action));
    if (!live) return pick ? Object.assign({ live: false }, pick, { option: mine || null }) : ranked.length === 1 ? { action: ranked[0].action, label: ranked[0].label, why: 'It’s the only move here.', live: true, option: ranked[0] } : null;
    // A better move must also win by a margin worth playing for: shared dice
    // make the paired margin narrow, and a near tie flipped the advice from
    // one screen to the next (report 337: End 2.85 against the strategy's
    // consume at 2.82).
    if (mine && (mine === live || live.mean - mine.mean <= Math.max(1.96 * mine.gapSe, SWITCH_MIN))) {
      const why = mine === live ? pick.why : `${pick.why} The live check rates it about equal to the best.`;
      return Object.assign({ live: true, rounds: r.rounds }, pick, { label: mine.label, why, option: mine });
    }
    return { action: live.action, label: live.label, why: `The playouts found a better move than the strategy’s pick${pick ? ` (${pick.label})` : ''}.`, live: true, rounds: r.rounds, option: live };
  }

  function fmtOption(goal, o, st) {
    return `${o.mean.toFixed(2)}${o.n > 1 ? ` ±${(1.96 * o.se).toFixed(2)}` : ''}`;
  }

  function expectText(goal, o, st) {
    if (!o) return '';
    return `Expected: ${o.mean.toFixed(2)} Rainbows in the vault by the end of day ${st.maxDays}.`;
  }

  // ---------- Playing a move here ----------

  // Plays a move with the simulator's dice. The cells it changes are marked
  // for the player to set to what their game shows. With toNextDay, the
  // strategy then plays the rest of the day the same way, as if the player
  // followed the advice, and stops at the next day's patrol: the player then
  // pastes a screenshot of their new day, or fixes the marked cells.
  function doMove(action, toNextDay) {
    const { st, problems } = buildState(model);
    if (problems.length) {
      showProblems(problems);
      return;
    }
    // An event whose kind wasn't seen is any of them. Doors hide none unseen:
    // events show as they appear, and new ones come from the engine's dice.
    for (const c of st.cells) {
      if (c.event && c.eventKnown === false) c.event = T.EVENT_POOL[Math.floor(Math.random() * T.EVENT_POOL.length)];
    }
    const before = JSON.parse(JSON.stringify(model));
    const label = labelFor(action);
    let result;
    try {
      result = S.apply(st, action);
    } catch (e) {
      result = { ok: false, reason: 'That move hit an error and was not played.' };
    }
    if (!result || !result.ok) {
      showProblems([result ? result.reason : 'That move could not be played.']);
      return;
    }
    let more = 0;
    const startDay = st.day;
    if (toNextDay) {
      const nextPatrol = () => st.day > startDay && st.phase === 'patrol' && !st.pending.length;
      for (let i = 0; i < 80 && st.phase !== 'ended' && !nextPatrol(); i++) {
        let next = null;
        try {
          next = S.decide(st, S.paramsFor(st), Math.random);
          if (next && !(S.apply(st, next) || {}).ok) next = null;
        } catch (e) {
          next = null;
        }
        if (!next) break;
        more += 1;
      }
    }
    undo.push({ model: before, selected, shot });
    if (undo.length > 30) undo.shift();
    leaveShot();
    model = modelFrom(st, before);
    flags = new Set(model.cells.map((c, n) => (cellSig(c) !== cellSig(before.cells[n]) ? n : -1)).filter((n) => n >= 0));
    applied = { label, changed: [...flags], newDay: model.day !== before.day, doors: model.step === 'patrol' ? model.dest.slice() : [], ended: !!model.ended, step: model.step, office: st.phase === 'office', more, toNextDay: !!toNextDay };
    const filled = [...flags].map((n) => `c${n}`);
    if (applied.newDay && model.step === 'patrol') filled.push('dest');
    if (model.step === 'event') filled.push('event');
    if (model.step === 'choice' && model.choice.kind !== 'gift') filled.push('choice');
    via = { action, label: toNextDay ? `${label}, then the rest of day ${startDay} by the strategy`.slice(0, 120) : label, filled, touched: new Set() };
    solver.st = null;
    solver.id += 1;
    showProblems([]);
    changed();
    $('az-applied').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (toNextDay && !model.ended) toast(`Day ${model.day}. Paste a screenshot of your new day (Ctrl+V) to load it, or fix the cells marked Check.`, 'ok', [{ id: 'pick', label: 'Choose a screenshot', primary: true }]);
  }

  function labelFor(action) {
    const r = solver.result;
    const option = r && r.options.find((o) => S.sameAction(o.action, action));
    if (option) return option.label;
    const match = solver.st && S.candidates(solver.st).find((c) => S.sameAction(c.action, action));
    return match ? match.label : action.type;
  }

  function undoMove() {
    const last = undo.pop();
    if (!last) return;
    reader.undoable = false;
    model = last.model;
    selected = last.selected;
    // An undone screenshot was never right, so it isn't shared.
    held = null;
    shot = !!last.shot;
    flags = new Set();
    applied = null;
    via = null;
    changed();
  }

  // The player set or confirmed part of the board the dice or the reader
  // filled in, so it's known to match their game.
  function touch(key) {
    if (via) via.touched.add(key);
  }

  // ---------- Rendering ----------

  const cellEls = [];

  function buildBoard() {
    const board = $('az-board');
    for (let n = 0; n < T.CELL_COUNT; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.style.gridRow = B.RING[n][0];
      b.style.gridColumn = B.RING[n][1];
      b.innerHTML = B.CELL_HTML;
      b.children[2].textContent = L(n);
      b.addEventListener('click', () => {
        const open = !$('az-pick').hidden && $('az-pick').dataset.cell === String(n);
        select(n);
        if (open) closePick(true);
        else openPick(n);
      });
      board.appendChild(b);
      cellEls[n] = { btn: b, body: b.children[0], hint: b.children[3], badges: b.children[4], tag: b.children[5], warden: b.children[6] };
    }
    // What's in a cell, picked from icons that open right on the cell.
    const pick = document.createElement('div');
    pick.id = 'az-pick';
    pick.className = 'az-pick';
    pick.hidden = true;
    pick.setAttribute('role', 'dialog');
    pick.setAttribute('aria-label', "What's in this cell");
    pick.innerHTML = pickHTML();
    board.appendChild(pick);
  }

  // Every inmate by rarity, then the doors and marks a cell can have.
  function pickHTML() {
    const tiers = T.TIERS.slice(0, TOP_TIER + 1);
    const btn = (value, label, art, cls) => `<button type="button" class="az-ico${cls ? ` ${cls}` : ''}" data-pick="${value}" title="${esc(label)}" aria-label="${esc(label)}">${art}</button>`;
    const row = (label, cls, items) => `<div class="az-pick-row"><span class="az-pick-label${cls ? ` ${cls}` : ''}">${esc(label)}</span>${items.join('')}</div>`;
    return [
      ...tiers.map((name, t) => row(name, `t${t}`, T.BEASTS.map((b) => btn(`inmate:${b}:${t}`, `${name} ${T.beastName(b)}`, B.PORTRAITS[b], `t${t}`)))),
      row('Locked', '', [
        btn('sealed', 'Locked door', B.MARKS.sealed),
        btn('sealed:unknown', 'Locked door with an event (kind unknown)', B.MARKS.event),
        btn('sealed:chain', 'Locked door with a Chain reaction', B.MARKS.chain),
        btn('sealed:execution', 'Locked door with an Execution', B.MARKS.execution),
        btn('sealed:trickster', 'Locked door with Behind Closed Doors', B.MARKS.trickster),
        btn('sealed:appetite', 'Locked door with Ravenous Appetite', B.MARKS.appetite),
        btn('sealed:convict', 'Locked door with High-Risk Convict', B.MARKS.convict),
        btn('sealed:crow', 'Locked door with Crow Whispers', B.MARKS.crow),
        btn('sealed:freedom', 'Locked door with Taste of Freedom', B.MARKS.freedom),
        btn('sealed:portion', 'Locked door with Extra Portion', B.MARKS.portion),
        btn('sealed:usurp1', 'Locked door with Usurpation I', B.MARKS.usurp1),
        btn('sealed:usurp2', 'Locked door with Usurpation II', B.MARKS.usurp2),
        btn('sealed:usurp3', 'Locked door with Usurpation III', B.MARKS.usurp3),
        btn('sealed:usurp4', 'Locked door with Usurpation IV', B.MARKS.usurp4),
        btn('sealed:ratway', 'Locked door with the Sewer Ratway', B.MARKS.ratway),
        btn('sealed:hunt', 'Locked door with the "Treasure" Hunt', B.MARKS.hunt),
        btn('dark', 'Locked door the "Treasure" Hunt left dark: Rare or better inside', B.MARKS.dark, 't2'),
        btn('scouted', "Scouted door (Warden's Scales): set its beast and rarity in the panel below", B.MARKS.scouted),
      ]),
      row('Other', '', [btn('nest', 'Rat nest', B.MARKS.nest), btn('empty', 'Empty cell', B.MARKS.empty), btn('ivory', 'Tusk mark: toggles on the inmate here', B.MARKS.ivory)]),
      row('Scratched', '', tiers.map((name, t) => btn(`scratch:${t}`, `Scratched door showing ${name}`, B.MARKS.scratch, `t${t}`))),
      row('Rarity shown', '', tiers.map((name, t) => btn(`revealed:${t}`, `Locked door showing a ${name} inside, beast unknown (a "?" portrait)`, B.MARKS.revealed, `t${t}`))),
    ].join('');
  }

  // The picker's choice for what a cell holds.
  function pickValue(c) {
    const tier = clamp(toInt(c.tier, 0), 0, TOP_TIER);
    if (c.kind === 'inmate') return `inmate:${c.beast}:${tier}`;
    if (c.kind === 'scratch') return `scratch:${tier}`;
    if (c.kind === 'revealed') return `revealed:${tier}`;
    if (c.kind === 'scouted') return 'scouted';
    if (c.kind === 'sealed') return c.atLeast && !c.event ? 'dark' : c.event ? `sealed:${c.event}` : 'sealed';
    return c.kind;
  }

  function setHTML(el, html) {
    if (el.__html !== html) {
      el.innerHTML = html;
      el.__html = html;
    }
  }

  function renderBoard() {
    const { st } = buildState(model);
    const rec = fresh() && settled() ? recommendation() : null;
    const a = rec ? rec.action : null;
    const best = new Set();
    if (a && a.type === 'patrol') best.add(a.cell);
    if (a && a.type === 'devour') best.add(a.to);
    if (a && a.type === 'swap') best.add(st.position);
    const doors = model.step === 'patrol' ? new Set(model.dest) : new Set();
    $('az-board').classList.toggle('is-patrolling', doors.size > 0);
    for (const cell of st.cells) {
      const el = cellEls[cell.n];
      const p = B.cellParts(cell, st);
      const mc = model.cells[cell.n];
      // Name the event's kind when the player knows it.
      let badges = p.badges;
      if (mc.event === 'chain') badges = badges.replace('>Event<', '>Chain<');
      else if (mc.event === 'execution') badges = badges.replace('>Event<', '>Execution<');
      else if (mc.event === 'trickster') badges = badges.replace('>Event<', '>Closed Doors<');
      else if (mc.event === 'appetite') badges = badges.replace('>Event<', '>Appetite<');
      else if (mc.event === 'convict') badges = badges.replace('>Event<', '>Convict<');
      else if (mc.event === 'crow') badges = badges.replace('>Event<', '>Crow<');
      else if (mc.event === 'freedom') badges = badges.replace('>Event<', '>Freedom<');
      else if (mc.event === 'usurp1') badges = badges.replace('>Event<', '>Usurp. I<');
      else if (mc.event === 'portion') badges = badges.replace('>Event<', '>Portion<');
      else if (mc.event === 'usurp2') badges = badges.replace('>Event<', '>Usurp. II<');
      else if (mc.event === 'hunt') badges = badges.replace('>Event<', '>Hunt<');
      if (cell.n === selected) p.cls.push('is-selected');
      if (doors.has(cell.n)) p.cls.push('is-dest');
      if (flags.has(cell.n)) p.cls.push('is-check');
      if (best.has(cell.n)) p.cls.push('is-hint');
      el.btn.className = p.cls.join(' ');
      setHTML(el.body, p.body);
      setHTML(el.hint, p.hint);
      setHTML(el.badges, badges);
      setHTML(el.warden, p.warden ? B.LANTERN : '');
      const tag = best.has(cell.n) ? (a.type === 'swap' ? 'Replace' : a.type === 'devour' ? 'Eat' : 'Go') : flags.has(cell.n) ? 'Check' : doors.has(cell.n) ? 'Door' : '';
      el.tag.textContent = tag;
      el.btn.setAttribute('aria-label', `${p.label}${doors.has(cell.n) ? ". One of today's doors" : ''}${tag === 'Check' ? '. Changed by the simulator: check it against your game' : ''}`);
      el.btn.setAttribute('aria-pressed', String(cell.n === selected));
    }
  }

  function renderCourt() {
    const working = fresh() && !settled();
    const rec = fresh() && settled() ? recommendation() : null;
    let title;
    let detail;
    if (model.treasureWait && !reading) {
      title = 'The Warden’s Treasure: check the board first';
      detail = 'Press View Prison Status in the game, wait a second on the board, then return. Auto Screenshot Mode reads the board while you look.';
    } else if (reading) {
      title = 'Reading the new picture…';
      detail = 'The advice follows as soon as it’s read.';
    } else if (working) {
      const c = checking();
      title = 'Working it out…';
      detail = `${T.plural(c.moves.length, 'move')}, ${c.each.toLocaleString()} games each: ${c.played.toLocaleString()} of ${c.total.toLocaleString()} played`;
    } else if (rec) {
      title = rec.label;
      detail = rec.option ? expectText(solver.result.goal, rec.option, solver.st) : 'Checking with playouts…';
    } else {
      const day = `Day ${model.day} of ${model.maxDays}`;
      title = 'Your board';
      detail = `${day} · ${STEP_NAMES[model.step]} · warden ${model.warden === T.OFFICE ? 'in the office' : `at cell ${L(model.warden)}`}`;
    }
    const busy = reading || working;
    setHTML($('az-court'), `<div class="decision${rec && !busy ? ' az-court-rec' : ''}${busy ? ' az-court-busy' : ''}"><div class="decision-text"><p class="decision-title">${busy ? SPIN : rec ? '<span class="az-court-eyebrow">Do this</span>' : ''}${esc(title)}</p><p class="decision-detail">${esc(detail)}</p></div></div>`);
  }

  function pressGroup(id, value) {
    for (const b of $(id).querySelectorAll('button[data-v]')) b.setAttribute('aria-pressed', String(b.dataset.v === value));
  }

  function renderEditor() {
    const n = selected;
    const c = model.cells[n];
    const office = n === T.OFFICE;
    $('az-cell-title').textContent = office ? 'Cell 01 · the office' : `Cell ${L(n)}`;
    $('az-warden').setAttribute('aria-pressed', String(model.warden === n));
    $('az-door').hidden = n === model.warden || model.step !== 'patrol';
    $('az-door').setAttribute('aria-pressed', String(model.dest.includes(n)));
    $('az-match').hidden = office || !flags.has(n);
    $('az-office-note').hidden = !office;
    $('az-cell-fields').hidden = office;
    if (office) return;
    pressGroup('az-kind', c.kind);
    const inmate = c.kind === 'inmate';
    const scouted = c.kind === 'scouted';
    const tiered = inmate || scouted || c.kind === 'scratch' || c.kind === 'revealed';
    $('az-beast-field').hidden = !(inmate || scouted);
    $('az-tier-field').hidden = !tiered;
    $('az-tier-legend').textContent = inmate ? 'Rarity' : scouted ? 'Rarity the scales showed' : 'Rarity you can see on the door';
    const tier = tiered ? clamp(toInt(c.tier, 0), 0, TOP_TIER) : 0;
    for (const b of $('az-beasts').querySelectorAll('button')) {
      b.className = `az-beast t${tier}`;
      b.setAttribute('aria-pressed', String((inmate || scouted) && b.dataset.v === c.beast));
    }
    for (const b of $('az-tiers').querySelectorAll('button')) b.setAttribute('aria-pressed', String(tiered && Number(b.dataset.v) === tier));
    $('az-inmate-extra').hidden = !inmate;
    if (inmate) {
      $('az-ivory').checked = !!c.ivory;
      const { st } = buildState(model);
      const lion = c.beast === 'lion';
      $('az-prey-field').hidden = !lion;
      if (lion) {
        const meals = st.cells.filter((o) => o.n !== n && !o.sealed && o.inmate && T.canEat(st, st.cells[n].inmate, o.inmate));
        const current = c.prey ? c.prey.cell : null;
        $('az-prey').innerHTML = `<option value="">No prey mark</option>${meals.map((o) => `<option value="${o.n}"${o.n === current ? ' selected' : ''}>Cell ${L(o.n)}: ${esc(T.describe(o.inmate))}</option>`).join('')}`;
        $('az-prey-rounds').value = String(c.prey ? c.prey.rounds : T.DEFAULT_PARAMS.preyRounds);
        $('az-prey-rounds').closest('.field').hidden = !c.prey;
      }
      const hunter = model.cells.findIndex((o) => o.kind === 'inmate' && o.beast === 'lion' && o.prey && o.prey.cell === n);
      $('az-prey-of').hidden = hunter < 0;
      if (hunter >= 0) $('az-prey-of').textContent = `Marked as prey by the Lion in cell ${L(hunter)}: both rise a tier each morning for ${T.plural(model.cells[hunter].prey.rounds, 'more morning')}.`;
    }
    $('az-event-field').hidden = !(c.kind === 'sealed' || c.kind === 'scratch' || c.kind === 'revealed' || c.kind === 'inmate' || scouted);
    $('az-event-field').querySelector('legend').textContent = c.kind === 'inmate' ? 'Event in the cell (a "!" beside the inmate)' : 'Event behind the door';
    pressGroup('az-event', c.event || 'none');
    $('az-nest-field').hidden = c.kind !== 'nest';
    if (c.kind === 'nest') $('az-nest-due').value = String(toInt(c.due, model.day + 2));
  }

  function renderSettings() {
    const maxDays = clamp(toInt(model.maxDays, 20), 5, 60);
    // The game counts down: "N day(s) until Riot" on day maxDays - N.
    const riot = $('az-riot');
    riot.max = String(maxDays - 1);
    if (document.activeElement !== riot) riot.value = String(maxDays - clamp(toInt(model.day, 1), 1, maxDays));
    $('az-dayof').textContent = `Day ${model.day} of ${maxDays}`;
    $('az-days').value = String(maxDays);
    pressGroup('az-step', model.step);
    for (const box of document.querySelectorAll('.az-stepbox')) {
      const steps = box.dataset.step.split(' ');
      box.hidden = !steps.includes(model.step);
    }
    // Today's doors: the cells within reach of the warden, plus any ticked.
    const ahead = [];
    for (let i = 1; i < T.CELL_COUNT && ahead.length < T.DEFAULT_PARAMS.patrolRange; i++) {
      ahead.push((model.warden + i) % T.CELL_COUNT);
    }
    const doors = [...new Set([...ahead, ...model.dest])];
    setHTML($('az-doors'), doors
      .map((n) => `<button type="button" class="az-doorcard" data-door="${n}" aria-pressed="${model.dest.includes(n)}"><span class="az-doorcard-arch" aria-hidden="true"></span><span class="az-doorcard-go">${n === T.OFFICE ? 'Go to Interrogation Room' : `Go to Cell ${n + 1}`}</span><small>${esc(cellShort(model.cells[n]))}</small></button>`)
      .join(''));
    $('az-devoured').checked = !!model.devourUsed;
    $('az-swapped').checked = !!model.swapUsed;
    $('az-consume-offered').checked = !!model.consumeOffered;
    $('az-consume-offered-wrap').hidden = !model.swapUsed;
    pressGroup('az-event-kind', model.eventKind);
    pressGroup('az-choice-kind', model.choice.kind);
    renderOffer();
    $('az-armed').checked = !!model.chainArmed;
    for (const b of $('az-tools').querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(model.tools.includes(b.dataset.tool)));
    $('az-tools-confirm').hidden = !model.toolsToConfirm;
    $('az-tools-confirm-text').textContent = model.toolsToConfirm || '';
    if (model.toolsToConfirm && model.toolsToConfirm !== toolsAsked) openTools();
    toolsAsked = model.toolsToConfirm || '';
    // The run's instruments first, in the order they were gained, then the
    // rest; the list scrolls back to the top when its order changes.
    const toolBox = $('az-tools');
    const held = model.tools.filter((id) => T.TOOLS[id]);
    const order = held.concat(T.TOOL_IDS.filter((id) => !held.includes(id)));
    if (toolBox.dataset.order !== order.join(',')) {
      for (const id of order) {
        const el = toolBox.querySelector(`[data-tool="${id}"]`);
        if (el) toolBox.appendChild(el);
        if (id === held[held.length - 1]) toolBox.appendChild($('az-tools-rest'));
      }
      $('az-tools-rest').hidden = !held.length;
      toolBox.dataset.order = order.join(',');
      toolBox.scrollTop = 0;
    }
    $('az-rewards').checked = !!model.rewards;
    const goal = model.objective;
    $('az-objective').value = goal;
    $('az-objective-text').textContent = T.OBJECTIVES[goal].text;
    const card = T.START_EVENTS && T.START_EVENTS[model.startEvent];
    $('az-start-event').value = card ? model.startEvent : 'none';
    $('az-start-text').hidden = !card;
    $('az-start-text').textContent = card ? `${card.text}.` : '';
    renderPlayNotes();
    const goalNeed = T.OBJECTIVES[goal].need || 0;
    $('az-walk-wrap').hidden = !goalNeed;
    $('az-walk-unit').textContent = T.OBJECTIVES[goal].unit || 'Progress';
    $('az-walk-need').textContent = `/${goalNeed}`;
    $('az-walk').max = String(goalNeed);
    if (document.activeElement !== $('az-walk')) $('az-walk').value = String(model.walkTiles);
    $('az-milestone').checked = !!model.milestone || (goalNeed > 0 && model.walkTiles >= goalNeed);
    // Ten slots like the game's, more if the vault holds more.
    const slots = Math.max(10, model.vault.length + (model.vault.length % 2));
    setHTML($('az-vault'), Array.from({ length: slots }, (_, i) => {
      const beast = model.vault[i];
      return beast
        ? `<button type="button" class="az-hex is-filled t5" data-unvault="${i}" title="Chromatic ${esc(T.beastName(beast))}: click to remove">${B.PORTRAITS[beast]}</button>`
        : '<span class="az-hex" aria-hidden="true"></span>';
    }).join(''));
  }

  function cellShort(c) {
    if (!c) return '';
    if (c.kind === 'inmate') return `${T.tierName(c.tier).slice(0, 3)} ${T.beastName(c.beast)}`;
    if (c.kind === 'scratch') return `${T.tierName(c.tier).slice(0, 3)} door`;
    if (c.kind === 'revealed') return `${T.tierName(c.tier).slice(0, 3)} inside`;
    if (c.kind === 'scouted') return `Scouted ${T.tierName(c.tier).slice(0, 3)} ${T.beastName(c.beast)}`;
    if (c.kind === 'nest') return 'Nest';
    if (c.kind === 'empty') return 'Empty';
    if (c.kind === 'office') return 'Office';
    return c.event ? 'Event' : 'Sealed';
  }

  function renderOffer() {
    const kind = model.choice.kind;
    if (kind === 'gift') {
      $('az-offer').innerHTML = `<p class="field-note">The Warden's Treasure always offers all four gifts: ${T.GIFT_IDS.map((id) => esc(T.toolName(id))).join(', ')}.</p>` +
        // Opulence gives 3 picks a Treasure: the advice weighs them all.
        `<label class="field"><span class="field-label">Picks left, this one included</span><input type="number" id="az-gift-picks" min="1" max="30" step="1" value="${model.choice.picks || 1}"></label>`;
      return;
    }
    const free = T.TOOL_IDS.filter((id) => !model.tools.includes(id));
    const picks = [0, 1, 2].map((i) => model.choice.options[i] || '');
    $('az-offer').innerHTML = picks
      .map((value, i) => `<label class="field"><span class="field-label">Option ${i + 1}</span><select data-offer="${i}"><option value="">None</option>${free.map((id) => `<option value="${id}"${id === value ? ' selected' : ''}>${esc(T.toolName(id))}</option>`).join('')}</select></label>`)
      .join('') +
      // A pet's re-roll: the game shows "Re-roll" with the attempts left.
      (kind === 'tool' ? `<label class="field"><span class="field-label">Re-rolls left</span><input type="number" id="az-rerolls" min="0" max="9" step="1" value="${model.choice.rerolls || 0}"></label>` : '');
  }

  // Updates a list in place, keeping rows by key, so a button under the
  // pointer survives the refreshes of a live check.
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

  // The instruments in a window over the middle of the board, with a search
  // by name (the user: the side column's list was too hard to look
  // through). The list and the confirm prompt move into it while it's open,
  // keeping their ids and handlers, and go back when it closes.
  let toolsAsked = '';
  function openTools() {
    const d = $('az-tools-dialog');
    if (d.open) return;
    $('az-tools-dialog-body').append($('az-tools-confirm'), $('az-tools'));
    $('az-tools-search').value = '';
    filterTools('');
    d.show();
    placeTools();
    $('az-tools-search').focus({ preventScroll: true });
  }
  function closeTools() {
    const d = $('az-tools-dialog');
    if (!d.open) return;
    filterTools('');
    d.close();
    $('az-tools-open').after($('az-tools'));
    $('az-tools-open').before($('az-tools-confirm'));
  }
  // Over the middle of the board, kept on the screen.
  function placeTools() {
    const d = $('az-tools-dialog');
    if (!d.open) return;
    const r = $('az-board').getBoundingClientRect();
    const w = d.offsetWidth;
    const h = d.offsetHeight;
    const keep = (v, size, room) => Math.max(8, Math.min(room - size - 8, v - size / 2));
    // The part of the board that's on the screen.
    const x0 = Math.max(0, r.left);
    const x1 = Math.min(window.innerWidth, r.right);
    const y0 = Math.max(0, r.top);
    const y1 = Math.min(window.innerHeight, r.bottom);
    d.style.left = `${keep(x1 > x0 ? (x0 + x1) / 2 : window.innerWidth / 2, w, window.innerWidth)}px`;
    d.style.top = `${keep(y1 > y0 ? (y0 + y1) / 2 : window.innerHeight / 2, h, window.innerHeight)}px`;
  }
  function filterTools(q) {
    const t = String(q || '').trim().toLowerCase();
    for (const b of $('az-tools').querySelectorAll('[data-tool]')) b.hidden = !!t && !T.toolName(b.dataset.tool).toLowerCase().includes(t);
    $('az-tools-rest').hidden = !!t || !model.tools.some((id) => T.TOOLS[id]);
  }

  // What to click for the advice, on the last picture and in its pixels:
  // the door card of a patrol, the decision card (Consume, Replace, End,
  // Instigate, Bestow), the meal's cell, the instrument offer's card. For
  // the desktop app's box over the game (the user, 2026-10-24). Only while
  // the advice is settled, for the board as just read.
  let lastPick = null;
  // When the last picture came: the app shows a box only from a picture that
  // came after the last click in the game.
  let pictureAt = 0;
  let highlightWhy = ''; // why there was no box, for the debug report
  let highlightLoading = false;
  // test: an action to box instead of the advice's (for checking the boxes).
  function highlight(test) {
    const rec = test ? { action: test, label: test.type } : solver.st && fresh() && settled() ? recommendation() : null;
    highlightWhy = rec ? '' : `no settled advice (${[!solver.st && 'no check', solver.st && !fresh() && 'board changed', !settled() && 'still checking'].filter(Boolean).join(', ') || 'no pick'})`;
    if (!rec) return null;
    const a = rec.action;
    const out = (w, h, box) => (box ? { w, h, at: pictureAt, label: rec.label, box: box.map(Math.round) } : null);
    // An instrument offer: three cards, the middle one in the middle, 480
    // apart in a picture 1080 high (the game's layout grows with the
    // height), each about 430 wide from 365 above the middle to 332 below.
    if (a.type === 'choose' && model.step === 'choice' && model.choice.kind === 'tool' && lastPick) {
      const k = model.choice.options.indexOf(a.id);
      if (k < 0 || model.choice.options.length !== 3) return null;
      const { w, h } = lastPick;
      const u = h / 1080;
      const c = w / 2 + (k - 1) * 480 * u;
      return out(w, h, [c - 215 * u, h / 2 - 365 * u, c + 215 * u, h / 2 + 332 * u]);
    }
    const r = reader.result;
    const pic = reader.image;
    if (!shot || !r || !r.ok || !pic || !r.loc) {
      highlightWhy = `no board reading (${[!shot && 'not a picture', !r && 'no result', r && !r.ok && 'not read', !pic && 'no image', r && !r.loc && 'no board place'].filter(Boolean).join(', ')})`;
      return null;
    }
    highlightWhy = `${a.type}: nothing to box`;
    const w = pic.width;
    const h = pic.height;
    const TS = window.TartarusScan;
    // A cell on the board, around its middle.
    const cellBox = (n) => {
      if (!TS || !TS.RING || !TS.RING[n]) return null;
      const [u, v] = TS.RING[n];
      const [cx, cy] = TS.at(r.loc, u, v);
      const k = TS.scaleAt(r.loc, u, v) * 119.45 * 0.47;
      return [cx - k, cy - 1.15 * k, cx + k, cy + 1.15 * k];
    };
    // The decision cards: in a row centred under the board, each about 1.8
    // cells wide, in a band below the bottom row; in their order (Consume,
    // Replace, End; or Instigate, Bestow), only the ones on offer.
    const dec = r.decision || {};
    const order = dec.office ? ['instigate', 'bestow'] : ['consume', 'replace', 'end'].filter((k) => dec[k]);
    const card = (name) => {
      const i = order.indexOf(name);
      if (!TS || i < 0) {
        highlightWhy = `${a.type}: the ${name} card wasn't seen (decision row: ${JSON.stringify(dec)})`;
        return null;
      }
      const [cx, cy] = TS.at(r.loc, 2.5, 3);
      const p = TS.scaleAt(r.loc, 2.5, 3) * 119.45;
      const cw = 1.82 * p;
      const gap = 0.08 * p;
      const x0 = cx - (order.length * cw + (order.length - 1) * gap) / 2 + i * (cw + gap);
      return [x0, cy + 0.66 * p, x0 + cw, cy + 1.61 * p];
    };
    switch (a.type) {
      case 'patrol': {
        // Its door card ("Go to Cell N"), around the card's text. Nothing
        // while the cards aren't read: a box on the wrong thing is worse
        // than none.
        const i = r.doors && r.doors.cells ? r.doors.cells.indexOf(a.cell) : -1;
        const t = i >= 0 && r.doors.boxes ? r.doors.boxes[i] : null;
        if (!t) {
          highlightWhy = `patrol: the door card for ${a.cell} wasn't read`;
          return null;
        }
        const tw = t[2] - t[0];
        const th = t[3] - t[1];
        return out(w, h, [t[0] - 0.7 * tw, t[3] - 6.8 * th, t[2] + 0.7 * tw, t[3] + 1.3 * th]);
      }
      case 'devour': return out(w, h, card('consume'));
      case 'swap': return out(w, h, card('replace'));
      case 'end': return out(w, h, card('end'));
      case 'office': return out(w, h, card(a.choice));
      // A meal's cell on the meal pick; the Hunt's prey on its pick of a cell.
      case 'chain': return out(w, h, r.chain ? cellBox(a.to) : null);
      case 'hunt': return out(w, h, dec.ratway ? cellBox(a.to) : null);
      default: return null;
    }
  }

  const actionKey = (a) => [a.type, a.cell, a.to, a.id, a.accept, a.choice].join('|');

  function renderResults() {
    $('az-treasure-wait').hidden = !model.treasureWait;
    const box = $('az-results');
    box.hidden = !solver.st;
    if (!solver.st) return;
    const st = solver.st;
    const stale = !fresh();
    box.classList.toggle('is-stale', stale);
    const working = !settled();
    const rec = working ? null : recommendation();
    const r = solver.result;
    const goal = 'rainbows';
    // The board changed since this check: its advice was for the board
    // before, so it isn't shown (report 304: a player took the dimmed move
    // for the advice on the new board). Recheck gives the new advice.
    $('az-res-eyebrow').textContent = stale ? 'The board changed' : 'Recommended';
    // Always through setHTML, which skips what it wrote last: a headline
    // written past it left a new check showing the old move.
    if (stale) setHTML($('az-res-move'), 'Press Recheck for advice on this board');
    else if (working) setHTML($('az-res-move'), `${SPIN}Working it out…`);
    else setHTML($('az-res-move'), esc(rec ? rec.label : 'Nothing to decide here.'));
    $('az-do').hidden = !rec || stale;
    $('az-do').textContent = rec && rec.action.type === 'end' ? 'End the day here' : 'Do it here';
    $('az-next').hidden = !rec || stale;
    $('az-undo').hidden = !undo.length;
    // After a screenshot, or once the board has changed: fix it and recheck.
    $('az-res-shot').hidden = !shot && !stale;
    $('az-fix').hidden = !shot;
    $('az-report-reading').hidden = !(shot && reader.result && reader.image && window.TartarusReport);
    $('az-recheck').classList.toggle('btn-primary', stale);
    $('az-res-shot-text').textContent = stale
      ? 'The board changed since this check. Recheck for advice on the board as it is now.'
      : `Read from your screenshot${flags.size ? `, with ${T.plural(flags.size, 'cell')} marked Check` : ''}.${unsureTools()} If anything on the board doesn’t match your game, fix it, then Recheck.`;
    let body = '';
    if (working && !stale) body += `<p class="trainer-source">Each move below is played out from your board, with everything you can’t see re-rolled each time. The advice shows when they’re all done, so it won’t change.</p>`;
    if (rec && !stale) {
      body += `<p class="trainer-source">${esc(rec.live ? `Checked by ${rec.rounds.toLocaleString()} playouts per option` : 'Instant pick from training')}</p>`;
      if (rec.why) body += `<p class="trainer-why">${esc(rec.why)}</p>`;
      if (rec.option) body += `<p class="trainer-why">${esc(expectText(goal, rec.option, st))}</p>`;
      if (rec.action.type === 'devour') {
        const odds = S.chainOdds(st, st.position, rec.action.to);
        body += `<p class="trainer-lesson">If the chain then goes on with the best meal at each bite: ${odds.bites.toFixed(1)} bites on average, ${(100 * odds.rainbow).toFixed(0)}% to reach Rainbow. Your game's Cancel can stop it at any bite.</p>`;
      }
      body += `<p class="trainer-lesson">${esc(afterText(rec.action))}</p>`;
    }
    setHTML($('az-res-body'), body);
    const c = checking();
    const options = working ? c.moves : r ? r.options : [];
    const status = $('az-res-status');
    if (stale) status.textContent = '';
    else if (working) status.textContent = `Playing out ${T.plural(c.moves.length, 'move')}, ${c.each.toLocaleString()} games each: ${c.played.toLocaleString()} of ${c.total.toLocaleString()} games played`;
    else if (!r) status.textContent = 'Live check: starting…';
    else if (options.length <= 1) status.textContent = options.length ? 'Only one move here.' : 'Nothing to decide right now.';
    else status.textContent = r.done ? `Live check: ${r.rounds.toLocaleString()} playouts per option` : `Live check: ${r.rounds.toLocaleString()} playouts per option so far…`;
    const max = Math.max(0.01, ...options.map((o) => o.mean || 0));
    const shown = options.length > 1 && !stale ? options : [];
    syncRows(
      $('az-res-list'),
      shown,
      (o) => actionKey(o.action),
      () => {
        const li = document.createElement('li');
        li.className = 'solver-row';
        li.innerHTML = '<span class="solver-label"><span class="solver-text"></span><span class="solver-tag" hidden>strategy</span></span><span class="solver-value"></span><span class="solver-meter"><span></span></span><span class="solver-sub" hidden></span>';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = 'Do this here';
        btn.addEventListener('click', () => li.option && doMove(li.option.action));
        li.appendChild(btn);
        li.btn = btn;
        return li;
      },
      (li, o) => {
        li.option = o;
        li.classList.toggle('is-working', working);
        if (working) {
          // While the check runs: each move with its progress, no scores.
          li.classList.remove('is-best');
          li.querySelector('.solver-text').textContent = o.label;
          li.querySelector('.solver-tag').hidden = true;
          li.querySelector('.solver-value').textContent = `${c.done.toLocaleString()} / ${c.each.toLocaleString()}`;
          li.querySelector('.solver-value').title = 'Games played out for this move so far';
          li.querySelector('.solver-meter span').style.width = `${Math.max(2, 100 * (c.each ? c.done / c.each : 0)).toFixed(1)}%`;
          li.querySelector('.solver-sub').hidden = true;
          li.btn.hidden = true;
          return;
        }
        const chosen = rec ? S.sameAction(o.action, rec.action) : o === options[0];
        li.classList.toggle('is-best', chosen);
        li.querySelector('.solver-text').textContent = o.label;
        li.querySelector('.solver-tag').hidden = !o.policy;
        const value = li.querySelector('.solver-value');
        value.textContent = fmtOption(goal, o, st);
        value.title = 'Expected Rainbows in the vault by the end of the run, with a 95% margin';
        const width = (100 * o.mean) / max;
        li.querySelector('.solver-meter span').style.width = `${Math.max(2, width).toFixed(1)}%`;
        const sub = li.querySelector('.solver-sub');
        let subText = '';
        if (o.action.type === 'devour') {
          const odds = S.chainOdds(st, st.position, o.action.to);
          subText = `chain: ${odds.bites.toFixed(1)} bites on average, ${(100 * odds.rainbow).toFixed(0)}% to Rainbow`;
        }
        sub.hidden = !subText;
        sub.textContent = subText;
        li.btn.hidden = chosen || stale;
      },
    );
    const top = options[0];
    const second = options[1];
    const close = top && second && top.mean - second.mean < Math.max(1.96 * second.gapSe, SWITCH_MIN);
    $('az-res-note').textContent = working || shown.length < 2
      ? ''
      : close
        ? 'The top moves are within the margin of error: either is fine.'
        : 'Each option is played out from your board with everything you can’t see re-rolled, and the trained strategy making every later choice. Scores are Rainbows in the vault by the end of the run.';
  }

  // What the player does after following the advice in their game.
  function afterText(action) {
    switch (action.type) {
      case 'patrol': return 'In your game, walk there. Then set the cell to what the door reveals (or press Do it here and fix it), and ask again.';
      case 'devour': return 'In your game, start the consume on that target. Then update the cells the chain changed, and ask again.';
      case 'chain': return 'In your game, pick that meal. Then paste the next screen, or update the cells that changed, and ask again.';
      case 'stopchain': return 'In your game, press Cancel on the meal screen. Today’s consume is used, so the day ends next.';
      case 'swap': return 'In your game, replace the warden’s inmate. Then set the warden’s cell to what came in, and ask again.';
      case 'end': return 'In your game, end the day. Then mark the new day’s doors, and ask again.';
      case 'event': return model.step === 'event' && model.eventKind === 'hunt'
        ? 'In your game, press Confirm. Then set each door showing a "?" to its rarity (Rarity shown); the doors left dark hold Rare or better (Do it here marks them, with the simulator’s dice for the rest). Ask again.'
        : 'Then update what changed, and ask again.';
      case 'office': return 'In your game, press it. Then paste a screenshot of what changed (or set it here under Make Your Decision), and ask again.';
      case 'choose': return 'Take it in your game, then ask again.';
      default: return 'Then update the board, and ask again.';
    }
  }

  function renderApplied() {
    const box = $('az-applied');
    box.hidden = !applied;
    if (!applied) return;
    let html = `<p class="trainer-eyebrow">Played here with the simulator's dice</p><p class="az-applied-move">${esc(applied.label)}</p>`;
    if (applied.toNextDay && !applied.ended) html += `<p class="trainer-why">${applied.more ? `Then the strategy played the rest of the day (${applied.more} more ${applied.more === 1 ? 'move' : 'moves'}), as if you followed its advice. ` : ''}What really happened in your game will differ: paste a screenshot of your new day (Ctrl+V) to load it, or fix the cells marked Check.</p>`;
    if (applied.ended) html += '<p class="trainer-why">That ended the run. Load another board, or play a new run in the simulator.</p>';
    else {
      if (applied.changed.length) html += `<p class="trainer-why">${applied.changed.length === 1 ? 'Cell' : 'Cells'} ${applied.changed.map(L).join(', ')} changed, marked Check. Set ${applied.changed.length === 1 ? 'it' : 'them'} to what your game shows.</p>`;
      if (applied.newDay && applied.step === 'patrol') html += `<p class="trainer-why">It's now day ${model.day}. The simulator rolled today's doors (${applied.doors.map(L).join(', ') || 'none'}); tick the ones your game offers.</p>`;
      if (applied.step === 'choice') html += '<p class="trainer-why">A tool or gift is on offer: set the options your game shows.</p>';
      if (applied.step === 'event') html += "<p class=\"trainer-why\">The door held a special event: check its kind in your game.</p>";
      if (applied.office) html += '<p class="trainer-why">The warden is in the office. If your game shows the Instigate and Bestow buttons, pick “Instigate or Bestow” above, or paste a screenshot of them. Otherwise carry on with “Make Your Decision”.</p>';
      html += '<p class="trainer-lesson">Then press “What should I do?” for the next move.</p>';
    }
    const unchecked = via && !applied.ended ? via.filled.filter((k) => !via.touched.has(k)).length : 0;
    if (via && via.filled.length && !unchecked && !applied.ended) html += '<p class="trainer-why">Checked against your game.</p>';
    html += `<div class="az-res-actions">${unchecked ? '<button type="button" class="btn" data-match>Everything here matches my game</button>' : ''}<button type="button" class="btn" data-undo>Undo</button></div>`;
    setHTML(box, html);
  }

  // The line under the ask button: whether boards are shared, and the switch.
  function renderShare() {
    const box = $('az-share');
    if (!SHARE) {
      box.hidden = true;
      return;
    }
    const seen = SHARE.shared ? ' · <button type="button" class="link" data-share="see">See what’s been shared</button>' : '';
    setHTML(box, SHARE.sharing
      ? `Boards you ask about in a row are shared anonymously, to measure the live game's odds. <button type="button" class="link" data-share="off">Turn off</button>${seen}`
      : `Sharing is off, so nothing leaves this browser. <button type="button" class="link" data-share="on">Share boards to help measure live's odds</button>${seen}`);
  }

  function showProblems(problems) {
    const list = $('az-problems');
    list.hidden = !problems.length;
    list.innerHTML = problems.map((p) => `<li>${esc(p)}</li>`).join('');
  }

  function render() {
    renderBoard();
    renderCourt();
    renderEditor();
    renderSettings();
    renderResults();
    renderApplied();
    renderShare();
  }

  // ---------- Editing ----------

  function select(n) {
    selected = clamp(n, 0, T.CELL_COUNT - 1);
    save();
    renderBoard();
    renderEditor();
  }

  // Opens the picker by cell n, below it if it fits on the board, else above.
  function openPick(n) {
    const pick = $('az-pick');
    if (n === T.OFFICE) {
      closePick(false);
      return;
    }
    const c = model.cells[n];
    const current = pickValue(c);
    pick.dataset.cell = String(n);
    for (const b of pick.querySelectorAll('[data-pick]')) {
      const ivory = b.dataset.pick === 'ivory';
      b.setAttribute('aria-pressed', String(ivory ? c.kind === 'inmate' && !!c.ivory : b.dataset.pick === current));
      if (ivory) b.disabled = c.kind !== 'inmate';
    }
    pick.hidden = false;
    const cell = cellEls[n].btn;
    const board = $('az-board');
    const w = pick.offsetWidth;
    const h = pick.offsetHeight;
    const below = cell.offsetTop + cell.offsetHeight + 6;
    const above = cell.offsetTop - h - 6;
    pick.style.left = `${clamp(cell.offsetLeft + (cell.offsetWidth - w) / 2, 0, Math.max(0, board.clientWidth - w))}px`;
    pick.style.top = `${below + h <= board.clientHeight || above < 0 ? below : above}px`;
    (pick.querySelector('[aria-pressed="true"]:not([data-pick="ivory"])') || pick.querySelector('[data-pick]')).focus();
  }

  function closePick(refocus) {
    const pick = $('az-pick');
    if (pick.hidden) return;
    pick.hidden = true;
    const n = Number(pick.dataset.cell);
    if (refocus && cellEls[n]) cellEls[n].btn.focus();
  }

  function pickCell(n, value) {
    if (value === 'ivory') {
      if (model.cells[n].kind === 'inmate') setCell(n, { ivory: !model.cells[n].ivory });
      return;
    }
    if (value === 'scouted') {
      const c = model.cells[n];
      setCell(n, { kind: 'scouted', beast: c.beast || 'mammoth', tier: toInt(c.tier, 0) });
      return;
    }
    const [kind, a, b] = value.split(':');
    if (kind === 'inmate') setCell(n, { kind, beast: a, tier: Number(b) });
    else if (kind === 'scratch' || kind === 'revealed') setCell(n, { kind, tier: Number(a) });
    else if (kind === 'sealed') setCell(n, { kind, event: a || null, atLeast: 0 });
    else if (kind === 'dark') setCell(n, { kind: 'sealed', atLeast: 2 });
    else setCell(n, { kind });
  }

  // Ends prey marks that no longer point at a meal the Lion can eat.
  function cleanPrey() {
    const { st } = buildState(Object.assign({}, model, { step: 'manage' }));
    model.cells.forEach((c, n) => {
      if (!c.prey) return;
      const lion = st.cells[n];
      const target = st.cells[c.prey.cell];
      const ok = c.kind === 'inmate' && c.beast === 'lion' && target && target.inmate && T.canEat(st, lion.inmate, target.inmate);
      if (!ok) model.cells[n] = Object.assign({}, c, { prey: null });
    });
  }

  function setCell(n, patch) {
    if (n === T.OFFICE) return;
    const prev = model.cells[n];
    const c = Object.assign({}, prev, patch);
    if (c.kind === 'inmate') {
      c.beast = T.BEASTS.includes(c.beast) ? c.beast : 'mammoth';
      c.tier = clamp(toInt(c.tier, 0), 0, TOP_TIER);
      // An event can wait beside an inmate ("Can trigger Prison Incident"):
      // it stays while the inmate is edited, and a door that opens drops its
      // event (opening it set the event off).
      c.event = 'event' in patch ? patch.event : prev && prev.kind === 'inmate' ? prev.event || null : null;
    } else {
      c.prey = null;
      c.ivory = false;
    }
    if (c.kind === 'scratch' || c.kind === 'revealed') c.tier = clamp(toInt(c.tier, 1), 0, TOP_TIER);
    if (c.kind === 'scouted') {
      c.beast = T.BEASTS.includes(c.beast) ? c.beast : 'mammoth';
      c.tier = clamp(toInt(c.tier, 0), 0, TOP_TIER);
    }
    if (c.kind === 'nest') {
      c.due = toInt(c.due, model.day + 2);
      c.event = null;
    }
    if (c.kind === 'empty') c.event = null;
    if (c.kind !== 'sealed') delete c.atLeast;
    if (c.beast !== 'lion') c.prey = null;
    model.cells[n] = c;
    cleanPrey();
    flags.delete(n);
    touch(`c${n}`);
    changed();
  }

  // The selected cell, marked Check, is already right.
  function confirmCell(n) {
    flags.delete(n);
    touch(`c${n}`);
    save();
    renderBoard();
    renderEditor();
    renderApplied();
    renderResults();
  }

  // Everything the dice filled in after "Do it here" is right.
  function confirmAll() {
    if (via) for (const key of via.filled) via.touched.add(key);
    flags = new Set();
    save();
    renderBoard();
    renderEditor();
    renderApplied();
    renderResults();
  }

  function setKind(kind) {
    const c = model.cells[selected];
    if (kind === c.kind) return;
    setCell(selected, { kind });
  }

  function toggleDoor(n) {
    if (n === model.warden) return;
    const has = model.dest.includes(n);
    model.dest = has ? model.dest.filter((x) => x !== n) : [...model.dest, n];
    if (!has && model.step !== 'patrol') model.step = 'patrol';
    touch('dest');
    changed();
  }

  function setWarden(n) {
    model.warden = n;
    changed();
  }

  // ---------- Examples and loading ----------

  function exampleModel() {
    const m = blankModel();
    const put = (n, beast, tier, extra) => {
      m.cells[n] = Object.assign({ kind: 'inmate', beast, tier, ivory: false, prey: null }, extra || {});
    };
    m.day = 6;
    m.warden = 4;
    m.step = 'patrol';
    m.dest = [5, 6, 8];
    m.milestone = false;
    put(1, 'wolf', 1);
    put(3, 'lion', 2);
    put(4, 'rat', 0);
    put(6, 'mammoth', 2);
    put(9, 'rat', 1);
    m.cells[10] = { kind: 'empty' };
    m.cells[11] = { kind: 'scratch', tier: 2, event: null };
    put(12, 'wolf', 3);
    m.cells[14] = { kind: 'nest', due: 7 };
    put(15, 'wolf', 2);
    m.cells[5] = { kind: 'sealed', event: 'unknown' };
    m.tools = ['rope'];
    return m;
  }

  function loadRun() {
    const data = store.get(SAVE_KEY);
    if (!data) {
      notice('No simulator run is saved in this browser yet. Play one first, or set up your board here.');
      return;
    }
    try {
      const st = T.deserialize(data);
      leaveShot();
      model = modelFrom(st, null);
      flags = new Set();
      applied = null;
      via = null;
      // A simulator run isn't live, so its boards are never shared.
      if (SHARE) SHARE.reset('sim');
      undo.length = 0;
      solver.st = null;
      changed();
      notice(model.ended ? 'Loaded your simulator run. It has ended, so set up a new position.' : `Loaded your simulator run: day ${model.day}.`);
    } catch (e) {
      notice(e.message);
    }
  }

  // Opens the position in the simulator, replacing its saved run.
  let openArmed = 0;
  function openInSimulator() {
    const { st, problems } = buildState(model);
    if (problems.length) {
      showProblems(problems);
      return;
    }
    const existing = store.get(SAVE_KEY);
    if (existing && Date.now() > openArmed) {
      openArmed = Date.now() + 6000;
      $('az-open-sim').textContent = 'This replaces your saved simulator run. Click again to confirm.';
      setTimeout(() => {
        $('az-open-sim').textContent = 'Play this position in the simulator';
      }, 6000);
      return;
    }
    st.log = [{ d: st.day, k: 'lab', t: 'Board analyzer: this position was set up by hand.' }];
    if (!store.set(SAVE_KEY, { app: 'tartarus-sim', v: T.VERSION, state: st })) {
      notice('This browser blocked saving, so the position could not be sent to the simulator.');
      return;
    }
    window.location.href = './';
  }

  // ---------- Reading a screenshot ----------

  const reader = { worker: null, failed: false, id: 0, pending: null, image: null, result: null, reading: null, ms: 0, picks: new Map(), pickId: 0 };
  const SHORT_TIER = ['Normal', 'Magic', 'Rare', 'Legend.', 'Supreme'];

  // A notice pinned to the window while a screenshot is read, so a paste
  // shows it's working wherever the page is scrolled. kind: busy, ok or bad.
  // A sticky one stays until it's answered.
  let toastTimer = 0;
  function toast(text, kind, actions, sticky) {
    const box = $('az-toast');
    clearTimeout(toastTimer);
    box.className = `az-toast is-${kind}`;
    $('az-toast-text').textContent = text;
    $('az-toast-actions').innerHTML = (actions || []).map((a) => `<button type="button" class="btn${a.primary ? ' btn-primary' : ''}" data-toast="${a.id}">${esc(a.label)}</button>`).join('');
    box.hidden = false;
    if (kind !== 'busy' && !sticky) toastTimer = setTimeout(() => (box.hidden = true), actions && actions.length ? 15000 : 6000);
  }

  // ---------- The game's language ----------
  // The reader learned on the English client. A board reads in any language
  // (portraits, frames, digits), but printed names are matched as English
  // words: the instrument offer's cards, the objective and start-of-run
  // cards, the Warden's Treasure screen. On another client the player is
  // told so, sets those by hand, and can send a screen the reader didn't
  // recognize in one click, so it can learn that language (the user,
  // 2026-10-17). Set here, or from the game's log (Auto Screenshot Mode).
  const GAME_LANGS = { en: 'English', ru: 'Russian', zh: 'Chinese', ja: 'Japanese' };
  const LANG_KEY = 'tartarus-sim:game-lang:v1';
  const LANG_NOTES = {
    ja: 'ゲームは日本語クライアントです。分析ツールは英語クライアントで学習しています。盤面のマス、獣、レア度はどの言語でも読み取れます。当日の扉はマス番号で読み取りますが、日本語クライアントではまだ確認できていないため、「Which door to patrol」で確認してください。置き換え・捕食のボタン、所持している刑具、彩色囚人の数、刑具の選択肢、目標、開始時のカードは英語の文字で読み取るため、手動で設定してください。認識されない画面があれば、表示される「Send this screenshot」ボタンで送ってください。日本語クライアントの読み取りを学習するのに役立ちます。',
    ru: 'Игра на русском языке. Анализатор обучен на английском клиенте: клетки, звери и редкость на поле, а также двери дня (по номерам клеток), читаются на любом языке. Кнопки замены и поглощения, ваши инструменты, счётчик хроматических заключённых, предложения инструментов, цели и карты начала забега читаются по английскому тексту. Укажите их вручную, а если экран не распознан, отправьте его кнопкой «Send this screenshot», чтобы анализатор научился читать русский клиент.',
    zh: '游戏为中文客户端。分析器是基于英文客户端训练的：棋盘上的格子、野兽和稀有度，以及当天的门（按格子编号），在任何语言下都能识别；但替换和吞噬按钮、你的刑具、彩色囚犯数量、刑具选择、本局目标和开局卡牌是按英文文字识别的。请手动设置这些内容；若某个画面未被识别，请点击“Send this screenshot”发送截图，帮助分析器学会识别中文客户端。',
  };
  let gameLang = 'en';
  try {
    gameLang = localStorage.getItem(LANG_KEY) || 'en';
  } catch (e) {
    // The default, then.
  }
  const langName = (code) => GAME_LANGS[code] || 'another language';
  // Today's doors are read by their cell numbers in any language (since
  // 20261017s), checked on real Chinese, Korean and Russian boards (c2); in
  // others a letter can pass for a digit, so the player checks them.
  const DOORS_READ = ['zh', 'ko', 'ru'];
  function langNote() {
    if (gameLang === 'en') return '';
    const doors = DOORS_READ.includes(gameLang)
      ? "the board's cells, beasts and rarities, and today's doors (by their cell numbers), read in any language"
      : "the board's cells, beasts and rarities read in any language, and today's doors are read by their cell numbers, but not yet checked on boards in your language, so check them under “Which door to patrol”";
    return `Your game is in ${langName(gameLang)}. The reader learned on the English client: ${doors}. The Replace and Consume buttons, your instruments, the Chromatic count, instrument offers, objectives and start-of-run cards are read by their English text. Set those by hand, and when a screen isn't recognized, please send it with the button that comes up, so the reader can learn your language.${LANG_NOTES[gameLang] ? `\n\n${LANG_NOTES[gameLang]}` : ''}`;
  }
  function renderLang() {
    const sel = $('az-game-lang');
    if (sel) sel.value = GAME_LANGS[gameLang] ? gameLang : 'other';
    const note = $('az-lang-note');
    if (note) {
      note.textContent = langNote();
      note.hidden = gameLang === 'en';
    }
  }
  // auto: from the game's log, which wins only when it says something new.
  function setGameLang(code, auto) {
    const c = String(code || 'en').slice(0, 2).toLowerCase() || 'en';
    if (c === gameLang) return gameLang;
    gameLang = c;
    try {
      localStorage.setItem(LANG_KEY, c);
    } catch (e) {
      // Kept for this page only.
    }
    renderLang();
    if (auto && c !== 'en') toast(langNote().split('\n')[0], 'ok');
    return gameLang;
  }
  // A screen the reader didn't recognize on a client not in English: the
  // player is told, and can send it (the report form, with the picture).
  let langMiss = null; // { what, image, detail, at }
  function langMissed(what, image, detail) {
    if (gameLang === 'en' || !image) return false;
    langMiss = { what, image, detail: String(detail || ''), at: Date.now() };
    toast(`The ${what} wasn't recognized: your game is in ${langName(gameLang)}. Set it by hand, and please send us this screenshot so the reader can learn your language.`, 'bad', [{ id: 'lang-report', label: 'Send this screenshot', primary: true }]);
    return true;
  }
  // On such a client, a board's screenshot is asked for once a session: its
  // door cards and buttons teach the reader that language's text.
  let langBoardAsked = false;
  function langBoard(image) {
    if (gameLang === 'en' || langBoardAsked || !image) return false;
    langBoardAsked = true;
    langMiss = { what: 'board', image, detail: 'a board, for its door cards and buttons', at: Date.now() };
    toast(`Your game is in ${langName(gameLang)}: ${DOORS_READ.includes(gameLang) ? '' : 'check today’s doors, and '}the Replace and Consume buttons may not be read, so set them by hand. Sending this board's screenshot once helps the reader learn your language.`, 'ok', [{ id: 'lang-report', label: 'Send this screenshot', primary: true }]);
    return true;
  }
  function sendLangMiss() {
    if (!langMiss || !window.TartarusReport) return;
    const tag = Math.random().toString(36).slice(2, 8);
    TartarusReport.open('other', { name: `${langName(gameLang)} ${langMiss.what} ${tag}`, image: langMiss.image, outcome: `Game language: ${gameLang}. Not recognized: the ${langMiss.what}${langMiss.detail ? ` (${langMiss.detail})` : ''}.` });
  }

  function scanStatus(text, bad) {
    const el = $('az-scan-status');
    el.textContent = text;
    el.classList.toggle('is-bad', !!bad);
  }

  async function readImageFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      scanStatus('That isn’t an image. Paste, drop or choose a screenshot (PNG or JPG).', true);
      toast('That isn’t an image. Copy a screenshot of the prison screen, then paste it here.', 'bad');
      return;
    }
    scanStatus('Reading your screenshot…');
    toast('Reading your screenshot to load the board…', 'busy');
    let source;
    try {
      source = await createImageBitmap(file);
    } catch (e) {
      scanStatus('This browser couldn’t open that image.', true);
      toast('This browser couldn’t open that image.', 'bad');
      return;
    }
    readBitmap(source);
  }

  // Reads a picture of the game (a pasted screenshot, or a frame from Follow
  // my game). opts.quiet skips the prompts; opts.onRead hears how it went.
  function readBitmap(source, opts) {
    // Very large screenshots are scaled down; the reader works at any size.
    const scale = Math.min(1, 2600 / source.width);
    const w = Math.round(source.width * scale);
    const h = Math.round(source.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    reader.image = canvas;
    pictureAt = Date.now();
    runScan(ctx.getImageData(0, 0, w, h), opts);
  }

  function runScan(imageData, opts) {
    const o = opts || {};
    // Follow my game's pictures come every step: their screenshot stays
    // folded away, so the board doesn't move down each time.
    reader.folded = !showShots;
    reader.follow = !!o.quiet;
    reader.id += 1;
    const id = reader.id;
    const t0 = performance.now();
    setReading(true);
    const done = (result, error) => {
      if (id === reader.id) setReading(false);
      if (id !== reader.id) {
        if (o.onRead) o.onRead({ ok: false, skipped: true, reason: 'a newer picture came in' });
        return;
      }
      reader.ms = Math.round(performance.now() - t0);
      if (error || !result) {
        reader.result = null;
        scanStatus(`The reader hit a problem: ${error || 'no result'}.`, true);
        if (!o.quiet) toast(`The reader hit a problem: ${error || 'no result'}.`, 'bad');
        renderScan();
        if (o.onRead) o.onRead({ ok: false, reason: error || 'no result', ms: reader.ms });
        return;
      }
      reader.result = result;
      reader.reading = result.ok ? scanToModel(result, model) : null;
      // The run's objective and its count, from the board's corner.
      if (result.ok && result.objective) cornerObjective(reader.image, result.objective, reader.reading.model.day);
      scanStatus(result.ok ? `Read in ${(reader.ms / 1000).toFixed(1)} s.` : `${result.reason} Try a screenshot of the prison screen, with the whole board in view.`, !result.ok);
      // controls: the board's own door cards or decision row showed, which
      // View Prison Status never does: no Warden's Treasure is open.
      // sig: the board in a line, so Auto Screenshot Mode can tell a
      // picture taken before the board changed (js/follow.js).
      const rm = result.ok ? reader.reading.model : null;
      const sig = rm ? [rm.day, rm.step, rm.warden, (rm.dest || []).join(','), (rm.cells || []).map((c) => (c ? `${c.kind || ''}${c.beast || ''}${c.tier === undefined ? '' : c.tier}` : '')).join('.')].join('|') : '';
      if (o.onRead) o.onRead(result.ok ? { ok: true, sig, day: reader.reading.model.day, unsure: reader.reading.checks.size, ms: reader.ms, controls: !!((result.doors && result.doors.cells && result.doors.cells.length) || result.decision), chain: !!result.chain, statusView: !!result.statusView } : { ok: false, reason: result.reason, ms: reader.ms });
      if (o.quiet) {
        renderScan();
        return;
      }
      if (!result.ok) {
        // Not a board: maybe the instrument pick or the Warden's Treasure.
        const image = reader.image;
        toast('No board here: checking for the instrument pick or the Warden’s Treasure…', 'busy');
        otherScreen(image).then((found) => {
          if (!found) toast(`${result.reason} Try a screenshot of the prison screen, with the whole board in view.`, 'bad');
        });
      }
      else {
        // The reading becomes the board at once, and the advice follows. If
        // the reader got something wrong, the player fixes it and rechecks.
        const unsure = reader.reading.checks.size;
        // View Prison Status (its "Return to Selection"): the board behind
        // the Treasure, even when the Treasure itself wasn't seen (report 325).
        const behindTreasure = model.treasureWait || !!result.statusView;
        useScan(true);
        if (behindTreasure) {
          useTreasure('view');
          renderScan();
          return;
        }
        if (ask()) toast(`Loaded day ${model.day} from your screenshot${unsure ? `, with ${T.plural(unsure, 'cell')} marked Check` : ''}.${unsureTools()} The advice is below. If the board doesn’t match your game, fix it and press Recheck.`, 'ok');
        else toast(`Loaded day ${model.day} from your screenshot, but the board needs fixing before the advice: see the notes under “What should I do?”.`, 'bad');
      }
      renderScan();
    };
    // The worker outlives this call, so it answers whichever reading is newest.
    reader.pending = { imageData, id, done };
    readerWorker();
    if (reader.worker) {
      const copy = imageData.data.slice().buffer;
      // lang: the game's language, for its door cards (see TartarusScan.scan).
      reader.worker.postMessage({ id, width: imageData.width, height: imageData.height, buffer: copy, lang: gameLang }, [copy]);
    } else scanHere(imageData, id, done);
  }

  // The reader's worker, started the first time it's needed. Readings of
  // the instrument pick answer through reader.picks, boards through
  // reader.pending.
  function readerWorker() {
    if (!reader.worker && !reader.failed) {
      try {
        reader.worker = new Worker(`js/scan-worker.js${SCRIPT_QUERY}`);
        reader.worker.onmessage = (e) => {
          if (e.data.kind === 'pick' || e.data.kind === 'objective') {
            const answer = reader.picks.get(e.data.id);
            reader.picks.delete(e.data.id);
            if (answer) answer(e.data.result, e.data.error);
            return;
          }
          const p = reader.pending;
          if (p && e.data.id === p.id) p.done(e.data.result, e.data.error);
        };
        reader.worker.onerror = () => {
          reader.failed = true;
          reader.worker = null;
          const p = reader.pending;
          if (p) scanHere(p.imageData, p.id, p.done);
          for (const [, answer] of reader.picks) answer(null, 'the reader stopped');
          reader.picks.clear();
        };
      } catch (e) {
        reader.failed = true;
        reader.worker = null;
      }
    }
    return reader.worker;
  }

  // Loads the reader's scripts onto the page, for when there's no worker.
  function loadReader(withPick) {
    const load = (src) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${src}${SCRIPT_QUERY}`;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return (window.TartarusScan ? Promise.resolve() : load('js/scan.js'))
      .then(() => (window.TARTARUS_SCAN ? null : load('js/scan-data.js')))
      .then(() => (!withPick || window.TARTARUS_PICK ? null : load('js/pick-data.js')));
  }

  // The instrument pick at the start of a run ("Select a Torture
  // Instrument"), from Follow my game: which three instruments are offered,
  // left to right, and whether a re-roll is left. Not a board: nothing here
  // touches the board until usePick.
  // The objective popup at the start of a run: which objective it is, from
  // its title. It becomes the board's objective, and stays for the run
  // whose instrument offer comes next.
  let runObjective = null;
  function readObjective(source) {
    const scale = Math.min(1, 2600 / source.width);
    const w = Math.round(source.width * scale);
    const h = Math.round(source.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    return new Promise((resolve) => {
      setReading(true);
      // A card the reader knows before the simulator does (a new start card)
      // is one the simulator doesn't know yet.
      const known = (result) => !!result && !!result.id && (T.OBJECTIVES[result.id] || (T.START_EVENTS || {})[result.id]);
      const done = (result, error) => (setReading(false), resolve(error || !known(result) ? { ok: false, objective: true, reason: error || 'the objective wasn’t one the simulator knows' } : { ok: true, objective: true, id: result.id, name: known(result).name }));
      reader.pickId += 1;
      const id = `objective${reader.pickId}`;
      if (readerWorker()) {
        reader.picks.set(id, done);
        const copy = imageData.data.slice().buffer;
        reader.worker.postMessage({ id, kind: 'objective', width: w, height: h, buffer: copy }, [copy]);
        return;
      }
      loadReader(false)
        .then(() => done(window.TartarusScan.readObjectiveTitle(imageData)))
        .catch((e) => done(null, (e && e.message) || 'the screenshot reader could not load'));
    });
  }

  // The run's objective, printed in the board's corner ("Objective: Prison
  // Walk", and its goal under it with the count so far, "0/4", or
  // "Completed"), read by the text reader while the run's objective isn't
  // known (the popup at its start was missed or misread: the user's Survival
  // of the Fittest run, 2026-10-17, whose "objective" picture was the
  // lobby), and once a day while its goal isn't met: the analyzer often
  // first sees a run midway, and how many consumes or doors are left weighs
  // an early consume for the instrument. One try at a time, three failures
  // in a row a day.
  const corner = { busy: false, tries: 0, day: 0, done: false };
  async function readCornerObjective(source, box) {
    const worker = await ocrWorker();
    if (!worker) return { ok: false };
    const [x0, y0, x1, y1] = box.map(Math.round);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 8 || h < 8) return { ok: false };
    // Small text reads better enlarged.
    const z = Math.max(1, Math.min(3, 600 / w));
    const c = document.createElement('canvas');
    c.width = Math.round(w * z);
    c.height = Math.round(h * z);
    c.getContext('2d').drawImage(source, x0, y0, w, h, 0, 0, c.width, c.height);
    let text = '';
    try {
      text = (await worker.recognize(c)).data.text || '';
    } catch (e) {
      return { ok: false };
    }
    const letters = (t) => t.toLowerCase().replace(/[^a-z]/g, '');
    // The title follows "Objective:" on its line, and a long one wraps onto
    // the next ("Survival of the / Fittest").
    const titled = text.split('\n').map(letters).filter(Boolean).map((l) => (l.includes('objective') ? l.slice(l.indexOf('objective') + 9) : l));
    const tries = titled.concat(titled.slice(0, -1).map((l, i) => l + titled[i + 1])).filter((l) => l.length >= 4);
    let best = null;
    for (const id of Object.keys(T.OBJECTIVES)) {
      if (id === 'other') continue;
      const n = letters(T.OBJECTIVES[id].name);
      for (const t of tries) {
        const d = editDistance(t, n) / n.length;
        if (!best || d < best.d) best = { id, d };
      }
    }
    if (!best || best.d > 0.3) return { ok: false };
    // The goal's count, "0/4" (letters can stick to it: "times0/2"), or
    // "Completed". It can't pass the goal: a digit of the goal's own text
    // can stick to it ("2 times1/2" with "times" missed reads "21/2"), so
    // then only its last digit is the count, if that fits (d8).
    const count = text.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    const need = count ? Number(count[2]) : null;
    let have = count ? Number(count[1]) : null;
    if (have !== null && have > need) have = have % 10 <= need ? have % 10 : null;
    return { ok: true, id: best.id, name: T.OBJECTIVES[best.id].name, completed: /completed/i.test(text), have, need: have === null ? null : need };
  }
  // day: the reading's, as Auto Screenshot Mode applies it only after this.
  function cornerObjective(source, box, day) {
    // Each new day, the count again; a new run (the day goes back), all.
    if (day !== corner.day) Object.assign(corner, { tries: 0, done: false });
    corner.day = day;
    const known = model.objective && model.objective !== 'other';
    const counting = known && T.OBJECTIVES[model.objective] && T.OBJECTIVES[model.objective].need && !model.milestone;
    if (corner.busy || corner.tries >= 3 || (known && (corner.done || !counting))) return;
    corner.busy = true;
    corner.tries += 1;
    readCornerObjective(source, box).then((read) => {
      corner.busy = false;
      if (!read.ok) return;
      corner.done = true;
      corner.tries = 0;
      // Advice already given for this board is given again for the board as
      // updated: else every update left it stale, "the board changed" on
      // every turn of a Prison Walk (report 351).
      const wasFresh = fresh();
      const targets = [model, reader.reading && reader.reading.model].filter(Boolean);
      const wasKnown = model.objective && model.objective !== 'other';
      // Not runObjective: that's the popup's, for the run's opening offer.
      if (!wasKnown) for (const m of targets) m.objective = read.id;
      // The count is this objective's: the higher of it and what's counted
      // already (the run is under way).
      const need = T.OBJECTIVES[read.id].need || 0;
      let counted = false;
      if (model.objective === read.id && need) {
        const have = read.completed ? need : read.need === need ? read.have : null;
        if (have !== null && have > model.walkTiles) {
          for (const m of targets) {
            m.walkTiles = Math.min(have, need);
            if (have >= need) m.milestone = true;
          }
          counted = true;
        }
      }
      if (wasKnown && !counted) return;
      changed();
      if (wasFresh) ask(true);
      const so = counted ? ` (${read.completed || read.have >= need ? 'met' : `${read.have} of ${need} so far`})` : '';
      toast(wasKnown ? `${read.name}: ${so.slice(2, -1)}, read from the board’s corner.` : `This run’s objective: ${read.name}${so}, read from the board’s corner. It’s set under Objective.`, 'ok');
    }, () => {
      corner.busy = false;
    });
  }

  // A card shown before the run (Cage Fight, Iron Law), besides its
  // objective. Iron Law makes the run 30 days long.
  let runStartEvent = null;
  function setStartEvent(id) {
    const card = T.START_EVENTS && T.START_EVENTS[id] ? T.START_EVENTS[id] : null;
    model.startEvent = card ? id : 'none';
    const left = model.maxDays - model.day;
    const days = card && card.days ? card.days : model.maxDays === 30 && id === 'none' ? T.DEFAULT_PARAMS.drillDays : model.maxDays;
    model.maxDays = days;
    model.day = clamp(days - left, 1, days);
    changed();
  }

  function useObjective(read) {
    if (read && read.ok && T.START_EVENTS && T.START_EVENTS[read.id]) {
      runStartEvent = read.id;
      setStartEvent(read.id);
      toast(`This run’s card: ${T.START_EVENTS[read.id].name}. It’s set under Start of run.`, 'ok');
      return true;
    }
    if (!read || !read.ok || !T.OBJECTIVES[read.id]) return false;
    runObjective = read.id;
    model.objective = read.id;
    model.walkTiles = 0;
    model.milestone = false;
    changed();
    toast(`This run’s objective: ${read.name}. It’s set under Objective.`, 'ok');
    return true;
  }

  // Reading printed text: Tesseract, loaded the first time it's needed (a
  // pinned version from jsDelivr, cached by the browser). It runs in this
  // browser; the picture isn't sent anywhere. Without it, the cards are
  // read by their art alone.
  // A load that fails is tried again with the next picture (a network
  // hiccup mustn't turn the names off until the page reloads); one that
  // hangs gives up after 20 s for this picture, so the art reading goes
  // ahead, and keeps loading for the next. ocrError: why the last try
  // didn't give a reader, for the reading (report 111).
  let ocr = null;
  let ocrError = '';
  function ocrWorker() {
    if (!ocr) {
      ocr = new Promise((resolve, reject) => {
        if (window.Tesseract) return resolve();
        const sc = document.createElement('script');
        sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
        sc.onload = resolve;
        sc.onerror = () => reject(new Error('its script didn’t download'));
        document.head.appendChild(sc);
      })
        .then(() => window.Tesseract.createWorker('eng'))
        .then((w) => {
          ocrError = '';
          return w;
        }, (e) => {
          ocrError = String((e && e.message) || e || 'it didn’t load');
          ocr = null;
          return null;
        });
    }
    const limit = new Promise((resolve) => setTimeout(() => {
      if (!ocrError) ocrError = 'it took over 20 s to load';
      resolve(null);
    }, 20000));
    return Promise.race([ocr, limit]);
  }

  function editDistance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row;
    }
    return prev[b.length];
  }

  // The instrument a card's text names: the known name it's closest to,
  // when that's clearly closer than any other. null when it isn't.
  function nameFromText(text) {
    const letters = (t) => t.toLowerCase().replace(/[^a-z]/g, '');
    // The whole text, each line, and each two lines together: a long name
    // ("Iron Tongs of Lust: Mammoth") can wrap onto a second line.
    const lines = text.split('\n');
    const pairs = lines.slice(1).map((l, i) => `${lines[i]} ${l}`);
    const tries = [text, ...lines, ...pairs].map(letters).filter((t) => t.length >= 3);
    const scores = T.TOOL_IDS.map((id) => {
      // The full name, and the part before a colon ("Iron Tongs of Lust").
      const forms = [...new Set([T.toolName(id), T.toolName(id).split(':')[0]].map(letters))];
      return { id, score: Math.min(...forms.flatMap((n) => tries.map((t) => editDistance(t, n) / n.length)), 9) };
    }).sort((a, b) => a.score - b.score);
    const [best, next] = scores;
    return best && best.score <= 0.3 && (!next || next.score - best.score >= 0.15) ? best : null;
  }

  // The three cards' names, left to right, from the band under each card's
  // art (a raised card's title sits a little higher, inside the band). ui:
  // the cards' size the reader found (see scanPick).
  async function readCardNames(canvas, ui) {
    const worker = await ocrWorker();
    if (!worker) {
      // No names read: why, for the reading.
      const none = [null, null, null];
      none.failed = ocrError || 'it didn’t load';
      return none;
    }
    const s = ui || canvas.height / 1080;
    const top = canvas.height / 2 - 540 * s;
    const out = [];
    for (let k = -1; k <= 1; k++) {
      const c = canvas.width / 2 + k * 480 * s;
      // Small cards' names enlarged to their size on a 1080-pixel-high
      // screen: the text reader misses the small ones.
      const z = Math.max(1, 1 / s);
      const crop = document.createElement('canvas');
      crop.width = Math.round(430 * s * z);
      crop.height = Math.round(130 * s * z);
      crop.getContext('2d').drawImage(canvas, Math.round(c - 215 * s), Math.round(top + 420 * s), Math.round(430 * s), Math.round(130 * s), 0, 0, crop.width, crop.height);
      try {
        // Handed over already made into a PNG: given the canvas, the text
        // reader waits on canvas.toBlob, which a hidden page (the desktop
        // app's analyzer) can put off for most of a second.
        const { data } = await worker.recognize(crop.toDataURL('image/png'));
        out.push(nameFromText(data.text || ''));
      } catch (e) {
        out.push(null);
      }
    }
    return out;
  }

  // The Warden's Treasure screen, from its printed text: its header
  // ("Warden's Treasure obtained"), or two or more of the four gifts'
  // names. Follow my game knows this screen from the game's log; this is
  // for pasted pictures and Take a picture now.
  async function readTreasure(source) {
    const worker = await ocrWorker();
    if (!worker) return { ok: false, treasure: true, reason: `the text reader couldn’t load (${ocrError || 'it didn’t load'})` };
    const scale = Math.min(1, 1600 / source.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    let text = '';
    try {
      text = (await worker.recognize(canvas)).data.text || '';
    } catch (e) {
      return { ok: false, treasure: true, reason: 'the text couldn’t be read' };
    }
    const letters = (t) => t.toLowerCase().replace(/[^a-z]/g, '');
    const lines = text.split('\n').map(letters).filter((l) => l.length >= 4);
    const header = lines.some((l) => l.includes('treasureobtained') || l.includes('wardenstreasure'));
    const gifts = T.GIFT_IDS.filter((id) => {
      const n = letters(T.GIFTS[id].name);
      return lines.some((l) => l.includes(n) || editDistance(l, n) / n.length <= 0.3);
    });
    return { ok: header || gifts.length >= 2, treasure: true, header, gifts };
  }

  // A pasted picture with no board in it: the instrument pick, or the
  // Warden's Treasure. A pick is a fresh run's when the board before was
  // a run's last day (or there's none); otherwise an objective's reward.
  async function otherScreen(source) {
    const pick = await readPick(source);
    const second = pick.ok ? pick.cards.map((c) => c.conf).sort((a, b) => b - a)[1] : 0;
    if (pick.ok && (pick.byName >= 2 || second >= 0.5)) {
      const fresh = model.day >= model.maxDays || (!model.tools.length && model.day <= 1);
      usePick(pick, fresh);
      return true;
    }
    const tr = await readTreasure(source);
    if (tr.ok) {
      useTreasure();
      return true;
    }
    langMissed('screen', source, pick.ok ? 'instrument cards not read' : pick.reason);
    return false;
  }

  function readPick(source) {
    const scale = Math.min(1, 2600 / source.width);
    const w = Math.round(source.width * scale);
    const h = Math.round(source.height * scale);
    // Its size, for the highlight of the card to take.
    lastPick = { w, h, at: Date.now() };
    pictureAt = lastPick.at;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const t0 = performance.now();
    setReading(true);
    return new Promise((resolve) => {
      const done = (result, error) => {
        setReading(false);
        const ms = Math.round(performance.now() - t0);
        if (error || !result) return resolve({ ok: false, pick: true, reason: error || 'no result', ms });
        if (!result.ok) return resolve({ ok: false, pick: true, reason: result.reason, ms });
        const cards = result.cards.map((c) => ({ sim: c.sim, name: T.toolName(c.sim), conf: c.conf, alts: c.alts, by: 'art' }));
        // Each card's printed name, read where it can be, outranks its art.
        readCardNames(canvas, result.ui).then((names) => {
          names.forEach((n, i) => {
            if (n && cards[i]) Object.assign(cards[i], { sim: n.id, name: T.toolName(n.id), conf: 1, by: 'name' });
          });
          resolve({ ok: true, pick: true, cards, names: cards.map((c) => c.name), unsure: cards.filter((c) => c.conf < 0.5).length, reroll: !!result.reroll, byName: cards.filter((c) => c.by === 'name').length, ocrFailed: names.failed || '', ms: Math.round(performance.now() - t0) });
        });
      };
      reader.pickId += 1;
      const id = `pick${reader.pickId}`;
      if (readerWorker()) {
        reader.picks.set(id, done);
        const copy = imageData.data.slice().buffer;
        reader.worker.postMessage({ id, kind: 'pick', width: w, height: h, buffer: copy }, [copy]);
        return;
      }
      loadReader(true)
        .then(() => done(window.TartarusScan.scanPick(imageData, window.TARTARUS_SCAN, window.TARTARUS_PICK)))
        .catch((e) => done(null, (e && e.message) || 'the screenshot reader could not load'));
    });
  }

  // An instrument offer. A fresh run's (fresh, the default): the board
  // behind the offer isn't known yet, so it starts blank, with the
  // player's settings kept. One mid-run (an objective's reward): on the
  // board as it is. Either way the offer is set as the step, and the advice
  // says which to take, or to re-roll. Cards the reader wasn't sure of are
  // named for checking.
  function usePick(read, fresh) {
    if (!read || !read.ok) return false;
    const start = fresh !== false;
    reader.undoable = true;
    undo.push({ model: JSON.parse(JSON.stringify(model)), selected, shot });
    if (undo.length > 30) undo.shift();
    if (start) {
      // runStart: this blank board is a run's opening offer, never shared,
      // even on a Recheck after fixing a card.
      // The run's objective: its popup came just before, or this is a
      // re-roll of the run's opening offer, which keeps what was set.
      const again = model.runStart && model.step === 'choice';
      // A new run lasts as its start card says (Iron Law: 30 days), else 20:
      // the last run's length doesn't carry over.
      const startEvent = runStartEvent || (again ? model.startEvent : 'none');
      const card = T.START_EVENTS && T.START_EVENTS[startEvent];
      const maxDays = again ? model.maxDays : (card && card.days) || T.DEFAULT_PARAMS.drillDays;
      const keep = { mode: model.mode, rewards: model.rewards, maxDays, runStart: true, objective: runObjective || (again ? model.objective : 'other'), walkTiles: again ? model.walkTiles : 0, startEvent };
      runObjective = null;
      runStartEvent = null;
      model = normalize(Object.assign(blankModel(), keep));
      shot = false;
      flags = new Set();
      via = null;
      selected = model.warden;
    }
    if (start) gifts.waiting = 0;
    model.step = 'choice';
    model.choice = { kind: 'tool', options: read.cards.map((c) => c.sim), rerolls: read.reroll ? 1 : 0 };
    applied = null;
    solver.st = null;
    reader.folded = true;
    renderScan();
    scanStatus('');
    changed();
    const unsure = read.cards.filter((c) => c.conf < 0.5);
    const check = unsure.length ? ` Check ${unsure.map((c) => `the ${['left', 'middle', 'right'][read.cards.indexOf(c)]} one (read as ${c.name})`).join(' and ')}: if it's wrong, change it under “A tool or gift” and press Recheck.` : '';
    // No card's name could be read (the text reader didn't load): the art
    // alone can name an instrument that wasn't offered (report 111 advised
    // taking Kin's Coin), so the offer is checked before any advice.
    if (read.ocrFailed && !read.byName) {
      toast(`The instrument offer read as ${read.names.join(', ')} from the cards' pictures alone: their names couldn't be read (the text reader: ${read.ocrFailed}). Check the three under “A tool or gift”, then press Recheck for the advice.`, 'bad');
      return false;
    }
    const asked = ask(true, start);
    toast(`${start ? 'A fresh run: the instrument offer is' : 'An instrument offer:'} ${read.names.join(', ')}${read.reroll ? ', with a re-roll left' : ''}. ${asked ? 'Which to take is below.' : 'It needs fixing before the advice.'}${check}`, unsure.length ? 'bad' : 'ok');
    return asked;
  }

  // The Warden's Treasure's picks: one a Treasure, or 3 with Opulence ("2
  // additional choices"). Auto Screenshot Mode counts, from the game log,
  // each Rainbow (each opens a Treasure) and each pick confirmed
  // (js/follow.js); the picks waiting are each new Rainbow's picks less each
  // one confirmed. The first counts this page hears only start the tally.
  const picksPer = () => ((T.START_EVENTS || {})[model.startEvent] || {}).picks || 1;
  const gifts = { log: null, waiting: 0, board: null };
  function giftCounts(c) {
    if (!c || !Number.isFinite(c.rainbows) || !Number.isFinite(c.taken)) return null;
    const was = gifts.log;
    if (was && c.rainbows >= was.rainbows && c.taken >= was.taken) gifts.waiting = Math.max(0, gifts.waiting + (c.rainbows - was.rainbows) * picksPer() - (c.taken - was.taken));
    gifts.log = { rainbows: c.rainbows, taken: c.taken };
    return gifts.waiting;
  }
  // A pick confirmed, or a Rainbow, since the board behind the Treasure was
  // last seen: the board changed, so it's seen again before the next advice.
  const pickedSinceBoard = () => !!gifts.log && (!gifts.board || gifts.log.taken > gifts.board.taken || gifts.log.rainbows > gifts.board.rainbows);
  // The picks waiting now, this one included: the log's tally, or for
  // screenshots, what was set (a new Treasure starts at the card's picks).
  function picksNow() {
    // A Treasure the tally missed the Rainbow of (this page opened during
    // it): the card's picks, as a guess for this screen only.
    if (gifts.log) return gifts.waiting > 0 ? gifts.waiting : picksPer();
    return model.step === 'choice' && model.choice.kind === 'gift' ? model.choice.picks || 1 : picksPer();
  }

  // The Warden's Treasure, opened by a Chromatic prisoner (Follow my game
  // knows it from the log): the gift to take, on the last board known.
  // Nothing is read from the picture: every gift is on offer. after is
  // what led to it, from the log: right after a swap, the newcomer was a
  // Rainbow, so it's in the vault and its cell locked again; after a
  // consume, today's consume is used.
  function useTreasure(after) {
    const gift = () => {
      const picks = picksNow();
      model.step = 'choice';
      model.choice = { kind: 'gift', options: [], rerolls: 0, picks };
      applied = null;
      solver.st = null;
    };
    // The board behind the Treasure has just been read (View Prison
    // Status): the gift advice uses it.
    if (after === 'view') {
      gift();
      model.treasureWait = false;
      model.treasureSeen = true;
      gifts.board = gifts.log ? Object.assign({}, gifts.log) : null;
      changed();
      renderScan();
      const asked = ask(true);
      toast(`Board seen behind the Warden’s Treasure. ${asked ? 'Which gift to take is below.' : 'The board needs fixing before the advice.'}`, asked ? 'ok' : 'bad');
      return asked;
    }
    // Back at the Treasure after viewing the board: nothing more to wait for,
    // unless a pick was confirmed since (Opulence's next pick).
    if (model.step === 'choice' && model.choice.kind === 'gift' && model.treasureSeen && !pickedSinceBoard()) {
      const picks = picksNow();
      if (picks === model.choice.picks) return fresh() && settled() ? true : ask(true);
      // A pick's Rainbow brought more picks: the advice weighs them.
      model.choice = Object.assign({}, model.choice, { picks });
      changed();
      return ask(true);
    }
    undo.push({ model: JSON.parse(JSON.stringify(model)), selected, shot });
    if (undo.length > 30) undo.shift();
    reader.undoable = true;
    let how = '';
    const w = model.cells[model.warden];
    if (after === 'swap' && w && w.kind === 'inmate') {
      model.cells[model.warden] = T.DEFAULT_PARAMS.reusableCells ? sealedCell() : { kind: 'empty' };
      model.vault = [...model.vault, w.beast];
      model.swapUsed = true;
      model.consumeOffered = true;
      how = ` It came from your Replace in cell ${L(model.warden)}: the newcomer was a Rainbow, now in the vault, and the cell locked again.`;
    } else if (after === 'consume') {
      model.devourUsed = true;
      how = ' It came from your consume: the next picture shows the board after it.';
    }
    // The Treasure covers the board, which may have changed (a chain, a
    // Rainbow): no gift is advised until the board behind it is seen.
    gift();
    model.treasureWait = true;
    model.treasureSeen = false;
    changed();
    renderScan();
    toast(`The Warden’s Treasure is open.${how} To advise a gift on the board as it is now, press View Prison Status in the game, wait a second on the board, then return to the Treasure.`, 'ok');
    return false;
  }

  // Without workers (a page opened from disk), reads on the page itself,
  // loading the reader the first time.
  function scanHere(imageData, id, done) {
    const ready = loadReader(true);
    ready
      .then(() => {
        setTimeout(() => {
          try {
            const result = window.TartarusScan.scan(imageData, window.TartarusScan.withPanelIcons(window.TARTARUS_SCAN, window.TARTARUS_PICK), { lang: gameLang });
            if (result.tools && result.tools.tools) for (const t of result.tools.tools) Object.assign(t, window.TARTARUS_SCAN.toolNames[t.id] || {});
            done(result);
          } catch (e) {
            done(null, e.message);
          }
        }, 30);
      })
      .catch(() => done(null, 'the screenshot reader could not load'));
  }

  // The reader doesn't see Tusk marks yet. A mark stays on its inmate until
  // it's used or the inmate goes, so a mark the board before knew (set by
  // hand, or kept from an earlier picture of the run) stays while the same
  // beast is still in the cell, at the same rarity or higher.
  function keptTusk(base, n, beast, tier) {
    const was = base && base.cells && base.cells[n];
    return !!(was && was.kind === 'inmate' && was.ivory && was.beast === beast && tier >= was.tier);
  }

  // The board the reading describes, built on the current settings (goal,
  // food chain, run length), plus the cells to check.
  // A devour's meal pick ("Select an Inmate to Consume"). The game darkens
  // all but the eater and its meals there, so rarities can't be read: the
  // board is the turn before (the one loaded here), with what this picture
  // does show. The eater in the warden's cell as it is now, the cells eaten
  // so far (they lock again), and the meals on offer, which share the
  // eater's rarity. With nothing eaten yet and the eater unchanged, it's the
  // day's devour being aimed, not a chain.
  function chainToModel(r, base) {
    const m = JSON.parse(JSON.stringify(base));
    const checks = new Set();
    const notes = [];
    const warden = r.warden ? r.warden.cell : base.warden;
    // The turn before: the same warden after the patrol, or the patrol that
    // brought the warden here.
    const after = base.warden === warden && (base.step === 'manage' || base.step === 'chain');
    const walked = base.step === 'patrol' && (base.dest || []).includes(warden);
    if (!after && !walked) {
      // Nothing to build on: the board as read, its darkened rarities marked.
      r.cells.forEach((c, n) => {
        if (n === T.OFFICE || n === warden) return;
        if (c.kind === 'locked') m.cells[n] = { kind: 'sealed', event: null };
        else if (c.kind === 'inmate') m.cells[n] = { kind: 'inmate', beast: c.beast, tier: clamp(c.tier, 0, TOP_TIER), ivory: keptTusk(base, n, c.beast, clamp(c.tier, 0, TOP_TIER)), prey: null };
        else m.cells[n] = { kind: 'empty' };
        if (c.kind !== 'locked') checks.add(n);
      });
      notes.push('A consume’s meal pick darkens the board, so its rarities were guessed: check the marked cells, or load the board from before the consume first.');
    }
    m.warden = warden;
    const was = base.cells[warden];
    const eater = r.cells[warden];
    // Cells the chain has eaten show a padlock again. The meal pick darkens
    // padlocks enough to read as an empty cell (reports 314 and 322), which
    // the live board never has, so a cell that held an inmate and now reads
    // empty was eaten too. Missing it took the chain for the day's first
    // consume, and the advice said Replace.
    let eaten = 0;
    if (after || walked) {
      r.cells.forEach((c, n) => {
        if (n === T.OFFICE || n === warden || (c.kind !== 'locked' && c.kind !== 'empty') || m.cells[n].kind !== 'inmate') return;
        m.cells[n] = { kind: 'sealed', event: null };
        eaten += 1;
      });
    }
    // Nothing eaten yet and the same beast in the warden's cell: the day's
    // first meal pick, where the eater can't have changed. The meal screen's
    // red light makes the reader's rarities unreliable there (report 337: an
    // eater read as Supreme, and the advice turned from its consume to End),
    // so the board before's eater and meals stand. A chain's eater rose and
    // re-rolled its beast, so there the reading stands.
    const sameBeast = !!was && was.kind === 'inmate' && !!eater && eater.kind === 'inmate' && was.beast === eater.beast;
    const first = eaten === 0 && (walked || sameBeast);
    if (first && was && was.kind === 'inmate') m.cells[warden] = JSON.parse(JSON.stringify(was));
    else if (eater && eater.kind === 'inmate') m.cells[warden] = { kind: 'inmate', beast: eater.beast, tier: clamp(eater.tier, 0, TOP_TIER), ivory: !!(was && was.ivory), prey: was && was.kind === 'inmate' ? was.prey : null };
    else {
      checks.add(warden);
      notes.push('The eater in the warden’s cell wasn’t read: set it as it is now.');
    }
    const tier = m.cells[warden].kind === 'inmate' ? m.cells[warden].tier : 0;
    // The meals on offer: the board before keeps its inmate when it fits;
    // otherwise the beast read here, at the eater's rarity. A scratched door
    // stays a door.
    for (const n of r.chain.targets) {
      const c = m.cells[n];
      if (c.kind === 'scratch') continue;
      if (c.kind === 'inmate' && c.tier <= tier && (!r.cells[n].beast || c.beast === r.cells[n].beast)) continue;
      m.cells[n] = { kind: 'inmate', beast: r.cells[n].beast || (c.kind === 'inmate' ? c.beast : 'mammoth'), tier, ivory: c.kind === 'inmate' ? !!c.ivory : false, prey: null };
      checks.add(n);
    }
    m.step = first ? 'manage' : 'chain';
    m.devourUsed = m.step === 'chain';
    // The meal pick shows the meals and Cancel, never Replace. A chain taken
    // for the day's first consume (report 323: the board before didn't hold
    // the meal already eaten) has no Replace after Cancel either, so the
    // advice weighs the meals against not consuming. No Hunt either (report
    // 128: after a Cancel, the Prey mark advised couldn't be made).
    if (m.step === 'manage') {
      m.swapUsed = false;
      m.noSwap = true;
      m.noHunt = true;
    }
    m.dest = [];
    m.chainArmed = false;
    // Only the meals the game framed can be eaten now (report 385: the
    // board before held a meal the game didn't offer, and it was advised).
    m.mealOnly = r.chain.targets.slice();
    const tools = (m.tools || []).map((id) => ({ id, sim: id, name: T.toolName(id), conf: 1 }));
    return { model: m, checks, notes, chromatic: (m.vault || []).length, tools, unsim: [], chain: r.chain.targets };
  }

  // A run's instruments, from what's known of the run and what a screenshot
  // shows. Instruments are only ever added, from an offer, so once the run
  // is known (instruments held, or an offer seen), only an offer the
  // analyzer saw can add one: the instrument read on it, or failing that,
  // the one the analyzer advised. Icons alone never add one, as two can look
  // alike (a tooltip can cover them, too). Without anything known of the
  // run, only icons the reader is sure of count. A screenshot from an
  // earlier day than the board before starts afresh.
  // sims: the instruments the reader can tell on a panel (any other reads
  // as something else).
  // A board from a new run: its day is earlier than the board before's, and
  // it looks like a run's start, not a misread day (the user's run: one
  // picture of day 15 read as day 19, so the next, day 15 again, cleared the
  // run's confirmed instruments and asked for them again). Early in a run
  // (day 1 or 2), or far fewer inmates out than before: a run starts with
  // about 4.
  function newRun(m, base) {
    if (!(m.day < base.day)) return false;
    if (m.day <= 2) return true;
    const out = (x) => (x.cells || []).filter((c) => c && c.kind === 'inmate').length;
    return out(m) <= Math.max(5, out(base) - 4);
  }

  function runTools(read, base, m, notes, sims) {
    const sameRun = !newRun(m, base);
    const known = sameRun ? (base.tools || []).filter((id) => T.TOOLS[id]) : [];
    const offer = sameRun && base.step === 'choice' && base.choice && base.choice.kind === 'tool' ? base.choice.options.filter((id) => T.TOOLS[id]) : [];
    const out = known.map((id) => ({ id, sim: id, name: T.toolName(id), conf: 1, kept: true }));
    const has = (id) => out.some((t) => t.sim === id);
    const slots = read.length;
    // A set run: once the run's instruments are known (the offers the
    // analyzer saw and advised, or the player's confirmation), they're
    // presumed and locked (m.toolsLocked), and icons never change them. The
    // user: "once the instruments have been recommended and selected, it
    // should presume those are the instruments and not say anything unless
    // it sees more total instruments than it already had". So the only
    // question is a panel showing more than the run has and than the count
    // last confirmed (m.toolsSeen).
    m.toolsToConfirm = '';
    m.toolsPanel = slots;
    if (!sameRun) {
      m.toolsLocked = false;
      m.toolsSeen = 0;
    }
    if (sameRun && (known.length || offer.length || base.runStart || base.toolsLocked)) {
      if (offer.length && slots > known.length && !offer.some(has)) {
        const seen = read.filter((t) => offer.includes(t.sim)).sort((a, b) => b.conf - a.conf)[0];
        // An icon read as an instrument that wasn't offered can still be one
        // that was: the closest offered one among its runner-ups (report 75:
        // the Forged Key read as the Lost Ring of Keys).
        let alike = null;
        if (!seen) {
          for (const t of read) {
            if (has(t.sim)) continue;
            const a = (t.alts || []).find((x) => x.sim && offer.includes(x.sim) && x.score >= 0.7);
            if (a && (!alike || a.score > alike.score)) alike = { sim: a.sim, score: a.score, as: t.sim };
          }
        }
        // The advice given on that offer: the board before is the offer, so
        // the analyzer's current recommendation is for it.
        const rec = base === model && fresh() ? recommendation() : null;
        const advised = rec && rec.action && rec.action.type === 'choose' && offer.includes(rec.action.id) ? rec.action.id : null;
        const take = seen ? seen.sim : alike ? alike.sim : advised;
        if (take) {
          out.push({ id: take, sim: take, name: T.toolName(take), conf: 1, kept: true });
          if (!seen && alike) notes.push(`An icon read as ${alike.as ? T.toolName(alike.as) : 'another instrument'}, which wasn't offered: taken as ${T.toolName(take)}, the closest of the offer. If you took another, change it under Torture Instrument.`);
          else if (!seen) notes.push(`Took it you chose ${T.toolName(take)}, as advised. If you took another, change it under Torture Instrument.`);
        } else notes.push(`Your instruments show one more than before, from the offer of ${offer.map((id) => T.toolName(id)).join(', ')}: set which you took under Torture Instrument.`);
      }
      if (out.length) m.toolsLocked = true;
      if (slots > Math.max(out.length, base.toolsSeen || 0)) m.toolsToConfirm = `Your panel shows ${T.plural(slots, 'instrument')}, and the analyzer has ${out.length}: ${out.map((t) => t.name).join(', ') || 'none'}. Set the ones you hold, then press These are right.`;
      return out;
    }
    // Nothing known of the run yet: only icons the reader is sure of, and
    // the player is asked to confirm.
    for (const t of read) if (t.sim && !has(t.sim) && t.conf >= TOOL_SURE) out.push(t);
    if (read.length) m.toolsToConfirm = `The analyzer doesn’t know this run’s instruments yet. It read ${out.length ? out.map((t) => T.toolName(t.sim)).join(', ') : 'none for sure'} from your panel of ${read.length}. Set the ones you hold, then press These are right.`;
    return out;
  }

  function scanToModel(r, base) {
    if (r.chain) return chainToModel(r, base);
    const m = JSON.parse(JSON.stringify(base));
    const checks = new Set();
    const notes = [];
    // Days until the riot set how much of the run is left.
    if (r.days) {
      const left = r.days.days;
      if (left < m.maxDays) m.day = Math.max(1, m.maxDays - left);
      else if (left < 30) {
        // More days left than the run has: only Iron Law's 30-day run has
        // that many.
        m.maxDays = 30;
        m.day = 30 - left;
        notes.push(`The riot is ${T.plural(left, 'day')} away, more than this run had, so it's now a 30-day run (Iron Law). Check the day.`);
      } else {
        // No run is that long: a misread countdown. It mustn't stretch the
        // run for good (one read as 38 made every later day "of 39").
        notes.push(`The days until the riot read as ${left}, more than any run has: check the day.`);
      }
    } else notes.push('The days until the riot weren’t read: check the day.');
    r.cells.forEach((c, n) => {
      if (n === T.OFFICE) return;
      if (c.kind === 'locked') {
        if (c.nest) {
          m.cells[n] = { kind: 'nest', due: m.day + 2 };
          checks.add(n);
        } else {
          // A door whose rarity shows, as read: a "?" portrait, scratched by
          // the Filthy Claws or not (report 243). A scratch stays while the
          // door is locked, even if its slashes weren't read.
          // What the player knew of a door that's still locked stays too: a
          // rarity shown (Crow Whispers, or the "Treasure" Hunt's "?"
          // portrait) and the Hunt's Rare or better.
          const was = base.cells[n];
          const event = c.event ? 'unknown' : null;
          if (c.shown) {
            m.cells[n] = { kind: c.shown.scratch || (was && was.kind === 'scratch') ? 'scratch' : 'revealed', tier: clamp(c.shown.tier, 0, TOP_TIER), event };
            if (c.shown.conf < 0.6) checks.add(n);
          } else if (was && (was.kind === 'revealed' || was.kind === 'scratch')) m.cells[n] = { kind: was.kind, tier: was.tier, event };
          else if (was && was.kind === 'sealed' && was.atLeast) m.cells[n] = { kind: 'sealed', event, atLeast: was.atLeast };
          else m.cells[n] = { kind: 'sealed', event };
        }
        if (c.conf < 0.6) checks.add(n);
      } else if (c.kind === 'inmate') {
        // The gold crosshair under a portrait: someone's Prey mark (report 352).
        m.cells[n] = { kind: 'inmate', beast: c.beast, tier: clamp(c.tier, 0, TOP_TIER), ivory: keptTusk(base, n, c.beast, clamp(c.tier, 0, TOP_TIER)), prey: null, marked: !!c.prey, event: c.event ? 'unknown' : null };
        if (c.conf < 0.6 || c.ghost) checks.add(n);
      } else {
        m.cells[n] = { kind: 'empty' };
        checks.add(n);
      }
    });
    // Most cells read as open and empty, which a board rarely is: it was
    // likely placed wrong (a screen shape the reader handled badly, report
    // 144), so the reading is checked before it's trusted.
    const emptyRead = r.cells.filter((c) => c.n !== T.OFFICE && c.kind !== 'locked' && c.kind !== 'inmate').length;
    if (emptyRead >= 8) notes.push(`${emptyRead} cells read as open and empty, which is unusual: the board may be misread. Check it against your game.`);
    if (r.warden) {
      m.warden = r.warden.cell;
      if (r.warden.conf < 0.6) checks.add(r.warden.cell);
    } else notes.push('The warden’s arrow wasn’t found: set the warden.');
    if (r.doors && r.doors.cells.length) {
      m.step = 'patrol';
      m.dest = r.doors.cells.filter((n) => n !== m.warden);
      // The mouse pointer over a card's number hides its digit (report 318),
      // unless the lit cells settled it (report 360). Unsettled, that door is
      // marked Check: a guess, not a reading.
      if (r.doors.hidden && r.doors.hidden.length && r.doors.lit) notes.push(`The mouse pointer covers the number on one card: the lit cells show it is cell ${L(r.doors.hidden[0])}.`);
      else if (r.doors.hidden && r.doors.hidden.length) {
        notes.push(`The mouse pointer covers the number on the card read as ${r.doors.hidden.map((n) => `cell ${L(n)}`).join(' and ')}: check that door.`);
        r.doors.hidden.forEach((n) => checks.add(n));
      }
      else if (r.doors.conf < 0.6) notes.push('Today’s doors were hard to read: check them.');
    } else if (!r.decision && !r.statusView && base.step === 'patrol' && (base.dest || []).length && m.day === base.day && m.warden === base.warden) {
      // No door cards and no buttons, on the same day with the warden where
      // it was: the cards haven't come back yet (report 334: pictured just
      // after a Warden's Treasure closed), so the doors stay as they were.
      m.step = 'patrol';
      m.dest = base.dest.slice();
      notes.push('No door cards or buttons showed (they may not have come back yet): today’s doors are kept from the board before.');
    } else {
      m.step = 'manage';
      m.dest = [];
      m.devourUsed = false;
      m.swapUsed = false;
    }
    m.chainArmed = false;
    // The cards under “Make Your Decision” are what the game allows now: a
    // swap only with a Replace card, a consume only with a Consume card. A
    // Consume card with no Replace card is a consume on offer, even after
    // today's swap.
    m.consumeOffered = false;
    m.treasureWait = false;
    m.treasureSeen = false;
    m.noSwap = false;
    m.noDevour = false;
    m.noHunt = false;
    m.huntOnly = null;
    m.officeOnly = null;
    m.mealOnly = null;
    // Without the cards (a picture taken as they come up), a board of the
    // same day with the warden in the same cell keeps what the board
    // before knew. And if the warden's inmate has changed since, today's
    // swap is done: it isn't advised again, while a consume still can be.
    const sameVisit = m.day === base.day && m.warden === base.warden && ['manage', 'choice', 'event'].includes(base.step);
    if (!r.decision && sameVisit && m.step === 'manage') {
      m.swapUsed = !!base.swapUsed;
      m.devourUsed = !!base.devourUsed;
      m.noSwap = !!base.noSwap;
      m.noDevour = !!base.noDevour;
      m.noHunt = !!base.noHunt;
      m.consumeOffered = !!base.consumeOffered;
      const was = base.cells[m.warden];
      const now = m.cells[m.warden];
      if (!m.devourUsed && was && now && was.kind === 'inmate' && now.kind === 'inmate' && (was.beast !== now.beast || was.tier !== now.tier)) {
        m.swapUsed = true;
        m.consumeOffered = true;
        notes.push('The warden’s inmate changed since the board before, so today’s Replace is taken as done.');
        m.cells[m.warden].ivory = false; // a Tusk mark is used by the Replace
      }
    }
    // “Select an Objective” with the warden on a Lion and the Blood-Stained
    // Trap held: the Hunt's pick of its prey when only some cells are framed
    // (report 352: the Lion's 3 meals), not the Sewer Ratway's, which frames
    // all 15. Without the frames read, it's the Hunt's when it comes right
    // after this visit's cards (the Ratway's follows its event card).
    const here = m.cells[m.warden];
    const trap = (m.tools || []).includes('trap') || ((r.tools && r.tools.tools) || []).some((t) => t.sim === 'trap');
    const framed = r.decision && r.decision.ratway && Array.isArray(r.decision.framed) && r.decision.framed.length ? r.decision.framed : null;
    const lionHere = !!here && here.kind === 'inmate' && here.beast === 'lion';
    const huntPick = !!(r.decision && r.decision.ratway) && trap && lionHere && (framed ? framed.length < 14 : base.step === 'manage' && m.day === base.day && m.warden === base.warden);
    if (r.decision && r.decision.office) {
      // The office's Instigate and Bestow cards. The game can show just one
      // (report 383: Bestow alone), when the reader tells them apart.
      m.step = 'office';
      m.dest = [];
      const ins = r.decision.instigate;
      const bes = r.decision.bestow;
      if (ins === false && bes) m.officeOnly = 'bestow';
      else if (bes === false && ins) m.officeOnly = 'instigate';
    } else if (huntPick) {
      // Only the Hunt is open now, on the framed cells.
      m.step = 'manage';
      m.dest = [];
      m.swapUsed = false;
      m.devourUsed = false;
      m.noSwap = true;
      m.noDevour = true;
      if (framed) m.huntOnly = framed.slice();
    } else if (r.decision && r.decision.ratway) {
      // The Sewer Ratway's cell pick: a move to any cell but the office.
      m.step = 'ratway';
      m.dest = [];
    } else if (r.decision) {
      // A missing card means that move isn't on offer now, not that it was
      // used: a used consume would rule out today's swap too.
      m.swapUsed = false;
      m.devourUsed = false;
      m.noSwap = !r.decision.replace;
      m.noDevour = !r.decision.consume;
      // A Hunt marks an inmate the Lion could consume, so it's offered only
      // beside a Consume card (reports 353-355: a Hunt advised with only End
      // showing). A reader that tells the Hunt card says so itself. And one
      // gone stays gone for the visit (report 128: none after a meal pick's
      // Cancel).
      m.noHunt = ('hunt' in r.decision ? !r.decision.hunt : !r.decision.consume) || (sameVisit && !!base.noHunt);
      // A Consume card after today's swap is a consume on offer.
      m.consumeOffered = !!r.decision.consume;
    }
    const read = r.tools && r.tools.tools ? r.tools.tools : [];
    const unsim = read.filter((t) => !t.sim);
    if (unsim.length) notes.push(`Not in the simulator yet, so left out: ${unsim.map((t) => t.name).join(', ')}.`);
    const tools = runTools(read, base, m, notes, r.tools && r.tools.sims);
    m.tools = tools.map((t) => t.sim);
    // A door short two mornings of the run, with none of the instruments
    // that take one known: the Forged Key, Barbed Whip or Burning Stake.
    // The reader can't tell the Forged Key on a panel, and runs that read as
    // holding the Ring of Keys or the Dog Tag see two doors every morning
    // (f5, from the collected boards). Mornings with the office within
    // reach don't count: its card can be missed.
    const takers = ['forged', 'whip', 'stake'];
    if (newRun(m, base)) m.shortDays = [];
    const officeNear = [1, 2, 3, 4, 5, 6].some((k) => (m.warden + k) % T.CELL_COUNT === T.OFFICE);
    const doorsDue = T.DEFAULT_PARAMS.destinations - m.tools.filter((id) => takers.includes(id)).length;
    if (m.step === 'patrol' && !officeNear && m.dest.length && m.dest.length < doorsDue) m.shortDays = [...new Set([...(m.shortDays || []), m.day])];
    if ((m.shortDays || []).length >= 2 && !m.tools.some((id) => takers.includes(id))) {
      // Held as the Lost Ring of Keys, which takes no door: the Forged Key's
      // icon, two keys on a ring (report 378), passes for it on the panel.
      const hint = m.tools.includes('keys')
        ? `${T.plural(m.shortDays.length, 'morning')} of this run offered a door short, which the Lost Ring of Keys doesn't do. The Forged Key does, and its icon looks like the Ring's: if you hold the Forged Key, set it under Torture Instrument in place of the Lost Ring of Keys${m.toolsLocked ? '' : ', then press These are right'}.`
        : `${T.plural(m.shortDays.length, 'morning')} of this run offered a door short, as the Forged Key, Barbed Whip or Burning Stake do. If you hold one, set it under Torture Instrument${m.toolsLocked ? '' : ', then press These are right'}.`;
      if (m.toolsLocked || m.toolsToConfirm) notes.push(hint);
      else m.toolsToConfirm = hint;
    }
    if (tools.some((t) => t.conf < TOOL_SURE)) notes.push('Some instruments were hard to tell apart: check them under Torture Instrument.');
    const chromatic = r.chromatic ? r.chromatic.count : 0;
    // Their beasts don't show in the slots, and nothing depends on them.
    m.vault = new Array(chromatic).fill('wolf');
    const highest = Math.max(0, ...m.cells.filter((c) => c.kind === 'inmate').map((c) => c.tier));
    // The start card's badge under the instrument panel: the run has that
    // card, in case its popup was missed. Only while no card is set: one the
    // player or a popup set stands (report 358: a Cage Fight badge read as
    // Tyranny undid the player's choice on every picture).
    if (r.badge && r.badge.id && T.START_EVENTS && T.START_EVENTS[r.badge.id] && (!m.startEvent || m.startEvent === 'none')) {
      m.startEvent = r.badge.id;
      notes.push(`Start of run: ${T.START_EVENTS[r.badge.id].name}, from its badge under the instruments.`);
    }
    // A badge that looks like more than one card (Tyranny and Cage Fight):
    // not guessed; the player sets it.
    if (r.badge && r.badge.alike && T.START_EVENTS && (!m.startEvent || m.startEvent === 'none')) {
      const names = r.badge.alike.filter((id) => T.START_EVENTS[id]).map((id) => T.START_EVENTS[id].name);
      if (names.length) notes.push(`The run's start card looks like ${names.join(' or ')} from its badge, which look alike: set it under Start of run.`);
    }
    // King of the Caged is met once a Supreme or Chromatic shows. Prison
    // Walk's tiles aren't read, so they keep what was set.
    if (m.objective === 'king') m.milestone = highest >= T.SUPREME || chromatic > 0;
    // The jaws marker shows on every inmate with something to eat. Cells that
    // disagree were probably misread. A washed-out portrait takes the beast
    // that makes the jaws fit.
    const hasTarget = (state, n) => !state.cells[n].sealed && state.cells[n].inmate && T.devourOptions(state, n).length > 0;
    r.cells.forEach((c, n) => {
      if (!c.ghost || m.cells[n].kind !== 'inmate') return;
      let best = null;
      for (const beast of T.BEASTS) {
        const trial = JSON.parse(JSON.stringify(m));
        trial.cells[n].beast = beast;
        const s2 = buildState(Object.assign({}, trial, { step: 'manage' })).st;
        const fit = r.cells.filter((d, k) => d.kind === 'inmate' && d.jaws !== null && hasTarget(s2, k) === !!d.jaws).length;
        if (!best || fit > best.fit) best = { beast, fit };
      }
      m.cells[n].beast = best.beast;
    });
    const { st: final } = buildState(Object.assign({}, m, { step: 'manage' }));
    const oddCells = [];
    r.cells.forEach((c, n) => {
      if (c.kind !== 'inmate' || m.cells[n].kind !== 'inmate') return;
      // Jaws over a Supreme's red glow aren't known (null): no check.
      if (c.jaws !== null && hasTarget(final, n) !== !!c.jaws) {
        checks.add(n);
        oddCells.push(n);
      }
    });
    // The game shows Consume only when the warden's inmate has a meal. With
    // none on the board as read, the advice can't weigh Consume: say why,
    // and where to look.
    const w = m.warden;
    const noMeal = !!(r.decision && r.decision.consume) && w != null && m.cells[w] && m.cells[w].kind === 'inmate' && !hasTarget(final, w);
    if (noMeal) {
      checks.add(w);
      notes.push(`Your game offers Consume, but the board as read has no meal for the ${T.describe(m.cells[w])} in ${L(w)}, so the advice can’t weigh Consume: check it and the inmates it could eat.`);
    }
    const odd = oddCells.filter((n) => !(noMeal && n === w)).length;
    if (odd) notes.push(odd === 1 ? '1 inmate’s jaws marker doesn’t fit what was read: check it and the inmates around.' : `${odd} inmates’ jaws markers don’t fit what was read: check them and the inmates around.`);
    // Cage Fight set for this run while the game's jaws fit better without
    // it (report 311: a Legendary Wolf showed no jaws over a Rare Rat that
    // Cage Fight would let it eat, and the advice had a Legendary Lion eat
    // that Rat). No reader sets the card, so it was likely set by hand.
    if (m.startEvent === 'cagefight' && oddCells.length) {
      const plain = buildState(Object.assign({}, m, { step: 'manage', startEvent: 'none' })).st;
      const known = r.cells.map((c, n) => n).filter((n) => r.cells[n].kind === 'inmate' && m.cells[n].kind === 'inmate' && r.cells[n].jaws !== null);
      const fits = (state) => known.filter((n) => hasTarget(state, n) === !!r.cells[n].jaws).length;
      const against = known.filter((n) => !r.cells[n].jaws && hasTarget(final, n) && !hasTarget(plain, n));
      if (against.length && fits(plain) > fits(final)) {
        const n = against[0];
        const meal = T.devourOptions(final, n)[0].cell;
        notes.push(`Cage Fight is set for this run, but your game shows no jaws on the ${T.describe(m.cells[n])} in ${L(n)}, which Cage Fight would let eat the ${T.describe(m.cells[meal])} in ${L(meal)}. If this run doesn’t have Cage Fight, set Start of run to No card.`);
      }
    }
    return { model: m, checks, notes, chromatic, tools, unsim, huntPick };
  }

  function renderScan() {
    const box = $('az-scan-result');
    const r = reader.result;
    box.hidden = !r || !reader.image || reader.folded;
    $('az-scan-show').hidden = !(r && reader.image && reader.folded);
    // A loaded picture can be taken back, if it was read wrong.
    $('az-scan-back').hidden = !(reader.undoable && undo.length);
    $('az-scan-report').hidden = !(r && reader.image && window.TartarusReport);
    if (box.hidden) return;
    drawScan();
    const rd = reader.reading;
    const list = [];
    if (r.ok && rd) {
      const m = rd.model;
      const inmates = m.cells.filter((c) => c.kind === 'inmate').length;
      const locked = m.cells.filter((c) => c.kind === 'sealed' || c.kind === 'nest').length;
      const events = m.cells.filter((c) => c.event).length;
      const nests = m.cells.filter((c) => c.kind === 'nest').length;
      list.push(`<li><b>Board</b> ${T.plural(inmates, 'inmate')}, ${T.plural(locked, 'locked cell')}${events ? `, ${T.plural(events, 'event')}` : ''}${nests ? `, ${T.plural(nests, 'rat nest')}` : ''}</li>`);
      list.push(`<li><b>Warden</b> ${r.warden ? (r.warden.cell === T.OFFICE ? 'in the office' : `cell ${L(r.warden.cell)}`) : 'not found'}</li>`);
      list.push(`<li><b>Today</b> ${rd.chain ? `${m.step === 'chain' ? 'a consume chain picks its next meal, or Cancel stops it' : 'the day’s consume picks its meal'}: cell ${rd.chain.map(L).join(' or ')}` : m.step === 'patrol' ? `choose a door: ${m.dest.map(L).join(', ')}` : r.decision && r.decision.ratway ? (rd.huntPick ? `the Hunt: pick the Lion’s prey${(r.decision.framed || []).length ? `, cell ${r.decision.framed.map(L).join(', ')}` : ''}` : 'the Sewer Ratway: pick any cell but the office') : r.decision && r.decision.office ? (rd.model.officeOnly ? `the office: ${rd.model.officeOnly === 'bestow' ? 'Bestow' : 'Instigate'} only` : 'the office: Instigate or Bestow') : r.decision ? `your decision: ${[r.decision.replace && 'Replace', r.decision.consume && 'Consume', 'End'].filter(Boolean).join(', ')}` : 'no door cards, so after the patrol'}</li>`);
      list.push(`<li><b>Riot</b> ${r.days ? `${T.plural(r.days.days, 'day')} away, so day ${m.day} of ${m.maxDays}` : 'not read'}</li>`);
      list.push(`<li><b>Instruments</b> ${rd.tools.length ? rd.tools.map((t) => esc(t.name || t.id) + (t.sim ? '' : ' (not simulated)')).join(', ') : 'none'}</li>`);
      list.push(`<li><b>Chromatic</b> ${T.plural(rd.chromatic, 'prisoner')}${r.chromatic ? '' : ' (panel not found)'}</li>`);
      if (rd.checks.size) list.push(`<li class="is-check"><b>Check</b> ${[...rd.checks].sort((a, b) => a - b).map(L).join(', ')}: unsure, marked Check on the board</li>`);
      for (const note of rd.notes) list.push(`<li class="is-note">${esc(note)}</li>`);
    }
    $('az-scan-summary').innerHTML = list.join('');
    // The objective, cut from the screenshot.
    const obj = r.ok && r.objective ? r.objective : null;
    $('az-scan-objective').hidden = !obj;
    if (obj) {
      const c = $('az-scan-objective-canvas');
      const [x0, y0, x1, y1] = obj;
      const w = x1 - x0;
      const h = y1 - y0;
      const scale = Math.min(1.6, 320 / w);
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(reader.image, x0, y0, w, h, 0, 0, c.width, c.height);
    }
  }

  // A wrong reading, or advice for something that isn't in the game: the
  // report sends the picture with what the reader made of it, what the
  // player has changed since (most likely what was misread) and the advice,
  // to retrain the reader on.
  function reportReading() {
    if (!window.TartarusReport || !reader.image || !reader.result) return;
    TartarusReport.open('reading', { image: reader.image, outcome: readingSummary() });
  }

  // A cell in a report: "lion 3", "locked!" (an event), "nest". Tiers by
  // number, 0 Normal to 4 Supreme.
  function cellText(c) {
    if (!c) return '?';
    if (c.kind === 'inmate' || c.kind === 'scouted') return `${c.beast} ${c.tier}${c.kind === 'inmate' && c.event ? '!' : ''}`;
    if (c.kind === 'scratch' || c.kind === 'revealed') return `${c.kind} ${c.tier}`;
    if (c.kind === 'locked' || c.kind === 'sealed') return c.nest ? 'nest' : c.event ? 'locked!' : 'locked';
    return c.kind;
  }

  // What the reader read, up to the collector's 1000 characters (all of it
  // with full): the most useful first.
  function readingSummary(full) {
    const r = reader.result;
    const rd = reader.reading;
    const lines = [`Reader ${SCRIPT_QUERY.replace(/^\?v=/, '') || 'local'}, ${reader.follow ? 'an Auto Screenshot Mode picture' : 'a screenshot'} of ${reader.image.width}×${reader.image.height}, read in ${(reader.ms / 1000).toFixed(1)} s.`];
    // The Warden's Treasure isn't read from a picture: during it, the picture
    // is a board, from before it or seen behind it (reports 349, 363: taken
    // for a board read wrong).
    if (model.step === 'choice' && model.choice.kind === 'gift') lines.push(`The Warden’s Treasure is open (from the game’s log); this picture is ${model.treasureSeen ? 'the board seen behind it' : 'the last board before it'}. Its gifts aren’t read from a picture.`);
    if (!r.ok || !rd) {
      lines.push(`Not read: ${r.reason || 'no result'}`);
      return lines.join('\n');
    }
    const m = rd.model;
    const sure = (x) => (x && x.conf < 0.6 ? '?' : '');
    const today = rd.chain
      ? `meal pick: ${rd.chain.map(L).join(', ')}`
      : r.doors && r.doors.cells.length
        ? `doors ${r.doors.cells.map(L).join(', ')}${sure(r.doors)}`
        : r.decision
          ? r.decision.ratway
            ? (rd.huntPick ? `the Hunt’s pick of its prey${(r.decision.framed || []).length ? `: ${r.decision.framed.map(L).join(', ')}` : ''}` : 'the Sewer Ratway’s pick of a cell')
            : `buttons: ${r.decision.office ? [r.decision.instigate !== false && 'Instigate', r.decision.bestow !== false && 'Bestow'].filter(Boolean).join(', ') : [r.decision.replace && 'Replace', r.decision.consume && 'Consume', 'End'].filter(Boolean).join(', ')}`
          : 'no doors or buttons';
    lines.push(`Day ${m.day} of ${m.maxDays}${r.days ? `, ${r.days.days} days to the riot${sure(r.days)}` : ', riot not read'}; warden ${r.warden ? L(r.warden.cell) + sure(r.warden) : 'not found'}; ${today}.`);
    lines.push(`Cells (tiers 0 Normal to 4 Supreme, ? unsure): ${r.cells.filter((c) => c.n !== T.OFFICE).map((c) => `${L(c.n)} ${cellText(c)}${c.jaws ? ' jaws' : ''}${c.prey ? ' prey' : ''}${c.ghost ? ' faded' : ''}${sure(c)}`).join(', ')}.`);
    const icons = r.tools && r.tools.tools ? r.tools.tools : [];
    lines.push(`Instruments read: ${icons.length ? icons.map((t) => `${t.name || t.id} ${Math.round(100 * t.conf)}%`).join(', ') : 'none'}; used: ${rd.tools.length ? rd.tools.map((t) => `${t.name || t.id}${t.kept ? ' (kept)' : ''}`).join(', ') : 'none'}.`);
    lines.push(`Chromatic ${rd.chromatic}${r.chromatic ? '' : ' (panel not found)'}; objective ${(T.OBJECTIVES[model.objective] || { name: model.objective || 'none' }).name}${T.START_EVENTS && T.START_EVENTS[model.startEvent] ? `; start card ${T.START_EVENTS[model.startEvent].name}` : ''}.`);
    if (rd.checks.size) lines.push(`Check: ${[...rd.checks].sort((a, b) => a - b).map(L).join(', ')}.`);
    // What the player has changed since this reading became the board.
    if (shot && reader.loaded === rd) {
      const changes = [];
      model.cells.forEach((c, n) => {
        if (n !== T.OFFICE && cellText(c) !== cellText(m.cells[n])) changes.push(`${L(n)} ${cellText(m.cells[n])} → ${cellText(c)}`);
      });
      if (model.warden !== m.warden) changes.push(`warden ${L(m.warden)} → ${L(model.warden)}`);
      const doors = (x) => [...x.dest].sort((a, b) => a - b).map(L).join(' ');
      if (model.step === 'patrol' && m.step === 'patrol' && doors(model) !== doors(m)) changes.push(`doors ${doors(m)} → ${doors(model)}`);
      const names = (ids) => ids.map((id) => T.toolName(id)).join(', ') || 'none';
      const had = (m.tools || []).filter(Boolean).sort();
      const has = model.tools.filter(Boolean).sort();
      if (had.join() !== has.join()) changes.push(`instruments ${names(had)} → ${names(has)}`);
      if (model.day !== m.day) changes.push(`day ${m.day} → ${model.day}`);
      if (changes.length) lines.push(`You changed: ${changes.join('; ')}.`);
    }
    // The advice as the player saw it: none until its check is done.
    const working = solver.st && !settled();
    const rec = solver.st && !working ? recommendation() : null;
    lines.push(rec ? `Advice${fresh() ? '' : ' (before your changes)'}: ${rec.label}. ${(rec.why || '').slice(0, 200)}` : working ? 'Advice: still being worked out.' : 'Advice: none.');
    for (const note of rd.notes) lines.push(note);
    const text = lines.join('\n');
    return !full && text.length > 1000 ? `${text.slice(0, 999)}…` : text;
  }

  // The screenshot with what was read drawn over it.
  function drawScan() {
    const r = reader.result;
    const img = reader.image;
    const canvas = $('az-scan-canvas');
    const dpr = window.devicePixelRatio || 1;
    const maxW = Math.min(900, canvas.parentElement.clientWidth || 640);
    const scale = Math.min(1, maxW / img.width) * dpr;
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.style.width = `${Math.round(canvas.width / dpr)}px`;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (!r.ok || !reader.reading) return;
    const checks = reader.reading.checks;
    const doors = new Set(reader.reading.model.step === 'patrol' ? reader.reading.model.dest : []);
    const font = (px) => `600 ${px}px "IBM Plex Mono", ui-monospace, monospace`;
    // The warden: a ring on the arrow's cell, under the labels.
    if (r.warden) {
      const c = r.cells[r.warden.cell];
      ctx.strokeStyle = '#f28c36';
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.arc(c.x * scale, (c.y - 40 * c.k) * scale, 30 * c.k * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of r.cells) {
      if (c.n === T.OFFICE) continue;
      const x = c.x * scale;
      const y = (c.y - 40 * c.k) * scale;
      const w = 92 * c.k * scale;
      const h = 82 * c.k * scale;
      const check = checks.has(c.n);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = check ? '#f1cd48' : doors.has(c.n) ? '#5fc4b8' : 'rgba(234, 223, 197, 0.55)';
      ctx.setLineDash(check ? [5, 4] : []);
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
      // Beast over rarity, shrunk to fit inside the cell's box.
      const cell = reader.reading.model.cells[c.n];
      const lines = c.kind === 'locked' ? [c.nest ? 'nest' : c.event ? 'locked !' : 'locked'] : c.kind === 'inmate' ? [T.beastName(cell.beast), SHORT_TIER[cell.tier]] : ['empty?'];
      let px = Math.round(11 * dpr);
      ctx.font = font(px);
      const widest = Math.max(...lines.map((t) => ctx.measureText(t).width));
      if (widest + 6 * dpr > w) {
        px = Math.max(Math.round(8 * dpr), Math.floor((px * (w - 6 * dpr)) / widest));
        ctx.font = font(px);
      }
      const lh = Math.round(px * 1.25);
      const tw = Math.min(w, Math.max(...lines.map((t) => ctx.measureText(t).width)) + 8 * dpr);
      const th = lh * lines.length + 2 * dpr;
      const top = y + h / 2 - th;
      ctx.fillStyle = check ? 'rgba(241, 205, 72, 0.92)' : 'rgba(15, 18, 22, 0.86)';
      ctx.fillRect(x - tw / 2, top, tw, th);
      ctx.fillStyle = check ? '#1c1913' : '#e3e6eb';
      lines.forEach((t, i) => ctx.fillText(t, x, top + dpr + lh * (i + 0.5)));
    }
    ctx.setLineDash([]);
  }

  // Loads the reading as the board. The caller then asks what to do.
  function useScan() {
    const rd = reader.reading;
    if (!rd) return;
    undo.push({ model: JSON.parse(JSON.stringify(model)), selected, shot });
    if (undo.length > 30) undo.shift();
    leaveShot();
    model = normalize(rd.model);
    reader.undoable = true;
    reader.loaded = rd;
    shot = true;
    shotTools = [...new Set(rd.tools.filter((t) => t.sim && t.conf < TOOL_SURE).map((t) => T.toolName(t.sim)))];
    flags = new Set(rd.checks);
    applied = null;
    via = { scan: true, filled: [...rd.checks].map((n) => `c${n}`), touched: new Set() };
    if (SHARE) SHARE.markManual();
    solver.st = null;
    selected = rd.checks.size ? Math.min(...rd.checks) : model.warden;
    // The screenshot stays in view, with what was read drawn on it, to
    // compare with the board.
    changed();
    scanStatus(rd.checks.size ? `Loaded as your board, with ${T.plural(rd.checks.size, 'cell')} marked Check.` : 'Loaded as your board.');
    renderScan();
  }

  // After a screenshot: to the board, at the first cell marked Check (or
  // the warden's), for the player to set what the reader got wrong.
  function fixBoard() {
    select(flags.size ? Math.min(...flags) : model.warden);
    $('az-board').scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (cellEls[selected]) cellEls[selected].btn.focus({ preventScroll: true });
  }

  // ---------- Wiring ----------

  function segment(id, apply) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.disabled) return;
      apply(b.dataset.v, b);
    });
  }

  function bind() {
    renderLang();
    $('az-game-lang').addEventListener('change', (ev) => setGameLang(ev.target.value === 'other' ? 'xx' : ev.target.value));
    // Beast and rarity pickers, built once.
    $('az-beasts').innerHTML = T.BEASTS.map((b) => `<button type="button" class="az-beast" data-v="${b}">${B.PORTRAITS[b]}<span>${esc(T.beastName(b))}</span></button>`).join('');
    $('az-tiers').innerHTML = T.TIERS.slice(0, TOP_TIER + 1).map((name, t) => `<button type="button" class="az-tier t${t}" data-v="${t}">${esc(name)}</button>`).join('');
    // The instruments: every one the simulator knows, clicked on and off.
    $('az-tools').innerHTML = T.TOOL_IDS.map((id) => `<button type="button" class="az-instrument" data-tool="${id}" aria-pressed="false" title="${esc(`${T.toolName(id)}: ${T.toolText(id)}`)}">${B.INSTRUMENTS[id] || ''}<span>${esc(T.toolName(id))}</span></button>`).join('') + '<p class="az-tools-rest" id="az-tools-rest" hidden>Others</p>';
    $('az-vault-add').innerHTML = `<span class="field-label">Add</span>${T.BEASTS.map((b) => `<button type="button" class="az-ico t5" data-vault-add="${b}" title="Add a Chromatic ${esc(T.beastName(b))}" aria-label="Add a Chromatic ${esc(T.beastName(b))}">${B.PORTRAITS[b]}</button>`).join('')}`;

    segment('az-kind', (v) => setKind(v));
    segment('az-beasts', (v) => setCell(selected, { kind: model.cells[selected].kind === 'scouted' ? 'scouted' : 'inmate', beast: v }));
    segment('az-tiers', (v) => {
      const c = model.cells[selected];
      setCell(selected, { kind: ['scratch', 'scouted', 'revealed'].includes(c.kind) ? c.kind : 'inmate', tier: Number(v) });
    });
    segment('az-event', (v) => setCell(selected, { event: v === 'none' ? null : v }));
    $('az-ivory').addEventListener('change', (e) => setCell(selected, { ivory: e.target.checked }));
    $('az-prey').addEventListener('change', (e) => {
      const value = e.target.value;
      setCell(selected, { prey: value === '' ? null : { cell: Number(value), rounds: toInt($('az-prey-rounds').value, T.DEFAULT_PARAMS.preyRounds) } });
    });
    $('az-prey-rounds').addEventListener('change', (e) => {
      const c = model.cells[selected];
      if (c.prey) setCell(selected, { prey: { cell: c.prey.cell, rounds: clamp(toInt(e.target.value, 1), 1, 9) } });
    });
    $('az-nest-due').addEventListener('change', (e) => setCell(selected, { due: clamp(toInt(e.target.value, model.day + 2), 1, 60) }));
    $('az-warden').addEventListener('click', () => setWarden(selected));
    $('az-door').addEventListener('click', () => toggleDoor(selected));

    $('az-riot').addEventListener('change', (e) => {
      const max = clamp(toInt(model.maxDays, 20), 5, 60);
      model.day = clamp(max - toInt(e.target.value, max - model.day), 1, max);
      changed();
    });
    $('az-days').addEventListener('change', (e) => {
      model.maxDays = clamp(toInt(e.target.value, 20), 5, 60);
      model.day = Math.min(model.day, model.maxDays);
      changed();
    });
    segment('az-step', (v) => {
      model.step = v;
      // The buttons only show with the warden in the office.
      if (v === 'office') model.warden = T.OFFICE;
      changed();
    });
    $('az-doors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-door]');
      if (b) toggleDoor(Number(b.dataset.door));
    });
    $('az-devoured').addEventListener('change', (e) => {
      model.devourUsed = e.target.checked;
      changed();
    });
    $('az-swapped').addEventListener('change', (e) => {
      model.swapUsed = e.target.checked;
      changed();
    });
    $('az-consume-offered').addEventListener('change', (e) => {
      model.consumeOffered = e.target.checked;
      changed();
    });
    segment('az-event-kind', (v) => {
      model.eventKind = v;
      touch('event');
      changed();
    });
    segment('az-choice-kind', (v) => {
      model.choice = Object.assign({}, model.choice, { kind: v });
      touch('choice');
      changed();
    });
    $('az-offer').addEventListener('change', (e) => {
      if (e.target.id === 'az-gift-picks') {
        model.choice = Object.assign({}, model.choice, { picks: clamp(toInt(e.target.value, 1), 1, 30) });
        touch('choice');
        changed();
        return;
      }
      if (e.target.id === 'az-rerolls') {
        model.choice = Object.assign({}, model.choice, { rerolls: clamp(toInt(e.target.value, 0), 0, 9) });
        touch('choice');
        changed();
        return;
      }
      const sel = e.target.closest('[data-offer]');
      if (!sel) return;
      const options = [0, 1, 2].map((i) => model.choice.options[i] || '');
      options[Number(sel.dataset.offer)] = sel.value;
      touch('choice');
      model.choice = Object.assign({}, model.choice, { options: options.filter(Boolean) });
      changed();
    });
    $('az-armed').addEventListener('change', (e) => {
      model.chainArmed = e.target.checked;
      changed();
    });
    $('az-tools-open').addEventListener('click', () => openTools());
    $('az-tools-close').addEventListener('click', () => closeTools());
    $('az-tools-dialog').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeTools();
      }
    });
    $('az-tools-search').addEventListener('input', (e) => filterTools(e.target.value));
    // Enter picks the one instrument left by the search.
    $('az-tools-search').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const left = [...$('az-tools').querySelectorAll('[data-tool]')].filter((b) => !b.hidden);
      if (left.length === 1) left[0].click();
    });
    window.addEventListener('resize', () => placeTools());
    $('az-tools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (!b) return;
      const id = b.dataset.tool;
      model.tools = model.tools.includes(id) ? model.tools.filter((t) => t !== id) : [...model.tools, id];
      model.choice = Object.assign({}, model.choice, { options: model.choice.options.filter((t) => !model.tools.includes(t)) });
      changed();
    });
    // The player confirms the run's instruments as set: they're locked in,
    // and the advice is checked again with them.
    $('az-tools-ok').addEventListener('click', () => {
      closeTools();
      model.toolsToConfirm = '';
      model.toolsLocked = true;
      // The panel's count now: only more than this asks again.
      model.toolsSeen = Math.max(model.tools.length, model.toolsPanel || 0);
      changed();
      ask();
    });
    $('az-rewards').addEventListener('change', (e) => {
      model.rewards = e.target.checked;
      changed();
    });
    $('az-milestone').addEventListener('change', (e) => {
      model.milestone = e.target.checked;
      const n = T.OBJECTIVES[model.objective].need || 0;
      if (!model.milestone && n) model.walkTiles = Math.min(model.walkTiles, n - 1);
      changed();
    });
    $('az-start-event').addEventListener('change', (e) => setStartEvent(e.target.value));
    $('az-objective').addEventListener('change', (e) => {
      model.objective = T.OBJECTIVES[e.target.value] ? e.target.value : 'king';
      model.walkTiles = clamp(model.walkTiles, 0, T.OBJECTIVES[model.objective].need || 0);
      changed();
    });
    $('az-walk').addEventListener('change', (e) => {
      const n = T.OBJECTIVES[model.objective].need || 0;
      model.walkTiles = clamp(toInt(e.target.value, 0), 0, n);
      if (n && model.walkTiles >= n) model.milestone = true;
      changed();
    });
    $('az-vault-add').addEventListener('click', (e) => {
      const b = e.target.closest('[data-vault-add]');
      if (!b) return;
      model.vault = [...model.vault, b.dataset.vaultAdd];
      changed();
    });
    $('az-vault').addEventListener('click', (e) => {
      const b = e.target.closest('[data-unvault]');
      if (!b) return;
      model.vault = model.vault.filter((_, i) => i !== Number(b.dataset.unvault));
      changed();
    });
    $('az-go').addEventListener('click', () => ask());
    $('az-do').addEventListener('click', () => {
      const rec = fresh() ? recommendation() : null;
      if (rec) doMove(rec.action);
    });
    $('az-next').addEventListener('click', () => {
      const rec = fresh() ? recommendation() : null;
      if (rec) doMove(rec.action, true);
    });
    $('az-undo').addEventListener('click', undoMove);
    $('az-applied').addEventListener('click', (e) => {
      if (e.target.closest('[data-undo]')) undoMove();
      if (e.target.closest('[data-match]')) confirmAll();
    });
    $('az-match').addEventListener('click', () => confirmCell(selected));
    $('az-pick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b || b.disabled) return;
      const n = Number($('az-pick').dataset.cell);
      closePick(true);
      pickCell(n, b.dataset.pick);
    });
    // Arrows move around the picker's grid; Escape closes it.
    $('az-pick').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePick(true);
        return;
      }
      const d = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
      if (!d) return;
      e.preventDefault();
      const rows = [...$('az-pick').querySelectorAll('.az-pick-row')].map((r) => [...r.querySelectorAll('[data-pick]:not(:disabled)')]);
      let r = rows.findIndex((row) => row.includes(document.activeElement));
      if (r < 0) return;
      let c = rows[r].indexOf(document.activeElement);
      r = clamp(r + d[0], 0, rows.length - 1);
      c = clamp(c + d[1], 0, rows[r].length - 1);
      rows[r][c].focus();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!$('az-pick').hidden && !e.target.closest('#az-pick, #az-board .cell')) closePick(false);
    });
    $('az-pick').addEventListener('focusout', (e) => {
      const to = e.relatedTarget;
      if (to && !$('az-pick').contains(to) && !to.closest('#az-board .cell')) closePick(false);
    });
    $('az-share').addEventListener('click', (e) => {
      const b = e.target.closest('[data-share]');
      if (!b) return;
      if (b.dataset.share === 'see') SHARE.download();
      else SHARE.setSharing(b.dataset.share === 'on');
    });
    if (SHARE) SHARE.onChange(renderShare);
    $('az-load-run').addEventListener('click', loadRun);
    $('az-example').addEventListener('click', () => {
      leaveShot();
      model = exampleModel();
      selected = 4;
      flags = new Set();
      applied = null;
      via = null;
      if (SHARE) SHARE.reset('example');
      solver.st = null;
      changed();
      notice('Loaded an example: day 6, the warden at cell 05, with three doors to choose from.');
    });
    let clearArmed = 0;
    $('az-clear').addEventListener('click', () => {
      if (Date.now() > clearArmed) {
        clearArmed = Date.now() + 5000;
        $('az-clear').textContent = 'Click again to clear';
        setTimeout(() => {
          $('az-clear').textContent = 'Clear the board';
        }, 5000);
        return;
      }
      clearArmed = 0;
      $('az-clear').textContent = 'Clear the board';
      leaveShot();
      model = blankModel();
      selected = 1;
      flags = new Set();
      applied = null;
      via = null;
      if (SHARE) SHARE.reset('manual');
      solver.st = null;
      changed();
      notice('Cleared: day 1, every cell sealed, the warden in the office.');
    });
    $('az-open-sim').addEventListener('click', openInSimulator);

    // Screenshots: choose a file, paste anywhere, or drop anywhere.
    $('az-scan-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) readImageFile(file);
      e.target.value = '';
    });
    // While the report dialog is open, pastes and drops are its screenshot.
    const reporting = () => !!window.TartarusReport && TartarusReport.isOpen();
    document.addEventListener('paste', (e) => {
      if (reporting()) return;
      const items = e.clipboardData ? [...e.clipboardData.items] : [];
      const item = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
      if (!item) return;
      e.preventDefault();
      readImageFile(item.getAsFile());
      $('az-scan').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || reporting()) return;
      e.preventDefault();
      $('az-scan').classList.add('is-drop');
    });
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) $('az-scan').classList.remove('is-drop');
    });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e) || reporting()) return;
      e.preventDefault();
      $('az-scan').classList.remove('is-drop');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) readImageFile(file);
    });
    $('az-fix').addEventListener('click', fixBoard);
    $('az-recheck').addEventListener('click', () => ask());
    // A screenshot's board waits to be shared until the player moves on; a
    // closing tab counts as moving on.
    window.addEventListener('pagehide', shareHeld);
    // Follow my game (js/auto.js, beta): read frames of the game, load
    // them, and ask, without the toasts a pasted screenshot gets.
    window.TartarusAnalyzer = {
      readFrame: (bitmap) => new Promise((resolve) => readBitmap(bitmap, { quiet: true, folded: true, onRead: resolve })),
      readPick: (bitmap) => readPick(bitmap),
      usePick: (read, fresh) => usePick(read, fresh),
      readTreasure: (bitmap) => readTreasure(bitmap),
      readObjective: (bitmap) => readObjective(bitmap),
      // The game's language (from the log: auto), and a screen the reader
      // didn't recognize on a client not in English.
      setGameLang: (code, auto) => setGameLang(code, auto),
      gameLang: () => gameLang,
      langMissed: (what, image, detail) => langMissed(what, image, detail),
      langBoard: (image) => langBoard(image),
      langMiss: () => (langMiss ? { what: langMiss.what, at: langMiss.at, lang: langName(gameLang) } : null),
      useObjective: (read) => useObjective(read),
      useTreasure: (after) => useTreasure(after),
      // Auto Screenshot Mode's Treasure counts ({ rainbows, taken }): the
      // picks waiting, or null without counts. giftsDone ends a tally that
      // went stale (no Treasure for a while).
      giftCounts: (c) => giftCounts(c),
      giftsDone: () => {
        gifts.waiting = 0;
      },
      useReading: () => useScan(),
      ask: () => ask(true),
      recommendation: () => (fresh() && settled() ? recommendation() : null),
      // The box to click for the advice (see highlight), or null.
      highlightWhy: () => highlightWhy,
      highlight: (test) => {
        // The board's shape (js/scan.js), for a cell's box: loaded once.
        if (!window.TartarusScan && shot && !highlightLoading) {
          highlightLoading = true;
          loadReader(false).catch(() => {
            highlightLoading = false;
          });
        }
        try {
          return highlight(test);
        } catch (e) {
          highlightWhy = String((e && e.message) || e);
          return null;
        }
      },
      // What the reader made of the last picture, in full (the desktop app's
      // test record keeps it).
      readingSummary: () => (reader.result && reader.image ? readingSummary(true) : ''),
      // The live check's workers: how many it may use (setCores, 0 for every
      // core but one) and how many are running now (0 once let go).
      setCores: (n) => setCores(n),
      cores: () => ({ cap: coreCap, use: workerCount(), most: MOST_WORKERS, running: solver.workers ? solver.workers.length : 0, onPage: !!solver.failed }),
      day: () => model.day,
      toast,
    };
    // In the desktop app, the link to download it has no use.
    if (window.TartarusDesktop && $('az-desktop-app')) $('az-desktop-app').hidden = true;
    // Reports of something new carry where the player was, nothing more.
    // The deployed collector turns away a report whose step it doesn't know
    // (a chain's pick), so that one goes without its step.
    if (window.TartarusReport) {
      TartarusReport.setup({
        app: 'analyze-20261014a',
        context: () => ({ page: 'analyze', day: model.day, step: COLLECTOR_STEPS.includes(model.step) ? model.step : null }),
      });
    }
    $('az-scan-report').addEventListener('click', reportReading);
    $('az-report-reading').addEventListener('click', reportReading);
    $('az-toast-actions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-toast]');
      if (!b) return;
      $('az-toast').hidden = true;
      if (b.dataset.toast === 'pick') $('az-scan-file').click();
      else if (b.dataset.toast === 'lang-report') sendLangMiss();
      else $('az-scan').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    $('az-treasure-now').addEventListener('click', () => {
      // Advise the gift on the board as the analyzer has it.
      model.treasureWait = false;
      model.treasureSeen = true;
      gifts.board = gifts.log ? Object.assign({}, gifts.log) : null;
      changed();
      ask();
    });
    $('az-scan-show').addEventListener('click', () => {
      reader.folded = false;
      renderScan();
    });
    $('az-scan-always').checked = showShots;
    $('az-scan-always').addEventListener('change', (e) => {
      showShots = e.target.checked;
      try {
        localStorage.setItem(SHOTS_KEY, showShots ? '1' : '0');
      } catch (err) {
        // Kept until the page closes.
      }
      reader.folded = !showShots;
      renderScan();
    });
    $('az-scan-back').addEventListener('click', () => {
      undoMove();
      renderScan();
      scanStatus('Back to the board before that picture. It isn’t shared.');
    });
    $('az-scan-discard').addEventListener('click', () => {
      reader.result = null;
      reader.reading = null;
      renderScan();
      $('az-report-reading').hidden = true;
      scanStatus('');
    });
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (reader.result && reader.image) drawScan();
      }, 150);
    });

    // Keyboard entry on the board.
    $('az-board').addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('#az-pick')) return;
      const key = e.key.toLowerCase();
      const move = { arrowright: 1, arrowdown: 1, arrowleft: -1, arrowup: -1 }[key];
      if (move) {
        e.preventDefault();
        select((selected + move + T.CELL_COUNT) % T.CELL_COUNT);
        cellEls[selected].btn.focus();
        return;
      }
      if (selected === T.OFFICE && key !== 'h') return;
      const c = model.cells[selected];
      let handled = true;
      if (BEAST_KEYS[key]) setCell(selected, { kind: 'inmate', beast: BEAST_KEYS[key] });
      else if (key >= '1' && key <= '5') setCell(selected, { kind: ['scratch', 'scouted', 'revealed'].includes(c.kind) ? c.kind : 'inmate', tier: Number(key) - 1 });
      else if (key === 's' || key === 'delete' || key === 'backspace') setCell(selected, { kind: 'sealed' });
      else if (key === 'x') setCell(selected, { kind: 'scratch' });
      else if (key === 'n') setCell(selected, { kind: 'nest' });
      else if (key === 'e') setCell(selected, { kind: 'empty' });
      else if (key === 'i' && c.kind === 'inmate') setCell(selected, { ivory: !c.ivory });
      else if (key === 'd') toggleDoor(selected);
      else if (key === 'h') setWarden(selected);
      else handled = false;
      if (handled) {
        e.preventDefault();
        cellEls[selected].btn.focus();
      }
    });
  }

  buildBoard();
  bind();
  render();
})();

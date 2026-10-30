const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sourcePath = require('node:path').join(__dirname, '../js/quicktime.js');
function gate() {
  assert.ok(fs.existsSync(sourcePath), 'QuickTime capture module exists');
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return new context.window.TartarusQuickTime.FrameGate(700);
}
const frame = (value) => new Uint8Array(1200).fill(value);
test('changed game invalidates advice immediately and waits for a stable frame', () => {
  const g = gate();
  assert.equal(g.update(frame(20), 0).ready, false);
  assert.equal(g.update(frame(20), 800).ready, true);
  g.accept();
  assert.equal(g.update(frame(20), 1100).ready, false);
  assert.equal(g.update(frame(80), 1200).changed, true);
  assert.equal(g.update(frame(80), 1600).ready, false);
  assert.equal(g.update(frame(80), 2000).ready, true);
});
test('tiny cursor flicker does not repeatedly rescan an unchanged board', () => {
  const g = gate();
  g.update(frame(20), 0);
  g.update(frame(20), 800);
  g.accept();
  const cursor = frame(20); cursor[0] = 240;
  assert.equal(g.update(cursor, 1000).changed, false);
  assert.equal(g.update(cursor, 2000).ready, false);
});
test('a new board during recognition makes the old token unusable', () => {
  const g = gate();
  g.update(frame(20), 0);
  const token = g.update(frame(20), 800).version;
  g.update(frame(80), 850);
  assert.notEqual(g.version, token);
});
function readiness(read, state) {
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return context.window.TartarusQuickTime.boardReadiness(read, state);
}
test('a recognized chain meal screen is usable even without the ordinary decision row', () => {
  assert.equal(readiness({ ok: true, controls: false }, { controls: true, chain: true, daysRead: true, wardenRead: true, checks: 0, step: 'chain' }), '');
});
test('a board without known buttons or remaining days cannot produce a confident move', () => {
  assert.match(readiness({ ok: true }, { controls: false, daysRead: true, wardenRead: true, checks: 0 }), /action buttons/);
  assert.match(readiness({ ok: true }, { controls: true, daysRead: false, wardenRead: true, checks: 0 }), /Days until the Riot/);
});
test('unconfirmed tools and an event overlay require explicit review', () => {
  assert.match(readiness({ ok: true }, { controls: true, daysRead: true, wardenRead: true, toolsToConfirm: 'blacklist', checks: 0 }), /These are right/);
  assert.match(readiness({ ok: true }, { controls: true, daysRead: true, wardenRead: true, step: 'event', checks: 0 }), /An event/);
});
test('ending from a meal picker tells the player to cancel before ending', () => {
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  assert.equal(context.window.TartarusQuickTime.endText({ chain: true }), 'Cancel the consume, then End the day.');
  assert.equal(context.window.TartarusQuickTime.endText({ chain: false }), 'Press End.');
});
function lifecycle() {
  const context = { window: {}, URLSearchParams, location: { search: '' }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return context.window.TartarusQuickTime.RecognitionLane;
}
test('timed-out recognition holds the lane until its analyzer finishes and discards its result', async () => {
  const Lane = lifecycle();
  let alarm, resolveRead, notices = 0;
  const lane = new Lane((fn) => { alarm = fn; return 1; }, () => {});
  const pending = lane.run(() => new Promise((resolve) => { resolveRead = resolve; }), 100, () => notices++);
  alarm();
  assert.equal(notices, 1);
  assert.equal(lane.busy, true);
  await assert.rejects(lane.run(() => 'must not run', 100, () => {}), /busy/);
  resolveRead({ ok: true });
  const outcome = await pending;
  assert.equal(outcome.expired, true);
  assert.equal(outcome.value, undefined);
  assert.equal(lane.busy, false);
});
test('an old stage timeout cannot erase a newer stage after the old analyzer drains', async () => {
  const Lane = lifecycle();
  const alarms = [];
  let notices = 0, finishNew;
  const lane = new Lane((fn) => { alarms.push(fn); return alarms.length; }, () => {});
  await lane.run(() => Promise.resolve('old'), 100, () => notices++);
  const newer = lane.run(() => new Promise((resolve) => { finishNew = resolve; }), 100, () => notices++);
  alarms[0]();
  assert.equal(notices, 0);
  assert.equal(lane.busy, true);
  finishNew('new');
  assert.equal((await newer).value, 'new');
});
// Run the real capture pipeline with synthetic media frames and the analyzer's
// actual treasure state machine. Browser media/DOM are the boundary doubles.
// A screen is 'treasure' (the overlay, no board), 'view' (View Prison Status)
// or { board: signature, checks, move } (a board with its action buttons).
function bridgeHarness(options = {}) {
  const elements = new Map();
  const classes = new Set();
  const element = () => ({ textContent: '', hidden: false, disabled: false, checked: true, listeners: {}, firstChild: null, classList: { add() {} }, setAttribute() {}, appendChild() {}, append() {}, prepend() {}, replaceChildren() {}, focus() {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
  const get = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const intervals = new Map(); let intervalId = 0, now = 0, pixel = 20, screen = 'treasure';
  const analyzerSource = fs.readFileSync(require('node:path').join(__dirname, '../js/analyze.js'), 'utf8');
  const start = analyzerSource.indexOf('  function useTreasure(after) {');
  const finish = analyzerSource.indexOf('\n  // Without workers', start);
  const board = () => ({ step: 'manage', choice: {}, cells: [], warden: 0, startEvent: options.opulence ? 'opulence' : 'none' });
  const state = { model: board(), applied: null, solver: {}, undo: [], reader: {}, selected: 0, shot: false,
    gifts: {}, picksNow: () => 1, pickedSinceBoard: () => false, fresh: () => !!state.isFresh, settled: () => true,
    changed: () => { state.isFresh = false; }, renderScan() {}, toast() {}, ask: () => { state.isFresh = true; return true; } };
  vm.createContext(state); vm.runInContext(analyzerSource.slice(start, finish), state);
  // The reader's side: the reading of the last board, and whether it is the
  // one loaded (the player's fixes live in `fixed`, as the analyzer's flags).
  const rd = { loaded: false, checks: 0, fixed: 0, move: 'patrol' };
  const calls = { useReading: 0, ask: 0, guesses: [], tipReads: 0, setTools: [] };
  // The instruments: the panel's slots in the last board read, and the run's
  // instruments as the analyzer has them (unknown until set or confirmed).
  const tools = { slots: 0, known: [], toConfirm: '' };
  const recommendation = () => {
    if (!state.isFresh || state.model.treasureWait) return null;
    if (state.model.step === 'choice') return { action: { type: 'choose', id: 'wine' } };
    return { action: rd.move === 'patrol' ? { type: 'patrol', cell: 3 } : { type: rd.move, to: 3 } };
  };
  const A = {
    async readFrame() {
      if (options.animateRead && options.animate) options.animate();
      if (screen === 'treasure') return { ok: false };
      if (screen === 'view') { rd.loaded = false; rd.sig = 'view'; rd.checks = 0; return { ok: true, statusView: true }; }
      rd.loaded = false; rd.sig = screen.board; rd.checks = screen.checks || 0; rd.move = screen.move || 'patrol';
      if (screen.tools) {
        tools.slots = screen.tools;
        // Icons read sure of themselves fill the unknown run's instruments, unconfirmed.
        if (!tools.locked && screen.sure) tools.known = screen.sure.slice();
        if (tools.known.length < screen.tools || !tools.locked) tools.toConfirm = `The analyzer doesn’t know this run’s instruments yet (${screen.tools} on the panel).`;
      }
      return { ok: true };
    },
    // An instrument's tip on the screen: its name read as text.
    async readToolTip() { calls.tipReads++; if (!screen.tip) return { ok: false, reason: 'no tip' }; return screen.tip === 'unreadable' ? { ok: false, reason: 'name not read' } : { ok: true, id: screen.tip, name: `Tool ${screen.tip}` }; },
    toolSurvey: () => ({ slots: tools.slots, known: tools.known.slice(), locked: !!tools.locked, needed: !!tools.toConfirm }),
    // Array.from: an array of this realm, for deepEqual (the ids come from the page's).
    setTools(ids) { calls.setTools.push(Array.from(ids)); tools.known = Array.from(ids); tools.locked = true; tools.toConfirm = ''; return state.ask(); },
    async readTreasure() { if (options.animate) options.animate(); return { ok: true }; },
    async readPick() { throw new Error('Treasure must not wait for three-card OCR'); },
    useReading() { calls.useReading++; state.model = board(); rd.loaded = true; rd.everLoaded = true; rd.fixed = rd.checks; state.isFresh = false; },
    keepReading() { if (!rd.everLoaded && !rd.loaded) return false; rd.loaded = true; return true; },
    useTreasure: state.useTreasure,
    // The user, 2026-10-24: a gift is never guessed on the board before the
    // Treasure; the eye view is asked for instead.
    treasureGuess() { throw new Error('A Treasure must not be guessed on the last board: ask for View Prison Status'); },
    giftState: () => ({ open: state.model.step === 'choice' && state.model.choice.kind === 'gift', wait: !!state.model.treasureWait, seen: !!state.model.treasureSeen, picked: false, opulence: state.model.startEvent === 'opulence' }),
    quickTimeState: () => (screen === 'treasure' ? null : { controls: screen !== 'view', daysRead: true, wardenRead: true, checks: rd.loaded ? rd.fixed : rd.checks, step: state.model.step, signature: rd.sig, toolsToConfirm: tools.toConfirm }),
    ask: () => { calls.ask++; return state.ask(); }, recommendation, quickRecommendation: recommendation,
    setGameLang() {},
  };
  const track = { getSettings: () => ({ displaySurface: options.surface || 'window' }), stop() {}, addEventListener() {} };
  const spoken = [];
  const voicesUsed = [];
  const stored = {};
  const docListeners = {};
  // An animated overlay: the next frame differs while a check still runs.
  const tick = () => [...intervals.values()].find((i) => i.ms === 250).fn();
  if (options.animated) options.animate = () => { pixel = (pixel + 50) % 250; now += 300; tick(); };
  const ctx = {
    window: { TartarusAnalyzer: A, Tartarus: { OFFICE: 0, GIFTS: { wine: { name: 'Crimson Wine' } } }, addEventListener() {} },
    location: { search: options.record ? '?quicktime=1&record=1' : '?quicktime=1', hostname: options.hostname || 'localhost' }, URLSearchParams, fetch: options.fetch, JSON, Date, localStorage: { getItem: (k) => (options.storage && options.storage[k]) || null, setItem: (k, v) => { stored[k] = v; } }, setTimeout, clearTimeout,
    setInterval: (fn, ms) => { intervals.set(++intervalId, { fn, ms }); return intervalId; }, clearInterval: (id) => intervals.delete(id),
    navigator: Object.assign({ mediaDevices: { getDisplayMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) } }, options.safari ? {} : { userAgentData: { brands: [{ brand: 'Chromium', version: '130' }] } }),
    performance: { now: () => now }, createImageBitmap: async () => ({ close() {} }),
    speechSynthesis: { cancel() {}, speak(u) { spoken.push(u.text); voicesUsed.push(u.voice && u.voice.name); }, getVoices: () => options.voices || [], addEventListener() {} }, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    document: {
      getElementById: get, querySelector: () => ({ prepend() {} }), addEventListener: (name, fn) => { docListeners[name] = fn; },
      documentElement: { classList: { add: (...names) => names.forEach((n) => classes.add(n)), remove: (...names) => names.forEach((n) => classes.delete(n)) } },
      createElement(tag) {
        if (tag === 'video') return { videoWidth: 1400, videoHeight: 1050, readyState: 2, play: async () => {} };
        if (tag === 'canvas') return { width: 144, height: 100, toDataURL: () => 'data:image/png;base64,AAAA', getContext: () => ({ drawImage() {}, clearRect() {}, getImageData: () => ({ data: new Uint8Array(144 * 100 * 4).fill(pixel) }) }) };
        return element();
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), ctx);
  return {
    start: () => get('qt-start').listeners.click(),
    // Each screen is a new picture (the frame gate sees it change), then
    // settles long enough to be read.
    async screen(next) {
      screen = next === true ? 'view' : next === false ? 'treasure' : next;
      pixel = (pixel + 50) % 250; now += 100;
      [...intervals.values()].find((i) => i.ms === 250).fn();
      now += 1000; [...intervals.values()].find((i) => i.ms === 250).fn();
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      // The advice poll, once, as the browser would run it.
      const poll = [...intervals.values()].find((i) => i.ms === 180);
      if (poll) poll.fn();
    },
    // A screen that never stands still: a new frame every 300 ms for 4 s.
    async restless(next) {
      screen = next;
      for (let t = 0; t < 4000; t += 300) {
        pixel = (pixel + 50) % 250; now += 300; tick();
        for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      }
      const poll = [...intervals.values()].find((i) => i.ms === 180);
      if (poll) poll.fn();
    },
    // Time passes on a still screen, the 250 ms timer running.
    async wait(ms) {
      for (let t = 0; t < ms; t += 250) {
        now += 250; tick();
        for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      }
      const poll = [...intervals.values()].find((i) => i.ms === 180);
      if (poll) poll.fn();
    },
    fix() { rd.fixed = 0; state.isFresh = false; },
    get: (id) => get(id).textContent,
    stop: () => get('qt-stop').listeners.click(),
    classes, calls, spoken, voicesUsed, stored, elements,
    paste: () => docListeners.paste({ clipboardData: { items: [{ type: 'image/png' }] } }),
  };
}
test('a single-pick Treasure keeps its advice back on the overlay after the eye view', async () => {
  const bridge = bridgeHarness();
  await bridge.start();
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /fresh board/);
  assert.equal(bridge.classes.has('qt-stale'), true);
  await bridge.screen(true);
  assert.match(bridge.get('qt-advice'), /Advice: Take Crimson Wine/);
  // Back on the Treasure overlay, where the gift is picked.
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /Advice: Take Crimson Wine/);
  assert.equal(bridge.classes.has('qt-stale'), false);
  bridge.stop();
});
test('Opulence offers never reuse gift advice; each fresh eye view can advise', async () => {
  const bridge = bridgeHarness({ opulence: true });
  await bridge.start();
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /fresh board/);
  await bridge.screen(true);
  assert.match(bridge.get('qt-advice'), /Crimson Wine/);
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /fresh board/);
  assert.equal(bridge.classes.has('qt-stale'), true);
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /fresh board/);
  await bridge.screen(true);
  assert.match(bridge.get('qt-advice'), /Crimson Wine/);
  assert.equal(bridge.classes.has('qt-stale'), false);
  bridge.stop();
});
test('the same board read again keeps the fixes made on it', async () => {
  const bridge = bridgeHarness();
  await bridge.start();
  await bridge.screen({ board: 'A', checks: 2 });
  // Doubts that stay: loaded once a notification would have gone.
  await bridge.wait(7000);
  assert.equal(bridge.calls.useReading, 1);
  assert.match(bridge.get('qt-advice'), /advice hidden/i);
  bridge.fix();
  // A notification over the same board: the screen changes, then settles back.
  await bridge.screen({ board: 'A', checks: 2 });
  assert.equal(bridge.calls.useReading, 1, 'the fixed board is not replaced by the same reading');
  assert.match(bridge.get('qt-advice'), /Advice: Go to cell 04/);
  await bridge.screen({ board: 'B' });
  assert.equal(bridge.calls.useReading, 2);
  bridge.stop();
});
// The user, 2026-10-24: the board after a Rainbow isn't the board before it,
// so a gift advised on the last board read was the wrong one. A Treasure
// right after a board asks for the eye view like any other.
test('a Treasure right after a board read asks for the eye view, and advises nothing', async () => {
  const bridge = bridgeHarness({ storage: { 'qt-speak': '1' } });
  await bridge.start();
  await bridge.screen({ board: 'A' });
  assert.match(bridge.get('qt-advice'), /Go to cell 04/);
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /fresh board/);
  assert.doesNotMatch(bridge.get('qt-advice'), /Crimson Wine|Provisional/);
  assert.match(bridge.get('qt-status'), /View Prison Status/);
  assert.equal(bridge.classes.has('qt-stale'), true);
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /fresh board/);
  assert.equal(bridge.spoken.filter((t) => /View Prison Status/.test(t)).length, 1, `said: ${JSON.stringify(bridge.spoken)}`);
  // The eye view gives the exact advice, which holds back on the overlay.
  await bridge.screen(true);
  assert.match(bridge.get('qt-advice'), /Advice: Take Crimson Wine/);
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /Advice: Take Crimson Wine/);
  bridge.stop();
});
test('Opulence gift advice requires a manually supplied remaining-pick count', () => {
  assert.match(readiness({ ok: true, statusView: true }, { controls: false, daysRead: true, wardenRead: true, checks: 0, giftPicksUncertain: true }), /Opulence.*Picks Left/);
  assert.equal(readiness({ ok: true, statusView: true }, { controls: false, daysRead: true, wardenRead: true, checks: 0, giftPicksUncertain: false }), '');
});
test('default recognition timers retain the browser global receiver', async () => {
  const ctx = { window: {}, URLSearchParams, location: { search: '' } };
  vm.createContext(ctx);
  vm.runInContext(`
    globalThis.setTimeout = function () { if (this !== globalThis) throw new TypeError('Illegal invocation'); return 1; };
    globalThis.clearTimeout = function () { if (this !== globalThis) throw new TypeError('Illegal invocation'); };
  `, ctx);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), ctx);
  const lane = new ctx.window.TartarusQuickTime.RecognitionLane();
  assert.equal((await lane.run(() => Promise.resolve('read'), 100, () => {})).value, 'read');
});
test('a notification over the board is read again, not loaded: the board behind it comes back', async () => {
  const bridge = bridgeHarness({ storage: { 'qt-speak': '1' } });
  await bridge.start();
  await bridge.screen({ board: 'A' });
  assert.equal(bridge.calls.useReading, 1);
  // A banner over the countdown or the instruments: the read has doubts.
  await bridge.screen({ board: 'covered', checks: 1 });
  assert.equal(bridge.calls.useReading, 1, 'the misread is not loaded');
  assert.match(bridge.get('qt-status'), /covered/);
  await bridge.wait(2000);
  assert.equal(bridge.calls.useReading, 1, 'still held while it may be a notification');
  // The banner goes: the same board as before, its advice back, said once.
  await bridge.screen({ board: 'A' });
  assert.equal(bridge.calls.useReading, 1);
  assert.match(bridge.get('qt-advice'), /Advice: Go to cell 04/);
  assert.deepEqual(bridge.spoken, ['Go to cell 4.']);
  bridge.stop();
});
test('Read again loads a doubtful screen at once', async () => {
  const bridge = bridgeHarness();
  await bridge.start();
  await bridge.screen({ board: 'A', checks: 1 });
  assert.equal(bridge.calls.useReading, 0);
  bridge.elements.get('qt-rescan').listeners.click();
  await bridge.wait(1500);
  assert.equal(bridge.calls.useReading, 1);
  bridge.stop();
});
test('the whole Mac screen (AirPlay) is read like a window when nothing covers it', async () => {
  const bridge = bridgeHarness({ surface: 'monitor' });
  await bridge.start();
  await bridge.screen({ board: 'A' });
  assert.match(bridge.get('qt-advice'), /Advice: Go to cell 04/);
  bridge.stop();
});
test('a notification over the board is read again, not loaded: the board behind it comes back', async () => {
  const bridge = bridgeHarness({ storage: { 'qt-speak': '1' } });
  await bridge.start();
  await bridge.screen({ board: 'A' });
  assert.equal(bridge.calls.useReading, 1);
  // A banner over the countdown or the instruments: the read has doubts.
  await bridge.screen({ board: 'covered', checks: 1 });
  assert.equal(bridge.calls.useReading, 1, 'the misread is not loaded');
  assert.match(bridge.get('qt-status'), /covered/);
  await bridge.wait(2000);
  assert.equal(bridge.calls.useReading, 1, 'still held while it may be a notification');
  // The banner goes: the same board as before, its advice back, said once.
  await bridge.screen({ board: 'A' });
  assert.equal(bridge.calls.useReading, 1);
  assert.match(bridge.get('qt-advice'), /Advice: Go to cell 04/);
  assert.deepEqual(bridge.spoken, ['Go to cell 4.']);
  bridge.stop();
});
test('Read again loads a doubtful screen at once', async () => {
  const bridge = bridgeHarness();
  await bridge.start();
  await bridge.screen({ board: 'A', checks: 1 });
  assert.equal(bridge.calls.useReading, 0);
  bridge.elements.get('qt-rescan').listeners.click();
  await bridge.wait(1500);
  assert.equal(bridge.calls.useReading, 1);
  bridge.stop();
});
test('the whole Mac screen (AirPlay) is read like a window when nothing covers it', async () => {
  const bridge = bridgeHarness({ surface: 'monitor' });
  await bridge.start();
  await bridge.screen({ board: 'A' });
  assert.match(bridge.get('qt-advice'), /Advice: Go to cell 04/);
  bridge.stop();
});
function contentRect(lum, w, h) {
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return context.window.TartarusQuickTime.contentRect(lum, w, h);
}
// A 160×100 screen with a picture from (x0, y0) to (x1, y1), the rest black.
function screenWith(x0, y0, x1, y1, fill = () => 90) {
  const lum = new Uint8Array(160 * 100);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) lum[y * 160 + x] = fill(x, y);
  return lum;
}
test('AirPlay on a wider screen: the iPad picture between the black bars', () => {
  const r = contentRect(screenWith(14, 0, 146, 100), 160, 100);
  assert.ok(Math.abs(r.x - 14 / 160) < 1e-9 && Math.abs(r.w - 132 / 160) < 1e-9);
  assert.equal(r.y, 0); assert.equal(r.h, 1);
});
test('a dark edge of the picture does not move the bars: they are centred', () => {
  // The game's left edge is as dark as the bar: the right bar sets both.
  const r = contentRect(screenWith(14, 0, 146, 100, (x) => (x < 30 ? 0 : 90)), 160, 100);
  assert.ok(Math.abs(r.x - 14 / 160) < 1e-9 && Math.abs(r.w - 132 / 160) < 1e-9);
});
function barIntrusion(lum, rect) {
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return context.window.TartarusQuickTime.barIntrusion(lum, 160, 100, rect, 0);
}
test('a Mac notification over the black bar is seen; a cursor there is not', () => {
  const picture = { x: 14 / 160, y: 0, w: 132 / 160, h: 1 };
  assert.equal(barIntrusion(screenWith(14, 0, 146, 100), picture), false);
  // The banner: top right, over the bar and the picture's edge.
  const banner = screenWith(14, 0, 146, 100);
  for (let y = 2; y < 10; y++) for (let x = 120; x < 158; x++) banner[y * 160 + x] = 200;
  assert.equal(barIntrusion(banner, picture), true);
  const cursor = screenWith(14, 0, 146, 100);
  for (let y = 50; y < 53; y++) for (let x = 150; x < 153; x++) cursor[y * 160 + x] = 255;
  assert.equal(barIntrusion(cursor, picture), false);
  // No bars (a window share, or none measured): nothing to cover.
  assert.equal(barIntrusion(banner, { x: 0, y: 0, w: 1, h: 1 }), false);
});
test('no bars, a black screen or a tiny lit spot: the whole frame is used', () => {
  assert.equal(contentRect(screenWith(0, 0, 160, 100), 160, 100), null);
  assert.equal(contentRect(new Uint8Array(160 * 100), 160, 100), null);
  assert.equal(contentRect(screenWith(70, 40, 90, 60), 160, 100), null);
});
test('each move is said once, not again when the same board is read again', async () => {
  const bridge = bridgeHarness({ storage: { 'qt-speak': '1' } });
  await bridge.start();
  await bridge.screen({ board: 'A' });
  await bridge.screen({ board: 'A' });
  assert.deepEqual(bridge.spoken, ['Go to cell 4.']);
  await bridge.screen({ board: 'B' });
  assert.deepEqual(bridge.spoken, ['Go to cell 4.', 'Go to cell 4.']);
  // A Treasure: the eye view is asked for, no gift is guessed aloud.
  await bridge.screen(false);
  assert.match(bridge.spoken[2], /View Prison Status/);
  bridge.stop();
});

// The user, 2026-10-24: the panel's icons read by their art were wrong
// (the Filthy Claws read as the Skewered Rat Heads, sure of it). When the
// run's instruments aren't known, the player taps each one on the iPad and
// its tip's name is read as text, then the set is taken as confirmed.
test('unknown instruments: each is tapped and its name read, then the set is taken', async () => {
  const bridge = bridgeHarness({ storage: { 'qt-speak': '1' } });
  await bridge.start();
  // The icons read the Claws as the Skewered Rat Heads, sure of it: that
  // reading is not trusted, every slot is asked for. No 6 s doubt wait
  // first: the instruments are unknown, not hidden by a notification.
  await bridge.screen({ board: 'A', tools: 2, sure: ['skewer'] });
  assert.match(bridge.get('qt-status'), /Tap instrument 1 of 2/);
  assert.match(bridge.get('qt-advice'), /advice hidden/i);
  assert.ok(bridge.spoken.some((t) => /Tap instrument 1 of 2/.test(t)), `said: ${JSON.stringify(bridge.spoken)}`);
  // The first tip opens; its name is read. The same tip, still open, is not read twice.
  await bridge.screen({ board: 'A', tools: 2, tip: 'coin' });
  assert.match(bridge.get('qt-status'), /Tap instrument 2 of 2/);
  await bridge.screen({ board: 'A', tools: 2, tip: 'coin' });
  assert.match(bridge.get('qt-status'), /Tap instrument 2 of 2/);
  // The tip closed for a moment: the board is read as usual, the survey goes on.
  await bridge.screen({ board: 'A', tools: 2 });
  assert.match(bridge.get('qt-status'), /Tap instrument 2 of 2/);
  assert.deepEqual(bridge.calls.setTools, []);
  // The second tip: the set is complete and taken, and the advice comes at once.
  await bridge.screen({ board: 'A', tools: 2, tip: 'claws' });
  assert.deepEqual(bridge.calls.setTools, [['coin', 'claws']]);
  assert.ok(bridge.spoken.some((t) => /Instruments set/.test(t)), `said: ${JSON.stringify(bridge.spoken)}`);
  assert.match(bridge.get('qt-advice'), /Advice: Go to cell 04/);
  // The tip closed: the board as before, with advice.
  await bridge.screen({ board: 'A', tools: 2 });
  assert.match(bridge.get('qt-advice'), /Advice: Go to cell 04/);
  bridge.stop();
});
test('a tip whose name can\'t be read is asked for again, then the player is asked to set the instruments by hand', async () => {
  const bridge = bridgeHarness();
  await bridge.start();
  await bridge.screen({ board: 'A', tools: 1 });
  assert.match(bridge.get('qt-status'), /Tap instrument 1 of 1/);
  await bridge.screen({ board: 'A', tools: 1, tip: 'unreadable' });
  assert.match(bridge.get('qt-status'), /tap it again/i);
  await bridge.screen({ board: 'A', tools: 1, tip: 'unreadable' });
  assert.match(bridge.get('qt-status'), /tap it again/i);
  await bridge.screen({ board: 'A', tools: 1, tip: 'unreadable' });
  assert.match(bridge.get('qt-status'), /These are right/);
  assert.deepEqual(bridge.calls.setTools, []);
  bridge.stop();
});
test('known instruments are never asked for; only a new one on the panel is', async () => {
  const bridge = bridgeHarness();
  await bridge.start();
  await bridge.screen({ board: 'A', tools: 1 });
  assert.match(bridge.get('qt-status'), /Tap instrument 1 of 1/);
  // A Treasure in the middle of the survey is read as usual (the eye view asked for).
  await bridge.screen(false);
  assert.match(bridge.get('qt-status'), /View Prison Status/);
  await bridge.screen({ board: 'A', tools: 1 });
  assert.match(bridge.get('qt-status'), /Tap instrument 1 of 1/);
  await bridge.screen({ board: 'A', tools: 1, tip: 'coin' });
  assert.deepEqual(bridge.calls.setTools, [['coin']]);
  await bridge.screen({ board: 'B', tools: 1 });
  assert.match(bridge.get('qt-advice'), /Advice: Go to cell 04/);
  // A third day: the panel shows one more than the run's locked set. That
  // may be a notification over the panel, so the doubt wait comes first.
  await bridge.screen({ board: 'C', tools: 2 });
  await bridge.wait(7000);
  assert.match(bridge.get('qt-status'), /Tap the new instrument/);
  await bridge.screen({ board: 'C', tools: 2, tip: 'claws' });
  assert.deepEqual(bridge.calls.setTools, [['coin'], ['coin', 'claws']]);
  bridge.stop();
});

function recorderClass() {
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return context.window.TartarusQuickTime.Recorder;
}
test('a record names its run by its start and numbers its lines', async () => {
  const Recorder = recorderClass();
  const posts = [];
  const r = new Recorder({ post: async (entry) => { posts.push(entry); }, now: () => Date.UTC(2026, 9, 22, 18, 4, 5, 123) });
  r.start({ surface: 'window' });
  await r.event('reading', { ok: true });
  assert.deepEqual(posts.map((p) => [p.run, p.seq, p.type]), [['2026-10-22T18-04-05-123', 1, 'connect'], ['2026-10-22T18-04-05-123', 2, 'reading']]);
  assert.equal(posts[0].surface, 'window');
  assert.equal(posts[1].at, '2026-10-22T18:04:05.123Z');
});
test('a record that cannot be written says so once a failure, and never breaks the capture', async () => {
  const Recorder = recorderClass();
  const errors = [];
  let up = false;
  const r = new Recorder({ post: async () => { if (!up) throw new Error('offline'); }, onError: (m) => errors.push(m) });
  r.start({});
  await r.event('frame', {});
  await r.event('frame', {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /offline/);
  up = true; await r.event('frame', {});
  up = false; await r.event('frame', {});
  assert.equal(errors.length, 2);
});
test('record lines are written in their order, even when a picture is still being encoded', async () => {
  const Recorder = recorderClass();
  const posts = [];
  const r = new Recorder({ post: async (entry) => { posts.push(entry); } });
  r.start({});
  let encoded;
  const frame = r.event('frame', new Promise((resolve) => { encoded = resolve; }));
  const reading = r.event('reading', { ok: true });
  encoded({ png: 'data:image/png;base64,AAAA' });
  await Promise.all([frame, reading]);
  assert.deepEqual(posts.map((p) => [p.seq, p.type, p.png || null]), [[1, 'connect', null], [2, 'frame', 'data:image/png;base64,AAAA'], [3, 'reading', null]]);
});
function recordingFetch(posts) {
  return async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 204 };
  };
}
test('with ?record=1 on the local site, each read board is recorded with its picture and advice', async () => {
  const posts = [];
  const bridge = bridgeHarness({ record: true, fetch: recordingFetch(posts) });
  await bridge.start();
  await bridge.screen({ board: 'A' });
  await new Promise((resolve) => setImmediate(resolve));
  const types = posts.map((p) => p.body.type);
  assert.equal(posts[0].url, '/__record');
  assert.equal(types[0], 'connect');
  const frame = posts.find((p) => p.body.type === 'frame');
  assert.ok(frame, 'the frame read is recorded');
  assert.equal(frame.body.png, 'data:image/png;base64,AAAA');
  const reading = posts.find((p) => p.body.type === 'reading');
  assert.equal(reading.body.ok, true);
  assert.ok(posts.some((p) => p.body.type === 'advice' && /cell 04/.test(p.body.text)), 'the advice is recorded');
  bridge.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(posts.some((p) => p.body.type === 'stop'), 'the end of the capture is recorded');
});
test('without ?record=1, or away from the local site, nothing is recorded', async () => {
  for (const options of [{}, { record: true, hostname: 'blahdot3h.github.io' }]) {
    const posts = [];
    const bridge = bridgeHarness(Object.assign({ fetch: recordingFetch(posts) }, options));
    await bridge.start();
    await bridge.screen({ board: 'A' });
    bridge.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(posts, []);
  }
});

// Regression guard (2026-10-22 live run): the Warden's Treasure overlay is
// animated, so the frame changed during every Treasure check and the check
// was dropped: no eye instruction at all.
test('an animated Treasure overlay after a board still asks for the eye view', async () => {
  const bridge = bridgeHarness({ animated: true, storage: { 'qt-speak': '1' } });
  await bridge.start();
  await bridge.screen({ board: 'A' });
  await bridge.screen(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(bridge.spoken.some((t) => /View Prison Status/.test(t)), `said: ${JSON.stringify(bridge.spoken)}`);
  assert.ok(!bridge.spoken.includes('Take Crimson Wine.'), 'no guess is said');
  bridge.stop();
});
test('an animated Treasure with no board seen says to open the eye, once', async () => {
  const bridge = bridgeHarness({ animated: true, storage: { 'qt-speak': '1' } });
  await bridge.start();
  await bridge.screen(false);
  await bridge.screen(false);
  await bridge.screen(false);
  const eye = bridge.spoken.filter((t) => /View Prison Status/.test(t));
  assert.equal(eye.length, 1, `said: ${JSON.stringify(bridge.spoken)}`);
  bridge.stop();
});

// Regression guard (2026-10-22 live run): an event's popup kept moving, the
// frame never stood still for the wait, and nothing was read at all.
test('a screen that never stops moving is read anyway after the longest wait', () => {
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  const g = new context.window.TartarusQuickTime.FrameGate(700, 2500);
  g.update(frame(20), 0); g.update(frame(20), 800); g.accept();
  let t = 1000, last;
  for (let i = 0; t < 3400; i++, t += 300) {
    last = g.update(frame(i % 2 ? 60 : 120), t);
    assert.equal(last.ready, false, `not yet at ${t}`);
  }
  last = g.update(frame(200), 3600);
  assert.equal(last.ready, true);
  assert.equal(last.restless, true);
  g.accept();
  assert.equal(g.update(frame(60), 3700).ready, false);
});
test('a screen that settles is still read after the usual wait, not the longest', () => {
  const g = gate();
  g.update(frame(20), 0); g.update(frame(20), 800); g.accept();
  g.update(frame(80), 1000);
  const r = g.update(frame(80), 1700);
  assert.equal(r.ready, true);
  assert.equal(r.restless, false);
});

test('a board behind a popup that never stops moving still gets its advice said', async () => {
  const bridge = bridgeHarness({ animated: true, animateRead: true, storage: { 'qt-speak': '1' } });
  await bridge.start();
  await bridge.restless({ board: 'A' });
  // Said as "cell 4": the voice read the padded "04" as "zero four".
  assert.ok(bridge.spoken.includes('Go to cell 4.'), `said: ${JSON.stringify(bridge.spoken)}`);
  assert.equal(bridge.spoken.filter((t) => t === 'Go to cell 4.').length, 1);
  bridge.stop();
});
test('the voice is on unless the player turned it off', async () => {
  for (const [storage, said] of [[{}, ['Go to cell 4.']], [{ 'qt-speak': '0' }, []]]) {
    const bridge = bridgeHarness({ storage });
    await bridge.start();
    await bridge.screen({ board: 'A' });
    assert.deepEqual(bridge.spoken, said);
    bridge.stop();
  }
});

test('a pasted screenshot goes to the Screenshot tab, where its reading can be checked', async () => {
  const bridge = bridgeHarness({ storage: { 'qt-tab': 'ipad' } });
  await bridge.start();
  bridge.paste();
  assert.equal(bridge.stored['qt-tab'], 'shot');
  assert.equal(bridge.get('qt-status'), 'Capture stopped.');
});
test('the iPad tab is only added in a Chromium browser, which can share a window', () => {
  const chromium = bridgeHarness();
  assert.ok(chromium.elements.has('qt-start'), 'the tab is set up');
  const safari = bridgeHarness({ safari: true });
  assert.equal(safari.elements.has('qt-start'), false);
});
function rank(voices) {
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return Array.from(context.window.TartarusQuickTime.rankVoices(voices), (v) => v.name);
}
// Regression guard: on a Mac whose system language isn't US English, Chrome
// spoke the advice in Albert, the first en-US voice, a novelty one.
test('the voice is never a novelty or robotic Mac voice', () => {
  const mac = ['Albert', 'Bad News', 'Bubbles', 'Eddy (English (United States))', 'Fred', 'Kathy', 'Samantha', 'Whisper', 'Zarvox']
    .map((name) => ({ name, lang: 'en-US' }));
  assert.deepEqual(rank(mac), ['Samantha', 'Eddy (English (United States))']);
});
test('Premium beats Enhanced beats Google beats Samantha', () => {
  const voices = [
    { name: 'Samantha', lang: 'en-US' }, { name: 'Google US English', lang: 'en-US' },
    { name: 'Samantha (Enhanced)', lang: 'en-US' }, { name: 'Ava (Premium)', lang: 'en_US' },
  ];
  assert.deepEqual(rank(voices), ['Ava (Premium)', 'Samantha (Enhanced)', 'Google US English', 'Samantha']);
});
test('only US English voices are offered', () => {
  assert.deepEqual(rank([{ name: 'Daniel', lang: 'en-GB' }, { name: 'Milena', lang: 'ru-RU' }]), []);
  assert.deepEqual(rank(undefined), []);
});
test('the advice is said in the best voice, or the one the player picked', async () => {
  const voices = ['Albert', 'Samantha', 'Daniel'].map((name, i) => ({ name, lang: i === 2 ? 'en-GB' : 'en-US' }));
  let bridge = bridgeHarness({ voices });
  await bridge.start();
  await bridge.screen({ board: 'A' });
  assert.deepEqual(bridge.voicesUsed, ['Samantha']);
  bridge.stop();
  // A saved voice this Mac doesn't have: the best one instead.
  bridge = bridgeHarness({ voices, storage: { 'qt-voice': 'Ava (Premium)' } });
  await bridge.start();
  await bridge.screen({ board: 'A' });
  assert.deepEqual(bridge.voicesUsed, ['Samantha']);
  bridge.stop();
});

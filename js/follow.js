/* Tartarus Simulator: Auto Screenshot Mode (beta), on follow.html.
 * After the player agrees on this page, they connect the game log and share
 * the game window here. Each time the log shows a move, js/capture.js grabs a
 * frame of the window; this page lists it as a small preview and hands it to
 * the board analyzer open in another tab of this browser (js/auto.js there),
 * which reads the board and refreshes the advice. Pictures never leave the
 * browser. The triggers are editable here while the prison's log lines are
 * being worked out. */
(function () {
  'use strict';

  const C = window.TartarusCapture;
  const panel = document.getElementById('follow');
  if (!C || !panel) return;

  const KEY = 'tartarus-sim:auto:v1';
  const CHANNEL = 'tartarus-follow';
  const KEEP = 12; // pictures listed
  // A burst of lines makes one picture, named by its highest kind: a popup
  // that opens right after a move or an action is the picture's subject.
  const RANK = { board: 1, instruments: 2, brushstroke: 2, objective: 3, treasure: 3, open: 3, startover: 4, chest: 5, finish: 6, manual: 7 };
  // #region default-triggers
  // The prison is "S16" in the game's log. A run starts with a pick of 3
  // instruments, which the game logs as it opens. Then each day starts with
  // a "new day" banner; when it closes, the game writes the day's number
  // (out of 20) and lights the cells you can go to. A picture 1.5 seconds
  // after either shows the screen settled, while you choose. The results
  // screen at the end writes the day line too, with max=0, and is left out.
  const DEFAULT_RULES = [
    '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
    '# Tartarus Prison is S16 in the log. A run\'s objective, when it shows one:',
    'objective | S16BoardTaskPop Run | 1500',
    '# The pick of 3 instruments, and after a re-roll:',
    'instruments | S16BoardRelicPop Run | 1500',
    'instruments | Btn_S16Board_RelicPop_Reroll | 2000',
    '# Each day, once its banner closes, and after a move, once its cards come up:',
    'board | \\[S16LastDay\\] check cur=\\d+ max=[1-9] | 1500',
    'board | UI_S16_Card_Up | 1500',
    '# After an action in the cell, and after each bite of a consume chain',
    '# (the next meal to pick, or the board after the chain), once it plays',
    "# out; unless the day ends, as a new day's banner drops a picture still",
    '# waiting (skip):',
    'board | Btn_S16Board_ActionCell | 2000',
    'board | UI_S16_Click_Eat | 2500',
    'skip | S16BoardNewDayPop Run | 0',
    "# The Warden's Treasure, which a Chromatic prisoner opens, and the board",
    '# once it closes, with the gift taken (a consume can open two in a row):',
    'treasure | S16BoardColoredPop Run | 1500',
    'board | S16BoardColoredPop Destory | 600',
    "# The game's Speed-up button: no picture, it flips 'Speed-up is on' here:",
    'speed | Btn_S16Board_Top_Speed | 0',
    '# A Cancel (a consume chain stopped), once the board settles:',
    'board | UI_S16_Click_Cancel | 1500',
    "# After an event's Confirm (the Sewer Ratway's cell pick, or the board after it):",
    'board | Btn_S16Board_EventPop_Confirm | 1500',
  ].join('\n');
  // The prison's own events, for working out more triggers: its buttons,
  // sounds and screens, without the lines that repeat them.
  const DEFAULT_WATCH = '^(?!.*(LogDataTable|AssetLoad@|PageStack@|PageBase@|PageView@|CardMotion|CardPose|BGM_))(?=.*S16)';
  // #endregion
  // Defaults from earlier versions. Saved settings that are just one of
  // these give way to the defaults above.
  const RETIRED = [
    [
      '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
      '# Tartarus Prison is S16 in the log. A run\'s objective, when it shows one:',
      'objective | S16BoardTaskPop Run | 1500',
      '# The pick of 3 instruments, and after a re-roll:',
      'instruments | S16BoardRelicPop Run | 1500',
      'instruments | Btn_S16Board_RelicPop_Reroll | 2000',
      '# Each day, once its banner closes, and after a move, once its cards come up:',
      'board | \\[S16LastDay\\] check cur=\\d+ max=[1-9] | 1500',
      'board | UI_S16_Card_Up | 1500',
      '# After an action in the cell, and after each bite of a consume chain',
      '# (the next meal to pick, or the board after the chain), once it plays',
      "# out; unless the day ends, as a new day's banner drops a picture still",
      '# waiting (skip):',
      'board | Btn_S16Board_ActionCell | 2000',
      'board | UI_S16_Click_Eat | 2500',
      'skip | S16BoardNewDayPop Run | 0',
      "# The Warden's Treasure, which a Chromatic prisoner opens, and the board",
      '# once it closes, with the gift taken (a consume can open two in a row):',
      'treasure | S16BoardColoredPop Run | 1500',
      'board | S16BoardColoredPop Destory | 1500',
      "# The game's Speed-up button: no picture, it flips 'Speed-up is on' here:",
      'speed | Btn_S16Board_Top_Speed | 0',
      '# A Cancel (a consume chain stopped), once the board settles:',
      'board | UI_S16_Click_Cancel | 1500',
    ].join('\n'),
    [
      '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
      '# Tartarus Prison is S16 in the log. A run\'s objective, when it shows one:',
      'objective | S16BoardTaskPop Run | 1500',
      '# The pick of 3 instruments, and after a re-roll:',
      'instruments | S16BoardRelicPop Run | 1500',
      'instruments | Btn_S16Board_RelicPop_Reroll | 2000',
      '# Each day, once its banner closes, and after a move, once its cards come up:',
      'board | \\[S16LastDay\\] check cur=\\d+ max=[1-9] | 1500',
      'board | UI_S16_Card_Up | 1500',
      '# After an action in the cell, and after each bite of a consume chain',
      '# (the next meal to pick, or the board after the chain), once it plays',
      "# out; unless the day ends, as a new day's banner drops a picture still",
      '# waiting (skip):',
      'board | Btn_S16Board_ActionCell | 2000',
      'board | UI_S16_Click_Eat | 2500',
      'skip | S16BoardNewDayPop Run | 0',
      "# The Warden's Treasure, which a Chromatic prisoner opens, and the board",
      '# once it closes, with the gift taken (a consume can open two in a row):',
      'treasure | S16BoardColoredPop Run | 1500',
      'board | S16BoardColoredPop Destory | 1500',
      "# The game's Speed-up button: no picture, it flips 'Speed-up is on' here:",
      'speed | Btn_S16Board_Top_Speed | 0',
    ].join('\n'),
    [
      '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
      '# Tartarus Prison is S16 in the log. A run\'s objective, when it shows one:',
      'objective | S16BoardTaskPop Run | 1500',
      '# The pick of 3 instruments, and after a re-roll:',
      'instruments | S16BoardRelicPop Run | 1500',
      'instruments | Btn_S16Board_RelicPop_Reroll | 2000',
      '# Each day, once its banner closes, and after a move, once its cards come up:',
      'board | \\[S16LastDay\\] check cur=\\d+ max=[1-9] | 1500',
      'board | UI_S16_Card_Up | 1500',
      '# After an action in the cell, once it plays out; unless the day ends,',
      "# as a new day's banner drops a picture still waiting (skip):",
      'board | Btn_S16Board_ActionCell | 2000',
      'skip | S16BoardNewDayPop Run | 0',
      "# The Warden's Treasure, which a Chromatic prisoner opens:",
      'treasure | S16BoardColoredPop Run | 1500',
    ].join('\n'),
    [
      '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
      '# Tartarus Prison is S16 in the log. A run\'s objective, when it shows one:',
      'objective | S16BoardTaskPop Run | 1500',
      '# The pick of 3 instruments, and after a re-roll:',
      'instruments | S16BoardRelicPop Run | 1500',
      'instruments | Btn_S16Board_RelicPop_Reroll | 2000',
      '# Each day, once its banner closes, and after a move, once its cards come up:',
      'board | \\[S16LastDay\\] check cur=\\d+ max=[1-9] | 1500',
      'board | UI_S16_Card_Up | 1500',
      "# The Warden's Treasure, which a Chromatic prisoner opens:",
      'treasure | S16BoardColoredPop Run | 1500',
    ].join('\n'),
    [
      '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
      '# Tartarus Prison is S16 in the log. A run\'s objective, when it shows one:',
      'objective | S16BoardTaskPop Run | 1500',
      '# The pick of 3 instruments, and after a re-roll:',
      'instruments | S16BoardRelicPop Run | 1500',
      'instruments | Btn_S16Board_RelicPop_Reroll | 2000',
      '# Each day, once its banner closes, and after a move, once its cards come up:',
      'board | \\[S16LastDay\\] check cur=\\d+ max=[1-9] | 1500',
      'board | UI_S16_Card_Up | 1500',
    ].join('\n'),
    [
      '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
      '# Tartarus Prison is S16 in the log. A run\'s objective, when it shows one:',
      'objective | S16BoardTaskPop Run | 1500',
      '# The pick of 3 instruments, and after a re-roll:',
      'instruments | S16BoardRelicPop Run | 1500',
      'instruments | Btn_S16Board_RelicPop_Reroll | 2000',
      '# Each day, once its banner closes:',
      'board | \\[S16LastDay\\] check cur=\\d+ max=[1-9] | 1500',
    ].join('\n'),
    [
      '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
      '# Tartarus Prison is S16 in the log. The pick of 3 instruments, and after a re-roll:',
      'instruments | S16BoardRelicPop Run | 1500',
      'instruments | Btn_S16Board_RelicPop_Reroll | 2000',
      '# Each day, once its banner closes:',
      'board | \\[S16LastDay\\] check cur=\\d+ max=[1-9] | 1500',
    ].join('\n'),
    [
      '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
      '# Tartarus Prison is S16 in the log. The pick of 3 instruments:',
      'instruments | S16BoardRelicPop Run | 1500',
      '# Each day, once its banner closes:',
      'board | \\[S16LastDay\\] check cur=\\d+ max=[1-9] | 1500',
    ].join('\n'),
    [
      '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
      '# A new day in Tartarus Prison (S16 in the log), once its banner closes:',
      'board | \\[S16LastDay\\] check cur=\\d+ | 1500',
    ].join('\n'),
    [
      '# kind | pattern | settle ms  (one trigger a line; # starts a note)',
      "# The prison's lines go here at launch. For now, the Frozen Canvas's:",
      'board | S8_HZXY_DrawPaper_Pigment_Puzzle | 900',
      'board | S8SnowField Anim_Fangzhi | 900',
      'brushstroke | S8_HZXY_DrawPaper_Brushwork$ | 900',
      'startover | S8_HZXY_DrawPaper_TearUp | 1200',
      'finish | S8_HZXY_DrawPaper_Draw_Finish | 1500',
    ].join('\n'),
    '^(?!.*Appear_Gen)(?=.*(S\\d+_|Anim_\\w+ Start|AudioEnum|requested row))',
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Settings ----------

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || 'null') || {};
    } catch (e) {
      return {};
    }
  }
  // The panel saves only its own settings. Whether Auto Screenshot Mode is on (the
  // player's agreement) is written only by the agreement at the bottom.
  // Triggers and the watch pattern are saved only when changed from the
  // defaults, so new defaults reach everyone who didn't change them.
  const OWN = ['rules', 'watch', 'read', 'speed'];
  const DEFAULTS = { rules: DEFAULT_RULES, watch: DEFAULT_WATCH, read: true, speed: false };
  const saved = load();
  for (const k of ['rules', 'watch']) if (RETIRED.includes(saved[k])) delete saved[k];
  const prefs = Object.assign({}, DEFAULTS, saved);
  const save = () => {
    try {
      const all = load();
      for (const k of OWN) {
        if (k !== 'read' && k !== 'speed' && prefs[k] === DEFAULTS[k]) delete all[k];
        else all[k] = prefs[k];
      }
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch (e) {
      // Private windows can refuse; settings last until the tab closes.
    }
  };
  // #region agreement
  // Nothing runs until the player has read this page and agreed to this
  // version of it: the controls stay hidden, and none of the code below
  // (connecting the log, sharing a window, passing pictures to the
  // analyzer) is set up.
  const agreed = C.agreed();
  $('az-auto-gate').hidden = agreed;
  $('az-auto-body').hidden = !agreed;
  if (!agreed) return;
  // #endregion

  // "kind | pattern | settle" lines into triggers.
  function parseRules(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('|').map((s) => s.trim());
      const [kind, pattern, settle] = parts.length >= 2 ? parts : ['board', parts[0], ''];
      if (pattern) out.push({ kind: kind || 'board', pattern, settle: Number(settle) || 900, rank: RANK[kind] || 1 });
    }
    return out;
  }

  // ---------- The board analyzer, in another tab ----------

  // Analyzer tabs say they're open when this page asks, when they open and
  // when they're focused. Pictures go to the one used last.
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  const me = Math.random().toString(36).slice(2);
  const analyzers = new Map(); // id -> { seen, focusedAt }

  function target() {
    let best = null;
    for (const [id, a] of analyzers) {
      if (!best || a.focusedAt > best.focusedAt || (a.focusedAt === best.focusedAt && a.seen > best.seen)) best = Object.assign({ id }, a);
    }
    return best;
  }

  function renderAnalyzer() {
    const n = analyzers.size;
    $('az-auto-analyzer-state').textContent = !channel ? 'This browser can’t pass pictures between tabs.'
      : n > 1 ? `Open in ${n} tabs. Pictures go to the one you used last.`
        : n ? 'Open in another tab. Pictures go there.'
          : 'Not open yet.';
    $('az-auto-analyzer').textContent = n ? 'Go to the board analyzer' : 'Open the board analyzer';
  }

  // ---------- The panel ----------

  const captures = []; // newest first: { id, time, kind, hits, frame, why, thumb, full, sent, read, state, asked, note }
  let lastPicture = null; // { at, kind, ok, why }, for the analyzer's status line
  let triggerCount = 0; // triggers in use, for the same
  // The player's last action in a cell, by the log's clock: a consume plays
  // its red screen as the card is clicked; a swap doesn't. A Warden's
  // Treasure that opens just after says which one led to it.
  const stampMs = (at) => {
    const m = /(\d+)\.(\d+)\.(\d+)-(\d+)\.(\d+)\.(\d+):(\d+)/.exec(at || '');
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : 0;
  };
  let lastAction = 0;
  let lastEat = 0;
  let lastGift = 0; // a Warden's Treasure gift confirmed
  // Warden's Treasure picks, for the analyzer to count what's waiting (3 a
  // Treasure with Opulence): each Rainbow reaching the vault, and each gift
  // confirmed. A Rainbow logs its sound twice and lights one vault cell, all
  // within a moment (every burst in the user's logs: 2 sounds a cell), so a
  // burst of Rainbows is its cells, or half its sounds if no cell logged.
  // Counting each sound made every Rainbow two, and a pick still waiting
  // after the gift was taken brought the gift advice back (reports 349, 363,
  // 373). A double-click on Confirm counts once: a pick is its popup
  // opening, then Confirm.
  const gifts = { rainbows: 0, taken: 0 };
  let giftOpen = false;
  const burst = { last: 0, base: 0, sounds: 0, cells: new Set() };

  // The Treasure's popup closing with no gift confirmed just before: the
  // player pressed View Prison Status, and the Treasure still waits.
  function treasureViewed(hits) {
    const shut = stampMs((hits.find((h) => /ColoredPop Destory/.test(h.text || '')) || {}).at);
    return !!shut && !(lastGift && shut >= lastGift && shut - lastGift < 3000);
  }
  function treasureAfter(hits) {
    const pop = stampMs((hits.find((h) => h.kind === 'treasure') || {}).at);
    if (!pop || !lastAction || pop < lastAction || pop - lastAction > 6000) return '';
    return lastEat >= lastAction - 500 ? 'consume' : 'swap';
  }

  // This page's status, for the analyzer to show (js/auto.js).
  function tell() {
    if (!channel) return;
    const st = C.state;
    channel.postMessage({ type: 'status', from: me, log: st.log, file: st.file, window: st.window, last: lastPicture, triggers: triggerCount, detail: st.detail, hits: st.hits, lang: st.lang });
  }
  const NO_EVENTS = 'No game events in the log yet. In the game, press Esc and click Enable Log (under Account Related), then log out and back in.';
  const seen = []; // newest first: { at, line, kind }
  let nextId = 1;
  let resumable = true; // whether the log from last time may still open

  function renderStatus(s) {
    const st = s || C.state;
    const log = st.log === 'on'
      ? `Following ${esc(st.file || 'the log')}: ${st.lines.toLocaleString()} new lines, ${st.hits.toLocaleString()} triggers`
      : st.log === 'starting' ? 'Opening the log…'
        : st.log === 'gone' ? `${esc(st.file || 'The log')} isn’t there any more: it was deleted or moved. It’s followed again as soon as the game writes a new one, or drag it here again.`
          : st.log === 'error' ? `The log can’t be read right now (${esc(st.error)}). Retrying…`
            : st.file ? `Not following ${esc(st.file)} yet.` : 'Not connected.';
    // The game's Enable Log is off: the log has none of the lines the
    // triggers are, so pictures come only from Take a picture now.
    const off = st.log === 'on' && st.detail === 'off'
      ? ' <strong>The game isn’t writing the lines Auto Screenshot Mode needs: its log detail is off.</strong> <a href="#follow-enable-log">Turn on the game’s log</a> (press Esc, then Enable Log), then log out and back in.'
      : '';
    // Following, but no trigger has matched yet: yellow, and its title
    // says how to turn on the game's log.
    const quiet = st.log === 'on' && (!st.hits || st.detail === 'off');
    const logState = $('az-auto-log-state');
    logState.innerHTML = log + off;
    logState.classList.toggle('is-quiet', quiet);
    logState.title = quiet ? NO_EVENTS : '';
    $('az-auto-win-state').textContent = st.window === 'on' ? `Sharing the game window${st.windowSize ? ` (${st.windowSize})` : ''}: ${st.frames} pictures taken.` : 'Not sharing.';
    $('az-auto-log').textContent = st.log === 'on' || st.log === 'starting' ? 'Stop following'
      : st.log === 'off' && st.file && resumable ? `Follow ${st.file} again` : 'Or choose the file';
    $('az-auto-win').textContent = st.window === 'on' ? 'Stop sharing' : 'Share the game window';
    $('az-auto-note').textContent = st.note || '';
  }

  function renderSeen() {
    $('az-auto-seen').innerHTML = seen.slice(0, 80).map((s) => `<li class="${s.kind ? 'is-hit' : ''}"><span class="az-auto-at">${esc(s.at.slice(-12))}</span>${s.kind ? `<span class="az-auto-kind">${esc(s.kind)}</span>` : ''}<code>${esc(s.line.replace(/^\[[^\]]*\]\[[^\]]*\]/, '').slice(0, 220))}</code></li>`).join('') || '<li class="az-auto-empty">No log lines yet.</li>';
  }

  function readText(c) {
    if (!c.frame) return `No picture: ${c.why || 'share the game window first.'}`;
    if (c.note) return c.note;
    if (!c.sent) return prefs.read ? 'Sending to the analyzer…' : 'Not read (reading is off).';
    if (!c.read) return 'Sent to the analyzer, reading…';
    if (c.read.skipped) return 'Skipped: a newer picture came in.';
    if (!c.read.ok) return `Not read: ${c.read.reason}`;
    if (c.read.objective) return `The run’s objective: ${c.read.name}, set on the analyzer.`;
    if (c.read.treasure) return `The Warden’s Treasure: ${c.asked ? 'which gift to take is on the analyzer.' : 'set on the analyzer.'}`;
    if (c.read.pick) return `Read the instrument offer: ${c.read.names.join(', ')}${c.read.unsure ? `, ${c.read.unsure} to check` : ''}${c.read.reroll ? ', a re-roll left' : ''}${c.state === 'used' ? ', loaded as a fresh run' : ''}${c.asked ? ', advice given' : ''}.`;
    const how = c.state === 'used' ? ', loaded' : '';
    return `Read day ${c.read.day}${c.read.unsure ? `, ${c.read.unsure} to check` : ''} in ${(c.read.ms / 1000).toFixed(1)} s${how}${c.asked ? ', advice given' : ''}.`;
  }

  function renderCaptures() {
    $('az-auto-caps').innerHTML = captures.map((c) => {
      const why = c.hits.length ? c.hits.map((h) => h.text || h.kind).slice(0, 3).join(', ') : c.kind;
      return `<li>${c.thumb ? `<a href="${c.full || c.thumb}" target="_blank" rel="noopener"><img src="${c.thumb}" alt="The game at ${esc(c.time.toLocaleTimeString())}"></a>` : '<span class="az-auto-nothumb"></span>'}<div><p><b>${esc(c.kind)}</b> · ${esc(c.time.toLocaleTimeString())}</p><p class="field-note">${esc(why)}</p><p class="field-note">${esc(readText(c))}</p></div></li>`;
    }).join('') || '<li class="az-auto-empty">No pictures yet. They come when the log shows a move, or when you press Take a picture now.</li>';
  }

  // ---------- Each picture ----------

  const toBlob = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));

  async function shrink(frame, width) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(width, frame.width);
    canvas.height = Math.round((frame.height * canvas.width) / frame.width);
    canvas.getContext('2d').drawImage(frame, 0, 0, canvas.width, canvas.height);
    let blob = await toBlob(canvas, 'image/webp', 0.8);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.8);
    return blob;
  }

  // The whole picture's pixels, without loss, for the screenshot reader:
  // { width, height, buffer } of RGBA. They're ready at once, where a PNG
  // of the game's window can take a second to make while the game is busy.
  function pixels(frame) {
    try {
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(frame.width, frame.height) : Object.assign(document.createElement('canvas'), { width: frame.width, height: frame.height });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(frame, 0, 0);
      const data = ctx.getImageData(0, 0, frame.width, frame.height);
      return { width: data.width, height: data.height, buffer: data.data.buffer };
    } catch (e) {
      return null;
    }
  }

  // The whole picture as a PNG, for an analyzer that doesn't take pixels
  // (a tab opened before they came in).
  async function png(frame) {
    try {
      if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(frame.width, frame.height);
        canvas.getContext('2d').drawImage(frame, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
      }
    } catch (e) {
      // Fall back to a canvas on the page.
    }
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext('2d').drawImage(frame, 0, 0);
    return toBlob(canvas, 'image/png');
  }

  // #region each-picture
  // Each picture is listed here as a small preview, kept in memory only:
  // closing the tab drops it. Then it's handed to the board analyzer open
  // in another tab of this browser, which reads it into the board (see
  // js/auto.js). It goes by the browser's BroadcastChannel, which reaches
  // only this site's own pages in this browser. Nothing is uploaded.
  async function onFrame(f) {
    const c = { id: nextId++, time: f.time, kind: f.kind, hits: f.hits || [], frame: !!f.frame, why: f.why || '', thumb: '', full: '', sent: false, read: null, state: '', asked: false, note: '' };
    lastPicture = { at: Date.now(), kind: c.kind, ok: c.frame, why: c.why };
    tell();
    captures.unshift(c);
    for (const old of captures.splice(KEEP)) {
      if (old.thumb) URL.revokeObjectURL(old.thumb);
      if (old.full) URL.revokeObjectURL(old.full);
    }
    if (!f.frame) {
      // The Warden's Treasure needs no picture (every gift is on offer), so
      // the analyzer hears of it anyway.
      if (c.kind === 'treasure' && prefs.read) {
        const to = target();
        if (to) {
          channel.postMessage({ type: 'frame', to: to.id, from: me, id: c.id, kind: c.kind, fresh: false, after: treasureAfter(c.hits), gifts: Object.assign({}, gifts), blob: null });
          c.sent = true;
        }
      }
      renderCaptures();
      return;
    }
    // The analyzer gets the picture first; the previews here can wait.
    if (prefs.read) {
      const to = target();
      if (!to) c.note = 'Not read: open the board analyzer first.';
      else {
        const pix = to.pixels ? pixels(f.frame) : null;
        const blob = pix ? null : await png(f.frame);
        if (!pix && !blob) c.note = 'Not read: the picture couldn’t be prepared.';
        else {
          // fresh: the offer that starts a run comes with the day-0 line;
          // one that comes later (an objective's reward) doesn't.
          const fresh = c.hits.some((h) => /check cur=0\b/.test(h.text || ''));
          // after: for the Warden's Treasure, the action that led to it.
          const after = c.kind === 'treasure' ? treasureAfter(c.hits) : '';
          // treasureView: the board, seen while a Warden's Treasure waits.
          const treasureView = c.kind === 'board' && treasureViewed(c.hits);
          // gifts: the Treasure's counts (Rainbows, picks confirmed).
          channel.postMessage({ type: 'frame', to: to.id, from: me, id: c.id, kind: c.kind, fresh, after, treasureView, gifts: Object.assign({}, gifts), pixels: pix, blob });
          c.sent = true;
        }
      }
      renderCaptures();
    }
    const thumb = await shrink(f.frame, 320);
    const full = await shrink(f.frame, 1600);
    if (thumb) c.thumb = URL.createObjectURL(thumb);
    if (full) c.full = URL.createObjectURL(full);
    renderCaptures();
    if (typeof f.frame.close === 'function') f.frame.close();
  }

  // What the analyzer made of a picture, as it goes.
  function onAnswer(m) {
    const c = captures.find((x) => x.id === m.id);
    if (!c) return;
    if (m.read) c.read = m.read;
    if (m.state) c.state = m.state;
    if (m.asked) c.asked = true;
    renderCaptures();
  }

  // #endregion

  // ---------- Wiring ----------

  // The log can bring hundreds of lines at once: the panel is drawn again at
  // most five times a second, not once a line.
  const due = new Set();
  const soon = (draw) => {
    if (due.has(draw)) return;
    due.add(draw);
    setTimeout(() => {
      due.delete(draw);
      draw();
    }, 200);
  };
  C.on('status', () => soon(renderStatus));
  C.on('seen', (s) => {
    if (/Btn_S16Board_ActionCell/.test(s.line)) lastAction = stampMs(s.at);
    if (/Eating_red_screen/.test(s.line)) lastEat = stampMs(s.at);
    if (/ColoredPop_Confirm/.test(s.line)) {
      lastGift = stampMs(s.at);
      if (giftOpen) gifts.taken += 1;
      giftOpen = false;
    }
    if (/S16BoardColoredPop Run\b/.test(s.line)) giftOpen = true;
    const vault = /Anim_Archive_LightUp, Id = (\S+)/.exec(s.line);
    if (vault || /UI_S16_Premium_Quality_Fly/.test(s.line)) {
      const t = stampMs(s.at);
      if (!t || t - burst.last > 3000) Object.assign(burst, { base: gifts.rainbows, sounds: 0, cells: new Set() });
      burst.last = t;
      if (vault) burst.cells.add(vault[1]);
      else burst.sounds += 1;
      gifts.rainbows = burst.base + Math.max(burst.cells.size, Math.ceil(burst.sounds / 2));
    }
    seen.unshift(s);
    seen.length = Math.min(seen.length, 200);
    soon(renderSeen);
  });
  C.on('frame', (f) => onFrame(f).catch((e) => console.error(e)));

  if (channel) {
    channel.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'here' && m.id) {
        analyzers.set(m.id, { seen: Date.now(), focusedAt: m.focusedAt || 0, pixels: !!m.pixels });
        renderAnalyzer();
        tell();
      } else if (m.type === 'bye') {
        analyzers.delete(m.id);
        renderAnalyzer();
      } else if (m.type === 'read' && m.to === me) onAnswer(m);
      else if (m.type === 'capture' && m.id) {
        // The analyzer's Take a picture now: the same as the button here,
        // and the picture goes to the analyzer that asked.
        analyzers.set(m.id, Object.assign({}, analyzers.get(m.id), { seen: Date.now(), focusedAt: Date.now() }));
        C.captureNow('manual');
      }
    };
    // Ask now and then which analyzer tabs are still open.
    const ask = () => {
      const now = Date.now();
      for (const [id, a] of analyzers) if (now - a.seen > 75000) analyzers.delete(id);
      renderAnalyzer();
      channel.postMessage({ type: 'hello' });
    };
    ask();
    setInterval(ask, 30000);
    // The analyzer shows whether Auto Screenshot Mode is running, from what this
    // page says of itself: whether it follows the log and shares the
    // window, and its last picture (when, of what, and whether one was
    // taken). Never the picture or the log's lines.
    C.on('status', () => soon(tell));
    setInterval(tell, 10000);
    window.addEventListener('pagehide', () => channel.postMessage({ type: 'status', from: me, closed: true }));
    tell();
  }

  $('az-auto-rules').value = prefs.rules;
  $('az-auto-watch').value = prefs.watch;
  $('az-auto-read').checked = prefs.read;
  // The game's Speed-up: animations take about 0.4 of the time, so pictures
  // come sooner. The game doesn't log whether it's on, only each press of
  // its button, so this switch is set once and each press flips it.
  const PACE = 0.45;
  const setSpeed = (on) => {
    prefs.speed = !!on;
    $('az-auto-speed').checked = prefs.speed;
    C.setPace(prefs.speed ? PACE : 1);
    save();
  };
  setSpeed(prefs.speed);
  $('az-auto-speed').addEventListener('change', (e) => setSpeed(e.target.checked));
  C.on('hit', (h) => {
    if (h.kind !== 'speed') return;
    setSpeed(!prefs.speed);
    $('az-auto-note').textContent = `Speed-up was pressed in the game: pictures now come ${prefs.speed ? 'sooner' : 'at the usual pace'}. If that's wrong, flip “Speed-up is on in the game”.`;
  });
  // The built-in triggers always apply, and lines saved here are added to
  // them: a list saved before a trigger was built in can't leave it out.
  const applyRules = () => {
    const rules = parseRules(DEFAULT_RULES);
    // Lines of earlier built-in lists, still in a saved list, are left out.
    const retired = new Set(RETIRED.flatMap((text) => parseRules(text).map((r) => r.pattern)));
    for (const r of parseRules(prefs.rules)) if (!retired.has(r.pattern) && !rules.some((x) => x.pattern === r.pattern)) rules.push(r);
    triggerCount = C.setRules(rules);
    $('az-auto-rules-note').textContent = `${triggerCount} ${triggerCount === 1 ? 'trigger' : 'triggers'} in use (the built-in ones, and any added here).`;
    tell();
  };
  applyRules();
  C.setWatch(prefs.watch);

  $('az-auto-rules').addEventListener('change', (e) => {
    prefs.rules = e.target.value;
    save();
    applyRules();
  });
  $('az-auto-rules-reset').addEventListener('click', () => {
    prefs.rules = DEFAULT_RULES;
    $('az-auto-rules').value = prefs.rules;
    save();
    applyRules();
  });
  $('az-auto-watch').addEventListener('change', (e) => {
    prefs.watch = e.target.value;
    save();
    $('az-auto-watch-note').textContent = C.setWatch(prefs.watch) ? '' : 'That pattern isn’t valid.';
  });
  $('az-auto-read').addEventListener('change', (e) => {
    prefs.read = e.target.checked;
    save();
  });
  $('az-auto-log').addEventListener('click', async () => {
    const st = C.state;
    try {
      if (st.log === 'on' || st.log === 'starting') C.stopLog();
      else if (st.log === 'off' && st.file && resumable) {
        if ((await C.resumeLog(true)) === 'on') return;
        // The browser wouldn't open it again. Dragging it in always works,
        // and the file picker may not (Program Files).
        resumable = false;
        renderStatus();
        $('az-auto-note').textContent = `The browser didn’t open ${st.file} again. Drag it onto the box once more.`;
      } else await C.connectLog();
    } catch (e) {
      // The browser doesn't say when it refused a file under Program Files:
      // the picker just ends, as if cancelled.
      $('az-auto-note').textContent = e && e.name === 'AbortError'
        ? 'No file chosen. If the browser said the folder “contains system files”, drag UE_game.log onto the box instead: that works there too.'
        : (e && e.message) || String(e);
    }
  });

  // Dropping a file anywhere on this page connects it as the log, and the
  // box in step 1 lights up while one is dragged over the page. Without
  // this, the browser would open the dropped file in place of this page.
  const dropBox = $('az-auto-drop');
  const hasFile = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  // The browser repeats dragover while a file is over the page, so the box
  // goes dark a second after they stop (a drag cancelled with Esc, say).
  let dark = 0;
  const light = (on) => {
    clearTimeout(dark);
    dropBox.classList.toggle('is-over', on);
    if (on) dark = setTimeout(() => light(false), 1000);
  };
  document.addEventListener('dragover', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    light(true);
  });
  document.addEventListener('dragleave', (e) => {
    if (hasFile(e) && !e.relatedTarget) light(false); // left the window
  });
  document.addEventListener('drop', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    light(false);
    $('az-auto-note').textContent = '';
    C.dropLog(e.dataTransfer).then(() => {
      resumable = true;
    }, (err) => {
      $('az-auto-note').textContent = (err && err.message) || String(err);
    });
  });
  $('az-auto-win').addEventListener('click', async () => {
    try {
      if (C.state.window === 'on') C.stopWindow();
      else await C.connectWindow();
    } catch (e) {
      if (e && e.name !== 'NotAllowedError') $('az-auto-note').textContent = e.message || String(e);
    }
  });
  $('az-auto-now').addEventListener('click', () => C.captureNow('manual'));
  $('az-auto-seen-save').addEventListener('click', () => {
    const text = seen.slice().reverse().map((s) => `${s.kind ? `[${s.kind}] ` : ''}${s.line}`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'log-lines.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('az-auto-seen-clear').addEventListener('click', () => {
    seen.length = 0;
    renderSeen();
  });

  if (!C.supported.log || !C.supported.window) $('az-auto-note').textContent = 'This browser can’t follow the game. Use Chrome or Edge on a PC.';
  renderStatus();
  renderSeen();
  renderCaptures();
  renderAnalyzer();
  // The log picked last time: the browser asks again before reading it.
  C.resumeLog(false).then(() => renderStatus()).catch(() => {});
})();

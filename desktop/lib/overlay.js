/* Tartarus Overlay: the card over the game. It shows what the board
 * analyzer recommends, read from the analyzer's own results panel
 * (lib/analyzer-adapter.js), and how Auto Screenshot Mode is doing. Everything
 * shown here is text the site wrote; it's set as text, never as markup. */
(function () {
  'use strict';

  const O = window.Overlay;
  const $ = (id) => document.getElementById(id);
  const state = { shell: {}, game: {}, follow: null, advice: null, menu: false };

  // A small element maker: h('p', { class: 'x' }, 'text', child).
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'cmd') el.dataset.cmd = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }
  const button = (label, cmd, primary) => h('button', { type: 'button', class: `btn${primary ? ' is-primary' : ''}`, cmd }, label);
  const line = (kind, content, ...buttons) => h('div', { class: `line is-${kind}` }, kind === 'busy' ? h('span', { class: 'spin' }) : null, h('p', null, content), ...buttons);
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  };

  // How to turn on the game's own log, which the triggers come from.
  const ENABLE_LOG = 'In the game, press Esc and click Enable Log, then log out and back in.';

  // What stops Auto Screenshot Mode from working, if anything.
  function followProblem() {
    const f = state.follow;
    const g = state.game;
    if (state.shell.offline) return line('bad', `Can’t reach the site (${state.shell.offline}). Retrying…`);
    if (state.shell.agreed === false) return line('warn', 'Read and agree on the Auto Screenshot Mode page first.', button('Open it', 'follow', true));
    if (!g.log) return line('bad', 'Couldn’t find your game log (UE_game.log).', button('Choose it', 'pick-log', true));
    if (!g.running) return line('info', 'Waiting for Torchlight: Infinite…');
    if (!f) return line('busy', 'Starting Auto Screenshot Mode…');
    if (f.log === 'gone') return line('warn', 'The game log isn’t there right now. It’s followed again once the game writes it.', button('Choose it', 'pick-log'));
    if (f.log === 'error') return line('bad', `The game log can’t be read: ${f.error || 'retrying'}.`, button('Choose it', 'pick-log'));
    if (f.log !== 'on') return line('busy', 'Connecting the game log…');
    // Windows won't share the game window: a game run as administrator
    // (report 214), or "Could not start video source" (reports 307, 326,
    // 342, 350, even with this app as administrator too). The screen it's
    // on can be shared instead, cut to the game window, once the player says
    // yes here.
    // A window share that starts but gives blank pictures counts too, and
    // with the game as administrator a window share isn't trusted at all
    // (reports 361 and 362).
    const wontShare = !(f.window === 'on' && f.shared === 'screen') && (g.adminBlock || !!(f.diag && f.diag.wontShare));
    if (wontShare && state.shell.screenShare === null) return line('warn', `${g.adminBlock ? 'The game runs as administrator, so Windows' : 'Windows'} won’t let the app share the game window. It can share the screen the game is on instead: every picture is cut to the game window’s area before anything reads or keeps it, and taken only while the game is the window in front. You can turn this off in the tray menu.`, button('Share the screen', 'screen-yes', true), button('No', 'screen-no'));
    if (wontShare && state.shell.screenShare === false && g.adminBlock) return line('warn', 'The game runs as administrator, so Windows won’t let the app share its window. Allow sharing the game’s screen in the tray menu, or start the app with right-click → Run as administrator.');
    if (wontShare && state.shell.screenShare === false) return line('warn', 'Windows won’t let the app share the game window. Allow sharing the game’s screen in the tray menu, cut to the game window, to get pictures.');
    if (f.window !== 'on') return line('busy', 'Sharing the game window…');
    // The game's own Enable Log is off: its log has none of the lines the
    // triggers look for, so no pictures come (js/capture.js tells).
    if (f.detail === 'off') return line('warn', `The game isn’t logging its moves, so no pictures come. ${ENABLE_LOG}`, button('How', 'enable-log'));
    // The game writes to its log all the time: one that stopped growing
    // isn't the one it's writing, and no pictures come.
    const grew = f.diag && f.diag.growingAt;
    if (grew && Date.now() - grew > 120000) return line('warn', `The game log hasn’t changed for ${Math.round((Date.now() - grew) / 60000)} minutes. Turn on Enable Log in the game (press Esc, under Account Related), then log out and back in. If it’s on, choose the game’s UE_game.log.`, button('Choose it', 'pick-log'), button('Debug report', 'debug-report'));
    return null;
  }

  // The folded bar's one line: the advice, or what's in its way.
  function oneLine() {
    const a = state.advice;
    const f = state.follow;
    const sh = state.shell;
    if (sh.offline) return 'Can’t reach the site';
    if (sh.agreed === false) return 'Agree on Auto Screenshot Mode first';
    if (!state.game.log) return 'Game log not found';
    if (!state.game.running) return 'Waiting for the game';
    if (sh.riot) return 'Riot: fight on';
    if (sh.runOver) return 'Run over: ready for the next';
    if (f && f.window !== 'on' && state.game.adminBlock && sh.screenShare !== true) return sh.screenShare === null ? 'Share the game’s screen? Unfold to answer' : 'Allow the screen share in the tray';
    if (f && (f.log !== 'on' || f.window !== 'on')) return 'Connecting…';
    if (f && f.detail === 'off') return 'Turn on Enable Log in the game';
    if (a && a.reading) return 'Reading the picture…';
    if (a && a.treasureWait) return 'Treasure: press View Prison Status';
    if (a && a.toolsConfirm) return sh.siteUpdate ? 'Confirm instruments, or Reload for the update' : 'Confirm your instruments';
    if (a && a.problems && a.problems.length) return 'The board needs a fix';
    if (a && a.working) return `Working it out${a.progress !== null && a.progress !== undefined ? `: ${a.progress}%` : '…'}`;
    if (a && a.stale) return 'Board changed: recheck';
    if (a && a.move) return `${a.move}${a.flagged ? ` (${a.flagged} to check)` : ''}`;
    return 'Waiting for the next move';
  }

  function render() {
    const a = state.advice;
    const f = state.follow;
    const sh = state.shell;
    document.body.classList.toggle('is-collapsed', !!sh.collapsed);
    $('fold').textContent = sh.collapsed ? '+' : '–';
    $('fold').title = sh.collapsed ? 'Unfold it' : 'Fold it to a thin bar';
    $('day').textContent = sh.collapsed ? oneLine()
      : a && a.riot !== null && a.riot !== undefined ? `${a.riot} ${a.riot === 1 ? 'day' : 'days'} until Riot${a.step ? ` · ${a.step}` : ''}` : sh.local ? 'local site' : '';

    const out = [];
    if (sh.appUpdate) out.push(line('info', `App update ${sh.appUpdate} is ready.`, button('Restart', 'restart')));
    // An update waiting while the old pages keep asking: it often fixes that.
    if (sh.siteUpdate) out.push(line(a && a.toolsConfirm ? 'warn' : 'info', a && a.toolsConfirm ? 'The site was updated, and the update may stop questions like the one below. It loads by itself when this run ends.' : 'The site was updated. It loads by itself when this run ends.', button('Reload now', 'reload', !!(a && a.toolsConfirm))));
    const problem = followProblem();
    if (problem) out.push(problem);

    if (a && a.reading) out.push(line('busy', `Reading the ${a.reading.kind === 'board' || a.reading.kind === 'manual' ? 'picture' : a.reading.kind}…`));
    const failed = a && a.lastRead && !a.lastRead.ok && !a.reading && Date.now() - a.lastRead.at < 120000;
    if (failed) out.push(line('bad', `Couldn’t read the last picture: ${a.lastRead.reason || 'no board in it'}.`, button('Try again', 'capture')));
    else if (f && f.lastFrame && !f.lastFrame.ok && Date.now() - f.lastFrame.at < 60000) out.push(line('warn', `No picture taken: ${f.lastFrame.why || 'the game window isn’t shared'}`));

    if (a && a.toolsConfirm) out.push(line('warn', a.toolsConfirm, button('These are right', 'tools-ok'), button('Board', 'board')));
    // A game client not in English: a screen the reader didn't recognize.
    if (a && a.langMiss && Date.now() - a.langMiss.at < 120000) out.push(line('warn', a.langMiss.what === 'board' ? `Your game is in ${a.langMiss.lang}: check today's doors, and set the Replace and Consume decisions by hand on the board analyzer, and send it this board's screenshot once, to help it learn your language.` : `The ${a.langMiss.what} wasn't read (your game is in ${a.langMiss.lang}). Set it on the board analyzer, and send the screenshot from there.`, button('Board', 'board')));
    // The Warden's Treasure covers the board: the gift waits for a look at it.
    if (a && a.treasureWait) out.push(line('warn', 'The Warden’s Treasure is open. Press View Prison Status in the game, wait a second on the board, then go back to the Treasure: the gift advice uses that board.', button('Advise anyway', 'treasure-now')));
    if (a && a.problems && a.problems.length) {
      out.push(line('warn', `The board needs a fix: ${a.problems[0]}`, button('Fix', 'fix', true)));
    } else if (a && a.has && a.working) {
      out.push(line('busy', `Working out the best move${a.progress !== null && a.progress !== undefined ? `: ${a.progress}%` : '…'}`));
      if (a.flagged) out.push(line('warn', `${a.flagged} ${a.flagged === 1 ? 'cell' : 'cells'} to check against your game.`, button('Fix', 'fix')));
    } else if (a && a.has && a.stale) {
      out.push(line('warn', 'The board changed since the last advice.', button('Recheck', 'recheck', true)));
    } else if (a && a.has && a.move) {
      const advice = h('div', null,
        h('p', { class: 'eyebrow' }, 'Recommended'),
        h('p', { class: 'move' }, a.move),
        a.why ? h('p', { class: 'why' }, a.why) : null,
        h('p', { class: 'meta' }, [
          a.expect.replace(/^Expected: /, '').replace(/ Rainbows in the vault by the end of day (\d+)\.?$/, ' Rainbows expected by day $1').replace(/\.$/, ''),
          a.status.replace(/^Live check: /, '').replace(/ playouts per option$/, ' playouts each'),
        ].filter(Boolean).join(' · ')),
        a.chain ? h('p', { class: 'alt' }, a.chain) : null,
        a.close && a.options[1] ? h('p', { class: 'alt' }, `About as good: ${a.options.find((o) => !o.best) ? a.options.find((o) => !o.best).label : a.options[1].label}`) : null,
      );
      out.push(advice);
      if (a.flagged) out.push(line('warn', `${a.flagged} ${a.flagged === 1 ? 'cell' : 'cells'} to check against your game.`, button('Fix', 'fix'), button('Recheck', 'recheck')));
    } else if (a && a.has && a.nothing) {
      out.push(line('info', 'Nothing to decide on this screen.', button('Picture', 'capture')));
    } else if (!problem && !(a && a.treasureWait)) {
      out.push(sh.runOver
        ? line('info', 'Run over. Its record is saved (tray menu: Review the record). Ready for the next run.')
        : line('info', 'Advice comes with the next move. Or take a picture now.', button('Picture', 'capture')));
    }

    $('body').replaceChildren(...out);
    const dot = (el, on, what) => {
      el.className = `dot ${on === true ? 'is-on' : on === false ? 'is-off' : ''}`;
      el.title = what;
    };
    // Green once the log has brought a game event; yellow while it's
    // followed but none has come yet (or the game's Enable Log is off).
    const quiet = !!f && f.log === 'on' && (!(f.hits > 0) || f.detail === 'off');
    dot($('dot-log'), f ? (f.log === 'on' ? (quiet ? null : true) : f.log === 'off' || f.log === 'error' ? false : null) : false,
      quiet ? `Following the log, but no game events yet. ${ENABLE_LOG}`
        : f && f.log === 'on' ? `Following ${f.file || 'the log'}: ${(f.lines || 0).toLocaleString()} new lines, ${f.hits || 0} triggers${f.diag && f.diag.lastTriggerAt ? `, the last ${ago(f.diag.lastTriggerAt)}` : ''}` : 'The game log isn’t followed');
    dot($('dot-win'), f ? (f.window === 'on' ? true : state.game.running ? null : false) : false, f && f.window === 'on' ? `Sharing the game window${f.lastFrame ? `, last picture ${ago(f.lastFrame.at)}` : ''}` : 'The game window isn’t shared');
    $('report-menu').hidden = !state.menu;
    $('report-reading').hidden = !(a && a.canReportReading);
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'report') {
      state.menu = !state.menu;
      render();
      return;
    }
    if (b.id === 'fold') return O.command('collapse');
    if (b.dataset.cmd) {
      state.menu = false;
      O.command(b.dataset.cmd);
      render();
    }
  });

  // The window takes the card's height.
  new ResizeObserver(() => O.size($('card').getBoundingClientRect().height)).observe($('card'));

  O.onShell((s) => {
    state.shell = s || {};
    render();
  });
  O.onGame((g) => {
    state.game = g || {};
    render();
  });
  O.onFollow((f) => {
    state.follow = f;
    render();
  });
  O.onAdvice((a) => {
    state.advice = a;
    render();
  });
  setInterval(render, 5000); // "s ago", and old notes going away
  render();
})();

/* Tartarus Overlay: the review window. Steps through a recorded session:
 * each picture the analyzer got, what the reader made of it, the board it
 * loaded, the advice with every move it weighed, and the player's fixes,
 * in order. Everything comes from the record on this PC (main.js). */
(function () {
  'use strict';

  const R = window.Record;
  const $ = (id) => document.getElementById(id);
  const TIERS = ['Normal', 'Magic', 'Rare', 'Legendary', 'Ultimate'];
  const BEASTS = { mammoth: 'Mammoth', lion: 'Lion', wolf: 'Wolf', rat: 'Rat' };
  const KINDS = { board: 'Board', manual: 'Picture (pressed)', instruments: 'Instrument pick', objective: 'Objective', treasure: 'Warden’s Treasure', event: 'Event' };
  const COMMANDS = { capture: 'Took a picture', fix: 'Pressed Fix', recheck: 'Pressed Recheck', 'tools-ok': 'Confirmed the instruments', report: 'Reported a wrong reading', 'report-new': 'Reported something new', board: 'Opened the board', collapse: 'Folded or unfolded the overlay', lock: 'Locked or unlocked the overlay' };
  let data = null; // { name, base, entries }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false && kid !== '') el.append(kid);
    return el;
  }
  const L = (n) => String(n + 1).padStart(2, '0');
  const time = (at) => new Date(at).toLocaleTimeString();
  const tierName = (t) => TIERS[Math.max(0, Math.min(4, Number(t) || 0))];

  // ---------- The board ----------

  function cellText(c) {
    if (!c) return '?';
    switch (c.kind) {
      case 'office': return 'Office';
      case 'inmate': return `${tierName(c.tier)} ${BEASTS[c.beast] || c.beast}${c.ivory ? ' + Tusk' : ''}${c.prey ? ` (prey mark: ${L(c.prey.cell)}, ${c.prey.rounds} left)` : ''}`;
      case 'sealed': return c.event ? `Sealed, event${c.event !== 'unknown' ? ` (${c.event})` : ''}` : 'Sealed';
      case 'empty': return 'Empty';
      case 'scratch': return `Scratched (${tierName(c.tier)})`;
      case 'revealed': return `Rarity shown (${tierName(c.tier)})`;
      case 'scouted': return `Scouted ${tierName(c.tier)} ${BEASTS[c.beast] || c.beast}`;
      case 'nest': return `Rat nest (hatches day ${c.due})`;
      default: return c.kind;
    }
  }

  // Where cell n sits on the 6×4 block: 01–06 along the top, 07–08 down
  // the right, 09–14 back along the bottom, 15–16 up the left.
  function place(n) {
    if (n <= 5) return [1, n + 1];
    if (n <= 7) return [n - 4, 6];
    if (n <= 13) return [4, 6 - (n - 8)];
    return [n === 14 ? 3 : 2, 1];
  }

  function flagsOf(b) {
    return [
      b.swapUsed && 'Replace used today',
      b.devourUsed && 'Consume used today',
      b.noSwap && 'no Replace card',
      b.noDevour && 'no Consume card',
      b.consumeOffered && 'Consume offered after the swap',
      b.chainArmed && 'chain reaction armed',
      b.toolsToConfirm && 'instruments to confirm',
    ].filter(Boolean);
  }

  function boardView(b, names, changed) {
    const cells = (b.cells || []).map((c, n) => {
      const [row, col] = place(n);
      const cls = ['cell', b.warden === n && 'is-warden', (b.dest || []).includes(n) && 'is-door', changed && changed.has(n) && 'is-changed'].filter(Boolean).join(' ');
      const tags = [b.warden === n && 'warden', (b.dest || []).includes(n) && 'door', c.ivory && 'Tusk', c.prey && 'prey', c.event && 'event'].filter(Boolean);
      const tier = c.kind === 'inmate' || c.kind === 'scouted' || c.kind === 'revealed' || c.kind === 'scratch' ? `t${Math.min(4, c.tier || 0)}` : '';
      const what = c.kind === 'inmate' || c.kind === 'scouted' ? `${tierName(c.tier)} ${BEASTS[c.beast] || c.beast}` : cellText(c);
      return h('div', { class: cls, style: `grid-row:${row};grid-column:${col}` }, h('span', { class: 'n' }, L(n)), h('span', { class: `what ${tier}` }, what), tags.map((t) => h('span', { class: 'tag' }, t)));
    });
    const tools = names && names.tools && names.tools.length ? names.tools.join(', ') : (b.tools || []).join(', ') || 'none';
    const court = h('div', { class: 'court', style: 'grid-row:2/4;grid-column:2/6' },
      h('p', null, h('b', null, `Day ${b.day} of ${b.maxDays}`), ` · step: ${b.step}`),
      h('p', null, `Instruments: ${tools}`),
      h('p', null, `Chromatic prisoners: ${(b.vault || []).length} · objective: ${b.objective}${b.milestone ? ' (completed)' : ''}`),
      b.step === 'choice' && b.choice ? h('p', null, `On offer (${b.choice.kind}): ${(names && names.choice && names.choice.length ? names.choice : b.choice.options || []).join(', ') || 'none'}${b.choice.rerolls ? `, ${b.choice.rerolls} re-roll left` : ''}`) : null,
      flagsOf(b).length ? h('p', { class: 'warn' }, flagsOf(b).join(' · ')) : null,
    );
    return h('div', { class: 'board' }, cells, court);
  }

  // What changed between two boards, in words, and which cells.
  function diff(a, b) {
    const lines = [];
    const cells = new Set();
    if (!a || !b) return { lines, cells };
    (b.cells || []).forEach((c, n) => {
      const was = cellText(a.cells && a.cells[n]);
      const now = cellText(c);
      if (was !== now) {
        lines.push(`Cell ${L(n)}: ${was} → ${now}`);
        cells.add(n);
      }
    });
    if (a.warden !== b.warden) lines.push(`Warden: cell ${L(a.warden)} → ${L(b.warden)}`);
    const doors = (x) => (x.dest || []).map(L).join(', ') || 'none';
    if (doors(a) !== doors(b)) lines.push(`Doors: ${doors(a)} → ${doors(b)}`);
    if (a.day !== b.day || a.maxDays !== b.maxDays) lines.push(`Day: ${a.day} of ${a.maxDays} → ${b.day} of ${b.maxDays}`);
    if (a.step !== b.step) lines.push(`Step: ${a.step} → ${b.step}`);
    if ((a.tools || []).join() !== (b.tools || []).join()) lines.push(`Instruments: ${(a.tools || []).join(', ') || 'none'} → ${(b.tools || []).join(', ') || 'none'}`);
    if ((a.vault || []).length !== (b.vault || []).length) lines.push(`Chromatic prisoners: ${(a.vault || []).length} → ${(b.vault || []).length}`);
    if (flagsOf(a).join() !== flagsOf(b).join()) lines.push(`Today: ${flagsOf(a).join(', ') || 'nothing used'} → ${flagsOf(b).join(', ') || 'nothing used'}`);
    if (a.objective !== b.objective || a.milestone !== b.milestone) lines.push(`Objective: ${a.objective}${a.milestone ? ' (done)' : ''} → ${b.objective}${b.milestone ? ' (done)' : ''}`);
    return { lines, cells };
  }

  // ---------- Steps ----------

  // A step starts with each picture; what follows it belongs to it.
  function stepsOf(entries) {
    const steps = [];
    let cur = null;
    for (const e of entries) {
      if (e.type === 'session') continue;
      if (e.type === 'picture' || !cur) {
        cur = { picture: e.type === 'picture' ? e : null, items: [] };
        steps.push(cur);
        if (e.type === 'picture') continue;
      }
      cur.items.push(e);
    }
    return steps;
  }

  function render() {
    const main = $('steps');
    main.replaceChildren();
    if (!data || !data.entries.length) {
      main.append(h('p', { class: 'empty' }, 'Nothing recorded in this session yet. Pictures, readings and advice show here as Auto Screenshot Mode takes them.'));
      $('count').textContent = '';
      return;
    }
    const showBoards = $('show-boards').checked;
    const showOther = $('show-other').checked;
    const onlyFixes = $('only-fixes').checked;
    const steps = stepsOf(data.entries);
    let prev = null; // the board before, for what changed
    let shown = 0;
    steps.forEach((s, i) => {
      const fixed = s.items.some((e) => e.type === 'edit' || (e.type === 'command' && ['fix', 'recheck', 'tools-ok', 'report'].includes(e.cmd)));
      const items = [];
      let boardShown = null;
      for (const e of s.items) {
        if (e.type === 'read') {
          items.push(h('div', { class: 'item is-bad' }, h('h3', null, `Not read · ${time(e.at)}`), h('p', { class: 'bad' }, e.reason || 'No board found in this picture.'), e.summary && e.summary.length ? h('ul', { class: 'summary' }, e.summary.map((t) => h('li', null, t))) : null));
        } else if (e.type === 'loaded') {
          const r = e.read || {};
          const what = r.pick ? `Instrument offer: ${(r.names || []).join(', ')}` : r.objective ? `Objective: ${r.name}` : r.treasure ? 'Warden’s Treasure' : `Day ${r.day}`;
          const d = diff(prev, e.board);
          items.push(h('div', { class: 'item' },
            h('h3', null, `Read · ${time(e.at)}`),
            h('p', null, `${what}${r.unsure ? `, ${r.unsure} marked Check` : ''}`),
            e.summary && e.summary.length ? h('ul', { class: 'summary' }, e.summary.map((t) => h('li', null, t))) : null,
            showBoards && e.board ? boardView(e.board, e.names, d.cells) : null,
          ));
          if (e.board) {
            prev = e.board;
            boardShown = JSON.stringify(e.board);
          }
        } else if (e.type === 'advice') {
          const a = e.advice || {};
          const same = e.board && JSON.stringify(e.board) === boardShown;
          const d = same ? { lines: [], cells: new Set() } : diff(prev, e.board);
          items.push(h('div', { class: `item ${a.problems && a.problems.length ? 'is-bad' : 'is-advice'}` },
            h('h3', null, `${a.problems && a.problems.length ? 'Board problem' : a.treasureWait ? 'Warden’s Treasure: waiting for the board' : a.toolsConfirm && !a.move ? 'Instruments to confirm' : 'Advice'} · ${time(e.at)}${a.riot !== null && a.riot !== undefined ? ` · ${a.riot} days until Riot` : ''}${a.step ? ` · ${a.step}` : ''}`),
            a.move ? h('p', { class: 'move' }, a.move) : null,
            a.why ? h('p', null, a.why) : null,
            a.expect || a.status ? h('p', { class: 'meta' }, [a.expect, a.status].filter(Boolean).join(' · ')) : null,
            a.chain ? h('p', null, a.chain) : null,
            (a.problems || []).map((p) => h('p', { class: 'bad' }, p)),
            a.toolsConfirm ? h('p', { class: 'warn' }, a.toolsConfirm) : null,
            a.treasureWait ? h('p', { class: 'warn' }, 'No gift advice until the board behind the Treasure is seen (View Prison Status).') : null,
            a.flagged ? h('p', { class: 'warn' }, `${a.flagged} cells marked Check.`) : null,
            a.options && a.options.length > 1 ? h('table', { class: 'options' }, a.options.map((o) => h('tr', { class: o.best ? 'is-best' : '' }, h('td', null, `${o.best ? '✓ ' : ''}${o.label}`), h('td', null, o.value)))) : null,
            a.close ? h('p', { class: 'meta' }, 'The top moves were within the margin of error.') : null,
            !same && d.lines.length ? h('ul', { class: 'diff' }, d.lines.map((t) => h('li', null, t))) : null,
            showBoards && e.board && !same ? boardView(e.board, e.names, d.cells) : null,
          ));
          if (e.board) {
            prev = e.board;
            boardShown = JSON.stringify(e.board);
          }
        } else if (e.type === 'edit') {
          const d = diff(prev, e.board);
          items.push(h('div', { class: 'item is-edit' },
            h('h3', null, `Changed on the board · ${time(e.at)}`),
            d.lines.length ? h('ul', { class: 'diff' }, d.lines.map((t) => h('li', null, t))) : h('p', { class: 'meta' }, 'No visible change.'),
            showBoards && e.board ? boardView(e.board, e.names, d.cells) : null,
          ));
          if (e.board) {
            prev = e.board;
            boardShown = JSON.stringify(e.board);
          }
        } else if (showOther) {
          const label = e.type === 'command' ? COMMANDS[e.cmd] || `Pressed ${e.cmd}` : e.type === 'game' ? 'The game started' : e.type === 'game-closed' ? 'The game closed' : e.type === 'riot' ? 'The Riot: the fight began (overlay folded)' : e.type === 'riot-over' ? 'Back in the prison' : e.type === 'run-over' ? 'The run is over (Ignore on the Riot screen)' : e.type;
          items.push(h('p', { class: 'other' }, `${time(e.at)} · ${label}`));
        }
      }
      if (onlyFixes && !fixed) return;
      if (!items.length && !s.picture) return;
      shown += 1;
      const p = s.picture;
      const shot = p && p.file ? h('div', { class: 'shot' }, h('img', { src: data.base + p.file, alt: `The picture at ${time(p.at)}`, loading: 'lazy' })) : h('div', { class: 'shot' }, h('div', { class: 'noshot' }, p ? 'No picture with this one.' : 'Before the first picture.'));
      const card = h('section', { class: 'step', id: `step-${i + 1}` },
        h('div', { class: 'step-head' }, h('b', null, `#${i + 1}`), p ? `${time(p.at)} · ${KINDS[p.kind] || p.kind}${p.fresh ? ' (start of a run)' : ''}` : '', fixed ? h('span', { class: 'warn' }, 'fixed by hand') : null),
        shot,
        h('div', { class: 'items' }, items),
      );
      main.append(card);
    });
    $('count').textContent = `${shown} of ${steps.length} steps · ${data.entries.filter((e) => e.type === 'picture').length} pictures`;
  }

  // A picture opens full width, and back.
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.shot img');
    if (img) img.closest('.step').classList.toggle('is-open');
  });

  async function loadSessions(keep) {
    const list = await R.sessions();
    const sel = $('session');
    const was = keep ? sel.value : '';
    sel.replaceChildren(...list.map((s) => h('option', { value: s.name }, `${s.name.replace('T', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')} UTC · ${s.pictures} pictures, ${s.advice} advice, ${s.edits} fixes`)));
    if (!list.length) {
      data = null;
      render();
      return;
    }
    sel.value = list.some((s) => s.name === was) ? was : list[0].name;
    await open(sel.value);
  }

  async function open(name) {
    data = await R.load(name);
    render();
  }

  $('session').addEventListener('change', (e) => open(e.target.value));
  $('reload').addEventListener('click', () => loadSessions(true));
  $('folder').addEventListener('click', () => R.openFolder());
  for (const id of ['show-boards', 'show-other', 'only-fixes']) $(id).addEventListener('change', render);
  loadSessions(false);
})();

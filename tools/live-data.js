#!/usr/bin/env node
/* Tartarus Simulator: live data.
 * The board analyzer shares the boards players ask about, in runs of two or
 * more in a row (js/live.js), with the collector in worker/. This tool pulls
 * them into beta/data/ and measures the odds they show, next to the values
 * the simulator uses, so the simulator can be tuned to match live.
 *
 *   node tools/live-data.js pull     new boards from the collector, then rates
 *   node tools/live-data.js rates    recompute beta/data/rates.json
 *   node tools/live-data.js reports  download new reports of things the
 *                                    simulator doesn't know yet (local only)
 *   node tools/live-data.js reports --watch [--every 60]
 *                                    keep checking, and print a NEW REPORT
 *                                    line for each one as it arrives
 *
 * pull needs the collector's address and export token, from LIVE_DATA_URL and
 * LIVE_DATA_TOKEN (or --url and --token). The repo's scheduled workflow,
 * .github/workflows/live-data.yml, runs it with the token from its secrets.
 * rates counts only what players saw in their game: anything the simulator's
 * dice or the screenshot reader filled in counts once the player changed or
 * confirmed it. --all counts those too. */
'use strict';

const fs = require('fs');
const path = require('path');
const T = require('../js/engine.js');

const args = process.argv.slice(2);
const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'rates';
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const ALL = args.includes('--all');

const ROOT = path.join(__dirname, '..');
const DIR = flag('dir') ? path.resolve(flag('dir')) : path.join(ROOT, 'beta', 'data');
const RAW = path.join(DIR, 'raw');
const STATE = path.join(DIR, 'state.json');
const RATES = path.join(DIR, 'rates.json');
// Rows a request asks for. 2000 a page made the collector answer HTTP 503
// (a Cloudflare limit) from 2026-10-16 on; a page that fails so is halved,
// down to MIN_PAGE, before the pull gives up.
const PAGE = 200;
const MIN_PAGE = 25;
const FEW = 30; // below this many, a rate is shown but not judged

// ---------- Pulling ----------

async function pull() {
  const url = (flag('url') || process.env.LIVE_DATA_URL || '').replace(/\/+$/, '');
  const token = flag('token') || process.env.LIVE_DATA_TOKEN || '';
  if (!url || !token) throw new Error('Set LIVE_DATA_URL and LIVE_DATA_TOKEN (or pass --url and --token).');
  fs.mkdirSync(RAW, { recursive: true });
  const state = readJson(STATE, { last: 0 });
  let total = 0;
  let page = PAGE;
  for (;;) {
    const res = await fetch(`${url}/v1/export?after=${state.last}&limit=${page}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status >= 500 && page > MIN_PAGE) {
      page = Math.max(MIN_PAGE, Math.floor(page / 2));
      console.log(`The collector's export answered HTTP ${res.status}: trying ${page} a page.`);
      continue;
    }
    if (!res.ok) throw new Error(`The collector's export failed: HTTP ${res.status}.`);
    const { rows, last } = await res.json();
    if (!rows.length) break;
    const byDay = new Map();
    for (const row of rows) {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(row.received) ? row.received : 'unknown';
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(JSON.stringify(row));
    }
    for (const [day, lines] of byDay) fs.appendFileSync(path.join(RAW, `${day}.jsonl`), `${lines.join('\n')}\n`);
    state.last = last;
    total += rows.length;
    writeJson(STATE, state);
    if (rows.length < page) break;
  }
  console.log(total ? `Pulled ${total} new ${total === 1 ? 'board' : 'boards'}.` : 'No new boards.');
  // The boards are kept whatever happens next: a failing measure doesn't
  // stop them being committed.
  try {
    if (total || !fs.existsSync(RATES)) rates();
  } catch (e) {
    console.log(`The rates weren't measured this time: ${e.message}`);
  }
}

// ---------- Reports ----------
// Reports of an event, instrument or gift the simulator doesn't know yet
// (js/report.js) stay in the collector's database, out of this public repo:
// they're free text and screenshots from anyone. This downloads the new ones,
// screenshots included, into trainingdata/reports/ (gitignored), through
// wrangler with your own Cloudflare login, so no export token is needed.

const REPORTS = path.join(ROOT, 'trainingdata', 'reports');
const IMAGE_EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

// Runs one query on a live database. The SQL must not contain double quotes.
function d1(sql, database) {
  const { execSync } = require('child_process');
  if (sql.includes('"')) throw new Error('No double quotes in the SQL.');
  const out = execSync(`npx --yes wrangler d1 execute ${database || 'tartarus-live'} --remote --json --command "${sql}"`, {
    cwd: path.join(ROOT, 'worker'),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0].results || [];
}

const slug = (text) => (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'unnamed';

function reports(opts) {
  const o = opts || {};
  fs.mkdirSync(REPORTS, { recursive: true });
  const statePath = path.join(REPORTS, 'state.json');
  const state = readJson(statePath, { last: 0 });
  const fresh = [];
  for (;;) {
    const rows = d1(`SELECT id, received, kind, name, body, image_type, image_size FROM reports WHERE id > ${Number(state.last) || 0} ORDER BY id LIMIT 200`);
    if (!rows.length) break;
    // Screenshots a few at a time: hex doubles their size on the way.
    const shots = rows.filter((r) => r.image_size);
    for (let i = 0; i < shots.length; i += 8) {
      const ids = shots.slice(i, i + 8).map((r) => Number(r.id)).join(',');
      for (const img of d1(`SELECT id, hex(image) AS hex FROM reports WHERE id IN (${ids})`)) {
        const row = rows.find((r) => r.id === img.id);
        row.file = `${String(row.id).padStart(5, '0')}-${row.kind}-${slug(row.name)}.${IMAGE_EXT[row.image_type] || 'bin'}`;
        fs.writeFileSync(path.join(REPORTS, row.file), Buffer.from(img.hex, 'hex'));
      }
    }
    const lines = rows.map(({ body, ...row }) => JSON.stringify(Object.assign(row, JSON.parse(body))));
    fs.appendFileSync(path.join(REPORTS, 'reports.jsonl'), `${lines.join('\n')}\n`);
    fresh.push(...rows);
    state.last = rows[rows.length - 1].id;
    writeJson(statePath, state);
    if (rows.length < 200) break;
  }
  if (!fresh.length) {
    if (!o.quiet) console.log('No new reports.');
    return fresh;
  }
  // One line per report, for a watcher (or a person) to act on.
  for (const r of fresh) {
    const b = JSON.parse(r.body);
    const parts = [`NEW REPORT #${r.id} ${r.kind}: ${r.name || '(no name)'}`];
    if (b.text) parts.push(`says: ${b.text.replace(/\s+/g, ' ').slice(0, 300)}`);
    if (b.outcome) parts.push(`happened: ${b.outcome.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (r.file) parts.push(`screenshot: ${path.relative(ROOT, path.join(REPORTS, r.file))}`);
    console.log(parts.join(' | '));
  }
  // What was reported, most reports first.
  const byName = new Map();
  for (const r of fresh) {
    const key = `${r.kind}: ${r.name || '(no name)'}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }
  console.log(`${fresh.length} new ${fresh.length === 1 ? 'report' : 'reports'} in ${path.relative(ROOT, REPORTS)}:`);
  for (const [key, list] of [...byName].sort((a, b) => b[1].length - a[1].length)) {
    const text = JSON.parse(list[list.length - 1].body).text;
    const files = list.filter((r) => r.file).length;
    console.log(`  ${key} (${list.length}${files ? `, ${files} screenshot${files === 1 ? '' : 's'}` : ''})${text ? `: ${text.slice(0, 100)}` : ''}`);
  }
  return fresh;
}

// Checks for new reports every --every seconds (60 by default) until
// stopped. A failed check (the network, or an expired login) is reported and
// the next one tries again.
async function watchReports() {
  const every = Math.max(20, Number(flag('every')) || 60);
  console.log(`Watching for new reports every ${every} s. Ctrl+C to stop.`);
  for (;;) {
    try {
      reports({ quiet: true });
    } catch (e) {
      console.log(`Check failed, trying again in ${every} s: ${String((e && e.message) || e).split('\n')[0]}`);
    }
    await new Promise((resolve) => setTimeout(resolve, every * 1000));
  }
}

// ---------- Reading ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function loadRows() {
  if (!fs.existsSync(RAW)) return [];
  const seen = new Set();
  const rows = [];
  for (const file of fs.readdirSync(RAW).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(RAW, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (seen.has(row.uid)) continue;
      seen.add(row.uid);
      rows.push(row);
    }
  }
  return rows;
}

// The game's tutorial run is scripted, so its boards say nothing about the
// odds (the user: never train on it or measure odds with it). Two of its
// boards are known: its first, with the warden in the office, a Normal Rat
// in 05, a Magic Lion in 08, a Rare Mammoth in 13 and one door, 03; and a
// morning with the warden in 05 and doors 06, 08 and 14 (report 34). A run
// with either is left out whole.
function tutorialBoard(B) {
  if (!B || B.step !== 'patrol') return false;
  const at = (n, beast, tier) => !!B.cells && !!B.cells[n] && B.cells[n].kind === 'inmate' && B.cells[n].beast === beast && B.cells[n].tier === tier;
  const dest = (B.dest || []).slice().sort((a, b) => a - b).join();
  if (B.warden === 4 && dest === '5,7,13') return true;
  return B.warden === 0 && dest === '2' && at(4, 'rat', 0) && at(7, 'lion', 1) && at(12, 'mammoth', 2);
}

// Consecutive boards of the same run: each pair is one confirmed step of a
// live game, from the board before to the board after.
function pairsOf(rows) {
  const runs = new Map();
  for (const row of rows) {
    const key = `${row.client}:${row.run}`;
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key).push(row);
  }
  const pairs = [];
  const firsts = [];
  let tutorials = 0;
  for (const list of runs.values()) {
    if (list.some((row) => tutorialBoard(row.board))) {
      tutorials += 1;
      continue;
    }
    list.sort((a, b) => a.seq - b.seq);
    if (list[0].seq === 0) firsts.push(list[0]);
    for (let i = 1; i < list.length; i++) if (list[i].seq === list[i - 1].seq + 1) pairs.push([list[i - 1], list[i]]);
  }
  return { runs: runs.size - tutorials, tutorials, pairs, firsts };
}

// ---------- Observations ----------

const N = T.CELL_COUNT;
const mod = (n) => ((n % N) + N) % N;
const steps = (from, to) => mod(to - from);
const closed = (c) => c.kind === 'sealed' || c.kind === 'nest';

// What now stands in a cell that was just opened or refilled: its inmate, or
// a Rainbow that went straight to the vault.
function arrival(A, B, n) {
  const c = B.cells[n];
  if (c.kind === 'inmate') return { tier: c.tier, beast: c.beast };
  if ((c.kind === 'empty' || c.kind === 'sealed') && B.vault.length === A.vault.length + 1) return { tier: T.RAINBOW, beast: B.vault[B.vault.length - 1] };
  return null;
}

function observe(pairs) {
  const obs = { doors: [], sides: [], scratch: [], swaps: [], keys: [], events: [], eventless: 0, mornings: [], devours: [], offers: [], unchecked: 0 };
  for (const [a, b] of pairs) {
    const A = a.board;
    const B = b.board;
    const via = b.via;
    // Whether part of B is what the player's game showed. Without --all, what
    // the dice or the reader filled in counts only once the player changed it
    // or confirmed it.
    const seen = (key) => {
      const ok = ALL || !via || !via.filled.includes(key) || via.touched.includes(key);
      if (!ok) obs.unchecked += 1;
      return ok;
    };
    const has = (id) => A.tools.includes(id);
    const sameDay = B.day === A.day;

    // A patrol: the warden walked to one of the doors and nothing else happened.
    if (A.step === 'patrol' && sameDay && !A.chainArmed && A.dest.includes(B.warden) && B.warden !== A.warden && !B.devourUsed && !B.swapUsed && ['manage', 'event', 'choice'].includes(B.step)) {
      const n = B.warden;
      const door = A.cells[n];
      if (closed(door) || door.kind === 'scratch') {
        const got = arrival(A, B, n);
        if (got && seen(`c${n}`)) {
          const ctx = { day: A.day, tools: A.tools.slice(), chain: A.chain };
          if (door.kind === 'scratch') obs.scratch.push(Object.assign({ shown: door.tier }, got, ctx));
          else obs.doors.push(Object.assign({ event: door.event || null }, got, ctx));
        }
        // The Lost Key Ring can open the doors on both sides.
        const sides = [mod(n - 1), mod(n + 1)].filter((x) => x !== T.OFFICE && closed(A.cells[x]));
        if (sides.length && sides.every((x) => seen(`c${x}`))) {
          const opened = sides.filter((x) => B.cells[x].kind === 'inmate');
          obs.keys.push({ keys: has('keys'), opened: opened.length > 0 });
          for (const x of opened) obs.sides.push(Object.assign({ keys: has('keys') }, arrival(A, B, x)));
        }
        if (B.step === 'event' && seen('event')) obs.events.push({ kind: B.eventKind, marked: door.event || null });
        else if (B.step === 'manage' && door.event && door.event !== 'unknown') obs.eventless += 1;
      }
    }

    // A swap of the warden's inmate, and nothing else.
    const w = A.warden;
    if (sameDay && A.step === 'manage' && ['manage', 'choice'].includes(B.step) && B.warden === w && !A.swapUsed && B.swapUsed && A.devourUsed === B.devourUsed) {
      const old = A.cells[w];
      const got = arrival(A, B, w);
      if (old.kind === 'inmate' && !old.ivory && got && seen(`c${w}`)) obs.swaps.push(Object.assign({ oldTier: old.tier, rope: has('rope'), stake: has('stake'), maiden: has('maiden'), scapegoat: has('scapegoat') }, got));
    }

    // A devour from the warden's cell, and nothing else.
    if (sameDay && A.step === 'manage' && B.warden === w && !A.devourUsed && B.devourUsed && A.swapUsed === B.swapUsed && A.cells[w].kind === 'inmate') {
      const eaten = A.cells.map((c, n) => n).filter((n) => n !== w && (A.cells[n].kind === 'inmate' || A.cells[n].kind === 'scratch') && B.cells[n].kind !== A.cells[n].kind);
      const got = arrival(A, B, w);
      if (got && eaten.length && [w, ...eaten].every((n) => seen(`c${n}`))) {
        const eater = A.cells[w];
        obs.devours.push({ bites: eaten.length, from: eater.tier, to: got.tier, beastChanged: got.tier < T.RAINBOW && got.beast !== eater.beast, tools: A.tools.slice() });
      }
    }

    // A new morning: the doors on offer.
    if (B.day === A.day + 1 && B.step === 'patrol' && B.warden === A.warden && B.dest.length && seen('dest')) {
      const offsets = B.dest.map((d) => steps(B.warden, d)).sort((x, y) => x - y);
      const office = steps(B.warden, T.OFFICE);
      obs.mornings.push({ count: B.dest.length, offsets, officeInReach: office >= 1 && office <= 5, fire: B.tools.includes('fire') });
    }

    // A tool on offer.
    if (B.step === 'choice' && B.choice.kind === 'tool' && A.step !== 'choice' && B.choice.options.length && seen('choice')) obs.offers.push({ options: B.choice.options.slice(), held: B.tools.slice() });
  }
  return obs;
}

// ---------- Statistics ----------

// 95% Wilson interval for k successes in n.
function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// Upper tail of the chi-square distribution: the chance of a fit this bad or
// worse if the simulator's odds were right.
function chiTail(x, df) {
  const a = df / 2;
  const y = x / 2;
  if (y <= 0) return 1;
  const lnGamma = (z) => {
    const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let s = 1.000000000190015;
    for (let j = 0; j < 6; j++) s += g[j] / (z + j + 1);
    const t = z + 5.5;
    return Math.log((2.5066282746310005 * s) / z) - t + (z + 0.5) * Math.log(t);
  };
  if (y < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= y / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-12) break;
    }
    return Math.max(0, 1 - sum * Math.exp(-y + a * Math.log(y) - lnGamma(a)));
  }
  let b = y + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return Math.min(1, Math.exp(-y + a * Math.log(y) - lnGamma(a)) * h);
}

// Counts of each outcome next to the simulator's odds for it.
function distribution(values, names, weights) {
  const n = values.length;
  const total = weights.reduce((s, w) => s + w, 0);
  const counts = names.map((_, i) => values.filter((v) => v === i).length);
  const rows = names.map((name, i) => {
    const sim = i < weights.length ? weights[i] / total : 0;
    const [lo, hi] = wilson(counts[i], n);
    return { name, count: counts[i], share: n ? counts[i] / n : null, low: lo, high: hi, sim, fits: n < FEW ? null : sim >= lo && sim <= hi };
  });
  // Chi-square over the outcomes the simulator allows. An outcome it never
  // rolls showing up at all means it's wrong.
  let p = null;
  if (n >= FEW) {
    const impossible = rows.some((r) => r.sim === 0 && r.count > 0);
    const live = rows.filter((r) => r.sim > 0);
    const x = live.reduce((s, r) => s + (r.count - n * r.sim) ** 2 / (n * r.sim), 0);
    p = impossible ? 0 : chiTail(x, live.length - 1);
  }
  return { n, rows, p, verdict: n < FEW ? 'too few yet' : p < 0.01 ? 'differs from the simulator' : 'fits the simulator' };
}

// A share of k in n, next to the simulator's value when it has a fixed one.
function rate(k, n, sim) {
  const [lo, hi] = wilson(k, n);
  let verdict = n < FEW ? 'too few yet' : 'measured';
  if (n >= FEW && sim != null) verdict = sim >= lo && sim <= hi ? 'fits the simulator' : 'differs from the simulator';
  return { n, count: k, share: n ? k / n : null, low: lo, high: hi, sim, verdict };
}

// ---------- Rates ----------

function rates() {
  const out = measure(loadRows());
  writeJson(RATES, out);
  print(out);
  return out;
}

// Every rate the boards show, next to the simulator's values.
function measure(rows) {
  const { runs, tutorials, pairs, firsts } = pairsOf(rows);
  const obs = observe(pairs);
  const P = T.DEFAULT_PARAMS;
  const TIERS = T.TIERS;
  const BEASTS = T.BEASTS;
  const tiers = (list) => distribution(list.map((o) => o.tier), TIERS, P.tierWeights);
  const beasts = (list) => distribution(list.filter((o) => o.tier < T.RAINBOW).map((o) => BEASTS.indexOf(o.beast)), BEASTS.map(T.beastName), P.beastWeights);

  // Day 1: how many runs' first boards show an event behind a door.
  let firstBoards = 0;
  let withEvent = 0;
  for (const row of firsts) {
    const B = row.board;
    if (B.day !== 1 || B.step !== 'patrol') continue;
    firstBoards += 1;
    if (B.cells.some((c) => (c.kind === 'sealed' || c.kind === 'scratch') && c.event)) withEvent += 1;
  }

  // Without the instruments that change who comes in: Hangman's Noose, the
  // Burning Stake (from below Legendary), the Severed Iron Maiden (+3) and
  // the Scapegoat's Guillotine (above the old rarity).
  const plainSwaps = obs.swaps.filter((s) => !s.rope && !s.maiden && !s.scapegoat && !(s.stake && s.oldTier < 3));
  // Doors without the instruments that change what's behind them: the
  // Sorting Hook (never a Normal) and the Felon's Dog Tag (25% +1 tier).
  const plainDoors = obs.doors.filter((d) => !d.tools.includes('hook') && !d.tools.includes('dogtag'));
  const mornings = obs.mornings.filter((m) => !m.fire);
  const offsets = {};
  for (const m of obs.mornings) for (const o of m.offsets) offsets[o] = (offsets[o] || 0) + 1;
  const reachMornings = obs.mornings.filter((m) => m.officeInReach);
  const toolCounts = {};
  for (const o of obs.offers) for (const id of o.options) toolCounts[id] = (toolCounts[id] || 0) + 1;
  const keyed = obs.keys.filter((k) => k.keys);
  const unkeyed = obs.keys.filter((k) => !k.keys);
  const mean = (list, f) => (list.length ? list.reduce((s, x) => s + f(x), 0) / list.length : null);

  const out = {
    about: 'Live odds measured from boards shared by the board analyzer, next to the values the simulator uses (js/engine.js DEFAULT_PARAMS). Made by tools/live-data.js.',
    counted: ALL ? 'everything, including dice and reader guesses nobody confirmed' : 'only what players set or confirmed against their game',
    boards: rows.length,
    runs,
    tutorialRuns: tutorials,
    steps: pairs.length,
    latest: rows.reduce((m, r) => (r.received > m ? r.received : m), ''),
    leftOut: obs.unchecked,
    doors: {
      about: "What a patrol finds behind a sealed door (and nests), without the Sorting Hook or the Felon's Dog Tag. Simulator: tierWeights and beastWeights.",
      tiers: tiers(plainDoors),
      beasts: beasts(plainDoors),
      withTools: obs.doors.length - plainDoors.length,
    },
    swaps: {
      about: "Who comes in when the warden's inmate is swapped, without Hangman's Rope or a Burning Stake roll. The simulator uses the same odds as doors.",
      tiers: tiers(plainSwaps),
      beasts: beasts(obs.swaps),
    },
    sideDoors: {
      about: 'Doors opened beside a patrol by the Lost Key Ring.',
      tiers: tiers(obs.sides.filter((s) => s.keys)),
      keyRing: rate(keyed.filter((k) => k.opened).length, keyed.length, 0.8),
      withoutKeyRing: { n: unkeyed.length, opened: unkeyed.filter((k) => k.opened).length, about: 'Side doors that opened without the Lost Key Ring. The simulator says this never happens.' },
    },
    scratchedDoors: {
      about: 'A scratched door shows its rarity. Simulator: the inmate has that rarity, and its beast follows beastWeights.',
      n: obs.scratch.length,
      rarityAsShown: rate(obs.scratch.filter((s) => s.tier === s.shown).length, obs.scratch.length, 1),
      beasts: beasts(obs.scratch),
    },
    events: {
      about: 'Special events behind doors. Simulator: one behind a random locked door at the start of eventStartChance % of runs, then more at random (eventMorningChance, eventWalkChance, eventActionChance), each seen at once.',
      dayOneBoardsWithEvents: rate(withEvent, firstBoards, P.eventStartChance / 100),
      chainReactions: rate(obs.events.filter((e) => e.kind === 'chain').length, obs.events.length, 0.5),
      unmarkedDoorsWithEvents: obs.events.filter((e) => !e.marked).length,
      markedDoorsWithoutEvents: obs.eventless,
    },
    mornings: {
      about: "The doors on offer each morning. Simulator: 3 of the 5 cells ahead (2 with the Burning Stake), and fewerDoorsChance for a morning with one fewer.",
      n: obs.mornings.length,
      doorCounts: obs.mornings.reduce((m, x) => Object.assign(m, { [x.count]: (m[x.count] || 0) + 1 }), {}),
      fewerDoors: rate(mornings.filter((m) => m.count < P.destinations).length, mornings.length, P.fewerDoorsChance / 100),
      stepsAhead: offsets,
      officeInReach: {
        about: 'Mornings where the office is within 5 steps. If the office counts as a step, no door is ever more than 5 steps ahead; if it is skipped, the 6th step can be offered.',
        n: reachMornings.length,
        withADoorSixAhead: reachMornings.filter((m) => m.offsets.includes(6)).length,
      },
    },
    devours: {
      about: "Devours started from the warden's cell. In the simulator each bite is +1 tier plus tool bonuses, and the eater re-rolls its beast after every bite.",
      n: obs.devours.length,
      meanBites: mean(obs.devours, (d) => d.bites),
      meanExtraTiers: mean(obs.devours, (d) => d.to - d.from - d.bites),
      beastChanged: rate(obs.devours.filter((d) => d.beastChanged).length, obs.devours.filter((d) => d.to < T.RAINBOW).length, null),
    },
    toolOffers: { about: 'How often each tool is offered.', n: obs.offers.length, counts: toolCounts },
  };
  return out;
}

// ---------- Printing ----------

function pct(x) {
  return x == null ? '   –  ' : `${(100 * x).toFixed(1).padStart(5)}%`;
}

function printDistribution(title, d) {
  console.log(`\n${title}: ${d.n} seen, ${d.verdict}${d.p != null ? ` (p = ${d.p < 0.0001 ? '<0.0001' : d.p.toFixed(4)})` : ''}`);
  for (const r of d.rows) {
    if (!r.count && !r.sim) continue;
    const mark = r.fits === false ? '  <- outside the range' : '';
    console.log(`  ${r.name.padEnd(10)} ${String(r.count).padStart(6)}  live ${pct(r.share)}  (${pct(r.low)} to ${pct(r.high)})  sim ${pct(r.sim)}${mark}`);
  }
}

function printRate(title, r) {
  console.log(`\n${title}: ${r.count} of ${r.n}, live ${pct(r.share)} (${pct(r.low)} to ${pct(r.high)})${r.sim != null ? `, sim ${pct(r.sim)}` : ''}: ${r.verdict}`);
}

function print(o) {
  console.log(`Live data: ${o.boards} boards in ${o.runs} runs, ${o.steps} confirmed steps (latest ${o.latest || 'none'}). Counting ${o.counted}; ${o.leftOut} unconfirmed guesses left out${o.tutorialRuns ? `, and ${o.tutorialRuns} tutorial runs` : ''}.`);
  printDistribution('Door rarities', o.doors.tiers);
  printDistribution('Door beasts', o.doors.beasts);
  printDistribution('Swap rarities', o.swaps.tiers);
  printDistribution('Swap beasts', o.swaps.beasts);
  printDistribution('Key Ring side-door rarities', o.sideDoors.tiers);
  printRate('Key Ring opens the side doors', o.sideDoors.keyRing);
  if (o.sideDoors.withoutKeyRing.opened) console.log(`  Note: ${o.sideDoors.withoutKeyRing.opened} side doors opened without the Key Ring.`);
  printRate('Scratched doors hold the rarity shown', o.scratchedDoors.rarityAsShown);
  printRate('Day 1 first boards with an event', o.events.dayOneBoardsWithEvents);
  printRate('Events that are Chain reactions', o.events.chainReactions);
  if (o.events.unmarkedDoorsWithEvents) console.log(`  Note: ${o.events.unmarkedDoorsWithEvents} events came from doors not marked with one.`);
  printRate('Mornings with fewer doors', o.mornings.fewerDoors);
  console.log(`  Doors on offer by steps ahead: ${Object.entries(o.mornings.stepsAhead).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none yet'}`);
  console.log(`  Office within reach: ${o.mornings.officeInReach.n} mornings, ${o.mornings.officeInReach.withADoorSixAhead} with a door 6 steps ahead.`);
  console.log(`\nDevours: ${o.devours.n}${o.devours.n ? `, ${o.devours.meanBites.toFixed(2)} bites on average, ${o.devours.meanExtraTiers.toFixed(2)} extra tiers` : ''}`);
  if (o.devours.beastChanged.n) printRate('Eaters that changed beast', o.devours.beastChanged);
  console.log(`Tool offers: ${o.toolOffers.n}`);
}

// ---------- Main ----------

module.exports = { measure, observe, pairsOf, print };
if (require.main === module) (async () => {
  if (mode === 'pull') await pull();
  else if (mode === 'rates') rates();
  else if (mode === 'reports') {
    if (args.includes('--watch')) await watchReports();
    else reports();
  }
  else {
    console.error('Usage: node tools/live-data.js pull | rates [--all] | reports [--watch] [--every 60]');
    process.exit(2);
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

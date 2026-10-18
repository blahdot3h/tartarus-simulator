#!/usr/bin/env node
/* Tartarus Simulator: strategy lab.
 * Plays huge numbers of simulated drills with the rules-based strategy in
 * js/solver.js (no AI) to compare strategies, tune the strategy's weights,
 * rank tools and gifts, and measure devour chains. Games run in parallel on
 * every CPU core. Game i always uses seed "<seed>-i", so each strategy faces
 * the same prisons and the comparisons are fair.
 *
 *   node tools/strategy-sim.js tune   [--games 40000] [--rounds 3] [--rewards off|on]
 *   node tools/strategy-sim.js eval   [--games 1000000] [--rewards off|on] [--params file.json] [--only solver]
 *   node tools/strategy-sim.js tools  [--games 200000]
 *   node tools/strategy-sim.js gifts  [--games 200000]
 *   node tools/strategy-sim.js chains [--games 200000]
 *   node tools/strategy-sim.js report [--games 1000000]   (everything, written to tools/results)
 *   node tools/strategy-sim.js train  [--games 150000] [--final 1000000]   (fine-tunes every profile the solver uses)
 *   node tools/strategy-sim.js guide  [--games 2000000] [--no-tune]   (the data behind strategy.html)
 *
 *   Options: --threads N (default: cores - 1), --seed WORD, --params file.json
 */
'use strict';

const { Worker, isMainThread, parentPort } = require('worker_threads');
const os = require('os');
const fs = require('fs');
const path = require('path');
const T = require('../js/engine.js');
const S = require('../js/solver.js');

// ---------- Playing games (runs inside workers) ----------

function emptyStats() {
  return {
    games: 0, rainbows: 0, rainbowsSq: 0, dist: [0, 0, 0, 0, 0, 0],
    devours: 0, bites: 0, stops: 0, chainHist: [0, 0, 0, 0, 0, 0, 0],
    fromChain: 0, fromDevour: 0, fromOther: 0, bestTier: [0, 0, 0, 0, 0, 0],
    swaps: 0, executions: 0, opened: 0, firstDay: 0, firstCount: 0,
    stairs: {}, crashes: 0, crash: null,
  };
}

function merge(a, b) {
  for (const k of Object.keys(b)) {
    if (k === 'crash') {
      if (!a.crash) a.crash = b.crash;
    } else if (k === 'stairs') {
      for (const [key, v] of Object.entries(b.stairs)) {
        const t = a.stairs[key] || (a.stairs[key] = { n: 0, rainbow: 0, bites: 0 });
        t.n += v.n;
        t.rainbow += v.rainbow;
        t.bites += v.bites;
      }
    } else if (Array.isArray(b[k])) b[k].forEach((v, i) => (a[k][i] = (a[k][i] || 0) + v));
    else a[k] += b[k];
  }
  return a;
}

// A chain's next meal, at random: the baselines never stop a chain.
function mealPick(st, random) {
  const meals = T.chainOptions(st);
  return meals.length ? { type: 'chain', to: meals[Math.floor(random() * meals.length)].cell } : { type: 'stopchain' };
}

// Simple strategies to compare against.
const BASELINES = {
  // Random legal moves: any destination, any target, swap half the time.
  random(st, random) {
    if (st.pending.length) return { type: 'choose', id: st.pending[0].options[Math.floor(random() * st.pending[0].options.length)] };
    if (st.chaining) return mealPick(st, random);
    if (st.phase === 'event') return { type: 'event', accept: random() < 0.5 };
    if (st.phase === 'patrol') return { type: 'patrol', cell: st.destinations[Math.floor(random() * st.destinations.length)] };
    const options = T.startOptions(st);
    if (options.length && random() < 0.7) return { type: 'devour', to: options[Math.floor(random() * options.length)].cell };
    const here = st.cells[st.position];
    if (T.canSwapNow(st) && here.inmate && !here.sealed && random() < 0.3) return { type: 'swap' };
    return { type: 'end' };
  },
  // A sensible player without the math: devour whenever possible, else swap
  // Normals, walk to an inmate that can eat, otherwise open a door.
  simple(st, random) {
    if (st.pending.length) return { type: 'choose', id: st.pending[0].options[0] };
    if (st.chaining) return mealPick(st, random);
    if (st.phase === 'event') return { type: 'event', accept: true };
    if (st.phase === 'patrol') {
      const hungry = st.destinations.find((n) => !st.cells[n].sealed && st.cells[n].inmate && T.devourOptions(st, n).length);
      const door = st.destinations.find((n) => st.cells[n].sealed && !st.cells[n].nest);
      return { type: 'patrol', cell: hungry !== undefined ? hungry : door !== undefined ? door : st.destinations[0] };
    }
    const options = T.startOptions(st);
    if (options.length) return { type: 'devour', to: options[Math.floor(random() * options.length)].cell };
    const here = st.cells[st.position];
    if (T.canSwapNow(st) && here.inmate && !here.sealed && here.inmate.tier === 0) return { type: 'swap' };
    return { type: 'end' };
  },
};

function newDrill(game, i, seedWord) {
  // Rewards on plays like the live game: a random tool to start, one for the
  // objective and a gift per Rainbow. No tools means none at all.
  const params = { rewards: !!game.rewards, startTools: game.rewards && !game.tool && !game.tools ? 1 : 0 };
  const st = T.newGame({ mode: 'drill', scenario: game.scenario || 'empty', seed: `${seedWord}-${i}`, params });
  // Tools held from day 1: one (game.tool) or a set (game.tools).
  if (game.tool) st.tools = [game.tool];
  if (game.tools) st.tools = game.tools.slice();
  // The Forged Key takes a door off today's offer too.
  if (st.tools.includes('forged')) st.destinations = st.destinations.slice(0, Math.max(1, st.params.destinations - 1));
  return st;
}

// The tiers above the eater, as "how many beasts could still eat there".
function stairKey(st, eaterCell) {
  const eater = st.cells[eaterCell].inmate;
  const { comp } = S.composition(st, eaterCell);
  const chain = T.FOOD_CHAIN;
  const eats = T.BEASTS.map((b) => chain[b].map((x) => T.BEASTS.indexOf(x)));
  let key = `${eater.tier}:`;
  for (let t = eater.tier + 1; t < T.RAINBOW; t++) {
    let fed = 0;
    for (let b = 0; b < 4; b++) if (eats[b].some((f) => comp[t * 4 + f] > 0)) fed += 1;
    key += fed;
  }
  return key;
}

function playGames(job) {
  const stats = emptyStats();
  for (let i = job.from; i < job.to; i++) {
    const st = newDrill(job.game, i, job.seed);
    const random = S.rng32(i * 2654435761 + 7);
    const decide = job.policy === 'solver' ? (s) => S.decide(s, job.params, random) : (s) => BASELINES[job.policy](s, random);
    let firstDay = 0;
    // Today's consume, counted when its chain ends: each bite waits for a
    // pick (or the game's Cancel).
    let consume = null;
    // A game that throws is left out and reported (the first one in full),
    // so one bad state can't end a long run.
    try {
      for (let guard = 0; st.phase !== 'ended' && guard < 2000; guard++) {
        const action = decide(st);
        const vaultBefore = st.vault.length;
        if (action.type === 'devour') consume = { vault: vaultBefore, key: job.stairs ? stairKey(st, st.position) : null };
        const result = S.apply(st, action);
        if (!result.ok) {
          if (!S.apply(st, { type: 'end' }).ok) break;
          continue;
        }
        const gained = st.vault.length - vaultBefore;
        const eating = action.type === 'devour' || action.type === 'chain' || action.type === 'stopchain';
        if (eating && consume && !st.chaining) {
          let bites = 1;
          for (let k = st.log.length - 1; k >= 0; k--) {
            const x = st.log[k].x;
            if (x && x.type === 'devour') {
              bites = x.bites.length;
              break;
            }
          }
          const won = st.vault.length - consume.vault;
          stats.devours += 1;
          stats.bites += bites;
          stats.chainHist[Math.min(6, bites)] += 1;
          if (won) stats[bites > 1 ? 'fromChain' : 'fromDevour'] += won;
          if (consume.key) {
            const t = stats.stairs[consume.key] || (stats.stairs[consume.key] = { n: 0, rainbow: 0, bites: 0 });
            t.n += 1;
            t.bites += bites;
            if (won) t.rainbow += 1;
          }
          if (action.type === 'stopchain') stats.stops += 1;
          consume = null;
        } else if (gained && !eating) stats.fromOther += gained;
        if (gained && !firstDay) firstDay = st.day;
      }
    } catch (e) {
      stats.crashes += 1;
      if (!stats.crash) stats.crash = `game ${job.seed}-${i}, tools [${st.tools.join(',')}], day ${st.day}, phase ${st.phase}: ${String(e && e.stack).split('\n').slice(0, 8).join(' | ')}`;
      continue;
    }
    const r = st.vault.length;
    stats.games += 1;
    stats.rainbows += r;
    stats.rainbowsSq += r * r;
    stats.dist[Math.min(5, r)] += 1;
    const best = Math.max(st.stats.best, r ? T.RAINBOW : 0);
    stats.bestTier[best] += 1;
    stats.swaps += st.stats.swaps;
    stats.executions += st.stats.executions;
    stats.opened += st.stats.opened;
    if (firstDay) {
      stats.firstDay += firstDay;
      stats.firstCount += 1;
    }
  }
  return stats;
}

if (!isMainThread) {
  parentPort.on('message', ({ id, job }) => parentPort.postMessage({ id, stats: playGames(job) }));
  return;
}

// ---------- Running jobs on every core ----------

const args = process.argv.slice(2);
const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'eval';
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const THREADS = Number(opt('threads', Math.max(1, os.cpus().length - 1)));
const SEED = String(opt('seed', 'LAB'));
const RESULTS = path.join(__dirname, 'results');

const pool = [];
const waiting = new Map();
let nextId = 1;
let GAMES_PLAYED = 0;
for (let i = 0; i < THREADS; i++) {
  const w = new Worker(__filename);
  w.on('message', ({ id, stats }) => {
    waiting.get(id)(stats);
    waiting.delete(id);
  });
  w.on('error', (e) => {
    console.error(e);
    process.exit(1);
  });
  pool.push({ w, busy: false, queue: [] });
}

// Splits `games` games into chunks across the pool; resolves merged stats.
// extra.from starts at a later game number, to add runs to a measurement.
function run(policy, params, game, games, extra) {
  const chunks = Math.max(THREADS, Math.ceil(games / 2500));
  const size = Math.ceil(games / chunks);
  const first = (extra && extra.from) || 0;
  const jobs = [];
  for (let from = first; from < first + games; from += size) {
    jobs.push({ policy, params, game, from, to: Math.min(first + games, from + size), seed: (extra && extra.seed) || SEED, stairs: !!(extra && extra.stairs) });
  }
  let next = 0;
  const total = emptyStats();
  return new Promise((resolveRun) => {
    let active = 0;
    let finished = false;
    const resolve = (stats) => {
      if (finished) return;
      finished = true;
      GAMES_PLAYED += stats.games;
      if (stats.crashes) console.log(`WARNING: ${stats.crashes} game(s) threw and were left out. The first: ${stats.crash}`);
      resolveRun(stats);
    };
    const launch = (worker) => {
      if (next >= jobs.length) {
        if (!active) resolve(total);
        return;
      }
      const job = jobs[next++];
      const id = nextId++;
      active += 1;
      waiting.set(id, (stats) => {
        merge(total, stats);
        active -= 1;
        launch(worker);
        if (next >= jobs.length && !active) resolve(total);
      });
      worker.w.postMessage({ id, job });
    };
    pool.forEach(launch);
  });
}

// The measure a strategy is tuned on: Rainbows per drill.
const mean = (s) => s.rainbows / s.games;
const se = (s) => Math.sqrt(Math.max(0, s.rainbowsSq / s.games - mean(s) ** 2) / s.games);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const fmt = (s) => `${mean(s).toFixed(4)} ± ${(1.96 * se(s)).toFixed(4)} Rainbows/run`;

function describe(s) {
  return {
    games: s.games,
    rainbowsPerRun: +mean(s).toFixed(4),
    ci95: +(1.96 * se(s)).toFixed(4),
    runsWithRainbow: +(1 - s.dist[0] / s.games).toFixed(4),
    rainbowCounts: s.dist.map((n) => +(n / s.games).toFixed(4)),
    devoursPerRun: +(s.devours / s.games).toFixed(2),
    bitesPerDevour: +(s.bites / Math.max(1, s.devours)).toFixed(3),
    chainStopsPerRun: +((s.stops || 0) / Math.max(1, s.games)).toFixed(3),
    chainLengths: s.chainHist.slice(1).map((n) => +(n / Math.max(1, s.devours)).toFixed(4)),
    rainbowSources: { chain: s.fromChain, singleDevour: s.fromDevour, other: s.fromOther },
    firstRainbowDay: s.firstCount ? +(s.firstDay / s.firstCount).toFixed(2) : null,
    swapsPerRun: +(s.swaps / s.games).toFixed(2),
    executionsPerRun: +(s.executions / s.games).toFixed(3),
    doorsPerRun: +(s.opened / s.games).toFixed(2),
  };
}

function loadParams() {
  const file = opt('params', null);
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// ---------- Tuning ----------

const GRID = {
  tierBase: [2.25, 2.5, 2.75, 3, 3.5],
  rainbowMult: [0.5, 1, 2, 4, 8],
  wOpen: [0, 0.5, 1, 1.5, 2, 3],
  wNow: [0, 0.5, 1, 1.5, 2, 3],
  wWalk: [0.5, 1, 1.5, 2, 3],
  wStep: [-1, 0, 0.3, 1, 2, 3, 5],
  wChain: [0, 4, 8, 16, 32],
  wStair: [0, 0.25, 0.5, 1, 2],
  swapMaxTier: [-1, 0, 1, 2],
  minDevour: [-1e9, -2, 0, 2, 5],
  execMargin: [-1e9, -5, 0, 5, 20, 1e9],
  acceptChain: [true, false],
};

async function tune(game, games, rounds, start, grid) {
  let best = Object.assign({}, S.DEFAULTS, start || {});
  let bestStats = await run('solver', best, game, games);
  console.log(`start: ${fmt(bestStats)}`);
  for (let round = 1; round <= rounds; round++) {
    let changed = false;
    // A grid can be a function of the weights, re-centered every round.
    for (const [key, values] of Object.entries(typeof grid === 'function' ? grid(best) : grid || GRID)) {
      const tried = [];
      for (const value of values) {
        if (value === best[key]) {
          tried.push([value, bestStats]);
          continue;
        }
        const stats = await run('solver', Object.assign({}, best, { [key]: value }), game, games);
        tried.push([value, stats]);
      }
      tried.sort((a, b) => mean(b[1]) - mean(a[1]));
      const [value, stats] = tried[0];
      const line = tried.map(([v, s]) => `${v}: ${mean(s).toFixed(4)}`).join('  ');
      if (value !== best[key] && mean(stats) > mean(bestStats)) {
        best = Object.assign({}, best, { [key]: value });
        bestStats = stats;
        changed = true;
        console.log(`round ${round} ${key} -> ${value}   (${line})`);
      } else console.log(`round ${round} ${key} stays ${best[key]}   (${line})`);
    }
    console.log(`after round ${round}: ${fmt(bestStats)}`);
    if (!changed) break;
  }
  return { params: best, stats: bestStats };
}

// A finer grid around a set of weights, for training on top of a tuning.
function fineGrid(p) {
  const scale = (v, factors) => [...new Set(factors.map((f) => +(v * f).toFixed(3)))];
  return {
    tierBase: [p.tierBase - 0.25, p.tierBase, p.tierBase + 0.25],
    rainbowMult: scale(p.rainbowMult, [0.75, 1, 1.5]),
    wOpen: scale(p.wOpen, [0.75, 1, 1.25]),
    wNow: scale(p.wNow, [0.75, 1, 1.25]),
    wWalk: scale(p.wWalk, [0.75, 1, 1.25]),
    wStep: [p.wStep - 0.5, p.wStep, p.wStep + 0.5, p.wStep + 1],
    wChain: scale(p.wChain, [0.5, 1, 1.5]),
    wStair: scale(p.wStair, [0.5, 1, 1.5]),
    swapMaxTier: [p.swapMaxTier - 1, p.swapMaxTier, p.swapMaxTier + 1].filter((v) => v >= -1 && v <= 4),
    minDevour: [-1, 0, 1],
    execMargin: [-5, 0, 5, 10],
    acceptChain: [true, false],
    wInstigate: scale(p.wInstigate, [0.5, 1, 2]),
    wCrow: scale(p.wCrow, [0.5, 1, 2]),
  };
}

async function train(games) {
  const t0 = Date.now();
  const finalGames = Number(opt('final', 1000000));
  // --only rewards or notools trains one of them.
  const only = opt('only', 'all');
  const variants = [
    { name: 'rewards', profile: 'rewards', game: { rewards: true }, games, rounds: 2 },
    { name: 'notools', profile: 'notools', game: { rewards: false }, games, rounds: 2 },
  ].filter((v) => only === 'all' || only === v.name);
  const out = { when: new Date().toISOString(), threads: THREADS, gamesPerTest: games, finalGames, variants: {} };
  for (const v of variants) {
    console.log(`
== ${v.name}: fine-tune on ${v.games.toLocaleString()} runs per test ==`);
    const start = Object.assign({}, S.DEFAULTS, S.PROFILES[v.profile]);
    const tuned = await tune(v.game, v.games, v.rounds, start, fineGrid);
    save(`tuned-${v.name}.json`, tuned.params);
    const before = await run('solver', start, v.game, finalGames, { seed: 'FINAL' });
    const after = await run('solver', tuned.params, v.game, finalGames, { seed: 'FINAL' });
    out.variants[v.name] = { params: tuned.params, before: describe(before), after: describe(after) };
    console.log(`${v.name} on fresh prisons: before ${fmt(before)}, after ${fmt(after)}`);
  }
  out.totalGames = GAMES_PLAYED;
  out.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  save('train-report.json', out);
  console.log(`
trained on ${GAMES_PLAYED.toLocaleString()} simulated runs in ${(out.seconds / 60).toFixed(1)} minutes; saved tools/results/train-report.json`);
}

// ---------- Instrument sets ----------

// Every set of up to `--max` instruments (4 by default) held from day 1,
// with no other rewards, on the same prisons (seed COMBO: game i of every
// set is the same prison), so the sets compare fairly. Each set runs until
// its 95% margin is under `--margin` Rainbows per run (0.01 by default).
// Sets of 3 and 4 vary more, so they need more runs: they first get a coarse
// margin (`--coarse`, 0.03) so every set has a value early, and are then
// refined. Saves tools/results/tool-combos.json as it goes; stop it any time
// (`--minutes` stops it cleanly) and run it again to carry on. Writes
// js/tool-combos.js, which the strategy uses to pick instruments by what's
// already held.
async function combos() {
  const t0 = Date.now();
  const start = GAMES_PLAYED;
  const max = Number(opt('max', 4));
  const margin = Number(opt('margin', 0.01));
  const coarse = Number(opt('coarse', 0.03));
  const limit = Number(opt('minutes', 0)) * 60000 || Infinity;
  const PILOT = 4000;
  const params = Object.assign({}, S.DEFAULTS, S.PROFILES.notools);
  const game = { rewards: false };
  const ids = T.TOOL_IDS;
  const file = path.join(RESULTS, 'tool-combos.json');
  // Carry on from an earlier run if it played the same way. The instrument
  // rankings don't change how these runs play (no rewards), and a new
  // instrument only adds sets: the ones already measured still hold.
  let out = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const playing = (p) => JSON.stringify(Object.assign({}, p, { toolRank: null, giftRank: null }));
  // --keep carries on after a weight change that only matters for sets it
  // doesn't touch (re-measure the sets it does, by removing them first).
  if (out && (out.seed !== 'COMBO' || (playing(out.params) !== playing(params) && !opt('keep', false)) || !out.sets[''] || !out.ids.every((id) => ids.includes(id)))) {
    console.log('The saved sets were played with other weights or instruments: starting over.');
    out = null;
  }
  if (out && out.ids.length < ids.length) console.log(`New instruments since the last run: ${ids.filter((id) => !out.ids.includes(id)).join(', ')}.`);
  if (out) Object.assign(out, { ids, params });
  if (!out) out = { seed: 'COMBO', ids, params, sets: {} };
  out.margin = margin;
  const priorRuns = out.totalRuns || 0;
  const keyOf = (set) => set.slice().sort().join('|');
  const sets = [[]];
  const pick = (from, size, chosen) => {
    if (chosen.length === size) return sets.push(chosen.slice());
    for (let i = from; i < ids.length; i++) pick(i + 1, size, [...chosen, ids[i]]);
  };
  for (let k = 1; k <= max; k++) pick(0, k, []);
  for (const set of sets) if (!out.sets[keyOf(set)]) out.sets[keyOf(set)] = { n: 0, sum: 0, sq: 0 };
  const sd = (r) => Math.sqrt(Math.max(0, r.sq / r.n - (r.sum / r.n) ** 2));
  const ci = (r) => (r.n ? (1.96 * sd(r)) / Math.sqrt(r.n) : Infinity);
  const runsFor = (r, target) => (r.n < PILOT ? PILOT : Math.ceil(((1.96 * sd(r)) / target) ** 2));
  let saved = Date.now();
  const write = () => {
    for (const r of Object.values(out.sets)) if (r.n) Object.assign(r, { v: +(r.sum / r.n).toFixed(4), ci: +ci(r).toFixed(4) });
    out.generated = new Date().toISOString().slice(0, 10);
    out.totalRuns = priorRuns + GAMES_PLAYED - start;
    save(path.basename(file), out);
    saved = Date.now();
  };
  console.log(`\n== ${(sets.length - 1).toLocaleString()} instrument sets of up to ${max}, each to ±${margin} ==`);
  const stages = [
    { sizes: [0, 1, 2], target: margin },
    { sizes: [3, 4], target: coarse },
    { sizes: [3], target: margin },
    { sizes: [4], target: margin },
  ];
  let stopped = false;
  for (const stage of stages) {
    const group = sets.filter((s) => stage.sizes.includes(s.length));
    // Top up until every set in the stage meets its margin; the margin
    // needs an estimate of the set's spread, so it can take a few passes.
    for (let pass = 0; pass < 6 && !stopped; pass++) {
      // A set short of its margin gets at least 5% more runs (and 500), so
      // a set sitting right at the margin doesn't take many tiny passes.
      const more = (r) => {
        const need = runsFor(r, stage.target) - r.n;
        return need > 0 ? Math.min(Math.max(need, Math.ceil(0.05 * r.n), 500), 200000) : 0;
      };
      const todo = group.map((set) => ({ set, r: out.sets[keyOf(set)] })).map((x) => Object.assign(x, { add: more(x.r) })).filter((x) => x.add > 0);
      if (!todo.length) break;
      console.log(`sets of ${stage.sizes.join(' and ')} to ±${stage.target}, pass ${pass + 1}: ${todo.length} sets, ${todo.reduce((a, x) => a + x.add, 0).toLocaleString()} runs`);
      const BATCH = 8;
      for (let i = 0; i < todo.length; i += BATCH) {
        if (Date.now() - t0 > limit) {
          stopped = true;
          break;
        }
        const batch = todo.slice(i, i + BATCH);
        const results = await Promise.all(batch.map((x) => run('solver', params, Object.assign({}, game, { tools: x.set }), x.add, { seed: 'COMBO', from: x.r.n })));
        batch.forEach((x, j) => {
          x.r.n += results[j].games;
          x.r.sum += results[j].rainbows;
          x.r.sq += results[j].rainbowsSq;
        });
        if (Date.now() - saved > 60000) {
          write();
          console.log(`  ${Math.min(todo.length, i + BATCH)} / ${todo.length}, ${(GAMES_PLAYED - start).toLocaleString()} runs, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
        }
      }
    }
    if (stopped) break;
  }
  write();
  writeCombosJs();
  const bySize = {};
  for (const set of sets) {
    const r = out.sets[keyOf(set)];
    const b = bySize[set.length] || (bySize[set.length] = { sets: 0, runs: 0, worst: 0 });
    b.sets += 1;
    b.runs += r.n;
    b.worst = Math.max(b.worst, ci(r));
  }
  for (const [k, b] of Object.entries(bySize)) console.log(`${k} held: ${b.sets} sets, ${b.runs.toLocaleString()} runs, widest margin ±${b.worst.toFixed(4)}`);
  console.log(`\n${(GAMES_PLAYED - start).toLocaleString()} runs in ${((Date.now() - t0) / 60000).toFixed(1)} minutes${stopped ? ' (stopped at the time limit; run again to carry on)' : ''}; saved tools/results/${path.basename(file)} and js/tool-combos.js`);
}

// js/tool-combos.js: the measured sets, keyed by the instruments' letters
// (a for the first in TOOL_IDS) in order, values to 3 decimals. The data sits
// under `single`, the name the solver and the guide read it by.
function writeCombosJs() {
  const data = {};
  {
    const file = path.join(RESULTS, 'tool-combos.json');
    if (!fs.existsSync(file)) return;
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    const letter = (id) => String.fromCharCode(97 + c.ids.indexOf(id));
    const v = {};
    // Per number held: how many sets, their runs, and the widest margin.
    const sizes = {};
    for (const [key, r] of Object.entries(c.sets)) {
      if (!key || !r.n) continue;
      v[key.split('|').map(letter).sort().join('')] = +r.v.toFixed(3);
      const s = sizes[key.split('|').length] || (sizes[key.split('|').length] = { sets: 0, runs: 0, margin: 0 });
      s.sets += 1;
      s.runs += r.n;
      s.margin = +Math.max(s.margin, r.ci).toFixed(4);
    }
    if (!c.sets[''] || !c.sets[''].n) return;
    data.single = { generated: c.generated, ids: c.ids, base: +c.sets[''].v.toFixed(3), sizes, v };
  }
  fs.writeFileSync(path.join(__dirname, '..', 'js', 'tool-combos.js'), `/* Generated by tools/strategy-sim.js combos: Rainbows per run with each set of instruments held from day 1. Do not edit by hand. */\n(function (root) {\n  root.TARTARUS_COMBOS = ${JSON.stringify(data)};\n  if (typeof module === 'object' && module.exports) module.exports = root.TARTARUS_COMBOS;\n})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);\n`);
}

// ---------- Chain math (exact, no simulation) ----------

// The data behind strategy.html, for one food chain. Tunes the strategy for
// that chain (skip with --no-tune), ranks tools and gifts with it, then
// measures everything the guide shows. Writes tools/results/guide-data.json
// and js/guide-data.js for the page.
async function guide(games) {
  const t0 = Date.now();
  const start = GAMES_PLAYED;
  const notools = { rewards: false };
  const rewards = { rewards: true };
  const seed = 'GUIDE';
  const tuneGames = Number(opt('tune-games', 50000));
  const rounds = Number(opt('rounds', 2));
  const side = Number(opt('side', 500000));
  const habitGames = Number(opt('habit-games', 200000));
  let pNotools = Object.assign({}, S.DEFAULTS, S.PROFILES.notools);
  let pRewards = Object.assign({}, S.DEFAULTS, S.PROFILES.rewards);
  const out = { generated: new Date().toISOString().slice(0, 10), headlineRuns: games, seed };

  if (!opt('no-tune', false)) {
    console.log(`\n== tune with no tools (${tuneGames.toLocaleString()} runs per test) ==`);
    pNotools = (await tune(notools, tuneGames, rounds, pNotools)).params;
  }

  console.log('\n== tools, one held from day 1 ==');
  const base = await run('solver', pNotools, notools, side, { seed });
  out.toolBase = +mean(base).toFixed(4);
  out.tools = [];
  for (const tool of T.TOOL_IDS) {
    const stats = await run('solver', pNotools, Object.assign({}, notools, { tool }), side, { seed });
    out.tools.push({ id: tool, name: T.TOOLS[tool].name, value: +mean(stats).toFixed(4), delta: +(mean(stats) - mean(base)).toFixed(4) });
    console.log(`${T.TOOLS[tool].name.padEnd(18)} ${fmt(stats)}`);
  }
  out.tools.sort((a, b) => b.value - a.value);
  const toolRank = out.tools.map((t) => t.id);
  pNotools.toolRank = toolRank;
  pRewards.toolRank = toolRank;

  if (!opt('no-tune', false)) {
    console.log('\n== tune with rewards on ==');
    pRewards = (await tune(rewards, tuneGames, rounds, pRewards)).params;
    pRewards.toolRank = toolRank;
  }

  console.log('\n== Warden\'s Treasure ==');
  const scored = await run('solver', Object.assign({}, pRewards, { giftRank: null }), rewards, side, { seed });
  out.gifts = [{ id: 'scored', value: +mean(scored).toFixed(4) }];
  for (const id of T.GIFT_IDS) {
    const order = [id, ...T.GIFT_IDS.filter((g) => g !== id)];
    const stats = await run('solver', Object.assign({}, pRewards, { giftRank: order }), rewards, side, { seed });
    out.gifts.push({ id, name: T.GIFTS[id].name, value: +mean(stats).toFixed(4) });
    console.log(`always ${T.GIFTS[id].name.padEnd(18)} ${fmt(stats)}`);
  }
  const fixed = out.gifts.slice(1).sort((a, b) => b.value - a.value);
  pRewards.giftRank = fixed[0].value > out.gifts[0].value + 1.96 * se(scored) ? fixed.map((g) => g.id) : null;
  out.gifts = [out.gifts[0], ...fixed];

  console.log(`\n== headline: ${games.toLocaleString()} runs with rewards on ==`);
  const head = await run('solver', pRewards, rewards, games, { seed, stairs: true });
  out.headline = describe(head);
  console.log(fmt(head));
  // Chain odds by eater tier: the cases with at least 1 consume per 100 runs
  // (1,000 in 100,000), and at least 100.
  out.stairs = Object.entries(head.stairs)
    .filter(([, v]) => v.n >= Math.max(100, games / 100))
    .map(([k, v]) => ({ key: k, n: v.n, rainbow: +(v.rainbow / v.n).toFixed(4), bites: +(v.bites / v.n).toFixed(3) }))
    .sort((a, b) => b.n - a.n);

  console.log('\n== strategy comparison ==');
  const compareGames = Number(opt('compare', 1000000));
  out.compare = { notools: {}, rewards: {} };
  for (const policy of ['random', 'simple']) {
    out.compare.notools[policy] = describe(await run(policy, null, notools, compareGames, { seed }));
    out.compare.rewards[policy] = describe(await run(policy, null, rewards, compareGames, { seed }));
  }
  out.compare.notools.tuned = describe(await run('solver', pNotools, notools, compareGames, { seed }));
  out.compare.rewards.tuned = out.headline;
  for (const k of ['notools', 'rewards']) console.log(k, Object.entries(out.compare[k]).map(([p, d]) => `${p} ${d.rainbowsPerRun}`).join('  '));

  console.log('\n== habits, one changed at a time (no tools) ==');
  const variants = [
    ['full', 'The full strategy', {}],
    ['alwaysExec', 'Always accepting Executions', { execMargin: -1e9 }],
    ['neverExec', 'Never accepting Executions', { execMargin: 1e9 }],
    ['shortWalks', 'Preferring short walks', { wStep: -1 }],
    ['noSpread', 'Ignoring the beast spread', { wStair: 0 }],
    ['swapNormals', 'Replacing Normals only', { swapMaxTier: 0 }],
    ['swapRares', 'Replacing Rares too', { swapMaxTier: 2 }],
    ['wait2', 'Waiting for bigger chains (small threshold)', { minDevour: 2 }],
    ['wait5', 'Waiting for bigger chains (large threshold)', { minDevour: 5 }],
    pNotools.acceptChain ? ['skipChain', 'Skipping Chain reactions', { acceptChain: false }] : ['acceptChain', 'Accepting Chain reactions', { acceptChain: true }],
    ['alwaysBestow', 'Always choosing Bestow at the office', { office: 'bestow' }],
    ['alwaysInstigate', 'Always choosing Instigate at the office', { office: 'instigate' }],
    ['neverSwap', 'Never replacing', { swapMaxTier: -1 }],
  ];
  out.habits = [];
  for (const [id, label, change] of variants) {
    if (id === 'swapRares' && pNotools.swapMaxTier >= 2) continue;
    if (id === 'swapNormals' && pNotools.swapMaxTier === 0) continue;
    const stats = await run('solver', Object.assign({}, pNotools, change), notools, habitGames, { seed });
    out.habits.push({ id, label, value: +mean(stats).toFixed(4), ci: +(1.96 * se(stats)).toFixed(4) });
    console.log(`${label.padEnd(46)} ${fmt(stats)}`);
  }
  out.habits.push({ id: 'simple', label: 'A simple player', value: out.compare.notools.simple.rainbowsPerRun });
  out.habits.push({ id: 'random', label: 'Random moves', value: out.compare.notools.random.rainbowsPerRun });
  out.habitRuns = habitGames;
  out.sideRuns = side;
  out.compareRuns = compareGames;


  out.coverage = coverageTable().map((r) => ({ beasts: r.beasts, size: r.size, continues: r.continues }));
  out.params = { notools: pNotools, rewards: pRewards };
  out.totalRuns = GAMES_PLAYED - start;
  out.minutes = +((Date.now() - t0) / 60000).toFixed(1);
  save('guide-data.json', out);
  save('tuned-notools.json', pNotools);
  save('tuned-rewards.json', pRewards);
  // The page reads js/guide-data.js.
  {
    fs.writeFileSync(path.join(__dirname, '..', 'js', 'guide-data.js'), `/* Generated by tools/strategy-sim.js guide on ${out.generated}. Do not edit by hand. */\nwindow.TARTARUS_GUIDE = ${JSON.stringify(out)};\n`);
  }
  console.log(`\n${out.totalRuns.toLocaleString()} runs in ${out.minutes} minutes; saved tools/results/guide-data.json and js/guide-data.js`);
}

// Adds instruments to the guide's data without redoing the rest, e.g. one
// the live game just showed: each held from day 1 with no other rewards, on
// the guide's prisons and with its weights, as the full guide measures them.
//   node tools/strategy-sim.js guide-tools --tools dogtag [--threads 4]
async function guideTools() {
  const file = path.join(RESULTS, 'guide-data.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = String(opt('tools', '')).split(',').filter((id) => T.TOOLS[id]);
  if (!ids.length) throw new Error('Name the instruments with --tools id,id.');
  const params = (data.params && data.params.notools) || Object.assign({}, S.DEFAULTS, S.PROFILES.notools);
  const side = data.sideRuns || 100000;
  for (const tool of ids) {
    const stats = await run('solver', params, { rewards: false, tool }, side, { seed: data.seed || 'GUIDE' });
    data.tools = data.tools.filter((t) => t.id !== tool);
    data.tools.push({ id: tool, name: T.TOOLS[tool].name, value: +mean(stats).toFixed(4), delta: +(mean(stats) - data.toolBase).toFixed(4) });
    console.log(`${T.TOOLS[tool].name.padEnd(18)} ${fmt(stats)}`);
  }
  data.tools.sort((a, b) => b.value - a.value);
  data.toolsAdded = (data.toolsAdded || []).filter((id) => !ids.includes(id)).concat(ids);
  save('guide-data.json', data);
  fs.writeFileSync(path.join(__dirname, '..', 'js', 'guide-data.js'), `/* Generated by tools/strategy-sim.js guide on ${data.generated}, with ${data.toolsAdded.join(', ')} added by guide-tools. Do not edit by hand. */\nwindow.TARTARUS_GUIDE = ${JSON.stringify(data)};\n`);
  console.log(`saved tools/results/guide-data.json and js/guide-data.js`);
}

function coverageTable() {
  const chain = T.FOOD_CHAIN;
  const rows = [];
  for (let mask = 1; mask < 16; mask++) {
    const present = T.BEASTS.filter((_, i) => mask & (1 << i));
    const fed = T.BEASTS.filter((b) => chain[b].some((f) => present.includes(f)));
    rows.push({ beasts: present.map(T.beastName).join(' + '), size: present.length, continues: fed.length / 4, eatersFed: fed.map(T.beastName).join(', ') || 'none' });
  }
  return rows.sort((a, b) => a.size - b.size || b.continues - a.continues);
}

// ---------- Modes ----------

function save(name, data) {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

async function main() {
  const t0 = Date.now();
  const games = Number(opt('games', mode === 'tune' ? 40000 : 200000));
  const game = { rewards: opt('rewards', 'off') === 'on' };
  // --tool id: one instrument held from day 1 (eval, variants).
  if (opt('tool', null)) game.tool = String(opt('tool'));
  console.log(`${mode}: ${games.toLocaleString()} games per test on ${THREADS} threads, seed ${SEED}${game.rewards ? ', rewards on' : ', no tools'}`);

  if (mode === 'tune') {
    const { params, stats } = await tune(game, games, Number(opt('rounds', 3)), loadParams());
    const name = `tuned-${game.rewards ? 'rewards' : 'notools'}.json`;
    save(name, params);
    console.log(`\nbest: ${fmt(stats)}\n${JSON.stringify(params)}\nsaved tools/results/${name}`);
  } else if (mode === 'eval') {
    const params = loadParams();
    const only = opt('only', null);
    for (const policy of only ? String(only).split(',') : ['random', 'simple', 'solver']) {
      const start = Date.now();
      const stats = await run(policy, params, game, games);
      const secs = (Date.now() - start) / 1000;
      console.log(`${policy.padEnd(7)} ${fmt(stats)}  ${stats.games.toLocaleString()} runs in ${secs.toFixed(1)}s (${Math.round(stats.games / secs).toLocaleString()} runs/s)`);
      console.log(`        ${JSON.stringify(describe(stats))}`);
    }
  } else if (mode === 'tools') {
    const params = loadParams();
    const base = await run('solver', params, game, games);
    console.log(`no tool        ${fmt(base)}`);
    for (const tool of T.TOOL_IDS) {
      const stats = await run('solver', params, Object.assign({}, game, { tool }), games);
      console.log(`${T.TOOLS[tool].name.padEnd(18)} ${fmt(stats)}  (${(mean(stats) - mean(base) >= 0 ? '+' : '')}${(mean(stats) - mean(base)).toFixed(4)})`);
    }
  } else if (mode === 'gifts') {
    const params = loadParams();
    const rewards = Object.assign({}, game, { rewards: true });
    const scored = await run('solver', params, rewards, games);
    console.log(`scored on the spot  ${fmt(scored)}`);
    for (const id of T.GIFT_IDS) {
      const order = [id, ...T.GIFT_IDS.filter((g) => g !== id)];
      const stats = await run('solver', Object.assign({}, params || {}, { giftRank: order }), rewards, games);
      console.log(`always ${T.GIFTS[id].name.padEnd(18)} ${fmt(stats)}`);
    }
  } else if (mode === 'chains') {
    console.log('\nChance a chain finds its next meal, by the beasts waiting at that tier:');
    {
      console.log('\nShare of re-rolls that find food, by the beasts on the block:');
      for (const r of coverageTable()) console.log(`  ${pct(r.continues).padStart(6)}  ${r.beasts}`);
    }
    const stats = await run('solver', loadParams(), game, games, { stairs: true });
    console.log(`\nSimulated with the strategy: ${fmt(stats)}`);
    console.log(JSON.stringify(describe(stats)));
    const rows = Object.entries(stats.stairs)
      .filter(([, v]) => v.n >= 200)
      .map(([k, v]) => ({ key: k, n: v.n, rainbow: v.rainbow / v.n, bites: v.bites / v.n }))
      .sort((a, b) => b.rainbow - a.rainbow);
    console.log('\nDevours by eater tier and beasts fed at each higher tier (top 25 by Rainbow rate):');
    for (const r of rows.slice(0, 25)) console.log(`  ${r.key.padEnd(8)} n=${String(r.n).padStart(8)}  Rainbow ${pct(r.rainbow).padStart(6)}  bites ${r.bites.toFixed(2)}`);
  } else if (mode === 'report') {
    await report(games);
  } else if (mode === 'guide') {
    await guide(games);
  } else if (mode === 'train') {
    await train(games);
  } else if (mode === 'guide-tools') {
    await guideTools();
  } else if (mode === 'combos') {
    await combos();
  } else if (mode === 'variants') {
    // Drills with the profile the run's settings pick (or --params), and
    // variants of it on the same prisons, e.g. --variants ";toolSets=false".
    const profile = game.rewards ? 'rewards' : 'notools';
    const base = loadParams() || Object.assign({}, S.DEFAULTS, S.PROFILES[profile]);
    let first = null;
    for (const variant of String(opt('variants', '')).split(';').map((v) => v.trim())) {
      const change = {};
      for (const pair of variant.split(',').filter(Boolean)) {
        const [k, v] = pair.split('=').map((x) => x.trim());
        change[k] = v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : isNaN(Number(v)) ? v : Number(v);
      }
      const stats = await run('solver', Object.assign({}, base, change), game, games);
      first = first || stats;
      console.log(`[${variant || profile}] ${fmt(stats)}${stats === first ? '' : `  (${mean(stats) - mean(first) >= 0 ? '+' : ''}${(mean(stats) - mean(first)).toFixed(4)})`}`);
    }
  }
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  pool.forEach((p) => p.w.terminate());
}

// The full study: no tools, then tools and the Warden's Treasure, then chains.
async function report(games) {
  const out = { games, seed: SEED, threads: THREADS, when: new Date().toISOString() };
  const tuneGames = Number(opt('tune-games', 40000));
  const notools = { rewards: false };
  const rewards = { rewards: true };

  // --params starts the tuning from saved weights instead of the defaults.
  console.log('\n== 1. No tools: tune the strategy ==');
  const tuned = await tune(notools, tuneGames, Number(opt('rounds', 3)), loadParams());
  save('tuned-notools.json', tuned.params);
  out.params = tuned.params;

  console.log('\n== 2. No tools: compare strategies ==');
  out.notools = {};
  for (const policy of ['random', 'simple']) out.notools[policy] = describe(await run(policy, null, notools, games));
  out.notools.default = describe(await run('solver', S.DEFAULTS, notools, games));
  out.notools.tuned = describe(await run('solver', tuned.params, notools, games));
  for (const [k, v] of Object.entries(out.notools)) console.log(`${k.padEnd(8)} ${v.rainbowsPerRun} ± ${v.ci95}`);

  console.log('\n== 3. One tool held from day 1 ==');
  out.tools = {};
  for (const tool of T.TOOL_IDS) {
    out.tools[tool] = describe(await run('solver', tuned.params, Object.assign({}, notools, { tool }), games));
    console.log(`${T.TOOLS[tool].name.padEnd(18)} ${out.tools[tool].rainbowsPerRun} (${(out.tools[tool].rainbowsPerRun - out.notools.tuned.rainbowsPerRun).toFixed(4)})`);
  }
  const toolRank = T.TOOL_IDS.slice().sort((a, b) => out.tools[b].rainbowsPerRun - out.tools[a].rainbowsPerRun);
  const withRank = Object.assign({}, tuned.params, { toolRank });

  console.log('\n== 4. Rewards on: tool at the first Supreme, Treasure gift per Rainbow ==');
  out.rewards = {};
  for (const policy of ['random', 'simple']) out.rewards[policy] = describe(await run(policy, null, rewards, games));
  out.rewards.tuned = describe(await run('solver', withRank, rewards, games));
  for (const id of T.GIFT_IDS) {
    const order = [id, ...T.GIFT_IDS.filter((g) => g !== id)];
    out.rewards[`always-${id}`] = describe(await run('solver', Object.assign({}, withRank, { giftRank: order }), rewards, games));
  }
  for (const [k, v] of Object.entries(out.rewards)) console.log(`${k.padEnd(14)} ${v.rainbowsPerRun} ± ${v.ci95}`);
  // Keep a fixed gift order only if it clearly beats scoring gifts on the spot.
  const bestGift = T.GIFT_IDS.slice().sort((a, b) => out.rewards[`always-${b}`].rainbowsPerRun - out.rewards[`always-${a}`].rainbowsPerRun)[0];
  if (out.rewards[`always-${bestGift}`].rainbowsPerRun > out.rewards.tuned.rainbowsPerRun + out.rewards.tuned.ci95) {
    withRank.giftRank = [bestGift, ...T.GIFT_IDS.filter((g) => g !== bestGift).sort((a, b) => out.rewards[`always-${b}`].rainbowsPerRun - out.rewards[`always-${a}`].rainbowsPerRun)];
    console.log(`gift order: ${withRank.giftRank.join(', ')}`);
  }

  console.log('\n== 5. Retune with rewards on ==');
  const tunedRewards = await tune(rewards, tuneGames, Number(opt('rounds', 3)), withRank);
  save('tuned-rewards.json', tunedRewards.params);
  out.paramsRewards = tunedRewards.params;
  out.rewards.retuned = describe(await run('solver', tunedRewards.params, rewards, games));
  console.log(`retuned ${out.rewards.retuned.rainbowsPerRun} ± ${out.rewards.retuned.ci95}`);

  console.log('\n== 6. Chains ==');
  out.coverage = coverageTable();
  const chainStats = await run('solver', tunedRewards.params, rewards, games, { stairs: true });
  out.chains = describe(chainStats);
  out.stairs = Object.entries(chainStats.stairs)
    .filter(([, v]) => v.n >= 500)
    .map(([k, v]) => ({ key: k, n: v.n, rainbow: +(v.rainbow / v.n).toFixed(4), bites: +(v.bites / v.n).toFixed(3) }))
    .sort((a, b) => b.rainbow - a.rainbow);

  save('report.json', out);
  console.log('\nsaved tools/results/report.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

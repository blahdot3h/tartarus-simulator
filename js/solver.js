/* Tartarus Simulator: solver.
 * Rules-based play with no AI, in three parts that work on the game state:
 *  - Chain math: the exact expected outcome of a devour, including the random
 *    chain after it.
 *  - A strategy: it scores every legal move from what the player can see and
 *    plays the best one. tools/strategy-sim.js tunes its weights by running
 *    millions of simulated games.
 *  - A Monte Carlo solver: it plays each candidate move out many times from
 *    the current position, with the strategy making every later choice, and
 *    ranks the moves by Rainbows vaulted. Each playout re-rolls everything
 *    the player can't see, so the solver never peeks behind a door.
 * Runs in the page (in a Web Worker when it can) and under Node. */
(function (root) {
  'use strict';

  const T = root.Tartarus || (typeof require === 'function' ? require('./engine.js') : null);
  const { BEASTS, RAINBOW } = T;
  const RAT = BEASTS.indexOf('rat');
  const LION = BEASTS.indexOf('lion');
  const MAMMOTH = BEASTS.indexOf('mammoth');
  // The day's swap is still open: a day has a devour or a swap, not both.
  // (An engine cached from before that rule has no canSwapNow.)
  const canSwapNow = (st) => (T.canSwapNow ? T.canSwapNow(st) : st.used.swap < st.params.swapsPerDay);

  // Strategy weights. Values are in "tier value" units, where an inmate of
  // tier t is worth tierBase^t. tools/strategy-sim.js tuned these by
  // coordinate search over simulated runs (see tools/README.md).
  const DEFAULTS = {
    tierBase: 3, // how much one tier is worth over the tier below
    rainbowMult: 2, // a vaulted Rainbow, as a multiple of tierBase^5
    wOpen: 1, // patrol: value of adding a new inmate by opening a door
    wNow: 1, // patrol: what the new or visited inmate can do today
    wWalk: 1, // patrol: walking to a known inmate
    wStep: 0, // patrol: per step walked (negative keeps the warden slow)
    wNest: -6, // patrol: opening a rat nest before it hatches
    wChain: 4, // patrol: a door that hides a Chain reaction
    wGoal: 1, // patrol: per tile walked toward Prison Walk, while it pays a tool
    wInstigate: 0.5, // office: an event Instigate brings, as a share of an event door's worth
    wCrow: 2, // patrol: a door hiding Crow Whispers (it only shows rarities)
    wShort: 0.1, // Short-Chained Shackles: a short walk's chance of an extra door, as a share of its worth (0.1 measured best: 0.749 against 0.683 at 1)
    wCage: 1, // Crowded Beastcage: a devour's chance of reopening the meal's cell, as a share of its worth
    rerollMargin: 0.02, // a pet's re-roll: only when a new offer's best averages this much more (Rainbows per run)
    wStair: 0, // keeping a spread of beasts at each tier, so chains can go on
    minDevour: 0, // skip devours worth less than this (-1e9: never skip)
    stopMargin: 0, // stop a consume chain (the game's Cancel) when its best next meal is worth less than this (-1e9: never stop)
    swapMaxTier: 0, // swap the warden's inmate only at or below this tier
    swapMargin: 0, // a day has a swap or a devour: swap only when it beats the best devour by this much
    maidenSwapTier: 3, // holding the Severed Iron Maiden, swap up to this tier (Legendary measured best)
    execMargin: 0, // accept an Execution worth more than this
    acceptChain: true, // accept Chain reactions
    toolRank: ['crown', 'trap', 'rope', 'claws', 'maul', 'scapegoat', 'maiden', 'coin', 'shackles', 'muzzle', 'blacklist', 'ravenous', 'revenge', 'skewer', 'stake', 'hook', 'saw', 'collar', 'guillotine', 'whip', 'dogtag', 'keys', 'tongs', 'cage', 'scales', 'shortchain', 'fire', 'axe', 'pestle', 'forged', 'ironbox'], // measured: each tool held from day 1
    toolSets: true, // pick instruments by the measured sets (js/tool-combos.js) when there are any
    office: null, // always 'bestow' or 'instigate' at the office (only to measure the habit)
    giftRank: null, // null scores the gifts on the spot; or a fixed order
    giftChain: true, // Opulence's chain first: Horn for a Rainbow, then Thumb Ring, then Vintage (pickGift)
    // Contract challenge: convoys for the first two contracts weigh their
    // points against what the inmates sent would be worth kept on the block.
    keep1: 0, // contract 1: an inmate kept is worth this share of its tier value, in points (0: send the most points)
    keep2: 0, // contract 2: the same
    reserve: 1, // vouchers to hold back for the heavy contract while delivering the first two
    earlyPoints: 1e9, // from day 9, ship the heavy contract early once it scores this many points (-1: once the escort is full)
    stuckRainbow: 1, // a Rainbow the heavy contract can't afford to ship, as a share of its usual worth
    minLeft: 1, // vouchers the first two contracts always leave for the heavy one (0 only to measure the old habit)
    wNeed: 0, // moves that bring the block closer to meeting the next contract, per inmate short
    needDays: 3, // ...counted only in the last few days before its deadline
    needCrit: 2, // ...and weighted this much more when the contract is a must (the other early one was missed)
  };

  // Tuned weights for each kind of run: drills with tool rewards on or off,
  // and the contract challenge. The solver picks by the run's settings. From
  // tools/results/ (train-report.json: the drill profiles were retrained on
  // 2026-10-15).
  const PROFILES = {
    rewards: { tierBase: 3, rainbowMult: 1.5, wOpen: 1.5, wNow: 0.844, wWalk: 0.75, wStep: 0.5, wChain: 6, wStair: 0.25, swapMaxTier: 3, minDevour: 0, execMargin: 0, acceptChain: true, wCrow: 1, toolRank: ['crown', 'trap', 'rope', 'claws', 'maul', 'scapegoat', 'maiden', 'coin', 'shackles', 'muzzle', 'blacklist', 'ravenous', 'revenge', 'skewer', 'stake', 'hook', 'saw', 'collar', 'guillotine', 'whip', 'dogtag', 'keys', 'tongs', 'cage', 'scales', 'shortchain', 'fire', 'axe', 'pestle', 'forged', 'ironbox'] },
    notools: { tierBase: 2.75, rainbowMult: 12, wOpen: 2.25, wNow: 0.375, wWalk: 1.875, wStep: 0.5, wChain: 24, wStair: 0.125, swapMaxTier: 1, minDevour: 0, execMargin: -5, acceptChain: false, wCrow: 1, toolRank: ['crown', 'trap', 'rope', 'claws', 'maul', 'scapegoat', 'maiden', 'coin', 'shackles', 'muzzle', 'blacklist', 'ravenous', 'revenge', 'skewer', 'stake', 'hook', 'saw', 'collar', 'guillotine', 'whip', 'dogtag', 'keys', 'tongs', 'cage', 'scales', 'shortchain', 'fire', 'axe', 'pestle', 'forged', 'ironbox'] },
    // The contract challenge, tuned on passing first and then points.
    challenge: { tierBase: 2.25, rainbowMult: 1, wOpen: 2, wNow: 0.75, wWalk: 1, wStep: 0.5, wChain: 8, wStair: 0.5, swapMaxTier: 3, minDevour: -2, execMargin: 5, acceptChain: true, toolRank: ['rope', 'crown', 'maul', 'maiden', 'scapegoat', 'coin', 'shackles', 'ravenous', 'trap', 'skewer', 'claws', 'revenge', 'blacklist', 'collar', 'keys', 'cage', 'ironbox', 'muzzle', 'saw', 'whip', 'stake', 'guillotine', 'hook', 'tongs', 'dogtag', 'fire', 'axe', 'scales', 'pestle', 'shortchain', 'forged'], keep1: 1, keep2: 1, reserve: 3, earlyPoints: 1e9, wNeed: 40, needDays: 2, needCrit: 4 },
  };
  const paramsFor = (st) => PROFILES[st.mode === 'challenge' ? 'challenge' : st.params.rewards ? 'rewards' : 'notools'];

  // Every decision asks for its parameters with the defaults filled in:
  // made once for each set (none of them is ever changed).
  const filled = new WeakMap();
  const withDefaults = (p) => {
    if (!p) return Object.assign({}, DEFAULTS);
    let out = filled.get(p);
    if (!out) filled.set(p, (out = Object.assign({}, DEFAULTS, p)));
    return out;
  };

  // Measured Rainbows per run for sets of up to 4 instruments held from day
  // 1 (js/tool-combos.js, from the lab's combos mode). Without it, the
  // trained ranking alone picks instruments.
  const COMBOS = root.TARTARUS_COMBOS || (typeof require === 'function' ? optional('./tool-combos.js') : null);
  function optional(file) {
    try {
      return require(file);
    } catch (e) {
      return null;
    }
  }

  // ---------- Small helpers ----------

  // mulberry32, for the solver's own dice (never the game's).
  function rng32(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const beastIndex = (b) => BEASTS.indexOf(b);
  const has = (st, id) => st.tools.includes(id);

  // Counts of open inmates by tier and beast (index tier * 4 + beast),
  // leaving out one cell, plus how many are on the block in all.
  function composition(st, exclude) {
    const comp = new Array(24).fill(0);
    let crowd = 0;
    for (const c of st.cells) {
      if (c.sealed || !c.inmate) continue;
      crowd += 1;
      if (c.n === exclude || c.inmate.tier >= RAINBOW) continue;
      comp[c.inmate.tier * 4 + beastIndex(c.inmate.beast)] += 1;
    }
    return { comp, crowd };
  }

  function normalize(weights) {
    const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0) || 1;
    return weights.map((w) => Math.max(0, w) / total);
  }

  // Door odds known to be at or above a tier (a "Treasure" Hunt's dark doors).
  function floorDist(dist, floor) {
    const kept = dist.map((p, t) => (t >= floor ? p : 0));
    return kept.some((p) => p > 0) ? normalize(kept) : dist;
  }

  // ---------- Chain math ----------

  // Everything a decision needs, computed once per position.
  function context(st, params) {
    const P = withDefaults(params);
    const chain = T.FOOD_CHAIN;
    const eats = BEASTS.map((b) => chain[b].map(beastIndex));
    const skewer = has(st, 'skewer');
    if (skewer) eats[RAT] = eats[RAT].concat(RAT);
    // What each beast counters: under Cage Fight it can eat those at a
    // lower rarity too (the Crown's other beasts only at its own).
    const counters = eats.map((list) => list.slice());
    // The Iron Crown of the Prison King: a Lion eats any beast.
    const crown = has(st, 'crown');
    if (crown) eats[LION] = [0, 1, 2, 3];
    // The Elephant-Foot Maul: a Mammoth eats what it counters at a higher
    // rarity too, and rises to 2 tiers above its meal.
    const maul = has(st, 'maul');
    // From Legendary up (params.doubleEatTier), Mammoths and Lions also eat
    // their second meal (an engine cached from before has none).
    const second = T.SECOND_MEAL || {};
    const withSecond = (diet) => diet.map((list, b) => [...new Set(list.concat((second[BEASTS[b]] || []).map(beastIndex)))]);
    const eatsHigh = withSecond(eats);
    const countersHigh = withSecond(counters);
    // Under Cage Fight, both meals at every rarity.
    const doubleFrom = T.cageFight && T.cageFight(st) ? 0 : Number.isFinite(st.params.doubleEatTier) ? st.params.doubleEatTier : T.SECOND_MEAL ? 3 : RAINBOW;
    const v = [0, 1, 2, 3, 4, 5].map((t) => P.tierBase ** t);
    const openDist = normalize(st.params.tierWeights);
    // With the vault full (T.VAULT_SLOTS), a would-be Rainbow stays Supreme.
    const vaultFull = !!T.VAULT_SLOTS && st.vault.length >= T.VAULT_SLOTS;
    const R = vaultFull ? v[T.SUPREME] : v[RAINBOW] * P.rainbowMult * (rainbowStuck(st) ? P.stuckRainbow : 1);
    const sealed = st.cells.filter((c) => c.sealed).length;
    // Long-Chained Shackles: what +1 tier on a random inmate is worth.
    const board = st.cells.filter((c) => !c.sealed && c.inmate && c.inmate.tier < RAINBOW);
    const lift = board.reduce((sum, c) => sum + (c.inmate.tier + 1 >= RAINBOW ? R : v[c.inmate.tier + 1]) - v[c.inmate.tier], 0) / Math.max(1, board.length);
    // Two tiers for every inmate on the block (Usurpation IV), and for a random one.
    const allLift2 = board.reduce((sum, c) => sum + (c.inmate.tier + 2 >= RAINBOW ? R : v[c.inmate.tier + 2]) - v[c.inmate.tier], 0);
    const goal = st.objective && st.objective.id === 'walk' && !st.milestone && st.params.rewards ? T.OBJECTIVES.walk.need - st.objective.progress : 0;
    return {
      st,
      P,
      eats,
      // What each beast eats at tier t, and what it counters there.
      eatsAt: (t) => (t >= doubleFrom ? eatsHigh : eats),
      countersAt: (t) => (t >= doubleFrom ? countersHigh : counters),
      // Cage Fight: lower-rarity meals, and the eater keeps its beast.
      fight: T.cageFight ? T.cageFight(st) : false,
      v,
      R,
      saw: has(st, 'saw'),
      whip: has(st, 'whip'),
      muzzle: has(st, 'muzzle'),
      skewer,
      crown,
      maul,
      collar: has(st, 'collar'),
      revenge: has(st, 'revenge') && sealed > 0,
      axeDoors: has(st, 'axe') ? Math.min(2, sealed) : 0,
      dogtag: has(st, 'dogtag'),
      cage: has(st, 'cage'),
      blacklist: has(st, 'blacklist'),
      shortchain: has(st, 'shortchain'),
      // Severed Iron Maiden: how many inmates of each tier are on the block.
      maiden: has(st, 'maiden') ? [0, 1, 2, 3, 4].map((t) => board.filter((c) => c.inmate.tier === t).length) : null,
      // Scapegoat's Guillotine, with 2 or more others beside the warden's
      // inmate: a swap comes in above the rarity it replaces, and 2 random
      // inmates go (what they're worth on average).
      scapegoat: has(st, 'scapegoat') && board.length >= 3 ? { loss: (2 * board.reduce((sum, c) => sum + v[c.inmate.tier], 0)) / board.length } : null,
      // Burning Stake: a swap from below Legendary may come in Legendary.
      stake: has(st, 'stake'),
      // The highest tier worth swapping: higher with the Maiden, up to Rare
      // with the Burning Stake, and up to Supreme with the Guillotine (a
      // Supreme's swap comes in Chromatic). A swapMaxTier below 0 never
      // swaps, not even in a Tusk cell.
      swapCap: P.swapMaxTier < 0 ? -1 : has(st, 'scapegoat') && board.length >= 3 ? T.SUPREME : Math.max(has(st, 'maiden') ? Math.max(P.swapMaxTier, P.maidenSwapTier) : P.swapMaxTier, has(st, 'stake') ? 2 : 0),
      sealed,
      lift: board.length ? lift : 0,
      lift2: board.length ? allLift2 / board.length : 0,
      allLift2,
      shacklesLift: has(st, 'shackles') && board.length ? lift : 0,
      goalLeft: goal,
      scratchExtra: 1 + (st.params.scratchStacksBase ? 1 : 0),
      openDist,
      openValue: openDist.reduce((sum, p, t) => sum + p * v[t], 0),
      need: contractNeed(st, P),
      // The game's Cancel: a chain can stop after any bite.
      chainStop: T.canStopChain ? T.canStopChain(st) : false,
      memo: new Map(),
    };
  }

  // Tier odds for a swapped-in inmate, after Hangman's Noose, and above the
  // old tier with the Scapegoat's Guillotine (a tier above when the weights
  // reach no higher; index 5 is Chromatic). The Burning Stake then makes a
  // swap from below Legendary come in Legendary 40% of the time.
  function swapDist(ctx, oldTier) {
    const w = (ctx.st.params.swapWeights || ctx.st.params.tierWeights).slice();
    if (has(ctx.st, 'rope')) w[0] = w[1] = 0;
    let dist;
    if (ctx.scapegoat) {
      const higher = w.map((x, t) => (t > oldTier ? x : 0));
      dist = higher.some((x) => x > 0) ? normalize(higher) : [0, 1, 2, 3, 4, 5].map((t) => (t === Math.min(RAINBOW, oldTier + 1) ? 1 : 0));
    } else dist = normalize(w);
    if (ctx.stake && oldTier < 3) {
      dist = dist.map((p) => 0.6 * p);
      dist[3] += 0.4;
    }
    return dist;
  }

  // Value from here on for an eater that just reached tier t: its beast
  // re-rolls (under Cage Fight it stays `keep`), then it chains into the
  // best valid meal if it has one.
  function rise(ctx, t, comp, crowd, keep) {
    if (t >= RAINBOW) return ctx.R;
    const beasts = keep >= 0 ? [keep] : [0, 1, 2, 3];
    let sum = 0;
    for (const b of beasts) {
      if (ctx.revenge) {
        // Avenger's Casket: 30% of the time a meal for the new form appears.
        const foods = ctx.eatsAt(t)[b];
        let spawned = 0;
        for (const f of foods) {
          comp[t * 4 + f] += 1;
          spawned += ctx.v[t] + feed(ctx, t, b, comp, crowd + 1);
          comp[t * 4 + f] -= 1;
        }
        sum += (0.3 * spawned) / foods.length + 0.7 * feed(ctx, t, b, comp, crowd);
      } else {
        sum += feed(ctx, t, b, comp, crowd);
      }
    }
    return sum / beasts.length;
  }

  // An eater of beast b at tier t takes the best meal it has. With none, the
  // chain ends and it keeps its tier, and with the game's Cancel it also
  // stops when no meal is worth eating (stopMargin).
  function feed(ctx, t, b, comp, crowd) {
    let key = `${t}${b}${ctx.muzzle ? `m${crowd}` : ''}`;
    for (let i = ctx.fight ? 0 : t * 4; i < 20; i++) key += String.fromCharCode(48 + comp[i]);
    const hit = ctx.memo.get(key);
    if (hit !== undefined) return hit;
    let out = -Infinity;
    // Under Cage Fight, countered meals of a lower rarity too.
    for (let mt = ctx.fight ? 0 : t; mt <= topMeal(ctx, t, b); mt++) {
      for (const f of (mt !== t ? ctx.countersAt(t) : ctx.eatsAt(t))[b]) {
        if (!comp[mt * 4 + f]) continue;
        comp[mt * 4 + f] -= 1;
        out = Math.max(out, bite(ctx, t, b, comp, crowd, 0, true, mt));
        comp[mt * 4 + f] += 1;
      }
    }
    if (out === -Infinity || (ctx.chainStop && out - ctx.v[t] < ctx.P.stopMargin)) out = ctx.v[t];
    ctx.memo.set(key, out);
    return out;
  }

  // One bite at tier t: the meal is gone and the eater rises. A chained bite
  // (after the first) can get the Barbed Collar's +1.
  // `crowd` counts the block before the bite, meal included; the Muzzle
  // counts it after.
  function bite(ctx, t, b, comp, crowd, extra, chained, mealTier = t) {
    let gain = (ctx.maul && b === MAMMOTH ? Math.max(1, mealTier + 2 - t) : 1) + extra;
    if (ctx.muzzle && crowd - 1 <= 4) gain += 2;
    if (ctx.skewer && b === RAT) gain += 1;
    if (ctx.crown && b === LION) gain += 2;
    const after = (g) => rise(ctx, Math.min(RAINBOW, t + g), comp, crowd - 1, ctx.fight ? b : -1);
    // The Rusty Saw (25%) and the Barbed Whip (35%) each may add +1.
    const s = ctx.saw ? 0.25 : 0;
    const w = ctx.whip ? 0.35 : 0;
    const sawed = (g) => (s || w ? (1 - s) * (1 - w) * after(g) + (s + w - 2 * s * w) * after(g + 1) + s * w * after(g + 2) : after(g));
    return -ctx.v[mealTier] + (chained && ctx.collar ? 0.2 * sawed(gain) + 0.8 * sawed(gain + 1) : sawed(gain));
  }

  // The highest meal tier an eater of beast b at tier t can take: its own,
  // or up to Supreme for a Mammoth with the Elephant-Foot Maul.
  function topMeal(ctx, t, b) {
    return ctx.maul && b === MAMMOTH ? RAINBOW - 1 : t;
  }

  // Expected change in value from a bite: the chosen meal, then the rest of
  // the chain. `chained` marks a bite inside a chain, after the first.
  // `comp` leaves out the eater and still holds the meal.
  function devourDelta(ctx, tier, beast, meal, scratch, comp, crowd, chained, mealTier = tier) {
    const i = mealTier * 4 + meal;
    if (!scratch) comp[i] -= 1;
    // A meal behind a scratched door isn't on the block, so the block doesn't
    // shrink when it's eaten.
    const value = bite(ctx, tier, beast, comp, scratch ? crowd + 1 : crowd, scratch ? ctx.scratchExtra : 0, chained, mealTier) - ctx.v[tier];
    if (!scratch) comp[i] += 1;
    return value;
  }

  // The best first meal for an eater of this tier and beast, by expected value.
  function bestMeal(ctx, tier, beast, comp, crowd) {
    let best = { value: -Infinity, meal: -1 };
    for (let mt = ctx.fight ? 0 : tier; mt <= topMeal(ctx, tier, beast); mt++) {
      for (const f of (mt !== tier ? ctx.countersAt(tier) : ctx.eatsAt(tier))[beast]) {
        if (!comp[mt * 4 + f]) continue;
        const value = devourDelta(ctx, tier, beast, f, false, comp, crowd, false, mt);
        if (value > best.value) best = { value, meal: f };
      }
    }
    return best;
  }

  // Exact odds that a devour's chain reaches Rainbow, and its expected bites,
  // for the explanation lines, when each later meal is picked for the best
  // odds. Uses the same rules as `rise`, without tools. It works for a pick
  // inside a chain too: `from` is the eater either way.
  function chainOdds(st, from, to) {
    const ctx = context(st, { tierBase: 1, rainbowMult: 1 });
    const eater = st.cells[from].inmate;
    const target = st.cells[to];
    const meal = target.sealed ? target.hidden : target.inmate;
    if (!eater || !meal) return { rainbow: 0, bites: 0 };
    const { comp } = composition(st, from);
    if (!target.sealed) comp[meal.tier * 4 + beastIndex(meal.beast)] -= 1;
    const memo = new Map();
    // Returns [P(reach Rainbow), expected further bites] from tier t, beast
    // re-rolling (under Cage Fight, staying `keep`).
    const fromTier = (t, keep) => {
      if (t >= RAINBOW) return [1, 0];
      const beasts = keep >= 0 ? [keep] : [0, 1, 2, 3];
      let p = 0;
      let n = 0;
      for (const b of beasts) {
        const [pb, nb] = eat(t, b);
        p += pb / beasts.length;
        n += nb / beasts.length;
      }
      return [p, n];
    };
    const eat = (t, b) => {
      let key = `${t}${b}`;
      for (let i = ctx.fight ? 0 : t * 4; i < 20; i++) key += String.fromCharCode(48 + comp[i]);
      if (memo.has(key)) return memo.get(key);
      // The player picks the meal with the best odds (then more bites).
      let out = null;
      for (let mt = ctx.fight ? 0 : t; mt <= topMeal(ctx, t, b); mt++) {
        for (const f of (mt !== t ? ctx.countersAt(t) : ctx.eatsAt(t))[b]) {
          if (!comp[mt * 4 + f]) continue;
          comp[mt * 4 + f] -= 1;
          const [pf, nf] = fromTier(ctx.maul && b === MAMMOTH ? Math.max(t + 1, mt + 2) : t + 1, ctx.fight ? b : -1);
          comp[mt * 4 + f] += 1;
          if (!out || pf > out[0] + 1e-12 || (Math.abs(pf - out[0]) <= 1e-12 && nf + 1 > out[1])) out = [pf, nf + 1];
        }
      }
      out = out || [0, 0];
      memo.set(key, out);
      return out;
    };
    const gain = target.sealed && target.scratch ? 1 + ctx.scratchExtra : ctx.maul && eater.beast === 'mammoth' ? Math.max(1, meal.tier + 2 - eater.tier) : 1;
    const [p, n] = fromTier(Math.min(RAINBOW, eater.tier + gain), ctx.fight ? beastIndex(eater.beast) : -1);
    return { rainbow: p, bites: 1 + n };
  }

  // ---------- Valuing positions and moves ----------

  // How ready the block is for chains: at each tier, the share of beasts an
  // eater could re-roll into and still find a meal there, weighted by tier.
  function stair(ctx, comp) {
    let value = 0;
    for (let t = 0; t < RAINBOW; t++) {
      let fed = 0;
      for (let b = 0; b < 4; b++) if (ctx.eatsAt(t)[b].some((f) => comp[t * 4 + f] > 0)) fed += 1;
      value += (fed / 4) * ctx.v[t];
    }
    return value;
  }

  // Change in readiness from adding (+1) or removing (-1) one inmate.
  function stairDelta(ctx, comp, tier, beast, sign) {
    if (!ctx.P.wStair || tier >= RAINBOW) return 0;
    const before = stair(ctx, comp);
    comp[tier * 4 + beast] += sign;
    const after = stair(ctx, comp);
    comp[tier * 4 + beast] -= sign;
    return ctx.P.wStair * (after - before);
  }

  // Expected readiness change from a new inmate with tier odds `dist`.
  function stairFresh(ctx, dist, comp) {
    if (!ctx.P.wStair) return 0;
    let sum = 0;
    for (let t = 0; t < dist.length; t++) for (let b = 0; b < 4; b++) if (dist[t]) sum += (dist[t] / 4) * stairDelta(ctx, comp, t, b, 1);
    return sum;
  }

  // What swapping an inmate of this tier is worth, on average. With the
  // Gaoler's Execution Axe, a higher roll also opens 2 doors. With the
  // Severed Iron Maiden, a roll with as many inmates above it as below it
  // gains 3 tiers.
  function swapValue(ctx, tier) {
    const dist = swapDist(ctx, tier);
    let value = dist.reduce((sum, p, t) => sum + p * (t >= RAINBOW ? ctx.R : ctx.v[t]), 0) - ctx.v[tier];
    if (ctx.axeDoors) value += dist.reduce((sum, p, t) => sum + (t > tier ? p : 0), 0) * ctx.axeDoors * ctx.P.wOpen * ctx.openValue;
    if (ctx.scapegoat) value -= ctx.scapegoat.loss;
    return value + maidenBonus(ctx, tier).value;
  }

  // Severed Iron Maiden: the chance that a swap's newcomer has as many
  // inmates above its rarity as below it, and what its 3 extra tiers add on
  // average. The block is counted without the inmate swapped out.
  function maidenBonus(ctx, tier) {
    const out = { chance: 0, value: 0 };
    if (!ctx.maiden) return out;
    const dist = swapDist(ctx, tier);
    const counts = ctx.maiden.slice();
    if (counts[tier] > 0) counts[tier] -= 1;
    for (let t = 0; t < dist.length; t++) {
      const above = counts.reduce((sum, n, u) => sum + (u > t ? n : 0), 0);
      const below = counts.reduce((sum, n, u) => sum + (u < t ? n : 0), 0);
      if (!dist[t] || above !== below) continue;
      out.chance += dist[t];
      out.value += dist[t] * ((t + 3 >= RAINBOW ? ctx.R : ctx.v[t + 3]) - ctx.v[t]);
    }
    return out;
  }

  // Behind Closed Doors: the inmate in the warden's cell becomes a Supreme.
  // For a door not yet opened, its occupant's tier follows `dist`.
  function tricksterValue(ctx, dist) {
    return dist.reduce((sum, p, t) => sum + p * Math.max(0, ctx.v[T.SUPREME] - ctx.v[Math.min(t, T.SUPREME)]), 0);
  }

  // Ravenous Appetite: the lowest-rarity inmate on the block, the new one
  // from the door included, gets several tries at +1 tier. `low` is the
  // lowest tier on the block now; the newcomer's tier follows `dist`.
  function appetiteValue(ctx, low, dist) {
    const n = T.APPETITE_TRIES;
    const q = T.APPETITE_ODDS;
    const val = (t) => (t >= RAINBOW ? ctx.R : ctx.v[t]);
    let sum = 0;
    for (let t = 0; t < dist.length; t++) {
      if (!dist[t]) continue;
      const from = Math.min(t, low);
      let choose = 1;
      for (let k = 0; k <= n; k++) {
        if (k) choose = (choose * (n - k + 1)) / k;
        sum += dist[t] * choose * q ** k * (1 - q) ** (n - k) * (val(Math.min(RAINBOW, from + k)) - val(from));
      }
    }
    return sum;
  }

  // What an inmate can do once the warden stands with it: its best devour or
  // a swap, whichever is worth more, and never below zero (it can just wait).
  function activation(ctx, tier, beast, comp, crowd, swapLeft) {
    let value = 0;
    if (tier < RAINBOW) value = Math.max(value, bestMeal(ctx, tier, beast, comp, crowd).value);
    if (swapLeft && tier <= ctx.swapCap) value = Math.max(value, swapValue(ctx, tier));
    return value;
  }

  // What a brand-new inmate (tier odds `dist`) could do today, on average.
  function freshActivation(ctx, dist, comp, crowd, swapLeft) {
    let sum = 0;
    for (let t = 0; t < dist.length; t++) {
      if (!dist[t]) continue;
      for (let b = 0; b < 4; b++) sum += (dist[t] / 4) * activation(ctx, t, b, comp, crowd, swapLeft);
    }
    return sum;
  }

  // Felon's Dog Tag: the inmate behind a door the patrol opens rises a tier
  // 25% of the time, so its rarity odds shift up a little.
  function tagged(ctx, dist) {
    if (!ctx.dogtag) return dist;
    const out = dist.map((p) => 0.75 * p);
    dist.forEach((p, t) => (out[Math.min(out.length - 1, t + 1)] += 0.25 * p));
    return out;
  }

  // Expected value of a new inmate behind a door: its own worth plus what it
  // could do today from the warden's cell.
  function freshValue(ctx, dist, comp, crowd, swapLeft) {
    const worth = dist.reduce((sum, p, t) => sum + p * ctx.v[t], 0);
    return ctx.P.wOpen * worth + ctx.P.wNow * freshActivation(ctx, dist, comp, crowd, swapLeft) + stairFresh(ctx, dist, comp);
  }

  // Value of an Execution by an inmate of this tier and beast.
  function executionValue(ctx, tier, beast, comp) {
    const same = ctx.st.params.executionSameTier;
    const prey = T.FOOD_CHAIN[BEASTS[beast]].map(beastIndex);
    let count = 0;
    let lost = 0;
    for (let t = 0; t <= (same ? tier : tier - 1); t++) {
      if (same && t !== tier) continue;
      for (const f of prey) {
        count += comp[t * 4 + f];
        lost += comp[t * 4 + f] * ctx.v[t];
      }
    }
    if (!count) return 0;
    const to = Math.min(RAINBOW, tier + count);
    return (to >= RAINBOW ? ctx.R : ctx.v[to]) - ctx.v[tier] - lost;
  }

  // Why a door with a known event is worth opening.
  const EVENT_WHY = {
    execution: 'an Execution waits behind the door',
    chain: 'a Chain reaction waits behind the door',
    trickster: 'Behind Closed Doors waits there: whoever is inside becomes a Supreme',
    appetite: 'Ravenous Appetite waits there: the lowest-rarity inmate gets 5 tries at +1 tier',
    convict: 'High-Risk Convict waits there: another cell opens on a Legendary',
    crow: 'Crow Whispers waits there: it shows the rarity behind the next 4 locked doors',
    freedom: 'Taste of Freedom waits there: 3 more locked cells open',
    usurp1: 'Usurpation I waits there: a random inmate rises a tier, and Usurpation II appears',
    usurp2: 'Usurpation II waits there: 2 random inmates rise a tier',
    usurp3: 'Usurpation III waits there: 2 random inmates rise 2 tiers',
    usurp4: 'Usurpation IV waits there: every inmate rises 2 tiers',
    ratway: 'the Sewer Ratway waits there: a free move to any cell but the office',
    hunt: '"Treasure" Hunt waits there: every locked door holding a Normal or Magic shows its rarity, so the rest hold Rare or better',
  };

  // What each event behind a door is worth, given the block's composition.
  // Each is a function, so only the ones needed are worked out.
  function eventWorth(ctx, comp) {
    const P = ctx.P;
    return {
      execution: () => {
        let exec = 0;
        for (let t = 0; t < ctx.openDist.length; t++) {
          for (let b = 0; b < 4; b++) exec += (ctx.openDist[t] / 4) * Math.max(0, executionValue(ctx, t, b, comp) - P.execMargin);
        }
        return exec;
      },
      chain: () => P.wChain,
      trickster: () => tricksterValue(ctx, ctx.openDist),
      appetite: () => {
        let low = Infinity;
        for (let i = 0; i < 20 && low === Infinity; i++) if (comp[i]) low = Math.floor(i / 4);
        return appetiteValue(ctx, low, ctx.openDist);
      },
      // A Legendary joins the block, from a cell that won't need a patrol.
      convict: () => P.wOpen * ctx.v[3],
      // Knowing what's behind 4 doors helps pick later patrols.
      crow: () => P.wCrow,
      // Three more doors open, with nobody to patrol there.
      freedom: () => T.FREEDOM_CELLS * P.wOpen * ctx.openValue,
      // A random inmate rises a tier, and Usurpation II (2 inmates) appears.
      // Each Usurpation raises inmates, then brings the next into the pool.
      usurp1: () => ctx.lift + 2 * ctx.lift * P.wInstigate,
      usurp2: () => 2 * ctx.lift + 2 * ctx.lift2 * P.wInstigate,
      usurp3: () => 2 * ctx.lift2 + ctx.allLift2 * P.wInstigate,
      usurp4: () => ctx.allLift2,
      // A second move: to the best door anywhere, worth a fresh door at least.
      ratway: () => P.wOpen * ctx.openValue,
      // Like Crow Whispers, but it tells every locked door apart: the low
      // ones show, and the rest are Rare or better.
      hunt: () => P.wCrow * Math.max(1, ctx.sealed / T.CROW_CELLS),
    };
  }

  // The warden's office: Bestow raises 1 random inmate on the block a tier;
  // Instigate puts new events behind locked doors, worth an average event
  // each, discounted by wInstigate since a patrol still has to reach them.
  function officeValues(st, ctx, comp) {
    let bestow = 0;
    let count = 0;
    for (const c of st.cells) {
      if (c.sealed || !c.inmate || c.inmate.tier >= RAINBOW) continue;
      const t = c.inmate.tier;
      bestow += (t + 1 >= RAINBOW ? ctx.R : ctx.v[t + 1]) - ctx.v[t];
      count += 1;
    }
    bestow /= Math.max(1, count);
    // Cells an Instigate can put an event on (T.instigateCells; an engine
    // cached from before only took locked doors).
    const free = T.instigateCells ? T.instigateCells(st).length : st.cells.filter((c) => c.sealed && !c.event && !c.nest).length;
    const worth = eventWorth(ctx, comp);
    const pool = st.eventPool || T.EVENT_POOL;
    const each = pool.reduce((sum, id) => sum + worth[id](), 0) / pool.length;
    // Tyranny (a start card): every stop at the office also triggers 3 more
    // Bestows and 3 more Instigates by themselves.
    const extra = st.startEvent === 'tyranny' && T.START_EVENTS.tyranny ? T.START_EVENTS.tyranny.extra : 0;
    // An Instigate on a board with no event makes 2 (T.instigateCount);
    // after Tyranny's, the board has some.
    const first = T.instigateCount ? T.instigateCount(st) : T.INSTIGATE_EVENTS;
    const tyranny = extra ? extra * bestow + Math.min(first + (extra - 1) * T.INSTIGATE_EVENTS, free) * each * ctx.P.wInstigate : 0;
    return { bestow, instigate: Math.min(extra ? T.INSTIGATE_EVENTS : first, free) * each * ctx.P.wInstigate, tyranny };
  }

  // Scores today's destinations. Returns [{ cell, score, why }], best first.
  function patrolScores(st, ctx) {
    const P = ctx.P;
    const board = composition(st, -1);
    const swapLeft = canSwapNow(st);
    let fresh = null;
    const freshNow = () => (fresh === null ? (fresh = freshValue(ctx, tagged(ctx, ctx.openDist), board.comp, board.crowd + 1, swapLeft)) : fresh);
    const out = [];
    const range = Math.min(st.params.patrolRange || T.DEFAULT_PARAMS.patrolRange, T.CELL_COUNT - 1);
    for (const n of T.patrolOptions(st)) {
      const c = st.cells[n];
      // A door out of the warden's reach (a typed board with the warden in
      // the wrong cell) has no walk to count: one just behind the warden
      // would otherwise score as a walk most of the way round.
      // The Sewer Ratway's move isn't a walk either.
      const steps = !st.ratway && T.stepsBetween(st.position, n) <= range ? T.stepsBetween(st.position, n) : 0;
      let score = P.wStep * steps;
      let why;
      if (st.chain && !st.ratway) {
        const path = steps ? T.clockwisePath(st, n) : [n];
        const sealed = path.filter((k) => st.cells[k].sealed).length;
        score += P.wOpen * (sealed - (c.sealed ? 1 : 0)) * ctx.openValue + (c.sealed ? freshNow() : c.inmate ? P.wWalk * known(c) : 0);
        why = `the chain opens ${T.plural(sealed, 'door')} on the way`;
      } else if (c.sealed && c.nest) {
        score += P.wNest;
        why = `it destroys the rat nest due on day ${c.nest.due}`;
      } else if (c.sealed) {
        // A door whose rarity shows (Crow Whispers, a scratch, the Scales)
        // is worth that rarity, and one a "Treasure" Hunt left dark is worth
        // the door odds from Rare up.
        const shown = c.known && c.hidden ? [0, 1, 2, 3, 4].map((t) => (t === Math.min(4, c.hidden.tier) ? 1 : 0)) : null;
        const dist = shown || (c.atLeast ? floorDist(ctx.openDist, c.atLeast) : null);
        const need = needValue(ctx, board.comp, [], dist || ctx.openDist);
        score += (dist ? freshValue(ctx, tagged(ctx, dist), board.comp, board.crowd + 1, swapLeft) : freshNow()) + need;
        // Executioner's Blacklist: opening this door leaves 5 or fewer locked,
        // so 2 random inmates rise a tier.
        if (ctx.blacklist && ctx.sealed - 1 <= 5) score += 2 * ctx.lift;
        const who = !shown && c.atLeast ? `a ${T.tierName(c.atLeast)} or better inmate (the "Treasure" Hunt left this door dark)` : 'a new inmate';
        why = need > 0 ? `${who}, who may help meet "${ctx.need.contract.name}"` : `${who}, who may consume today`;
        const worth = eventWorth(ctx, board.comp);
        const pool = st.eventPool || T.EVENT_POOL;
        const anyEvent = () => pool.reduce((sum, id) => sum + worth[id](), 0) / pool.length;
        // An event shows once the warden has walked past its door. A door
        // not yet passed may still hide one; a seen event whose kind the
        // player can't see is any of them, evenly.
        if (c.seen === false) {
          score += (st.params.eventChance / 100) * anyEvent();
        } else if (c.event && c.eventKnown === false) {
          score += anyEvent();
          why = 'a special event waits behind the door';
        } else if (c.event && worth[c.event]) {
          score += worth[c.event]();
          why = EVENT_WHY[c.event];
        }
      } else if (n === T.OFFICE) {
        const office = officeValues(st, ctx, board.comp);
        score += Math.max(office.bestow, office.instigate) + office.tyranny;
        why = office.bestow >= office.instigate ? 'the office: Bestow raises 1 random inmate a tier' : `the office: Instigate brings ${(T.instigateCount ? T.instigateCount(st) : T.INSTIGATE_EVENTS) === 1 ? 'a new special event' : `${T.instigateCount ? T.instigateCount(st) : T.INSTIGATE_EVENTS} new special events`}`;
        if (office.tyranny) why += `, and Tyranny adds ${T.START_EVENTS.tyranny.extra} of each`;
      } else if (c.inmate) {
        score += P.wWalk * known(c);
        why = `its ${T.describe(c.inmate)} can act today`;
        // An event waiting in an open cell goes off when the warden walks in.
        if (c.event) {
          const worth = eventWorth(ctx, board.comp);
          const pool = st.eventPool || T.EVENT_POOL;
          if (c.eventKnown === false || !worth[c.event]) {
            score += pool.reduce((sum, id) => sum + worth[id](), 0) / pool.length;
            why = `a special event waits in the cell with its ${T.describe(c.inmate)}`;
          } else {
            score += worth[c.event]();
            why = EVENT_WHY[c.event].replace('behind the door', 'in the cell');
          }
        }
      } else {
        why = 'an empty cell';
      }
      // Long-Chained Shackles: a walk of 4 or more may raise someone a tier.
      if (ctx.shacklesLift && steps >= 4) score += 0.4 * ctx.shacklesLift;
      // Short-Chained Shackles: a walk of 3 or fewer may open another door.
      if (ctx.shortchain && steps >= 1 && steps <= 3 && ctx.sealed > (c.sealed ? 1 : 0)) score += P.wShort * 0.5 * P.wOpen * ctx.openValue;
      // Prison Walk: each tile walked brings its tool closer.
      if (ctx.goalLeft) score += P.wGoal * Math.min(steps, ctx.goalLeft);
      out.push({ cell: n, score, why });
    }
    return out.sort((a, b) => b.score - a.score);

    function known(cell) {
      const { comp, crowd } = composition(st, cell.n);
      return activation(ctx, cell.inmate.tier, beastIndex(cell.inmate.beast), comp, crowd, swapLeft);
    }
  }

  // What a prey mark still promises: both inmates rise a tier each morning.
  function linkValue(st, ctx, link) {
    let value = 0;
    for (const id of [link.lion, link.prey]) {
      const cell = T.cellOf(st, id);
      if (!cell || !cell.inmate) continue;
      const t = cell.inmate.tier;
      const to = Math.min(RAINBOW, t + link.rounds);
      value += (to >= RAINBOW ? ctx.R : ctx.v[to]) - ctx.v[t];
    }
    return value;
  }

  // The Blood-Stained Trap's best Hunt today: what its prey mark would
  // promise, at 80% for the chance it ends early (a side leaves the block or
  // changes beast). Null when there's no Hunt to make.
  function bestHunt(st, ctx) {
    if (!T.canHuntNow || !T.canHuntNow(st)) return null;
    const lion = st.cells[st.position].inmate;
    let best = null;
    for (const n of T.huntTargets(st)) {
      const value = 0.8 * linkValue(st, ctx, { lion: lion.id, prey: st.cells[n].inmate.id, rounds: st.params.preyRounds });
      if (!best || value > best.value) best = { cell: n, value };
    }
    return best;
  }

  // The prey mark an action would end, valued (0 if none).
  function linkLoss(st, ctx, inmate, certain) {
    const link = inmate && T.linkOf(st, inmate.id);
    if (!link) return 0;
    // A Lion that devours re-rolls its beast; 1 in 4 times it stays a Lion.
    return linkValue(st, ctx, link) * (certain || link.prey === inmate.id ? 1 : 0.75);
  }

  // Today's devour options for the warden's inmate, valued. Best first.
  // While a chain waits for a pick, they're the eater's next meals.
  function devourScores(st, ctx) {
    const here = st.cells[st.position];
    if (!here || here.sealed || !here.inmate) return [];
    const { comp, crowd } = composition(st, st.position);
    const tier = here.inmate.tier;
    const beast = beastIndex(here.inmate.beast);
    const own = linkLoss(st, ctx, here.inmate, false);
    const whole = ctx.need ? composition(st, -1).comp : null;
    const chained = !!st.chaining;
    return (chained ? T.chainOptions(st) : T.startOptions(st))
      .map((o) => {
        const target = st.cells[o.cell];
        const meal = o.scratch ? target.hidden : target.inmate;
        const mealLink = o.scratch ? 0 : linkLoss(st, ctx, meal, true);
        const sameLink = own && mealLink && T.linkOf(st, here.inmate.id) === T.linkOf(st, meal.id);
        const loss = sameLink ? Math.max(own, mealLink) : own + mealLink;
        const stairLoss = o.scratch ? 0 : stairDelta(ctx, comp, meal.tier, beastIndex(meal.beast), -1);
        // The next contract: the meal leaves the block, and the eater rises
        // as a random beast (the chain after the first bite isn't counted).
        let need = 0;
        if (whole) {
          const removes = [[tier, beast]];
          if (!o.scratch) removes.push([meal.tier, beastIndex(meal.beast)]);
          const to = Math.min(RAINBOW, tier + T.gainFor(st, st.position, o).gain);
          need = needValue(ctx, whole, removes, [0, 1, 2, 3, 4, 5].map((t) => (t === to ? 1 : 0)));
        }
        // Crowded Beastcage: 40% of the time the meal's cell opens again with
        // someone new (the chain after the first bite isn't counted).
        const cage = ctx.cage ? ctx.P.wCage * 0.4 * ctx.P.wOpen * ctx.openValue : 0;
        return { cell: o.cell, score: devourDelta(ctx, tier, beast, beastIndex(meal.beast), !!o.scratch, comp, crowd, chained, o.scratch ? tier : meal.tier) - loss + stairLoss + need + cage };
      })
      .sort((a, b) => b.score - a.score);
  }

  // A swap in the warden's cell: the new inmate's worth over the old one,
  // less any prey mark it ends, plus the Tusk bonus if the cell has one.
  // None after today's devour: a day has one or the other.
  function swapGainHere(st, ctx) {
    const here = st.cells[st.position];
    if (!here || here.sealed || !here.inmate || !canSwapNow(st) || ctx.swapCap < 0) return -Infinity;
    let gain = swapValue(ctx, here.inmate.tier) - linkLoss(st, ctx, here.inmate, true);
    if (ctx.need) gain += needValue(ctx, composition(st, -1).comp, [[here.inmate.tier, beastIndex(here.inmate.beast)]], swapDist(ctx, here.inmate.tier));
    if (here.ivory) {
      const board = st.cells.filter((c) => !c.sealed && c.inmate && c.inmate.tier < RAINBOW);
      const lift = board.reduce((sum, c) => sum + ctx.v[c.inmate.tier + 1] - ctx.v[c.inmate.tier], 0) / Math.max(1, board.length);
      gain += Math.min(st.params.ivoryCount, board.length) * lift;
      return gain;
    }
    return here.inmate.tier <= ctx.swapCap ? gain : -Infinity;
  }

  // Board value for comparing gifts: tier values plus vaulted Rainbows, with
  // a bonus for inmates that have something to eat.
  function boardValue(st, ctx) {
    let value = st.vault.length * ctx.R;
    for (const c of st.cells) {
      if (c.sealed || !c.inmate) continue;
      value += ctx.v[c.inmate.tier] * (T.devourOptions(st, c.n).length ? 1.25 : 1);
    }
    return value;
  }

  function pickGift(st, ctx, options, random) {
    const P = ctx.P;
    if (P.giftRank) return P.giftRank.find((id) => options.includes(id)) || options[0];
    // Opulence's chain (the user's find): the Brass Horn when it makes a
    // Rainbow now, as each brings 3 more picks; else the Thumb Ring while 3
    // or more picks wait (more inmates); else Crimson Vintage while 2 or more
    // wait (rarities line up for the Horn). On capped Opulence runs it
    // reached 10 Rainbows in 57% of runs, against 27% for the board-value
    // pick below; without the card it changes nothing (3.530 against 3.532).
    if (P.giftChain) {
      const left = st.pending.filter((p) => p.kind === 'gift').length;
      if (options.includes('horn')) {
        for (let i = 0; i < 3; i++) {
          const trial = clone(st);
          trial.rng = (random() * 4294967296) >>> 0;
          if (T.choose(trial, 'horn').ok && trial.vault.length > st.vault.length) return 'horn';
        }
      }
      if (left >= 3 && options.includes('ring') && st.cells.some((c) => c.sealed && c.n !== T.OFFICE)) return 'ring';
      if (left >= 2 && options.includes('wine') && st.cells.some((c) => !c.sealed && c.inmate && c.inmate.tier < T.SUPREME - 1)) return 'wine';
    }
    let best = null;
    for (const id of options) {
      let value = 0;
      const samples = id === 'ring' || id === 'horn' ? 3 : 1;
      for (let i = 0; i < samples; i++) {
        const trial = clone(st);
        trial.rng = (random() * 4294967296) >>> 0;
        if (!T.choose(trial, id).ok) continue;
        value += boardValue(trial, context(trial, P));
      }
      value /= samples;
      if (!best || value > best.value) best = { id, value };
    }
    return best ? best.id : options[0];
  }

  // ---------- Contract challenge ----------

  // True while a new Rainbow couldn't ship: the heavy contract is still to
  // come and too few vouchers are left for the heavy escort a Rainbow needs.
  function rainbowStuck(st) {
    const ch = st.challenge;
    return !!ch && !ch.result && ch.deliveries.length < 3 && ch.vouchers < T.ESCORTS.heavy.cost;
  }

  // The contract the block should get ready for: the next of the first two,
  // in its last `needDays` days. Null otherwise; the heavy contract only
  // needs a high tier, which the rest of the strategy already values.
  function contractNeed(st, P) {
    const ch = st.challenge;
    if (!ch || ch.window || !P.wNeed) return null;
    const slot = ch.deliveries.length;
    if (slot >= 2) return null;
    const contract = ch.contracts[slot];
    if (contract.deadline - st.day >= P.needDays) return null;
    const must = slot === 1 && !ch.deliveries[0].success;
    return { contract, weight: P.wNeed * (must ? P.needCrit : 1) };
  }

  // How many inmates the block is short of meeting a contract, from its
  // composition (tier * 4 + beast counts).
  function contractGap(contract, comp) {
    let size = 0;
    let elite = 0;
    let low = 0;
    let beasts = 0;
    let kin = 2;
    for (let b = 0; b < 4; b++) {
      let any = 0;
      let below = 0;
      for (let t = 0; t < RAINBOW; t++) {
        const k = comp[t * 4 + b];
        if (!k) continue;
        any += k;
        if (t === 2 || t === 3) elite += k;
        if (t <= 1) low += k;
        if (t < 3) below += k;
      }
      size += any;
      if (any) beasts += 1;
      // Kin escort: a Legendary and a lower inmate of its beast.
      const leg = comp[12 + b];
      if (leg && below) kin = 0;
      else if (leg && kin) kin = 1;
    }
    switch (contract.id) {
      case 'mixed': return Math.max(0, 3 - size) + Math.max(0, 2 - beasts);
      case 'cohort': return Math.max(0, 4 - size);
      case 'veteran': return Math.max(0, 1 - elite) + Math.max(0, 2 - low);
      case 'elite': return Math.max(0, 2 - elite) + Math.max(0, 2 - beasts);
      case 'kin': return kin;
      case 'muster': return Math.max(0, 3 - elite);
      default: return 0;
    }
  }

  // The value of a move for the next contract: how much closer it brings the
  // block, on average. `removes` lists [tier, beast] pairs leaving the block;
  // `addDist` gives tier odds for one inmate joining it, of a random beast.
  function needValue(ctx, comp, removes, addDist) {
    const need = ctx.need;
    if (!need) return 0;
    const before = contractGap(need.contract, comp);
    for (const [t, b] of removes) comp[t * 4 + b] -= 1;
    let after = 0;
    if (addDist) {
      for (let t = 0; t < addDist.length; t++) {
        if (!addDist[t] || t >= RAINBOW) continue;
        for (let b = 0; b < 4; b++) {
          comp[t * 4 + b] += 1;
          after += (addDist[t] / 4) * contractGap(need.contract, comp);
          comp[t * 4 + b] -= 1;
        }
      }
      // A Rainbow leaves for the vault, so it adds nobody to the block.
      if (addDist[RAINBOW]) after += addDist[RAINBOW] * contractGap(need.contract, comp);
    } else after = contractGap(need.contract, comp);
    for (const [t, b] of removes) comp[t * 4 + b] += 1;
    return need.weight * (before - after);
  }

  // The inmates that could ship, grouped by tier and beast: inmates in a group
  // are interchangeable for every contract. Within a group, cells with a prey
  // mark or Tusk go last, since they're worth more on the block.
  function cargoGroups(st) {
    const byKey = new Map();
    const add = (tier, beast, ref, last) => {
      const key = tier * 4 + beastIndex(beast);
      let g = byKey.get(key);
      if (!g) byKey.set(key, (g = { tier, beast: beastIndex(beast), refs: [] }));
      g.refs.push({ ref, last });
    };
    for (const c of st.cells) {
      if (c.sealed || !c.inmate) continue;
      add(c.inmate.tier, c.inmate.beast, { cell: c.n }, c.ivory || T.linkOf(st, c.inmate.id) ? 1 : 0);
    }
    for (const v of st.vault) add(RAINBOW, v.beast, { vault: v.id }, 0);
    const groups = [...byKey.values()];
    for (const g of groups) g.refs.sort((a, b) => a.last - b.last);
    return groups;
  }

  // The same tests as the engine's contract check, on counts.
  function fitsContract(contract, a) {
    let beasts = 0;
    for (let b = 0; b < 4; b++) if (a.mask & (1 << b)) beasts += 1;
    switch (contract.id) {
      case 'mixed': return a.size >= 3 && beasts >= 2;
      case 'cohort': return a.size >= 4;
      case 'veteran': return a.elite >= 1 && a.low >= 2;
      case 'elite': return a.elite >= 2 && beasts >= 2;
      case 'kin': return a.leg.some((n, b) => n >= 1 && a.below[b] >= 1);
      case 'muster': return a.elite >= 3;
      default: return a.top >= 1;
    }
  }

  // The best convoy for the open contract by `rate(plan)`, searching how many
  // of each group to send. A plan has the escort, its cost, points, pressure
  // and `kept`: what the inmates sent are worth on the block in tier values.
  // `rate` returns -Infinity to rule a plan out. Returns the best plan with
  // its cells and vault Rainbows, or null when nothing qualifies.
  function planCargo(st, ctx, rate) {
    const ch = st.challenge;
    const contract = T.currentContract(st);
    if (!ch || !contract || ch.vouchers < T.ESCORTS.light.cost) return null;
    const groups = cargoGroups(st);
    const counts = new Array(groups.length).fill(0);
    const escorts = Object.entries(T.ESCORTS).filter(([, e]) => ch.vouchers >= e.cost);
    const cap = Math.max(...escorts.map(([, e]) => e.cap));
    const bounty = contract.bounty ? beastIndex(contract.bounty) : -1;
    let best = null;
    const leaf = () => {
      const a = { size: 0, mask: 0, elite: 0, low: 0, top: 0, leg: [0, 0, 0, 0], below: [0, 0, 0, 0] };
      let points = 0;
      let pressure = 0;
      let kept = 0;
      for (let i = 0; i < groups.length; i++) {
        const k = counts[i];
        if (!k) continue;
        const g = groups[i];
        a.size += k;
        a.mask |= 1 << g.beast;
        if (g.tier === 2 || g.tier === 3) a.elite += k;
        if (g.tier <= 1) a.low += k;
        if (g.tier >= T.SUPREME) a.top += k;
        if (g.tier === 3) a.leg[g.beast] += k;
        else if (g.tier < 3) a.below[g.beast] += k;
        points += k * (2 ** g.tier + (g.tier >= T.SUPREME && g.beast === bounty ? 8 : 0));
        pressure += k * T.PRESSURE[g.tier];
        kept += k * (g.tier >= RAINBOW ? ctx.R : ctx.v[g.tier]);
      }
      if (!a.size || !fitsContract(contract, a)) return;
      for (const [escort, e] of escorts) {
        if (pressure > e.cap) continue;
        const plan = { escort, cost: e.cost, points, pressure, kept, size: a.size };
        const score = rate(plan);
        if (score > -Infinity && (!best || score > best.score)) best = Object.assign(plan, { score, counts: counts.slice() });
      }
    };
    const walk = (i, pressure) => {
      if (i === groups.length) return leaf();
      const g = groups[i];
      for (let k = 0; k <= g.refs.length && pressure + k * T.PRESSURE[g.tier] <= cap; k++) {
        counts[i] = k;
        walk(i + 1, pressure + k * T.PRESSURE[g.tier]);
      }
      counts[i] = 0;
    };
    walk(0, 0);
    if (!best) return null;
    best.cells = [];
    best.vaultIds = [];
    groups.forEach((g, i) => {
      for (const { ref } of g.refs.slice(0, best.counts[i])) {
        if (ref.vault !== undefined) best.vaultIds.push(ref.vault);
        else best.cells.push(ref.cell);
      }
    });
    return best;
  }

  // Ranks plans for the heavy contract, which ends the run: the most points,
  // then the cheaper escort.
  const mostPoints = (plan) => plan.points - 0.01 * plan.cost;

  // The strategy's convoy for the open window. The heavy contract takes the
  // most points. The first two weigh points against what the inmates sent
  // would be worth kept, and hold vouchers back for the heavy contract.
  function convoyPlan(st, ctx) {
    const ch = st.challenge;
    const slot = ch.deliveries.length;
    if (slot >= 2) return planCargo(st, ctx, mostPoints);
    const P = ctx.P;
    const keep = slot === 0 ? P.keep1 : P.keep2;
    // Vouchers to keep after this delivery: the reserve, plus one for
    // contract 2 when this is contract 1. Never fewer than one, or the
    // heavy contract can't ship at all. Contract 2 is a must when contract 1
    // was missed, so then any escort that leaves one voucher will do.
    const must = slot === 1 && !ch.deliveries[0].success;
    const need = must ? P.minLeft : Math.max(P.minLeft, P.reserve + (slot === 0 ? 1 : 0));
    return planCargo(st, ctx, (plan) => {
      const left = ch.vouchers - plan.cost;
      if (left < P.minLeft || (plan.escort !== 'light' && left < need)) return -Infinity;
      return plan.points - keep * plan.kept + 0.001 * plan.points - 0.01 * plan.cost;
    });
  }

  // From day 9, once the first two contracts are settled: ship the heavy
  // contract at the end of the day when its convoy is good enough.
  function wantsEarly(st, ctx) {
    if (!T.canOpenEarly(st) || st.day >= T.CHALLENGE_DAYS || ctx.P.earlyPoints >= 1e9) return false;
    const plan = planCargo(st, ctx, mostPoints);
    if (!plan) return false;
    if (ctx.P.earlyPoints >= 0) return plan.points >= ctx.P.earlyPoints;
    // -1: once nothing more fits in the best escort you can afford.
    const cap = st.challenge.vouchers >= T.ESCORTS.heavy.cost ? T.ESCORTS.heavy.cap : T.ESCORTS.light.cap;
    return cap - plan.pressure < T.PRESSURE[0];
  }

  // ---------- Instruments ----------

  // What each offered instrument adds to the ones already held, in Rainbows
  // per run: the measured set with it against the same set without it. With
  // more held than the data covers, the average over the held instruments'
  // measured subsets. Null when there's no data for these instruments, and
  // in the contract challenge, which plays for points with its own ranking.
  function toolGains(st, options) {
    const data = st.mode !== 'challenge' && COMBOS && COMBOS.single;
    if (!data || !options.every((id) => data.ids.includes(id))) return null;
    if (!data.largest) data.largest = Math.max(...Object.keys(data.v).map((k) => k.length));
    const key = (ids) => ids.map((id) => String.fromCharCode(97 + data.ids.indexOf(id))).sort().join('');
    const value = (ids) => (ids.length ? data.v[key(ids)] : data.base);
    const held = st.tools.filter((id) => data.ids.includes(id));
    const size = Math.min(held.length, data.largest - 1);
    const subsets = [];
    const pick = (from, chosen) => {
      if (chosen.length === size) return subsets.push(chosen);
      for (let i = from; i < held.length; i++) pick(i + 1, [...chosen, held[i]]);
    };
    pick(0, []);
    const gains = {};
    for (const id of options) {
      let sum = 0;
      let n = 0;
      for (const sub of subsets) {
        const a = value([...sub, id]);
        const b = value(sub);
        if (a === undefined || b === undefined) continue;
        sum += a - b;
        n += 1;
      }
      if (!n) return null;
      gains[id] = sum / n;
    }
    return gains;
  }

  // A pet's re-roll: what the best instrument on offer adds, against what
  // the best of a new offer of 3 adds on average (every 3 the re-roll could
  // show, from the instruments neither held nor on offer). Null without
  // measured sets.
  function rerollOdds(st, options) {
    const others = T.TOOL_IDS.filter((id) => !st.tools.includes(id) && !options.includes(id));
    const pool = others.length >= 3 ? others : T.TOOL_IDS.filter((id) => !st.tools.includes(id));
    const gains = toolGains(st, [...new Set([...options, ...pool])]);
    if (!gains || pool.length < 3) return null;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        for (let k = j + 1; k < pool.length; k++) {
          sum += Math.max(gains[pool[i]], gains[pool[j]], gains[pool[k]]);
          n += 1;
        }
      }
    }
    return { now: Math.max(...options.map((id) => gains[id])), next: sum / n };
  }

  const signed = (v) => `${v >= 0 ? '+' : '\u2212'}${Math.abs(v).toFixed(2)}`;

  function wantsReroll(st, P, options) {
    if (!T.canReroll || !T.canReroll(st) || P.toolSets === false) return false;
    const odds = rerollOdds(st, options);
    return !!odds && odds.next > odds.now + P.rerollMargin;
  }

  // The instrument to take: the one that adds the most to what's held, or
  // the trained ranking's best when there's no measured data.
  function pickTool(st, P, options) {
    const gains = P.toolSets !== false && toolGains(st, options);
    if (gains) return options.reduce((best, id) => (gains[id] > gains[best] ? id : best));
    return P.toolRank.find((id) => options.includes(id)) || options[0];
  }

  // ---------- The strategy ----------

  // The move the strategy would play now, as an action object.
  function decide(st, params, random) {
    const ctx = context(st, params || paramsFor(st));
    const P = ctx.P;
    const roll = random || Math.random;
    if (st.phase === 'ended') return null;
    if (st.pending.length) {
      const choice = st.pending[0];
      if (choice.kind === 'gift') return { type: 'choose', id: pickGift(st, ctx, choice.options, roll) };
      if (choice.kind === 'tool' && wantsReroll(st, P, choice.options)) return { type: 'reroll' };
      return { type: 'choose', id: pickTool(st, P, choice.options) };
    }
    if (st.challenge && st.challenge.window) {
      const plan = convoyPlan(st, ctx);
      if (plan) return { type: 'deliver', cells: plan.cells, vaultIds: plan.vaultIds, escort: plan.escort };
      return st.challenge.window.early ? { type: 'close' } : { type: 'skip' };
    }
    // A chain waiting for a pick takes the meal worth the most, or stops
    // (the game's Cancel) when none is worth eating.
    if (st.chaining) {
      const options = devourScores(st, ctx);
      if (ctx.chainStop && (!options.length || options[0].score < P.stopMargin)) return { type: 'stopchain' };
      return options.length ? { type: 'chain', to: options[0].cell } : { type: 'end' };
    }
    if (st.phase === 'office') {
      if (P.office) return { type: 'office', choice: P.office };
      const office = officeValues(st, ctx, composition(st, -1).comp);
      return { type: 'office', choice: office.bestow >= office.instigate ? 'bestow' : 'instigate' };
    }
    if (st.phase === 'event' && st.event) {
      if (st.event.kind === 'chain') return { type: 'event', accept: !!P.acceptChain };
      // Ravenous Appetite, High-Risk Convict, Crow Whispers and Taste of
      // Freedom only add.
      // The Sewer Ratway's move can stay put, so it only adds too, and the
      // "Treasure" Hunt's card has only Confirm.
      if (['appetite', 'convict', 'crow', 'freedom', 'usurp1', 'usurp2', 'usurp3', 'usurp4', 'ratway', 'hunt'].includes(st.event.kind)) return { type: 'event', accept: true };
      const exec = st.cells[st.event.cell].inmate;
      if (!exec) return { type: 'event', accept: false };
      // Behind Closed Doors: a free Supreme, unless it already is one.
      if (st.event.kind === 'trickster') return { type: 'event', accept: exec.tier < T.SUPREME };
      const { comp } = composition(st, st.event.cell);
      return { type: 'event', accept: executionValue(ctx, exec.tier, beastIndex(exec.beast), comp) > P.execMargin };
    }
    if (st.phase === 'patrol') {
      const scores = patrolScores(st, ctx);
      return scores.length ? { type: 'patrol', cell: scores[0].cell } : { type: 'end' };
    }
    // Manage: devour, swap or end the day. Both act on the warden's cell,
    // and a day has one or the other, not both. With the Blood-Stained Trap,
    // a Hunt on a Lion is the third choice.
    const swapGain = swapGainHere(st, ctx);
    const hunt = bestHunt(st, ctx);
    if (T.canDevourNow(st)) {
      const devours = devourScores(st, ctx);
      if (devours.length && devours[0].score >= P.minDevour) {
        if (hunt && hunt.value > devours[0].score && hunt.value > swapGain) return { type: 'hunt', to: hunt.cell };
        // The swap instead, when it's worth more than the best devour.
        if (swapGain > 0 && swapGain > devours[0].score + P.swapMargin) return { type: 'swap' };
        return { type: 'devour', to: devours[0].cell };
      }
    }
    if (hunt && hunt.value > 0 && hunt.value > swapGain) return { type: 'hunt', to: hunt.cell };
    if (swapGain > 0) return { type: 'swap' };
    if (st.challenge && wantsEarly(st, ctx)) return { type: 'early' };
    return { type: 'end' };
  }

  function apply(st, action) {
    switch (action.type) {
      case 'choose': return T.choose(st, action.id);
      case 'reroll': return T.rerollOffer ? T.rerollOffer(st) : { ok: false };
      case 'event': return T.resolveEvent(st, action.accept);
      case 'patrol': return T.patrol(st, action.cell);
      case 'devour': return T.devour(st, st.position, action.to);
      case 'chain': return T.chainBite(st, action.to);
      case 'stopchain': return T.stopChain(st);
      case 'office': return T.officeAct(st, action.choice);
      case 'swap': return T.swap(st, st.position);
      case 'hunt': return T.hunt(st, action.to);
      case 'end': return T.endDay(st);
      case 'deliver': return T.deliver(st, action.cells, action.vaultIds, action.escort);
      case 'skip': return T.skipDelivery(st);
      case 'close': return T.cancelEarlyDelivery(st);
      case 'early': return T.openEarlyDelivery(st);
      default: return { ok: false, reason: 'Unknown move.' };
    }
  }

  // Plays a run to the end with the strategy. `onMove` sees each move.
  function playout(st, params, random, onMove) {
    const roll = random || Math.random;
    // A drill's Rainbows can't grow past a full vault: the playout is done.
    const full = () => st.mode !== 'challenge' && T.VAULT_SLOTS && st.vault.length >= T.VAULT_SLOTS;
    for (let guard = 0; st.phase !== 'ended' && guard < 2000 && !full(); guard++) {
      const action = decide(st, params, roll);
      if (!action) break;
      const result = apply(st, action);
      if (onMove) onMove(action, result, st);
      if (!result.ok && !(action.type !== 'end' && apply(st, { type: 'end' }).ok)) break;
    }
    return st;
  }

  // ---------- Monte Carlo solver ----------

  // A copy without the log, which playouts don't need.
  function clone(st) {
    const log = st.log;
    st.log = [];
    const copy = jsonCopy(st);
    st.log = log;
    return copy;
  }

  // What JSON.parse(JSON.stringify(v)) makes of plain data, without the text
  // in between (playouts copy the state thousands of times a second): keys
  // holding undefined or a function are left out, and NaN, Infinity and -0
  // become null, null and 0.
  function jsonCopy(v) {
    if (typeof v !== 'object' || v === null) return typeof v === 'number' ? (Number.isFinite(v) ? v + 0 : null) : v;
    if (typeof v.toJSON === 'function') return JSON.parse(JSON.stringify(v));
    if (Array.isArray(v)) {
      const out = new Array(v.length);
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        out[i] = x === undefined || typeof x === 'function' || typeof x === 'symbol' ? null : jsonCopy(x);
      }
      return out;
    }
    const out = {};
    for (const k of Object.keys(v)) {
      const x = v[k];
      if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
      out[k] = jsonCopy(x);
    }
    return out;
  }

  // Re-rolls everything the player can't see: the game's dice, and any
  // occupant behind a door that hasn't been fully revealed.
  function hideFuture(st, seed) {
    const random = rng32(seed);
    st.rng = (random() * 4294967296) >>> 0;
    for (const c of st.cells) {
      // An event whose kind the player can't see (behind a door, or in an
      // open cell) is any of them, evenly. A door the warden hasn't walked
      // past may hide one the player can't see.
      const pool = st.eventPool || T.EVENT_POOL;
      if (c.event && c.eventKnown === false) c.event = pool[Math.floor(random() * pool.length)];
      if (c.sealed && c.seen === false && !c.nest) c.event = random() * 100 < st.params.eventChance ? pool[Math.floor(random() * pool.length)] : null;
      if (!c.sealed || !c.hidden || c.known >= 2) continue;
      if (c.known === 1) c.hidden.beast = BEASTS[Math.floor(random() * 4)];
      else c.hidden = null;
    }
  }

  // The moves worth comparing at this point of the run, with labels.
  function candidates(st) {
    const out = [];
    if (st.phase === 'ended') return out;
    if (st.pending.length) {
      for (const id of st.pending[0].options) out.push({ action: { type: 'choose', id }, label: `Take ${T.toolName(id)}` });
      if (T.canReroll && T.canReroll(st)) out.push({ action: { type: 'reroll' }, label: 'Re-roll the offer' });
      return out;
    }
    if (st.challenge && st.challenge.window) {
      out.push(...convoyOptions(st));
      if (st.challenge.window.early) out.push({ action: { type: 'close' }, label: 'Close the early window' });
      else out.push({ action: { type: 'skip' }, label: 'Skip this contract' });
      return out;
    }
    if (st.chaining) {
      for (const o of T.chainOptions(st)) {
        const target = st.cells[o.cell];
        const meal = o.scratch ? 'the scratched door' : `the ${T.describe(target.inmate)}`;
        out.push({ action: { type: 'chain', to: o.cell }, label: `Chain on: eat ${meal} in ${T.cellLabel(o.cell)}` });
      }
      if (T.canStopChain && T.canStopChain(st)) out.push({ action: { type: 'stopchain' }, label: 'Stop the chain (Cancel)' });
      return out;
    }
    if (st.phase === 'office') {
      out.push({ action: { type: 'office', choice: 'bestow' }, label: 'Bestow: 1 random inmate rises a tier' });
      out.push({ action: { type: 'office', choice: 'instigate' }, label: `Instigate: ${(T.instigateCount ? T.instigateCount(st) : T.INSTIGATE_EVENTS) === 1 ? 'a new special event' : `${T.instigateCount ? T.instigateCount(st) : T.INSTIGATE_EVENTS} new special events`}` });
      return out;
    }
    if (st.phase === 'event' && st.event) {
      // Event names that read as names (Behind Closed Doors) take no "the".
      const name = `${['chain', 'execution'].includes(st.event.kind) ? 'the ' : ''}${T.eventName(st.event.kind)}`;
      // The "Treasure" Hunt's card has only Confirm.
      if (st.event.kind === 'hunt') {
        out.push({ action: { type: 'event', accept: true }, label: `Confirm ${name}` });
        return out;
      }
      out.push({ action: { type: 'event', accept: true }, label: `Accept ${name}` });
      out.push({ action: { type: 'event', accept: false }, label: `Skip ${name}` });
      return out;
    }
    if (st.phase === 'patrol') {
      if (T.canOpenEarly(st)) out.push({ action: { type: 'early' }, label: 'Deliver the heavy contract early' });
      for (const n of T.patrolOptions(st)) {
        const c = st.cells[n];
        const opens = st.chain ? T.clockwisePath(st, n).filter((k) => st.cells[k].sealed).length : 0;
        const what = st.chain ? `the chain opens ${T.plural(opens, 'door')}` : n === T.OFFICE ? 'Instigate or Bestow' : c.sealed ? (c.nest ? 'the rat nest' : c.event ? 'a locked door with an event' : 'a locked door') : c.inmate ? `the ${T.describe(c.inmate)}` : 'an empty cell';
        // The office's card in the game reads "Go to Interrogation Room".
        const where = n === T.OFFICE ? 'Interrogation Room' : `cell ${T.cellLabel(n)}`;
        out.push({ action: { type: 'patrol', cell: n }, label: `Go to ${where} (${what})` });
      }
      return out;
    }
    const here = st.cells[st.position];
    for (const o of T.startOptions(st)) {
      const target = st.cells[o.cell];
      const meal = o.scratch ? `the scratched door` : `the ${T.describe(target.inmate)}`;
      out.push({ action: { type: 'devour', to: o.cell }, label: `Consume ${meal} in ${T.cellLabel(o.cell)}` });
    }
    if (canSwapNow(st) && here && !here.sealed && here.inmate) {
      out.push({ action: { type: 'swap' }, label: `Replace the ${T.describe(here.inmate)} in ${T.cellLabel(here.n)}` });
    }
    // The Blood-Stained Trap's Hunt: a Prey mark on an inmate the Lion here can consume.
    if (T.canHuntNow && T.canHuntNow(st)) {
      for (const n of T.huntTargets(st)) out.push({ action: { type: 'hunt', to: n }, label: `Hunt: a Prey mark on the ${T.describe(st.cells[n].inmate)} in ${T.cellLabel(n)}` });
    }
    if (T.canOpenEarly(st)) out.push({ action: { type: 'early' }, label: 'Deliver the heavy contract early' });
    out.push({ action: { type: 'end' }, label: st.mode === 'drill' && st.day >= st.maxDays ? 'Finish the run' : 'End the day' });
    return out;
  }

  const sameSet = (a, b) => (a || []).length === (b || []).length && (a || []).every((x) => (b || []).includes(x));
  const sameAction = (a, b) => !!a && !!b && a.type === b.type && a.cell === b.cell && a.to === b.to && a.id === b.id && a.accept === b.accept && a.choice === b.choice
    && (a.type !== 'deliver' || (a.escort === b.escort && sameSet(a.cells, b.cells) && sameSet(a.vaultIds, b.vaultIds)));

  // Names a convoy: its inmates with their cells, the escort and the points.
  function cargoLabel(st, action, points) {
    const names = [...action.cells.map((n) => `${T.describe(st.cells[n].inmate)} ${T.cellLabel(n)}`), ...action.vaultIds.map(() => 'a vault Rainbow')];
    return `Send ${names.join(', ')} by ${action.escort} escort (${T.plural(points, 'point')})`;
  }

  // Convoys worth comparing in the open window: the strategy's pick, the most
  // points, the most points by light escort, and the cheapest cargo that
  // meets the contract. While the heavy contract is still to come, each one
  // keeps a voucher for it. The heavy contract ends the run, so for it the
  // strategy's pick (the most points) is the only convoy.
  function convoyOptions(st, params) {
    const ctx = context(st, params || paramsFor(st));
    const ch = st.challenge;
    const heavyNext = ch.deliveries.length < 2;
    const ok = (plan) => !heavyNext || ch.vouchers - plan.cost >= 1;
    const plans = [['pick', convoyPlan(st, ctx)]];
    if (heavyNext) {
      plans.push(
        ['most', planCargo(st, ctx, (p) => (ok(p) ? mostPoints(p) : -Infinity))],
        ['light', planCargo(st, ctx, (p) => (ok(p) && p.escort === 'light' ? mostPoints(p) : -Infinity))],
        ['least', planCargo(st, ctx, (p) => (ok(p) && p.escort === 'light' ? 0.001 * p.points - p.kept : -Infinity))],
      );
    }
    const out = [];
    for (const [kind, plan] of plans) {
      if (!plan) continue;
      const action = { type: 'deliver', cells: plan.cells.slice().sort((a, b) => a - b), vaultIds: plan.vaultIds.slice(), escort: plan.escort };
      if (out.some((c) => sameAction(c.action, action))) continue;
      out.push({ action, label: cargoLabel(st, action, plan.points), kind, points: plan.points });
    }
    return out;
  }

  // A finished playout's value. Drills count Rainbows vaulted. The challenge
  // counts passing first, then points: a pass is worth PASS_WEIGHT points,
  // so 1% of pass chance is worth 10 points.
  const PASS_WEIGHT = 1000;

  // The standard error of the mean difference between two options' values on
  // the same dice (rounds an option couldn't play are NaN and skipped).
  function pairedSe(a, b) {
    let n = 0;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < a.length && i < b.length; i++) {
      const d = a[i] - b[i];
      if (Number.isNaN(d)) continue;
      n += 1;
      sum += d;
      sq += d * d;
    }
    if (n < 2) return Infinity;
    const m = sum / n;
    return Math.sqrt(Math.max(0, sq / n - m * m) / n);
  }

  // Ranks played-out rows ({ label, action, vals, pass, points, best, ... })
  // by value, after `rounds` of `target`. The analyzer also merges the rows
  // several workers played out with it: rows whose vals line up round by
  // round keep their common dice, and so their paired margins.
  function summarize(rows, rounds, target, goal) {
    const ranked = rows
      .map((r) => {
        let n = 0;
        let sum = 0;
        let sq = 0;
        for (const x of r.vals) {
          if (Number.isNaN(x)) continue;
          n += 1;
          sum += x;
          sq += x * x;
        }
        const mean = n ? sum / n : 0;
        const sd = n > 1 ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0;
        return { row: r, mean, se: n > 1 ? sd / Math.sqrt(n) : 0, n };
      })
      .sort((a, b) => b.mean - a.mean || b.row.best - a.row.best);
    const top = ranked[0];
    const options = ranked.map(({ row, mean, se, n }) => ({
      label: row.label,
      action: row.action,
      kind: row.kind,
      mean,
      se,
      gapSe: row === top.row ? 0 : pairedSe(top.row.vals, row.vals),
      n,
      pass: n ? row.pass / n : 0,
      points: n ? row.points / n : 0,
      best: n ? row.best / n : 0,
      policy: row.policy,
      extra: row.extra,
    }));
    return { done: rounds >= target || rows.length <= 1, rounds, goal, options };
  }

  // Plays every candidate out `rollouts` times and ranks them by value. Each
  // round of playouts shares its dice across candidates (common random
  // numbers), so the differences between moves are measured, not the luck;
  // `gapSe` is each option's paired margin against the leader. `extra` adds
  // candidates, such as a convoy the player is putting together.
  // Returns a stepper: call step(budgetMs) until it reports done.
  // `stream` splits the work between workers: each plays its own rounds of
  // dice, and the pick and candidates are the same in all (summarize merges
  // them).
  function solve(st, opts) {
    const o = Object.assign({ rollouts: 400, seed: 1, stream: 0, params: null, extra: null }, opts || {});
    const base = clone(st);
    const list = candidates(base);
    for (const e of o.extra || []) if (!list.some((c) => sameAction(c.action, e.action))) list.push(Object.assign({ extra: true }, e));
    const random = rng32(o.stream ? (o.seed ^ Math.imul(o.stream, 0x9e3779b1)) >>> 0 : o.seed);
    const pick = list.length ? decide(clone(base), o.params, rng32(o.seed ^ 0x5bd1e995)) : null;
    const goal = base.mode === 'challenge' ? 'contract' : 'rainbows';
    const rows = list.map((c) => ({ label: c.label, action: c.action, kind: c.kind || null, extra: !!c.extra, vals: [], pass: 0, points: 0, best: 0, policy: sameAction(c.action, pick) }));
    let round = 0;
    const result = () => summarize(rows, round, o.rollouts, goal);
    return {
      rows,
      step(budgetMs) {
        const stop = Date.now() + (budgetMs || 50);
        while (round < o.rollouts && rows.length > 1 && Date.now() < stop) {
          const seed = (random() * 4294967296) >>> 0;
          for (const row of rows) {
            const trial = clone(base);
            hideFuture(trial, seed);
            if (!apply(trial, row.action).ok) {
              row.vals.push(NaN);
              continue;
            }
            const roll = rng32(seed ^ 0x9e3779b9);
            playout(trial, o.params, roll);
            if (goal === 'contract') {
              const res = trial.challenge.result;
              const passed = !!(res && res.passed);
              row.pass += passed ? 1 : 0;
              row.points += trial.challenge.score;
              row.vals.push((passed ? PASS_WEIGHT : 0) + trial.challenge.score);
            } else {
              row.vals.push(trial.vault.length);
              // Second measure: the best rarity reached.
              row.best += Math.max(0, ...trial.cells.filter((c) => !c.sealed && c.inmate).map((c) => c.inmate.tier), trial.vault.length ? RAINBOW : 0);
            }
          }
          round += 1;
        }
        return result();
      },
    };
  }

  // ---------- Trainer helpers ----------

  // The strategy's own pick with a short reason. Instant: no playouts.
  function instant(st, params) {
    const P = params || paramsFor(st);
    const action = decide(st, P, rng32(1));
    if (!action) return null;
    const match = candidates(st).find((c) => sameAction(c.action, action));
    return { action, label: match ? match.label : action.type, why: reason(st, action, P) };
  }

  function reason(st, action, params) {
    const ctx = context(st, params);
    const here = st.cells[st.position];
    switch (action.type) {
      case 'patrol': {
        const s = patrolScores(st, ctx).find((x) => x.cell === action.cell);
        return s ? `${s.why[0].toUpperCase()}${s.why.slice(1)}.` : '';
      }
      case 'devour': {
        const odds = chainOdds(st, st.position, action.to);
        // A day has a devour or a swap, not both.
        const over = swapGainHere(st, ctx) > 0 ? ' It beats a Replace here, and a day has one or the other.' : '';
        return `The best first meal: picking its later meals well, its chain averages ${odds.bites.toFixed(1)} bites, with ${(100 * odds.rainbow).toFixed(0)}% to reach Rainbow.${over}`;
      }
      case 'chain': {
        const odds = chainOdds(st, st.position, action.to);
        return `The best next meal: going on with the best meal each time, the chain averages ${odds.bites.toFixed(1)} more bites, with ${(100 * odds.rainbow).toFixed(0)}% to reach Rainbow.`;
      }
      case 'stopchain':
        return 'No meal left is worth eating: each would cost more than it gains, so press Cancel and keep them on the block.';
      case 'office':
        return action.choice === 'bestow' ? 'A random inmate rises a tier now, which beats a couple of new event doors.' : 'The block is thin, so new event doors are worth more than raising it.';
      case 'swap': {
        // A day has a swap or a devour, not both.
        const over = T.startOptions(st).length ? ' That beats today’s best consume, and a day has one or the other.' : '';
        const maiden = maidenBonus(ctx, here.inmate.tier);
        const odds = `${(100 * maiden.chance).toFixed(0)}% of the time`;
        if (here.ivory) return `A Tusk cell: replacing its inmate raises other inmates a tier${maiden.chance > 0 ? `, and the Severed Iron Maiden adds 3 tiers to the new inmate ${odds}` : ''}.${over}`;
        if (ctx.scapegoat) return `The Scapegoat's Guillotine brings the new inmate in above ${T.tierName(here.inmate.tier)}${here.inmate.tier >= T.SUPREME ? ', a Chromatic' : ''}, worth more than the 2 random inmates it removes.${over}`;
        if (maiden.chance > 0) return `The Severed Iron Maiden adds 3 tiers to the new inmate ${odds}, so a fresh roll beats this ${T.tierName(here.inmate.tier)} inmate on average.${over}`;
        if (ctx.axeDoors) return `A ${T.tierName(here.inmate.tier)} inmate is worth less than a fresh roll on average, and a higher roll makes the Gaoler's Execution Axe open ${T.plural(ctx.axeDoors, 'door')}.${over}`;
        return `A ${T.tierName(here.inmate.tier)} inmate is worth less than a fresh roll on average.${over}`;
      }
      case 'hunt': {
        const prey = st.cells[action.to].inmate;
        const over = T.startOptions(st).length || swapGainHere(st, ctx) > 0 ? ' That beats today’s consume or Replace, and a day has one of them.' : '';
        return `A Prey mark: this Lion and the ${T.describe(prey)} each rise a tier every morning for ${T.plural(st.params.preyRounds, 'morning')}, as long as both stay on the block and keep their beasts.${over}`;
      }
      case 'end': {
        if (!T.canDevourNow(st) || !T.startOptions(st).length) return 'Nothing left today is worth doing.';
        // A devour is skipped only when it costs more than it gains: nearly
        // always because it would end a prey mark.
        const marked = here && here.inmate && T.linkOf(st, here.inmate.id) ? here.inmate : T.startOptions(st).map((o) => st.cells[o.cell].inmate).find((m) => m && T.linkOf(st, m.id));
        if (marked) return 'Skip today’s consume: it would end a prey mark, and the free tier each morning is worth more than one bite.';
        return 'Every consume here would cost more than it gains today.';
      }
      case 'event': {
        if (st.event.kind === 'chain') return action.accept ? 'Your next walk opens every sealed door on the way.' : 'More inmates would hurt this block today.';
        if (st.event.kind === 'trickster') {
          const who = st.cells[st.event.cell].inmate;
          return action.accept ? `The ${T.describe(who)} becomes a Supreme, one step from Rainbow.` : 'It is already a Supreme; accepting would only change its beast.';
        }
        if (st.event.kind === 'appetite') return `The lowest-rarity inmate gets ${T.APPETITE_TRIES} tries at +1 tier, for ${(T.APPETITE_TRIES * T.APPETITE_ODDS).toFixed(1)} tiers on average.`;
        if (st.event.kind === 'convict') return 'Another cell opens on a Legendary inmate, with no patrol needed.';
        if (st.event.kind === 'crow') return `Free information: the rarity behind the next ${T.CROW_CELLS} locked doors.`;
        if (st.event.kind === 'freedom') return `Free inmates: ${T.FREEDOM_CELLS} more locked cells open.`;
        if (st.event.kind === 'usurp1') return 'A random inmate rises a tier, and Usurpation II joins the events.';
        if (st.event.kind === 'usurp2') return 'Two random inmates rise a tier, and Usurpation III joins the events.';
        if (st.event.kind === 'usurp3') return 'Two random inmates rise 2 tiers each, and Usurpation IV joins the events.';
        if (st.event.kind === 'usurp4') return 'Every inmate on the block rises 2 tiers.';
        if (st.event.kind === 'ratway') return 'A free move to any cell but the office: the best door or inmate on the whole block, not just the next six cells.';
        if (st.event.kind === 'hunt') return 'Free information, and its card has only Confirm: every locked door holding a Normal or Magic shows its rarity, so the doors left dark hold Rare or better.';
        const exec = st.cells[st.event.cell].inmate;
        const victims = T.executionVictims(st, st.event.cell).length;
        return action.accept ? `The ${T.describe(exec)} removes ${T.plural(victims, 'inmate')} and rises as many tiers: it gains more than it removes.` : 'It would remove more than it gains.';
      }
      case 'choose': {
        if (st.pending[0].kind === 'gift') {
          // Opulence: more picks wait at this Treasure, and the advice
          // weighs them.
          const picks = st.pending.filter((p) => p.kind === 'gift').length;
          return picks > 1 ? `Worth the most on this board with the picks to come: ${picks} picks wait at this Treasure, this one included.` : 'Worth the most on this board right now.';
        }
        const gains = ctx.P.toolSets !== false && toolGains(st, st.pending[0].options);
        if (gains && gains[action.id] !== undefined) {
          const add = gains[action.id];
          const held = st.tools.length === 1 ? `With the ${T.toolName(st.tools[0])}, it` : st.tools.length ? 'With the instruments you hold, it' : 'It';
          const odds = T.canReroll && T.canReroll(st) ? rerollOdds(st, st.pending[0].options) : null;
          const vs = odds ? ` A re-roll's best would add about ${signed(odds.next)} on average.` : '';
          return `${held} adds about ${signed(add)} Rainbows per run in simulated runs.${vs}`;
        }
        const rank = ctx.P.toolRank.indexOf(action.id);
        return rank >= 0 ? `Ranked #${rank + 1} of ${ctx.P.toolRank.length} tools in training.` : '';
      }
      case 'reroll': {
        const odds = rerollOdds(st, st.pending[0].options);
        return odds
          ? `The best instrument on offer adds about ${signed(odds.now)} Rainbows per run; a new offer's best adds about ${signed(odds.next)} on average.`
          : 'A new offer is likely to hold a better instrument.';
      }
      case 'deliver': return convoyWhy(st, action, params);
      case 'skip': return 'Nothing on the block meets this contract.';
      case 'close': return 'Nothing meets the heavy contract yet.';
      case 'early': return ctx.P.earlyPoints < 0
        ? 'The heavy convoy is as full as your escort allows, so waiting can’t add points. Shipping now locks in the pass.'
        : ctx.P.earlyPoints < 1e9
          ? `The heavy convoy scores at least ${ctx.P.earlyPoints} points now. Shipping locks in the pass.`
          : 'The heavy contract can be met now. Shipping it ends the run.';
      default: return '';
    }
  }

  // Why the strategy loads this convoy: what it keeps, and the vouchers left.
  function convoyWhy(st, action, params) {
    const ch = st.challenge;
    if (!action.cells) return '';
    const slot = ch.deliveries.length;
    if (slot >= 2) return 'The heavy contract ends the run, so it takes the most points your vouchers can escort.';
    const P = withDefaults(params || paramsFor(st));
    const keep = slot === 0 ? P.keep1 : P.keep2;
    const sent = new Set(action.cells);
    const kept = st.cells
      .filter((c) => !c.sealed && c.inmate && !sent.has(c.n))
      .sort((a, b) => b.inmate.tier - a.inmate.tier)
      .slice(0, 2)
      .map((c) => `${T.describe(c.inmate)} ${T.cellLabel(c.n)}`);
    const left = ch.vouchers - T.ESCORTS[action.escort].cost;
    const next = slot === 0 ? 'the next contracts' : 'the heavy contract';
    const keepText = kept.length ? ` Your ${kept.join(' and ')} stay for ${next}.` : '';
    const voucherText = left >= T.ESCORTS.heavy.cost
      ? ` It leaves ${T.plural(left, 'voucher')}, so the heavy contract can still go by heavy escort.`
      : ` It leaves ${T.plural(left, 'voucher')}.`;
    const lead = keep >= 1 ? 'Meets the contract with the inmates worth least to you.' : keep > 0 ? 'Meets the contract with the most points it can spare.' : 'Meets the contract for the most points.';
    return `${lead}${keepText}${voucherText}`;
  }

  // The move that turned `before` into `after`, as an action, or null if it
  // wasn't a game move (a Lab edit, say).
  function moveBetween(before, after) {
    if (!before || !after || before.phase === 'ended') return null;
    // The log entries the move added. The log only grows, though it drops its
    // oldest lines, so find where the last few lines it had before now sit.
    const n = before.log.length;
    const tail = Math.min(5, n);
    const same = (a, b) => a && b && a.d === b.d && a.k === b.k && a.t === b.t;
    const fits = (p) => {
      for (let k = 1; k <= tail; k++) if (!same(after.log[p - k], before.log[n - k])) return false;
      return true;
    };
    let from = 0;
    for (let p = Math.min(after.log.length, n); p >= tail; p--) {
      if (fits(p)) {
        from = p;
        break;
      }
    }
    const added = after.log.slice(from);
    const recent = (types) => {
      for (const e of added) if (e.x && types.includes(e.x.type)) return e.x;
      return null;
    };
    // While a choice is pending, nothing but the choice can be made.
    if (before.pending.length) {
      const x = recent(['tool', 'gift']);
      return x ? { type: 'choose', id: x.id } : null;
    }
    const ch0 = before.challenge;
    const ch1 = after.challenge;
    if (ch0 && ch0.window) {
      if (ch1.deliveries.length > ch0.deliveries.length) {
        if (!ch1.deliveries[ch1.deliveries.length - 1].success) return { type: 'skip' };
        const x = recent(['deliver']);
        return x && x.cells ? { type: 'deliver', cells: x.cells, vaultIds: x.vault || [], escort: x.escort } : { type: 'deliver' };
      }
      return ch1.window ? null : { type: 'close' };
    }
    if (ch1 && ch1.window && ch1.window.early && !(ch0 && ch0.window)) return { type: 'early' };
    if (before.phase === 'event') {
      if (after.phase === 'event') return null;
      const x = recent(['skipped', 'armed', 'execution', 'trickster', 'appetite', 'convict', 'crow', 'freedom', 'usurp1', 'usurp2', 'usurp3', 'usurp4', 'ratway', 'hunt']);
      return x ? { type: 'event', accept: x.type !== 'skipped' } : null;
    }
    if (before.phase === 'office') {
      const x = recent(['instigate', 'bestow']);
      return x ? { type: 'office', choice: x.type } : null;
    }
    // A pick inside a chain: the bite after the ones the chain had. A chain
    // that ended logs its record where it began, before the lines compared.
    if (before.chaining) {
      const n = before.chaining.bites.length;
      const done = [...after.log].reverse().find((e) => e.x && e.x.type === 'devour');
      const bites = after.chaining ? after.chaining.bites : done ? done.x.bites : null;
      if (bites && bites[n]) return { type: 'chain', to: bites[n].cell };
      return !after.chaining && after.phase !== 'ended' ? { type: 'stopchain' } : null;
    }
    // The Sewer Ratway's move isn't counted as a patrol.
    if (before.phase === 'patrol') return after.stats.patrols > before.stats.patrols || (before.ratway && !after.ratway) ? { type: 'patrol', cell: after.position } : null;
    if (after.used.devour > before.used.devour) {
      if (after.chaining) return { type: 'devour', to: after.chaining.bites[0].cell };
      const x = recent(['devour']);
      return x ? { type: 'devour', to: x.bites[0].cell } : null;
    }
    if (after.used.swap > before.used.swap) return { type: 'swap' };
    // The Blood-Stained Trap's Hunt, which logs the marked cell.
    if (after.used.hunt && !before.used.hunt) {
      const x = recent(['trap']);
      return x ? { type: 'hunt', to: x.cell } : null;
    }
    if (after.day > before.day || after.phase === 'ended' || (ch1 && ch1.window && !(ch0 && ch0.window))) return { type: 'end' };
    return null;
  }

  const api = { DEFAULTS, PROFILES, PASS_WEIGHT, paramsFor, instant, moveBetween, sameAction, decide, apply, playout, candidates, solve, summarize, chainOdds, patrolScores, devourScores, context, composition, clone, hideFuture, rng32, executionValue, planCargo, mostPoints, convoyPlan, convoyOptions, cargoLabel };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TartarusSolver = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);

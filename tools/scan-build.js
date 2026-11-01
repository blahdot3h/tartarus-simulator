#!/usr/bin/env node
/* Tartarus Simulator: builds js/scan-data.js, the screenshot reader's
 * reference data, from labeled screenshots of the live game.
 *
 *   node tools/scan-build.js [--dir trainingdata]
 *
 * The screenshots aren't in the repo (see .gitignore); tools/scan-truth.json
 * holds their labels. What it makes:
 *  - board: points on the board's fixed frame, for finding it at any scale
 *  - faces: each beast's face, from labeled portraits
 *  - digits: digit shapes, from the day counter, door cards and cell numbers
 *  - tools: each torture instrument's art, from the panel icons and the
 *    reward cards */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./png.js');
const S = require('../js/scan.js');

const ROOT = path.join(__dirname, '..');
const argDir = process.argv.indexOf('--dir');
const DIR = path.resolve(ROOT, argDir > 0 ? process.argv[argDir + 1] : 'trainingdata');
const TRUTH = JSON.parse(fs.readFileSync(path.join(__dirname, 'scan-truth.json'), 'utf8'));
const BOARD_REF = 'chrome_avP3jtNJHL.png';

// The instruments, with the simulator tool each one is (null: not simulated
// yet), and where its art is on a reward card screenshot.
const TOOLS = {
  scales: { name: "Warden's Scales", sim: 'scales', card: ['chrome_D9Kttgh2tL.png', 395, 245, 140, 140] },
  noose: { name: "Hangman's Noose", sim: 'rope', card: ['chrome_D9Kttgh2tL.png', 895, 180, 100, 170] },
  pestle: { name: 'Iron Pestle', sim: 'pestle', card: ['chrome_D9Kttgh2tL.png', 1365, 230, 120, 170] },
  brand: { name: 'Searing Branding Iron', sim: 'fire', card: ['chrome_EslGxHjQL3.png', 395, 275, 140, 145] },
  keys: { name: 'Lost Ring of Keys', sim: 'keys', card: ['chrome_EslGxHjQL3.png', 880, 225, 130, 140] },
  hook: { name: 'Sorting Hook', sim: 'hook', card: ['chrome_EslGxHjQL3.png', 1370, 265, 110, 160] },
  tongs: { name: 'Iron Tongs of Lust: Mammoth', sim: 'tongs', card: ['chrome_tWbki0rB4N.png', 400, 250, 130, 140] },
  skewer: { name: 'Skewered Rat Heads: Colossal Rat', sim: 'skewer', card: ['chrome_tWbki0rB4N.png', 875, 195, 140, 160] },
  guillotine: { name: 'Fanged Guillotine: Alpha Wolf', sim: 'guillotine', card: ['chrome_tWbki0rB4N.png', 1355, 250, 140, 140] },
  casket: { name: "Avenger's Casket", sim: 'revenge', card: ['chrome_ZjcmxiWWmC.png', 350, 235, 140, 150] },
  muzzle: { name: "Raging Beast's Agonizing Muzzle", sim: 'muzzle', card: ['chrome_ZjcmxiWWmC.png', 830, 190, 140, 150] },
  // Its panel icon: report 25, a player's "Report a wrong reading" (read as the Crowded Beastcage, whose report-21 icon it was closer to).
  saw: { name: 'Rusty Saw', sim: 'saw', card: ['chrome_ZjcmxiWWmC.png', 1305, 240, 140, 150], icons: ['report-25-saw-days13.png'] },
  ironbox: { name: 'Squirming Iron Box: Colossal Rat', sim: 'ironbox', card: null },
  axe: { name: "Gaoler's Execution Axe", sim: 'axe', card: ['cards_2026-10-15_axe_shackles_collar.png', 222, 180, 118, 175] },
  shackles: { name: 'Long-Chained Shackles', sim: 'shackles', card: ['cards_2026-10-15_axe_shackles_collar.png', 670, 235, 153, 150] },
  collar: { name: "Maddened Beast's Barbed Collar", sim: 'collar', card: ['cards_2026-10-15_axe_shackles_collar.png', 1150, 235, 150, 165] },
  // From players' reports: the Beastcage's panel icon (report 7) and the
  // Severed Iron Maiden's (report 9), as PNG.
  // Its panel icon: report 21, a player's "Report a wrong reading" (read as
  // the Rusty Saw), cropped to the instrument panel.
  cage: { name: 'Crowded Beastcage', sim: 'cage', card: ['report-7-crowded-beastcage.png', 16, 192, 68, 118], icons: ['report-21-crowded-beastcage-panel.png'] },
  maiden: { name: 'Severed Iron Maiden', sim: 'maiden', card: null, icons: ['report-9-severed-iron-maiden.png'] },
  // Report 11 shows the whip's card. Report 10's panel icon, a red ring
  // with a tail, was dropped: it may be the whip, the Ravenous Chains or the
  // Barbed Collar, and as the whip it drew the user's Collar.
  whip: { name: 'Barbed Whip', sim: 'whip', card: ['report-11-barbed-whip-card.png', 440, 160, 120, 118] },
  // Cards from the user's screenshot and players' reports (2026-10-16).
  stake: { name: 'Burning Stake', sim: 'stake', card: ['user-burning-stake-card.png', 225, 105, 115, 190] },
  coin: { name: "Kin's Coin of Fate", sim: 'coin', card: ['report-17-kins-coin-card.png', 210, 180, 195, 195] },
  scapegoat: { name: "Scapegoat's Guillotine", sim: 'scapegoat', card: ['report-12-scapegoat-card.png', 170, 125, 130, 145] },
  // Its card art: report 28, a player's screenshot of the card (the reader
  // had nothing for it, and read a held Dog Tag as the Skewer).
  dogtag: { name: "Felon's Dog Tag", sim: 'dogtag', card: ['report-28-felons-dog-tag-card.png', 238, 180, 180, 220] },
  // Its panel icon is in tools/pick-truth.json (the user's run, 2026-10-17, held
  // with the Muzzle); its card art matched other instruments' panel icons.
  maul: { name: 'Elephant-Foot Maul: Mammoth', sim: 'maul', card: null },
  // Report 65. No panel icon yet (its card art isn't used for panels).
  claws: { name: 'Filthy Claws: Alpha Wolf', sim: 'claws', card: null },
  // Report 100. No panel icon yet.
  trap: { name: 'Blood-Stained Trap: Berserk Lion', sim: 'trap', card: null },
  // Panel icons in tools/pick-truth.json (the user's iPad run, 2026-10-31):
  // without them the Chains read as the Barbed Collar or the Trap, and the
  // Crown as the Skewered Rat Heads.
  ravenous: { name: "Ferocious Beast's Ravenous Chains", sim: 'ravenous', card: null },
  crown: { name: 'Iron Crown of the Prison King: Berserk Lion', sim: 'crown', card: null },
};

const cache = new Map();
const read = (file) => {
  if (!cache.has(file)) cache.set(file, P.read(path.join(DIR, file)));
  return cache.get(file);
};
const round = (v, d) => Array.from(v, (x) => +x.toFixed(d));

// Padlocks: compact beige blobs. Used to place the training boards exactly.
function padlocks(img) {
  return S.blobs(img, 0, 0, img.width - 1, img.height - 1, (x, y) => {
    const o = (y * img.width + x) * 4;
    const r = img.data[o];
    const g = img.data[o + 1];
    const b = img.data[o + 2];
    const l = (r + g + b) / 3;
    return l > 125 && r >= g && g >= b - 4 && r - b >= 8 && r - b <= 60;
  })
    .filter((b) => b.n >= 12 && b.n <= 160 && b.w >= 6 && b.w <= 18 && b.h >= 4 && b.h <= 14)
    .map((b) => [b.cx, b.cy]);
}

// A training board's placement: the scale and offset that put the most
// padlocks on padlock spots.
function placement(img) {
  const locks = padlocks(img);
  const unit = { s: 1, tx: 0, ty: 0 };
  const spots = S.RING.slice(1).map(([u, v]) => S.at(unit, u, v));
  let best = null;
  for (let s = 0.9; s <= 1.1001; s += 0.0025) {
    for (const [lx, ly] of locks) {
      for (const [px, py] of spots) {
        const tx = lx - s * px;
        const ty = ly - s * py;
        let n = 0;
        let err = 0;
        let sx = 0;
        let sy = 0;
        for (const [qx, qy] of spots) {
          const ex = s * qx + tx;
          const ey = s * qy + ty;
          let m = Infinity;
          let hit = null;
          for (const l of locks) {
            const d = Math.hypot(l[0] - ex, l[1] - ey);
            if (d < m) {
              m = d;
              hit = l;
            }
          }
          if (m < 3) {
            n += 1;
            err += m;
            sx += hit[0] - ex;
            sy += hit[1] - ey;
          }
        }
        if (!best || n > best.n || (n === best.n && err < best.err)) best = { s, tx: tx + (n ? sx / n : 0), ty: ty + (n ? sy / n : 0), n, err };
      }
    }
  }
  return best;
}

function grayBlur(img) {
  return S.blur(S.grayOf(img), img.width, img.height, 1);
}

function sample(g, w, h, x, y) {
  x = Math.max(0, Math.min(w - 1.001, x));
  y = Math.max(0, Math.min(h - 1.001, y));
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
}

// ---------- The board's frame ----------

function boardPoints() {
  const img = read(BOARD_REF);
  const loc = placement(img);
  const g = grayBlur(img);
  const unit = { s: 1, tx: 0, ty: 0 };
  const rooms = S.RING.map(([u, v], n) => ({ n, xy: S.at(unit, u, v), k: S.scaleAt(unit, u, v) }));
  const arrows = S.ARROW.map(([u, v]) => ({ xy: S.at(unit, u, v), k: S.scaleAt(unit, u, Math.min(3, v)) }));
  const cand = [];
  for (let y = 38; y <= 462; y += 3) {
    for (let x = 290; x <= 1045; x += 3) {
      // Cell rooms change with what's inside; the office never does.
      if (rooms.some((r) => r.n !== 0 && Math.abs(x - r.xy[0]) < 52 * r.k && y > r.xy[1] - 86 * r.k && y < r.xy[1] + 12 * r.k)) continue;
      // The warden's arrow can sit on any of these.
      if (arrows.some((a) => Math.hypot(x - a.xy[0], y - a.xy[1]) < 34 * a.k)) continue;
      const X = loc.s * x + loc.tx;
      const Y = loc.s * y + loc.ty;
      const v = sample(g, img.width, img.height, X, Y);
      const gx = sample(g, img.width, img.height, X + 2, Y) - sample(g, img.width, img.height, X - 2, Y);
      const gy = sample(g, img.width, img.height, X, Y + 2) - sample(g, img.width, img.height, X, Y - 2);
      cand.push([x, y, v, Math.hypot(gx, gy)]);
    }
  }
  // The strongest edges, plus an even spread of the rest.
  cand.sort((a, b) => b[3] - a[3]);
  const strong = cand.slice(0, 700);
  const rest = cand.slice(700).filter((_, i) => i % Math.max(1, Math.floor((cand.length - 700) / 300)) === 0);
  const points = [...strong, ...rest].map(([x, y, v]) => [x, y, Math.round(v)]);
  return { points, width: 755, height: 424, from: BOARD_REF, placement: loc };
}

// ---------- Faces ----------

function faces() {
  const out = { lion: [], mammoth: [], rat: [], wolf: [] };
  for (const [file, t] of Object.entries(TRUTH)) {
    if (file.startsWith('_')) continue;
    const img = read(file);
    const loc = placement(img);
    const g = grayBlur(img);
    for (const [cell, what] of Object.entries(t.inmates)) {
      const [beast] = what.split('/');
      if (!out[beast]) continue;
      const [u, v] = S.RING[Number(cell) - 1];
      const [x, y] = S.at(loc, u, v);
      const k = S.scaleAt(loc, u, v);
      out[beast].push(round(S.faceVector(g, img.width, img.height, x, y, k).v, 2));
    }
  }
  return out;
}

// ---------- Digits ----------

function digits() {
  const out = {};
  const add = (d, v, kind) => (out[d] || (out[d] = [])).push({ v: round(v, 2), kind });
  const counts = { days: 0, doors: 0, labels: 0 };
  const prefix = [];
  // Each screenshot as it is, then resized, so digits are learned as they
  // look at other screen sizes. These sizes differ from the test's.
  for (const [file, t] of Object.entries(TRUTH)) {
    if (file.startsWith('_')) continue;
    for (const size of [1]) {
    const base = read(file);
    const img = size === 1 ? base : P.resize(base, size);
    const loc0 = placement(base);
    const loc = { s: loc0.s * size, tx: loc0.tx * size, ty: loc0.ty * size };
    const g = grayBlur(img);
    const W = img.width;
    const H = img.height;
    const label = (word, value, lineH, kind) => {
      const s = String(value);
      if (word.glyphs.length !== s.length) return;
      word.glyphs.forEach((gl, i) => add(s[i], S.glyphVector(g, W, H, gl, lineH), kind));
      counts[kind] += 1;
    };
    // The day counter, found the way the reader finds it.
    const day = S.dayNumber(img, loc);
    if (day && t.days) label(day.word, t.days, day.h, 'days');
    // Door cards: the number at the end of each card's text, in order, and
    // the "Go to Cell" before it.
    if (t.doors.length) {
      const cards = S.doorCards(img, loc);
      if (cards.length === t.doors.length) {
        cards.forEach((c, i) => {
          label(c.word, t.doors[i], c.h, 'doors');
          prefix.push(round(S.prefixVector(g, W, H, c.p), 2));
        });
      } else console.log(`  ${file}: found ${cards.length} door cards, labeled ${t.doors.length}`);
    }
    // Cell numbers around the board.
    S.RING.forEach(([u, v], n) => {
      if (n === 0) return;
      const [x, y] = S.at(loc, u, v);
      const k = S.scaleAt(loc, u, v);
      const off = v === 0 ? [0, -88] : v === 3 ? [0, 22] : u === 5 ? [63, -38] : [-62, -39];
      const ex = x + off[0] * k;
      const ey = y + off[1] * k;
      const lines = S.textLines(img, ex - 18 * k, ey - 14 * k, ex + 18 * k, ey + 14 * k, { minH: 6, maxH: 30 });
      let best = null;
      for (const line of lines) {
        for (const p of line.pieces) {
          const d = Math.hypot((p.x0 + p.x1) / 2 - ex, (p.y0 + p.y1) / 2 - ey);
          if (!best || d < best.d) best = { p, d, h: line.h };
        }
      }
      if (best && best.p.words.length === 1) label(best.p.words[0], n + 1, best.h, 'labels');
    });
    }
  }
  // Up to 10 examples a digit, from day counters and door cards first
  // (the text the reader actually reads), then cell numbers.
  const order = { days: 0, doors: 1, labels: 2 };
  for (const d of Object.keys(out)) {
    const list = out[d].sort((a, b) => order[a.kind] - order[b.kind]);
    const step = Math.max(1, Math.floor(list.length / 10));
    out[d] = list.filter((_, i) => i % step === 0).slice(0, 10).map((x) => x.v);
  }
  return { digits: out, counts, prefix };
}

// ---------- Instruments ----------

// The art's own box inside a region: anything brighter or more colorful
// than the dark background.
function artBox(img, x, y, w, h) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const o = (yy * img.width + xx) * 4;
      const [, s, v] = S.hsv(img.data[o], img.data[o + 1], img.data[o + 2]);
      if ((s > 0.3 && v > 0.35) || v > 0.5) {
        x0 = Math.min(x0, xx);
        y0 = Math.min(y0, yy);
        x1 = Math.max(x1, xx);
        y1 = Math.max(y1, yy);
      }
    }
  }
  return x1 < 0 ? [x, y, x + w - 1, y + h - 1] : [x0, y0, x1, y1];
}

// A board placed just past the right edge of a picture cropped to the
// instrument panel, so the reader looks for the panel's label across all of
// it.
function besideCrop(img) {
  const unit = { s: 1, tx: 0, ty: 0 };
  const left = Math.min(S.at(unit, 0, 0)[0], S.at(unit, 0, 3)[0]);
  return { s: 1, tx: img.width + 70 - left, ty: 0 };
}

function tools() {
  const out = [];
  let icons = 0;
  // Icons from the panel, as players see them.
  for (const [file, t] of Object.entries(TRUTH)) {
    if (file.startsWith('_') || !t.tools.length) continue;
    const img = read(file);
    const loc = placement(img);
    const found = S.findToolIcons(img, loc);
    if (found.icons.length !== t.tools.length) {
      console.log(`  ${file}: found ${found.icons.length} icons, labeled ${t.tools.length}; skipped`);
      continue;
    }
    found.icons.forEach((icon, i) => {
      out.push({ id: t.tools[i], from: 'icon', feat: S.artFeature(img, ...icon.box) });
      icons += 1;
    });
  }
  // Card art for every instrument, until panel icons of each are labeled,
  // and panel icons cut from players' reports (`icons`).
  for (const [id, t] of Object.entries(TOOLS)) {
    if (t.card) {
      const [file, x, y, w, h] = t.card;
      const img = read(file);
      out.push({ id, from: 'card', feat: S.artFeature(img, ...artBox(img, x, y, w, h)) });
    }
    // A report's screenshot with this instrument alone on the panel: its
    // icon, found as the reader finds it.
    for (const file of t.icons || []) {
      const img = read(file);
      // Reports come at any size, so the board is found as the reader finds
      // it. One cropped to the instrument panel has no board: the panel's
      // label is then looked for across the whole picture.
      let loc = S.locateBoard(img, S.grayOf(img), { board: { points: board.points, width: board.width, height: board.height } });
      if (!loc || loc.score < 0.65) loc = besideCrop(img);
      const found = S.findToolIcons(img, loc);
      if (found.icons.length !== 1) {
        console.log(`  ${file}: found ${found.icons.length} icons, expected 1; skipped`);
        continue;
      }
      out.push({ id, from: 'icon', feat: S.artFeature(img, ...found.icons[0].box) });
      icons += 1;
    }
  }
  for (const r of out) {
    r.feat.grid = round(r.feat.grid, 1);
    r.feat.hist = round(r.feat.hist, 3);
  }
  return { tools: out, icons };
}

// ---------- Build ----------

const t0 = Date.now();
if (!fs.existsSync(DIR)) {
  console.log(`No screenshots at ${DIR}.`);
  process.exit(1);
}
const board = boardPoints();
console.log(`board: ${board.points.length} frame points from ${BOARD_REF} (placed at s=${board.placement.s.toFixed(3)}, ${board.placement.n} padlocks)`);
const faceSet = faces();
console.log(`faces: ${Object.entries(faceSet).map(([b, l]) => `${b} ${l.length}`).join(', ')}`);
const digitSet = digits();
console.log(`digits: ${Object.keys(digitSet.digits).sort().map((d) => `${d}×${digitSet.digits[d].length}`).join(' ')} (from ${digitSet.counts.days} day counters, ${digitSet.counts.doors} door cards, ${digitSet.counts.labels} cell numbers)`);
const toolSet = tools();
console.log(`instruments: ${toolSet.tools.length} references (${toolSet.icons} panel icons)`);

const data = {
  generated: new Date().toISOString().slice(0, 10),
  board: { points: board.points, width: board.width, height: board.height },
  faces: faceSet,
  digits: digitSet.digits,
  prefix: digitSet.prefix,
  tools: toolSet.tools,
  toolNames: Object.fromEntries(Object.entries(TOOLS).map(([id, t]) => [id, { name: t.name, sim: t.sim }])),
};
const out = `/* Generated by tools/scan-build.js on ${data.generated} from labeled screenshots. Do not edit by hand. */
(function (root) {
  root.TARTARUS_SCAN = ${JSON.stringify(data)};
  if (typeof module === 'object' && module.exports) module.exports = root.TARTARUS_SCAN;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
`;
fs.writeFileSync(path.join(ROOT, 'js', 'scan-data.js'), out);
console.log(`wrote js/scan-data.js (${(out.length / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../tools/png.js');
const S = require('../js/scan.js');
const REF = require('../js/scan-data.js');
const PICK = require('../js/pick-data.js');

// AirPlay frames of the user's iPad (2026-10-24), kept out of the repo in
// sandbox/tips/: the board with two instruments, and the same board with
// the tip of the first, then the second, instrument open.
const DIR = path.join(__dirname, '..', 'sandbox', 'tips');
const frame = (file) => P.read(path.join(DIR, file));
const missing = (file) => !fs.existsSync(path.join(DIR, file)) && `sandbox/tips/${file} is not on this machine`;
const NO_TIP = 'airplay-no-tip.png';
const TIP_1 = 'airplay-kins-coin.png';
const TIP_2 = 'airplay-filthy-claws.png';
const SMALL = 'airplay-1400-scratched-normal.png';
const EMPTIED = 'airplay-1400-emptied-door.png';
const STATUS_OVERLAP = 'airplay-1400-status-view-overlap.png';
const TWO_LINE_TIP = 'airplay-1400-tip-two-line-name.png';
const CAGE_FIGHT = 'airplay-1400-badge-cagefight.png';

// Regression guard: the objective "Undercurrents" wraps onto three lines,
// and its third ("times Completed") passed for the "Torture Instrument"
// label, so no instrument icon was found under it.
test('the instrument panel is found under its own label, not the objective\'s last line', { skip: missing(NO_TIP) }, () => {
  const r = S.scan(frame(NO_TIP), REF);
  assert.ok(r.ok);
  assert.ok(r.tools.label.y0 > 400, `label at y ${r.tools.label.y0}: the objective's text is above 400`);
  assert.equal(r.tools.tools.length, 2);
});

// The tip of an instrument (tapped on the iPad, or pointed at): a flat grey
// box to the right of its icon, its name on the first line. Reading the name
// as text replaces matching the icon's art (the user, 2026-10-24: the Filthy
// Claws' icon read as the Skewered Rat Heads, sure of it).
const inside = (a, b) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];
test('no tip on a plain board', { skip: missing(NO_TIP) }, () => {
  assert.equal(S.findToolTip(frame(NO_TIP)), null);
});
test('the first instrument\'s tip is found, with its name line', { skip: missing(TIP_1) }, () => {
  const tip = S.findToolTip(frame(TIP_1));
  assert.ok(tip, 'a tip');
  // The box, in the frame's pixels (from the AirPlay picture, 1.538 a display point).
  assert.ok(inside(tip.box, [500, 200, 940, 940]) && tip.box[2] - tip.box[0] > 380 && tip.box[3] - tip.box[1] > 650, `box ${tip.box}`);
  // "Kin's Coin of Fate", with room around it for the text reader.
  assert.ok(inside([540, 243, 784, 269], tip.title), `title ${tip.title} holds the name`);
  assert.ok(tip.title[3] < 300, `title ${tip.title} stops above the divider's text`);
});
test('the second instrument\'s tip is found further right', { skip: missing(TIP_2) }, () => {
  const tip = S.findToolTip(frame(TIP_2));
  assert.ok(tip, 'a tip');
  assert.ok(inside([653, 398, 995, 430], tip.title), `title ${tip.title} holds "Filthy Claws: Alpha Wolf"`);
  assert.ok(tip.title[3] < 460, `title ${tip.title} stops above "Condition"`);
  assert.ok(tip.box[0] > 600 && tip.box[0] < 660, `box starts right of the second icon: ${tip.box}`);
});

// Regression guard (the user's run, 2026-10-24): cell 07 is a locked door
// scratched by the Filthy Claws, its inmate Normal (a white frame). On the
// 1400-pixel frame iPad mode reads, the slashes' red reached the frame's
// foot and left the Normal in doubt, so the board was never advised on.
test('a scratched door with a Normal behind it is read sure on a small frame', { skip: missing(SMALL) }, () => {
  const r = S.scan(frame(SMALL), REF);
  assert.ok(r.ok);
  const c7 = r.cells[6];
  assert.equal(c7.kind, 'locked');
  assert.deepEqual([c7.shown.tier, c7.shown.scratch], [0, true]);
  assert.ok(c7.shown.conf >= 0.6, `conf ${c7.shown.conf}`);
  // The scratched Rares beside it still read as Rare.
  assert.deepEqual([r.cells[3].shown.tier, r.cells[8].shown.tier], [2, 2]);
});

// Regression guard (the user's run, 2026-10-24, day 9): the scratched Normal
// behind cell 07's door was gone in the morning (Kin's Coin, most likely),
// and the door showed the cell's lit floor. The analyzer kept the scratch
// from the day before, so two Normal Wolves had a meal the game didn't
// show jaws for, and the board stayed in doubt.
test('a locked door on an emptied cell is told from a plain door and a "?" door', { skip: missing(EMPTIED) || missing(SMALL) }, () => {
  const r = S.scan(frame(EMPTIED), REF);
  assert.ok(r.ok);
  assert.equal(r.cells[6].kind, 'locked');
  assert.equal(r.cells[6].emptied, true, 'cell 07 emptied');
  for (const n of [1, 9, 14]) assert.equal(!!r.cells[n].emptied, false, `plain door ${n + 1}`);
  for (const n of [3, 15]) assert.equal(!!r.cells[n].emptied, false, `scratched door ${n + 1}`);
  // The day before, the same door still held its Normal.
  const before = S.scan(frame(SMALL), REF);
  assert.equal(!!before.cells[6].emptied, false);
  assert.equal(before.cells[6].shown.tier, 0);
});

// Regression guard (the user's run, 2026-10-25): View Prison Status behind
// the Warden's Treasure, with "Chromatic Prisoner" showing through just under
// "Return to Selection". "Return" read as two words, the view as a plain
// board with no action buttons, and the advice stayed hidden.
test('View Prison Status is told with "Chromatic Prisoner" showing under its button', { skip: missing(STATUS_OVERLAP) || missing(NO_TIP) }, () => {
  const r = S.scan(frame(STATUS_OVERLAP), REF);
  assert.ok(r.ok);
  assert.equal(r.statusView, true);
  assert.equal(!!S.scan(frame(NO_TIP), REF).statusView, false, 'a plain board');
});

// Regression guard (the user's run, 2026-10-25): "Ferocious Beast's Ravenous
// Chains" wraps onto a second line in its tip. Only the first line went to
// the text reader, "Ferocious Beast's" matched no instrument, and the advice
// waited for the instruments for good.
test('an instrument\'s name that wraps onto two lines is read whole', { skip: missing(TWO_LINE_TIP) }, () => {
  const tip = S.findToolTip(frame(TWO_LINE_TIP));
  assert.ok(tip, 'a tip');
  assert.ok(tip.title[1] <= 139 && tip.title[3] >= 169, `title ${tip.title} holds both lines of the name`);
  assert.ok(tip.title[3] < 190, `title ${tip.title} stops above "Condition"`);
});

// Regression guard (the user's run, 2026-10-25): on the iPad the start
// card's badge hangs lower than on Steam. The reader looked at the bare wall
// above it, Cage Fight stayed unset, and a Rare Mammoth's jaws over a Normal
// Lion read as a misread cell, which hid the advice.
test('the start card\'s badge is read on the iPad', { skip: missing(CAGE_FIGHT) || missing(NO_TIP) }, () => {
  const ref = S.withPanelIcons(REF, PICK);
  assert.equal(S.scan(frame(CAGE_FIGHT), ref).badge.id, 'cagefight');
  // Another card's badge, with no sample: found, not taken for Cage Fight.
  const other = S.scan(frame(NO_TIP), ref).badge;
  assert.ok(other, 'a badge');
  assert.equal(other.id, null);
});

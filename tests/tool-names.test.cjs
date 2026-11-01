const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/engine.js');

const id = (text) => (T.toolFromText(text) || {}).id || null;

// Regression guard (the user's run, 2026-10-31): an objective's reward
// offered the Iron Crown of the Prison King. Its long name is printed small
// and cut short ("Berser..."), and the text reader garbled "Crown of", so
// the card was read by its art alone (as the Skewered Rat Heads, unsure)
// and iPad mode gave no advice on the offer. These are what the text reader
// made of that card, at four sizes.
test('a long name cut short with "..." is read from the part shown', () => {
  for (const text of [
    '1 ET. {\nrl Iron fon per Prison King: Berser... N\n',
    '1 RT. {\n——\nd Iron Cronies Prison King: Berser... N\n',
    'i ET. |\n—\n4 Iron Fic the Prison King: Berser... u\n',
    '--\n4 Iron Ft, the Prison King: Berser... )\n',
  ]) assert.equal(id(text), 'crown', JSON.stringify(text));
});

test('names around stray marks from the card\'s frame are still read', () => {
  assert.equal(id('17\na\na4 Squirming Iron Box: Colossal Rat W\n'), 'ironbox');
  assert.equal(id('a Yak\n—— o\nPB Kin\'s Coin of Fate Il\n'), 'coin');
});

test('a name wrapped onto two lines is read whole', () => {
  assert.equal(id('Iron Crown of the Prison\nKing: Berserk Lion'), 'crown');
});

test('no name is made up from the frame\'s marks alone', () => {
  assert.equal(id('1 ET. {\n——\n'), null);
  assert.equal(id(''), null);
});

test('a few letters before the dots are not enough to name a card', () => {
  assert.equal(id('Iron... N'), null);
});

/* Short notes on playing the run's instruments, the pairs of them the lab
   found worth more or less together, and the start-of-run card ("contract").
   The user, 2026-10-22: "a small snippet on the strategy of how to play the
   specific instrument that the person gets ... the same when they have a
   specific 2 instrument combination ... playing around any special
   contracts pre-game". Pair numbers are from tools/results/tool-combos.json:
   Rainbows a run held together, and what they make beyond their separate
   gains. */
(function (root) {
  const TOOL_NOTES = {
    revenge: 'Consume whenever you can: 30% of consumes open a locked cell holding a meal at the eater\'s new rarity, which keeps chains going.',
    muzzle: 'Keep the block thin: a consume with 4 or fewer inmates on the block, its meal included, gains +2 tiers. Let consumes thin the block before you open many doors.',
    saw: 'Consume every day you can: 25% of consumes gain an extra tier.',
    keys: 'Patrol to doors with locked cells on both sides: 80% of the time those open too, for free.',
    rope: 'Replace freely: a Replace never brings a Normal or Magic, so replacing a Normal or Magic is always an upgrade.',
    fire: 'Open doors: 35% of the time the inmate behind it is copied into another locked cell, so a door can bring two inmates.',
    ironbox: 'Nests take a locked cell each morning and hatch Rare Rats 2 days later. Rats eat Mammoths, so keep Rare Mammoths for them. Alone it measured below no instrument: open doors early, before nests fill them.',
    skewer: 'Rats can eat Rats of their rarity, +1 extra tier a bite: send the warden to a Rat when another Rat shares its rarity.',
    hook: 'Open doors freely: no door ever holds a Normal.',
    pestle: 'A Replace keeps the beast and re-rolls only the rarity: replace low inmates whose beast you want to keep.',
    scales: 'After a Replace, 80% of the time the best inmate behind a locked door shows: Replace early, then patrol toward what it reveals.',
    tongs: 'Each morning a Mammoth gets a Tusk mark, and replacing the inmate in a Tusk cell raises 4 inmates a tier: keep Mammoths, and Replace the marked one when the block is full of inmates worth raising.',
    guillotine: 'Wolves can also eat Rats below their rarity: a high Wolf can climb on the low Rats around it.',
    axe: 'A Replace that comes in higher opens 2 locked cells: Replace Normals early for free doors. Alone it measured below no instrument.',
    shackles: 'Walk far: a patrol of 4 or more cells has 40% to raise a random inmate a tier, so take the far door when the choice is close.',
    collar: 'Chains pay: every bite after the first has 80% for +1 tier. Consume when meals wait at the next rarities, so the chain goes on.',
    forged: 'One door fewer each morning, but 50% of opened doors open another locked cell: pick doors to open over inmates to visit. Alone it measured below no instrument.',
    dogtag: 'Open doors: 25% of the time the inmate behind the door comes out a tier higher.',
    cage: 'Consume often: 40% of the time the eaten inmate\'s cell refills at once, so consumes don\'t thin the block.',
    blacklist: 'Once 5 or fewer cells are still locked, every door a patrol opens raises 2 random inmates: open doors early to get there, then keep opening.',
    shortchain: 'Walk short: a patrol of 3 cells or fewer has 50% to open a random locked cell, so take the near door when the choice is close. Alone it measured about even with no instrument.',
    maiden: 'Replace an inmate that stands level (as many inmates above its rarity as below it, an inmate alone always is): the new one comes in 3 tiers up. The advice says when a Replace gets the +3.',
    whip: 'One door fewer each morning, and every bite of a consume has 35% for +1 tier: consume every day and make chains.',
    ravenous: 'Each morning your highest inmate removes the inmates on both sides of it, with 40% for +1 tier each: keep cheap inmates or empty cells beside your best one.',
    scapegoat: 'A Replace with 2 or more others on the block removes 2 random ones and brings the new inmate in above the rarity replaced. Replace only when the others are cheap: with exactly 2 others, both go.',
    stake: 'One door fewer each morning, and replacing an inmate below Legendary has 40% to bring a Legendary: Replace Normals and Magics often.',
    coin: 'Each morning two inmates sharing a beast and rarity have 60% to merge: one goes and another like it gains +2 tiers. Keep matching pairs on the block.',
    crown: 'Lions eat any inmate of their rarity, +2 extra tiers a bite: send the warden to Lions that have same-rarity inmates around.',
    maul: 'Mammoths can eat Lions and Wolves of a higher rarity too, landing 2 tiers above the meal: a Mammoth eating up is the big jump.',
    claws: 'Each day a locked cell gets Scratch Marks showing its rarity, and a Wolf of that rarity can eat through the door for +3: keep Wolves at the rarities the scratched doors show.',
    trap: 'With the warden on a Lion, Hunt marks one of its meals and both rise a tier each morning for 3 mornings. Hunt early on pairs that can climb; the last 3 days pay less, the last day nothing. A day has a Consume, a Replace or a Hunt.',
  };

  // Pairs worth noting: the strongest together and the worst clashes. Measured
  // again with runs starting with 4 inmates out and the other live-data
  // rules (2026-10-22).
  const PAIR_NOTES = {
    'maiden|rope': 'Every Replace brings Rare or better, and an inmate alone on the block stands level: replace your only inmate and it comes back 3 tiers up. Keep the block thin: a run starts with 4 inmates out, so let consumes clear it first. One of the best pairs measured (5.37 Rainbows a run, +1.81 beyond the two apart).',
    'ironbox|skewer': 'The nests hatch Rare Rats, and Rats eat Rats of their rarity: hatched Rats feed each other (4.54, +2.75 beyond the two apart).',
    'coin|ironbox': 'Hatched Rare Rats come in matching pairs for the Coin to merge: leave them be (4.51, +2.07 beyond the two apart).',
    'maiden|scapegoat': 'Replace only an inmate that stands level, counted before the Scapegoat removes 2: the new one gets +3. A Replace that isn\'t level just throws inmates away (4.95, +1.65 beyond the two apart).',
    'crown|keys': 'The Keys\' extra doors fill the block with same-rarity meals for your Lions (4.58, +0.89 beyond the two apart).',
    'blacklist|keys': 'The Keys take you down to 5 locked cells fast, where every opened door raises 2 inmates (3.38, +0.84 beyond the two apart).',
    'coin|keys': 'More open doors bring more matching pairs for the Coin (3.56, +0.63 beyond the two apart).',
    'keys|trap': 'More open doors bring more meals for a Hunt (4.73, +0.38 beyond the two apart).',
    'keys|maul': 'More open doors bring more Lions and Wolves for Mammoths to eat up (4.39, +0.68 beyond the two apart).',
    'maiden|stake': 'Replace low inmates that stand level: 40% come in Legendary, and +3 on top (2.80, +0.36 beyond the two apart).',
    'claws|muzzle': 'Eating through scratched doors keeps the block thin, where consumes get the Muzzle\'s +2 (3.76, +0.46 beyond the two apart).',
    'scapegoat|trap': 'Clash: the Scapegoat\'s removals take Prey marks and Lions\' meals. Hunt, and avoid a Replace with 2 or more others on the block (-1.78 against the two apart).',
    'rope|scapegoat': 'Clash: Noose Replaces are already Rare or better, and the Scapegoat throws 2 inmates away for them. Replace with fewer than 2 others on the block (-1.17 against the two apart).',
    'maul|trap': 'Clash: Mammoths eat Lions, and Hunts want Lions alive. Pick one plan for the run (-1.46 against the two apart).',
    'ironbox|maul': 'Clash: hatched Rats eat Mammoths. Keep Mammoths away from Rat rarities, or let the Rats have the low ones (-0.87 against the two apart).',
    'revenge|trap': 'Clash: consumes and Hunts compete for the day\'s action, and a consume can break a Prey mark (-1.43 against the two apart).',
    'crown|scapegoat': 'Clash: the Scapegoat\'s removals take your Lions\' meals. Replace with fewer than 2 others on the block (-1.03 against the two apart).',
    'claws|ironbox': 'Clash: nests use up the locked cells the Claws scratch (-0.66 against the two apart).',
    'crown|maul': 'Clash: Mammoths eat Lions. Decide which beast your run climbs with (-0.83 against the two apart).',
    'crown|trap': 'The best pair measured (5.39 Rainbows a run), though less than the two apart (-0.98): both play through Lions, and a Lion consuming its marked prey ends the Hunt. Hunt first, and let Lions consume once the marks run out.',
    'ravenous|trap': 'Clash: each morning the Ravenous Chains\' highest inmate removes the inmates beside it, which can take a marked prey or its Lion. Keep Hunt pairs away from your best inmate (-1.11 against the two apart).',
    'trap|whip': 'Clash: the Whip pays for consuming every day, and a Hunt uses the day\'s action instead. Pick one plan for the run (-1.11 against the two apart).',
  };

  // The start-of-run cards ("contracts").
  const CONTRACT_NOTES = {
    cagefight: 'Cage Fight: inmates eat the beasts they counter at their own rarity or lower, and eating never changes their beast. A high eater can clean up every lower meal of its prey and keeps its beast, so consume a lot and keep low meals around your best eaters.',
    ironlaw: 'Iron Law: the run lasts 30 days. Long plans pay more: Hunts, nests, Coin merges, building a big chain.',
    tyranny: 'Tyranny: each stop at the Interrogation Room also triggers Instigate and Bestow 3 more times each. Route the warden through the office often.',
    opulence: 'Opulence: each Warden\'s Treasure gives 3 picks, and a Rainbow made by a pick brings 3 more. Rainbows are worth more: the gift order matters (the Horn first if it makes a Rainbow).',
  };

  // How a start card changes an instrument's play.
  const CONTRACT_TOOL_NOTES = {
    'cagefight|guillotine': 'With Cage Fight, every eater already eats lower meals, so the Guillotine adds nothing.',
    'cagefight|maul': 'With Cage Fight, a Mammoth eats Lions and Wolves at any rarity: lower ones, and higher ones through the Maul.',
    'cagefight|crown': 'With Cage Fight, a Lion eats Wolves and Rats at or below its rarity, and any inmate of its rarity through the Crown.',
    'cagefight|skewer': 'With Cage Fight, Rats eat Mammoths and Rats at or below their rarity, and stay Rats.',
    'ironlaw|trap': 'With Iron Law\'s 30 days, a Prey mark pays its 3 mornings until day 27.',
    'ironbox|ironlaw': 'With Iron Law\'s 30 days, more nests hatch: more Rare Rats to use.',
    'coin|ironlaw': 'With Iron Law\'s 30 days, matching pairs get more mornings to merge.',
  };

  const key = (a, b) => [a, b].sort().join('|');

  // Notes for a run: its start card first, then each instrument held, then
  // the pairs among them, then how the start card changes them.
  function notesFor(tools, startEvent, names) {
    const out = [];
    const held = (tools || []).filter((id) => TOOL_NOTES[id]);
    const name = (id) => (names && names[id]) || id;
    if (CONTRACT_NOTES[startEvent]) {
      const text = CONTRACT_NOTES[startEvent].replace(/^[^:]+: /, '');
      out.push({ kind: 'contract', title: name(startEvent), text: text.charAt(0).toUpperCase() + text.slice(1) });
    }
    for (const id of held) out.push({ kind: 'tool', title: name(id), text: TOOL_NOTES[id] });
    for (let i = 0; i < held.length; i++) {
      for (let j = i + 1; j < held.length; j++) {
        const note = PAIR_NOTES[key(held[i], held[j])];
        if (note) out.push({ kind: 'pair', title: `${name(held[i])} with ${name(held[j])}`, text: note });
      }
    }
    if (startEvent && startEvent !== 'none') {
      for (const id of held) {
        const note = CONTRACT_TOOL_NOTES[key(startEvent, id)];
        if (note) out.push({ kind: 'contract-tool', title: `${name(id)} with ${name(startEvent)}`, text: note });
      }
    }
    return out;
  }

  const api = { TOOL_NOTES, PAIR_NOTES, CONTRACT_NOTES, CONTRACT_TOOL_NOTES, notesFor };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TartarusTips = api;
})(typeof window !== 'undefined' ? window : globalThis);

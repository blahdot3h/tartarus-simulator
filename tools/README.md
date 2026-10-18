# Strategy lab

`strategy-sim.js` plays huge numbers of simulated drills to find out which strategy vaults the most Rainbows. It uses the game's own rules engine (`js/engine.js`) and the rules-based strategy in `js/solver.js`. There is no AI: every choice comes from scoring rules, and the lab tunes their weights by trying each value and keeping whichever vaults more Rainbows.

Games run in parallel on every CPU core. Game *i* always uses the seed `LAB-i`, so every strategy faces the same prisons and the same door rolls until their choices differ. On a 32-thread desktop it plays roughly 25,000 to 40,000 full 20-day runs a second.

## Running it

Needs Node 18 or newer. From the project folder:

```
node tools/strategy-sim.js eval   --games 1000000            # random play vs a simple player vs the solver strategy
node tools/strategy-sim.js tune   --games 40000 --rounds 3   # coordinate search over the strategy's weights
node tools/strategy-sim.js tools  --games 200000             # each tool held from day 1
node tools/strategy-sim.js gifts  --games 200000             # Warden's Treasure choices
node tools/strategy-sim.js chains --games 200000             # chain odds by beasts per tier
node tools/strategy-sim.js report --games 1000000            # the whole study, saved to tools/results/
node tools/strategy-sim.js train  --games 150000 --final 1000000   # fine-tunes the drill profiles the Trainer uses (--only rewards or notools)
node tools/strategy-sim.js combos --minutes 60               # every set of up to 4 instruments, each to ±0.01; run again to carry on
node tools/strategy-sim.js variants --rewards on --variants ";toolSets=false"   # the drill profile against changed weights, same prisons
```

Options:
- `--rewards on`: runs start with a pick of 3 random instruments, as live ones do, the run's objective (King of the Caged or Prison Walk) earns another, and each Rainbow opens the Warden's Treasure. The default is no tools at all.
- `--params file.json`: start from saved weights.
- `--threads N`: how many threads to use.
- `--seed WORD`: a different set of prisons.

## What the strategy decides

At every decision the strategy scores each legal move from what the player can see:

- **Patrol.** It scores each destination. A locked door is worth what a new inmate is worth, plus what it could do today from the warden's cell, plus any event behind the door. A known inmate is worth its best devour or swap. A small bonus per step favors walking further, and another counts tiles toward Prison Walk while it still pays a tool (`wGoal`; 0, 1 and 3 all scored 1.71 Rainbows per run on 200,000 runs, since the objective gets met anyway). With the Long-Chained Shackles, a walk of 4 or more cells adds 40% of a tier on an average inmate.
- **Devour.** It takes the first meal with the highest expected value. That value comes from an exact calculation of the chain that follows, including tools such as the Barbed Collar's +1 on chained bites. After each bite the player picks the next meal or stops the chain (the game's Cancel): the calculation and the strategy take the best meal each time, and stop when no meal is worth eating (`stopMargin`).
- **The office.** A destination like any other. There it compares Bestow (1 random inmate +1 tier, worth the average raise) with Instigate (events behind 2 locked doors, worth an average event each, halved by `wInstigate` since a patrol still has to reach them).
- **Swap.** It swaps the warden's inmate when it's at or below a tier threshold. A day has a swap or a devour, not both, so when a devour is on offer it swaps only if the swap is worth more than the best devour. With the Gaoler's Execution Axe, the 2 doors a higher roll opens count toward the swap's value.
- **Events.** It accepts Chain reactions, Ravenous Appetite, High-Risk Convict and Crow Whispers, and Behind Closed Doors unless the inmate is already a Supreme. It accepts an Execution when the executioner gains more than it removes. Events show as soon as they appear, so a locked door is never valued for a hidden one. An event whose kind isn't known counts as each kind equally. A door whose rarity shows (Crow Whispers, a scratch, the Scales) is valued at that rarity.
- **Instruments and gifts.** An instrument is picked by what it adds to the ones already held, from the measured sets in `js/tool-combos.js` (see below); without them, by a ranking measured by the lab. Gifts are scored on the spot.

The in-game Trainer shows this strategy's pick right away. It then plays each candidate move out hundreds of times with the strategy, re-rolling everything the player can't see each time. It keeps the strategy's pick unless the playouts find a clearly better move. Each move the player makes is graded against those playouts.

The strategy has two tuned profiles, chosen by the run's settings: drills with rewards on (the default) and drills with no tools. `train` refines them on a finer grid around their current weights, re-centered each round. It then scores the old and new weights on a separate set of 1,000,000 fresh prisons, so the before/after comparison is fair.

## The strategy guide's data

`strategy.html` reads `js/guide-data.js`, which the `guide` mode generates. It plays the live game's food chain, where each beast has one meal (Mammoth eats Lion, Lion eats Wolf, Wolf eats Rat, Rat eats Mammoth). `guide` tunes the strategy (unless `--no-tune`), ranks tools and gifts, measures each habit, and plays the headline. For now the target is ±0.1 Rainbows a measurement (the user, 2026-10-17: "just do enough tests to have 0.1 rainbows of certainty for now"), which 2,000 runs a measurement meet:

```
node tools/strategy-sim.js guide --no-tune --games 2000 --side 2000 --habit-games 2000 --compare 100000
```

For ±0.01, use 100,000 runs a measurement (`--games 100000 --side 100000 --habit-games 100000 --compare 100000`). The latest run (2026-10-18, with every Usurpation placing the next on a free cell and the Muzzle counting the block before its consume) took 602,000 runs in 5.3 minutes on 1 thread, most of them the strategy comparison's 100,000 runs a player. Its full numbers are in `results/guide-data.json`.

## The contract challenge (removed)

The Chinese sim's 12-day contract challenge (contracts, vouchers, escorts and convoys) was removed from the simulator, the analyzer, the strategy guide and the lab on 2026-10-17, at the user's word: it isn't in the live game. The `challenge`, `ctune` and `cguide` commands went with it. Sections below still show its numbers as they were measured; their files are in the git history.

## Results

The Chinese sim's two-meal food chain (Mammoth also eats Wolf, Lion also eats Rat) was confirmed not to be in the live game on 2026-10-15, so it was removed from the simulator and the lab. The older sections below still show the two-meal numbers measured at the time; their files are in the git history.

### Usurpations in a row, and the Muzzle before its consume (2026-10-18)

Two rules from the user, in the engine since 20261018d:
- **Usurpation:** each Usurpation card now puts the next one on a random free cell, seen at once: a locked door with no event, or an inmate's open cell with none (the cells Instigate can use). Before, only Usurpation I's card placed the next, and only behind a door. The strategy weighs the Usurpation cells with their own weight, `wUsurp` (0.5).
- **Agonizing Muzzle:** its 2 extra tiers need 4 or fewer inmates on the block before the consume, its meal included (before: after it).

The instrument pairs were measured again from scratch (`combos --max 2 --margin 0.1`, on 1 thread: 1,988,000 runs in 43.2 minutes, ±0.07 at worst). The pair lab's no-instrument baseline is 1.77 (was 1.37).
- **Best pairs:** the Maiden with the Noose is still the best pair (9.12), then the Maiden with the Scapegoat's Guillotine (6.09), and the Noose with the Trap (5.02) or the Maul (4.98).
- **The Muzzle's pairs** fell by 0.35 to 0.47 while the baseline rose by 0.39: with the Maul 4.43 (was 4.77), the Crown 4.37 (was 4.84) and the Claws 4.37 (was 4.73).
- **Clashes:** the Scapegoat's Guillotine with the Trap (−1.20) and the Noose (−1.06), and the Maul with the Trap (−0.92).

Then the guide, with the same settings (602,000 runs in 5.3 minutes on 1 thread):
- **Headline:** **4.66** Rainbows a run with rewards on (±0.10, was 4.41), and 1.80 with no instruments (±0.01 on 100,000 runs, was 1.39). The gain is the strategy's: it goes for the seen Usurpation cells. Played simply, no instruments gives 0.86 (was 0.83), and random play is unchanged (0.06). With the next Usurpation only behind doors (20261018b), the same runs gave 4.76 and 1.94.
- **Instruments:** the Trap (3.60), the Maul (3.56) and the Crown (3.45) still lead, then the Noose (3.27), the Claws (3.05) and Kin's Coin (2.77). Every instrument is above its old number but the Muzzle, down to 2.40 (was 2.72), from 5th to 11th; the drill ranking follows. Below no instrument (1.85 in this table): the Iron Box (1.11), the Forged Key (1.35), the Execution Axe (1.62), the Short-Chained Shackles (1.75), the Searing Branding Iron (1.78) and the Iron Pestle (1.80), with the Lost Ring of Keys, the Warden's Scales and the Barbed Whip (1.87 to 1.88) level with it inside the margin.
- **Warden's Treasure:** Crimson Vintage 4.47, Thumb Ring 4.20, Horn 3.93 and Brand 3.87, against 4.66 judged on the spot.
- **Habits:** preferring short walks (1.60), always accepting Executions (1.64), never replacing (1.64) and always taking Bestow (1.65) cost the most, against the strategy's 1.85.

The strategy's other weights weren't tuned again.

### Second meals at every rarity (2026-10-17, night)

The user, as players' games kept offering them: "fix it then and adjust the sim data accordingly". Mammoths now eat Wolves and Lions eat Rats at every rarity, still at the eater's rarity (`doubleEatTier` 0, was 3, Legendary). The evidence:
- **First meals:** a Rare Lion's meal pick offered two Rare Rats (report 206). Consume was offered to a Normal Mammoth over a Normal Wolf (208), and to a Rare Mammoth over Rare Wolves (306).
- **Mid-chain:** "Chain Consume" picks offered a Magic Lion a Magic Rat (322), and a Rare Lion a Rare Rat (323).
- **Jaws markers:** on players' boards, 120 of 123 inmates below Legendary whose only food was such a meal showed jaws.

The guide was measured again with it, with the same settings (602,000 runs in 5.1 minutes on 1 thread):
- **Headline:** **4.41** Rainbows a run with rewards on (±0.09, was 4.08), and 1.39 with no instruments (±0.005, was 1.26).
- **Instruments:** chains go on more often, so the instruments built on consumes gain the most.
  - The Elephant-Foot Maul reaches 3.21 (was 2.46): a Mammoth's Maul now reaches higher-rarity Wolves.
  - The Blood-Stained Trap reaches 3.21 (was 2.64): its Lion can mark Rats too.
  - The Agonizing Muzzle reaches 2.72 (was 2.06), and the Barbed Collar and the Rusty Saw gain too.
  - The Executioner's Blacklist dipped (1.82, was 1.93), inside the margin.
- **Order:** the Maul, the Trap, the Crown (3.17), the Noose (2.75), the Muzzle (2.72) and the Claws (2.69); the drill ranking follows. Below no instrument (1.39): the Iron Box (0.85), the Forged Key (1.20) and the Execution Axe (1.26).
- **Warden's Treasure:** Crimson Vintage 4.13, Thumb Ring 3.97, Horn 3.71 and Brand 3.63, against 4.41 judged on the spot.
- **Habits:** never replacing (1.26), always accepting Executions (1.22), always taking Instigate (1.28), preferring short walks (1.29) and always taking Bestow (1.30) cost the most. Replacing Normals only measured 1.40, level with the strategy's 1.39 inside the margin.

The instrument pairs were measured again (`combos --max 2 --margin 0.1`, on 1 thread: 1,988,000 runs in 42.4 minutes, ±0.06 at worst). The pair lab's no-instrument baseline is 1.37.
- **Best pairs:** the Maiden with the Noose is still the best pair (9.07). Then the Maiden with the Scapegoat's Guillotine (5.98), and the Muzzle with the Crown (4.84), the Maul (4.77) and the Claws (4.73).
- **Clashes:** the Scapegoat's Guillotine with the Trap (−1.20), the Noose and the Crown (−1.00 each), and the Iron Box with the Maul and the Muzzle (−0.98 each).

The strategy's weights were tuned under the old rule and weren't tuned again.

### Extra Portion (2026-10-17, night)

A player's report (#313): "randomly select up to 3 inmates and increase their rarity by 1 tier". It's the 11th event in the pool (`portion`), as likely as each of the others, and the strategy always accepts it. Its card hasn't been seen, so a Supreme it picks becoming a Rainbow is the simulator's reading.

The guide was measured again with it, with the same settings (602,000 runs in 4.9 minutes on 1 thread): **4.08** Rainbows a run with rewards on (±0.09, was 4.01), and 1.26 with no instruments (±0.005 on 100,000 runs, was 1.17). Every instrument gained between 0.01 and 0.16. Instruments less than about 0.1 apart traded places: the Noose now comes before the Trap, the Claws before the Maul, and the Ravenous Chains before the Blacklist and the Avenger's Casket. The drill ranking follows. The instrument pairs weren't measured again: their numbers below are from before Extra Portion.

### Measured again with events at random, to ±0.1 (2026-10-17, night)

With events appearing at random (next section), the instrument pairs were measured again from scratch on 4 threads, and the guide on 1 while the user played, to the user's target for now: "just do enough tests to have 0.1 rainbows of certainty for now". The contract challenge was removed at the same time (above). Without it, the code plays 3,000 seeded runs with fixed instruments and 2,000 with rewards on move for move as before.

- **Headline, rewards on** (`guide --no-tune --games 2000 --side 2000 --habit-games 2000 --compare 100000`, 602,000 runs in 4.8 minutes): **4.01** Rainbows a run (±0.08), against 3.47 under the old rule. 98.3% of runs vault one, the first around day 9, with 8.9 Replaces and 5.5 consumes a run. With no instruments, 1.169 (±0.005 on 100,000 runs; was 0.896). The events make the difference: 72% of runs now start with one, and about 0.18 more appear a day.
- **Instruments alone** (±0.04 to ±0.07): Iron Crown of the Prison King 2.99, Blood-Stained Trap 2.56, Hangman's Noose 2.50, Elephant-Foot Maul 2.40, Filthy Claws 2.38, Scapegoat's Guillotine 2.37, Kin's Coin of Fate 2.30, Severed Iron Maiden 2.24, Long-Chained Shackles 2.01, Agonizing Muzzle 1.99, Executioner's Blacklist 1.92. Worse than none (1.19): the Squirming Iron Box (0.63), the Forged Key (0.97) and the Gaoler's Execution Axe (1.11). The Short-Chained Shackles (1.15), the Searing Branding Iron (1.17) and the Iron Pestle (1.18) are level with none within the margin. The drill ranking (`toolRank`) follows this order. Instruments less than about 0.1 apart can trade places at this precision: the Maul now comes before the Claws, and Kin's Coin before the Maiden.
- **Pairs** (`combos --max 2 --margin 0.1`, nothing carried over): 497 sets of up to 2 instruments, 4,000 runs each (±0.06 at worst), 1,988,000 runs in 11.8 minutes. The pair lab's no-instrument baseline is 1.19.
  - The Maiden with the Noose is still the best pair, at 8.92 Rainbows a run (was 9.27), 5.37 beyond its parts. Then the Maiden with the Scapegoat's Guillotine (5.88), the Crown with the Muzzle (4.41), the Crown with the Claws (4.27), the Crown with the Trap (4.23), the Noose with Kin's Coin (4.21) and the Iron Box with the Rat Heads (4.20).
  - Clashes: the Scapegoat's Guillotine with the Noose and the Crown (−0.99 each), the Trap (−0.94) and Kin's Coin (−0.85), and the Iron Box with the Claws (−0.65).
  - The Trap does best with the Crown (4.23), the Noose (4.02) and the Claws (3.56); the Claws with the Crown (4.27), the Maul (3.69) and the Muzzle (3.65).
  - The best second instrument differs from the single ranking for 10 of the 31.
- **Habits** (no instruments, ±0.04): never replacing (1.01), always accepting Executions (1.02), always taking Instigate (1.08) and preferring short walks (1.09) cost the most, against 1.19 for the strategy. Always taking Bestow (1.13), replacing Normals only (1.13) and waiting for bigger chains with the large threshold (1.14) cost a little; the others are within 0.04 of the strategy.
- **Warden's Treasure:** judging each gift on the spot (4.01) beats always taking the same one: Crimson Vintage 3.76, Three-Headed Thumb Ring 3.45, Brass Horn of Strife 3.23, Brand of Original Sin 3.22.
- **Strategy comparison** (100,000 runs a player): with no instruments, random moves vault 0.043 a run, a simple player 0.649 and the strategy 1.169. With rewards on, 0.243, 1.398 and the headline's 4.01.
- **The strategy page's chain table** now scales its cut-offs with the runs: the lab keeps the cases with at least 1 consume per 100 runs (and at least 100), and the page shows those with 1 per 20 runs below Legendary. They were fixed at 1,000 and 5,000 consumes, which only 100,000 runs reach: a 2,000-run guide kept 3 cases, and keeps 23 now.

### Events appear at random, seen at once (2026-10-17, evening)

The user: "you need to pass a cell in order for an event to spawn ... isn't the case, events can spawn anywhere on the board at random on any turn". Until now the simulator hid an event behind each locked door at 5% at the start, showed it only once the warden walked past, and added new ones only by Instigate or when an emptied cell sealed again (5%).

Players' boards agree with the user (147,602 screenshot boards in 5,288 games, ids 750,000 on; scratch tools event-appear.js and event-spawn.js):
- **Before any walk:** 72% of runs' first boards (day 1, the warden in the office) already show an event: one on 2,760 of 3,946, two on 56, none on 1,130.
- **Where new ones turn up:** of the doors gaining an event between two boards, 1,505 were on the warden's walk, 1,132 came with an office stop (Instigate), and 8,512 were neither, all on locked doors.
- **Real, mostly:** 85% stay until their door opens; 15% vanish with the door still locked (likely misreads).
- **When:** after the patrol's walk (10.0% of walks), overnight (5.8% of nights), after a move during the day (4.7%). About 1 game-day in 8 shows a new one, almost always just one.

So now (`spawnEvent`): a run starts with one event behind a random locked door at 72% (`eventStartChance`). Then a new one appears behind a random locked door without one (and not a rat nest) at 5% each morning from day 2 (`eventMorningChance`), 9% after the patrol's move (`eventWalkChance`), and 4% after a Consume (once its chain is over), Replace, Hunt or event choice (`eventActionChance`). These are the measured rates less the 15% of misreads, in whole percent. Every event shows at once. Walking past a door reveals nothing, an emptied cell that seals again gets no roll of its own, and an event a save kept hidden shows on loading. The strategy no longer values a door the warden hasn't passed for a hidden event, and its playouts no longer re-roll such events.

On 300 runs played by the strategy: 71% start with an event, and 0.18 new events appear a day. The sections below were measured under the old rule; the section above has the lab's numbers under this one.

### Measured again with the vault cap and Instigate (2026-10-17)

With the vault's 10 slots and Instigate's events (2 on a board with no event yet, else 1) in the engine, and the Filthy Claws and the Blood-Stained Trap among the instruments, the instrument pairs, the guide and the contract challenge were measured again from scratch on 4 threads (the engine and solver of bebf979).

- **Headline, rewards on** (`guide --no-tune`, 100,000 runs per measurement, 5,600,000 runs in 23.6 minutes): **3.471** Rainbows a run (±0.011), against 3.493 before. 96.7% of runs vault one, the first around day 9.5, with 9.2 Replaces and 5.2 consumes per run. With no instruments, 0.896 (was 0.980), most likely Instigate's fewer events: always taking Instigate fell from 0.944 to 0.780, while always taking Bestow stayed at 0.795.
- **Instruments alone:** Iron Crown of the Prison King 2.65, Blood-Stained Trap 2.22, Hangman's Noose 2.17, Filthy Claws 2.14, Elephant-Foot Maul 2.04, Scapegoat's Guillotine 2.03, Severed Iron Maiden 2.01, Kin's Coin of Fate 1.96, Long-Chained Shackles 1.75, Agonizing Muzzle 1.65, Executioner's Blacklist 1.57. Every one but the Squirming Iron Box (+0.03) lost 0.02 to 0.15. Worse than no instrument: the Iron Box (−0.33) and the Forged Key (−0.12); the Iron Pestle and the Gaoler's Execution Axe are level with none. The drill ranking (`toolRank`) follows this order: the Maiden now comes before Kin's Coin and the Muzzle before the Blacklist, and the Burning Stake moves up from 18th to 15th.
- **Pairs** (`combos --max 2`, nothing carried over): 497 sets of up to 2 instruments, each to ±0.01, in 20.4M runs (105 minutes). The pair lab's no-instrument baseline is 0.898.
  - The Maiden with the Noose makes 9.27 Rainbows a run, where the uncapped vault let it reach 15.45. It's still the best pair, 5.99 beyond its parts. Then the Maiden with the Scapegoat's Guillotine (5.82), the Iron Box with the Rat Heads (4.08), the Crown with the Muzzle (4.07) and the Crown with the Claws (4.03).
  - Clashes: the Scapegoat's Guillotine with the Crown (−1.02), the Noose (−0.97), the Trap (−0.93) and Kin's Coin (−0.83), and the Iron Box with the Claws (−0.75).
  - The Trap does best with the Crown (3.88), the Noose (3.69) and the Claws (3.30); the Claws with the Crown (4.03), the Muzzle (3.52) and the Maul (3.40).
  - The best second instrument differs from the single ranking for 12 of the 31.
- **Habits** (no instruments): always accepting Executions (0.683), never replacing (0.754), always taking Instigate (0.780), preferring short walks (0.783) and always taking Bestow (0.795) cost the most. Accepting Chain reactions measured 0.902, 0.006 above the strategy and inside the ±0.01 target, so the setting stays.
- **Warden's Treasure:** judging each gift on the spot (3.471) beats always taking the same one: Crimson Vintage 3.29, Three-Headed Thumb Ring 3.09, Brass Horn of Strife 2.88, Brand of Original Sin 2.85.
- **Contract challenge** (`cguide --games 200000 --habit-games 100000`, 1,700,000 runs in 12.6 minutes): 95.0% pass with 52.1 points, against 95.5% and 52.4 before. Sending the most points on every contract passes 36.2%, keeping 1 voucher 75.6%, and playing with the drill weights 93.1%. Of the 5.0% that fail, 2.1% never reach a Supreme and 2.9% miss both early contracts. The challenge's own instrument ranking wasn't measured again.
- **Still to confirm in the game:** these numbers take the Trap's Hunt as the day's action, marking one inmate, and the Claws' scratches as letting a Wolf of that rarity consume through the door for +3. Both are the simulator's readings of the cards.

### Measured again with "Treasure" Hunt and the Elephant-Foot Maul (2026-10-16)

With "Treasure" Hunt in the event pool and the Elephant-Foot Maul among the instruments, the instrument pairs, the guide and the contract challenge were measured again on 4 threads.

- **Headline, rewards on** (`guide --no-tune`, 100,000 runs per measurement, 5,400,000 runs in 20.1 minutes): **3.435** Rainbows a run (±0.011), up from 3.380. The Hunt alone took it down to 3.299 (next section); the Maul, offered like any other instrument, more than makes up for that. 97.2% of runs vault one, the first around day 9, with 9.3 Replaces and 5.2 consumes per run. With no instruments, 0.980 (was 1.026, the Hunt's cost).
- **Instruments alone:** Iron Crown of the Prison King 2.70, Hangman's Noose 2.23, Elephant-Foot Maul 2.16, Scapegoat's Guillotine 2.16, Kin's Coin of Fate 2.09, Severed Iron Maiden 2.03, Long-Chained Shackles 1.82, Executioner's Blacklist 1.72, Agonizing Muzzle 1.70, Ravenous Chains 1.65. The Maul and the Guillotine are level within the margin (±0.006). The drill ranking (`toolRank`) follows this order, so the Maul moves from right after the Crown to third.
- **Pairs** (`combos --max 2`): 435 sets of up to 2 instruments, each to ±0.01, in 17.5M runs. The 406 sets without the Maul were measured with the Hunt and carried over: without the Maul, the Maul's code plays 3,000 seeded runs move for move as before. The Maiden with the Noose, at 15.45 Rainbows a run, took 1.16M of the runs. The pair lab's no-instrument baseline is 0.978.
  - The Maul's best partners: the Noose (3.64), the Crown (3.30) and the Muzzle (3.07). It clashes with the Crown and the Scapegoat's Guillotine (−0.58 each), the Squirming Iron Box (−0.57) and the Blacklist (−0.45). With the Crown, likely because Maul Mammoths eat the Lions the Crown climbs with.
  - The other best pairs are as before: the Maiden with the Noose (15.45), the Maiden with the Scapegoat's Guillotine (5.77), the Iron Box with the Rat Heads (4.09), the Crown with the Muzzle (4.09) and the Noose with Kin's Coin (3.97).
  - The best second instrument differs from the single ranking for 11 of the 29.
- **Habits** (no instruments): always taking Bestow (0.796), preferring short walks (0.828), always accepting Executions (0.832) and never replacing (0.855) cost the most.
- **Warden's Treasure:** judging each gift on the spot (3.435) beats always taking the same one: Crimson Vintage 3.23, Three-Headed Thumb Ring 3.06, Brass Horn of Strife 2.88, Brand of Original Sin 2.84.
- **Contract challenge** (`cguide --games 200000 --habit-games 100000`, 1,700,000 runs in 10.3 minutes): 95.4% pass with 52.4 points, against 95.4% and 52.5 before. Sending the most points on every contract passes 35.9%, keeping 1 voucher 78.0%, and playing with the drill weights 93.1%. The Maul stays third in the challenge's ranking (its section below). A first try ended in a Node crash (a segmentation fault, no JavaScript error) partway through. Replaying the same runs went through, and the second try matches the first run for run as far as the first got.

### Blood-Stained Trap: Berserk Lion (2026-10-17)

Report 100, the card: "Blood-Stained Trap: Berserk Lion. Condition: Stops at Berserk Lion's cell. Effect: Adds Hunt to decision options, which can add a Prey mark to Consumable targets". It's the 31st instrument (`trap`), read like the Iron Crown, whose card names the Berserk Lion: every Lion.
- **Hunt:** with the warden on a Lion that has no prey mark, Hunt is a third choice beside Consume and Replace (`T.hunt`, `T.huntTargets`, `T.canHuntNow`). A day has one of the three.
- **The mark:** the Lion marks one inmate it can consume that has no prey mark either. Then the simulator's Prey marker rule applies: each morning both rise a tier, for 3 mornings, until either leaves the block or changes beast. That rule predates the live game. The card doesn't say whether Hunt uses up the day's action, or whether it marks one target or every one; this is a reading to confirm.
- **Strategy:** it hunts when the mark (`linkValue`, at 80% for the chance it ends early) is worth more than the best consume and Replace, and it already guards marks from being eaten.
- **Pages:** the simulator page has a Hunt button that asks which inmate to mark, and the analyzer counts a Hunt as the day's action. The reader doesn't know the game's Hunt card in the decision row yet.
- **Measured in the pair lab** (`combos --max 2`, 31 new sets to ±0.01; the others carried over, since without the Trap the code plays 3,000 seeded runs as before): alone 2.33 Rainbows a run, second after the Crown (2.70). It does best with the Crown (3.92), the Noose (3.77) and the Claws (3.37), and clashes with the Scapegoat's Guillotine (−0.93), the Maul (−0.61) and the Avenger's Casket (−0.58). The drill ranking has it second. The challenge ranking keeps it after the Ravenous Chains.
- **The guide and the challenge:** measured with the vault's 10-Rainbow cap, in the first section of Results.

### Filthy Claws: Alpha Wolf (2026-10-17)

Report 65, the card: "Filthy Claws: Alpha Wolf. Condition: At the start of each day. Effect: Randomly adds a Scratch Marks mark to 1 unopened cell". It's the 30th instrument (`claws`). Each morning, before the destinations are drawn, it scratches one random unopened cell that isn't scratched yet and isn't a rat nest. The inmate behind it is settled then, and its rarity shows. The scratch works as the simulator's Scratch marker always has: a Wolf of that rarity can consume the inmate through the door, whatever its beast, for +3, and the strategy already counts those meals. That rule predates the live game and isn't confirmed there.

Supporting evidence (report 243, the evening of 2026-10-17): a board with two Magic scratches (cells 02 and 15) had a Magic Wolf in 08 with its jaws marker, while no Magic Rat, its only other meal, was on the board. That fits a Wolf consuming through a scratched door of its rarity. The +3 isn't shown there. The same picture shows the reader taking scratched doors for plain locks, which c2 is fixing.

Measured on 4 threads. The 435 sets without it carried over: without the Claws, the code plays 3,000 seeded runs move for move as before.
- **Alone:** 2.19 Rainbows a run (guide, 100,000 runs; 2.196 in the pair lab). That's third, after the Crown (2.70) and the Noose (2.23), and just ahead of the Maul and the Scapegoat's Guillotine (2.16 each). The drill ranking (`toolRank`) has it third.
- **Pairs** (`combos --max 2`, 465 sets to ±0.01): best with the Crown (4.05), the Agonizing Muzzle (3.53, the most beyond their parts, +0.60) and the Maul (3.46). It clashes with the Squirming Iron Box (−0.71; the nests and the scratches want the same locked cells), the Noose (−0.23) and the Blacklist (−0.21).
- **Headline, rewards on:** 3.493 Rainbows a run (±0.011), up from 3.435 now that the Claws are among the picks. 97.4% of runs vault one.
- **Contract challenge:** 95.5% pass with 52.4 points (was 95.4% and 52.4). In the challenge's own ranking it stays tenth, where it was. Where it sits there barely matters (200,000 runs each: 95.45% after the Crown, 95.42% tenth, 95.32% last).

### Second meals below Legendary: what the jaws show (2026-10-17)

c2 noticed Rare Mammoths with jaws whose only meal at their rarity was a Rare Wolf, in the user's run 2026-10-17T04-18-38 (no start card, objective Consume 4 times, Kin's Coin only). On its picture 16, with the warden on a Rare Mammoth, the game offered Consume, and the Mammoth's only Rare prey were Rare Wolves.

Then the reader went over 349 boards: the user's recorded runs, the labelled screenshots and the report pictures, never the tutorial. It counted the inmates with jaws markers on their boards, leaving out Supremes, whose glow was read as jaws until 3c5f194:
- **Only a second meal at its own rarity, no lower prey** (jaws mean the game allows it): Normal Lion 30 with jaws, 0 without; Normal Mammoth 52 and 3; Magic Lion 11 and 0; Magic Mammoth 13 and 0; Rare Lion 9 and 0; Rare Mammoth 5 and 0; Legendary Lion 9 and 0; Legendary Mammoth 15 and 2. Below Legendary, that's 120 with jaws and 3 without.
- **Checks:** only lower-rarity prey, 2 with jaws of 404 (no Cage Fight in these runs); nothing to eat, 3 of 475; a first meal, 630 with jaws, 25 without.

The user chose to keep second meals at Legendary and up (`doubleEatTier` 3), so nothing in the rules changed. The analyzer keeps marking a lower-rarity Lion or Mammoth with jaws and only a second meal as one to check.

Two player reports later that day went further than jaws:
- **Report 206:** the game's meal pick ("Select an Inmate to Consume") offered a Rare Lion two Rare Rats (c2 checked the portraits: rat at 0.97 against wolf at 0.6 to 0.66), and the next board shows the Lion as a Legendary Lion with cell 07 gone. That run wasn't Cage Fight: three other consumes in it re-rolled the eater's beast. The analyzer had said it "can't find a meal".
- **Report 208:** the game offered Consume to a Normal Mammoth with jaws whose only same-rarity food was a Normal Wolf, and the analyzer advised a Replace without weighing Consume.

The rule stays as the user decided (Legendary and up, outside Cage Fight); these join the evidence above. Since then the analyzer names the case: when the warden's inmate has only second meals at its rarity, the meal pick's problem and the Consume note list them and point at Cage Fight, instead of calling the board misread. Scratch tools: read-webps.js / png-readings.js (readings), meal-summary.js (groups).

### Behind Cell Doors (2026-10-17)

Reports 30 and 51: "Objective: Behind Cell Doors. Open 10 cells", paying another instrument pick (and a Warden's Cache at the riot, not simulated), like Survival of the Fittest. It counts like that one does (`countObjective`), here in `openCell`: every cell that opens counts, however it opens (a patrol, a chain, the Lost Ring of Keys, a hatching nest), since the card doesn't say. Like the other live objectives, it isn't drawn in simulated runs; the analyzer has it in its objective list, and the reader takes its title (word lengths 6, 4, 5), which it first read as King of the Caged.

### "Treasure" Hunt (2026-10-16)

Report 41, a card with only Confirm: "Reveals all unopened cells with rarity below Rare". A revealed door shows its rarity with a "?" portrait, as with Crow Whispers, so the player can tell that the locked doors left dark hold Rare or better. The engine marks those (`atLeast`, cleared when the cell opens or empties): the solver values such a door at the door odds from Rare up, and re-rolls what's behind it only from Rare up. Nests are passed over, as Crow Whispers does. It's the 10th event in the pool. The analyzer has it as an event and a door mark, and a "left dark" door kind (Rare or better); a screenshot keeps a door's shown rarity and its Rare-or-better floor while the door stays locked, since the reader takes a "?" portrait for a plain lock.

In the pool it costs a little, since events come up evenly and this one only informs: on the guide's prisons (`variants --seed GUIDE`, 100,000 runs each), rewards on 3.299 against 3.380 without it, and no instruments 0.980 against 1.026. The section above measures the guide, the pairs and the challenge with it; the sections below were measured without it.

### Measured again with the live odds (2026-10-16)

With the live rarity odds (40/38/12/8/2 behind doors and 52/32/9/6/1.5 from a Replace, two sections down), the instrument pairs, the guide and the contract challenge were measured again on 4 threads. "Treasure" Hunt (report 41) wasn't in the event pool yet.

- **Headline, rewards on** (`guide --no-tune`, 100,000 runs per measurement, 5,300,000 runs in 27.9 minutes): **3.380** Rainbows a run (±0.011), up from 2.958. 97.2% of runs vault one (was 95.6%), the first around day 9 (was 10), with 9.4 Replaces and 5.1 consumes per run. With no instruments, 1.026, up from 0.816.
- **Instruments alone:** Iron Crown of the Prison King 2.73, Hangman's Noose 2.27, Scapegoat's Guillotine 2.20, Kin's Coin of Fate 2.14, Severed Iron Maiden 2.05, Long-Chained Shackles 1.85, Executioner's Blacklist 1.79, Agonizing Muzzle 1.73, Ravenous Chains 1.71. The drill ranking (`toolRank`) follows this order.
  - The Noose rose the most (from 1.67): with the live Replace odds, 36% of what it brings in is Legendary and 9% Supreme (it was 29% and none).
  - Level with no instrument: the Searing Branding Iron and the Iron Pestle (1.02). Worse: the Gaoler's Execution Axe 0.97, the Forged Key 0.84 and the Squirming Iron Box 0.56.
- **Pairs** (`combos --max 2`): 407 sets of up to 2 instruments, each to ±0.01, in 16.4M runs. The Maiden with the Noose, at 15 Rainbows a run, took 1.18M of them. The pair lab's no-instrument baseline is 1.030.
  - Best pairs: the Maiden with the Noose (15.16), the Maiden with the Scapegoat's Guillotine (5.76), the Squirming Iron Box with the Skewered Rat Heads (4.11), the Crown with the Muzzle (4.08) and the Noose with Kin's Coin (4.01).
  - Beyond their parts: Iron Box with Rat Heads +2.96, Maiden with Guillotine +2.53, Iron Box with Kin's Coin +2.24, Maiden with the Burning Stake +1.23, Crown with the Lost Ring of Keys +1.06.
  - Clashes: the Scapegoat's Guillotine with the Crown (−1.01), the Noose (−0.96) and Kin's Coin (−0.84). Likely because each of its Replaces removes 2 inmates the Crown's Lions and the Coin's matching pairs need, and with the Noose the new inmate already comes in Rare or better.
  - The best second instrument differs from the single ranking for 10 of the 28.
- **Habits** (no instruments): always taking Bestow (0.807), preferring short walks (0.858), always accepting Executions (0.886) and never replacing (0.900) cost the most.
- **"Never replacing" was mis-measured.** Since the Burning Stake (f0100c3), the solver's Replace cap had a floor at Normal, so `swapMaxTier` −1 still replaced Normals and scored the same as "Replacing Normals only". That's why the second-meals section below found never swapping "about even", and the strategy page and the Trainer said so.
  - Now −1 never replaces, a Tusk cell included: 0.900 against 1.026, on the guide's prisons (`variants --seed GUIDE`, where the full strategy gives the guide's 1.0259 again). The page and the Trainer now say never replacing costs Rainbows.
  - The profiles the site plays all cap at Normal or higher, so no advice changed.
- **Warden's Treasure:** judging each gift on the spot (3.380) beats always taking the same one: Crimson Vintage 3.20, Three-Headed Thumb Ring 3.00, Brass Horn of Strife 2.87, Brand of Original Sin 2.81.
- **Contract challenge** (`cguide --games 200000 --habit-games 100000`, 1,700,000 runs in 15.1 minutes): 95.4% pass with 52.5 points, up from 93.7% and 51.8. Sending the most points on every contract passes 35.1%, keeping 1 voucher 78.2%, and playing with the drill weights 93.1%. The challenge profile and its instrument ranking weren't tuned again.

### Sewer Ratway (2026-10-16)

Report 13 and the user's screenshots: "Select any 1 cell (excluding the Interrogation Room), move to that cell, and trigger subsequent content", then the game asks "Select an Objective" with every cell but the office on offer, the warden's own included. It's in the event pool with the others. Its card has only Confirm, and moving to the warden's own cell keeps it in place, so the strategy always takes it. Then it weighs every cell as it weighs a patrol, without the walk: the move adds no tiles and sets off no Shackles. The analyzer has a Sewer Ratway step for that screen.

### Live odds for doors and Replace (2026-10-16)

Players' boards (tools/live-data.js) showed the simulator's rarity odds were off. Behind doors, over 1,011 doors (no tutorial runs, no Sorting Hook or Felon's Dog Tag), live is 39.8% Normal, 38.5% Magic, 11.7% Rare, 8.2% Legendary and 1.9% Supreme, steady from day 1 to day 15+. The simulator had 52/27/15/6/0. Replace brings in 51.7/31.4/9.2/6.1/1.5 over 261 Replaces (no Noose, Maiden, Scapegoat's Guillotine or Stake roll). At the user's word, the simulator now uses 40/38/12/8/2 for doors (`tierWeights`) and 52/32/9/6/1.5 for Replace (`swapWeights`, new; the Lab takes halves). The Lab's saved settings move to params:v6 and pick up the new door odds. Everything below was measured with the old odds; "Measured again with the live odds", above, has the new measurements.

### Usurpation III and IV (2026-10-16)

The user's cards: Usurpation III "Randomly increase 2 Inmates' rarity by 2 tiers / Add [Usurpation IV] to Prison Incidents and remove [Usurpation III] from Prison Incidents", and IV "Increase all Inmates' rarity by 2 tiers", then it leaves the Prison Incidents. So the chain runs I → II → III → IV (`T.USURP`): I raises 1 inmate a tier, II 2 a tier (its card is unseen, read from the others), III 2 inmates 2 tiers, IV every inmate 2 tiers. Each leaves the pool and brings the next. Only I's card also puts the next behind a locked door at once. The strategy accepts them all.

### The Elephant-Foot Maul: Mammoth (2026-10-16)

Report 57, the card: "Elephant-Foot Maul: Mammoth. Effect: Mammoth can Consume higher-rarity countered Inmates; after Consuming, its rarity increases to +2 tiers above the consumed target's rarity". Read like the Iron Crown, whose card names the Berserk Lion: every Mammoth, on every bite. A Mammoth can eat what it counters (Lions, and Wolves from Legendary up) at any higher rarity, and each bite takes it to 2 tiers above the meal, so a same-rarity meal gives +2 and a Normal Mammoth eating a Legendary Lion reaches Rainbow. Other instruments' extra tiers come on top, and the eater re-rolls its beast as usual. The strategy's chain math takes the higher meals (`topMeal`, the Maul's gain in `bite`, and the explanation's chain odds). Measured (the first section of Results), it makes 2.16 Rainbows a run held alone, third after the Crown and the Noose. In the contract challenge's own ranking it stays third, after the Noose and the Crown; where it sits there barely matters (200,000 runs each: 95.29% pass third, 95.24% after the Scapegoat's Guillotine, 95.16% last). The reader has no panel icon for it yet. A reference cut from the card art (report 57) was tried and pulled the same day: on held-instrument panels it beat the right icons, reading a Casket, and the Tongs with the Whip, as the Maul. It waits for a panel-icon sample.

### Instigate makes 1 event, on any cell (2026-10-17)

The user: "instigate doesn't guarantee 2 events, the sim appears to think it guarantees 2 every time". Their records hold 19 office visits. Comparing the event marks on the boards before and after each visit, the 10 Instigates each added exactly 1 event; none added 2. 5 landed on an open cell beside an inmate (the "!" that a walk into the cell sets off) and 5 on a locked cell. So that's where open-cell events come from. The other visits were Bestows (1 tier-up) or were cut short by a Treasure.

The user then said it may make 2 when the board has no event yet. All 10 recorded Instigates had one already, so that's taken as the rule until their test says otherwise (`T.instigateCount`: `INSTIGATE_EVENTS_EMPTY` 2 on an event-free board). Otherwise `T.INSTIGATE_EVENTS` is 1, on a random cell from `T.instigateCells`: a locked door with no event or nest, or an open cell with an inmate and no event. Tyranny's extra Instigates make 1 each too. The solver's office value counts those cells. On 3,000 runs each, rewards on: no card 3.421 Rainbows (3.540 with 2 events behind locked doors), Tyranny 6.584 (7.267). The lab numbers were measured again with this and the vault cap (the first section of Results).

### The vault holds 10, and Opulence's chain (2026-10-17)

The user: "it caps at 10, then only allows things to go up to red max". The vault panel has 10 slots. Once it's full, an inmate that would reach Rainbow stays Supreme: no vault entry and no Treasure (`T.VAULT_SLOTS`, in afterGrowth). The solver's playouts stop in a drill once the vault is full, since the score can't change. The strategy values a would-be Rainbow as a Supreme then. Uncapped, Opulence's picks could cascade without end: a one-pick look-ahead for the gifts ran to about 157 Rainbows a run.

The user's chain with Opulence goes Thumb Ring, then Crimson Vintage, then the Brass Horn, whose consumes make Rainbows that each bring 3 more picks ("it guarantees 10 rainbows everytime basically"). The playouts' gift pick (`pickGift`) now follows it before the board-value pick (`giftChain`). It takes the Horn when it makes a Rainbow now (3 tries), else the Thumb Ring while 3 or more picks wait and a door is shut, else Crimson Vintage while 2 or more wait and an inmate is below Legendary. Results on capped Opulence runs, 3,000 each, same seeds:

| Gift picks in playouts | Rainbows a run | Reached 10 |
|---|---|---|
| Board value (before) | 6.66 | 26.7% |
| The chain (now) | 7.70 | 56.7% |
| The chain, Ring with only 2 waiting | 7.39 | 55.0% |
| Strictly Ring, Vintage, Horn by picks left | 6.74 | 40.3% |
| With Brand of Original Sin in the middle | 4.99 to 6.03 | 20 to 29% |
| One pick looked ahead (1,000 runs) | 7.45 | 46.2% |

Without the card it changes nothing (20,000 runs: 3.530 against 3.532). The capped Opulence playout costs about 7 ms a run, against 37 ms uncapped. On the user's day-20 board (vault 7, 3 picks), the live check now ranks the Thumb Ring first (7.44), where the old one said Brand.

### Opulence, a start-of-run card (2026-10-17)

The user's screenshot: "Opulence. You can make 2 additional choices when obtaining Warden's Treasure", and their word: each Treasure is 3 picks in a row, and a Rainbow made by a pick brings 3 more. Their game log agrees: a run with 7 Rainbows had exactly 3 confirmed picks for each, and one pick's Rainbow (04:54:46) added 3 to the 1 left. The engine queues 3 gift picks a Rainbow with the card (`T.START_EVENTS.opulence`, `picks` 3). The analyzer keeps the picks waiting on the Treasure (`model.choice.picks`, "Picks left" under the offer), and the live check plays all of them out. Before this it advised every pick as if it were the last. On the user's day 20 (vault 7, warden in 08), that meant Brand of Original Sin three times, worth about 7.0 Rainbows. A replay of that board (scratchpad opulence/replay.cjs: every first pick, with the next picks searched as well) found Three-Headed Thumb Ring first 8.19, Crimson Vintage first 8.12, Brand first 7.87 and the Horn first 7.18. The best fixed order was Thumb Ring → Vintage → Vintage (8.19). The Horn pays only twice in a row: the first makes Supremes, the second has them eat each other.

Auto Screenshot Mode counts the picks from the log (js/follow.js). A Rainbow plays `UI_S16_Premium_Quality_Fly` and lights a vault cell (`Anim_Archive_LightUp`, a "not found" warning today); either line counts it, once. A pick is a `S16BoardColoredPop Run` followed by `Btn_S16Board_ColoredPop_Confirm`; a double-click on Confirm counts once. Every picture sent to the analyzer carries the counts. The analyzer adds 3 picks for each new Rainbow (1 without the card) and takes 1 off for each confirm. js/auto.js treats a board picture between two picks as the board behind the next one, so the next advice uses the board the last gift changed. After the last pick the board goes the usual way. A tally still waiting with no Treasure for 30 s is dropped. Simulated runs don't draw start cards yet.

### Tyranny, a start-of-run card (2026-10-16)

The user's screenshot: "Tyranny. Automatically triggers Instigate and Bestow 3 additional times each time you stop at the Interrogation Room". Read as 3 more of each on every stop at the office, by themselves and before the visit's own choice, which stays (`T.START_EVENTS.tyranny`, `extra` 3). The strategy adds what 3 Bestows and up to 6 new events are worth to a walk to the office, so with the card it heads there far more often: on a test board the office scored 142.8 against 32.2 without it. The analyzer has it under Start of run, and its popup reader knows the one-word title (a lone 7-letter word; every other saved screenshot reads as before). Simulated runs don't draw start cards yet.

### Start-of-run cards: Cage Fight and Iron Law (2026-10-16)

The user's screenshots show cards before a run starts, besides its objective (the objective shows on the board, as "Objective: Survival of the Fittest"): Cage Fight, below, and Iron Law, "Extends the duration of the current run to 30 days". Cage Fight was first set up as an objective; it's now a start card (`state.startEvent`, `T.START_EVENTS`), so a run keeps its objective's tool with it, and older saves move it over. The analyzer has a Start of run setting, which Iron Law sets to a 30-day run keeping the days left, and its popup reader knows both titles. Simulated runs don't draw them yet.

### Cage Fight (2026-10-16)

The user's screenshot of a new objective: "Cage Fight. Inmates can Consume lower-rarity countered Inmates; Consuming does not randomly change their Codes". From the user: an inmate can eat any inmate it counters at its own rarity or lower. Only Mammoths and Lions eat two kinds (Mammoths: Lions and Wolves; Lions: Wolves and Rats), at any rarity; Wolves eat only Rats, and Rats only Mammoths. "Codes" are beasts, so the eater keeps its beast. The analyzer can set it as the run's objective (`cagefight`, with no tool to earn), and the strategy's chain math follows it (lower-rarity meals, no re-roll). Simulated runs don't draw it. A quick check of 200 runs with no instruments: 3.07 Rainbows a run against 0.82 without it.

### Second meals and the game's Cancel, measured again (2026-10-16)

From Legendary up, Mammoths also eat Wolves and Lions also eat Rats (fbbc8ba), and a consume chain can be stopped at any bite (4fb3ecd). Everything was measured again on 4 threads:

- **Headline, rewards on:** 2.958 Rainbows a run (±0.010), up from 2.153. With no instruments, 0.816, up from 0.627.
- **Instruments alone,** 100,000 runs each: Iron Crown of the Prison King 2.58, Severed Iron Maiden 2.08, Kin's Coin of Fate 1.96, Scapegoat's Guillotine 1.82, Hangman's Noose 1.67, Long-Chained Shackles 1.61, then the Blacklist and the Muzzle at 1.54. The drill ranking (`toolRank`) follows this order. The Squirming Iron Box (0.45) and the Forged Key (0.57) still cost Rainbows on their own.
- **Pairs:** 407 sets of up to 2 instruments, each to ±0.01, in 14.8M runs. The pair lab's no-instrument baseline is 0.817. The best pairs are the Maiden with the Noose (16.28), the Maiden with the Scapegoat's Guillotine (5.29) and the Crown with the Muzzle (4.01). The Crown gains most beyond its parts with the Lost Ring of Keys (+1.00) and the Muzzle (+0.70).
- **Habits** (no instruments): never swapping now comes out about even (0.813 against 0.816), where before the second meals it was among the costliest habits. (A bug: since the Burning Stake, "never" still swapped Normals, so this was Normals only. See the live-odds measurements above.) Always taking Bestow (0.590), short walks (0.651) and always accepting Executions (0.661) cost the most. The strategy page and the Trainer now say swapping is about even without tools.
- **Stopping chains:** in the 100,000-run headline the strategy never stopped a chain (`stopMargin` 0). The live check still weighs Stop the chain (Cancel) at every bite.
- **Contract challenge:** 93.7% pass and 51.8 points, up from 90.7% and 51.3.

### The Iron Crown of the Prison King (2026-10-16)

Report 20, the card: "Iron Crown of the Prison King: Berserk Lion. Condition: When Berserk Lion Consumes. Effect: Berserk Lion can Consume any Inmate of the same rarity. +2 additional Rarity Tiers after consuming". Read like the Skewered Rat Heads, whose card names the Colossal Rat: every Lion can consume any inmate of its own rarity, and each of its bites gains +2 extra tiers, +3 in all. A Lion that re-rolls into another beast loses it until it's a Lion again. Alone it makes 2.58 Rainbows a run, the best single instrument, ahead of the Severed Iron Maiden (2.08), and the strategy ranks it first. Its best partners are the Agonizing Muzzle (4.01) and the Lost Ring of Keys (3.63).

### The Burning Stake and Kin's Coin of Fate (2026-10-16)

Measured alone and in pairs on 4 threads (no instrument 0.633):

- **Burning Stake** (the user's screenshots of its card): one destination fewer each morning, and swapping out an inmate below Legendary has a 40% chance to bring in a Legendary. The simulator first had it under this name, then took it for a mistranslation of the Searing Branding Iron; the live game has both. 0.924 alone, 15th of 27: the lost door costs nearly what the Legendaries bring. Holding it, the strategy swaps up to Rare. Best with the Severed Iron Maiden (3.50, +1.24 beyond their parts) and Kin's Coin (2.94).
- **Kin's Coin of Fate** (report 17): each morning, when two or more inmates share a beast and rarity ("matching", as the user read the game's link), 60% chance that one of them is removed and another like it gains +2 tiers. 1.907 alone, 2nd of 27. Best with Hangman's Noose (3.51) and the Squirming Iron Box (3.46, +1.88 beyond their parts: its nests hatch matching Rare Rats).

### The Ravenous Chains and the Scapegoat's Guillotine (2026-10-16)

Two more instruments, measured alone and in pairs on 4 threads (no instrument 0.633):

- **Ferocious Beast's Ravenous Chains** (from the user's screenshot of the card): each morning the highest-rarity inmate removes the inmates in the cells on either side of it on the ring, with a 40% chance of +1 tier for each one removed. 1.369 alone, 5th of 25. Best with the Severed Iron Maiden (2.76). With the Squirming Iron Box it makes 2.04, 1.00 beyond their parts: the box's nests keep feeding the chains.
- **Scapegoat's Guillotine** (report 12): when a swap has 2 or more other inmates on the block, 2 random ones are removed and the new inmate comes in above the rarity it replaced. 1.810 alone, 2nd of 25. Holding it, the strategy swaps up to Supreme, weighing the guaranteed rise against what the 2 removed inmates are worth on average. With the Maiden it makes 5.29 (+2.14 beyond their parts).
  - When the rarity weights reach no higher than the old inmate (a Supreme), the newcomer comes in one tier above, so a swapped Supreme becomes Chromatic. That is a reading of "guarantee that the Inmate's rarity is increased", and much of the Guillotine's value rests on it.
- **Contract challenge:** the Guillotine ranks after the Maiden, and the Chains after the Long-Chained Shackles.

### The Severed Iron Maiden and the Barbed Whip (2026-10-16)

Two more instruments from players' reports (#9 to #11), measured alone and in pairs on 4 threads (no instrument 0.633):

- **Severed Iron Maiden**: after a swap, if the block has as many inmates above the new inmate's rarity as below it, the newcomer gains 3 tiers. The user confirmed that nobody above and nobody below counts. 1.968 alone, now the best single instrument (the Executioner's Blacklist is next at 1.552).
  - Holding it, the strategy swaps up to Legendary (`maidenSwapTier` 3). With the no-tools profile's usual cap at Magic it made 1.68; up to Rare 1.91, Legendary 1.96, Supreme 1.92.
  - With Hangman's Noose it makes **16.17** Rainbows per run. Every inmate the Noose swaps in is Rare or Legendary, so a level swap reaches Rainbow at once, and swapping an inmate that's alone on the block is always level.
  - If nobody above and below didn't count, the Maiden would make 1.23 and the pair 2.63 (4,000 runs each).
- **Barbed Whip**: one destination fewer each morning, and each bite of a devour has a 35% chance of +1 extra tier. The card was cut off after "+1 additional Rarity Tier"; the user confirmed reading it like the Rusty Saw. 0.852 alone (12th of 23): the lost door costs more than the extra chance gains (the Saw alone makes 1.005). Best with the Maiden (2.02) and the Noose (1.65).
- **Contract challenge:** where the Maiden sits in its ranking makes no measurable difference (90.9% pass first, second or last), so it's second, after the Noose. The Whip follows the Saw.
- **Screenshot reader:** it learned both from the reports: the Maiden's panel icon (report 9), the Whip's card (report 11) and the Whip's panel icon (report 10, which it had read as the Squirming Iron Box).
- **The guide with both in the pool** (`guide --no-tune` and `cguide`, 100,000 runs per measurement):
  - Rewards on: 2.153 Rainbows per run (2.160 before; within the margin), 86.8% of runs vault one. Both the Maiden and the Noose rarely come up in the same run.
  - Gifts: judging each one on the spot (2.153) now barely beats always taking Crimson Vintage (2.145).
  - Contract challenge: 90.7% pass with 51.3 points.

### A day has a swap or a devour, not both (2026-10-16)

Confirmed in the live game: once the warden's inmate is swapped there is no devour that day, and a devour uses up the day's swap. The strategy used to swap first and then devour with the new inmate. Now the two are alternatives, and it swaps only when the swap is worth more than the best devour (`swapMargin` 0).

On 100,000 drills per variant with rewards on, on the same prisons (`variants --rewards on --seed SWAPDEV`):

| When a devour is on offer, swap… | Rainbows per run |
| --- | --- |
| only if it beats the best devour (`swapMargin` 0) | **2.1225** ± 0.009 |
| only if it beats it by more than 3 (`swapMargin` 3) | 2.1207 |
| if it comes within 3 of it (`swapMargin` −3) | 2.1117 |
| never | 2.0831 |
| whenever the swap gains | 1.5991 |

These runs still picked instruments by the pair data from before the rule, so they sit below the guide's headline. The comparison between them is what counts. The swap tiers hold (`--seed SWAPTIER`). With rewards on, stopping at Rare or at Legendary scores the same (2.1104), and stopping at Magic costs 0.020. With no tools, Normals only and Normal and Magic are level (0.6300 and 0.6272).

**The guide's data** (`guide --no-tune` at 100,000 runs per measurement on 4 threads, 4,600,000 runs in 15.2 minutes). Rewards on: **2.160** Rainbows per run, down from 2.472. 87.0% of runs vault one (was 91.3%), the first around day 12, with 9.1 swaps and 5.1 devours per run. With no tools: 0.627, down from 0.759. A first run, made before the instrument sets below were re-measured, still picked instruments by the old pairs and made 2.108 with rewards on.

- **Each instrument held from day 1:** Executioner's Blacklist 1.545, Long-Chained Shackles 1.463, Hangman's Noose 1.345, Skewered Rat Heads 1.275, Avenger's Casket 1.235, Agonizing Muzzle 1.227, Barbed Collar 1.005, Sorting Hook 1.004, Rusty Saw 0.996, Fanged Guillotine 0.942, Iron Tongs of Lust 0.843, Felon's Dog Tag 0.791, Crowded Beastcage 0.665, Warden's Scales 0.638.
  - Level with no instrument: Iron Pestle 0.623, Lost Ring of Keys 0.621, Short-Chained Shackles 0.610.
  - Worse: Searing Branding Iron 0.573, Gaoler's Execution Axe 0.537, Forged Key 0.394, Squirming Iron Box 0.297.
  - The Noose (1.767 before) and the Muzzle (1.605) lost the most, since swaps now cost a devour.
  - The Blacklist rose from 1.357. With fewer devours, fewer cells empty and re-seal, so 5 or fewer locked cells comes sooner.
- **Habits** (no tools): always choosing Bestow 0.434, always accepting Executions 0.471, preferring short walks 0.481, never swapping 0.536. Never swapping scores what it did before, since the rule never bites without swaps. It was the costliest habit and is now the fourth.
- **Warden's Treasure:** judging each gift on the spot (2.160) still beats always taking the same one: Crimson Vintage 2.105, Brand of Original Sin 1.828, Brass Horn of Strife 1.792, Three-Headed Thumb Ring 1.731.
- **Contract challenge** (`cguide --games 200000 --habit-games 100000`): the trained strategy passes 91.1% with 51.4 points, down from 94.9% and 52.8. Sending the most points on every contract still fails most runs (27.8% pass), and playing with the drill weights makes no measurable difference to passing (91.3%) but scores 1 point less.

**Instrument sets** (`combos --max 2` on 4 threads). The rule changed how the sets play, so they started over, singles and pairs only for now: 6,742,442 runs in 25.4 minutes, every set within ±0.01. With no instrument 0.633.

- **Best pairs:** Squirming Iron Box with Skewered Rat Heads 3.63, Hangman's Noose with Long-Chained Shackles 2.68, Agonizing Muzzle with the Noose 2.49, Lost Ring of Keys with the Executioner's Blacklist 2.46, the Muzzle with the Shackles 2.17.
- **Worth more than their parts:** Iron Box with Rat Heads +2.69, Ring of Keys with the Blacklist +0.92, Muzzle with Noose +0.54, Noose with Shackles +0.50, Searing Branding Iron with the Blacklist +0.44.
- **Clashes:** the Blacklist with instruments that feed devours: the Iron Box −0.58, Avenger's Casket −0.51, Rat Heads −0.46 and the Rusty Saw −0.43. Likely because every devour empties a cell that seals again, which keeps the locked count above the Blacklist's 5.
- **The best second instrument differs from the single ranking for 12 of the 21.** For example, holding the Blacklist the Ring of Keys adds 0.90 and the Shackles 0.54, and holding the Shackles the Noose adds 1.22 and the Muzzle 0.71.
- Picking by the sets still pays: 2.165 Rainbows per run against 2.142 with the single ranking, +0.024 on the same prisons (`variants --rewards on --seed AB`, 100,000 runs each; it was +0.059 before the rule). Sets of 3 and 4 weren't re-measured; with more held, the Trainer averages over the pairs.

### The office, steered chains and six more events; retrained (2026-10-15, evening)

More live play filled in the season:
- **The office is a destination.** Walking there offers Instigate (special events behind 2 locked doors; 2 is what one run showed) or Bestow (1 random inmate rises a tier).
- **Chains are steered.** A chain still runs while the eater has a meal, but when there are two or more the player picks the next one.
- **Six more events**, all equally likely: Ravenous Appetite, High-Risk Convict, Crow Whispers, Taste of Freedom, and Usurpation I, which leaves the pool once it fires and puts Usurpation II behind a door at once. What Usurpation II does (2 inmates rise) is a guess.
- **Events are hidden.** About 5% of locked cells hold one, shown only once the warden walks past; an event room also holds an inmate.
- **The Forged Key**, a 17th instrument: one destination fewer each morning, and a patrol that opens a door has a 50% chance to open another. The **Muzzle** now counts the block after the meal (4 or fewer).
- **Objectives are random in the contract challenge too**, and King of the Caged is never assumed.

**Training.** `train --games 200000` fine-tuned both drill profiles, 2 rounds each, with two new weights in the grid: Instigate's share of an event's worth (`wInstigate`) and a Crow Whispers door (`wCrow`). It took 27,600,000 runs in 35.9 minutes. On 1,000,000 fresh prisons:

| Profile | Before | After | Runs with a Rainbow |
| --- | --- | --- | --- |
| Rewards on (the default drill) | 1.903 | **1.939** ± 0.003 | 82% → 83% |
| No tools | 0.719 | **0.761** ± 0.001 | 59% → 61% |

- **Chain reactions.** With no instruments, skipping them now beats accepting them (0.762 against 0.745 in tuning), so that profile skips them. With rewards on, accepting stays slightly ahead (1.947 against 1.944).
- **The office.** Instigate's weight has a sharp best value at 0.5. At 0.25 the Trainer mostly bestows, and at 1 it mostly instigates, and both cost 4–6%. Picking by the board, it bestowed about 1.7 times and instigated about 1.2 times per run.
- Both profiles put less weight on each step walked (`wStep` 1 → 0.5) and more on a vaulted Rainbow (`rainbowMult`). With rewards on, the Trainer now also swaps Legendaries (`swapMaxTier` 3), though that barely differs from stopping at Rare.

**Instrument sets.** What a second instrument is worth depends on the first, so `combos` measures every set of up to 4 instruments held from day 1, with no other rewards, on the same prisons (seed `COMBO`: game *i* is the same prison for every set). Each set runs until its own 95% margin is under ±0.01 Rainbows per run, the guide's target. Sets with more instruments spread more and need more runs, so they come in stages: singles and pairs first, then sets of 3 and 4 to a coarse ±0.03, then refined to ±0.01. The file `results/tool-combos.json` keeps each set's run count and sums, so a later run carries on where the last one stopped. `js/tool-combos.js` holds the values for the Trainer and the guide.

Singles and pairs: 5,165,948 runs in 5.7 minutes, every set within ±0.010. With no instrument 0.761.

- **Best pairs:** Muzzle with Hangman's Noose 3.93, Squirming Iron Box with Skewered Rat Heads 3.79, Noose with Long-Chained Shackles 3.17, Noose with Rat Heads 2.84, Avenger's Casket with Noose 2.66.
- **Worth more than their parts** (the pair against the two instruments' separate gains added up): Iron Box with Rat Heads +2.70, since the box's daily rat nests become meals once Rats can eat Rats. Iron Box alone is the worst instrument (0.36), but with Rat Heads it's the second-best pair. Also Muzzle with Noose +1.32 and Noose with Shackles +0.47.
- **Clashes:** Iron Box with Noose −0.53, Muzzle with Lost Ring of Keys −0.53 (the Ring's extra doors keep the block above the Muzzle's 4), Iron Box with Muzzle −0.51.
- **The best second instrument differs from the single ranking for 9 of the 17 starting ones.** For example, holding Rat Heads the Iron Box adds 2.30 and the Noose 1.35, and holding the Noose the Muzzle adds 2.16 and the Shackles 1.40.

The Trainer now takes the offered instrument that adds the most to the ones held, from these sets (`toolSets`; past 4 held it averages over the measured subsets). The contract challenge keeps its own ranking, since it plays for points. On 1,000,000 drills with rewards on (`variants --rewards on --seed AB --variants ";toolSets=false"`), that made **1.998** Rainbows per run against 1.938 with the single ranking: +0.059, or 3.1%, on the same prisons.

**Felon's Dog Tag** (an 18th instrument, from a player's report on 2026-10-16: "There is a 25% chance to trigger after opening: +1 Rarity Tier to the current Inmate", read as the inmate behind the door the patrol opens). Measured with `combos`, which now keeps its sets when an instrument is added: 0.925 alone (11th of 18; no instrument 0.762), best with the Long-Chained Shackles 1.92, Hangman's Noose 1.87 and the Agonizing Muzzle 1.75. It works best beyond their parts with the Sorting Hook (+0.18), since every door then holds Magic or better.

**Three more instruments** (2026-10-16, from a player's report and the user's screenshot of an instrument pick), measured alone and in pairs on 4 threads (no instrument 0.762):

- **Executioner's Blacklist**: when a patrol opens a door and 5 or fewer cells are still locked, 2 random inmates rise a tier. 1.357 alone (6th of 21). With the Lost Ring of Keys 2.64, +1.25 beyond their parts, since the Ring's extra doors bring the block down to 5 locked cells sooner. It also pairs well with the Execution Axe (+0.67).
- **Crowded Beastcage**: after an inmate is devoured, 40% chance its cell opens again at once. 0.782 (14th). Valuing that as 40% of a door (`wCage` 1) beat smaller weights; best paired with the Blacklist (+0.28).
- **Short-Chained Shackles**: a walk of 3 cells or fewer has a 50% chance to open a random locked cell. Valued as half a door, it pulled the strategy into short walks and scored 0.683, worse than nothing. At a tenth of that (`wShort` 0.1) it scores 0.751, about neutral (17th): the extra door can use up an event or a nest. Best with the Blacklist (1.69).

`combos --keep` carries on after a weight change that only matters for some sets; remove those sets from `results/tool-combos.json` first so they're measured again.

Sets of 3 and 4 (the same night, 71,157,462 runs in 90 minutes; 76,323,410 with the pairs): all 680 sets of 3 within ±0.01; all 2,380 sets of 4 within ±0.03, and 481 of them refined to ±0.01. Finishing the sets of 4 to ±0.01 needs about 83 million more runs (around 2 to 3 hours); `combos --minutes N` carries on.

- **Best sets of 3:** Iron Box, Avenger's Casket and Rat Heads 5.32; Iron Box, Rusty Saw and Rat Heads 5.03; Muzzle, Noose and Rat Heads 5.03; Muzzle, Noose and Shackles 5.02.
- **Best set of 4:** Iron Box, Muzzle, Noose and Rat Heads, 7.82 (±0.03). The Muzzle and the Iron Box clash as a pair, but they're the best two to add to Noose and Rat Heads, so sets can't be judged by adding up pairs. That's why the Trainer reads the measured set itself.

**The guide's data** (`guide --no-tune` at 100,000 runs per measurement). Rewards on: **2.472** Rainbows per run, 91.3% of runs vault one, the first around day 11. With no tools: 0.759. That's after the starting instrument became a pick of 3, as in the live game (the guide's re-run, 4,200,000 runs in 5.9 minutes). With a free random one it was 1.998.

- **Each instrument held from day 1:** Hangman's Noose 1.767, Long-Chained Shackles 1.674, Agonizing Muzzle 1.605, Skewered Rat Heads 1.482, Avenger's Casket 1.429, Rusty Saw 1.163, Barbed Collar 1.159, Sorting Hook 1.104, Fanged Guillotine 1.082, Iron Tongs of Lust 0.978, Lost Ring of Keys 0.797, Warden's Scales 0.781. Worse than none: Iron Pestle 0.739, Gaoler's Execution Axe 0.730, Searing Branding Iron 0.723, Forged Key 0.533 (the lost destination each morning costs more than its extra doors give) and Squirming Iron Box 0.353.
- **The office:** always choosing Bestow makes 0.566 and always choosing Instigate 0.659, against 0.759 for picking by the board.
- **Warden's Treasure:** judging each gift on the spot (1.998) beats always taking the same one: Crimson Vintage 1.963, Brand of Original Sin 1.810, Brass Horn of Strife 1.733, Three-Headed Thumb Ring 1.659.
- **Contract challenge** (`cguide --games 200000 --habit-games 100000`; its profile wasn't retrained): the trained strategy passes 94.9% with 52.8 points, up from 93.9% and 52.1 this morning. Sending the most points on every contract still fails most runs (28.6% pass), and playing with the drill weights costs 1.6% of passes.

### New live rules, re-measured (2026-10-15)

Live play showed more of the season, and the simulator now follows it:
- **Patrols reach six cells** ahead of the warden instead of five.
- **Every run starts with a random instrument.**
- **Objectives.** Each run has one: King of the Caged (an inmate reaches Supreme, the old first-Supreme reward) or Prison Walk (move 18 tiles). What live objectives pay isn't known yet, so each pays an instrument here. The challenge keeps King of the Caged.
- **A third event, Behind Closed Doors.** The inmate in the opened cell becomes a Supreme of the scarcest beast on the block. The three events are equally likely.
- **Three more instruments**, for 16 in all: the Gaoler's Execution Axe, Long-Chained Shackles and Maddened Beast's Barbed Collar.

`guide --no-tune` re-measured both chains at 100,000 runs per measurement: 4,100,000 runs per chain, in 4.5 minutes (single-meal) and 5.1 minutes (two-meal). "Rewards on" now means a random instrument to start, one for the objective and a gift per Rainbow; "no tools" means none at all.

**Each instrument held from day 1** (no other rewards), sorted by the single-meal chain. Baselines with no instrument: 0.495 single-meal and 0.923 two-meal, up from 0.269 and 0.664 under the old rules.

| Instrument | Single-meal | Change | Two-meal | Change |
| --- | --- | --- | --- | --- |
| Long-Chained Shackles | 1.433 | +0.938 | 1.847 | +0.924 |
| Skewered Rat Heads | 1.296 | +0.801 | 1.631 | +0.708 |
| Hangman's Noose | 1.276 | +0.780 | 1.977 | +1.054 |
| Avenger's Casket | 1.243 | +0.747 | 1.841 | +0.918 |
| Maddened Beast's Barbed Collar | 1.004 | +0.509 | 1.633 | +0.710 |
| Rusty Saw | 0.901 | +0.406 | 1.478 | +0.555 |
| Fanged Guillotine | 0.832 | +0.337 | 1.217 | +0.294 |
| Iron Tongs of Lust | 0.829 | +0.334 | 1.214 | +0.291 |
| Sorting Hook | 0.770 | +0.275 | 1.329 | +0.406 |
| Lost Ring of Keys | 0.597 | +0.101 | 1.220 | +0.297 |
| Raging Beast's Agonizing Muzzle | 0.595 | +0.100 | 1.167 | +0.244 |
| Gaoler's Execution Axe | 0.590 | +0.095 | 1.158 | +0.236 |
| Searing Branding Iron | 0.519 | +0.024 | 1.026 | +0.103 |
| Warden's Scales | 0.495 | +0.000 | 0.924 | +0.001 |
| Iron Pestle | 0.481 | **−0.015** | 0.916 | **−0.006** |
| Squirming Iron Box | 0.252 | **−0.243** | 0.661 | **−0.262** |

The Long-Chained Shackles are the strongest instrument on the single-meal chain and second on the two-meal one. With six cells in reach, nearly every morning offers a walk of 4 or more, and each such walk has a 40% chance to raise an inmate. The Barbed Collar ranks fifth on both chains. The Gaoler's Execution Axe fires only when a swap rolls a higher rarity, so it adds little. (The Scales' exact tie with no instrument is chance: in 3,000 paired runs they scouted about 30,000 times and changed 1,321 results.)

**Rewards on**: 1.815 single-meal (was 0.648) and 2.564 two-meal (was 1.261). On the single-meal chain 81% of runs vault a Rainbow, the first around day 11.

**Warden's Cache**, always the same gift: single-meal Crimson Vintage 1.757, Brand of Original Sin 1.633, Three-Headed Thumb Ring 1.625, Brass Horn of Strife 1.520; two-meal Crimson Vintage 2.477, Three-Headed Thumb Ring 2.331, Brand of Original Sin 2.154, Brass Horn of Strife 2.133. Judging each gift on the spot (1.815 and 2.564) beats all of them.

**Contract challenge** (`cguide`: 2,000,000 runs plus 300,000 per variant, 6.5 million runs in 8.3 minutes). The trained strategy passes 93.9% with 52.1 points (was 94.5% and 52.3). Putting the Long-Chained Shackles second in the challenge's instrument order, after Hangman's Noose, raised the pass rate from 93.3% to 93.8% on 300,000 runs (96.5% to 96.6% on the two-meal chain), so both challenge profiles rank it there, with the Barbed Collar fifth. Starts: Supply 94.4%, Lean 90.5%, Rat-breeding 96.7%. Runs that still fail: 4.6% never reach a Supreme or Rainbow by day 12, and 1.6% ship the heavy contract but miss both early ones.

The solver's instrument rankings (`toolRank` in PROFILES) followed these orders until the evening's re-measure above.

### Instruments, re-measured (2026-10-13)

After the instruments took their live names, the Burning Stake became the Searing Branding Iron with the card's rule, and five live instruments were added (Sorting Hook, Iron Pestle, Warden's Scales, Iron Tongs of Lust, Fanged Guillotine). `guide --no-tune` re-measured both chains at **100,000 runs per measurement**, which keeps every margin under ±0.01 Rainbows (here ±0.002 to ±0.006): 3,800,000 runs in about 4 minutes per chain.

**Each instrument held from day 1** (no other rewards), sorted by the single-meal chain. Baselines with no instrument: 0.269 single-meal, 0.664 two-meal.

| Instrument | Single-meal | Change | Two-meal | Change |
| --- | --- | --- | --- | --- |
| Skewered Rat Heads | 1.106 | +0.837 | 1.413 | +0.749 |
| Avenger's Casket | 1.082 | +0.813 | 1.659 | +0.996 |
| Hangman's Noose | 1.056 | +0.787 | 1.751 | +1.087 |
| Rusty Saw | 0.707 | +0.438 | 1.262 | +0.598 |
| Fanged Guillotine | 0.578 | +0.309 | 0.939 | +0.275 |
| Sorting Hook | 0.559 | +0.290 | 1.101 | +0.437 |
| Iron Tongs of Lust | 0.557 | +0.288 | 0.944 | +0.280 |
| Lost Ring of Keys | 0.435 | +0.166 | 1.037 | +0.373 |
| Raging Beast's Agonizing Muzzle | 0.366 | +0.097 | 0.904 | +0.240 |
| Searing Branding Iron | 0.319 | +0.050 | 0.788 | +0.124 |
| Warden's Scales | 0.271 | +0.002 | 0.663 | **−0.001** |
| Iron Pestle | 0.259 | **−0.010** | 0.654 | **−0.010** |
| Squirming Iron Box | 0.122 | **−0.148** | 0.493 | **−0.171** |

**Rewards on** (an instrument at the first Supreme, a gift per Rainbow): 0.648 single-meal (was 0.744 with the 8 old tools), 1.261 two-meal. The drop comes from the first Supreme's offer: 3 of 13 instruments instead of 3 of 8, so a top-three one is on offer 58% of the time instead of 82%, and the strong Burning Stake is gone.

**Warden's Cache**, always the same gift: single-meal Crimson Vintage 0.635, Three-Headed Thumb Ring 0.610, Brand of Original Sin 0.609, Brass Horn of Strife 0.580; two-meal Crimson Vintage 1.232, Three-Headed Thumb Ring 1.180, Brand of Original Sin 1.106, Brass Horn of Strife 1.104. Judging each gift on the spot beats all of them on both chains.

The solver's instrument rankings (`toolRank` in PROFILES) now follow these orders. The challenge profiles keep their measured order for the seven unchanged instruments, with the rest appended, until `ctune` re-measures them.

### The first full study (2026-10-12)

From the full study on 2026-10-12, run on the two-meal food chain (the default at the time): 1,000,000 runs per test, default drill values. "Hard mode loop chain" below is the single-meal chain that is now the default. The ± figures are 95% margins.

**Speed.** 1,000,000 runs take about 61 seconds with no tools (16,300 runs/s) and 77 seconds with tool and Cache rewards on (12,900 runs/s), on 31 threads of an i9-14900K.

**No tools** (Rainbows vaulted per 20-day run):

| Strategy | Rainbows/run | Runs with a Rainbow |
| --- | --- | --- |
| Random legal moves | 0.047 | 5% |
| Simple: devour when possible, swap Normals, open doors | 0.411 | 40% |
| Solver strategy, starting weights | 0.577 | 55% |
| Solver strategy, tuned | **0.662 ± 0.001** | 62% |

**Rewards on** (a tool at the first Supreme, a Warden's Cache gift per Rainbow):

| Strategy | Rainbows/run |
| --- | --- |
| Random | 0.088 |
| Simple | 0.648 |
| Tuned for no tools, measured tool ranking | 1.336 |
| Retuned with rewards on | **1.390 ± 0.002** (82% of runs vault one or more) |

**Each tool held from day 1** (no other rewards; the baseline with no tool is 0.662):

| Tool | Rainbows/run | Change |
| --- | --- | --- |
| Hangman's Noose | 1.749 | +1.087 |
| Avenger's Casket | 1.655 | +0.994 |
| Skewered Rat Heads | 1.408 | +0.746 |
| Burning Stake | 1.402 | +0.741 |
| Rusty Saw | 1.258 | +0.596 |
| Lost Ring of Keys | 1.033 | +0.372 |
| Agonizing Muzzle | 0.902 | +0.240 |
| Squirming Iron Box | 0.490 | **−0.172** |

**Warden's Cache.** Scoring the gifts on the spot (1.336) beats always taking the same one. In order: Crimson Vintage 1.302, Three-Headed Thumb Ring 1.260, Brand of Original Sin 1.181, Brass Horn of Strife 1.176.

**Hard mode loop chain:** 0.269 with no tools, 0.706 with rewards. Each beast has only one meal, so chains break far more often.

### Training run (25.9 million runs)

`train` refined all four profiles the Trainer uses: 150,000 runs per test for the two standard profiles, 50,000 for hard mode, then 1,000,000 fresh prisons each to score the old and new weights. It played **25,900,000 simulated runs in 29.8 minutes** on 31 threads.

| Profile | Before | After | Runs with a Rainbow |
| --- | --- | --- | --- |
| Rewards on (default drill) | 1.3904 | **1.3925** ± 0.0019 | 82% |
| No tools | 0.6615 | **0.6618** ± 0.0011 | 62% |
| Hard mode, rewards on | 0.7061 | **0.7112** ± 0.0017 | 50% |
| Hard mode, no tools | 0.2674 | 0.2672 ± 0.0009 (kept the old weights) | 26% |

The gains are small. The strategy was already close to the best these scoring rules can do, and the extra runs mostly confirmed it. New weights were kept only where they scored at least as well on the fresh prisons.

### What wins

- **Devour every day you can, unless it breaks a prey mark.** The strategy devours whenever the best devour scores at least zero (`minDevour` 0). Two inmates of one rarity becoming one a tier higher is always a gain at the tuned tier values, so a devour scores below zero only when it ends a prey mark (the mark's free tiers each morning are lost), when it removes a beast the spread needs, or, in the challenge, when it eats what the next contract needs. Waiting for a bigger staircase never paid off. A devour threshold of +2 dropped results from 0.66 to 0.57, and +5 dropped them to 0.38.
- **Swap the warden's low-tier inmates.** With no tools, swapping Normal and Magic is best. Never swapping halves the result (0.36), and swapping only Normals gives 0.61. With rewards on, swapping Rares too is best (1.38 vs 1.36).
- **Accept Chain reactions** (0.66 vs 0.53 when skipped).
- **Accept an Execution only when it gains more than it removes.** Always accepting gives 0.64, and never accepting 0.61.
- **Walk further.** A bonus per step walked beat preferring short steps (0.66 vs 0.64).
- **Open doors.** A new inmate is worth more than walking to a known one that has no meal.

### Chains and how many beasts you need

A chain re-rolls the eater's beast after every bite, so the next bite depends only on which beasts wait at the next tier. These are the exact odds that the chain finds its next meal:

| Beasts waiting at the next tier | Standard chain | Loop chain |
| --- | --- | --- |
| Rat or Wolf | 50% | 25% |
| Lion or Mammoth | 25% | 25% |
| Rat + Mammoth, Rat + Lion, Rat + Wolf, Wolf + Mammoth | 75% | 50% |
| Lion + Wolf, Lion + Mammoth | 50% | 50% |
| **Rat + Mammoth + Lion, or Rat + Mammoth + Wolf** | **100%** | 75% |
| Lion + Wolf + Rat, or Mammoth + Lion + Wolf | 75% | 75% |
| All four | 100% | 100% |

The chance a chain reaches Rainbow is the product over the tiers it still has to climb. For example, a Rare eater needs food at Legendary and at Supreme, so best pairs at both give 75% × 75% = 56%. The simulation agrees. A Legendary eater reached Rainbow in a chain 77% of the time with 3 beasts fed at Supreme, 55% with 2 and 31% with 1. A Rare eater with 2 fed at both Legendary and Supreme reached it 31% of the time. Extra copies of a beast don't help a single chain, since each chain eats one inmate per tier. They only keep the staircase ready for the next one.

Chains produced 68% of all Rainbows. With rewards on, 64% of devours were a single bite, 26% two bites, 8% three, 1.8% four and 0.4% five.

The full numbers were in `results/report.json`, removed with the two-meal chain (see the git history). The tuned weights are in `results/tuned-notools.json` and `results/tuned-rewards.json`, and `js/solver.js` uses them.

# Screenshot reader

`js/scan.js` reads a screenshot of the live game's prison screen for the board analyzer. There's no AI and no OCR service. It compares the screenshot with reference data taken from labeled screenshots, all inside the player's browser, in about a second.

- **The board** is part of the game's scene, so it keeps its shape at any UI scale. The reader finds it by matching about 1,000 points on its fixed frame, at any size and position, which places every cell.
- **Cells.** A padlock means a locked cell; an orange rat head on it marks a rat nest, and a "!" an event. An inmate's beast comes from its face, matched against labeled portraits, and its rarity from its frame's color. The red jaws marker shows on every inmate with something to eat. The analyzer checks the reading against the markers, and a washed-out portrait takes whichever beast makes them fit.
- **The warden** is the gold arrow.
- **Panels** are UI, which players can scale apart from the scene, so each panel is found by its own text and measured from it: the door cards ("Go to Cell N"), the "N days until Riot" counter, the Torture Instruments panel and the Chromatic Prisoners panel. Digits are matched against digit shapes from the screenshots.
- **Instruments** are matched against the panel icons and the art on the instrument reward cards.

## Rebuilding it

The labeled screenshots go in `trainingdata/`, which isn't in the repo (see `.gitignore`), and their labels in `tools/scan-truth.json`. Then:

```
node tools/scan-build.js           # makes js/scan-data.js
node tools/scan-test.js            # scores the reader against the labels
node tools/scan-test.js --quick    # the screenshots as captured only
```

## Accuracy (2026-10-13)

Five labeled board screenshots, also resized to stand in for other resolutions and UI scales, and cropped to the board:

| Screenshots | Cells | Beasts | Rarity | Warden | Doors | Days | Instruments | Events, nests, jaws |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| As captured | 100% | 100% | 100% | 100% | 100% | 100% | 80% | 100% |
| Scaled 1.45× and 2× | 100% | 100% | 100% | 100% | 100% | 100% | 80% | 100% |
| Cropped to the board | 100% | 100% | 100% | 100% | 100% | 100% | (cropped out) | 100% |
| Scaled 0.8× | 100% | 100% | 100% | 100% | 80% | 80% | 80% | 100% |
| Scaled 0.6× | 97% | 100% | 100% | 100% | 20% | 40% | 80% | 98% |

- **Instruments.** The 80% is one screenshot where a tooltip covers the panel. Only three instruments have panel icons so far (Squirming Iron Box, Raging Beast's Agonizing Muzzle and Lost Ring of Keys). The others are matched against their reward-card art, which hasn't been tested on the panel yet. The Gaoler's Execution Axe, Long-Chained Shackles and Maddened Beast's Barbed Collar take their card art from a screenshot of the instrument offer (2026-10-15); adding them left every score above unchanged.
- **Small screenshots.** At 0.6× the door and day digits are only a few pixels tall, so they're often misread there.
- **Chromatic prisoners.** No labeled screenshot has one yet, so the slot count is untested beyond reading 0.
- **Objectives** aren't read yet.

# Live data

The board analyzer shares the boards players ask about (see `worker/README.md`). Two boards in a row from the same game are a confirmed step of a live game, such as a patrol and what the door held, a swap and who came in, or a night and the next morning's doors. `live-data.js` pulls those boards into `beta/data/` and measures what the steps show, next to the simulator's values in `js/engine.js` (`DEFAULT_PARAMS`):

```
node tools/live-data.js pull     # new boards from the collector (the workflow does this every 6 hours)
node tools/live-data.js rates    # the report, also saved as beta/data/rates.json
node tools/live-data.js rates --all   # also count guesses nobody confirmed
node tools/live-data.js reports  # new reports of unknown events, instruments and gifts, into trainingdata/reports/
node tools/live-data.js reports --watch   # keep checking every minute; one NEW REPORT line each
```

It measures:
- door rarities and beasts (`tierWeights`, `beastWeights`),
- swaps,
- Ring of Keys side doors,
- scratched doors,
- the share of runs whose first board shows an event (`eventStartChance`) and the Chain/Execution split,
- doors per morning (`fewerDoorsChance`) and how far ahead they are, which settles whether the office counts as a patrol step,
- devours and tool offers.

Each rate has a 95% range. A rate is judged once it has 30 observations, and rarities and beasts also get a chi-square test against the simulator's odds.

**What counts.** After "Do it here", the simulator's dice fill in what happened, and the screenshot reader fills in what it couldn't read for sure. Those parts count only once the player changes them or confirms them with "Matches my game", so the simulator's own odds don't leak into the measurements. A board the player entered by hand counts as is.

**Checked on simulated games.** Turning 3,000 simulated runs into analyzer boards (181,566 boards) gave back the simulator's own odds:
- door and swap rarities 52/27/15/6,
- beasts at 25% each,
- 18.1% of day-1 doors with an event,
- 80.4% Ring of Keys openings,
- no doors more than 5 steps ahead.

The one gap was Chain reactions at 53% instead of 50%. In the simulator, the strategy can see an event's kind and favors Chain reactions; live players can't see it.

**Caveat on events.** A door with no event marker might just be a marker nobody entered. Boards from the screenshot reader read event markers reliably.

# The Frozen Canvas lab

`canvas-sim.js` plays Frozen Canvases with the trainer's strategy (`js/canvas-solver.js`) and measures how often the Treasure Chest ends at Lv7, the only result that pays:

```
node tools/canvas-sim.js eval --games 400000
```

**Rules.** The rules come from the research in October 2026:
- Sources: the game's texts and tooltips seen in SS7 and SS13 gameplay videos, the SS6 and SS7 patch notes and hotfixes, and the tlidb wiki.
- The canvas has been a core Netherrealm mechanic since SS7 and is still in SS14.
- Confirmed:
  - a 6×6 canvas of blank, ice and void cells,
  - monster (round) and gameplay (diamond) paints, Lv1–7,
  - objectives with a range (Horizontal, Vertical, Diagonal, Adjacent) and a target type, where paints already in range count,
  - meeting an objective raises every matching paint in range,
  - the three brushstroke directions (Reimagine, Spread, Layer): 2 are offered, then 2 effects from the chosen one,
  - Forced Color Mixing at 5 and then 10 Colored Snow, 3 a canvas. It breaks 1 random paint on the canvas.
- **Practice values**, in `DEFAULT_PARAMS` and editable on the page, cover everything the game hides:
  - how often a canvas has a chest,
  - the inventory's levels,
  - Coloring Paint levels, ranges and targets,
  - the brushstroke pools,
  - ice and void counts.

**Two goals.** On a canvas with a Treasure Chest, the goal is a Lv7 chest. Without one, it's as many rainbow (Lv7) paints as possible. Their eggs can drop skills too. The score is the chest's worth by level (Lv7 = 100), plus 4 for each other rainbow paint.

**Result with the practice values** (100,000 canvases, about 15 seconds):

| | Lv7 chest, on chest canvases | Rainbow paints, on canvases without a chest |
| --- | --- | --- |
| Before forcing broke a paint, with Global objectives | 71.3% ± 0.4 | 0.31 ± 0.005 |
| Forcing breaks a paint, with Global objectives (40,000 canvases) | 55.2% ± 1.1 | 0.29 ± 0.011 |
| **Forcing breaks a paint, no Global objectives** | **42.1% ± 0.7** (average chest level 4.80) | **0.091 ± 0.003** |
| All rules confirmed by the player (2026-10-13) | 37.8% ± 0.6 (average chest level 4.69; 21% of chests are lost to forcing) | 0.102 ± 0.003 |
| **Look-ahead strategy (below)** | **37.6% ± 0.6** (average chest level 5.38; forcing 0.4 times a canvas, about 4% of chests lost) | **0.787 ± 0.009** |

Two rule changes on 2026-10-13 moved these numbers:
- **Forcing breaks a paint.** About 1 chest in 6 is lost to a break, even with the risk check below.
- **No Global objectives.** The player knows four ranges, so Global isn't dealt. Whole-canvas objectives made most of the rainbows on chest-less canvases.

An earlier fix in the strategy still holds. Once its chest reached Lv7, it went fishing for another chest with Layer's re-roll effect, and sometimes re-rolled its own finished chest. A Lv7 chest only changes through an effect like that, so the strategy never takes re-roll while a chest is on the canvas.

Live rules the user confirmed:
- The ranges are Horizontal, Vertical, Diagonal and Adjacent.
- An objective raises each matching paint in range by +1, and only Layer effects add more.
- Spread's ice effects turn an ice cell into a blank cell that takes paints.
- A Coloring Paint placed on a void cell isn't a paint: the cell stays void, and only its objective works from there.
- Forced Color Mixing meets the objective, but 1 random placed paint breaks (it can be the chest): it's gone, and nothing can go on that cell until a Spread effect repairs it. Another Spread effect lets the Coloring Paint go on a broken cell.
- Diagonal is the full X to the canvas edges. Adjacent is the 4 cells sharing an edge. A Coloring Paint doesn't count for its own objective, and the objective doesn't raise it.
- A Coloring Paint placed on a painted cell overwrites the paint there.
- Layer's random +1 can hit any paint in range, whatever the objective's type.
- A chest is never on the grid at the start. About 1 canvas in 4 or 5 has one among the paints, usually at Lv2 (practice values 22% and mostly Lv2).
- The canvas ends when every cell is filled, and there are always enough paints to fill it.
- An objective fails only when its range has no blank cell left and it is still short. A paint that doesn't match can go in range without failing it, but it doesn't rise. After a fail no new Coloring Paints come, but the failed objective can still be forced.
- A repair fixes 1 broken cell.
- Brushstroke refreshes are 0 to 2 a canvas, by the level of the pet.
- Every Coloring Paint seen live came at Lv3 and needs 3. The player says they can come up to Lv4, so the practice value is 70% Lv3, with some Lv1, Lv2 and Lv4.
- An objective completes the moment it is met, even right as its Coloring Paint is placed. The next Coloring Paint comes with a random range and 2 of the 3 brushstroke directions.
- The void count (11–15) comes from a live screenshot.

**Starting over.** For Colored Snow (practice value 5) a canvas starts over with the same canvas and paints, and the Coloring Paints and brushstrokes to come are rolled again. Players with a chest start over when the luck goes bad, and rarely force. `resets` measures that: it plays each chest canvas again and again until the chest is Lv7, and counts the Snow.

```
node tools/canvas-sim.js resets --games 20000 [--cap 100]
```

| 20,000 chest canvases | Lv7 per attempt | Colored Snow per Lv7 chest | Never got there in 100 attempts |
| --- | --- | --- | --- |
| Old strategy, forcing | 23.5% | 85.5 (81% of it on forcing) | 0.2% |
| Old strategy, never forcing | 0.6% | 809 | 60.6% |
| **Look-ahead, forcing** (5,000 canvases) | 17.0% | **49.0 ± 3.9** (50% on forcing; median 10) | 0.7% |
| **Look-ahead, never forcing** (5,000 canvases) | 8.7% | **52.5 ± 3.2** (median 10) | 4.9% |

The old strategy disagreed with live play, where players reach Lv7 by starting over and rarely force. Three fixes closed the gap:
- The starting Coloring Paint now always lands where its objective can be met. Random placement had left 55% of practice canvases dead from the start.
- An objective that can't be met is never chosen, even to reach the chest.
- Brushstrokes are chosen by look-ahead.

Without forcing, a chest canvas now completes 6.8 objectives instead of 1.7, and 38% of Coloring Paints complete the moment they land. Forcing and never forcing now cost about the same Colored Snow per Lv7 chest; never forcing just takes about twice the attempts. The per-attempt rates are pooled over attempts, so the hard canvases that take many attempts weigh most. Played once, a chest canvas reaches Lv7 30.6% of the time without forcing.

**The strategy:**
- **Placing the chest:** it goes first, on the cell whose row, column, diagonals and neighbors have the most open cells.
- **Objectives that reach the chest:** fill their ranges with matching paint.
- **Objectives that don't:** finish them quickly, off the chest's lines.
- **Brushstrokes, by look-ahead:** each effect is worth the best cell score the Coloring Paint would get after it. Random effects (a new range, a new Coloring Paint) are averaged over what they could give. A direction is worth the better of the 2 effects it would deal, on average. If nothing on offer can be met, refresh.
- **Where the Coloring Paint goes:** never where its objective can't be met. Best is a cell where it completes the moment it lands, and where it reaches the chest (more with Layer +1). Void, ice and broken cells score a cell's worth, because they save a blank one.
- **Never** take the re-roll effect while a chest is on the canvas.
- **Without a chest:** aim each objective at the highest paints (Layer's +1 is best), and force a stuck one when it pushes paints toward Lv7 by more than the break costs on average. Never force with a Lv7 chest on the canvas.
- **Forcing:** when an objective is stuck, force it if it feeds the chest, or to get a new Coloring Paint while the chest has room. Only with at least 6 paints on the canvas, so the break hits the chest 1 time in 6 or less. Thresholds from 4 to 8 score within 2 points of each other. Splitting the rule (forcing for the chest sooner, for a new Coloring Paint later) or capping forces scored 2 to 8 points worse.

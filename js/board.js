/* Tartarus Simulator: the board's art.
 * The ring layout, the beast portraits drawn for this simulator, the warden's
 * lantern and office, and how each cell looks. Shared by the game (ui.js) and
 * the board analyzer (analyze.js). */
(function (root) {
  'use strict';

  const T = root.Tartarus;
  const L = (n) => T.cellLabel(n);

  // Where each cell sits on the 6×4 board as [row, column]: clockwise from the
  // top-left corner, around a courtyard that holds the decision panel.
  const RING = [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [2, 6], [3, 6], [4, 6], [4, 5], [4, 4], [4, 3], [4, 2], [4, 1], [3, 1], [2, 1]];

  // Beast portraits drawn for this simulator.
  const svg = (inner) => `<svg class="portrait" viewBox="0 0 64 64" aria-hidden="true">${inner}</svg>`;
  const PORTRAITS = {
    mammoth: svg(
      '<path class="p-shade" d="M19 18C8 15 3 26 6 36c2 7 9 9 14 4l3-4Z"/>' +
      '<path class="p-shade" d="M45 18c11-3 16 8 13 18-2 7-9 9-14 4l-3-4Z"/>' +
      '<path class="p-main" d="M17 25C17 15 24 9 32 9s15 6 15 16c0 5-4 8-9 10-1 6-2 11-1 15 1 3 4 3 5 1 2 3-1 8-6 7-4-1-6-6-6-12 0-5-1-8-3-10-5-2-9-5-9-11Z"/>' +
      '<path class="p-bone" d="M27 36c-5 5-9 8-13 5M37 36c5 5 9 8 13 5"/>' +
      '<circle class="p-ink" cx="25" cy="24" r="1.8"/><circle class="p-ink" cx="39" cy="24" r="1.8"/>' +
      '<path class="p-line" d="M28 10l-2-4M32 9V4M36 10l2-4"/>',
    ),
    lion: svg(
      '<path class="p-shade" d="M32 4L36.6 12L44.1 6.8L44.8 16L53.9 14.5L50.5 23.1L59.3 25.8L52.5 32L59.3 38.2L50.5 40.9L53.9 49.5L44.8 48L44.1 57.2L36.6 52L32 60L27.4 52L19.9 57.2L19.2 48L10.1 49.5L13.5 40.9L4.7 38.2L11.5 32L4.7 25.8L13.5 23.1L10.1 14.5L19.2 16L19.9 6.8L27.4 12Z"/>' +
      '<circle class="p-main" cx="21" cy="20" r="4.5"/><circle class="p-main" cx="43" cy="20" r="4.5"/>' +
      '<circle class="p-ink2" cx="21" cy="20" r="2"/><circle class="p-ink2" cx="43" cy="20" r="2"/>' +
      '<ellipse class="p-main" cx="32" cy="33" rx="13" ry="14.5"/>' +
      '<ellipse class="p-light" cx="32" cy="40.5" rx="7.5" ry="5.5"/>' +
      '<ellipse class="p-ink" cx="26.5" cy="30" rx="2.2" ry="1.5"/><ellipse class="p-ink" cx="37.5" cy="30" rx="2.2" ry="1.5"/>' +
      '<path class="p-ink" d="M29 35.5h6L32 39Z"/>' +
      '<path class="p-inkline" d="M32 39v2.5M32 41.5c-1.5 2-3.5 2.3-5 1.2M32 41.5c1.5 2 3.5 2.3 5 1.2"/>',
    ),
    wolf: svg(
      '<polygon class="p-main" points="16,5 26,19 32,17 38,19 48,5 51,25 53,34 41,46 32,58 23,46 11,34 13,25"/>' +
      '<polygon class="p-ink2" points="18,11 24,20 18,23"/><polygon class="p-ink2" points="46,11 40,20 46,23"/>' +
      '<polygon class="p-shade" points="30,18 34,18 32,30"/>' +
      '<polygon class="p-light" points="27,38 37,38 32,56"/>' +
      '<polygon class="p-ink" points="20,30 28,32 22,34.5"/><polygon class="p-ink" points="44,30 36,32 42,34.5"/>' +
      '<polygon class="p-ink" points="28.5,50 35.5,50 32,55"/>',
    ),
    rat: svg(
      '<circle class="p-shade" cx="17" cy="19" r="10"/><circle class="p-shade" cx="47" cy="19" r="10"/>' +
      '<circle class="p-ink2" cx="17" cy="19" r="5.5"/><circle class="p-ink2" cx="47" cy="19" r="5.5"/>' +
      '<path class="p-main" d="M32 15c13 0 18 12 13 23-4 8-9 15-13 18-4-3-9-10-13-18-5-11 0-23 13-23Z"/>' +
      '<circle class="p-ink" cx="26" cy="30" r="2.3"/><circle class="p-ink" cx="38" cy="30" r="2.3"/>' +
      '<circle class="p-ink" cx="32" cy="53.5" r="2.6"/>' +
      '<rect class="p-bonefill" x="30.6" y="56" width="2.8" height="4" rx="0.6"/>' +
      '<path class="p-line" d="M27 48L12 44M27 51L12 53M37 48l15-4M37 51l15 2"/>',
    ),
  };
  const LANTERN = '<svg class="warden" viewBox="0 0 16 18" aria-hidden="true"><path d="M6 1h4v2H6z"/><path d="M4 4h8l-1 10H5z"/><path d="M5 15h6v2H5z"/><path class="flame" d="M8 6.5c1.4 1.6 1.6 3 0 4.6-1.6-1.6-1.4-3 0-4.6Z"/></svg>';
  // Two rows of teeth: "ate" in the devour icons.
  const FANGS = '<svg class="fangs" viewBox="0 0 16 14" aria-hidden="true"><path d="M1 1h14l-1.75 4.5-1.75-3-1.75 3-1.75-3-1.75 3-1.75-3-1.75 3-1.75-3Z"/><path d="M1 13h14l-1.75-4.5-1.75 3-1.75-3-1.75 3-1.75-3-1.75 3-1.75-3-1.75 3Z"/></svg>';
  // Cell 01, the warden's office: a desk with the ledger open by a candle.
  const OFFICE_ART =
    '<span class="office"><svg class="office-art" viewBox="0 0 64 52" aria-hidden="true">' +
    '<circle class="o-glow" cx="48" cy="13" r="12"/>' +
    '<path class="o-paper" d="M10 27l12-3.5 12 3.5V15l-12-3.5L10 15Z"/>' +
    '<path class="o-line" d="M22 11.5v12M13.5 17.6l5.5-1.7M13.5 21.1l5.5-1.7M25 15.9l5.5 1.7M25 19.4l5.5 1.7"/>' +
    '<rect class="o-wax" x="45.5" y="17" width="5" height="10" rx="1"/>' +
    '<path class="o-flame" d="M48 8.5c2.3 2.6 2.5 4.9 0 7.3-2.5-2.4-2.3-4.7 0-7.3Z"/>' +
    '<rect class="o-wood" x="4" y="27" width="56" height="5" rx="1"/>' +
    '<path class="o-wood" d="M8 32h5v16H8zM51 32h5v16h-5z"/>' +
    '<rect class="o-wood-lo" x="29" y="32" width="18" height="8" rx="1"/>' +
    '<rect class="o-knob" x="36" y="35.2" width="4" height="1.6" rx="0.8"/>' +
    '</svg><span class="office-name">Office</span></span>';

  // The Torture Instruments, drawn after their art in the live game (the
  // reward cards and the instrument panel). Keyed by the simulator's tool id.
  const icon = (cls, inner) => `<svg class="instrument ${cls}" viewBox="0 0 48 48" aria-hidden="true">${inner}</svg>`;
  // One key hanging from the ring at x, tilted a little.
  const key = (x, a) =>
    `<path d="M24 16L${x} 21" stroke="#6f7488" stroke-width="1.2"/><g transform="rotate(${a} ${x} 21)"><circle cx="${x}" cy="23.5" r="2.4" fill="none" stroke="#a3a8bd" stroke-width="1.6"/>` +
    `<rect x="${x - 0.8}" y="25.8" width="1.6" height="15" fill="#a3a8bd"/><path d="M${x + 0.8} 36h2.6v1.5h-2.6zM${x + 0.8} 38.8h1.9v1.5h-1.9z" fill="#a3a8bd"/></g>`;
  // `n` triangular spikes around a ring, pointing out from radius r1 to r2.
  const spikes = (cx, cy, r1, r2, n, turn, fill) => {
    let d = '';
    for (let i = 0; i < n; i++) {
      const a = ((i + turn) / n) * 2 * Math.PI;
      const w = Math.PI / n / 1.6;
      const pt = (r, t) => `${(cx + r * Math.cos(t)).toFixed(1)} ${(cy + r * Math.sin(t)).toFixed(1)}`;
      d += `M${pt(r1, a - w)}L${pt(r2, a)}L${pt(r1, a + w)}Z`;
    }
    return `<path d="${d}" fill="${fill}"/>`;
  };
  const ratHead = (x, y, a) =>
    `<g transform="translate(${x} ${y}) rotate(${a})"><circle cx="-3.6" cy="-4.4" r="2.4" fill="#5d5b62"/><circle cx="3.6" cy="-4.4" r="2.4" fill="#5d5b62"/>` +
    '<path d="M-6 -1.5c0-3.6 2.7-5 6-5s6 1.4 6 5c0 3-3.2 6.5-6 8.5-2.8-2-6-5.5-6-8.5Z" fill="#9b99a0"/>' +
    '<circle cx="-2.2" cy="-1" r="0.9" fill="#1d1b20"/><circle cx="2.2" cy="-1" r="0.9" fill="#1d1b20"/><circle cx="0" cy="6.2" r="1.1" fill="#c47c84"/></g>';
  const INSTRUMENTS = {
    // Avenger's Casket: an iron maiden, its spiked door swung open.
    revenge: icon('glow-red',
      '<path d="M14 12c0-5 4.5-8 9.5-8S33 7 33 12v32H14Z" fill="#2c2c33" stroke="#5a5b66" stroke-width="1.2"/>' +
      '<path d="M17 14h13v27H17Z" fill="#5a1418"/><path d="M23.5 14v27" stroke="#2c2c33" stroke-width="1.4"/>' +
      '<path d="M17 18h-2.6M17 24h-2.6M17 30h-2.6M17 36h-2.6M30 18h2.6M30 24h2.6M30 30h2.6M30 36h2.6" stroke="#b9bcc6" stroke-width="1.2"/>' +
      '<path d="M18 4.5l2-2.5 1.5 2.5 2-3 2 3 1.5-2.5 2 2.5" fill="none" stroke="#b9bcc6" stroke-width="1"/>' +
      '<path d="M34.5 13l7 2.5v26l-7 2.5Z" fill="#3a3b44" stroke="#6b6c78" stroke-width="1"/>' +
      '<path d="M36.5 19h-2.4M36.5 25h-2.4M36.5 31h-2.4M36.5 37h-2.4" stroke="#b9bcc6" stroke-width="1.2"/>'),
    // Raging Beast's Agonizing Muzzle: a spiked iron cage over a red jaw.
    muzzle: icon('glow-red',
      '<path d="M8 30a16 16 0 0 1 32 0Z" fill="#6e1a1c"/>' +
      '<path d="M8 30a16 16 0 0 1 32 0M14 30a10 15 0 0 1 20 0M19.5 30a4.5 15.5 0 0 1 9 0M8.6 24h30.8M11 18.5h26" fill="none" stroke="#5d5f69" stroke-width="2.2"/>' +
      '<path d="M7 31l-4-2.5M8.5 21L4 18.5M14 12.5l-3-4M24 9V4M34 12.5l3-4M39.5 21l4.5-2.5M41 31l4-2.5" stroke="#aeb1bb" stroke-width="2" stroke-linecap="round"/>' +
      '<path d="M10 30h28l-3 8-2.5-5-2.5 6-2.5-6L25 39l-2.5-6-2.5 6-2.5-6-2.5 5Z" fill="#b8202a"/>' +
      '<path d="M12 33l1.5 3M35 33l-1.5 3" stroke="#e8d9c0" stroke-width="1.2"/>'),
    // Rusty Saw: a long bloodied blade with a red grip.
    saw: icon('glow-red',
      '<path d="M7 9l6-5 23 27-6 5Z" fill="#c3c6cd"/>' +
      '<path d="M7 9l2.5 3.2 1-1.6 1.8 3.4 1-1.7 1.8 3.4 1-1.7 1.8 3.4 1-1.7 1.8 3.4 1-1.7 1.8 3.4 1-1.7 1.8 3.4 1-1.7 1.8 3.4 1-1.7L30 36" fill="none" stroke="#7d8089" stroke-width="1.1"/>' +
      '<path d="M10 7l3-2 3 4-2 3ZM15 14.5l2-1.5 1.5 2.5-1.6 1.3ZM20 18l1.5-1 1 2-1.3.8Z" fill="#9b1d22"/>' +
      '<path d="M30 36l6-5 7 8.5-6 5Z" fill="#8c2a22" stroke="#5e1813" stroke-width="1"/><path d="M34 37.5l3.5 4.2" stroke="#c9905f" stroke-width="1.2"/>'),
    // Lost Ring of Keys: old iron keys hanging from a ring.
    keys: icon('glow-blue',
      '<circle cx="24" cy="10" r="6.5" fill="none" stroke="#8d92a8" stroke-width="2.2"/>' +
      key(14, 12) + key(19, 6) + key(24, 0) + key(29, -6) + key(34, -12)),
    // Hangman's Noose: a coiled hangman's knot above the loop.
    rope: icon('glow-teal',
      '<path d="M24 2v11" stroke="#7d4b33" stroke-width="3.4" stroke-linecap="round"/>' +
      '<path d="M19.5 14h9M19.5 17h9M19.5 20h9M19.5 23h9M19.5 26h9" stroke="#a46b4b" stroke-width="2.8" stroke-linecap="round"/>' +
      '<path d="M19.5 15.5h9M19.5 18.5h9M19.5 21.5h9M19.5 24.5h9" stroke="#5e3624" stroke-width="0.7"/>' +
      '<ellipse cx="24" cy="36.5" rx="8.5" ry="9.5" fill="none" stroke="#93593d" stroke-width="3.4"/>' +
      '<ellipse cx="24" cy="36.5" rx="8.5" ry="9.5" fill="none" stroke="#c99068" stroke-width="1" stroke-dasharray="1.6 2.4"/>'),
    // Searing Branding Iron: a long iron rod with a red-hot skull brand.
    fire: icon('glow-orange',
      '<path d="M41 4l3 3-22 22-3-3Z" fill="#6d4a33"/><path d="M38.5 6.5l3 3M35 10l3 3" stroke="#3a2618" stroke-width="1.4"/>' +
      '<path d="M17 21c-2-6 3-12 6-15-1 4 1 6 3 7 0-3 1-5 3-7 0 5 3 7 2 12Z" fill="#e8622a" opacity="0.85"/>' +
      '<circle cx="15" cy="32" r="11" fill="#e8622a"/>' +
      '<path d="M7 31c0-6 3.5-10 8-10s8 4 8 10c0 3-1.5 5-3.5 6v4h-9v-4c-2-1-3.5-3-3.5-6Z" fill="#ffb347"/>' +
      '<ellipse cx="11.8" cy="31" rx="2.4" ry="2.8" fill="#7a1a10"/><ellipse cx="18.2" cy="31" rx="2.4" ry="2.8" fill="#7a1a10"/>' +
      '<path d="M15 34l-1.4 2.6h2.8Z" fill="#7a1a10"/><path d="M12 39.5v2M15 39.5v2M18 39.5v2" stroke="#7a1a10" stroke-width="1.2"/>'),
    // Squirming Iron Box: an iron chest, lid ajar, with rats pouring out.
    ironbox: icon('glow-orange',
      '<path d="M10 22l26-7 3 6-26 7Z" fill="#45474f" stroke="#6b6d78" stroke-width="1"/>' +
      '<path d="M12 25h26v16H12Z" fill="#33353c" stroke="#5f616c" stroke-width="1.2"/><path d="M12 31h26M12 36h26M20 25v16M30 25v16" stroke="#4f515b" stroke-width="1.2"/>' +
      '<path d="M15 25c2-2 4-1 6-2s4-2 6-1 5 0 8-1" stroke="#7a5a3a" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
      '<ellipse cx="9" cy="40" rx="5" ry="3" fill="#7a5638"/><ellipse cx="14" cy="44" rx="5.5" ry="2.8" fill="#8b6442"/><ellipse cx="6" cy="45" rx="4" ry="2.4" fill="#6a4a30"/>' +
      '<path d="M4 41c-2 0-3 1-3 3M19 45c2 0 3 .5 4 2" stroke="#b08a66" stroke-width="0.9" fill="none"/>' +
      '<circle cx="11.5" cy="39" r="0.7" fill="#1d1b20"/><circle cx="16.8" cy="43.4" r="0.7" fill="#1d1b20"/>'),
    // Skewered Rat Heads: three rat heads run through on an iron spit.
    skewer: icon('glow-orange',
      '<path d="M7 45L43 3" stroke="#77777f" stroke-width="2" stroke-linecap="round"/><path d="M43 3l-1 4.5 3-3Z" fill="#c9cbd2"/>' +
      ratHead(15, 35.5, 40) + ratHead(24, 25, 40) + ratHead(33, 14.5, 40)),
    // Sorting Hook: a bloodied sickle hook on a wrapped grip and a chain.
    hook: icon('glow-blue',
      '<path d="M26 26c-6-1-9-6-8-12s7-10 13-9c5 1 9 5 9 10" fill="none" stroke="#b9bcc6" stroke-width="3.6" stroke-linecap="round"/>' +
      '<path d="M40 15c0 3-1 5-3 6l2-6Z" fill="#b9bcc6"/><path d="M33 6.5c3 1 5.5 3 6.5 6" stroke="#9b1d22" stroke-width="2.2" fill="none" stroke-linecap="round"/>' +
      '<path d="M26 26l-3 10" stroke="#5a2e22" stroke-width="4.6" stroke-linecap="round"/><path d="M24.4 29l3 1M23.6 32l3 1" stroke="#a87a55" stroke-width="1"/>' +
      '<circle cx="22" cy="40.5" r="3.2" fill="none" stroke="#8d92a8" stroke-width="1.8"/>' +
      '<path d="M26 39c3 0 4 2 6 2s3-2 5-2" fill="none" stroke="#8d92a8" stroke-width="1.6" stroke-dasharray="2 1.2"/>'),
    // Iron Pestle: a nail-studded club with a ring and chain at the grip.
    pestle: icon('glow-teal',
      '<path d="M38 4c4 2 5 5 3 8L18 37l-5-4L34 6c1-1.5 2.5-2.4 4-2Z" fill="#5e3a2c" stroke="#3a231a" stroke-width="1"/>' +
      '<path d="M36 9l4-2M31 14l4-2M26 19l3.5-2M21 24l3-2M33 6.6l-1.6-3.4M28 11.6l-1.8-3.2M23 16.8l-1.8-3" stroke="#c9cbd2" stroke-width="1.3" stroke-linecap="round"/>' +
      '<path d="M31 8l-3 3M38 11l-4 3" stroke="#9b1d22" stroke-width="1.6"/>' +
      '<path d="M18 37l-3 3" stroke="#3a231a" stroke-width="5" stroke-linecap="round"/>' +
      '<circle cx="12" cy="42" r="3.4" fill="none" stroke="#8d92a8" stroke-width="1.8"/>' +
      '<path d="M15 44c2 1 3 3 5 3s3-1 5-1" fill="none" stroke="#8d92a8" stroke-width="1.6" stroke-dasharray="2 1.2"/>'),
    // Warden's Scales: a balance with a pan of meat on each side.
    scales: icon('glow-teal',
      '<path d="M24 6v32" stroke="#4a4c56" stroke-width="2.6"/><circle cx="24" cy="5.5" r="2" fill="#7a7d8a"/>' +
      '<path d="M8 13.5l32-2.5" stroke="#5d606c" stroke-width="2.2" stroke-linecap="round"/>' +
      '<path d="M9 14l-5 13M9 14l5 13M39 11.5l-5 12M39 11.5l5 12" stroke="#7a7d8a" stroke-width="0.9"/>' +
      '<path d="M2.5 27h13c0 4-3 6-6.5 6s-6.5-2-6.5-6Z" fill="#3c3e46"/><path d="M33 23.5h12c0 4-3 6-6 6s-6-2-6-6Z" fill="#3c3e46"/>' +
      '<path d="M5 27c0-3 2-4 4-4s4 1 4.5 4Z" fill="#8c2622"/><path d="M35 23.5c0-2.6 2-3.6 4-3.6s3.6 1 4 3.6Z" fill="#7a5a3a"/>' +
      '<path d="M16 44h16l-3-6H19Z" fill="#3c3e46"/>'),
    // Iron Tongs of Lust: iron pincers gripping a bloody tusk.
    tongs: icon('glow-orange',
      '<path d="M30 3l-4 16M38 5l-8 15" stroke="#7d8089" stroke-width="2.4" stroke-linecap="round"/>' +
      '<path d="M26 19l4 1-6 9-4-2Z" fill="#5d606c"/>' +
      '<path d="M8 22c6-4 12-4 16 0 4 5 6 12 3 19-1 2-3 3-5 2 1-6 0-11-3-14-4-3-8-4-11-3-2-1-2-3 0-4Z" fill="#e6d8bf" stroke="#9a8a6c" stroke-width="1"/>' +
      '<path d="M14 24c3 2 5 6 5 10M19 26c2 3 3 6 3 10" stroke="#a51e24" stroke-width="2" fill="none" stroke-linecap="round"/>' +
      '<path d="M9 22c2 0 3 2 2 3" stroke="#a51e24" stroke-width="1.8" fill="none"/>'),
    // Fanged Guillotine: a toothed, bloodied blade on an anvil.
    guillotine: icon('glow-red',
      '<path d="M8 32h30c0 2-2 4-6 4H24l2 5h8v4H12v-4h8l2-5h-6c-5 0-8-2-8-4Z" fill="#33353c" stroke="#5f616c" stroke-width="1"/>' +
      '<path d="M6 30c6-12 18-18 32-20l4 4c-10 2-18 7-24 16Z" fill="#b9bcc6" stroke="#7d8089" stroke-width="1"/>' +
      '<path d="M10 30l2-3 1 3 2-3.5 1 3.5 2-4 1 4" fill="none" stroke="#e6e7ea" stroke-width="1"/>' +
      '<path d="M18 26c3-3 6-5 9-6M24 20l-2 4M30 17l-2 3" stroke="#9b1d22" stroke-width="2" fill="none" stroke-linecap="round"/>' +
      '<path d="M42 14l3-9" stroke="#5a2e22" stroke-width="3" stroke-linecap="round"/>'),
    // Gaoler's Execution Axe: a long-handled axe, its broad blade bloodied.
    axe: icon('glow-red',
      '<path d="M11 45L32 9" stroke="#5e3a2c" stroke-width="3.6" stroke-linecap="round"/>' +
      '<path d="M14.5 39l3 1.8M16.5 35.6l3 1.8M18.5 32.2l3 1.8" stroke="#a87a55" stroke-width="1"/>' +
      '<path d="M29 13l6.5-10Q48.5 9 44 26L32 17.5Z" fill="#b9bcc6" stroke="#7d8089" stroke-width="1"/>' +
      '<path d="M29.5 11.5l-5.5-2.5 2.5 6Z" fill="#7d8089"/>' +
      '<path d="M37.5 5Q46 10.5 43 22.5" stroke="#9b1d22" stroke-width="2.6" fill="none" stroke-linecap="round"/>' +
      '<path d="M41.5 19.5l-1.4 4.5M38 9.5l-2.2 2.6M36 15l-2 1.5" stroke="#9b1d22" stroke-width="1.5" stroke-linecap="round"/>' +
      '<circle cx="11" cy="45" r="2" fill="#3a231a"/>'),
    // Long-Chained Shackles: two spiked iron cuffs on a long chain.
    shackles: icon('glow-green',
      '<path d="M20 29C31 37 45 32 41 23S27 27 30 19" fill="none" stroke="#8d92a8" stroke-width="2.2" stroke-dasharray="2.8 1.4"/>' +
      spikes(14, 33, 8.5, 12, 9, 0.25, '#b9bcc6') +
      '<circle cx="14" cy="33" r="7.5" fill="none" stroke="#4d505b" stroke-width="4.2"/><circle cx="14" cy="33" r="7.5" fill="none" stroke="#9a9eaa" stroke-width="1"/>' +
      spikes(35, 13, 7.5, 10.5, 8, 0.5, '#b9bcc6') +
      '<circle cx="35" cy="13" r="6.5" fill="none" stroke="#4d505b" stroke-width="3.8"/><circle cx="35" cy="13" r="6.5" fill="none" stroke="#9a9eaa" stroke-width="1"/>'),
    // Forged Key: two old keys on a small ring, in a cold blue glow.
    forged: icon('glow-blue',
      '<circle cx="24" cy="11" r="6" fill="none" stroke="#8d92a8" stroke-width="2.2"/><circle cx="29" cy="15" r="4.4" fill="none" stroke="#6f7488" stroke-width="1.8"/>' +
      key(20, 10) + key(29, -14)),
    // Felon's Dog Tag: a pair of stamped tags on a ball chain, one bloodied.
    dogtag: icon('glow-green',
      '<path d="M9 9c5-6 18-7 25-1" fill="none" stroke="#8d92a8" stroke-width="2" stroke-dasharray="1.6 1.3" stroke-linecap="round"/>' +
      '<rect x="20" y="13" width="16" height="26" rx="5" fill="#5d606c" stroke="#3c3e46" stroke-width="1" transform="rotate(14 28 26)"/>' +
      '<rect x="12" y="12" width="17" height="27" rx="5" fill="#b9bcc6" stroke="#7d8089" stroke-width="1.2"/>' +
      '<path d="M20.5 16.5L11 9" stroke="#8d92a8" stroke-width="1.6" stroke-dasharray="1.4 1.1"/><circle cx="20.5" cy="16.5" r="1.8" fill="#2c2c33"/>' +
      '<path d="M15.5 22.5h10M15.5 26.5h10M15.5 30.5h7" stroke="#7d8089" stroke-width="1.4" stroke-linecap="round"/>' +
      '<path d="M13 34c3 .5 5.5-.5 8 2.5" stroke="#9b1d22" stroke-width="2" fill="none" stroke-linecap="round"/>'),
    // Crowded Beastcage: a domed iron cage, a beast's red eyes inside.
    cage: icon('glow-red',
      '<circle cx="24" cy="3.6" r="2.2" fill="none" stroke="#8d92a8" stroke-width="1.6"/><path d="M24 5.8V8" stroke="#8d92a8" stroke-width="2"/>' +
      '<path d="M10 21c0-8 6-13 14-13s14 5 14 13v20H10Z" fill="#2a1416" stroke="#5d606c" stroke-width="2"/>' +
      '<ellipse cx="20.5" cy="26.5" rx="1.7" ry="1.2" fill="#ff3b30"/><ellipse cx="27.5" cy="26.5" rx="1.7" ry="1.2" fill="#ff3b30"/>' +
      '<path d="M15 12.5V41M19.5 9.5V41M24 8.2V41M28.5 9.5V41M33 12.5V41" stroke="#6b6d78" stroke-width="1.5"/>' +
      '<path d="M10 21h28M10 32h28" stroke="#7d8089" stroke-width="2"/>' +
      '<rect x="7" y="40.5" width="34" height="4.5" rx="1" fill="#3a3b44" stroke="#6b6d78" stroke-width="1"/>'),
    // Executioner's Blacklist: a black ledger with a winged clasp and red
    // ribbons.
    blacklist: icon('glow-blue',
      '<path d="M12 9l22-3 4 32-22 4Z" fill="#e6d8bf" stroke="#9a8a6c" stroke-width="1"/>' +
      '<path d="M9 10l23-4 4 32-23 4Z" fill="#1d1b20" stroke="#4d505b" stroke-width="1.4"/>' +
      '<path d="M11.5 12l2.6 28" stroke="#7a1a10" stroke-width="2.2"/>' +
      '<path d="M16 21c2.5-3 5-3 7-1 2-3 5-3 7-1-2 0-3.5 1-4 3-1-1.5-2.5-1.8-3-1-.5-1-2-1.3-3 0-.6-2-2-3-4-1Z" fill="#9b1d22"/>' +
      '<path d="M22.5 22.5l.6 4" stroke="#c0282d" stroke-width="1.4"/>' +
      '<path d="M27 40l1 6 2-2.5 2 2-1-6M33 39l2.5 5 1.5-2.8 2.3 1.4-2.3-4.6" fill="#b8202a"/>'),
    // Short-Chained Shackles: an iron ball on a short chain, its cuff open.
    shortchain: icon('glow-green',
      '<circle cx="28" cy="18" r="12" fill="#4d4648" stroke="#2c2c33" stroke-width="1.2"/>' +
      '<path d="M21 12c2-3 5-4 8-4" stroke="#8a7f80" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="33" cy="22" r="1.6" fill="#6e2a24"/><circle cx="24" cy="25" r="1.1" fill="#6e2a24"/>' +
      '<path d="M37 26c1 4 0 7-3 9M31 35c-3 1-6 1-8 0" fill="none" stroke="#8d92a8" stroke-width="2.4" stroke-dasharray="3 1.5"/>' +
      spikes(14, 36, 6.8, 9.6, 8, 0.25, '#b9bcc6') +
      '<path d="M8.2 33.5a6.5 6.5 0 1 0 11.6 0" fill="none" stroke="#4d505b" stroke-width="3.8"/><path d="M8.2 33.5a6.5 6.5 0 1 0 11.6 0" fill="none" stroke="#9a9eaa" stroke-width="1"/>'),
    // Severed Iron Maiden: a closed iron maiden with a red band, tilted and
    // cut off below, as on the instrument panel in a player's report.
    maiden: icon('glow-red',
      '<g transform="rotate(-24 24 24)">' +
      '<path d="M16.5 9c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5l1.5 25-3 2.5-3-2-3 2.5-3-2.5-3 2-3-2.5Z" fill="#6b6870" stroke="#3c3a40" stroke-width="1.2"/>' +
      '<ellipse cx="24" cy="9.5" rx="3.6" ry="4.2" fill="#9a98a0"/>' +
      '<path d="M22.2 8.6h1.2M24.6 8.6h1.2M23.2 11.6h1.6" stroke="#2c2c33" stroke-width="1" stroke-linecap="round"/>' +
      '<path d="M24 14.5V33" stroke="#3c3a40" stroke-width="1.2"/>' +
      '<rect x="15.8" y="20" width="16.4" height="5" fill="#9b1d22"/>' +
      '<path d="M18.6 17.5h-2M18.8 29.5h-2.2M29.4 17.5h2M29.2 29.5h2.2" stroke="#b9bcc6" stroke-width="1.2"/>' +
      '<path d="M21 37.5v3M27 37.5v4.5" stroke="#9b1d22" stroke-width="1.6" stroke-linecap="round"/>' +
      '</g>'),
    // Barbed Whip: a red lash coiled into a ring, barbed, on a dark handle.
    whip: icon('glow-red',
      spikes(22, 20, 11, 14, 16, 0, '#c0282d') +
      '<circle cx="22" cy="20" r="11" fill="none" stroke="#5a1418" stroke-width="3.6"/>' +
      '<circle cx="22" cy="20" r="11" fill="none" stroke="#9b1d22" stroke-width="1.6" stroke-dasharray="3 1.6"/>' +
      '<circle cx="23.5" cy="19" r="7.2" fill="none" stroke="#8c1d22" stroke-width="2"/>' +
      '<path d="M30 28.5l7.5 12" stroke="#3a2a22" stroke-width="4.2" stroke-linecap="round"/>' +
      '<path d="M31.5 31l5 8" stroke="#6e5244" stroke-width="1" stroke-linecap="round"/>' +
      '<circle cx="38.2" cy="41.6" r="2.4" fill="#2c2c33" stroke="#8d92a8" stroke-width="1"/>'),
    // Ferocious Beast's Ravenous Chains: a grey chain coiled into a ring,
    // barbed in red, ending in a hook.
    ravenous: icon('glow-red',
      spikes(23, 20, 10.5, 13.5, 18, 0.5, '#c0282d') +
      '<circle cx="23" cy="20" r="10.5" fill="none" stroke="#4d505b" stroke-width="3.6" stroke-dasharray="3.2 1.4"/>' +
      '<circle cx="23" cy="20" r="10.5" fill="none" stroke="#a3a8bd" stroke-width="1" stroke-dasharray="3.2 1.4"/>' +
      '<circle cx="24.5" cy="19" r="6.5" fill="none" stroke="#6b6d78" stroke-width="2.4" stroke-dasharray="2.6 1.2"/>' +
      '<path d="M31 28c3 4 4 8 1.5 11.5" fill="none" stroke="#8d92a8" stroke-width="2.4" stroke-dasharray="2.6 1.2"/>' +
      '<path d="M33 40c-2 3.4-6.4 3.4-8 0" fill="none" stroke="#b9bcc6" stroke-width="2.2" stroke-linecap="round"/>'),
    // Scapegoat's Guillotine: a wooden frame over a bloodied steel blade.
    scapegoat: icon('glow-teal',
      '<rect x="13" y="5" width="22" height="5" rx="1" fill="#6e4a32" stroke="#3a2a22" stroke-width="1"/>' +
      '<rect x="15" y="9" width="4" height="12" fill="#5e3a2c"/><rect x="29" y="9" width="4" height="12" fill="#5e3a2c"/>' +
      '<path d="M15 12h18" stroke="#8d92a8" stroke-width="1.6"/><circle cx="24" cy="7.5" r="1.4" fill="#2c2c33"/>' +
      '<path d="M11 19h26l-2.5 22h-21Z" fill="#9a9eaa" stroke="#5d606c" stroke-width="1.2"/>' +
      '<path d="M11.5 23.5h25" stroke="#c9ccd4" stroke-width="1"/>' +
      '<path d="M17 27c3 1 5 4 3.5 8M27 26c2 2.5 1.5 6 4 9M23 31c.5 2 0 4-1 5.5" stroke="#9b1d22" stroke-width="2" fill="none" stroke-linecap="round"/>'),
    // Burning Stake: a chained wooden stake over a fire.
    stake: icon('glow-orange',
      '<rect x="20" y="4" width="8" height="32" rx="2" fill="#5e3a2c" stroke="#3a2a22" stroke-width="1"/>' +
      '<path d="M21 9h6M21 15h6M21 21h6" stroke="#3a2a22" stroke-width="1"/>' +
      '<path d="M19 11l10 4M19 17l10 4M19 23l10 4" stroke="#8d92a8" stroke-width="1.6" stroke-dasharray="2 1"/>' +
      '<path d="M10 44c-2-6 2-9 4-13 1 3 3 4 4 2 0-4 3-6 5-9 1 4 4 6 5 3 2 3 5 6 4 10 2-1 3-3 3-5 3 4 4 9 2 12Z" fill="#d9581e"/>' +
      '<path d="M15 44c-1-4 2-6 3-8 1 2 3 2 3 0 2 2 4 3 5 1 1 2 3 4 2 7Z" fill="#f2b23a"/>' +
      '<path d="M8 45l32-3M10 42l28 3" stroke="#5e3a2c" stroke-width="2.4" stroke-linecap="round"/>'),
    // Kin's Coin of Fate: a cracked coin, half a frowning face, half smiling.
    coin: icon('glow-blue',
      '<circle cx="24" cy="24" r="17" fill="#6b6870" stroke="#3c3a40" stroke-width="2"/>' +
      '<circle cx="24" cy="24" r="13.5" fill="none" stroke="#9a98a0" stroke-width="1" stroke-dasharray="2 1.6"/>' +
      '<path d="M24 11.5a12.5 12.5 0 0 0 0 25Z" fill="#3c3a40"/><path d="M24 11.5a12.5 12.5 0 0 1 0 25Z" fill="#c9ccd4"/>' +
      '<path d="M16.5 20.5l3.5 1M27.5 21.5l3.5-1" stroke="#1d1b20" stroke-width="1.4" stroke-linecap="round"/>' +
      '<path d="M17 31c1.5-2 3.5-2 5 0" fill="none" stroke="#9a98a0" stroke-width="1.4" stroke-linecap="round"/>' +
      '<path d="M26.5 29c1.5 2.5 4 2.5 5.5 0" fill="none" stroke="#1d1b20" stroke-width="1.4" stroke-linecap="round"/>' +
      '<path d="M24 8l-2 6 3 5-3 6 2 5-2 6 2 4" fill="none" stroke="#1d1b20" stroke-width="1.4"/>'),
    // Iron Crown of the Prison King: a spiked iron crown set with red stones.
    crown: icon('glow-orange',
      '<path d="M8 35L6 13l8.5 9.5L19 9l5 11 5-11 4.5 13.5L42 13l-2 22Z" fill="#6b6e7a" stroke="#2a2b31" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M10 31.5L8.6 17M24 22v8M38 31.5L39.4 17" stroke="#9a9eaa" stroke-width="1" fill="none"/>' +
      '<circle cx="6" cy="13" r="1.8" fill="#9a9eaa"/><circle cx="19" cy="9" r="1.8" fill="#9a9eaa"/><circle cx="29" cy="9" r="1.8" fill="#9a9eaa"/><circle cx="42" cy="13" r="1.8" fill="#9a9eaa"/>' +
      '<rect x="7.5" y="34" width="33" height="7" rx="1.2" fill="#4a4c57" stroke="#2a2b31" stroke-width="1.3"/>' +
      '<circle cx="15" cy="37.5" r="1.9" fill="#c0282d"/><circle cx="24" cy="37.5" r="2.2" fill="#e0453a"/><circle cx="33" cy="37.5" r="1.9" fill="#c0282d"/>'),
    // Elephant-Foot Maul: Mammoth: a spiked iron hammer head on a bound haft.
    maul: icon('glow-orange',
      '<path d="M11 44l18-23" stroke="#5e3a2c" stroke-width="4.2" stroke-linecap="round"/>' +
      '<path d="M14.5 38.5l3.2-0.6M17.5 34.6l3.2-0.6M20.5 30.7l3.2-0.6" stroke="#9a9eaa" stroke-width="1.4" stroke-linecap="round"/>' +
      '<g transform="rotate(-38 31 16)">' +
      '<path d="M22 9.5l1.6-4.5 1.6 4.5M28.5 9.5l1.6-4.5 1.6 4.5M35 9.5l1.6-4.5 1.6 4.5M22 22.5l1.6 4.5 1.6-4.5M28.5 22.5l1.6 4.5 1.6-4.5M35 22.5l1.6 4.5 1.6-4.5" fill="#9a9eaa" stroke="#2a2b31" stroke-width="0.8" stroke-linejoin="round"/>' +
      '<rect x="19" y="9" width="24" height="14" rx="4" fill="#6b6e7a" stroke="#2a2b31" stroke-width="1.3"/>' +
      '<path d="M25.5 9v14M31.5 9v14M37.5 9v14" stroke="#4a4c57" stroke-width="1.5"/></g>'),
    // Blood-Stained Trap: Berserk Lion: an iron jaw trap, its teeth bloodied,
    // on a short chain.
    trap: icon('glow-red',
      '<path d="M6 26c0-9 8-16 18-16s18 7 18 16" fill="none" stroke="#2a2b31" stroke-width="6" stroke-linecap="round"/>' +
      '<path d="M6 26c0-9 8-16 18-16s18 7 18 16" fill="none" stroke="#6b6e7a" stroke-width="3.6" stroke-linecap="round"/>' +
      '<path d="M10 22l3 5 3-6 3 6 3-7 2 7 3-7 3 6 3-6 3 6 3-5" fill="#e6e7ea" stroke="#2a2b31" stroke-width="0.8" stroke-linejoin="round"/>' +
      '<path d="M15 21l1 3M24 20l0.8 3M33 21l0.6 3" stroke="#a51e24" stroke-width="1.8" stroke-linecap="round"/>' +
      '<rect x="8" y="27" width="32" height="7" rx="2.5" fill="#4a4c57" stroke="#2a2b31" stroke-width="1.3"/>' +
      '<circle cx="24" cy="30.5" r="2.2" fill="#9a9eaa" stroke="#2a2b31" stroke-width="0.8"/>' +
      '<path d="M24 34v4M22 40.5a2 2 0 1 0 4 0a2 2 0 1 0-4 0M24 42.5v2" fill="none" stroke="#7d8089" stroke-width="1.6"/>'),
    // Filthy Claws: Alpha Wolf: four curved iron blades on a knuckle guard,
    // bloodied at the tips.
    claws: icon('glow-red',
      '<path d="M7 5c2 9 6 15 12 19M14 3c1 9 5 15 10 19M21 3c0 8 3 14 8 17M28 5c-1 7 1 13 5 15" fill="none" stroke="#2a2b31" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="M7 5c2 9 6 15 12 19M14 3c1 9 5 15 10 19M21 3c0 8 3 14 8 17M28 5c-1 7 1 13 5 15" fill="none" stroke="#c9ccd4" stroke-width="2" stroke-linecap="round"/>' +
      '<path d="M7 5l1 4M14 3l0.6 4M21 3l0.2 4M28 5l-0.4 3.5" stroke="#a51e24" stroke-width="2.2" stroke-linecap="round"/>' +
      '<rect x="17" y="20" width="22" height="13" rx="4" transform="rotate(-20 28 26.5)" fill="#4a4c57" stroke="#2a2b31" stroke-width="1.3"/>' +
      '<path d="M21 28.5l14-5" stroke="#6b6e7a" stroke-width="1.4"/>' +
      '<path d="M31 34l9 9" stroke="#5e3a2c" stroke-width="5" stroke-linecap="round"/>'),
    // Maddened Beast's Barbed Collar: a blood-red collar ringed with barbs.
    collar: icon('glow-red',
      spikes(24, 24, 14.5, 21.5, 14, 0, '#3a1012') +
      spikes(24, 24, 14.5, 19, 14, 0.5, '#8c1d22') +
      '<circle cx="24" cy="24" r="13" fill="none" stroke="#5a1418" stroke-width="5.2"/>' +
      '<circle cx="24" cy="24" r="13" fill="none" stroke="#c0282d" stroke-width="1.6" stroke-dasharray="5 2.2"/>' +
      spikes(24, 24, 10.6, 7.5, 10, 0.25, '#d9a3a6') +
      '<rect x="20.5" y="34" width="7" height="5" rx="1.2" fill="#2c2c33" stroke="#8d92a8" stroke-width="1"/>'),
  };

  // What else marks a cell: a locked door and what's behind it, a nest, an
  // empty cell, a scratched door (tinted by the rarity it shows) and Tusk.
  const mark = (inner) => `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">${inner}</svg>`;
  const MARKS = {
    sealed: mark('<path d="M16 21v-5a8 8 0 0 1 16 0v5" fill="none" stroke="#c9a35a" stroke-width="3.4"/><rect x="11" y="21" width="26" height="20" rx="3" fill="#c9a35a"/><circle cx="24" cy="29.5" r="2.8" fill="#3b2f19"/><path d="M23 31.5h2l1 5h-4Z" fill="#3b2f19"/>'),
    event: mark('<path d="M24 4l20 20-20 20L4 24Z" fill="#3b2410" stroke="#f28c36" stroke-width="2.4"/><path d="M21.6 12h4.8l-1 15h-2.8Z" fill="#f28c36"/><circle cx="24" cy="33" r="2.7" fill="#f28c36"/>'),
    chain: mark('<rect x="6" y="15" width="22" height="13" rx="6.5" fill="none" stroke="#f28c36" stroke-width="3.6" transform="rotate(-30 17 21.5)"/><rect x="20" y="20" width="22" height="13" rx="6.5" fill="none" stroke="#f5b26b" stroke-width="3.6" transform="rotate(-30 31 26.5)"/>'),
    execution: mark('<path d="M30 6l4 4L12 44l-4-3Z" fill="#7a5130"/><path d="M27 4c7 1 13 6 15 14l-11 3c-1-5-3-8-8-10Z" fill="#c3c6cd" stroke="#7d8089" stroke-width="1"/><path d="M38 9c2.2 2.4 3.4 5.4 4 9" stroke="#e0675f" stroke-width="2" fill="none"/>'),
    // Ravenous Appetite: a tray piled with food.
    appetite: mark('<path d="M6 30h36l-4 8H10Z" fill="#7a5130" stroke="#c9a35a" stroke-width="1.6"/><path d="M12 30c0-7 5-12 12-12s12 5 12 12Z" fill="#b8202a"/><circle cx="18" cy="24" r="3" fill="#e8a33a"/><circle cx="26" cy="21" r="3.4" fill="#e8a33a"/><circle cx="31" cy="26" r="2.6" fill="#e8a33a"/><path d="M24 8v6M19 10l2 5M29 10l-2 5" stroke="#c9cbd2" stroke-width="1.6" stroke-linecap="round"/>'),
    // High-Risk Convict: an open cell door with a Legendary's orange glow.
    convict: mark('<path d="M10 44V18a11 11 0 0 1 22 0v26Z" fill="#2a2f37" stroke="#f28c36" stroke-width="2.4"/><path d="M15 20v22M21 18v24M27 20v22" stroke="#f28c36" stroke-width="2"/><path d="M32 18l8-4v30l-8-2Z" fill="#3a3f48" stroke="#9aa0ad" stroke-width="1.2"/>'),
    // Crow Whispers: a crow's head over a "?" door.
    crow: mark('<path d="M14 44V24a10 10 0 0 1 20 0v20Z" fill="#2a2f37" stroke="#8d92a8" stroke-width="2"/><path d="M20.5 27a3.5 3.5 0 1 1 5.5 2.9c-1.4 1-2 1.8-2 3.6M24 37.5v.5" stroke="#5fc4b8" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M8 12c4-6 12-7 16-3l8-1-6 4c-3 4-9 5-14 3Z" fill="#1d1b20" stroke="#6f7488" stroke-width="1"/><circle cx="20" cy="10.5" r="1.2" fill="#e0675f"/>'),
    // Taste of Freedom: a key over three open doors.
    freedom: mark('<path d="M4 44V26a6 6 0 0 1 12 0v18ZM18 44V22a6 6 0 0 1 12 0v22ZM32 44V26a6 6 0 0 1 12 0v18Z" fill="#2a2f37" stroke="#c9a35a" stroke-width="1.8"/><circle cx="18" cy="9" r="4.5" fill="none" stroke="#e8c46a" stroke-width="2.2"/><path d="M22.5 9h17M33 9v4M37 9v3" stroke="#e8c46a" stroke-width="2.2" stroke-linecap="round"/>'),
    // Extra Portion: a bowl with three servings rising.
    portion: mark('<path d="M6 26h36c0 10-8 17-18 17S6 36 6 26Z" fill="#7a5130" stroke="#c9a35a" stroke-width="1.8"/><path d="M11 22l4-6 4 6M20 15l4-6 4 6M29 22l4-6 4 6" fill="none" stroke="#e8c46a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'),
    // Usurpation: a name gouged into the wall, with one or two claw marks.
    usurp1: mark('<rect x="6" y="8" width="36" height="32" rx="3" fill="#2a2f37" stroke="#9aa0ad" stroke-width="1.4"/><path d="M14 14l4 20M20 13l4 20M26 14l4 20" stroke="#e0675f" stroke-width="2.2" stroke-linecap="round"/><path d="M35 15v18" stroke="#f5ecd8" stroke-width="3" stroke-linecap="round"/>'),
    usurp2: mark('<rect x="6" y="8" width="36" height="32" rx="3" fill="#2a2f37" stroke="#9aa0ad" stroke-width="1.4"/><path d="M11 14l4 20M17 13l4 20M23 14l4 20" stroke="#e0675f" stroke-width="2.2" stroke-linecap="round"/><path d="M32 15v18M38 15v18" stroke="#f5ecd8" stroke-width="3" stroke-linecap="round"/>'),
    // Sewer Ratway: a round sewer grate with a rat's tail slipping through.
    ratway: mark('<circle cx="24" cy="24" r="17" fill="#2a2f37" stroke="#8d92a8" stroke-width="2.4"/><path d="M11 17h26M8.5 24h31M11 31h26M24 8v32" stroke="#8d92a8" stroke-width="2.2"/><path d="M29 35c3 4 8 5 13 2" fill="none" stroke="#d9a3a6" stroke-width="2.4" stroke-linecap="round"/>'),
    // A door the "Treasure" Hunt left dark: a lock with a plus, Rare or better.
    dark: mark('<path d="M13 21v-5a8 8 0 0 1 16 0v5" fill="none" stroke="var(--tc)" stroke-width="3.2"/><rect x="8" y="21" width="26" height="20" rx="3" fill="#2a2f37" stroke="var(--tc)" stroke-width="2.2"/><path d="M40 6v14M33 13h14" stroke="var(--tc)" stroke-width="3.4" stroke-linecap="round"/>'),
    // "Treasure" Hunt: a magnifier over a locked door.
    hunt: mark('<path d="M6 44V24a10 10 0 0 1 20 0v20Z" fill="#2a2f37" stroke="#8d92a8" stroke-width="2"/><circle cx="29" cy="19" r="9" fill="#1d2228" stroke="#e8c46a" stroke-width="3"/><path d="M35.5 25.5l7.5 7.5" stroke="#e8c46a" stroke-width="4" stroke-linecap="round"/><path d="M25 19h8" stroke="#5fc4b8" stroke-width="2.2" stroke-linecap="round"/>'),
    usurp3: mark('<rect x="6" y="8" width="36" height="32" rx="3" fill="#2a2f37" stroke="#9aa0ad" stroke-width="1.4"/><path d="M9 14l4 20M15 13l4 20M21 14l4 20" stroke="#e0675f" stroke-width="2.2" stroke-linecap="round"/><path d="M29 15v18M34 15v18M39 15v18" stroke="#f5ecd8" stroke-width="2.6" stroke-linecap="round"/>'),
    usurp4: mark('<rect x="6" y="8" width="36" height="32" rx="3" fill="#2a2f37" stroke="#9aa0ad" stroke-width="1.4"/><path d="M9 14l3 20M14 13l3 20M19 14l3 20" stroke="#e0675f" stroke-width="2.2" stroke-linecap="round"/><path d="M26 15v18M30.5 15v18M35 15v18M39.5 15v18" stroke="#f5ecd8" stroke-width="2.4" stroke-linecap="round"/>'),
    // A locked door showing its inmate's rarity, beast unknown: a "?" tinted
    // by the rarity.
    revealed: mark('<path d="M12 44V18a12 12 0 0 1 24 0v26Z" fill="#2a2f37" stroke="var(--tc)" stroke-width="2.4"/><path d="M19.5 22a4.5 4.5 0 1 1 7 3.7c-1.8 1.3-2.5 2.4-2.5 4.6M24 36v.6" stroke="var(--tc)" stroke-width="2.6" fill="none" stroke-linecap="round"/>'),
    // Behind Closed Doors: a shut door with an Ultimate's red star.
    trickster: mark('<path d="M12 44V20a12 12 0 0 1 24 0v24Z" fill="#2a2f37" stroke="#ea4f57" stroke-width="2.4"/><path d="M24 13.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8Z" fill="#ea4f57"/><circle cx="31" cy="35" r="1.7" fill="#c9a35a"/>'),
    nest: mark('<path d="M6 34c6 7 30 7 36 0M8 30c6 8 26 8 32 0M10 38c8 5 20 5 28 0" fill="none" stroke="#8a6a3c" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="13" r="5" fill="#d9a634"/><circle cx="32" cy="13" r="5" fill="#d9a634"/><path d="M24 11c7 0 10 6 7 12-2 4-5 7-7 9-2-2-5-5-7-9-3-6 0-12 7-12Z" fill="#f1c84a"/><circle cx="20.5" cy="19" r="1.5" fill="#3b2f19"/><circle cx="27.5" cy="19" r="1.5" fill="#3b2f19"/>'),
    empty: mark('<rect x="8" y="8" width="32" height="32" rx="3" fill="none" stroke="#7a8190" stroke-width="2" stroke-dasharray="4 3.4"/>'),
    scratch: mark('<path d="M12 44V18a12 12 0 0 1 24 0v26Z" fill="#2a2f37" stroke="var(--tc)" stroke-width="2.4"/><path d="M17 20l6 18M22 17l6 18M27 18l5 15" stroke="var(--tc)" stroke-width="2.2" stroke-linecap="round"/>'),
    scouted: mark('<path d="M4 24c5-8 12-12 20-12s15 4 20 12c-5 8-12 12-20 12S9 32 4 24Z" fill="#20252c" stroke="#5fc4b8" stroke-width="2.4"/><circle cx="24" cy="24" r="7" fill="#5fc4b8"/><circle cx="24" cy="24" r="3" fill="#0f1216"/>'),
    ivory: mark('<path d="M10 40c14 2 26-6 30-26 1-4 0-7-2-8-2 8-8 20-26 26-4 1-5 7-2 8Z" fill="#efe6cf" stroke="#b9ad8f" stroke-width="1.2"/>'),
  };

  // The parts inside each cell button.
  const CELL_HTML = '<span class="cell-body"></span><span class="door" aria-hidden="true"></span><span class="cell-no"></span><span class="cell-hint"></span><span class="cell-badges"></span><span class="cell-tag"></span><span class="cell-warden"></span><span class="cell-fx"></span>';

  // A cell's classes, contents, hint, badges and accessible label.
  function cellParts(cell, st) {
    const warden = st.position === cell.n;
    if (cell.n === T.OFFICE) {
      const label = `Cell ${L(cell.n)}: the warden's office. No inmate is ever held here${warden ? '. The warden is here' : ''}`;
      return { cls: ['cell', 'is-office'], body: OFFICE_ART, hint: '', badges: '', label, warden };
    }
    const inmate = cell.inmate;
    const visible = !cell.sealed && !!inmate;
    const known = cell.sealed && cell.hidden && cell.known ? cell.hidden : null;
    const cls = ['cell', cell.sealed ? 'is-sealed' : visible ? 'has-inmate' : 'is-empty'];
    if (visible) cls.push('t' + inmate.tier);
    else if (known) cls.push('t' + known.tier);
    if (cell.scratch) cls.push('has-scratch');
    let body = '';
    let hint = '';
    const badges = [];
    let label = `Cell ${L(cell.n)}: `;
    if (cell.sealed) {
      if (cell.nest) {
        const left = Math.max(0, cell.nest.due - st.day);
        hint = `<span class="nest-count">${left}</span><span class="nest-label"><span class="nest-word">Nest · </span>day ${cell.nest.due}</span>`;
        label += `sealed rat nest, hatches on day ${cell.nest.due}`;
      } else if (known) {
        const text = cell.known === 2 ? T.describe(known) : T.tierName(known.tier);
        hint = `<span class="hint">${text}</span>`;
        label += `sealed, ${text} inside`;
      } else if (cell.atLeast) {
        // A door the "Treasure" Hunt left dark.
        const text = `${T.tierName(cell.atLeast)}+`;
        hint = `<span class="hint">${text}</span>`;
        label += `sealed, ${T.tierName(cell.atLeast)} or better inside`;
      } else {
        label += 'sealed';
      }
      if (cell.event && cell.seen !== false) {
        badges.push('<span class="badge badge-event">Event</span>');
        label += ', special event behind the door';
      }
    } else if (visible) {
      body = `<span class="token">${PORTRAITS[inmate.beast]}<span class="token-beast">${T.beastName(inmate.beast)}</span><span class="token-tier">${T.tierName(inmate.tier)}</span></span>`;
      label += T.describe(inmate);
      if (cell.ivory) {
        badges.push('<span class="badge badge-ivory">Tusk</span>');
        label += ', Tusk cell';
      }
      // An event can wait in an open cell; walking in sets it off.
      if (cell.event) {
        badges.push('<span class="badge badge-event">Event</span>');
        label += ', a special event waits in the cell';
      }
      const link = T.linkOf(st, inmate.id);
      if (link) {
        const hunter = link.lion === inmate.id;
        const other = T.cellOf(st, hunter ? link.prey : link.lion);
        const where = other ? L(other.n) : '--';
        badges.push(`<span class="badge badge-prey">${hunter ? 'Hunt' : 'Prey'} ${where}·${link.rounds}</span>`);
        label += hunter ? `, hunting cell ${where}` : `, prey of cell ${where}`;
      } else if (inmate.marked) {
        // A Prey mark read from a picture, its Lion not known.
        badges.push('<span class="badge badge-prey">Prey</span>');
        label += ', wears a Prey mark';
      }
    } else {
      body = '<span class="floor">Empty</span>';
      label += 'empty';
    }
    if (cell.scratch) {
      badges.push('<span class="badge badge-scratch">Scratch</span>');
      label += ', scratched door';
    }
    if (visible && badges.length) cls.push('has-badges');
    if (warden) label += '. The warden is here';
    return { cls, body, hint, badges: badges.join(''), label, warden };
  }

  root.TartarusBoard = { RING, PORTRAITS, LANTERN, FANGS, OFFICE_ART, INSTRUMENTS, MARKS, CELL_HTML, cellParts };
})(typeof window !== 'undefined' ? window : globalThis);

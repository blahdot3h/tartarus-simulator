/* Tartarus Simulator: solver worker.
 * Runs the Monte Carlo solver off the page's main thread and streams partial
 * results back, so the board stays responsive while it plays options out.
 * A newer request replaces the one in progress.
 *
 * With `raw`, it sends each round's values instead of a result, so the page
 * can run several of these at once, each on its own `stream` of dice, and
 * merge their rows (TartarusSolver.summarize). */
'use strict';

importScripts(`engine.js${self.location.search}`, `tool-combos.js${self.location.search}`, `solver.js${self.location.search}`);

let current = 0;

self.onmessage = (e) => {
  // The page has seen enough of this check.
  if (e.data.stop) {
    if (e.data.stop === current) current = 0;
    return;
  }
  const { id, state, rollouts, params, extra, stream, raw } = e.data;
  current = id;
  const job = self.TartarusSolver.solve(state, { rollouts, params, extra, stream: stream || 0, seed: (id * 7919 + 1) >>> 0 });
  let sent = 0; // rounds already sent
  const tick = () => {
    if (id !== current) return;
    const result = job.step(60);
    if (raw) {
      // Every row gets one value a round, so the new values line up.
      self.postMessage({
        id,
        stream,
        rounds: result.rounds,
        done: result.done,
        goal: result.goal,
        meta: sent === 0 ? job.rows.map((r) => ({ label: r.label, action: r.action, kind: r.kind, extra: r.extra, policy: r.policy })) : null,
        rows: job.rows.map((r) => ({ vals: r.vals.slice(sent), pass: r.pass, points: r.points, best: r.best })),
      });
      sent = result.rounds;
    } else self.postMessage({ id, result });
    if (!result.done) setTimeout(tick, 0);
  };
  tick();
};

/* Tartarus Simulator: screenshot reader worker.
 * Reads a screenshot off the page's thread with js/scan.js and its reference
 * data, so the page stays responsive while it works. A message with
 * kind 'pick' is the instrument pick at the start of a run, not a board. */
'use strict';

importScripts(`scan.js${self.location.search}`, `scan-data.js${self.location.search}`, `pick-data.js${self.location.search}`);

// Where the board was in the last picture: the next one of the same size
// (Auto Screenshot Mode's frames of one window) looks there first.
const cache = {};

self.onmessage = (e) => {
  const { id, kind, width, height, buffer, lang } = e.data;
  try {
    const img = { width, height, data: new Uint8ClampedArray(buffer) };
    if (kind === 'objective') {
      self.postMessage({ id, kind, result: self.TartarusScan.readObjectiveTitle(img) });
      return;
    }
    if (kind === 'tip') {
      self.postMessage({ id, kind, result: self.TartarusScan.findToolTip(img) });
      return;
    }
    if (kind === 'pick') {
      self.postMessage({ id, kind, result: self.TartarusScan.scanPick(img, self.TARTARUS_SCAN, self.TARTARUS_PICK) });
      return;
    }
    // Instruments' panel icons from labeled live screenshots ride along.
    const ref = self.TartarusScan.withPanelIcons(self.TARTARUS_SCAN, self.TARTARUS_PICK);
    const result = self.TartarusScan.scan(img, ref, { cache, lang });
    // The instruments' names and their simulator tools ride along, for the
    // runner-up matches too.
    if (result.tools && result.tools.tools) {
      const names = self.TARTARUS_SCAN.toolNames;
      for (const t of result.tools.tools) {
        Object.assign(t, names[t.id] || {});
        for (const a of t.alts || []) a.sim = (names[a.id] || {}).sim;
      }
      // The instruments the reader can tell on a panel: any other one
      // always reads as something else.
      result.tools.sims = [...new Set(ref.tools.map((r) => (names[r.id] || {}).sim).filter(Boolean))];
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, kind, error: String((err && err.message) || err) });
  }
};

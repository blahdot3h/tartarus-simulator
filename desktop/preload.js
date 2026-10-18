/* Tartarus Overlay: what the site's pages (follow.html, analyze.html) get
 * from the app, as window.TartarusDesktop. The adapters in lib/ use it;
 * the shell (main.js) checks which page asks before it answers, so only
 * follow.html can read the log, and only the analyzer gives advice. */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (channel, fn) => {
  if (typeof fn !== 'function') return;
  ipcRenderer.on(channel, (e, data) => fn(data));
};

contextBridge.exposeInMainWorld('TartarusDesktop', {
  // Whether the game runs, and where its log is: { running, title, log }.
  game: () => ipcRenderer.invoke('game:get'),
  onGame: (fn) => listen('game', fn),
  // The log (follow.html only): { name, size }, or null when it isn't there.
  logStat: () => ipcRenderer.invoke('log:stat'),
  // Bytes start..end of the log, as an ArrayBuffer.
  logRead: async (start, end) => {
    const bytes = await ipcRenderer.invoke('log:read', start, end);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
  // A log file dropped on follow.html: the app reads it, wherever it is
  // (follow.html only). False when the file has no path on this PC.
  useLogFile: (file) => {
    let where = '';
    try {
      where = webUtils.getPathForFile(file);
    } catch (e) {
      where = '';
    }
    if (where) ipcRenderer.send('log:use', where);
    return !!where;
  },
  // The app's own file window, for choosing the log (follow.html only).
  pickLog: () => ipcRenderer.send('log:pick'),
  // The Riot's fight has begun (true) or the prison's screens are back
  // (false), from the log (follow.html only).
  riot: (on) => ipcRenderer.send('site:riot', !!on),
  // A trigger matched (its kind only), for the debug log (follow.html only).
  trigger: (kind) => ipcRenderer.send('site:trigger', String(kind).slice(0, 20)),
  // The run is over (Ignore on the Riot screen), or a new one begins
  // (follow.html only): 'over' or 'new'.
  run: (what) => ipcRenderer.send('site:run', String(what)),
  // To the overlay: what Auto Screenshot Mode is doing, and the advice.
  follow: (data) => ipcRenderer.send('site:follow', data),
  advice: (data) => ipcRenderer.send('site:advice', data),
  // The test record (analyzer only): an entry, and a picture's bytes.
  record: (entry, bytes) => ipcRenderer.send('site:record', entry, bytes),
  // The player's agreement on follow.html, kept by the app (follow.html
  // only): { version, at }, or null.
  consent: () => ipcRenderer.invoke('consent:get'),
  setConsent: (value) => ipcRenderer.send('consent:set', value),
  // When Windows won't share the game window (follow.html only): whether
  // the player allowed the screen it's on instead ({ allowed, asked }),
  // asking for that screen on the next share, and where the game window is
  // on it, for cutting every picture to it.
  screenShare: () => ipcRenderer.invoke('share:screen-ok'),
  shareScreen: (on) => ipcRenderer.send('share:screen', !!on),
  gameCrop: () => ipcRenderer.invoke('game:crop'),
  // The overlay's buttons and the hotkeys: 'capture', 'fix', 'recheck',
  // 'report', and 'debug-report' with its text.
  onDebugReport: (fn) => listen('debug-report', fn),
  onCommand: (fn) => listen('command', fn),
});

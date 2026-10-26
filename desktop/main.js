/* Tartarus Overlay: Auto Screenshot Mode as a desktop app, with the advice in an
 * overlay over the game, for playing on one monitor.
 *
 * The app is a thin shell around the website. It loads the live site's own
 * pages (follow.html and analyze.html), so every fix to the site reaches the
 * app the next time those pages load, with no app update. On top of them it
 * adds what a browser can't do:
 *  - it finds the game's log itself (Steam's libraries, the launcher's
 *    folder), wherever it's installed, and reads it for follow.html, read
 *    only, one file;
 *  - it shares the Torchlight: Infinite window with follow.html itself,
 *    found by its title: no picker, and never another window or a screen;
 *  - it shows the advice in a small always-on-top overlay (lib/overlay.html),
 *    while the game is in front.
 * Two small adapters (lib/follow-adapter.js, lib/analyzer-adapter.js) are
 * put into those pages to connect them to the shell. Pictures and the log
 * never leave the PC. Boards and reports are shared exactly as on the
 * website, by the website's own code.
 *
 * Options: --site=URL (a local copy: --site=http://localhost:8090/),
 * --game-title=REGEX and --log=PATH (tests), --user-data=DIR, --test (no
 * hotkeys, balloons or updates), --dev (developer tools). */
'use strict';

const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, net, screen, session, shell, webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ---------- Options ----------

const arg = (name) => {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const LIVE_SITE = 'https://blahdot3h.github.io/tartarus-simulator/';
let SITE = arg('site') || process.env.TARTARUS_SITE || LIVE_SITE;
if (!SITE.endsWith('/')) SITE += '/';
const SITE_URL = new URL(SITE);
// #region game-title
const GAME_TITLE = new RegExp(arg('game-title') || '^Torchlight: Infinite\\s*$');
// #endregion
const LOG_OVERRIDE = arg('log');
const TEST = flag('test');
// Tests that need windows shown put them off every screen.
const OFFSCREEN = TEST && flag('offscreen');
const DEV = flag('dev') || TEST;
// The maintainer's debug build (--dev) keeps 1 GB of recorded runs; the
// normal build keeps the last few.
const BIG_RECORD = flag('dev');
const STEAM_APP = '1974050'; // Torchlight: Infinite on Steam
const HOTKEYS = { overlay: 'Control+Alt+O', analyzer: 'Control+Alt+A', capture: 'Control+Alt+P' };
const ICON = path.join(__dirname, 'build', 'icon.png');

if (arg('user-data')) app.setPath('userData', path.resolve(arg('user-data')));
// The app's windows sit behind a full-screen game, hidden or not. Chromium
// treats a covered window as not drawn, and a window shown again could show
// an old, narrow picture of its page: every window draws as if in front.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Chromium runs a hidden window's page at idle priority and in Windows'
// efficiency mode: the analyzer is one, so its reading and its live check
// ran on a hybrid CPU's slow cores, two or three times slower while the game
// ran (the user's i9-14900K, 2026-10-25: reads from 0.5 s to 1.1 s and more).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// The app never plays sound: no page it loads, now or after a site change,
// can make any (the user heard sounds in the background while gaming).
app.commandLine.appendSwitch('mute-audio');
app.setAppUserModelId('io.github.blahdot3h.tartarus-overlay');

// ---------- Settings ----------

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); // a byte-order mark (Notepad, PowerShell) is fine
  } catch (e) {
    return {};
  }
};
const settings = Object.assign({
  overlayOn: true, // the player can hide it (Ctrl+Alt+O)
  overlay: null, // { x, y }, where the player dragged it
  overlayWidth: 360,
  hideFromCaptures: true, // kept out of screenshots, recordings and the shared window
  hideBehind: false, // hidden while another window is in front of the game
  highlight: true, // a box over the game around what the advice says to click
  collapsed: false, // the overlay folded to a thin bar ("–" on it)
  cpu: 'half', // the analyzer's share of the processor (tray: Processor use)
  gameFirst: true, // the site pages run below normal priority, so the game comes first
  record: true, // keep a record of each board and advice, for testing
  recordLimitMB: 1024, // debug build (--dev): the record's room on disk, pictures included
  recordRuns: 5, // normal build: the runs the record keeps
  consent: null, // { version, at }: the player agreed on follow.html in the app, to that version
  // When Windows won't share the game window: the player's answer in the
  // overlay to sharing the screen it's on instead ({ on, at }), null until
  // asked. Cleared when the agreement is withdrawn.
  screenShare: null,
  logPath: '', // a log the player chose, when the app didn't find it
  analyzer: null, // the analyzer window's bounds
}, readJson(SETTINGS_FILE));
delete settings.onlyWithGame; // 0.1.1 hid the overlay behind other windows by default
delete settings.locked; // before 0.2.5 the overlay could be locked (clicks went through)
// Before 0.1.7 the overlay's "–" hid it for good, and that was kept; now it
// folds the card. Anyone it hid gets the overlay back once.
if (!(settings.v >= 2)) {
  settings.overlayOn = true;
  settings.v = 2;
}
let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (e) {
      // Kept until the app closes.
    }
  }, 300);
}

// ---------- The debug log ----------

// What the app did, for working out what went wrong in a test: the game
// starting and stopping, the log and window, each picture and the advice,
// errors. With --dev, the pages' own errors and warnings too. Never the
// game log's lines or a picture. At most 2 MB, then it starts over.
const LOG_FILE = path.join(app.getPath('userData'), 'logs', 'overlay.log');
function note(...parts) {
  const text = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  if (TEST) console.log(`[overlay] ${text}`);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.old.log'));
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`);
  } catch (e) {
    // No log this time.
  }
}
process.on('uncaughtException', (e) => note('error', String(e && e.stack || e)));

// ---------- The site's pages ----------

// The site page a URL is, like 'analyze.html', or null for anything else.
function pageOf(url) {
  try {
    const u = new URL(url);
    if (u.origin !== SITE_URL.origin || !u.pathname.startsWith(SITE_URL.pathname)) return null;
    return u.pathname.slice(SITE_URL.pathname.length) || 'index.html';
  } catch (e) {
    return null;
  }
}
const PAGES = { follow: 'follow.html', analyzer: 'analyze.html' };
const ADAPTERS = { follow: 'follow-adapter.js', analyzer: 'analyzer-adapter.js' };

// ---------- Finding the game's log ----------

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, out) => {
      const m = !err && new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`).exec(out);
      resolve(m ? m[1].trim() : null);
    });
  });
}
const statOf = (p) => {
  try {
    return fs.statSync(p);
  } catch (e) {
    return null;
  }
};

// #region find-log
// Where the game writes UE_game.log. While the game runs, beside the game
// itself: Windows says where its program is (UE_game\Binaries\Win64), and
// the log is in UE_game\TorchLight\Saved\Logs. Otherwise under each Steam
// library that has the game, and under the launcher's default folder; the
// newest log there wins. A game under Program Files that can't write there
// has its log in Windows' VirtualStore copy, which is looked at too. Without
// a log yet, a folder of an installed game, where it appears once the game
// starts.
const virtualStore = (p) => (/^[a-z]:\\program files/i.test(p) && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'VirtualStore', p.slice(3)) : null);
// The game writes its log all the time while it runs: one that hasn't
// changed for 2 minutes then isn't the one it writes (reports 357, 365: a
// log left from another install, or Unreal's UE_game_2.log when the first
// was held open).
let logLookedAt = 0;
const STALE_MS = 120000;
function logStale() {
  if (!game.running || !logPath || Date.now() - gameSince < STALE_MS) return false;
  const st = statOf(logPath);
  return !st || Date.now() - st.mtimeMs > STALE_MS;
}
// The newest UE_game*.log in these folders, and when it last changed.
function newestLog(dirs) {
  let best = null;
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^UE_game(_\d+)?\.log$/i.test(n));
    } catch (e) {
      continue;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      const st = statOf(p);
      if (st && st.isFile() && (!best || st.mtimeMs > best.st.mtimeMs)) best = { p, st };
    }
  }
  return best;
}
// The Logs folders beside the running game (and their VirtualStore copies).
function besideGame() {
  const program = game.running && game.hwnd && win32 ? win32.programOf(game.hwnd) : null;
  if (!program || !/torchlight/i.test(program)) return [];
  const own = path.resolve(path.dirname(program), '..', '..', 'TorchLight', 'Saved', 'Logs');
  return [own, virtualStore(own)].filter(Boolean);
}
async function findLog() {
  if (LOG_OVERRIDE) {
    logFoundBy = 'given';
    return path.resolve(LOG_OVERRIDE);
  }
  if (settings.logPath && statOf(path.dirname(settings.logPath))) {
    // A hand-picked log, unless the game stopped writing it and writes
    // another, beside it or beside the running game.
    const chosen = statOf(settings.logPath);
    const idle = game.running && Date.now() - gameSince > STALE_MS && (!chosen || Date.now() - chosen.mtimeMs > STALE_MS);
    const other = idle ? newestLog([path.dirname(settings.logPath), ...besideGame()]) : null;
    if (other && path.resolve(other.p) !== path.resolve(settings.logPath) && Date.now() - other.st.mtimeMs < STALE_MS) {
      logFoundBy = 'being written (the chosen one isn’t)';
      return other.p;
    }
    logFoundBy = 'chosen by the player';
    return settings.logPath;
  }
  const own = newestLog(besideGame());
  if (own) {
    logFoundBy = 'beside the running game';
    return own.p;
  }
  logFoundBy = 'in the game folders';
  const roots = new Map();
  const addRoot = (p) => p && roots.set(path.resolve(p).toLowerCase(), path.resolve(p));
  for (const [key, value] of [['HKCU\\Software\\Valve\\Steam', 'SteamPath'], ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'], ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath']]) addRoot(await regQuery(key, value));
  addRoot('C:\\Program Files (x86)\\Steam');
  const libraries = new Map(roots);
  for (const root of roots.values()) {
    try {
      const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
        const lib = path.resolve(m[1].replace(/\\\\/g, '\\'));
        libraries.set(lib.toLowerCase(), lib);
      }
    } catch (e) {
      // Not a Steam folder.
    }
  }
  const logs = [];
  for (const lib of libraries.values()) {
    try {
      const acf = fs.readFileSync(path.join(lib, 'steamapps', `appmanifest_${STEAM_APP}.acf`), 'utf8');
      const m = /"installdir"\s+"([^"]+)"/.exec(acf);
      if (m) logs.push(path.join(lib, 'steamapps', 'common', m[1], 'UE_game', 'TorchLight', 'Saved', 'Logs', 'UE_game.log'));
    } catch (e) {
      // The game isn't in this library.
    }
  }
  for (const base of ['C:\\Program Files (x86)\\Torchlight Infinite', 'C:\\Program Files\\Torchlight Infinite']) {
    logs.push(path.join(base, 'Game', 'UE_game', 'Torchlight', 'Saved', 'Logs', 'UE_game.log'));
  }
  for (const p of [...logs]) if (virtualStore(p)) logs.push(virtualStore(p));
  const there = logs.map((p) => ({ p, st: statOf(p) })).filter((x) => x.st && x.st.isFile()).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  if (there.length) return there[0].p;
  // UE_game\TorchLight is there: the game is installed, and writes its log on start.
  return logs.find((p) => statOf(path.resolve(p, '..', '..', '..'))) || null;
}

// #endregion
let logPath = null;
let logFoundBy = '';
let logNoted = '';
async function refreshLog() {
  const found = await findLog();
  if (`${found}|${logFoundBy}` !== logNoted) {
    logNoted = `${found}|${logFoundBy}`;
    note(`log file (${logFoundBy}):`, found || 'not found');
  }
  if (found !== logPath) {
    logPath = found;
    pushGame();
    rebuildMenu();
  }
}

async function pickLog() {
  const res = await dialog.showOpenDialog({
    title: 'Choose UE_game.log',
    defaultPath: logPath || undefined,
    properties: ['openFile'],
    filters: [{ name: 'Torchlight: Infinite log', extensions: ['log'] }],
  });
  if (res.canceled || !res.filePaths[0]) return;
  settings.logPath = res.filePaths[0];
  saveSettings();
  await refreshLog();
}

// ---------- The game window ----------

// #region game-window
// What a browser can't see: which program a window is. The game window is
// found by its title, every few seconds.
let game = { running: false, title: '', hwnd: 0 };
let gameSince = 0; // when the game was last found running
// The game counts as closed only after its window has been missing for
// three looks in a row: a failed look, or a moment between two windows
// (loading screens), doesn't hide the overlay or end the share.
let missing = 0;
// Windows' own list of its windows, read for their titles only: a look takes
// about 2 ms. Without it, the capture's list of windows, which takes about
// 0.3 s of processor time a look.
async function findGameWindow() {
  if (win32) return win32.findWindow(GAME_TITLE, game.hwnd);
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  const s = sources.find((x) => GAME_TITLE.test(x.name));
  return s ? { title: s.name, hwnd: Number(s.id.split(':')[1]) || 0 } : null;
}
async function lookForGame() {
  let source = null;
  let looked = false;
  try {
    source = await findGameWindow();
    looked = true;
  } catch (e) {
    // Try again next time.
  }
  missing = source ? 0 : missing + (looked ? 1 : 0);
  if (!source && (!looked || (game.running && missing < 3))) {
    setTimeout(lookForGame, 2000);
    return;
  }
  const was = game.running;
  const wasHwnd = game.hwnd;
  game = { running: !!source, title: source ? source.title.trim() : '', hwnd: source ? source.hwnd : 0, admin: game.admin };
  if (was && game.running && wasHwnd && game.hwnd !== wasHwnd) {
    note(`game window changed (window ${win32 ? win32.stateOf(game.hwnd) : 'state unknown'})`);
    pushGame();
  }
  if (!was && game.running) gameSince = Date.now();
  // A log the game stopped writing gives way to one it's writing.
  if (game.running && Date.now() - logLookedAt > 30000) {
    logLookedAt = Date.now();
    if (logStale()) refreshLog();
  }
  if (game.running !== was) {
    // Whether the game runs as administrator (see adminText): Windows cuts
    // off at once a window share from an app that doesn't.
    if (game.running) game.admin = win32 && game.hwnd ? win32.elevatedOf(game.hwnd) : null;
    note(game.running ? `game running: "${game.title}" (window ${win32 && game.hwnd ? win32.stateOf(game.hwnd) : 'state unknown'}); ${adminText(game.admin)}` : 'game closed');
    recordEvent({ type: game.running ? 'game' : 'game-closed' });
    if (game.running) await refreshLog();
    if (game.running && !overlayPlaced) placeOverlay();
    if (!game.running) checkSite();
    pushGame();
    rebuildMenu();
  }
  setTimeout(lookForGame, 2000);
}

// #endregion
// The window in front, and window rectangles, from Windows itself. Without
// them, the overlay shows whenever the game runs.
const win32 = (() => {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const foreground = user32.func('__stdcall', 'GetForegroundWindow', 'intptr', []);
    const rect = user32.func('__stdcall', 'GetWindowRect', 'bool', ['intptr', koffi.out(koffi.pointer(RECT))]);
    const iconic = user32.func('__stdcall', 'IsIconic', 'bool', ['intptr']);
    const kernel32 = koffi.load('kernel32.dll');
    const windowPid = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr', koffi.out(koffi.pointer('uint32'))]);
    const openProcess = kernel32.func('__stdcall', 'OpenProcess', 'intptr', ['uint32', 'bool', 'uint32']);
    const imageName = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['intptr', 'uint32', 'void *', koffi.inout(koffi.pointer('uint32'))]);
    const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['intptr']);
    const nextWindow = user32.func('__stdcall', 'FindWindowExW', 'intptr', ['intptr', 'intptr', 'void *', 'void *']);
    const windowText = user32.func('__stdcall', 'GetWindowTextW', 'int', ['intptr', 'void *', 'int']);
    const visible = user32.func('__stdcall', 'IsWindowVisible', 'bool', ['intptr']);
    const hung = user32.func('__stdcall', 'IsHungAppWindow', 'bool', ['intptr']);
    const longPtr = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr', ['intptr', 'int']);
    let dwmAttr = null;
    try {
      dwmAttr = koffi.load('dwmapi.dll').func('__stdcall', 'DwmGetWindowAttribute', 'int32', ['intptr', 'uint32', 'void *', 'uint32']);
    } catch (e) {
      // Without DWM, nothing is cloaked.
    }
    const advapi32 = koffi.load('advapi32.dll');
    const openToken = advapi32.func('__stdcall', 'OpenProcessToken', 'bool', ['intptr', 'uint32', koffi.out(koffi.pointer('intptr'))]);
    const tokenInfo = advapi32.func('__stdcall', 'GetTokenInformation', 'bool', ['intptr', 'int', 'void *', 'uint32', koffi.out(koffi.pointer('uint32'))]);
    // Whether a process runs as administrator (TokenElevation): true, false,
    // or null when Windows won't say, as it often won't to a program not run
    // as administrator about one that is.
    const elevated = (h) => {
      const token = [0];
      if (!openToken(h, 0x0008, token) || !Number(token[0])) return null; // TOKEN_QUERY
      try {
        const flag = Buffer.alloc(4);
        return tokenInfo(token[0], 20, flag, 4, [0]) ? flag.readUInt32LE(0) !== 0 : null;
      } finally {
        closeHandle(token[0]);
      }
    };
    // The program that started a process, from Windows' process list.
    const ENTRY = koffi.struct('PROCESSENTRY32W', { dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32', th32DefaultHeapID: 'uintptr_t', th32ModuleID: 'uint32', cntThreads: 'uint32', th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32', szExeFile: koffi.array('char16', 260, 'String') });
    const snapshot = kernel32.func('__stdcall', 'CreateToolhelp32Snapshot', 'intptr', ['uint32', 'uint32']);
    const firstProcess = kernel32.func('__stdcall', 'Process32FirstW', 'bool', ['intptr', koffi.inout(koffi.pointer(ENTRY))]);
    const nextProcess = kernel32.func('__stdcall', 'Process32NextW', 'bool', ['intptr', koffi.inout(koffi.pointer(ENTRY))]);
    const processes = () => {
      const list = new Map();
      const snap = snapshot(2, 0); // TH32CS_SNAPPROCESS
      if (Number(snap) === -1 || !Number(snap)) return list;
      try {
        const e = { dwSize: koffi.sizeof(ENTRY) };
        for (let ok = firstProcess(snap, e); ok; e.dwSize = koffi.sizeof(ENTRY), ok = nextProcess(snap, e)) list.set(e.th32ProcessID, { parent: e.th32ParentProcessID, name: e.szExeFile });
      } finally {
        closeHandle(snap);
      }
      return list;
    };
    // Windows' efficiency mode (EcoQoS) for a process: off, as the app
    // asks for its pages. PROCESS_POWER_THROTTLING_EXECUTION_SPEED in the
    // control mask with the state clear turns it off; read back, whether
    // it's on.
    const THROTTLE = koffi.struct('PROCESS_POWER_THROTTLING_STATE', { Version: 'uint32', ControlMask: 'uint32', StateMask: 'uint32' });
    const setInfo = kernel32.func('__stdcall', 'SetProcessInformation', 'bool', ['intptr', 'int', koffi.pointer(THROTTLE), 'uint32']);
    const getInfo = kernel32.func('__stdcall', 'GetProcessInformation', 'bool', ['intptr', 'int', koffi.inout(koffi.pointer(THROTTLE)), 'uint32']);
    const ecoOff = (pid) => {
      const h = pid ? openProcess(0x1200, false, pid) : 0; // set + query limited information
      if (!h) return null;
      try {
        const now = { Version: 1, ControlMask: 0, StateMask: 0 };
        const was = getInfo(h, 4, now, koffi.sizeof(THROTTLE)) && !!(now.ControlMask & 1) && !!(now.StateMask & 1);
        setInfo(h, 4, { Version: 1, ControlMask: 1, StateMask: 0 }, koffi.sizeof(THROTTLE));
        return was;
      } finally {
        closeHandle(h);
      }
    };
    const elevatedPid = (pid) => {
      const h = pid ? openProcess(0x1000, false, pid) : 0;
      if (!h) return null;
      try {
        return elevated(h);
      } finally {
        closeHandle(h);
      }
    };
    return {
      // Efficiency mode off for a process; true if it had been on.
      ecoOff,
      // Whether the program behind a window runs as administrator: Windows
      // cuts off at once a window share from a program that doesn't. The
      // game's own process often won't say (its protection); a game started
      // by a program that runs as administrator runs as one too, so that
      // program is told as well. { game, by: { name, admin } }.
      elevatedOf(hwnd) {
        const pid = [0];
        windowPid(hwnd, pid);
        if (!pid[0]) return { game: null, by: null };
        const game = elevatedPid(pid[0]);
        const list = processes();
        const me = list.get(pid[0]);
        const parent = me && list.get(me.parent);
        return { game, by: parent ? { name: parent.name, admin: elevatedPid(me.parent) } : null };
      },
      // This app itself (GetCurrentProcess's handle is -1).
      selfElevated: () => elevated(-1),
      // What a window is like, for the debug log: the capture's list leaves
      // out windows that are cloaked (another desktop, say), not responding
      // or tool windows.
      stateOf(hwnd) {
        const flags = [];
        if (dwmAttr) {
          const cloaked = Buffer.alloc(4);
          if (dwmAttr(hwnd, 14, cloaked, 4) === 0 && cloaked.readUInt32LE(0)) flags.push('cloaked'); // DWMWA_CLOAKED
        }
        if (hung(hwnd)) flags.push('not responding');
        if (iconic(hwnd)) flags.push('minimized');
        if (Number(longPtr(hwnd, -20)) & 0x80) flags.push('tool window'); // WS_EX_TOOLWINDOW
        return flags.join(', ') || 'shown normally';
      },
      // The shown top-level window whose title matches, not one of this
      // app's: { title, hwnd }, or null. The one found last time is looked
      // at first. Titles only, nothing else of any window.
      findWindow(re, known) {
        const buf = Buffer.alloc(1024);
        const fits = (h) => {
          if (!visible(h)) return null;
          const n = windowText(h, buf, 512);
          const title = n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
          if (!re.test(title)) return null;
          const pid = [0];
          windowPid(h, pid);
          return pid[0] === process.pid ? null : { title, hwnd: h };
        };
        // The largest that fits: a launcher can share the game's title
        // (reports 371, 372, 379), and the game's own window is the big one.
        // A minimized one keeps its place.
        if (known && iconic(known)) {
          const again = fits(known);
          if (again) return again;
        }
        let best = null;
        for (let h = Number(nextWindow(0, 0, null, null)); h; h = Number(nextWindow(0, h, null, null))) {
          const found = fits(h);
          if (!found) continue;
          const r = {};
          const area = rect(h, r) ? (r.right - r.left) * (r.bottom - r.top) : 0;
          if (!best || area > best.area || (area === best.area && h === known)) best = { title: found.title, hwnd: h, area };
        }
        return best ? { title: best.title, hwnd: best.hwnd } : null;
      },
      // Where the program behind a window is: only its file's name
      // (PROCESS_QUERY_LIMITED_INFORMATION reads nothing else of it).
      programOf(hwnd) {
        const pid = [0];
        windowPid(hwnd, pid);
        if (!pid[0]) return null;
        const h = openProcess(0x1000, false, pid[0]);
        if (!h) return null;
        try {
          const buf = Buffer.alloc(4096);
          const size = [2048];
          return imageName(h, 0, buf, size) ? buf.toString('utf16le', 0, size[0] * 2) : null;
        } finally {
          closeHandle(h);
        }
      },
      foreground: () => Number(foreground()),
      // The process a window belongs to.
      pidOf(hwnd) {
        const pid = [0];
        windowPid(hwnd, pid);
        return pid[0];
      },
      rect(hwnd) {
        const r = {};
        return rect(hwnd, r) ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null;
      },
      minimized: (hwnd) => !!iconic(hwnd),
      // A window's visible frame, in screen pixels: GetWindowRect adds the
      // invisible resize borders, where what's behind the window shows
      // (DWMWA_EXTENDED_FRAME_BOUNDS).
      frame(hwnd) {
        if (dwmAttr) {
          const b = Buffer.alloc(16);
          if (dwmAttr(hwnd, 9, b, 16) === 0) {
            const x = b.readInt32LE(0);
            const y = b.readInt32LE(4);
            const width = b.readInt32LE(8) - x;
            const height = b.readInt32LE(12) - y;
            if (width > 0 && height > 0) return { x, y, width, height };
          }
        }
        const r = {};
        return rect(hwnd, r) ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null;
      },
    };
  } catch (e) {
    return null;
  }
})();
// "As administrator", for the debug log and report: the game's, or when its
// process won't say, the program that started it, and this app's. A game
// run as administrator, with this app not, has its window share cut off.
const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');
// The game likely runs as administrator and this app doesn't.
const adminBlocks = (a) => !!a && (a.game === true || (a.game === null && !!a.by && a.by.admin === true)) && !(win32 && win32.selfElevated() === true);
function adminText(a) {
  const self = win32 ? win32.selfElevated() : null;
  const by = a && a.by ? `, started by ${a.by.name} (as administrator: ${yesNo(a.by.admin)})` : '';
  return `game as administrator: ${yesNo(a ? a.game : null)}${by}; Tartarus Overlay as administrator: ${yesNo(self)}${adminBlocks(a) ? ' (the game likely runs as administrator and this app doesn’t: Windows can stop the window share)' : ''}`;
}
const hwndOf = (win) => {
  if (!win || win.isDestroyed()) return 0;
  const b = win.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
};

// ---------- The test record ----------

// #region record
// For testing: each picture the analyzer got, what the reader made of it,
// the board it advised on and the advice, and the player's fixes and
// commands, one run a folder (record.jsonl and pictures/), kept on this PC.
// The review window (lib/review.html) steps through them. The debug build
// (--dev, the maintainer's own) keeps runs up to settings.recordLimitMB
// (1 GB) in all; the normal build keeps the last settings.recordRuns (5).
// The oldest go first, never the one being written.
const RECORDS = path.join(app.getPath('userData'), 'records');
const SESSION_NAME = /^\d{4}-\d\d-\d\dT[\d-]+$/;
let recording = null; // { name, dir, file, pictures }
const pictureFiles = new Map(); // picture id -> the file its entry named, until it's written
let recordBytes = 0; // all sessions, roughly
const recordLimit = () => Math.max(1, Number(settings.recordLimitMB) || 1024) * 1024 * 1024;
const keepRuns = () => Math.max(1, Number(settings.recordRuns) || 5);
function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : (statOf(p) || { size: 0 }).size;
  }
  return total;
}
// Over the limit, the oldest runs go, never the one being written.
function pruneRecords() {
  try {
    const sizes = fs.readdirSync(RECORDS).filter((d) => SESSION_NAME.test(d)).sort().map((d) => ({ d, size: dirSize(path.join(RECORDS, d)) }));
    let total = sizes.reduce((sum, s) => sum + s.size, 0);
    let left = sizes.length;
    for (const s of sizes) {
      if (BIG_RECORD ? total <= recordLimit() : left <= keepRuns()) break;
      if (recording && s.d === recording.name) continue;
      fs.rmSync(path.join(RECORDS, s.d), { recursive: true, force: true });
      total -= s.size;
      left -= 1;
      note('record: removed the old run', s.d);
    }
    recordBytes = total;
  } catch (e) {
    // No records yet.
  }
  rebuildMenu();
}
function recordTo() {
  if (recording) return recording;
  const name = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(RECORDS, name);
  fs.mkdirSync(path.join(dir, 'pictures'), { recursive: true });
  recording = { name, dir, file: path.join(dir, 'record.jsonl'), pictures: 0 };
  fs.appendFileSync(recording.file, `${JSON.stringify({ type: 'session', at: new Date().toISOString(), version: app.getVersion(), site: SITE, log: logPath })}\n`);
  pruneRecords();
  return recording;
}
function addRecord(entry, bytes) {
  if (!settings.record) return;
  try {
    // A new run gets its own folder: it starts with its objective, or with
    // the instrument pick that opens it (not a re-roll of that pick).
    if (recording && recording.pictures > 0 && entry.type === 'picture') {
      const opens = entry.kind === 'objective' || (entry.kind === 'instruments' && entry.fresh);
      if (opens && !['objective', 'instruments'].includes(recording.lastKind)) recording = null;
    }
    // A picture's file, sent after the analyzer read it: written under the
    // name its entry got, with no line of its own (and no new run's folder:
    // its run may be over already).
    if (entry.type === 'picture-file') {
      const file = pictureFiles.get(entry.id);
      pictureFiles.delete(entry.id);
      if (file && bytes && bytes.byteLength > 0 && bytes.byteLength < 12 * 1024 * 1024) {
        fs.writeFileSync(file, Buffer.from(bytes));
        recordBytes += bytes.byteLength;
        if (BIG_RECORD && recordBytes > recordLimit()) pruneRecords();
      }
      return;
    }
    const s = recordTo();
    if (entry.type === 'picture') s.lastKind = entry.kind;
    const out = Object.assign({ at: new Date().toISOString() }, entry);
    delete out.pending;
    if (entry.type === 'picture' && entry.pending) {
      s.pictures += 1;
      out.file = `pictures/${String(s.pictures).padStart(4, '0')}-${String(entry.kind || 'picture').replace(/[^a-z]/gi, '')}.webp`;
      pictureFiles.set(entry.id, path.join(s.dir, out.file));
      if (pictureFiles.size > 50) pictureFiles.delete(pictureFiles.keys().next().value);
    } else if (bytes && bytes.byteLength > 0 && bytes.byteLength < 12 * 1024 * 1024) {
      s.pictures += 1;
      out.file = `pictures/${String(s.pictures).padStart(4, '0')}-${String(entry.kind || 'picture').replace(/[^a-z]/gi, '')}.webp`;
      fs.writeFileSync(path.join(s.dir, out.file), Buffer.from(bytes));
      recordBytes += bytes.byteLength;
      if (BIG_RECORD && recordBytes > recordLimit()) pruneRecords();
    }
    fs.appendFileSync(s.file, `${JSON.stringify(out)}\n`);
  } catch (e) {
    note('record failed:', String((e && e.message) || e));
  }
}
// Only while a session is open: the game starting and closing, commands.
const recordEvent = (entry) => recording && addRecord(entry);

// #endregion
const readLines = (file) => (statOf(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter(Boolean);
function listSessions() {
  try {
    return fs.readdirSync(RECORDS).filter((d) => SESSION_NAME.test(d)).sort().reverse().map((name) => {
      const types = readLines(path.join(RECORDS, name, 'record.jsonl')).map((l) => (/"type":"([\w-]+)"/.exec(l) || [])[1]);
      const count = (t) => types.filter((x) => x === t).length;
      return { name, pictures: count('picture'), advice: count('advice'), edits: count('edit') };
    });
  } catch (e) {
    return [];
  }
}
function loadSession(name) {
  if (!SESSION_NAME.test(String(name))) return null;
  const dir = path.join(RECORDS, name);
  const file = path.join(dir, 'record.jsonl');
  if (!statOf(file)) return null;
  const entries = readLines(file).map((l) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
  return { name, base: `${require('url').pathToFileURL(dir).href}/`, entries };
}

function showReview() {
  if (wins.review && !wins.review.isDestroyed()) {
    wins.review.show();
    wins.review.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1400,
    height: 950,
    title: 'Review the record · Tartarus Overlay',
    show: !TEST,
    icon: ICON,
    backgroundColor: '#0f1216',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'lib', 'review-preload.js'), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  wins.review = win;
  win.loadFile(path.join(__dirname, 'lib', 'review.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (DEV) {
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }
}

// ---------- Processor use ----------

// How much of the processor the analyzer's live check may use (tray:
// Processor use): its workers, a share of the cores. The site pages also
// run below normal priority (settings.gameFirst), so whenever the game and
// the app both want the processor, the game gets it. Workers run inside
// their page's process, so they're below normal too.
const CORES = require('os').availableParallelism();
const CPU_USE = {
  most: { label: 'Fastest: every core but one', workers: Math.max(1, CORES - 1) },
  half: { label: 'Balanced: half the cores', workers: Math.max(1, Math.round(CORES / 2)) },
  quarter: { label: 'Light: a quarter of the cores', workers: Math.max(1, Math.round(CORES / 4)) },
  one: { label: 'Lightest: one core', workers: 1 },
};
const cpuUse = () => CPU_USE[settings.cpu] || CPU_USE.half;
// Each minute: the site pages still run at the priority the app gave them,
// with Windows' efficiency mode off. Chromium lowered a hidden page's to
// idle and turned efficiency mode on after some hours (the user's app,
// 2026-10-25); the debug log says when it had to be put back.
function keepPagePriority() {
  const os = require('os');
  const want = settings.gameFirst ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL;
  for (const name of ['follow', 'analyzer']) {
    const win = wins[name];
    if (!win || win.isDestroyed()) continue;
    try {
      const pid = win.webContents.getOSProcessId();
      if (!pid) continue;
      const was = os.getPriority(pid);
      if (was !== want) os.setPriority(pid, want);
      const eco = win32 && win32.ecoOff ? win32.ecoOff(pid) : null;
      if (was !== want || eco) note(`${name} page: priority put back (it was ${was}${eco ? ', in efficiency mode' : ''})`);
    } catch (e) {
      // the page is going or gone
    }
  }
}
setInterval(keepPagePriority, 60 * 1000);
function tunePage(name) {
  const win = wins[name];
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  try {
    const os = require('os');
    const pid = wc.getOSProcessId();
    os.setPriority(pid, settings.gameFirst ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL);
    if (win32 && win32.ecoOff) win32.ecoOff(pid);
    note(`${name} page: ${settings.gameFirst ? 'below normal' : 'normal'} priority (process ${pid})`);
  } catch (e) {
    note(`${name} page priority not set:`, String((e && e.message) || e));
  }
  // The analyzer's API may come a moment after the page.
  if (name === 'analyzer' && pageOf(wc.getURL()) === PAGES.analyzer) setTimeout(readGameLang, 3000);
  if (name === 'analyzer' && pageOf(wc.getURL()) === PAGES.analyzer) {
    wc.executeJavaScript(`(function cap(n, tries) {
      if (window.TartarusAnalyzer && TartarusAnalyzer.setCores) return TartarusAnalyzer.setCores(n);
      if (tries > 0) setTimeout(() => cap(n, tries - 1), 1000);
      return null;
    })(${cpuUse().workers}, 30)`).then((n) => n && note(`analyzer: at most ${n} ${n === 1 ? 'worker' : 'workers'}`)).catch(() => {});
  }
}
// The game's language, for the analyzer (its window is hidden in the app):
// on a client not in English, it warns that doors, decisions, instruments
// and printed names may need setting by hand, and offers to send a screen
// it didn't recognize. Kept by the analyzer page; read back for the menu.
const GAME_LANGS = [['en', 'English'], ['ru', 'Русский (Russian)'], ['zh', '中文 (Chinese)'], ['ja', '日本語 (Japanese)']];
let gameLang = 'en';
function readGameLang() {
  const wc = wins.analyzer && !wins.analyzer.isDestroyed() ? wins.analyzer.webContents : null;
  if (!wc) return;
  wc.executeJavaScript('window.TartarusAnalyzer && TartarusAnalyzer.gameLang ? TartarusAnalyzer.gameLang() : "en"').then((code) => {
    if (code && code !== gameLang) {
      gameLang = code;
      rebuildMenu();
    }
  }).catch(() => {});
}
function setGameLang(code) {
  const wc = wins.analyzer && !wins.analyzer.isDestroyed() ? wins.analyzer.webContents : null;
  if (!wc) return;
  gameLang = code;
  note(`game language: ${code}`);
  wc.executeJavaScript(`window.TartarusAnalyzer && TartarusAnalyzer.setGameLang ? TartarusAnalyzer.setGameLang(${JSON.stringify(code)}) : null`).catch(() => {});
  rebuildMenu();
}
function setCpu(key) {
  if (!CPU_USE[key]) return;
  settings.cpu = key;
  saveSettings();
  note(`processor use: ${CPU_USE[key].label}, ${CPU_USE[key].workers} of ${CORES}`);
  tunePage('analyzer');
  rebuildMenu();
}
function setGameFirst(on) {
  settings.gameFirst = !!on;
  saveSettings();
  note(`game first: ${settings.gameFirst ? 'on' : 'off'}`);
  tunePage('follow');
  tunePage('analyzer');
  rebuildMenu();
}
// The analyzer's workers right now: { cap, use, most, running }, or null.
function coresNow() {
  const wc = wins.analyzer && !wins.analyzer.isDestroyed() ? wins.analyzer.webContents : null;
  if (!wc || pageOf(wc.getURL()) !== PAGES.analyzer) return Promise.resolve(null);
  const ask = wc.executeJavaScript('window.TartarusAnalyzer && TartarusAnalyzer.cores ? TartarusAnalyzer.cores() : null').catch(() => null);
  return Promise.race([ask, new Promise((r) => setTimeout(() => r(null), 2000))]);
}

// The app's memory and processor use over all its processes, for the debug
// log and report: memory in use now, in MB, and the processor as a share of
// one core, since this caller's last look (since each process started, the
// first time).
const usageWas = {};
function usage(caller) {
  const names = new Map();
  for (const [name, win] of Object.entries(wins)) if (win && !win.isDestroyed()) names.set(win.webContents.getOSProcessId(), name);
  const now = Date.now();
  const was = usageWas[caller];
  const seconds = new Map();
  let mb = 0;
  let used = 0;
  let span = 0;
  const each = [];
  for (const m of app.getAppMetrics()) {
    const one = Math.round(m.memory.workingSetSize / 1024);
    const cpu = (m.cpu && m.cpu.cumulativeCPUUsage) || 0;
    mb += one;
    seconds.set(m.pid, cpu);
    each.push(`${names.get(m.pid) || String(m.type).toLowerCase()} ${one}`);
    if (was) used += Math.max(0, cpu - (was.seconds.get(m.pid) || 0));
    else {
      used += cpu;
      span = Math.max(span, (now - m.creationTime) / 1000);
    }
  }
  if (was) span = (now - was.at) / 1000;
  usageWas[caller] = { at: now, seconds };
  return { mb, cpu: span > 0 ? Math.round((used / span) * 100) : null, since: was ? 'last note' : 'start', each };
}
const usageText = (u, c) => `app ${u.mb} MB (${u.each.join(', ')})${u.cpu === null ? '' : `, ${u.cpu}% of one core since the ${u.since}`}; analyzer workers: ${c ? `${c.running} running, ${c.use} allowed of ${c.most + 1}` : 'not known'}`;

// ---------- Windows ----------

const wins = { follow: null, analyzer: null, overlay: null, review: null, highlight: null };
let quitting = false;
let tray = null;

function sitePreferences() {
  return { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true, sandbox: true, spellcheck: false };
}

function loadPage(name) {
  const win = wins[name];
  win.loadURL(SITE + PAGES[name], { extraHeaders: 'pragma: no-cache\n' }).catch(() => {
    // did-fail-load retries.
  });
}

function makeSiteWindow(name, opts) {
  const win = new BrowserWindow(Object.assign({
    show: false,
    width: 1100,
    height: 860,
    backgroundColor: '#0f1216',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: sitePreferences(),
  }, opts));
  win.removeMenu();
  wins[name] = win;
  const wc = win.webContents;
  // The adapter goes in once the page's own scripts have run.
  wc.on('dom-ready', () => {
    if (pageOf(wc.getURL()) !== PAGES[name]) return;
    const code = fs.readFileSync(path.join(__dirname, 'lib', ADAPTERS[name]), 'utf8');
    note(`${name} page loaded:`, wc.getURL());
    wc.executeJavaScript(code, true).catch((e) => note(`${name} adapter error:`, String((e && e.message) || e)));
    tunePage(name);
  });
  // The page's own errors (and with --dev, its warnings), for the debug log.
  wc.on('console-message', (e, ...old) => {
    const level = e.level !== undefined ? e.level : old[0];
    const message = e.message !== undefined ? e.message : old[1];
    const where = `${e.sourceId !== undefined ? e.sourceId : old[3]}:${e.lineNumber !== undefined ? e.lineNumber : old[2]}`;
    if (/Electron Security Warning/.test(String(message))) return; // shown only when run from source
    if (level === 'error' || level === 3 || (DEV && (level === 'warning' || level === 2))) note(`${name} console ${level}:`, String(message).slice(0, 600), where);
  });
  // Offline, or the site is down: try again.
  wc.on('did-fail-load', (e, code, text, url, mainFrame) => {
    if (!mainFrame || code === -3) return; // -3: a load replaced by another
    note(`${name} page failed to load:`, code, text);
    pushShell({ offline: `${PAGES[name]}: ${text}` });
    setTimeout(() => !win.isDestroyed() && loadPage(name), 15000);
  });
  wc.on('did-finish-load', () => pushShell({ offline: '' }));
  wc.on('render-process-gone', (e, details) => {
    note(`${name} page crashed:`, details && details.reason);
    setTimeout(() => !win.isDestroyed() && loadPage(name), 1000);
  });
  // Only this window's own page loads in it. Links to the other app page
  // show that window; anything else opens in the player's browser.
  wc.on('will-navigate', (e, url) => {
    if (pageOf(url) === PAGES[name]) return;
    e.preventDefault();
    if (!route(url) && /^https?:/i.test(url)) shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (route(url)) return { action: 'deny' };
    // A picture's preview on follow.html.
    if (url.startsWith('blob:')) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, webPreferences: { preload: undefined, sandbox: true, contextIsolation: true } } };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (DEV) {
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') wc.toggleDevTools();
    });
  }
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  loadPage(name);
  return win;
}

// A link to another app page shows that window.
function route(url) {
  const page = pageOf(url);
  const name = Object.keys(PAGES).find((k) => PAGES[k] === page);
  if (!name) return false;
  show(name);
  return true;
}

function show(name) {
  const win = wins[name];
  if (!win || win.isDestroyed()) return;
  if (OFFSCREEN) win.setPosition(Math.min(...screen.getAllDisplays().map((d) => d.bounds.x)) - win.getSize()[0] - 400, 0);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  redraw(win);
}

// A window shown after being hidden can show an old, narrow picture of its
// page until something makes it draw again: a size nudge lays the page out
// at its real size, and it's drawn again in full twice over.
function redraw(win) {
  const paint = () => !win.isDestroyed() && win.webContents.invalidate();
  if (!win.isMaximized() && !win.isFullScreen()) {
    const [w, h] = win.getSize();
    setTimeout(() => !win.isDestroyed() && win.setSize(w + 1, h + 1), 50);
    setTimeout(() => !win.isDestroyed() && win.setSize(w, h), 150);
  }
  setTimeout(paint, 300);
  setTimeout(paint, 1000);
}

function toggle(name) {
  const win = wins[name];
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else show(name);
}

function makeAnalyzer() {
  const b = settings.analyzer && onScreen(settings.analyzer) ? settings.analyzer : null;
  const win = makeSiteWindow('analyzer', Object.assign({ width: 1280, height: 900, title: 'Board analyzer · Tartarus Overlay' }, b || {}));
  const keep = () => {
    if (win.isMaximized() || win.isMinimized()) return;
    settings.analyzer = win.getBounds();
    saveSettings();
  };
  win.on('moved', keep);
  win.on('resized', keep);
  return win;
}

// ---------- The overlay ----------

let overlayPlaced = false;

const onScreen = (b) => screen.getAllDisplays().some((d) => {
  const a = d.workArea;
  return b.x + 60 > a.x && b.x < a.x + a.width - 60 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
});

// Where the player left it; at first, the game window's top right corner,
// or the main screen's.
function placeOverlay() {
  const win = wins.overlay;
  if (!win) return;
  const w = settings.overlayWidth;
  let at = settings.overlay && onScreen(settings.overlay) ? settings.overlay : null;
  if (at) overlayPlaced = true;
  else {
    let area = screen.getPrimaryDisplay().workArea;
    const r = game.running && win32 ? win32.rect(game.hwnd) : null;
    if (r && r.width > 200) {
      area = screen.screenToDipRect(null, r);
      overlayPlaced = true;
    }
    at = { x: Math.round(area.x + area.width - w - 24), y: Math.round(area.y + Math.min(140, area.height / 8)) };
  }
  const b = win.getBounds();
  win.setBounds({ x: at.x, y: at.y, width: w, height: b.height });
}

function makeOverlay() {
  const win = new BrowserWindow({
    width: settings.overlayWidth,
    height: 150,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // clicks on it don't take the game out of focus
    hasShadow: false,
    title: 'Tartarus Overlay',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'lib', 'overlay-preload.js'), backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  wins.overlay = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(!!settings.hideFromCaptures);
  win.loadFile(path.join(__dirname, 'lib', 'overlay.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', () => {
    pushShell();
    pushGame();
    if (lastAdvice) send('overlay', 'advice', lastAdvice);
    if (lastFollow) send('overlay', 'follow', lastFollow);
  });
  win.on('moved', () => {
    const b = win.getBounds();
    settings.overlay = { x: b.x, y: b.y };
    saveSettings();
  });
  win.on('close', (e) => {
    if (!quitting) e.preventDefault();
  });
  placeOverlay();
  return win;
}

// Shown while the game runs, whatever is in front. With hideBehind (the
// tray menu), only while the game itself is in front.
let overlayShown = false;
function overlayWanted() {
  if (!settings.overlayOn || !game.running) return false;
  if (!settings.hideBehind || !win32) return true;
  const front = win32.foreground();
  if (front === game.hwnd) return !win32.minimized(game.hwnd);
  return front === hwndOf(wins.overlay);
}
function updateOverlay() {
  const win = wins.overlay;
  if (!win || win.isDestroyed()) return;
  const want = overlayWanted();
  if (want === overlayShown) return;
  overlayShown = want;
  if (want) {
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  } else win.hide();
}

function setOverlayOn(on) {
  settings.overlayOn = !!on;
  saveSettings();
  updateOverlay();
  rebuildMenu();
}

// ---------- Between the pages and the overlay ----------

const send = (name, channel, data) => {
  const win = wins[name];
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};
const sender = (e, name) => !!wins[name] && !wins[name].isDestroyed() && e.sender === wins[name].webContents;
const fromPage = (e, name) => sender(e, name) && !!e.senderFrame && pageOf(e.senderFrame.url) === PAGES[name];

function gameInfo() {
  return { running: game.running, title: game.title, window: game.hwnd || 0, adminBlock: game.running && adminBlocks(game.admin), log: logPath ? { path: logPath, name: path.basename(logPath), there: !!statOf(logPath) } : null };
}
function pushGame() {
  const g = gameInfo();
  send('follow', 'game', g);
  send('overlay', 'game', g);
}

let siteUpdate = false;
let appUpdate = '';
let shellExtra = { offline: '' };
let agreed = null; // whether the player agreed on follow.html, once it says
function pushShell(patch) {
  if (patch) Object.assign(shellExtra, patch);
  send('overlay', 'shell', Object.assign({
    collapsed: settings.collapsed,
    riot,
    runOver,
    agreed,
    siteUpdate,
    appUpdate,
    hotkeys: HOTKEYS,
    screenShare: settings.screenShare ? settings.screenShare.on : null,
    local: /^(localhost|127\.0\.0\.1)$/.test(SITE_URL.hostname),
    version: app.getVersion(),
  }, shellExtra));
}

let lastAdvice = null;
let lastFollow = null;
const small = (data) => {
  try {
    return JSON.stringify(data).length < 50000;
  } catch (e) {
    return false;
  }
};

// #region consent
// The agreement on follow.html belongs to the app: given once, a copy of
// the page from another address (the local test site) or a new install
// doesn't ask again, while the page's agreement version is the same. Turning
// it off on the page clears it here too.
ipcMain.handle('consent:get', (e) => (fromPage(e, 'follow') ? settings.consent : null));
ipcMain.on('consent:set', (e, value) => {
  if (!fromPage(e, 'follow')) return;
  const at = value && typeof value.at === 'string' ? value.at.slice(0, 40) : new Date().toISOString();
  const next = value && value.withdrawn === true ? { withdrawn: true, at }
    : value && Number.isInteger(value.version) && value.version > 0 ? { version: value.version, at } : null;
  if (JSON.stringify(next) === JSON.stringify(settings.consent)) return;
  settings.consent = next;
  // The screen fallback was allowed under this agreement: it goes with it.
  if (!next || next.withdrawn) settings.screenShare = null;
  saveSettings();
  note(!next ? 'agreement cleared' : next.withdrawn ? 'agreement withdrawn: off for the app' : `agreement remembered for the app (version ${next.version})`);
});

// An agreement given on the live site before the app remembered agreements:
// read once from that page, so the test copy doesn't ask again.
async function adoptLiveAgreement() {
  if (settings.consent || SITE === LIVE_SITE) return;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL(`${LIVE_SITE}follow.html`);
    const found = await win.webContents.executeJavaScript(`(() => {
      try {
        const s = JSON.parse(localStorage.getItem('tartarus-sim:auto:v1') || 'null');
        const v = window.TartarusCapture && window.TartarusCapture.CONSENT_VERSION;
        return s && s.enabled === true && s.consent === v ? { version: v, at: s.consentAt || null } : null;
      } catch (e) {
        return null;
      }
    })()`);
    if (found) {
      settings.consent = found;
      saveSettings();
      note(`agreement carried over from the live site (version ${found.version})`);
    } else note('no agreement on the live site to carry over');
  } catch (e) {
    note('could not read the agreement on the live site:', String((e && e.message) || e)); // offline: the page asks
  } finally {
    win.destroy();
  }
}

// #endregion
ipcMain.handle('game:get', (e) => (sender(e, 'follow') || sender(e, 'overlay') ? gameInfo() : null));

// #region read-log
// The log, for follow.html only: its size, and the bytes it asks for.
ipcMain.handle('log:stat', async (e) => {
  if (!fromPage(e, 'follow') || !logPath) return null;
  try {
    const st = await fs.promises.stat(logPath);
    return st.isFile() ? { name: path.basename(logPath), size: st.size } : null;
  } catch (err) {
    return null;
  }
});
// A log dropped on follow.html (its path, from the app) or chosen in the
// app's own file window: the app reads it, wherever it is.
ipcMain.on('log:use', async (e, file) => {
  if (!fromPage(e, 'follow') || typeof file !== 'string' || !/\.log$/i.test(file)) return;
  const st = statOf(file);
  if (!st || !st.isFile()) return;
  settings.logPath = file;
  saveSettings();
  note('log chosen by the player:', file);
  await refreshLog();
});
ipcMain.on('log:pick', (e) => {
  if (fromPage(e, 'follow')) pickLog();
});

ipcMain.handle('log:read', async (e, start, end) => {
  if (!fromPage(e, 'follow') || !logPath) throw new Error('No log.');
  const from = Math.max(0, Math.floor(Number(start) || 0));
  const length = Math.min(Math.max(0, Math.floor(Number(end) || 0) - from), 4 * 1024 * 1024);
  const fh = await fs.promises.open(logPath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, from);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
});

// #endregion
// What follow.html is doing, and the analyzer's advice, for the overlay.
ipcMain.on('site:follow', (e, data) => {
  if (!fromPage(e, 'follow') || !data || !small(data)) return;
  const was = lastFollow || {};
  lastFollow = data;
  const shareError = data.diag && data.diag.shareError;
  if (shareError && shareError !== (was.diag && was.diag.shareError)) note('window share failed on the page:', shareError);
  if (data.log !== was.log || data.window !== was.window || data.agreed !== was.agreed) note(`follow: agreed=${data.agreed} log=${data.log}${data.error ? ` (${data.error})` : ''} window=${data.window}`);
  const f = data.lastFrame;
  if (f && (!was.lastFrame || f.at !== was.lastFrame.at)) note(`picture: ${f.kind}${f.ok ? '' : ` (none taken: ${f.why})`}`);
  if (typeof data.agreed === 'boolean' && data.agreed !== agreed) {
    agreed = data.agreed;
    // Before anything runs, the player reads follow.html and agrees there.
    if (!agreed && (!TEST || OFFSCREEN)) show('follow');
    pushShell();
  }
  send('overlay', 'follow', data);
});
// The Riot folds the overlay until the fight is over, unless the player
// had it folded already; it unfolds only what it folded, and a fold or
// unfold by the player during the fight is theirs.
let riot = false;
let riotFolded = false;
ipcMain.on('site:riot', (e, on) => {
  if (!fromPage(e, 'follow') || !!on === riot) return;
  riot = !!on;
  note(riot ? 'Riot: the fight is on' : 'back in the prison');
  // The box over the game waits for a picture of the screen now.
  highlightClicked();
  recordEvent({ type: riot ? 'riot' : 'riot-over' });
  if (riot && !settings.collapsed) {
    settings.collapsed = true;
    riotFolded = true;
  } else if (!riot && riotFolded) {
    settings.collapsed = false;
    riotFolded = false;
  }
  pushShell();
  if (!riot) reloadIfWaiting('back in the prison');
});

// Ignore on the Riot screen ends the run: its record is closed (the next
// picture starts a new run's folder), the analyzer clears its board (which
// also ends its shared run), and the overlay says the run is over until the
// next one begins.
let runOver = false;
ipcMain.on('site:run', (e, what) => {
  if (!fromPage(e, 'follow')) return;
  if (what === 'over' && !runOver) {
    runOver = true;
    highlightClicked();
    note('run over: its record is closed, the analyzer cleared');
    recordEvent({ type: 'run-over' });
    recording = null;
    send('analyzer', 'command', 'run-over');
    pushShell();
    reloadIfWaiting('the run is over');
  } else if (what === 'new' && runOver) {
    runOver = false;
    pushShell();
  }
});

// Each trigger the log matched (its kind), and once a minute while the game
// runs, how Auto Screenshot Mode is doing in numbers: for the debug log,
// to find out why pictures don't come. Never the game log's lines.
ipcMain.on('site:trigger', (e, kind) => {
  if (!fromPage(e, 'follow')) return;
  note('trigger:', String(kind));
  // The screen is changing: the box shown may be on what was just clicked.
  highlightClicked();
});
// A button clicked in the prison (the log's click line; its fact only):
// the box goes at once, door cards and the fight's start included.
ipcMain.on('site:click', (e) => {
  if (fromPage(e, 'follow')) highlightClicked();
});
let checked = null; // the counts at the last minute's note
// A count since the last note; one smaller than then started over (a new
// game log after a restart, or a reloaded page), so it all counts.
const since = (now, then) => ((now || 0) >= then ? (now || 0) - then : now || 0);
let minutes = 0;
setInterval(async () => {
  minutes += 1;
  if (game.running || minutes % 10 === 0) note(`use: ${usageText(usage('minute'), await coresNow())}`);
  const f = lastFollow;
  if (!f || !game.running) return;
  const d = f.diag || {};
  const was = checked || { lines: 0, hits: 0, frames: 0, failed: 0 };
  const still = d.growingAt ? Math.round((Date.now() - d.growingAt) / 1000) : null;
  note(`check: log=${f.log} window=${f.window}${f.windowSize ? ` (${f.windowSize})` : ''} game log detail=${f.detail || '?'}; log file ${d.logSize || '?'} bytes, ${still === null ? 'not measured' : still < 15 ? 'growing' : `unchanged for ${still} s`}; this minute: ${since(f.lines, was.lines)} lines read, ${since(f.hits, was.hits)} triggers, ${since(f.frames, was.frames)} pictures, ${since(d.failed, was.failed)} failed${d.lastNote ? `; last picture: ${d.lastNote}` : ''}`);
  checked = { lines: f.lines || 0, hits: f.hits || 0, frames: f.frames || 0, failed: d.failed || 0 };
}, 60000);

// A report of how the app is doing, for a player to send when something
// doesn't work: it opens the analyzer's Report form, filled in, and is also
// copied to the clipboard. Paths under the player's own folder are shortened
// to %USERPROFILE%. It holds no picture and no game log line.
// What the game log holds, for finding why no trigger matches (the
// standalone client, reports 345, 346, 361 and 362): its text encoding,
// and in its last 4 MB how many lines name the prison's season (S16) and
// which season tags appear (S16, S17...), as counts. No line of the log is
// kept or reported (the user, 2026-10-18).
function logCheck() {
  if (!logPath) return 'no log';
  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 3));
    fs.readSync(fd, head, 0, head.length, 0);
    let n = Math.min(size, 4 * 1024 * 1024);
    let buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    let nul = 0;
    for (let i = 0; i < Math.min(n, 65536); i++) if (buf[i] === 0) nul += 1;
    const utf16 = (head[0] === 0xff && head[1] === 0xfe) || nul > Math.min(n, 65536) / 5;
    // UTF-16 starts each character on an even byte.
    if (utf16 && (size - n) % 2) buf = buf.subarray(1);
    const text = buf.toString(utf16 ? 'utf16le' : 'utf8');
    const lines = text.split('\n');
    const s16 = lines.filter((l) => l.includes('S16')).length;
    const tags = {};
    for (const m of text.matchAll(/(?<![A-Za-z0-9])S(\d{1,2})(?=[A-Z][a-z])|_S(\d{1,2})_/g)) {
      const k = `S${m[1] || m[2]}`;
      tags[k] = (tags[k] || 0) + 1;
    }
    const top = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none';
    const kind = utf16 ? 'UTF-16' : head[0] === 0xef && head[1] === 0xbb ? 'UTF-8 (BOM)' : 'UTF-8';
    return `${kind}; last ${(n / 1048576).toFixed(1)} MB: ${lines.length} lines, ${s16} with "S16"; season tags: ${top}`;
  } catch (e) {
    return `can't be read (${e.code || e.message})`;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function debugReportText(cores) {
  const home = require('os').homedir();
  const clean = (t) => String(t || '').split(home).join('%USERPROFILE%');
  const f = lastFollow || {};
  const d = f.diag || {};
  const a = lastAdvice || {};
  const ago = (t) => (t ? `${Math.round((Date.now() - t) / 1000)} s ago` : 'never');
  const lines = [
    `Tartarus Overlay ${app.getVersion()}${BIG_RECORD ? ' (debug)' : ''}, site ${SITE}, Windows ${require('os').release()}`,
    `Game: ${game.running ? `running (${game.title}); ${adminText(game.admin)}` : 'not running'}; log file (${logFoundBy}): ${clean(logPath) || 'not found'}`,
    `Agreed: ${agreed}; log: ${f.log}${f.error ? ` (${clean(f.error)})` : ''}; window: ${f.window}${f.windowSize ? ` ${f.windowSize}` : ''}${f.shared === 'screen' ? ' (the game’s screen, cut to the game window)' : ''}; screen fallback: ${settings.screenShare ? (settings.screenShare.on ? 'allowed' : 'declined') : 'not asked'}; game log detail (Enable Log): ${f.detail || 'not known yet'}`,
    `Log file: ${d.logSize || '?'} bytes, last grew ${ago(d.growingAt)}. Since connecting: ${f.lines || 0} lines read, ${f.hits || 0} triggers ${JSON.stringify(d.triggers || {})}, ${f.frames || 0} pictures, ${d.failed || 0} failed.`,
    `Log check: ${logCheck()}`,
    `Last window share error: ${d.shareError ? `${clean(d.shareError)} (${ago(d.shareErrorAt)})` : 'none'}`,
    `Last trigger: ${d.lastTriggerKind || 'none'} ${ago(d.lastTriggerAt)}. Last picture: ${f.lastFrame ? `${f.lastFrame.kind} ${ago(f.lastFrame.at)}${f.lastFrame.ok ? '' : ` (none taken: ${f.lastFrame.why})`}` : 'none'}; on the page: ${d.lastNote || '-'}`,
    `Analyzer: ${a.lastRead ? `last read ${ago(a.lastRead.at)}, ${a.lastRead.ok ? 'ok' : `failed: ${a.lastRead.reason}`}` : 'nothing read'}; advice: ${a.move || (a.working ? 'working' : 'none')}`,
    `Processor use: ${cpuUse().label}, ${cpuUse().workers} of ${CORES}; game first: ${settings.gameFirst ? 'on' : 'off'}. Use: ${usageText(usage('report'), cores)}`,
    'Recent debug log:',
  ];
  try {
    const tail = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-30).map((l) => clean(l).replace(/^\d{4}-\d\d-\d\dT/, ''));
    lines.push(...tail);
  } catch (e) {
    lines.push('(none)');
  }
  return lines.join('\n');
}
async function debugReport() {
  const text = debugReportText(await coresNow());
  try {
    require('electron').clipboard.writeText(text);
  } catch (e) {
    // The form still has it.
  }
  note('debug report opened');
  show('analyzer');
  send('analyzer', 'debug-report', { name: `Desktop debug report ${app.getVersion()}`, text: text.slice(0, 2000), outcome: 'Pictures don’t come, or something else isn’t working. (Say what you saw.)' });
}

ipcMain.on('site:advice', (e, data) => {
  if (!fromPage(e, 'analyzer') || !data || !small(data)) return;
  const was = lastAdvice || {};
  const r = data.lastRead;
  if (r && (!was.lastRead || r.at !== was.lastRead.at)) {
    const what = r.pick ? `instrument offer: ${r.names.join(', ')}` : r.objective ? `objective: ${r.name}` : r.treasure ? "Warden's Treasure" : `day ${r.day}`;
    note(`read: ${r.ok ? what + (r.unsure ? `, ${r.unsure} to check` : '') : `failed (${r.reason})`}`);
  }
  const sum = (a) => (a.problems && a.problems.length ? `board problem: ${a.problems[0]}` : a.working ? 'working' : a.stale ? 'board changed' : a.move ? `advice: ${a.move}` : a.nothing ? 'nothing to decide' : '');
  if (sum(data) !== sum(was) && sum(data) && sum(data) !== 'working') note(sum(data));
  if (data.toolsConfirm && data.toolsConfirm !== was.toolsConfirm) note('instruments to confirm:', data.toolsConfirm);
  lastAdvice = data;
  send('overlay', 'advice', data);
});

// The overlay's buttons.
ipcMain.on('overlay:command', (e, cmd) => {
  if (sender(e, 'overlay')) command(cmd);
});
ipcMain.on('site:record', (e, entry, bytes) => {
  if (!fromPage(e, 'analyzer') || !entry || typeof entry !== 'object' || typeof entry.type !== 'string') return;
  addRecord(entry, bytes);
});
ipcMain.handle('record:sessions', (e) => (sender(e, 'review') ? listSessions() : []));
ipcMain.handle('record:load', (e, name) => (sender(e, 'review') ? loadSession(name) : null));
ipcMain.on('record:folder', (e) => {
  if (sender(e, 'review')) shell.openPath(RECORDS);
});

ipcMain.on('overlay:size', (e, height) => {
  if (!sender(e, 'overlay')) return;
  const b = wins.overlay.getBounds();
  const h = Math.max(36, Math.min(900, Math.ceil(Number(height) || 0)));
  if (h !== b.height) wins.overlay.setBounds({ x: b.x, y: b.y, width: settings.overlayWidth, height: h });
});

function command(cmd) {
  note('command:', cmd);
  recordEvent({ type: 'command', cmd: String(cmd) });
  switch (cmd) {
    case 'board': return toggle('analyzer');
    case 'follow': return show('follow');
    case 'capture':
      // Auto Screenshot Mode is off: its page, to turn it on (report 380).
      if (agreed === false) return show('follow');
      return send('follow', 'command', 'capture');
    case 'fix':
      show('analyzer');
      return send('analyzer', 'command', 'fix');
    case 'recheck':
    case 'tools-ok':
    case 'treasure-now':
      return send('analyzer', 'command', cmd);
    case 'debug-report': return debugReport();
    case 'enable-log':
      // The Auto Screenshot Mode page's box on turning on the game's log.
      show('follow');
      if (wins.follow) wins.follow.webContents.executeJavaScript("(() => { const box = document.getElementById('follow-enable-log'); if (box) box.scrollIntoView({ block: 'start' }); return true; })()").catch(() => {});
      return undefined;
    case 'report':
    case 'report-new':
      show('analyzer');
      return send('analyzer', 'command', cmd);
    case 'hide':
      setOverlayOn(false);
      if (tray && !TEST) tray.displayBalloon({ title: 'Overlay hidden', content: `Press ${HOTKEYS.overlay.replace(/Control/, 'Ctrl')} to show it again, or use the tray icon.`, iconType: 'info' });
      return undefined;
    case 'collapse':
      riotFolded = false;
      settings.collapsed = !settings.collapsed;
      saveSettings();
      return pushShell();
    case 'review': return showReview();
    case 'pick-log': return pickLog();
    case 'screen-yes':
    case 'screen-no':
      return setScreenShare(cmd === 'screen-yes');
    case 'reload': return reloadSite();
    case 'restart': return updater && updater.quitAndInstall();
    default: return undefined;
  }
}

// #region highlight
// What to click, boxed over the game (the user, 2026-10-24): a see-through
// window the size of the game window that lets every click through to the
// game, kept out of captures as the overlay is, and shown only while the
// game is in front and the advice is for the board just read. The box comes
// from the analyzer in the picture's pixels; the picture is the game window,
// so it scales to the window's place on the screen.
let testHighlight = false; // --test: shown whatever is in front
let highlightShown = '';
// After a click in the game the box is put away until a picture taken after
// it has been read and advised on, so it never stays on the card just
// clicked or comes back over another screen (the user: it stayed too long,
// and after the fight began).
let highlightGone = 0; // the last click's time
let highlightWant = { key: '', since: 0 }; // the box asked for, since when
let highlightOn = ''; // the box drawn now
const HIGHLIGHT_HOLD_MS = 300;
function highlightClicked() {
  highlightGone = Date.now();
  updateHighlight();
}
function makeHighlight() {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'lib', 'highlight-preload.js'), sandbox: true, contextIsolation: true },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  // A box sent before the page is ready would be lost: sent again once it is.
  win.webContents.on('did-finish-load', () => {
    highlightShown = '';
  });
  win.loadFile(path.join(__dirname, 'lib', 'highlight.html'));
  wins.highlight = win;
  return win;
}
function updateHighlight() {
  const win = wins.highlight;
  if (!win || win.isDestroyed()) return;
  let hl = lastAdvice && lastAdvice.highlight;
  // Only from a picture taken after the last click in the game or screen
  // change (hl.at, when the picture was taken), and not during the Riot or
  // once the run is over.
  if (hl && (!(hl.at > highlightGone) || riot || runOver)) hl = null;
  // A box not drawn yet waits while a newer picture is being read (its
  // advice may be for the screen before: the user saw the box on the first
  // card, then moved), and until it has held for a moment, so it's drawn
  // where it ends up (the user, 2026-10-25). One already drawn stays.
  const want = hl && hl.box ? JSON.stringify([hl.box, hl.label]) : '';
  if (want !== highlightWant.key) highlightWant = { key: want, since: Date.now() };
  if (want && want !== highlightOn && ((lastAdvice && lastAdvice.reading) || Date.now() - highlightWant.since < HIGHLIGHT_HOLD_MS)) hl = null;
  const r = settings.highlight && hl && hl.box && game.running && game.hwnd && win32 ? win32.frame(game.hwnd) : null;
  const front = r && (testHighlight || (win32.foreground() === game.hwnd && !win32.minimized(game.hwnd)));
  if (!front) {
    if (highlightShown) {
      win.hide();
      highlightShown = '';
    }
    highlightOn = '';
    return;
  }
  highlightOn = want;
  const at = screen.screenToDipRect(null, r);
  const k = at.width / hl.w;
  const box = { x: Math.round(hl.box[0] * k), y: Math.round(hl.box[1] * (at.height / hl.h)), w: Math.round((hl.box[2] - hl.box[0]) * k), h: Math.round((hl.box[3] - hl.box[1]) * (at.height / hl.h)) };
  const key = JSON.stringify([at, box]);
  if (key === highlightShown) return;
  highlightShown = key;
  win.setBounds({ x: Math.round(at.x), y: Math.round(at.y), width: Math.round(at.width), height: Math.round(at.height) });
  win.webContents.send('box', { box, label: hl.label || '' });
  if (!win.isVisible()) {
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  }
}

// #endregion
// #region share-game
// Only follow.html may share a window, and the only window it gets is the
// game's, found by its title. Another window never is. A whole screen is
// shared only when Windows won't share the game window and the player said
// yes to it in the overlay: then it's the screen the game is on, and
// js/capture.js cuts every picture to the game window (gameCrop below)
// and takes none while another window is in front.
let testUnlisted = false; // --test: as if the capture's list left the game out
let testShareFail = false; // --test: as if Windows wouldn't share the game window
let screenNext = false; // follow.html asked for the screen on its next share
const screenAllowed = () => !!(settings.screenShare && settings.screenShare.on === true && agreed);
function setScreenShare(on) {
  settings.screenShare = { on: !!on, at: new Date().toISOString() };
  saveSettings();
  note(on ? 'screen share allowed: the screen the game is on, cut to the game window, when Windows won’t share the window' : 'screen share declined');
  pushShell();
  rebuildMenu();
  send('follow', 'command', 'share-again');
}
// The screen the game window is on (most of it), and both in screen pixels.
function gameScreen() {
  const r = game.running && game.hwnd && win32 ? win32.frame(game.hwnd) : null;
  if (!r) return null;
  const display = screen.getDisplayMatching(screen.screenToDipRect(null, r));
  return { r, display, s: screen.dipToScreenRect(null, display.bounds) };
}
// Where the game window is on its screen, and whether it's in front: the
// crop for every picture of a shared screen (follow.html only).
ipcMain.handle('game:crop', (e) => {
  if (!fromPage(e, 'follow') || !screenAllowed()) return null;
  const g = gameScreen();
  if (!g) return null;
  // In front: the game's window, another of the game's own windows, or one
  // of this app's that doesn't cover the game (report 362: the picture was
  // asked for from the app).
  const fg = win32.foreground();
  const own = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).some((w) => Number(w.getNativeWindowHandle().readBigUInt64LE(0)) === fg);
  const covers = (a, b) => !!a && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const front = !win32.minimized(game.hwnd) && (fg === game.hwnd || win32.pidOf(fg) === win32.pidOf(game.hwnd) || (own && !covers(win32.frame(fg), g.r)));
  return { x: g.r.x - g.s.x, y: g.r.y - g.s.y, width: g.r.width, height: g.r.height, screenWidth: g.s.width, screenHeight: g.s.height, front };
});
ipcMain.handle('share:screen-ok', (e) => (fromPage(e, 'follow') ? { allowed: screenAllowed(), asked: !!settings.screenShare } : null));
ipcMain.on('share:screen', (e, on) => {
  if (fromPage(e, 'follow')) screenNext = !!on && screenAllowed();
});
function allowCapture() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const wc = wins.follow && !wins.follow.isDestroyed() ? wins.follow.webContents : null;
    let mine = !!wc && !!request.frame && pageOf(request.frame.url) === PAGES.follow;
    if (mine && typeof webContents.fromFrame === 'function') mine = webContents.fromFrame(request.frame) === wc;
    if (!mine) {
      note('window share refused: not asked by follow.html');
      return callback({});
    }
    const wantScreen = screenNext && screenAllowed();
    screenNext = false;
    if (wantScreen) {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const g = gameScreen();
          const s = g ? sources.find((x) => String(x.display_id) === String(g.display.id)) : null;
          note(s ? `screen share: the screen the game is on (${g.s.width}×${g.s.height}), every picture cut to the game window` : 'screen share refused: the game’s screen wasn’t found');
          callback(s ? { video: s } : {});
        })
        .catch((e) => {
          note('screen share failed:', String((e && e.message) || e));
          callback({});
        });
      return undefined;
    }
    if (testShareFail && game.running) {
      // A window Windows won't hand over (the test's stand-in for "Could
      // not start video source").
      note('window share: (test) a window that won’t start');
      return callback({ video: { id: 'window:1:0', name: game.title } });
    }
    desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
      .then((sources) => {
        // The game's window by its handle, then by its title (a launcher
        // can share the title, reports 371 and 372).
        let s = testUnlisted ? null : sources.find((x) => game.hwnd && x.id.startsWith(`window:${game.hwnd}:`)) || sources.find((x) => GAME_TITLE.test(x.name));
        if (s) note(`window share: "${s.name.trim()}"`);
        else if (game.running && game.hwnd) {
          // Windows has the game's window, but the capture's list left it out
          // (reports 175 and 180): it's asked for by its handle.
          s = { id: `window:${game.hwnd}:0`, name: game.title };
          note(`window share: "${game.title}" by its handle, not in the capture's list of ${sources.length} windows (window ${win32 ? win32.stateOf(game.hwnd) : 'state unknown'})`);
        } else note('window share refused: no game window');
        callback(s ? { video: s } : {});
      })
      .catch((e) => {
        note('window share failed:', String((e && e.message) || e));
        callback({});
      });
  });
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);
  const ok = (url) => !!pageOf(url || '');
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(allowed.has(permission) && ok(details.requestingUrl || wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => allowed.has(permission) && origin === SITE_URL.origin);
}

// #endregion
// ---------- Keeping up with the site ----------

// The site's pages carry an asset tag (?v=) that changes with every update.
// A newer one is loaded at once while the game isn't running; during a run
// the overlay offers to reload.
async function pageTag() {
  try {
    return await wins.analyzer.webContents.executeJavaScript('(() => { const s = [...document.querySelectorAll("script[src]")].map((x) => x.src).find((x) => /[?&]v=/.test(x)); return s ? new URL(s).searchParams.get("v") : null; })()');
  } catch (e) {
    return null;
  }
}
async function checkSite() {
  try {
    const res = await net.fetch(SITE + PAGES.analyzer, { cache: 'no-store' });
    const m = /[?&]v=([\w.-]+)/.exec(await res.text());
    const mine = await pageTag();
    if (!m || !mine || m[1] === mine) return;
    note(`site updated: ${mine} -> ${m[1]}${game.running ? ' (offering a reload)' : ' (reloading)'}`);
    if (!game.running) reloadSite();
    else if (!siteUpdate) {
      siteUpdate = true;
      pushShell();
    }
  } catch (e) {
    // Offline: next time.
  }
}
// A site update that came during play waits for a safe moment: a run's end
// (Ignore on the Riot screen), or the prison after the Riot's fight. Not the
// Riot screen itself, where a reload could miss the Fight or Ignore click.
// Players left an update unloaded for hours, its fixes with it.
function reloadIfWaiting(why) {
  if (!siteUpdate) return;
  note(`site update loaded (${why})`);
  // A moment later: the analyzer clears its board at a run's end first.
  setTimeout(() => siteUpdate && reloadSite(), 3000);
}
function reloadSite() {
  siteUpdate = false;
  for (const name of Object.keys(PAGES)) {
    const win = wins[name];
    if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
  }
  pushShell();
}

// The app itself updates from the GitHub releases, when it's installed.
let updater = null;
function startUpdater() {
  if (!app.isPackaged || TEST) return;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (e) {
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-downloaded', (info) => {
    note('app update downloaded:', info.version);
    appUpdate = info.version;
    pushShell();
    rebuildMenu();
  });
  updater.on('error', (e) => note('app update check failed:', String((e && e.message) || e).slice(0, 300)));
  const check = () => updater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 3600 * 1000);
}

// ---------- Tray and hotkeys ----------

const keyName = (k) => k.replace('Control', 'Ctrl');

function rebuildMenu() {
  if (!tray) return;
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setToolTip(`Tartarus Overlay${game.running ? '' : ': waiting for Torchlight: Infinite'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: game.running ? 'Torchlight: Infinite is running' : 'Waiting for Torchlight: Infinite', enabled: false },
    { label: logPath ? `Log: ${logPath}` : 'Log: not found', enabled: false },
    { type: 'separator' },
    { label: 'Show the overlay', type: 'checkbox', checked: settings.overlayOn, accelerator: HOTKEYS.overlay, click: (i) => setOverlayOn(i.checked) },
    { label: 'Hide it while another window is in front', type: 'checkbox', checked: settings.hideBehind, enabled: !!win32, click: (i) => { settings.hideBehind = i.checked; saveSettings(); updateOverlay(); } },
    { label: 'Highlight what to click', type: 'checkbox', checked: settings.highlight, enabled: !!win32, click: (i) => { settings.highlight = i.checked; saveSettings(); updateHighlight(); } },
    { label: 'Share the game’s screen when Windows won’t share its window', type: 'checkbox', checked: screenAllowed(), enabled: agreed && !!win32, click: (i) => setScreenShare(i.checked) },
    { label: 'Hide it from screenshots and streams', type: 'checkbox', checked: settings.hideFromCaptures, click: (i) => { settings.hideFromCaptures = i.checked; saveSettings(); if (wins.overlay) wins.overlay.setContentProtection(i.checked); } },
    { label: 'Put the overlay back in the corner', click: () => { settings.overlay = null; overlayPlaced = false; saveSettings(); placeOverlay(); } },
    { type: 'separator' },
    { label: 'Board analyzer', accelerator: HOTKEYS.analyzer, click: () => show('analyzer') },
    { label: 'Take a picture now', accelerator: HOTKEYS.capture, click: () => command('capture') },
    { label: 'Auto Screenshot Mode (status and agreement)', click: () => show('follow') },
    { label: 'Choose the game log…', click: () => pickLog() },
    {
      label: 'Game language',
      submenu: GAME_LANGS.map(([code, label]) => ({ label, type: 'radio', checked: gameLang === code, click: () => setGameLang(code) })),
    },
    {
      label: 'Processor use',
      submenu: [
        ...Object.entries(CPU_USE).map(([key, c]) => ({ label: `${c.label} (${c.workers} of ${CORES})`, type: 'radio', checked: cpuUse() === c, click: () => setCpu(key) })),
        { type: 'separator' },
        { label: 'Let the game go first (lower priority)', type: 'checkbox', checked: settings.gameFirst, click: (i) => setGameFirst(i.checked) },
      ],
    },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: login, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: siteUpdate ? 'Reload the site (an update is ready)' : 'Reload the site', click: () => reloadSite() },
    appUpdate ? { label: `Restart to update the app (${appUpdate})`, click: () => command('restart') } : { label: `Version ${app.getVersion()}${DEV ? ' (debug)' : ''}`, enabled: false },
    { label: 'Record every board and advice (testing)', type: 'checkbox', checked: settings.record, click: (i) => { settings.record = i.checked; saveSettings(); } },
    { label: `Review the record… (${BIG_RECORD ? `${Math.round(recordBytes / 1048576)} MB of ${Math.round(recordLimit() / 1048576)} MB` : `the last ${keepRuns()} runs`})`, click: () => showReview() },
    { label: 'Send a debug report…', click: () => debugReport() },
    { label: 'Open the debug log', click: () => shell.openPath(LOG_FILE) },
    ...(DEV ? [{
      label: 'Developer tools',
      submenu: [['follow', 'Auto Screenshot Mode page'], ['analyzer', 'Board analyzer'], ['overlay', 'Overlay']].map(([name, label]) => ({
        label,
        click: () => wins[name] && wins[name].webContents.openDevTools({ mode: 'detach' }),
      })),
    }] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function makeTray() {
  let image = nativeImage.createFromPath(ICON);
  if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.on('click', () => toggle('analyzer'));
  rebuildMenu();
}

function registerHotkeys() {
  if (TEST) return;
  const actions = {
    overlay: () => setOverlayOn(!settings.overlayOn),
    analyzer: () => toggle('analyzer'),
    capture: () => command('capture'),
  };
  for (const [name, key] of Object.entries(HOTKEYS)) {
    try {
      if (!globalShortcut.register(key, actions[name])) note(`hotkey ${key} is taken by another program: use the tray menu`);
    } catch (e) {
      // Taken by another program: the tray menu still works.
    }
  }
}

// ---------- Start ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => show('analyzer'));
  app.on('window-all-closed', () => {
    // The app lives in the tray.
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  // Tests give the app commands in a file in its user data folder (the main
  // process gets no input on Windows). "quit" stops it as the tray's Quit
  // does, so the pages' storage is written out.
  if (TEST) {
    const COMMANDS = path.join(app.getPath('userData'), 'test-commands.txt');
    setInterval(() => {
      let text = '';
      try {
        text = fs.readFileSync(COMMANDS, 'utf8');
        fs.rmSync(COMMANDS);
      } catch (e) {
        return;
      }
      if (/quit/.test(text)) {
        quitting = true;
        app.quit();
      }
      // "hide follow": as the player closes that window with its X.
      // "site-update": as if the site had a newer version than the pages.
      if (/site-update/.test(text)) {
        siteUpdate = true;
        pushShell();
      }
      const hide = /hide (\w+)/.exec(text);
      if (hide && wins[hide[1]] && !wins[hide[1]].isDestroyed()) wins[hide[1]].hide();
      // "admin-game": as if the game ran as administrator (and this app not).
      if (/admin-game/.test(text)) {
        game.admin = { game: true, by: null };
        pushGame();
      }
      // "unlisted": the capture's list leaves the game window out.
      if (/unlisted/.test(text)) testUnlisted = true;
      // "highlight-any": the box shown whatever window is in front.
      if (/highlight-any/.test(text)) testHighlight = true;
      // "share-fail": Windows won't share the game window.
      if (/share-fail/.test(text)) testShareFail = true;
      // "cpu one": as the tray's Processor use does.
      const cpu = /cpu (\w+)/.exec(text);
      if (cpu) setCpu(cpu[1]);
    }, 300);
  }

  app.whenReady().then(async () => {
    note(`start: version ${app.getVersion()}, site ${SITE}${DEV ? ', debug' : ''}${TEST ? ', test' : ''}, foreground check ${win32 ? 'on' : 'off'}, as administrator: ${yesNo(win32 ? win32.selfElevated() : null)}`);
    allowCapture();
    pruneRecords();
    await refreshLog();
    await adoptLiveAgreement();
    makeOverlay();
    makeHighlight();
    makeSiteWindow('follow', { width: 1000, height: 860, title: 'Auto Screenshot Mode · Tartarus Overlay' });
    makeAnalyzer();
    makeTray();
    registerHotkeys();
    lookForGame();
    setInterval(updateOverlay, 250);
    setInterval(updateHighlight, 250);
    setInterval(checkSite, 10 * 60 * 1000);
    startUpdater();
    if (!TEST && !game.running) {
      tray.displayBalloon({ title: 'Tartarus Overlay is running', content: 'The advice shows over Torchlight: Infinite while you play. The tray icon has the board analyzer and settings.', iconType: 'info' });
    }
    if (TEST) console.log(`[overlay] ready site=${SITE} log=${logPath} win32=${!!win32}`);
  });
}

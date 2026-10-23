# Tartarus Overlay (desktop app, local only for now)

Auto Screenshot Mode as a Windows app, with the board analyzer's advice in a small
always-on-top card over the game, so one monitor is enough.

## How it's built

The app is a thin Electron shell around the **live website**. It loads
`follow.html` and `analyze.html` from the site, unchanged, so every fix to the
site reaches the app the next time those pages load. What the shell adds:

| Piece | What it does |
|---|---|
| `main.js` | Finds `UE_game.log` (Steam's libraries via the registry and `libraryfolders.vdf`, app 1974050; the launcher's default folder; or one the player chose). Finds the game window by its title (`Torchlight: Infinite`), and answers follow.html's window share with that window only, with no picker. Shows the overlay while the game is in front. Tray menu, hotkeys, site and app updates. |
| `preload.js` | `window.TartarusDesktop` for the two site pages. The shell checks which page asks: only follow.html can read the log. |
| `lib/follow-adapter.js` | Put into follow.html. Hands the log to `TartarusCapture.useHandle` and calls `TartarusCapture.connectWindow()` while the game runs, after the player has agreed on that page. The triggers, the agreement and the checks are the site's own code. |
| `lib/analyzer-adapter.js` | Put into analyze.html. Copies the results panel's text to the overlay, and presses the analyzer's buttons for the overlay's (Fix, Recheck, Report). |
| `lib/overlay.*` | The card over the game. |

Pictures and the log never leave the PC. Boards and reports are shared exactly
as on the website, by the website's code (a local `--site` never shares boards).

**The site contract:** the analyzer adapter reads analyze.html's results panel
by its ids and a few phrases (listed at the top of `lib/analyzer-adapter.js`).
If those change on the site, update the adapter too, or the overlay goes quiet.

## Run it

```
npm install            # once
npm start              # against the live site
npm run local          # against http://localhost:8090/ (node tools/serve.js --port 8090)
```

VS Code's terminal sets `ELECTRON_RUN_AS_NODE=1`; unset it first if Electron
says it can't find the module `electron`.

Hotkeys: Ctrl+Alt+O show/hide the overlay · Ctrl+Alt+A board analyzer ·
Ctrl+Alt+P take a picture now. The card's "–" folds it to a thin bar, and
the Riot's fight folds it by itself.

Run the game **borderless or windowed**: nothing can draw over exclusive
fullscreen, and a shared window there looks black.

**Processor and memory.** The tray's Processor use sets how many workers the
analyzer's live check may use: every core but one, half (the default), a
quarter, or one. The site pages run below normal priority, so the game gets
the processor first (tray: "Let the game go first"). The workers are let go
a minute after the last check, and their memory with them. The game window
is found through Windows' own window list (about 2 ms a look), not the
capture's list (about 0.3 s of processor time a look). Once a minute while
the game runs, and every 10 minutes otherwise, the debug log notes the app's
memory and processor use (`use:`); the debug report carries it too.

**Linux** (KDE Plasma under Wayland, the game under Proton). `main.js` runs
Electron on X11 (XWayland), where the game's window is listed by its title.
`XDG_SESSION_TYPE=x11` must also be set before Electron starts: `main.js`
sets it too late for the hotkeys, and Plasma then asks the player to approve
them (Global Shortcuts Requested) at each start. A launcher in
`~/.local/bin/tartarus-overlay` (`chmod +x`, path to this folder adjusted):

```
#!/bin/sh
cd "$HOME/tartarus-simulator/desktop" || exit 1
unset ELECTRON_RUN_AS_NODE
export XDG_SESSION_TYPE=x11
exec ./node_modules/electron/dist/electron . "$@"
```

and, for the app menu, `~/.local/share/applications/tartarus-overlay.desktop`
(a .desktop file doesn't expand `~` or `$HOME`: write the full paths):

```
[Desktop Entry]
Type=Application
Name=Tartarus Overlay
Comment=Torchlight: Infinite board analyzer overlay
Exec=/home/<you>/.local/bin/tartarus-overlay
Icon=/home/<you>/tartarus-simulator/desktop/build/icon.png
Categories=Game;
```

Under `--test`, the app takes commands from `test-commands.txt` in its user
data folder (`quit`, `hide <window>`, `cpu <most|half|quarter|one>`):
Electron's main process gets no stdin on Windows.

## Updates

- **Site changes** (reader, advice, triggers, rules, reports): automatic. The
  pages load from the site; every 10 minutes the shell compares the site's
  asset tag (`?v=`) with the loaded one, reloads at once while the game isn't
  running, and during play offers a Reload button on the overlay and reloads
  by itself at the next safe moment: a run's end (Ignore on the Riot screen)
  or back in the prison after the Riot's fight, 3 s later so the analyzer
  clears its board first. Players otherwise kept an old page for hours. Under
  `--test`, `site-update` in test-commands.txt acts as a newer site.
- **App changes** (this folder): `electron-updater` checks GitHub Releases of
  blahdot3h/tartarus-simulator every 6 hours, downloads in the background and
  installs on quit (the overlay offers Restart). Unsigned builds show
  SmartScreen's "Windows protected your PC" on first install.

To publish a version:
1. Bump `version` in package.json (and package-lock.json), commit, push.
2. Tag it and push the tag: `git tag -a vX.Y.Z -m "Tartarus Overlay X.Y.Z"`,
   `git push origin vX.Y.Z`. GitHub refuses a release without its tag.
3. Create the release first, with its notes:
   `gh release create vX.Y.Z --title "Tartarus Overlay X.Y.Z" --notes-file notes.md`.
   Left to electron-builder, it can create the release twice at once and
   lose files (0.2.1 did).
4. `GH_TOKEN=$(gh auth token) npm run release` builds and uploads the
   installer, its blockmap and latest.yml into it. Check all three are there
   (`gh release view vX.Y.Z`): installed copies read latest.yml.

## Build

`npm run dist` makes `dist/Tartarus-Overlay-Setup-<version>.exe` (per-user
install, no admin).

## Test

The scratch test (`desktop-test/run.mjs` in the session scratchpad) runs the
whole loop without the real game: a stand-in window titled "Tartarus Test Game"
off-screen showing a board screenshot, a fake log, `--game-title`, `--log`,
`--user-data` and `--remote-debugging-port`, driven over the DevTools protocol.

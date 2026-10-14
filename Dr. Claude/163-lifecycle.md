# Brief 163 — Main-process lifecycle: one instance, survive renderer death

**Repo:** JakeTunesV3 · **Patch:** `patches/brief-163-lifecycle.patch` · **Branch:** `fix/brief-163-lifecycle` (base: chain-B patch #1's branch — the index.ts patches stack; see README)

## Problem (audit Lens 1, findings 4 and 5)

(a) No single-instance lock existed anywhere — two launches
produced two audible players racing the same state writes.
(b) `render-process-gone` was unhandled in the main process, so a
renderer death that isn't a JS error (OOM kill, GPU process loss)
escaped CrashNet entirely — CrashNet runs IN the renderer.

## What the patch does (index.ts only, +36 lines)

- **(a)** Immediately after the flight recorder's boot lines (the
  earliest code that runs after imports): 
  `app.requestSingleInstanceLock()`; on failure `app.quit()`; on
  success a `second-instance` handler that restores (if minimized)
  and focuses the existing window.
- **(b)** In `createWindow`, after the window-open deny handler:
  `webContents.on('render-process-gone')` logs through the
  CrashNet channel — the flight recorder, with the same
  `renderer.*` event naming the renderer's `reportCrash` IPC feeds
  (`renderer.render-process-gone`, with reason + exitCode) — then
  reloads the window at most once per 60 s guard window
  (`lastRendererGoneReloadMs` beside the `mainWindow` declaration).
  Further deaths inside the window are logged
  (`renderer.render-process-gone.reload-skipped`) and left alone,
  so a poisoned page can't reload-loop the app.
- The reload lands the renderer in Brief 162's restored-paused
  state, not silence (when 162 is in).

Note: after a failed lock, `app.quit()` is issued immediately;
module evaluation continuing to register handlers before the quit
lands is the standard Electron pattern and harmless (no window is
ever created — `whenReady` work exits with the app).

## Tests

No unit seam exists for app-lifecycle wiring (it is Electron-main
glue by nature); verification is: patch applies in chain order,
final index.ts parses (`node --check`, same as pristine) with
brace/paren balance identical to pristine. Live check after
install: launch the app twice — the second launch must focus the
first window and exit; kill the renderer process (`taskkill` /
Activity Monitor on the helper) — main.log must show
`renderer.render-process-gone` and the window must reload once.
CI (`npm run check`) is the gate — merge only on green CI.

## Rails

index.ts +36 for this patch. No new silent catches, no raw
`ipcMain.handle` (none added at all).

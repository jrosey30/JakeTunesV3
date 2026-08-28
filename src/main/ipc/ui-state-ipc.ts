/**
 * UI-state persistence IPC (load / save ui-state.json).
 *
 * Extracted from main/index.ts so new UI-state channels don't land in
 * the mega-file. Behavior preserved: corrupt-file salvage, serialized
 * deep-merge writes, unique tmp staging names.
 */
import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { loadPins, savePins, normalizePins, pinsPath } from '../playlist-pins.ts'

function uiStatePath(): string {
  return join(app.getPath('userData'), 'ui-state.json')
}

let uiStateWriteChain: Promise<unknown> = Promise.resolve()

async function saveUiStateSerialized(uiState: Record<string, unknown>): Promise<{ ok: boolean }> {
  // Bug #3: this used to be a full-overwrite write. Callers all do a
  // load-spread-save pattern in the renderer, but when `loadUiState`
  // returned null/empty (transient parse failure during atomic rename,
  // file briefly missing, etc.) they'd spread `{}` and the resulting
  // save would clobber every persisted field that wasn't in the caller's
  // partial. That's how `optConvertBitrate` evaporated mid-session —
  // some caller saved its 7 fields, the convert toggle wasn't one of
  // them, so it disappeared.
  //
  // Defense-in-depth: read current disk state, deep-merge the incoming
  // partial on top, then atomically write. Even if every renderer
  // caller is buggy, persisted fields survive.
  const path = uiStatePath()
  try {
    let current: Record<string, unknown> = {}
    try {
      const raw = await readFile(path, 'utf-8')
      current = JSON.parse(raw) as Record<string, unknown>
      if (typeof current !== 'object' || current === null) current = {}
    } catch { /* no file yet or parse fail — start fresh */ }
    const merged = { ...current, ...uiState }
    // UNIQUE tmp name, and every save serialized on uiStateWriteChain.
    //
    // The tmp path used to be the fixed `path + '.partial.json'`, so two saves
    // in flight at once both wrote THAT file. Interleave a shorter payload over
    // a longer one and the tail of the long write survives past the end of the
    // short one — then rename() atomically installs the garbage. That is
    // exactly what was on disk on 2026-08-02: a valid 656-char object with 22
    // trailing bytes of an older write. JSON.parse threw on every launch, the
    // app silently fell back to defaults, and Jake's bpm/camelotKey columns
    // disappeared every restart even though they were correctly persisted.
    //
    // Atomic rename only protects readers from a HALF-WRITTEN file; it does
    // nothing when two writers share the staging file. JsonFileCache already
    // gets this right (pid + time + random) — same idiom here.
    const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`
    await writeFile(tmp, JSON.stringify(merged), 'utf-8')
    const { rename: renameFS } = await import('fs/promises')
    await renameFS(tmp, path)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

export function registerUiStateIpc(ipc: IpcRegistrar): void {
  ipc.handle('load-ui-state', async () => {
    const path = uiStatePath()
    let data: string
    try {
      data = await readFile(path, 'utf-8')
    } catch {
      return { ok: false, state: null }   // no file yet — first run
    }
    try {
      return { ok: true, state: JSON.parse(data) }
    } catch (err) {
      // A corrupt ui-state used to fail SILENTLY here: every launch fell back to
      // defaults, so Jake's Songs columns (bpm + camelotKey are in columnOrder
      // and not hidden) vanished on every restart and it read as the column
      // feature being broken. Found 2026-08-02 with 22 trailing bytes of an
      // older, longer write stuck on the end — see the save handler.
      //
      // Salvage the leading object if there is one: the real state is usually
      // intact and only the tail is garbage, so this restores the user's layout
      // instead of resetting it. Keep the bad file for diagnosis either way.
      console.warn('[ui-state] unparseable —', err instanceof Error ? err.message : err)
      let recovered: unknown = null
      for (let end = data.length; end > 1; end--) {
        if (data[end - 1] !== '}') continue
        try { recovered = JSON.parse(data.slice(0, end)); break } catch { /* keep shrinking */ }
      }
      try {
        const { rename: renameFS } = await import('fs/promises')
        await renameFS(path, `${path}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      if (recovered && typeof recovered === 'object') {
        console.warn('[ui-state] recovered the leading object — layout preserved')
        return { ok: true, state: recovered as Record<string, unknown> }
      }
      return { ok: false, state: null }
    }
  }, { public: true })

  // Mutating — main window only.
  ipc.handle('save-ui-state', async (_e, uiState: Record<string, unknown>) => {
    const run = uiStateWriteChain.then(() => saveUiStateSerialized(uiState), () => saveUiStateSerialized(uiState))
    uiStateWriteChain = run.catch(() => {})
    return run
  }, { refuse: REFUSED_SENDER })

  // Sidebar pins (2026-08-28) — moved OUT of per-machine ui-state into their
  // own synced sidecar so "same pins" holds across machines (the workmini
  // harvest exchanges it, newest updatedAt wins). Legacy migration: a machine
  // with no pins file yet serves its old ui-state pinnedPlaylists with an
  // EMPTY stamp, so the first real save anywhere outranks every legacy copy.
  ipc.handle('load-playlist-pins', async () => {
    const file = pinsPath(app.getPath('userData'))
    const pins = await loadPins(file)
    if (pins) return { ok: true, pins }
    try {
      const legacy = JSON.parse(await readFile(uiStatePath(), 'utf-8')) as Record<string, unknown>
      const migrated = normalizePins({ pinnedPlaylists: legacy['pinnedPlaylists'], updatedAt: '' })
      if (migrated) return { ok: true, pins: migrated }
    } catch { /* no legacy state either — first run */ }
    return { ok: true, pins: null }
  }, { public: true })

  ipc.handle('save-playlist-pins', async (_e, pinnedPlaylists: unknown) => {
    const pins = normalizePins({ pinnedPlaylists, updatedAt: new Date().toISOString() })
    if (!pins) return { ok: false, error: 'bad-shape' }
    await savePins(pins, pinsPath(app.getPath('userData')))
    return { ok: true }
  }, { refuse: REFUSED_SENDER })
}

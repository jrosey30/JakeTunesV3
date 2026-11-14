/**
 * One parse of a big JSON file for everyone who asks at once (2026-11-14).
 *
 * The 2026-11-13 crash was 186 reads of the 14 MB library.json in flight
 * together (tag-writeback-queue.ts). Three other places in index.ts had the
 * same shape: each caller that found the file's date had moved read and
 * parsed the whole file for itself, so N callers arriving together after a
 * save cost N copies.
 *
 * Here a file is read and parsed once per date it has had: callers that
 * arrive while that read is running wait for it, and callers that arrive
 * after get the parsed value until the file's date moves. The value is let
 * go `holdMs` after it was last asked for, so the app doesn't keep a second
 * whole library in memory between bursts.
 *
 * What comes back is shared: read it, don't change it.
 *
 * Electron-free; every effect is injected (__tests__/shared-json-read.test.ts).
 */
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'

export interface SharedJsonReadDeps {
  path: () => string
  stat?: (path: string) => Promise<{ mtimeMs: number }>
  readFile?: (path: string) => Promise<string>
  /** How long the parsed value is kept after the last ask. */
  holdMs?: number
}

export const SHARED_JSON_HOLD_MS = 30_000

export function createSharedJsonRead<T>(deps: SharedJsonReadDeps): {
  /** The parsed file and the date it was read at. Rejects as a read or a parse would. */
  read: () => Promise<{ value: T; mtimeMs: number }>
  /** How many times the file was read and parsed (tests, diagnostics). */
  parses: () => number
} {
  const stat = deps.stat ?? fsStat
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf-8'))
  const holdMs = deps.holdMs ?? SHARED_JSON_HOLD_MS
  let held: { mtimeMs: number; value: T } | null = null
  let running: { mtimeMs: number; promise: Promise<{ value: T; mtimeMs: number }> } | null = null
  let letGo: ReturnType<typeof setTimeout> | null = null
  let parses = 0

  const keep = (): void => {
    if (letGo) clearTimeout(letGo)
    letGo = setTimeout(() => { held = null; letGo = null }, holdMs)
    letGo.unref?.()
  }

  return {
    async read() {
      const path = deps.path()
      const { mtimeMs } = await stat(path)
      if (held && held.mtimeMs === mtimeMs) { keep(); return { value: held.value, mtimeMs } }
      if (running && running.mtimeMs === mtimeMs) return running.promise
      const mine: { mtimeMs: number; promise: Promise<{ value: T; mtimeMs: number }> } = { mtimeMs, promise: null as never }
      mine.promise = (async () => {
        try {
          parses++
          const value = JSON.parse(await readFile(path)) as T
          held = { mtimeMs, value }
          keep()
          return { value, mtimeMs }
        } finally {
          if (running === mine) running = null
        }
      })()
      running = mine
      return mine.promise
    },
    parses: () => parses,
  }
}

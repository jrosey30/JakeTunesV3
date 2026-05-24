// Music Man's Record Store — disk cache (Brief 037 §7)
//
// Persists ShelfBundles and Blurbs under the JakeTunes user data dir.
// Stays Electron-decoupled: callers pass in the base dir (from
// app.getPath('userData')).
//
// Layout under <baseDir>/record-store/:
//   shelves/<YYYY-MM-DD>.json    one ShelfBundle per local calendar date
//   blurbs/<persona>/<key>.json  per-item, per-persona, cached forever
//   day-themes/history.json      rolling 21-day theme log (cooldown)
//
// Reliability:
//   - Atomic writes (write to <file>.tmp.<rand>, rename). The codebase
//     already uses this pattern for library.json / overrides.
//   - Single-flight per file via an in-memory write-promise map. Two
//     concurrent writes to the same path serialize.
//   - Defensive read. Corrupt JSON (truncated by a crash mid-write) is
//     caught, the file is deleted, the caller gets null and regenerates.

import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'fs/promises'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import type { ShelfBundle, Blurb, Persona } from './types'

const SUB_SHELVES = 'shelves'
const SUB_BLURBS = 'blurbs'
const SUB_THEMES = 'day-themes'

/** Slug a blurb item id into a safe filename (max one disk hop). */
function blurbFilename(itemId: string): string {
  return itemId.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json'
}

/** Single-flight write map. Keyed by absolute path. */
const writeInflight = new Map<string, Promise<void>>()

async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  const prior = writeInflight.get(filePath)
  if (prior) {
    // Chain after the prior write so we never have two renames racing
    // on the same destination path.
    await prior.catch(() => {})
  }
  const op = (async () => {
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp.${randomBytes(4).toString('hex')}`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    await rename(tmp, filePath)
  })()
  writeInflight.set(filePath, op)
  try {
    await op
  } finally {
    if (writeInflight.get(filePath) === op) writeInflight.delete(filePath)
  }
}

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return null
    // Anything else (truncated JSON, EISDIR, etc.) → unlink + null so
    // the caller regenerates instead of crashing.
    console.warn(`[record-store/cache] corrupt or unreadable ${filePath}; removing:`, err)
    await unlink(filePath).catch(() => {})
    return null
  }
}

// ── Shelf-bundle cache ───────────────────────────────────────────────

export class RecordStoreCache {
  private baseDir: string

  constructor(userDataDir: string) {
    this.baseDir = join(userDataDir, 'record-store')
  }

  private shelvesPath(dateISO: string): string {
    return join(this.baseDir, SUB_SHELVES, `${dateISO}.json`)
  }

  private blurbPath(persona: Persona, itemId: string): string {
    return join(this.baseDir, SUB_BLURBS, persona, blurbFilename(itemId))
  }

  private themeHistoryPath(): string {
    return join(this.baseDir, SUB_THEMES, 'history.json')
  }

  /** Returns today's bundle if valid (validUntil > now), else null. */
  async getShelfBundle(dateISO: string): Promise<ShelfBundle | null> {
    const bundle = await readJsonOrNull<ShelfBundle>(this.shelvesPath(dateISO))
    if (!bundle) return null
    if (typeof bundle.validUntil !== 'number' || bundle.validUntil < Date.now()) {
      return null
    }
    return bundle
  }

  /** Last-resort fallback: load today's bundle even if expired, or the
   *  most recent bundle if none for today. For "served from yesterday"
   *  when LLM is unreachable. */
  async getStaleShelfBundle(dateISO: string): Promise<ShelfBundle | null> {
    const today = await readJsonOrNull<ShelfBundle>(this.shelvesPath(dateISO))
    if (today) return today
    // Walk recent dates backwards. We only keep 21 days, so 30 is a
    // safe upper bound.
    const d = new Date(`${dateISO}T00:00:00`)
    for (let i = 1; i < 30; i++) {
      d.setDate(d.getDate() - 1)
      const iso = d.toISOString().slice(0, 10)
      const found = await readJsonOrNull<ShelfBundle>(this.shelvesPath(iso))
      if (found) return found
    }
    return null
  }

  async putShelfBundle(bundle: ShelfBundle): Promise<void> {
    await atomicWriteJson(this.shelvesPath(bundle.date), bundle)
  }

  async getBlurb(persona: Persona, itemId: string): Promise<Blurb | null> {
    return readJsonOrNull<Blurb>(this.blurbPath(persona, itemId))
  }

  async putBlurb(blurb: Blurb): Promise<void> {
    await atomicWriteJson(this.blurbPath(blurb.persona, blurb.itemId), blurb)
  }

  /** Rolling theme history, last 21 days. Used by the day-theme
   *  generator to avoid repeats (Brief §3.4 cooldown). */
  async getThemeHistory(): Promise<Array<{ date: string; theme: string }>> {
    const arr = await readJsonOrNull<Array<{ date: string; theme: string }>>(this.themeHistoryPath())
    return arr ?? []
  }

  async appendThemeHistory(entry: { date: string; theme: string }): Promise<void> {
    const existing = await this.getThemeHistory()
    // Insert at front, dedupe by date, cap to last 21 entries.
    const next = [entry, ...existing.filter((e) => e.date !== entry.date)].slice(0, 21)
    await atomicWriteJson(this.themeHistoryPath(), next)
  }

  /** Walk back through cached shelf bundles for the last N days and
   *  return the union of every ShelfItem id that appeared. Used by the
   *  candidate-pool builder for the recency penalty (Brief §3.4). */
  async getRecentlyPickedIds(todayISO: string, daysBack: number): Promise<Set<string>> {
    const out = new Set<string>()
    const d = new Date(`${todayISO}T00:00:00`)
    for (let i = 0; i < daysBack; i++) {
      const iso = d.toISOString().slice(0, 10)
      const bundle = await readJsonOrNull<ShelfBundle>(this.shelvesPath(iso))
      if (bundle) {
        for (const shelf of bundle.shelves) {
          for (const item of shelf.items) out.add(item.id)
        }
      }
      d.setDate(d.getDate() - 1)
    }
    return out
  }

  /** Best-effort cleanup of shelf bundles older than 21 days. Called
   *  occasionally so the cache dir doesn't grow forever. Never throws. */
  async pruneOldShelves(): Promise<void> {
    try {
      const dir = join(this.baseDir, SUB_SHELVES)
      const entries = await readdir(dir).catch(() => [])
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - 21)
      const cutoffISO = cutoff.toISOString().slice(0, 10)
      for (const name of entries) {
        const m = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)
        if (m && m[1] < cutoffISO) {
          await unlink(join(dir, name)).catch(() => {})
        }
      }
    } catch (err) {
      console.warn('[record-store/cache] pruneOldShelves swallowed error:', err)
    }
  }
}

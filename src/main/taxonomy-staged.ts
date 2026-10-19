/**
 * Subgenre hand-off (2026-10-19, the taste-engine repairs).
 *
 * The nightly classifier (scripts/taxonomy-classify.py) could only write
 * metadata-overrides.json while JakeTunes was QUIT: the app keeps that file
 * in memory (overridesCache) and rewrites it whole on its next edit, so an
 * outside write would be erased. The app is open around the clock, so from
 * 2026-09-06 to 2026-10-19 104 of 110 nights deferred and 1,220 songs waited
 * for a subgenre.
 *
 * Now the classifier hands its work to the app instead: when the app is
 * running it writes `taxonomy-staged.json` beside the overrides, and this
 * module (90 s after launch, then every 5 minutes) folds it in through the
 * app's own serialized override writer — the file keeps exactly one writer,
 * and nothing waits for a quit.
 *
 * The merge is ADDITIVE and identical to the script's direct-write path:
 * a song that already has a subgenre is never touched; every other field
 * and each entry's accepted fp survive; only a brand-new entry gets a fp,
 * computed from the live library row.
 *   ⚠️ TWIN: scripts/taxonomy-classify.py merge_staged — same rules.
 */
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const STAGED_FILE = 'taxonomy-staged.json'
export const DEFERRED_FILE = 'taxonomy-deferred.json'
export const APPLIED_STATUS_FILE = 'taxonomy-applied.json'

export interface StagedSubgenre { subgenre: string; subgenrePath?: string; subgenreLean?: string }
export interface StagedFile { version: 1; at: string; entries: Record<string, StagedSubgenre> }
type OverrideEntry = { fp?: string; fields?: Record<string, string> }
type Overrides = Record<string, unknown>

/** The staged file, or null when it is missing a field we rely on. */
export function parseStaged(raw: string): StagedFile | null {
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (!v || typeof v !== 'object') return null
  const o = v as { version?: unknown; at?: unknown; entries?: unknown }
  if (o.version !== 1 || typeof o.at !== 'string' || !o.entries || typeof o.entries !== 'object' || Array.isArray(o.entries)) return null
  const entries: Record<string, StagedSubgenre> = {}
  for (const [id, e] of Object.entries(o.entries as Record<string, unknown>)) {
    const s = e as Partial<StagedSubgenre> | null
    if (!/^\d+$/.test(id) || !s || typeof s.subgenre !== 'string' || !s.subgenre.trim()) continue
    entries[id] = {
      subgenre: s.subgenre,
      ...(typeof s.subgenrePath === 'string' && s.subgenrePath ? { subgenrePath: s.subgenrePath } : {}),
      ...(typeof s.subgenreLean === 'string' && s.subgenreLean ? { subgenreLean: s.subgenreLean } : {}),
    }
  }
  return { version: 1, at: o.at, entries }
}

/** Remove a file that may already be gone; any other failure is reported. */
async function removeIfPresent(path: string, log: (m: string) => void): Promise<void> {
  try { await unlink(path) } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log(`[taxonomy-staged] could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const hasSubgenre = (e: unknown): boolean =>
  !!(e && typeof e === 'object' && ((e as OverrideEntry).fields || {}).subgenre)

export interface MergeResult {
  applied: Array<{ trackId: number; fields: Record<string, string> }>
  alreadyFiled: number
  notInLibrary: number
}

/**
 * Fold staged subgenres into `overrides` IN PLACE (call it inside the
 * serialized writer's mutate, on the cache as it is at write time).
 * `fingerprint(id)` returns the live library row's fp, or null when the
 * song has left the library (its staged entry is dropped).
 */
export function mergeStagedSubgenres(
  overrides: Overrides,
  entries: Record<string, StagedSubgenre>,
  fingerprint: (trackId: number) => string | null,
): MergeResult {
  const out: MergeResult = { applied: [], alreadyFiled: 0, notInLibrary: 0 }
  for (const [id, s] of Object.entries(entries)) {
    const fp = fingerprint(Number(id))
    if (fp === null) { out.notInLibrary++; continue }
    const existing = overrides[id]
    if (hasSubgenre(existing)) { out.alreadyFiled++; continue }
    const e = (existing && typeof existing === 'object' ? existing : {}) as OverrideEntry
    const added: Record<string, string> = { subgenre: s.subgenre, subgenrePath: s.subgenrePath || s.subgenre }
    if (s.subgenreLean) added.subgenreLean = s.subgenreLean
    overrides[id] = { fp: e.fp || fp, fields: { ...(e.fields || {}), ...added } }
    out.applied.push({ trackId: Number(id), fields: added })
  }
  return out
}

export interface TaxonomyStagedHost {
  stateDir: string
  /** Live library rows (id, title, artist, duration) for the fp. */
  libraryTracks(): Promise<Array<{ id: number; title?: string; artist?: string; duration?: number }>>
  /** The app's serialized override writer (overridesCache.update). */
  updateOverrides(mutate: (current: Overrides) => Overrides): Promise<void>
  /** Wait until the overrides cache has hit disk. */
  flushOverrides(): Promise<void>
  /** The cache's failure counters — a write dropped by its safety lock or a
   *  failed flush means the staged file must stay for the next pass. */
  overrideFlushStats(): { flushFailures: number; droppedWrites: number }
  /** Mirror applied fields into the renderer + kick the NAS sync. */
  onApplied(updates: Array<{ trackId: number; field: string; newValue: string }>): void
  fingerprint(t: { title?: string; artist?: string; duration?: number }): string
  log(msg: string): void
}

/**
 * One pass: claim the staged file (rename, so a classifier run that lands a
 * NEW file meanwhile is never deleted unread), merge, flush, then drop the
 * claim and the deferred marker and leave a status line. On any failure the
 * claimed file is put back so the next pass retries.
 */
export async function applyStagedOnce(host: TaxonomyStagedHost): Promise<MergeResult | null> {
  const staged = join(host.stateDir, STAGED_FILE)
  const claimed = `${staged}.applying`
  try { await rename(staged, claimed) } catch { return null }   // nothing staged
  try {
    const parsed = parseStaged(await readFile(claimed, 'utf8'))
    if (!parsed) throw new Error('staged file unreadable')
    const fps = new Map<number, string>()
    for (const t of await host.libraryTracks()) fps.set(t.id, host.fingerprint(t))
    let result: MergeResult = { applied: [], alreadyFiled: 0, notInLibrary: 0 }
    const before = host.overrideFlushStats()
    await host.updateOverrides((current) => {
      result = mergeStagedSubgenres(current, parsed.entries, (id) => fps.get(id) ?? null)
      return current
    })
    await host.flushOverrides()
    const after = host.overrideFlushStats()
    if (after.droppedWrites > before.droppedWrites || after.flushFailures > before.flushFailures) {
      throw new Error('the overrides write did not reach disk')
    }
    await removeIfPresent(claimed, host.log)
    await removeIfPresent(join(host.stateDir, DEFERRED_FILE), host.log)
    const status = { at: new Date().toISOString(), stagedAt: parsed.at, applied: result.applied.length, alreadyFiled: result.alreadyFiled, notInLibrary: result.notInLibrary }
    const statusPath = join(host.stateDir, APPLIED_STATUS_FILE)
    await writeFile(`${statusPath}.tmp`, JSON.stringify(status, null, 2))
    await rename(`${statusPath}.tmp`, statusPath)
    if (result.applied.length) {
      host.onApplied(result.applied.flatMap((a) =>
        Object.entries(a.fields).map(([field, newValue]) => ({ trackId: a.trackId, field, newValue }))))
    }
    host.log(`[taxonomy-staged] applied ${result.applied.length} subgenre(s) (already filed ${result.alreadyFiled}, left library ${result.notInLibrary})`)
    return result
  } catch (err) {
    // Put the claim back unless a newer staged file already took its place.
    try {
      if (await readFile(staged).then(() => true, () => false)) await removeIfPresent(claimed, host.log)
      else await rename(claimed, staged)
    } catch (restoreErr) {
      host.log(`[taxonomy-staged] could not restore the hand-off: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`)
    }
    host.log(`[taxonomy-staged] apply failed, will retry: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

const FIRST_PASS_MS = 90_000
const PASS_MS = 5 * 60_000

export function startTaxonomyStagedApply(host: TaxonomyStagedHost): void {
  let running = false
  const pass = async (): Promise<void> => {
    if (running) return
    running = true
    try { await applyStagedOnce(host) } finally { running = false }
  }
  setTimeout(() => { void pass(); setInterval(() => { void pass() }, PASS_MS) }, FIRST_PASS_MS)
}

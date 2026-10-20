/**
 * The other Macs' taste copies (2026-10-20): what the sync script pulled into
 * userData/taste-elsewhere/<source>/ — the hub's copies on a replica
 * ("hub"), each replica's copies on the hub (its name). READ-ONLY here: this
 * Mac never writes them, and never copies their rows into its own files.
 * The merge rules are src/common/taste-shared.ts.
 *
 * Each file is parsed once per change (size + mtime). A copy that does not
 * parse (it never should: rsync renames into place) keeps the last good
 * parse rather than dropping that Mac's verdicts.
 *
 * Electron-free: the directory is passed in, so tests run it on a temp dir.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { TASTE_ELSEWHERE_DIR, type SharedLedgerRow } from '../common/taste-shared.ts'

/** Source folders under userData/taste-elsewhere/, sorted. [] when none. */
export async function elsewhereSources(userData: string): Promise<string[]> {
  try {
    const dirents = await readdir(join(userData, TASTE_ELSEWHERE_DIR), { withFileTypes: true })
    return dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort()
  } catch {
    return []
  }
}

const parsed = new Map<string, { size: number; mtime: number; value: unknown }>()

async function parseOnce<T>(path: string, parse: (raw: string) => T): Promise<T | null> {
  const st = await stat(path).catch(() => null)
  const hit = parsed.get(path)
  if (!st) return null
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.value as T
  try {
    const value = parse(await readFile(path, 'utf-8'))
    parsed.set(path, { size: st.size, mtime: st.mtimeMs, value })
    return value
  } catch {
    return hit ? (hit.value as T) : null
  }
}

/** One JSON file from every source that has it. */
export async function elsewhereJson(userData: string, file: string): Promise<Array<{ source: string; doc: unknown }>> {
  const out: Array<{ source: string; doc: unknown }> = []
  for (const source of await elsewhereSources(userData)) {
    const doc = await parseOnce(join(userData, TASTE_ELSEWHERE_DIR, source, file), (raw) => JSON.parse(raw) as unknown)
    if (doc && typeof doc === 'object') out.push({ source, doc })
  }
  return out
}

function parseLedger(raw: string): SharedLedgerRow[] {
  const rows: SharedLedgerRow[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line) as SharedLedgerRow
      if (r && typeof r === 'object') rows.push(r)
    } catch { /* a torn last line is skipped, as in the local reader */ }
  }
  return rows
}

/** Every other Mac's ledger rows, each marked with its source. One array
 *  per source; the arrays are cached, so callers can memo on identity. */
export async function elsewhereLedgerRows(userData: string, file = 'taste-ledger.jsonl'): Promise<SharedLedgerRow[][]> {
  const out: SharedLedgerRow[][] = []
  for (const source of await elsewhereSources(userData)) {
    const rows = await parseOnce(join(userData, TASTE_ELSEWHERE_DIR, source, file), (raw) => parseLedger(raw).map((r) => ({ ...r, elsewhere: source })))
    if (rows && rows.length) out.push(rows)
  }
  return out
}

/**
 * Taste-ledger file IO (2026-08-22). Extracted when the index line-ratchet
 * caught the SAME six-line jsonl parse living twice in index.ts (the
 * learned-summary handler and the feed generator). discovery-learned.ts is
 * chartered pure-and-fs-free, so the file half lives here.
 */
import { readFile } from 'fs/promises'
import type { LedgerRow } from './discovery-learned.ts'

/** Every parseable row; [] when the ledger doesn't exist yet. */
export async function readLedgerRows(path: string): Promise<LedgerRow[]> {
  try {
    const raw = await readFile(path, 'utf-8')
    return raw.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) as LedgerRow } catch { return null }
    }).filter((r): r is LedgerRow => !!r)
  } catch {
    return []
  }
}

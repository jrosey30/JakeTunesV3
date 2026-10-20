/**
 * Taste-ledger file IO (2026-08-22). Extracted when the index line-ratchet
 * caught the SAME six-line jsonl parse living twice in index.ts (the
 * learned-summary handler and the feed generator). discovery-learned.ts is
 * chartered pure-and-fs-free, so the file half lives here.
 */
import { readFile } from 'fs/promises'
import { dirname } from 'path'
import type { LedgerRow } from './discovery-learned.ts'
import { elsewhereLedgerRows } from './taste-elsewhere.ts'
import { unionLedgerRows } from '../common/taste-shared.ts'

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

/**
 * This Mac's rows plus the other Macs' (2026-10-20): the copies the sync
 * script pulled into <ledger dir>/taste-elsewhere/<source>/taste-ledger.jsonl.
 * Each verdict once, ordered by time — so Discovery's "latest verdict wins"
 * and the learned summary hear both Macs. Read-only: nothing is written.
 */
export async function readSharedLedgerRows(path: string): Promise<LedgerRow[]> {
  const [local, elsewhere] = await Promise.all([readLedgerRows(path), elsewhereLedgerRows(dirname(path))])
  return unionLedgerRows(local, elsewhere as LedgerRow[][])
}

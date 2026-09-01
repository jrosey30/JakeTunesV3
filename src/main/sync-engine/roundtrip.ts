/**
 * roundtrip — THE 6.0 STORY. Read back what the iPod experienced.
 *
 * The Mini's firmware records listening in `Play Counts` (one positional
 * entry per catalog record: plays since the last iTunesDB write, last-played
 * mac-time) and queued intent in `OTGPlaylistInfo` (positional indexes).
 * Until now the sync engine retired these unread — every offline listen
 * evaporated. This module ingests them at PLUG-IN time, before any sync
 * touches the card, and hands the deltas to the renderer to apply through
 * the normal save flow. Offline listening is involuntary honesty — the
 * purest taste signal there is.
 *
 * DELIBERATELY A SIBLING of the frozen engine pipeline: zero edits to
 * ipod-activity-engine.ts. Reads only; the card is never written.
 *
 * Double-count safety: `Play Counts` is CUMULATIVE per catalog generation
 * (firmware appends until the next sync rewrites iTunesDB). State keyed by
 * the on-card catalog's sha1 tracks what was already ingested per track and
 * ingests only the delta; a new sync (new generation) resets the ledger.
 * The identical snapshot re-ingests nothing.
 *
 * Track mapping: catalog record order → path mhod → last-sync-manifest
 * destPath → library id. Identity-based (the manifest is written by the
 * sealing sync), never text-guessing.
 */

import { createHash } from 'crypto'
import { join } from 'path'
import { readFile, writeFile, rename } from 'fs/promises'

const MAC_EPOCH_OFFSET_S = 2082844800 // 1904-01-01 → 1970-01-01

export interface RoundTripHost {
  stateDir: string
  getLibraryTracks: () => Promise<Array<{ id: number; playCount?: number; lastPlayedAt?: number }>>
  appendPlayEvents: (trackId: number, count: number, tsMs: number) => Promise<void>
  sendToRenderer: (channel: string, ...args: unknown[]) => void
  isSyncInFlight: () => boolean
}

export interface PlayCountEntry { plays: number; lastPlayedMs: number }

/** Parse the firmware's `Play Counts` file. Tolerant: unknown magic → null. */
export function parsePlayCounts(buf: Buffer): PlayCountEntry[] | null {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'mhdp') return null
  const headerLen = buf.readUInt32LE(4)
  const entryLen = buf.readUInt32LE(8)
  const n = buf.readUInt32LE(12)
  if (headerLen < 16 || entryLen < 8 || n < 0 || n > 100000) return null
  const out: PlayCountEntry[] = []
  for (let i = 0; i < n; i++) {
    const p = headerLen + i * entryLen
    if (p + 8 > buf.length) break
    const plays = buf.readUInt32LE(p)
    const mac = buf.readUInt32LE(p + 4)
    out.push({ plays, lastPlayedMs: mac > MAC_EPOCH_OFFSET_S ? (mac - MAC_EPOCH_OFFSET_S) * 1000 : 0 })
  }
  return out
}

/** Parse one `OTGPlaylistInfo` file → positional catalog indexes. */
export function parseOtgIndexes(buf: Buffer): number[] {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'mhpo') return []
  const headerLen = buf.readUInt32LE(4)
  const n = buf.readUInt32LE(16)
  if (headerLen < 20 || n < 0 || n > 100000) return []
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const p = headerLen + i * 4
    if (p + 4 > buf.length) break
    out.push(buf.readUInt32LE(p))
  }
  return out
}

/** Walk the on-card iTunesDB: colon path per mhit, in record order. */
export function parseCatalogPaths(buf: Buffer): string[] | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'mhbd') return null
  let pos = buf.readUInt32LE(4)
  let sec1: number | null = null
  while (pos < buf.length - 16 && buf.toString('latin1', pos, pos + 4) === 'mhsd') {
    const stl = buf.readUInt32LE(pos + 8)
    if (buf.readUInt32LE(pos + 12) === 1) sec1 = pos
    if (stl <= 0) return null
    pos += stl
  }
  if (sec1 === null) return null
  const mhlt = sec1 + buf.readUInt32LE(sec1 + 4)
  if (buf.toString('latin1', mhlt, mhlt + 4) !== 'mhlt') return null
  const n = buf.readUInt32LE(mhlt + 8)
  const paths: string[] = []
  let p = mhlt + buf.readUInt32LE(mhlt + 4)
  for (let i = 0; i < n; i++) {
    if (buf.toString('latin1', p, p + 4) !== 'mhit') return null
    const tl = buf.readUInt32LE(p + 8)
    const hl = buf.readUInt32LE(p + 4)
    const nm = buf.readUInt32LE(p + 12)
    let path = ''
    let mp = p + hl
    for (let m = 0; m < nm; m++) {
      const mtl = buf.readUInt32LE(mp + 8)
      if (buf.readUInt32LE(mp + 12) === 2) {
        const slen = buf.readUInt32LE(mp + 0x1c)
        path = buf.toString('utf16le', mp + 0x28, mp + 0x28 + slen)
      }
      mp += mtl
    }
    paths.push(path)
    p += tl
  }
  return paths
}

interface RoundTripState {
  generation: string
  snapshot: string
  ingested: Record<string, number>
}

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex')

let inFlight = false

export async function ingestIpodRoundTrip(mount: string, host: RoundTripHost): Promise<void> {
  if (inFlight || host.isSyncInFlight()) return
  inFlight = true
  try {
    const itunesDir = join(mount, 'iPod_Control', 'iTunes')
    const pcBuf = await readFile(join(itunesDir, 'Play Counts')).catch(() => null)
    const otgBufs: Buffer[] = []
    for (const name of ['OTGPlaylistInfo', 'OTGPlaylistInfo_1', 'OTGPlaylistInfo_2', 'OTGPlaylistInfo_3']) {
      const b = await readFile(join(itunesDir, name)).catch(() => null)
      if (b) otgBufs.push(b)
    }
    if (!pcBuf && otgBufs.length === 0) return  // nothing to bring home

    const dbBuf = await readFile(join(itunesDir, 'iTunesDB')).catch(() => null)
    if (!dbBuf) return
    const paths = parseCatalogPaths(dbBuf)
    if (!paths) {
      console.warn('[roundtrip] on-card catalog unparseable — skipping ingest')
      return
    }

    const generation = sha1(dbBuf)
    const snapshot = sha1(Buffer.concat([pcBuf || Buffer.alloc(0), ...otgBufs]))
    const statePath = join(host.stateDir, 'ipod-roundtrip-state.json')
    let state: RoundTripState = { generation: '', snapshot: '', ingested: {} }
    try {
      state = JSON.parse(await readFile(statePath, 'utf-8')) as RoundTripState
    } catch { /* first run */ }
    if (state.snapshot === snapshot) return  // nothing new since last look
    if (state.generation !== generation) state = { generation, snapshot: '', ingested: {} }

    // Positional join: catalog record → manifest destPath → library id.
    let destToId = new Map<string, number>()
    try {
      const man = JSON.parse(await readFile(join(host.stateDir, 'last-sync-manifest.json'), 'utf-8')) as
        { tracks?: Array<{ id: number; destPath: string }> }
      destToId = new Map((man.tracks || []).map((t) => [t.destPath, t.id]))
    } catch {
      console.warn('[roundtrip] no sync manifest — cannot map card records to library ids')
      return
    }
    const idAt = (idx: number): number | null => {
      const p = paths[idx]
      const id = p ? destToId.get(p) : undefined
      return typeof id === 'number' ? id : null
    }

    // Play deltas vs what this generation already gave us.
    const entries = pcBuf ? parsePlayCounts(pcBuf) : null
    const deltas: Array<{ id: number; delta: number; lastPlayedMs: number }> = []
    let unmatched = 0
    if (entries) {
      for (let i = 0; i < entries.length && i < paths.length; i++) {
        const e = entries[i]
        if (e.plays <= 0) continue
        const id = idAt(i)
        if (id === null) { unmatched++; continue }
        const prev = state.ingested[String(id)] || 0
        const delta = e.plays - prev
        if (delta > 0) deltas.push({ id, delta, lastPlayedMs: e.lastPlayedMs })
        state.ingested[String(id)] = Math.max(prev, e.plays)
      }
    }
    const otgLists = otgBufs
      .map((b) => parseOtgIndexes(b).map(idAt).filter((x): x is number => x !== null))
      .filter((l) => l.length > 0)

    state.snapshot = snapshot
    const tmp = `${statePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(state), 'utf-8')
    await rename(tmp, statePath)

    if (deltas.length === 0 && otgLists.length === 0) return

    // Ledger first — the record exists even if application fails.
    const ledgerLine = JSON.stringify({
      kind: 'roundtrip', when: new Date().toISOString(), generation: generation.slice(0, 12),
      plays: deltas.map((d) => ({ id: d.id, delta: d.delta, lastPlayedMs: d.lastPlayedMs })),
      otg: otgLists, unmatched,
    })
    const { appendFile } = await import('fs/promises')
    await appendFile(join(host.stateDir, 'ipod-roundtrip-ledger.jsonl'), ledgerLine + '\n', 'utf-8')
      .catch((err) => console.warn('[roundtrip] ledger append failed:', err))

    // Windowed-count events: delta plays stamped at the firmware's
    // last-played time (an approximation the ledger makes explicit).
    for (const d of deltas) {
      await host.appendPlayEvents(d.id, d.delta, d.lastPlayedMs || Date.now())
        .catch(() => { /* the ledger already holds the truth */ })
    }

    // Absolute updates for the renderer (UPDATE_TRACKS applies values as-is).
    const lib = await host.getLibraryTracks()
    const byId = new Map(lib.map((t) => [t.id, t]))
    const updates: Array<{ id: number; field: string; value: number }> = []
    for (const d of deltas) {
      const t = byId.get(d.id)
      if (!t) continue
      updates.push({ id: d.id, field: 'playCount', value: (Number(t.playCount) || 0) + d.delta })
      if (d.lastPlayedMs > (Number(t.lastPlayedAt) || 0)) {
        updates.push({ id: d.id, field: 'lastPlayedAt', value: d.lastPlayedMs })
      }
    }
    const totalPlays = deltas.reduce((n, d) => n + d.delta, 0)
    console.log(`[roundtrip] iPod brought home ${totalPlays} play(s) across ${deltas.length} track(s)` +
      (otgLists.length ? `, ${otgLists.length} On-The-Go list(s)` : '') +
      (unmatched ? ` (${unmatched} unmatched)` : ''))
    host.sendToRenderer('ipod-roundtrip', {
      updates,
      summary: { plays: totalPlays, tracks: deltas.length, otgLists: otgLists.length },
    })
  } catch (err) {
    console.warn('[roundtrip] ingest failed:', err instanceof Error ? err.message : err)
  } finally {
    inFlight = false
  }
}

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
 * Reads only; the card is never written. Two callers, one logic
 * (planRoundTrip): plug-in (ingestIpodRoundTrip) and the pre-sync gate every
 * sync path runs before it wipes or rewrites the card (ipod-plays-archive.ts,
 * 2026-10-28: an Activity Sync retired a 20 KB Play Counts that the plug-in
 * round trip never read, and nothing kept a copy).
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

import { createHash, randomUUID } from 'crypto'
import { join } from 'path'
import { appendFile, mkdir, readFile, writeFile, rename } from 'fs/promises'

const MAC_EPOCH_OFFSET_S = 2082844800 // 1904-01-01 → 1970-01-01

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

export interface RoundTripState {
  generation: string
  snapshot: string
  ingested: Record<string, number>
}

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex')

export const ROUNDTRIP_STATE_FILE = 'ipod-roundtrip-state.json'
export const ROUNDTRIP_LEDGER_FILE = 'ipod-roundtrip-ledger.jsonl'
/** The OTG files the round trip reads, in snapshot order (order is part of the snapshot hash). */
export const ROUNDTRIP_OTG_NAMES = ['OTGPlaylistInfo', 'OTGPlaylistInfo_1', 'OTGPlaylistInfo_2', 'OTGPlaylistInfo_3'] as const

/** The bytes the round trip needs: firmware scratch + the catalog it is positional against. */
export interface RoundTripSnapshot {
  playCounts: Buffer | null
  otg: Buffer[]
  catalog: Buffer | null
}

/** Read the round-trip bytes from an `iPod_Control/iTunes` dir (a card, or an archive copy). */
export async function readRoundTripSnapshot(itunesDir: string): Promise<RoundTripSnapshot> {
  const playCounts = await readFile(join(itunesDir, 'Play Counts')).catch(() => null)
  const otg: Buffer[] = []
  for (const name of ROUNDTRIP_OTG_NAMES) {
    const b = await readFile(join(itunesDir, name)).catch(() => null)
    if (b) otg.push(b)
  }
  const catalog = await readFile(join(itunesDir, 'iTunesDB')).catch(() => null)
  return { playCounts, otg, catalog }
}

/** Identity of the scratch bytes. The same Play Counts + OTG = the same snapshot = nothing new. */
export function roundTripSnapshotId(snap: RoundTripSnapshot): string {
  return sha1(Buffer.concat([snap.playCounts || Buffer.alloc(0), ...snap.otg]))
}

export type ManifestLike = { tracks?: Array<{ id: number; destPath?: string }> } | null

export interface RoundTripDelta { id: number; delta: number; lastPlayedMs: number }

/** What the scratch bytes mean against a catalog + manifest. Pure: no I/O, no clock. */
export type RoundTripPlan =
  | { kind: 'empty' }                                  // no Play Counts, no OTG
  | { kind: 'no-plays' }                               // scratch present, zero plays, no OTG songs
  | { kind: 'already-recorded'; snapshot: string }
  | { kind: 'cannot-map'; code: 'format' | 'no-catalog' | 'bad-catalog' | 'no-manifest'; reason: string; plays: number }
  | {
      kind: 'plan'
      generation: string
      snapshot: string
      deltas: RoundTripDelta[]
      otgLists: number[][]
      unmatched: number
      nextState: RoundTripState
    }

const playsIn = (entries: PlayCountEntry[] | null): number =>
  (entries || []).reduce((n, e) => n + Math.max(0, e.plays), 0)

/**
 * THE shared round-trip logic. Plug-in ingest, the pre-sync gate and archive
 * re-ingest all go through this one function, so a play can only ever be
 * counted one way. Double-count safety lives here (per-generation `ingested`).
 */
export function planRoundTrip(
  snap: RoundTripSnapshot,
  manifest: ManifestLike,
  prior: RoundTripState | null,
): RoundTripPlan {
  if (!snap.playCounts && snap.otg.length === 0) return { kind: 'empty' }
  const entries = snap.playCounts ? parsePlayCounts(snap.playCounts) : null
  const otgIdx = snap.otg.map(parseOtgIndexes)
  const plays = playsIn(entries)
  if (snap.playCounts && !entries) {
    return { kind: 'cannot-map', code: 'format', plays: 0, reason: 'the iPod’s play log is in a format JakeTunes can’t read' }
  }
  if (plays === 0 && otgIdx.every((l) => l.length === 0)) return { kind: 'no-plays' }

  const snapshot = roundTripSnapshotId(snap)
  if (prior && prior.snapshot === snapshot) return { kind: 'already-recorded', snapshot }
  if (!snap.catalog) return { kind: 'cannot-map', code: 'no-catalog', plays, reason: 'the iPod has no song list (iTunesDB) to match its plays against' }
  const paths = parseCatalogPaths(snap.catalog)
  if (!paths) return { kind: 'cannot-map', code: 'bad-catalog', plays, reason: 'the iPod’s song list (iTunesDB) can’t be read' }
  const manTracks = manifest && Array.isArray(manifest.tracks) ? manifest.tracks : null
  const destToId = new Map<string, number>()
  for (const t of manTracks || []) if (t && typeof t.destPath === 'string' && t.destPath) destToId.set(t.destPath, t.id)
  if (destToId.size === 0) {
    return { kind: 'cannot-map', code: 'no-manifest', plays, reason: 'this Mac has no record of what the last sync put on this iPod, so its plays can’t be matched to songs' }
  }

  const generation = sha1(snap.catalog)
  let state: RoundTripState = prior && prior.generation === generation
    ? { generation, snapshot: prior.snapshot, ingested: { ...prior.ingested } }
    : { generation, snapshot: '', ingested: {} }
  const idAt = (idx: number): number | null => {
    const p = paths[idx]
    const id = p ? destToId.get(p) : undefined
    return typeof id === 'number' ? id : null
  }
  const deltas: RoundTripDelta[] = []
  let unmatched = 0
  for (let i = 0; entries && i < entries.length && i < paths.length; i++) {
    const e = entries[i]
    if (e.plays <= 0) continue
    const id = idAt(i)
    if (id === null) { unmatched++; continue }
    const prev = state.ingested[String(id)] || 0
    const delta = e.plays - prev
    if (delta > 0) deltas.push({ id, delta, lastPlayedMs: e.lastPlayedMs })
    state.ingested[String(id)] = Math.max(prev, e.plays)
  }
  const otgLists = otgIdx
    .map((l) => l.map(idAt).filter((x): x is number => x !== null))
    .filter((l) => l.length > 0)
  state = { ...state, snapshot }
  return { kind: 'plan', generation, snapshot, deltas, otgLists, unmatched, nextState: state }
}

export interface RoundTripHost {
  stateDir: string
  getLibraryTracks: () => Promise<Array<{ id: number; playCount?: number; lastPlayedAt?: number }>>
  appendPlayEvents: (trackId: number, count: number, tsMs: number) => Promise<void>
  sendToRenderer: (channel: string, ...args: unknown[]) => void
  isSyncInFlight: () => boolean
  /** A manifest kept with an archived copy of THIS catalog (by sha1), for when the live
   *  manifest can't map it — e.g. a sync that stopped after writing its in-flight manifest. */
  fallbackManifest?: (catalogSha1: string) => Promise<ManifestLike>
}

/** What a round trip did — always logged, so "nothing new" and "never ran" can't look alike. */
export type RoundTripOutcome =
  | { kind: 'nothing-on-card' }
  | { kind: 'no-plays' }
  | { kind: 'nothing-new'; snapshot: string }
  | { kind: 'brought-home'; snapshot: string; plays: number; tracks: number; otgLists: number; unmatched: number }
  | { kind: 'skipped'; reason: string }
  | { kind: 'cannot-map'; reason: string; plays: number }
  | { kind: 'failed'; reason: string }

export function describeRoundTripOutcome(o: RoundTripOutcome): string {
  switch (o.kind) {
    case 'nothing-on-card': return 'nothing on the iPod to bring home (no Play Counts, no On-The-Go)'
    case 'no-plays': return 'nothing new — the iPod logged no plays since its last sync'
    case 'nothing-new': return `nothing new — these plays were already brought home (snapshot ${o.snapshot.slice(0, 12)})`
    case 'brought-home': return `brought home ${o.plays} play(s) across ${o.tracks} song(s)` +
      (o.otgLists ? `, ${o.otgLists} On-The-Go list(s)` : '') + (o.unmatched ? ` (${o.unmatched} unmatched)` : '') +
      ` (snapshot ${o.snapshot.slice(0, 12)})`
    case 'skipped': return `skipped: ${o.reason}`
    case 'cannot-map': return `could not match ${o.plays} play(s): ${o.reason}`
    case 'failed': return `failed: ${o.reason}`
  }
}

export async function readRoundTripState(stateDir: string): Promise<RoundTripState | null> {
  try {
    const s = JSON.parse(await readFile(join(stateDir, ROUNDTRIP_STATE_FILE), 'utf-8')) as RoundTripState
    return s && typeof s === 'object' ? s : null
  } catch {
    return null
  }
}

async function readManifest(path: string): Promise<ManifestLike> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as ManifestLike
  } catch {
    return null
  }
}

/** Unique per write: two writers in one process must never share a tmp name. */
export function uniqueTmpPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
}

async function writeRoundTripState(stateDir: string, state: RoundTripState): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const path = join(stateDir, ROUNDTRIP_STATE_FILE)
  const tmp = uniqueTmpPath(path)
  await writeFile(tmp, JSON.stringify(state), 'utf-8')
  await rename(tmp, path)
}

/**
 * Record a plan: state + ledger first (the record exists even if applying
 * fails), then windowed play events, then absolute updates to the renderer.
 */
export async function applyRoundTripPlan(
  plan: Extract<RoundTripPlan, { kind: 'plan' }>,
  host: RoundTripHost,
  opts: { ledgerKind?: string; writeState?: boolean } = {},
): Promise<RoundTripOutcome> {
  const ledgerKind = opts.ledgerKind || 'roundtrip'
  // An archive re-ingest must not overwrite the live per-generation state:
  // that state guards the card's CURRENT Play Counts against double counting.
  if (opts.writeState !== false) await writeRoundTripState(host.stateDir, plan.nextState)
  const { deltas, otgLists, unmatched } = plan
  const totalPlays = deltas.reduce((n, d) => n + d.delta, 0)
  const outcome: RoundTripOutcome = {
    kind: 'brought-home', snapshot: plan.snapshot, plays: totalPlays, tracks: deltas.length, otgLists: otgLists.length, unmatched,
  }
  if (deltas.length === 0 && otgLists.length === 0 && unmatched === 0) return { kind: 'nothing-new', snapshot: plan.snapshot }

  const ledgerLine = JSON.stringify({
    kind: ledgerKind, when: new Date().toISOString(), generation: plan.generation.slice(0, 12), snapshot: plan.snapshot.slice(0, 12),
    plays: deltas.map((d) => ({ id: d.id, delta: d.delta, lastPlayedMs: d.lastPlayedMs })),
    otg: otgLists, unmatched,
  })
  await appendFile(join(host.stateDir, ROUNDTRIP_LEDGER_FILE), ledgerLine + '\n', 'utf-8')
    .catch((err) => console.warn('[roundtrip] ledger append failed:', err))

  // Windowed-count events: delta plays stamped at the firmware's
  // last-played time (an approximation the ledger makes explicit).
  for (const d of deltas) {
    await host.appendPlayEvents(d.id, d.delta, d.lastPlayedMs || Date.now())
      .catch((err) => console.warn('[roundtrip] play-event append failed (the ledger holds the truth):', err))
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
  if (deltas.length > 0 || otgLists.length > 0) {
    host.sendToRenderer('ipod-roundtrip', {
      updates,
      summary: { plays: totalPlays, tracks: deltas.length, otgLists: otgLists.length },
    })
  }
  return outcome
}

// One round trip at a time per process. Plug-in and the pre-sync gate queue
// behind each other (the second one sees "nothing new") instead of racing
// on the state file or silently skipping.
let lock: Promise<unknown> = Promise.resolve()
function withRoundTripLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn)
  lock = run.catch((err) => console.warn('[roundtrip] lock holder failed:', err instanceof Error ? err.message : err))
  return run
}

/**
 * Ingest an already-read snapshot against `host.stateDir`'s manifest + state.
 * The pre-sync gate calls this with the exact bytes it archived.
 */
export function ingestRoundTripSnapshot(snap: RoundTripSnapshot, host: RoundTripHost): Promise<RoundTripOutcome> {
  return withRoundTripLock(async () => {
    try {
      const prior = await readRoundTripState(host.stateDir)
      const manifest = await readManifest(join(host.stateDir, 'last-sync-manifest.json'))
      let plan = planRoundTrip(snap, manifest, prior)
      const weak = (plan.kind === 'cannot-map' && plan.code === 'no-manifest') || (plan.kind === 'plan' && plan.unmatched > 0)
      if (weak && snap.catalog && host.fallbackManifest) {
        const alt = await host.fallbackManifest(sha1(snap.catalog))
        const p2 = alt ? planRoundTrip(snap, alt, prior) : null
        if (p2 && p2.kind === 'plan' && (plan.kind !== 'plan' || p2.unmatched < plan.unmatched)) {
          console.warn(`[roundtrip] mapped with the manifest kept alongside this catalog (${p2.unmatched} unmatched)`)
          plan = p2
        }
      }
      switch (plan.kind) {
        case 'empty': return { kind: 'nothing-on-card' }
        case 'no-plays': return { kind: 'no-plays' }
        case 'already-recorded': return { kind: 'nothing-new', snapshot: plan.snapshot }
        case 'cannot-map': return { kind: 'cannot-map', reason: plan.reason, plays: plan.plays }
        case 'plan': return await applyRoundTripPlan(plan, host)
      }
    } catch (err) {
      return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
    }
  })
}

/**
 * Plug-in round trip: read the card and bring its plays home. Never writes the
 * card. Skips while a sync is running — that sync records the plays itself
 * before it touches anything (ipod-plays-archive.ts securePlaysBeforeSync).
 * Every outcome is logged with console.warn (main.log keeps only warn/error).
 */
export async function ingestIpodRoundTrip(mount: string, host: RoundTripHost): Promise<RoundTripOutcome> {
  const outcome: RoundTripOutcome = host.isSyncInFlight()
    ? { kind: 'skipped', reason: 'a sync is running (it records the plays itself before touching the iPod)' }
    : await ingestRoundTripSnapshot(await readRoundTripSnapshot(join(mount, 'iPod_Control', 'iTunes')), host)
  console.warn(`[roundtrip] plug-in (${host.stateDir}): ${describeRoundTripOutcome(outcome)}`)
  return outcome
}

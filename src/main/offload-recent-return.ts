/**
 * Songs Jake just got come back onto this Mac (2026-11-10; rewritten
 * 2026-11-12 after the review of PR 409).
 *
 * offload-keep-recent.ts stops the queue from offloading them. This is the
 * other half: on 2026-11-09 and 11-10 the queue had already turned hundreds of
 * just-imported songs into links, "Transistor" among them.
 *
 * The first version could become a download loop in two ways. The rules now:
 *
 *   • Only what was ADDED lately comes back. A played old song stays streamed
 *     (its copy on homemini is kept warm instead, stream-keep-warm.ts), or
 *     playing it would fetch its original and a week later drop it again.
 *   • A song that came back is not offloaded again for RETURN_HOLD_DAYS,
 *     whatever the windows say (`returned` in the ledger, asked by the queue).
 *     So the tight windows never let go of what this fetched.
 *   • It only runs with room to spare: after the write the disk must still have
 *     ROOMY_ENTER_BYTES free. The windows turn tight under 60 GB and this stops
 *     at 80, so fetching can't be what turns them.
 *   • Nothing is downloaded to find out it doesn't match. homemini is asked
 *     for its file's size and sha1 first (audio-identity.ts); a download starts
 *     only when they are this Mac's record of the file it replaced. homemini's
 *     tags-only repairs change those bytes on purpose: such a song is left
 *     streamed and remembered (`refused`), and asked about again only after
 *     REFUSED_RECHECK_MS. Taking homemini's newer file instead would need the
 *     proof that only the tags differ, which this Mac can't see.
 *   • One song that can't come back never holds the songs behind it.
 *   • "Is the player using it?" is asked right before the file is swapped, not
 *     when the batch was picked.
 *
 * A file is still written only when the downloaded bytes are the recorded size
 * and whole-file sha1 (rehydrateBytesOk, as "Undo offload").
 *
 * Electron-free; every effect is injected (__tests__/offload-recent-return.test.ts).
 */
import { rehydrateBytesOk, type OffloadReplacementRecord } from './offload-audio.ts'
import { identityKey, isPending, type IdentityAnswer } from './audio-identity.ts'
import { ROOMY_ENTER_BYTES } from './offload-keep-recent.ts'

/** At most this many files a pass (a pass runs every 90 s). */
export const RETURN_PER_PASS = 6
/** A file is fetched whole into memory before it is checked, so a show-sized file (a merged concert is 1 GB) stays streamed. */
export const RETURN_MAX_BYTES = 300 * 1024 * 1024
/** How many links homemini is asked about in one pass. */
export const RETURN_ASK = 40
const DAY = 24 * 60 * 60 * 1000
/** A song that came back stays this long, whatever the windows say. */
export const RETURN_HOLD_DAYS = 14
/** A refused song is asked about again after this long (or at once when its record changes). */
export const REFUSED_RECHECK_MS = DAY
export const RETURN_LEDGER_FILE = 'offload-returned.json'

export interface ReturnLedger {
  version: 1
  /** colon path → when it came back (epoch ms). */
  returned: Record<string, number>
  /** colon path → what was refused: this Mac's record, homemini's answer, when. */
  refused: Record<string, { record: string; remote: string; at: number }>
}

export function emptyLedger(): ReturnLedger {
  return { version: 1, returned: {}, refused: {} }
}

export function parseLedger(text: string | null): ReturnLedger {
  if (!text) return emptyLedger()
  try {
    const o = JSON.parse(text) as Partial<ReturnLedger>
    const out = emptyLedger()
    for (const [p, at] of Object.entries(o.returned ?? {})) if (typeof at === 'number' && Number.isFinite(at)) out.returned[p] = at
    for (const [p, r] of Object.entries(o.refused ?? {})) {
      if (r && typeof r.record === 'string' && typeof r.remote === 'string' && typeof r.at === 'number') out.refused[p] = r
    }
    return out
  } catch {
    return emptyLedger()
  }
}

/** The queue asks this: a song that came back in the last RETURN_HOLD_DAYS is not offloaded. */
export function returnedLately(ledger: ReturnLedger, colonPath: string, now: number): boolean {
  const at = ledger.returned[colonPath]
  return typeof at === 'number' && now - at < RETURN_HOLD_DAYS * DAY
}

/** Hub, at home, long windows: all three, or nothing is fetched. */
export function returnAllowed(o: { hub: boolean; roomy: boolean; away: boolean }): boolean {
  return o.hub && o.roomy && !o.away
}

/** Would the write leave the disk its headroom? Unknown free space is a no. */
export function roomToReturn(freeBytes: number, incomingBytes: number): boolean {
  return Number.isFinite(freeBytes) && freeBytes - Math.max(0, incomingBytes) >= ROOMY_ENTER_BYTES
}

/** The newest record of each path that is in `keep`, newest first. A record with no whole-file sha1 can't restore anything; a show-sized file is left streamed. */
export function recentReturnCandidates(
  records: ReadonlyArray<OffloadReplacementRecord>,
  keep: { has(colonPath: string): boolean },
): OffloadReplacementRecord[] {
  const newest = new Map<string, OffloadReplacementRecord>()
  for (const r of records) {
    if (!r?.path || !keep.has(r.path)) continue
    if (!/^[0-9a-f]{40}$/i.test(r.fullSha1 || '')) continue
    if (!(Number(r.bytes) > 0) || Number(r.bytes) > RETURN_MAX_BYTES) continue
    const have = newest.get(r.path)
    if (!have || String(r.ts) >= String(have.ts)) newest.set(r.path, r)
  }
  return [...newest.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
}

export interface ReturnRecentResult {
  restored: number
  /** Songs homemini holds other bytes for: left streamed. */
  refused: number
  /** Whole files downloaded this pass. */
  downloads: number
  stoppedBecause: string | null
  ledger: ReturnLedger
  ledgerChanged: boolean
}

export async function returnRecentSongs(opts: {
  hub: boolean
  roomy: boolean
  away: boolean
  records: ReadonlyArray<OffloadReplacementRecord>
  /** Songs ADDED lately (offload-keep-recent.ts addedLately). */
  added: { has(colonPath: string): boolean }
  ledger: ReturnLedger
  now: number
  /** The player asked for this song lately. Asked when picking AND right before the swap. */
  inUse: (colonPath: string) => boolean
  currentKind: (record: OffloadReplacementRecord) => Promise<'symlink' | 'file' | 'missing'>
  askIdentity: (ids: Array<string | number>) => Promise<IdentityAnswer>
  freeBytes: () => Promise<number>
  /** homemini's original bytes, whole. Called only after its identity matched the record. */
  fetchFull: (id: string | number) => Promise<Buffer | null>
  writeBack: (record: OffloadReplacementRecord, bytes: Buffer) => Promise<void>
  /** Back on the offload queue, so the song is offloaded once its hold is over. */
  requeue: (records: OffloadReplacementRecord[]) => Promise<void>
  max?: number
  log: (msg: string) => void
}): Promise<ReturnRecentResult> {
  const ledger: ReturnLedger = { version: 1, returned: { ...opts.ledger.returned }, refused: { ...opts.ledger.refused } }
  const out: ReturnRecentResult = { restored: 0, refused: 0, downloads: 0, stoppedBecause: null, ledger, ledgerChanged: false }
  if (!returnAllowed(opts)) return out
  const max = opts.max ?? RETURN_PER_PASS

  // Links only, not in use, not refused lately on this same record.
  const asking: OffloadReplacementRecord[] = []
  for (const r of recentReturnCandidates(opts.records, opts.added)) {
    if (asking.length >= RETURN_ASK) break
    const memo = ledger.refused[r.path]
    if (memo && memo.record === r.fullSha1 && opts.now - memo.at < REFUSED_RECHECK_MS) continue
    if (opts.inUse(r.path)) continue
    let kind: 'symlink' | 'file' | 'missing'
    try { kind = await opts.currentKind(r) } catch { continue }
    if (kind === 'symlink') asking.push(r)
  }
  if (!asking.length) return out

  let answer: IdentityAnswer
  try { answer = await opts.askIdentity(asking.map((r) => r.id)) } catch { answer = { kind: 'unreachable' } }
  if (answer.kind !== 'answers') {
    out.stoppedBecause = answer.kind === 'unsupported' ? 'homemini can’t say what it holds' : 'homemini didn’t answer'
    return out
  }

  const refuse = (r: OffloadReplacementRecord, remote: string, why: string): void => {
    const had = ledger.refused[r.path]
    ledger.refused[r.path] = { record: String(r.fullSha1), remote, at: opts.now }
    out.ledgerChanged = true
    out.refused++
    if (!had || had.record !== r.fullSha1 || had.remote !== remote) {
      opts.log(`[offload] ${r.id} stays streamed: ${why}. Not asked about again for a day, or until this Mac’s record of it changes.`)
    }
  }

  const back: OffloadReplacementRecord[] = []
  for (const r of asking) {
    if (back.length >= max) break
    const identity = answer.byId.get(String(r.id)) ?? null
    // No file, or not hashed yet: nothing is known, so nothing is fetched and nothing is remembered.
    if (!identity || isPending(identity)) continue
    if (identity.size !== r.bytes || identity.sha1.toLowerCase() !== String(r.fullSha1).toLowerCase()) {
      refuse(r, identityKey(identity), 'homemini’s file is no longer the one this Mac replaced (its tags were repaired there, or it was re-imported)')
      continue
    }
    let free: number
    try { free = await opts.freeBytes() } catch { free = Number.NaN }
    if (!roomToReturn(free, r.bytes)) {
      out.stoppedBecause = 'the disk would be left with less than its headroom'
      break
    }
    out.downloads++
    let bytes: Buffer | null
    try { bytes = await opts.fetchFull(r.id) } catch { bytes = null }
    if (!bytes) continue   // homemini didn't send it: nothing learned
    if (!rehydrateBytesOk(r, bytes)) {
      refuse(r, identityKey(identity), 'the bytes homemini sent are not the ones it said it holds')
      continue
    }
    // Asked again NOW: a song tapped while its file was downloading keeps its link, and is tried on a later pass.
    if (opts.inUse(r.path)) continue
    try {
      if ((await opts.currentKind(r)) !== 'symlink') continue
      await opts.writeBack(r, bytes)
    } catch (err) {
      opts.log(`[offload] ${r.id} could not be written back: ${err instanceof Error ? err.message : err}`)
      continue
    }
    ledger.returned[r.path] = opts.now
    delete ledger.refused[r.path]
    out.ledgerChanged = true
    back.push(r)
  }
  if (back.length) {
    await opts.requeue(back)
    out.restored = back.length
    opts.log(`[offload] ${back.length} song(s) Jake just got are back on this Mac: ${back.map((r) => r.id).join(', ')}`)
  }
  if (out.stoppedBecause) opts.log(`[offload] bringing songs back stopped: ${out.stoppedBecause}`)
  return out
}

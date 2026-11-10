/**
 * Does homemini hold this exact file? The gate before a local file becomes a
 * link (2026-11-09).
 *
 * The old gate downloaded homemini's whole copy to hash it, every try: 533 GB
 * in a week for 105 songs that could never match
 * (~/concert-repair/refused-copies-diagnosis.md). Now homemini is asked for its
 * own hash (audio-identity.ts) and nothing is downloaded to check.
 *
 * It replaces a file only when ALL of these hold:
 *   • homemini's size and whole-file sha1 equal this Mac's file, hashed here;
 *   • this Mac's file did not change while it was being hashed;
 *   • what homemini serves right now is the copy it answered about (the same
 *     ETag: size and modified time), it says the file is that size, and its
 *     first 256 KB are this file's first 256 KB. An old answer about a file
 *     since replaced can't pass, wherever in the file the change is.
 * A copy homemini hasn't hashed yet is not confirmed. In the background the
 * row waits. When Jake asked for this song ("Remove download"), it is asked
 * about a few more times, and then the whole file is compared the old way, so
 * the click does what it says and the message says what happened.
 * That is the old rule (same size, same sha1 of the whole file), with the
 * hash taken on homemini's disk instead of over the wire.
 *
 * A refusal is remembered as (this Mac's file, homemini's answer) and nothing
 * is hashed or fetched for it again until one of the two changes.
 *
 * Only when homemini doesn't have the route (404, an older backend) does the
 * old whole-file compare run, with the library's CURRENT fingerprint as the
 * pre-filter, and never while away from home unless Jake asked for this song.
 */
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import {
  classifyProbe, compareOpened, defaultFetchPrefix, defaultOpenRaw, digestFile, fullBodiesMatch, rawAudioUrl, urlAsksForTranscode,
  type FullFileDigest, type HomeminiPrefixProbe, type RawOpen,
} from './offload-audio.ts'
import { askAudioIdentity, hubBaseFromAudioBase, identityKey, isPending, oneIdentity, type OneIdentity } from './audio-identity.ts'
import { withCompanionInit } from './hub-companion.ts'

const PREFIX_BYTES = 256 * 1024
export const PENDING_WAIT_MS = 3000
/** How many more times a request asks about a copy homemini hasn't hashed yet. */
export const USER_PENDING_RETRIES = 4

/** What a refusal was made on. Either side changing makes a new try worth it. */
export interface RefusalMemo {
  /** This Mac's file: size and modified time. */
  local: string
  /** homemini's answer for the id (audio-identity), or `etag:<etag>` from the old check. */
  remote: string
}

export type HoldsFile =
  | { ok: true; fullSha1: string; bytes: number; via: 'identity' | 'whole-file' }
  | {
    ok: false
    /**
     * different: homemini holds other bytes. held: the same refusal as last time, nothing re-checked.
     * away: only a whole-file download could tell, and this Mac is away from home.
     * pending: homemini hasn't hashed its copy yet; the next ask has it.
     */
    reason: 'different' | 'missing' | 'unreachable' | 'transcode' | 'held' | 'away' | 'pending'
    refused?: RefusalMemo
  }

/** What to tell Jake when a file was kept. Each line is what actually happened. */
export function keptLocalMessage(reason: Extract<HoldsFile, { ok: false }>['reason']): string {
  switch (reason) {
    case 'different':
    case 'held': return 'homemini holds a different copy of this file (the audio may be the same with other tags) — kept local'
    case 'missing': return 'homemini does not have this file yet — kept local'
    case 'pending': return 'homemini has the file and is still checking it — kept local for now'
    case 'away': return 'away from home: comparing this file means downloading it whole — kept local'
    case 'transcode': return 'homemini would send a converted copy, which can’t be compared — kept local'
    case 'unreachable': return 'homemini did not give a clear answer — kept local'
  }
}

interface LocalStat { size: number; mtimeMs: number }

export function localFileKey(st: LocalStat): string {
  return `${st.size}-${Math.floor(st.mtimeMs)}`
}

export function sameRefusal(a: RefusalMemo | undefined, b: RefusalMemo): boolean {
  return !!a && a.local === b.local && a.remote === b.remote
}

async function readPrefix(abs: string): Promise<Buffer> {
  const fh = await open(abs, 'r')
  try {
    const buf = Buffer.alloc(PREFIX_BYTES)
    const { bytesRead } = await fh.read(buf, 0, PREFIX_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex')

export async function confirmHomeminiHoldsFile(opts: {
  id: string | number
  localAbs: string
  audioBase: string
  /** homemini's answer when the caller already asked (a batch); left out, it is asked here. */
  identity?: OneIdentity
  /** The library's fingerprint of the song NOW. The old check's pre-filter only. */
  libraryFingerprint?: string
  /** false: never download the whole file to compare it (away from home, in the background). */
  allowWholeFile: boolean
  remembered?: RefusalMemo
  askIdentity?: (id: string | number) => Promise<OneIdentity>
  /**
   * Jake asked for this song: a copy homemini hasn't hashed yet is asked about
   * this many more times, then compared whole (when `allowWholeFile`). 0, the
   * default, is the background: `pending` is the answer.
   */
  pendingRetries?: number
  pendingWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  statLocal?: (abs: string) => Promise<LocalStat>
  hashLocal?: (abs: string) => Promise<FullFileDigest>
  readLocalPrefix?: (abs: string) => Promise<Buffer>
  fetchPrefix?: (url: string) => Promise<HomeminiPrefixProbe>
  openRaw?: (url: string) => Promise<RawOpen>
}): Promise<HoldsFile> {
  const url = rawAudioUrl(opts.audioBase, opts.id)
  if (urlAsksForTranscode(opts.audioBase) || urlAsksForTranscode(url)) return { ok: false, reason: 'transcode' }
  const statLocal = opts.statLocal ?? stat
  const hashLocal = opts.hashLocal ?? digestFile
  const fetchPrefix = opts.fetchPrefix ?? defaultFetchPrefix
  const probeNow = async (): Promise<HomeminiPrefixProbe> => {
    try { return await fetchPrefix(url) } catch { return { transportError: true, status: 0, body: null } }
  }

  const ask = opts.askIdentity ?? (async (id) => oneIdentity(await askAudioIdentity({
    baseUrl: hubBaseFromAudioBase(opts.audioBase), ids: [id], withInit: withCompanionInit,
  }), id))
  const askNow = async (): Promise<OneIdentity> => {
    try { return await ask(opts.id) } catch { return 'unreachable' }
  }
  let identity: OneIdentity = opts.identity !== undefined ? opts.identity : await askNow()
  // Asking is what makes homemini hash the file, so a request is worth a few more asks.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  for (let i = 0; i < (opts.pendingRetries ?? 0) && identity !== 'unsupported' && identity !== 'unreachable' && isPending(identity); i++) {
    await sleep(opts.pendingWaitMs ?? PENDING_WAIT_MS)
    identity = await askNow()
  }
  if (identity === 'unreachable') return { ok: false, reason: 'unreachable' }
  if (identity === null) return { ok: false, reason: 'missing' }
  // Not hashed yet is not an identity: nothing is replaced on a size and a date.
  if (identity !== 'unsupported' && isPending(identity)) {
    if (!((opts.pendingRetries ?? 0) > 0 && opts.allowWholeFile)) return { ok: false, reason: 'pending' }
    identity = 'unsupported'   // a request, still not hashed: the whole file is compared, as before
  }

  let before: LocalStat
  try { before = await statLocal(opts.localAbs) } catch { return { ok: false, reason: 'unreachable' } }
  const local = localFileKey(before)

  if (identity === 'unsupported') {
    // An older backend: the old check, and only here.
    if (!opts.allowWholeFile) return { ok: false, reason: 'away' }
    const probe = await probeNow()
    const kind = classifyProbe(opts.libraryFingerprint ?? null, probe)
    if (kind === 'unreachable') return { ok: false, reason: 'unreachable' }
    if (kind === 'missing') return { ok: false, reason: 'missing' }
    const memo: RefusalMemo | undefined = probe.etag ? { local, remote: `etag:${probe.etag}` } : undefined
    if (memo && sameRefusal(opts.remembered, memo)) return { ok: false, reason: 'held', refused: memo }
    if (kind === 'mismatch') return { ok: false, reason: 'different', ...(memo ? { refused: memo } : {}) }
    const whole = await compareOpened(url, opts.localAbs, opts.openRaw ?? defaultOpenRaw, hashLocal)
    if (whole.ok) return { ok: true, fullSha1: whole.fullSha1, bytes: whole.bytes, via: 'whole-file' }
    return { ok: false, reason: whole.reason, ...(whole.reason === 'different' && memo ? { refused: memo } : {}) }
  }

  const memo: RefusalMemo = { local, remote: identityKey(identity) }
  if (sameRefusal(opts.remembered, memo)) return { ok: false, reason: 'held', refused: memo }
  if (identity.size !== before.size) return { ok: false, reason: 'different', refused: memo }
  let mine: FullFileDigest
  try { mine = await hashLocal(opts.localAbs) } catch { return { ok: false, reason: 'unreachable' } }
  if (!fullBodiesMatch(mine, { sha1: identity.sha1, bytes: identity.size })) return { ok: false, reason: 'different', refused: memo }

  // The file must be the one that was hashed, and homemini must be serving it now.
  let mineFront: Buffer
  try {
    mineFront = await (opts.readLocalPrefix ?? readPrefix)(opts.localAbs)
    if (localFileKey(await statLocal(opts.localAbs)) !== local) return { ok: false, reason: 'unreachable' }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  const probe = await probeNow()
  if (probe.transportError) return { ok: false, reason: 'unreachable' }
  if (!probe.body || probe.body.length <= 0 || (probe.status !== 200 && probe.status !== 206)) return { ok: false, reason: 'missing' }
  // The copy being served must be the copy the answer was about. Not a refusal: asked again.
  if (!probe.etag || probe.etag !== identity.etag) return { ok: false, reason: 'unreachable' }
  if (probe.total !== mine.bytes) return { ok: false, reason: 'unreachable' }
  const theirFront = probe.body.subarray(0, PREFIX_BYTES)
  if (mineFront.length <= 0 || theirFront.length !== mineFront.length || sha1(theirFront) !== sha1(mineFront)) {
    return { ok: false, reason: 'different' }
  }
  return { ok: true, fullSha1: mine.sha1, bytes: mine.bytes, via: 'identity' }
}

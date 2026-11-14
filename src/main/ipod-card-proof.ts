/**
 * Is a replacement card really the size it says? — the cheap check
 * (review of PR 414, 2026-11-14).
 *
 * A card that claims more than it holds wraps around: what is written late
 * lands on top of what was written first. So while a sync copies, the hash of
 * each song's source is taken as it is confirmed on the card
 * (ipod-sync-card.ts confirmWriteOnCard, the one place every engine passes
 * through), and the FIRST 15 and the LAST 15 written are kept. After the iPod
 * has been unplugged and plugged back in (so nothing comes from the Mac's
 * cache), those 30 files are read off the card and compared. About a minute.
 *
 * Only for an iPod whose set-up isn't sealed yet (`wanted`), so an ordinary
 * sync pays nothing. It never writes to the iPod. If it can't run — no record
 * of the copy, or no replug yet — it says so; it never passes by default.
 */
import { createHash, randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { join, sep } from 'path'
import { IPOD_MARKER_REL, parseDeviceMarker } from '../common/ipod-identity.ts'

export const CARD_PROOF_SAMPLE = 15
export const CARD_PROOF_FILE = 'ipod-card-proof.json'

interface Sample { rel: string; md5: string; size: number }
interface Proof { markerId: string; run: string; plug: number; count: number; at: string; first: Sample[]; last: Sample[] }

export type CardProofResult =
  | { status: 'pass'; checked: number; line: string }
  | { status: 'fail'; checked: number; bad: number; line: string }
  /** Not run: the iPod hasn't been unplugged and plugged back in since the copy. */
  | { status: 'waiting'; line: string }
  /** Not run: no record of what the first sync wrote. */
  | { status: 'none'; line: string }

const runId = randomUUID()
let plugCount = 0
let persistDir: string | null = null
let wanted: (markerId: string) => Promise<boolean> = async () => false
const live = new Map<string, Proof>()
const markerOf = new Map<string, { id: string | null; at: number }>()
let timer: ReturnType<typeof setTimeout> | null = null

/** Turn the collector on (the hub, at start-up). `want`: is this iPod's set-up still unsealed? */
export function startCardProof(dir: string, want: (markerId: string) => Promise<boolean>): void {
  persistDir = dir
  wanted = want
}
/** For the tests. */
export function resetCardProof(): void {
  persistDir = null
  wanted = async () => false
  live.clear()
  markerOf.clear()
  plugCount = 0
  if (timer) { clearTimeout(timer); timer = null }
}
/** An iPod was just plugged in (ipod-ipc.ts, once per plug-in). */
export function cardPlugged(): void { plugCount++ }

export function md5OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('md5')
    createReadStream(path).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

async function markerIdAt(mount: string): Promise<string | null> {
  const hit = markerOf.get(mount)
  if (hit && Date.now() - hit.at < 60_000) return hit.id
  let id: string | null = null
  try { id = parseDeviceMarker(JSON.parse(await readFile(join(mount, ...IPOD_MARKER_REL), 'utf-8')))?.id ?? null } catch { id = null }
  markerOf.set(mount, { id, at: Date.now() })
  return id
}

async function readAll(): Promise<Record<string, Proof>> {
  if (!persistDir) return {}
  try {
    const raw = JSON.parse(await readFile(join(persistDir, CARD_PROOF_FILE), 'utf-8')) as { proofs?: Record<string, Proof> }
    return raw.proofs && typeof raw.proofs === 'object' ? raw.proofs : {}
  } catch {
    return {}
  }
}

/** Put what was collected on disk now (it is also written a few seconds after each copy). */
export async function flushCardProof(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null }
  if (!persistDir || live.size === 0) return
  const all = await readAll()
  for (const p of live.values()) all[p.markerId] = p
  await mkdir(persistDir, { recursive: true })
  const path = join(persistDir, CARD_PROOF_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ proofs: all }), 'utf-8')
  await rename(tmp, path)
}

/**
 * One song was just confirmed on the card. Never throws and never fails a
 * copy: a sample that can't be taken is simply not taken.
 */
export async function noteCardWrite(src: string, dst: string): Promise<void> {
  try {
    if (!persistDir) return
    const cut = dst.indexOf(`${sep}iPod_Control${sep}Music${sep}`)
    if (cut < 0) return
    const mount = dst.slice(0, cut)
    const markerId = await markerIdAt(mount)
    if (!markerId || !(await wanted(markerId))) return
    let p = live.get(markerId)
    // A new plug-in (or a new run of the app) is a new copy: start again.
    if (!p || p.run !== runId || p.plug !== plugCount) {
      p = { markerId, run: runId, plug: plugCount, count: 0, at: new Date().toISOString(), first: [], last: [] }
      live.set(markerId, p)
    }
    const sample: Sample = { rel: dst.slice(cut + 1), md5: await md5OfFile(src), size: (await stat(src)).size }
    p.count++
    p.at = new Date().toISOString()
    if (p.first.length < CARD_PROOF_SAMPLE) p.first.push(sample)
    else { p.last.push(sample); if (p.last.length > CARD_PROOF_SAMPLE) p.last.shift() }
    if (!timer) {
      timer = setTimeout(() => { timer = null; void flushCardProof().catch((err) => console.warn('[card-proof] save:', err instanceof Error ? err.message : err)) }, 3000)
      timer.unref?.()
    }
  } catch (err) {
    console.warn('[card-proof] sample skipped:', err instanceof Error ? err.message : err)
  }
}

/** Read the sampled files off the card and compare. Reads only. */
export async function verifyCardProof(mount: string, markerId: string): Promise<CardProofResult> {
  const p = live.get(markerId) ?? (await readAll())[markerId] ?? null
  if (!p || p.first.length === 0) {
    return { status: 'none', line: 'The card check couldn’t run: JakeTunes has no record of what the first sync wrote. Playing the last song on the iPod is the check.' }
  }
  // Read back only what the Mac can no longer be holding in memory.
  const replugged = p.run === runId ? plugCount > p.plug : plugCount >= 2
  if (!replugged) return { status: 'waiting', line: 'Unplug the iPod and plug it back in. Then JakeTunes reads back the first and last songs it wrote, to check the card (about a minute).' }
  let checked = 0
  let bad = 0
  for (const s of [...p.first, ...p.last]) {
    const path = join(mount, s.rel)
    let size: number
    try { size = (await stat(path)).size } catch { continue }   // a later sync took the song off: not the card's fault
    checked++
    if (size !== s.size || (await md5OfFile(path).catch(() => '')) !== s.md5) bad++
  }
  if (checked === 0) return { status: 'none', line: 'The card check couldn’t run: none of the songs it sampled are on the iPod any more.' }
  if (bad > 0) {
    return { status: 'fail', checked, bad, line: `The card didn’t keep what was written: ${bad} of the ${checked} songs read back came back different. This card is not sound, or not the size it says. Don’t trust this iPod until the card is replaced.` }
  }
  return { status: 'pass', checked, line: `Card check passed: the first and last songs written (${checked} of them) read back exactly as written.` }
}

/**
 * Picked artist photos (2026-11-03): the desktop's half of homemini's GET /api/artist-photo-picks
 * (JakeTunesMobile util/artistPhotoPicks.ts). Jake, on the Now Digging card: "this picture of
 * Cameron winter is trash". Deezer's Cameron Winter is a red-lit selfie with his face hidden, and
 * artist-photo.ts would put it back at its next 30-day refresh whatever was saved over it.
 *
 * So homemini keeps the picks, and this:
 *   1. pulls the list (ETag + 304) on launch and every 3 hours, and keeps it in userData so a
 *      launch away from homemini still honours it;
 *   2. saves each picked photo as that act's artist-image (<slug>.jpg) from GET
 *      /api/artist-photo/<file>, only when the bytes on disk are not already it. The file name is
 *      the photo's content address, so a download is checked against it;
 *   3. answers isPicked(slug) for artist-photo.ts, whose Deezer refresh leaves a picked act alone.
 * Photos asked for in the first moments of a launch wait for the first pull (ready(), capped at
 * 1.5 s), so the picked face is the first one drawn.
 *
 * Pure of electron: fetch, the folders and the clock are injected (__tests__/artist-photo-picks.test.ts).
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withCompanionInit } from './hub-companion.ts'
import { artistSlug } from './artist-photo.ts'

export interface ArtistPhotoPick { artist: string; slug: string; file: string }

const PHOTO_FILE = /^[0-9a-f]{16}\.jpg$/
const MAX_PHOTO_BYTES = 12 * 1024 * 1024
export const PICKS_EVERY_MS = 3 * 3600 * 1000
export const PICKS_READY_CAP_MS = 1500

/** homemini's photo file name for these bytes: sha1, first 16 hex (⚠️ TWIN: JakeTunesMobile artistProfileDoc.ts photoFileFor). */
export const photoFileOf = (bytes: Uint8Array): string => `${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}.jpg`

/** GET /api/artist-photo-picks, or null when it is not that document. A row whose slug is not its artist's is dropped. */
export function parsePhotoPicks(raw: unknown): ArtistPhotoPick[] | null {
  const o = raw as { v?: unknown; picks?: unknown } | null
  if (!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.picks)) return null
  const out: ArtistPhotoPick[] = []
  for (const p of o.picks as unknown[]) {
    const r = (p ?? {}) as Record<string, unknown>
    if (typeof r.artist !== 'string' || typeof r.slug !== 'string' || typeof r.file !== 'string') continue
    if (!PHOTO_FILE.test(r.file) || artistSlug(r.artist) !== r.slug) continue
    out.push({ artist: r.artist, slug: r.slug, file: r.file })
  }
  return out
}

export interface PicksFetchReply {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}
export type PicksFetchLike = (url: string, init?: Record<string, unknown>) => Promise<PicksFetchReply>

export interface ArtistPhotoPicksOptions {
  /** homemini backend origin, e.g. http://homemini:3000. */
  baseUrl: string
  /** The artist-image:// folder (userData/artist-images). */
  dir: string
  /** The last list homemini sent (userData/artist-photo-picks.json). */
  stateFile: string
  fetchImpl?: PicksFetchLike
  /** A photo saved (console.log by default). */
  log?: (msg: string) => void
  /** A problem, once per change of problem (console.warn by default). */
  warn?: (msg: string) => void
  timeoutMs?: number
}

export function createArtistPhotoPicks(opts: ArtistPhotoPicksOptions) {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as PicksFetchLike)
  const log = opts.log ?? ((m: string) => console.log(m))
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const timeoutMs = opts.timeoutMs ?? 15_000
  const base = opts.baseUrl.replace(/\/+$/, '')
  let picks = new Map<string, ArtistPhotoPick>()
  let etag = ''
  let lastProblem = ''
  let loading: Promise<void> | null = null
  let first: Promise<void> | null = null

  /** Log a problem once per change of problem, not every tick. */
  const problem = (what: string): void => {
    if (what !== lastProblem) warn(`[artist-photo-picks] ${what}`)
    lastProblem = what
  }

  /** The list the last pull saved (read once per run). */
  const load = (): Promise<void> => (loading ??= (async () => {
    try {
      const saved = JSON.parse(await readFile(opts.stateFile, 'utf8')) as { etag?: unknown }
      const list = parsePhotoPicks(saved)
      if (list) {
        picks = new Map(list.map((p) => [p.slug, p]))
        etag = typeof saved.etag === 'string' ? saved.etag : ''
      }
    } catch { /* first run, or unreadable: start empty */ }
  })())

  const save = async (): Promise<void> => {
    const tmp = `${opts.stateFile}.tmp`
    await writeFile(tmp, JSON.stringify({ v: 1, etag, picks: [...picks.values()] }))
    await rename(tmp, opts.stateFile)
  }

  /** Make <slug>.jpg the picked photo; true when the file changed. */
  const apply = async (p: ArtistPhotoPick): Promise<boolean> => {
    const jpg = join(opts.dir, `${p.slug}.jpg`)
    const have = await readFile(jpg).catch(() => null)
    if (have && photoFileOf(have) === p.file) return false
    let bytes: Buffer
    try {
      const res = await fetchImpl(`${base}/api/artist-photo/${p.file}`, withCompanionInit({ signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
      if (!res.ok) { problem(`${p.artist}: photo ${p.file} answered HTTP ${res.status}`); return false }
      bytes = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      problem(`${p.artist}: photo download failed (${(err as Error)?.message ?? err})`)
      return false
    }
    if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES || photoFileOf(bytes) !== p.file) {
      problem(`${p.artist}: photo ${p.file} came back as other bytes; not saved`)
      return false
    }
    await mkdir(opts.dir, { recursive: true })
    const tmp = `${jpg}.tmp-${process.pid}`
    await writeFile(tmp, bytes)
    await rename(tmp, jpg)
    await unlink(join(opts.dir, `${p.slug}.miss`)).catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== 'ENOENT') warn(`[artist-photo-picks] ${p.slug}.miss could not be removed (${err?.message ?? err})`)
    })
    log(`[artist-photo-picks] ${p.artist}: saved the picked photo (${p.file})`)
    return true
  }

  /** One pull: the list (304 while nothing moved), then every picked photo onto disk. Returns the slugs that changed. */
  const pull = async (): Promise<string[]> => {
    await load()
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (etag) headers['If-None-Match'] = etag
      const res = await fetchImpl(`${base}/api/artist-photo-picks`, withCompanionInit({ headers, signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
      if (res.status === 200) {
        const list = parsePhotoPicks(await res.json().catch(() => null))
        if (!list) {
          problem('homemini sent a picks list this desktop cannot read; keeping the saved one')
        } else {
          picks = new Map(list.map((p) => [p.slug, p]))
          etag = res.headers.get('etag') ?? ''
          lastProblem = ''
          await save().catch((err) => problem(`saving the list failed (${(err as Error)?.message ?? err})`))
        }
      } else if (res.status === 304) {
        lastProblem = ''
      } else if (res.status !== 404) {
        // 404 is a homemini without picks yet; anything else is worth one line.
        problem(`homemini answered HTTP ${res.status}; keeping the saved list`)
      }
    } catch (err) {
      problem(`homemini unreachable (${(err as Error)?.message ?? err}); keeping the saved list`)
    }
    const changed: string[] = []
    for (const p of picks.values()) if (await apply(p)) changed.push(p.slug)
    return changed
  }

  return {
    pull,
    isPicked: (slug: string): boolean => picks.has(slug),
    /** Resolves (never rejects) once the first pull is done or PICKS_READY_CAP_MS has passed;
     *  before start(), once the saved list is read. */
    ready: (): Promise<void> => first ?? load(),
    start(): void {
      const tick = (): Promise<void> => pull().then(() => {}, (err: unknown) => warn(`[artist-photo-picks] pull failed (${(err as Error)?.message ?? err})`))
      first = Promise.race([tick(), new Promise<void>((resolve) => setTimeout(resolve, PICKS_READY_CAP_MS))])
      // unref: the refresh never holds a process open on its own (tests; the app lives by Electron).
      setInterval(() => { void tick() }, PICKS_EVERY_MS).unref?.()
    },
  }
}

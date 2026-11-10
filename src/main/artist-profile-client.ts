/**
 * Artist profile client (2026-10-20) — the desktop's half of homemini's
 * pre-built artist profiles (the contract: src/common/artist-profile.ts).
 *
 * Jake: the old pages had "bios loading late and often wrong". So the page
 * paints from what is on disk, instantly, and this client refreshes behind it:
 *
 *   1. read(name) — the cached profile (userData/artist-profiles/<name>.json)
 *      or nothing. No network, ever. A cached 404 reads as 'missing'.
 *   2. refresh(name) — one GET with If-None-Match once a copy is cached
 *      (usually a 304), and it answers as soon as that text is saved. Every
 *      photo the profile names is then fetched once into the artist-image
 *      folder, a few at a time, behind the answer (served by artist-image://;
 *      photos are immutable, so a saved one is never fetched again). Each one
 *      that lands is announced through onUpdate with the new state
 *      (2026-11-10: the text homemini returned in 14 ms used to wait for
 *      every photo, up to 15 s each when away).
 *   2b. readAll() — every cached profile, for the page's first frame.
 *   3. 404 → 'missing': the page falls back to its Wikipedia summary with no
 *      members. Homemini away / 5xx / junk → the cache stands untouched.
 *
 * Plus Jake's override: putMemberPhoto() hands homemini the picture he chose
 * for a member and re-reads the profile so the new photo shows.
 *
 * Pure of electron — fetch, the folders and the clock are injected, so it
 * runs under node:test (__tests__/artist-profile-client.test.ts).
 */
import { readFile, readdir, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'
import {
  artistPhotoFileOf, artistProfilePath, emptyProfileState, memberPhotoPath, profilePhotoUrls, parseArtistProfile, photoCacheSlug, profileCacheFile, ARTIST_PHOTO_PREFIX,
  type ArtistProfile, type ArtistProfileState,
} from '../common/artist-profile.ts'

export interface ProfileFetchReply {
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer?(): Promise<ArrayBuffer>
  headers?: { get(name: string): string | null }
}
export type ProfileFetchLike = (url: string, init?: Record<string, unknown>) => Promise<ProfileFetchReply>

/** A visit closer than this to the last ask reuses it (a page re-mount, a back-and-forth). */
export const PROFILE_MIN_GAP_MS = 60_000
/** Biggest photo we will save (homemini serves 900×900 JPEGs, ~100–400 KB). */
const MAX_PHOTO_BYTES = 12 * 1024 * 1024

export interface ArtistProfileClientOptions {
  /** homemini backend origin, e.g. http://homemini:3000 (no trailing slash). */
  baseUrl: string
  /** Where the per-artist profile cache lives (userData/artist-profiles). */
  profileDir: string
  /** The artist-image:// folder (userData/artist-images). */
  photoDir: string
  fetchImpl?: ProfileFetchLike
  now?: () => number
  warn?: (key: string, msg: string) => void
  timeoutMs?: number
  photoTimeoutMs?: number
  putTimeoutMs?: number
  /** A photo of this artist's profile just landed on disk (or the last one was given up on). */
  onUpdate?: (state: ArtistProfileState) => void
}

/** Photos of one profile fetched at the same time. */
export const PHOTO_FETCH_CONCURRENCY = 4
/** The most cached profiles readAll hands over (newest first). */
export const READ_ALL_LIMIT = 600

interface CacheFile { name: string; doc: unknown; etag: string | null; confirmedAt: number; missing?: boolean }

export type MemberPhotoResult = { ok: true; state: ArtistProfileState } | { ok: false; error: string }

export interface ArtistProfileClient {
  read(name: string): Promise<ArtistProfileState>
  /** Answers once the profile TEXT is saved; photos land behind it (onUpdate). `waitPhotos` waits for them too. */
  refresh(name: string, opts?: { force?: boolean; waitPhotos?: boolean }): Promise<ArtistProfileState>
  /** Every cached profile (newest first, at most `limit`). No network. `complete` = nothing was left out. */
  readAll(limit?: number): Promise<{ states: ArtistProfileState[]; complete: boolean }>
  /** Resolves when this artist's photo downloads are done (or at once when none run). */
  photosSettled(name: string): Promise<void>
  /** Resolves when no photo download is running for any artist (tests wait on it before they remove their folders). */
  idle(): Promise<void>
  /** Jake's own photo of one member → homemini. `jpeg` is already normalized. */
  putMemberPhoto(artist: string, member: string, jpeg: Uint8Array): Promise<MemberPhotoResult>
}

export function createArtistProfileClient(opts: ArtistProfileClientOptions): ArtistProfileClient {
  const fetchImpl: ProfileFetchLike = opts.fetchImpl ?? (fetch as unknown as ProfileFetchLike)
  const now = opts.now ?? Date.now
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const timeoutMs = opts.timeoutMs ?? 6000
  const photoTimeoutMs = opts.photoTimeoutMs ?? 15_000
  const putTimeoutMs = opts.putTimeoutMs ?? 30_000
  const base = opts.baseUrl.replace(/\/+$/, '')

  const liveThisSession = new Set<string>()
  const lastAsk = new Map<string, number>()
  /** Artists whose last answer was 404 ("not built yet"): asked again on every visit, whatever the gap. */
  const lastWasMissing = new Set<string>()
  const inFlight = new Map<string, Promise<ArtistProfileState>>()
  let wasUnreachable = false

  const key = (name: string) => String(name || '').trim()
  const cachePath = (name: string) => join(opts.profileDir, profileCacheFile(key(name)))
  const photoPath = (slug: string) => join(opts.photoDir, `${slug}.jpg`)

  async function readCache(name: string): Promise<{ profile: ArtistProfile | null; raw: unknown; etag: string | null; missing: boolean; confirmedAt: number } | null> {
    let raw: Partial<CacheFile> | null = null
    try { raw = JSON.parse(await readFile(cachePath(name), 'utf-8')) as Partial<CacheFile> } catch { return null /* none yet, or torn — treated as absent */ }
    if (!raw || typeof raw !== 'object' || key(raw.name ?? '').toLowerCase() !== key(name).toLowerCase()) return null
    const confirmedAt = typeof raw.confirmedAt === 'number' ? raw.confirmedAt : 0
    if (raw.missing) return { profile: null, raw: null, etag: null, missing: true, confirmedAt }
    const profile = parseArtistProfile(raw.doc)
    if (!profile) return null
    return { profile, raw: raw.doc, etag: typeof raw.etag === 'string' ? raw.etag : null, missing: false, confirmedAt }
  }

  async function writeCache(name: string, file: Omit<CacheFile, 'name' | 'confirmedAt'>): Promise<void> {
    await writeJsonAtomic(cachePath(name), { name: key(name), ...file, confirmedAt: now() }, false)
  }

  async function savedPhotos(profile: ArtistProfile | null): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const url of profilePhotoUrls(profile)) {
      const file = artistPhotoFileOf(url)
      if (!file) continue
      const slug = photoCacheSlug(file)
      const st = await stat(photoPath(slug)).catch(() => null)
      if (st && st.isFile() && st.size > 0) out[url] = slug
    }
    return out
  }

  async function read(name: string): Promise<ArtistProfileState> {
    const n = key(name)
    if (!n) return emptyProfileState(n)
    const cache = await readCache(n)
    if (!cache) return emptyProfileState(n, 'none')
    if (cache.missing) return { ...emptyProfileState(n, 'missing'), fetchedAt: cache.confirmedAt || null }
    return {
      name: n,
      profile: cache.profile,
      source: liveThisSession.has(n.toLowerCase()) ? 'homemini' : 'cache',
      photos: await savedPhotos(cache.profile),
      fetchedAt: cache.confirmedAt || null,
    }
  }

  function noteReachable(ok: boolean, why?: string): void {
    if (ok && wasUnreachable) { wasUnreachable = false; warn('reachable', '[artist-profile] homemini reachable again') }
    if (!ok && !wasUnreachable) {
      wasUnreachable = true
      warn('unreachable', `[artist-profile] homemini unreachable (${why ?? 'no answer'}) — artist pages draw their cached profile, or the Wikipedia summary`)
    }
  }

  async function fetchProfile(n: string): Promise<void> {
    const cache = await readCache(n)
    const url = `${base}${artistProfilePath(n)}`
    let res: ProfileFetchReply
    try {
      const conditional = cache?.etag ? { headers: { 'If-None-Match': cache.etag } } : {}
      res = await fetchImpl(url, withCompanionInit({ ...conditional, signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
    } catch (err) {
      liveThisSession.delete(n.toLowerCase())
      noteReachable(false, err instanceof Error ? err.message : String(err))
      return
    }
    if (res.status === 304 && cache && !cache.missing) {
      noteReachable(true)
      liveThisSession.add(n.toLowerCase())
      await writeCache(n, { doc: cache.raw, etag: cache.etag })   // confirmed fresh: restart its age
      return
    }
    if (res.status === 404) {
      // No profile for this artist (not built yet, or withdrawn because the
      // identity didn't hold). Better empty than wrong: drop any old copy.
      noteReachable(true)
      liveThisSession.delete(n.toLowerCase())
      lastWasMissing.add(n.toLowerCase())
      await writeCache(n, { doc: null, etag: null, missing: true })
      return
    }
    if (!res.ok) {
      liveThisSession.delete(n.toLowerCase())
      noteReachable(false, `GET ${res.status}`)
      return
    }
    const body = await res.json().catch((err: unknown) => {
      warn('body', `[artist-profile] ${n}: unreadable reply (${err instanceof Error ? err.message : String(err)})`)
      return null
    })
    const profile = parseArtistProfile(body)
    if (!profile) {
      warn('shape', `[artist-profile] ${n}: reply is not a profile document — keeping what is cached`)
      return
    }
    noteReachable(true)
    liveThisSession.add(n.toLowerCase())
    lastWasMissing.delete(n.toLowerCase())
    await writeCache(n, { doc: body, etag: res.headers?.get('etag') ?? null })
  }

  /** One photo → the artist-image folder. True when it is on disk afterwards. */
  async function fetchPhoto(n: string, url: string): Promise<boolean> {
    const file = artistPhotoFileOf(url)
    if (!file) return false
    const dest = photoPath(photoCacheSlug(file))
    const st = await stat(dest).catch(() => null)
    if (st && st.isFile() && st.size > 0) return false                // already saved: nothing new to announce
    try {
      const res = await fetchImpl(`${base}${ARTIST_PHOTO_PREFIX}${encodeURIComponent(file)}`, withCompanionInit({ signal: AbortSignal.timeout(photoTimeoutMs) }) as Record<string, unknown>)
      const type = res.headers?.get('content-type') ?? 'image/jpeg'
      if (!res.ok || !res.arrayBuffer || !/^image\//i.test(type)) {
        warn(`photo:${file}`, `[artist-profile] ${n}: photo ${file} unavailable (HTTP ${res.status}, ${type})`)
        return false
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) {
        warn(`photo:${file}`, `[artist-profile] ${n}: photo ${file} refused (${bytes.length} bytes)`)
        return false
      }
      await mkdir(opts.photoDir, { recursive: true })
      const tmp = `${dest}.${process.pid}.${now()}.tmp`
      await writeFile(tmp, bytes)
      await rename(tmp, dest).catch(async (err: unknown) => {
        await unlink(tmp).catch((e: unknown) => warn('photo-tmp', `[artist-profile] could not remove ${tmp}: ${e instanceof Error ? e.message : String(e)}`))
        throw err
      })
      return true
    } catch (err) {
      warn(`photo:${file}`, `[artist-profile] ${n}: photo ${file} not saved (${err instanceof Error ? err.message : String(err)})`)
      return false
    }
  }

  /**
   * Each photo once (the credited header photo first, then the members'), a
   * few at a time; immutable, so a saved file is never fetched again. Every
   * photo that lands is announced on its own, so a tile fills the moment its
   * picture is here instead of when the slowest one is.
   */
  async function fetchPhotos(n: string): Promise<void> {
    const cache = await readCache(n)
    const urls = profilePhotoUrls(cache?.profile)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < urls.length) {
        const url = urls[next++]
        if (await fetchPhoto(n, url) && opts.onUpdate) {
          try { opts.onUpdate(await read(n)) } catch (err) { warn('on-update', `[artist-profile] ${n}: update not delivered: ${err instanceof Error ? err.message : String(err)}`) }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PHOTO_FETCH_CONCURRENCY, urls.length) }, worker))
  }

  const photoRuns = new Map<string, Promise<void>>()
  function startPhotos(n: string): Promise<void> {
    const k = n.toLowerCase()
    const running = photoRuns.get(k)
    if (running) return running
    const run = fetchPhotos(n)
      .catch((err: unknown) => warn('photos', `[artist-profile] ${n}: photos failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { photoRuns.delete(k) })
    photoRuns.set(k, run)
    return run
  }
  const photosSettled = (name: string): Promise<void> => photoRuns.get(key(name).toLowerCase()) ?? Promise.resolve()
  const idle = async (): Promise<void> => { while (photoRuns.size) await Promise.all([...photoRuns.values()]) }

  function refresh(name: string, o?: { force?: boolean; waitPhotos?: boolean }): Promise<ArtistProfileState> {
    const n = key(name)
    if (!n) return Promise.resolve(emptyProfileState(n))
    const k = n.toLowerCase()
    const after = async (p: Promise<ArtistProfileState>): Promise<ArtistProfileState> => {
      if (!o?.waitPhotos) return p
      await p
      await photosSettled(n)
      return read(n)
    }
    const running = inFlight.get(k)
    if (running) return after(running)
    // A 404 is "not built yet": homemini builds a page within minutes of its first
    // visit, so the revisit asks again instead of reusing the stub for the gap.
    if (!o?.force && !lastWasMissing.has(k) && now() - (lastAsk.get(k) ?? 0) < PROFILE_MIN_GAP_MS) return after(read(n))
    lastAsk.set(k, now())
    const p = (async () => {
      try {
        await fetchProfile(n)
      } catch (err) {
        warn('refresh', `[artist-profile] ${n}: refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      // The text is saved: answer now. The photos follow behind, each announced as it lands.
      void startPhotos(n)
      return read(n)
    })().finally(() => { inFlight.delete(k) })
    inFlight.set(k, p)
    return after(p)
  }

  async function readAll(limit = READ_ALL_LIMIT): Promise<{ states: ArtistProfileState[]; complete: boolean }> {
    let files: string[]
    try { files = (await readdir(opts.profileDir)).filter((f) => f.endsWith('.json')) } catch { return { states: [], complete: true } }
    const dated = await Promise.all(files.map(async (f) => ({ f, at: (await stat(join(opts.profileDir, f)).catch(() => null))?.mtimeMs ?? 0 })))
    dated.sort((a, b) => b.at - a.at)
    const states: ArtistProfileState[] = []
    for (const { f } of dated.slice(0, limit)) {
      let named = ''
      try { named = key(String((JSON.parse(await readFile(join(opts.profileDir, f), 'utf-8')) as Partial<CacheFile>).name ?? '')) } catch { continue /* torn: absent, as read() treats it */ }
      if (!named || profileCacheFile(named) !== f) continue
      const s = await read(named)
      if (s.source !== 'none') states.push(s)
    }
    return { states, complete: dated.length <= limit }
  }

  async function putMemberPhoto(artist: string, member: string, jpeg: Uint8Array): Promise<MemberPhotoResult> {
    const n = key(artist)
    const cache = n ? await readCache(n) : null
    const person = cache?.profile?.members?.people.find((p) => p.name === member)
    if (!person) return { ok: false, error: `${member || 'That member'} is not on this page's lineup any more — reopen the page and try again.` }
    if (!jpeg || jpeg.length === 0) return { ok: false, error: 'That file could not be read as a picture.' }
    let res: ProfileFetchReply
    try {
      res = await fetchImpl(`${base}${memberPhotoPath(n, person.name)}`, withCompanionInit({
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: jpeg as unknown as BodyInit,
        signal: AbortSignal.timeout(putTimeoutMs),
      }) as Record<string, unknown>)
    } catch (err) {
      warn('put', `[artist-profile] member photo for ${member} (${n}) not sent: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: 'homemini is unreachable, so the photo was not saved. Try again when it is back.' }
    }
    const reply = await res.json().catch(() => null) as { ok?: unknown; error?: unknown } | null
    const why = reply && typeof reply.error === 'string' && reply.error ? reply.error : ''
    if (!res.ok || (reply && reply.ok === false)) {
      warn('put', `[artist-profile] member photo for ${member} (${n}) refused: HTTP ${res.status}${why ? ` (${why})` : ''}`)
      if (res.status === 404 && !why) return { ok: false, error: 'homemini does not take member photos yet. Nothing was changed.' }
      if (res.status === 413) return { ok: false, error: 'That picture is too big for homemini. Try a smaller one.' }
      return { ok: false, error: `homemini could not save the photo (${why || `HTTP ${res.status}`}). Nothing was changed.` }
    }
    return { ok: true, state: await refresh(n, { force: true, waitPhotos: true }) }
  }

  return { read, refresh, readAll, photosSettled, idle, putMemberPhoto }
}

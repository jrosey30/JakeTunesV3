/**
 * Artist photos (2026-10-11 rebuild). The old sources both died — Bandsintown
 * now answers 403, TheAudioDB's free key 404s — and a failed refresh wrote a
 * "miss" that hid photos already on disk (2Pac's from August), so the Artists
 * page went to initials.
 *
 * Now: Deezer, and only the Deezer artist one of Jake's albums or songs proves
 * is HIS (the MESH lesson: a name is not an identity). The confirmed artist's
 * fan count is kept in artist-deezer.json alongside the photo. A photo already on disk is never hidden by a failed refresh,
 * and never held back by a refresh that is due: it is returned at once and refreshed behind (2026-11-10).
 *
 * Electron-free; fetch, clock and file locations are injected for tests.
 */
import { join } from 'path'
import { createHash } from 'crypto'
import { readFile, writeFile, rename, stat, unlink, mkdir, readdir } from 'fs/promises'

export const PHOTO_MAX_AGE_MS = 30 * 24 * 3600 * 1000
export const MISS_TTL_MS = 6 * 3600 * 1000
/** A refresh that could not finish (Deezer away, nothing newer) is not tried again sooner than this. */
export const REFRESH_RETRY_MS = 6 * 3600 * 1000
/** Pause between two background refreshes, so a first lookup for a page never waits behind a long line of them. */
export const REFRESH_GAP_MS = 1000

/**
 * When a photo on disk is due a refresh: 30 days plus up to 30 more, fixed per
 * artist. 1,399 photos were all fetched on 2026-10-18; with one shared age
 * they would all fall due on the same day. Spread, that is about 47 a day.
 */
export function photoMaxAgeMs(slug: string): number {
  const spread = createHash('sha1').update(slug).digest().readUInt32BE(0) / 0x1_0000_0000
  return PHOTO_MAX_AGE_MS + Math.floor(spread * PHOTO_MAX_AGE_MS)
}
const API = 'https://api.deezer.com'

/** Filename-safe and stable. Names with no Latin letters (ברי סחרוף, Молчат
 *  Дома) used to collapse to 'unknown' and could never have a photo. */
export function artistSlug(name: string): string {
  const ascii = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  if (/[a-z0-9]/.test(ascii) && !/[^\x00-\x7f]/.test(String(name).normalize('NFKD').replace(/[̀-ͯ]/g, ''))) return ascii
  const trimmed = String(name || '').trim()
  return trimmed ? `u-${createHash('sha1').update(trimmed.toLowerCase()).digest('hex').slice(0, 16)}` : 'unknown'
}

/** Name key: accents folded, every script kept, "&" = "and", leading "the" dropped. */
export function nameKey(s: string | undefined): string {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/^the /, '')
}
/** Title key: "(Remastered 2012)" and " - Live" are the same record. */
export function titleKey(s: string | undefined): string {
  return nameKey(String(s || '').replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+-\s+.*$/, ''))
}

export interface DeezerArtist { id: number; fans: number; pic?: string }
interface DzArtist { id: number; name?: string; nb_fan?: number; picture_xl?: string; picture_big?: string; type?: string }

/**
 * The Deezer artist that is provably Jake's: every exact-name page, most fans
 * first; the first whose discography has one of his albums, or whose top
 * tracks include his songs (two when he has two) — duplicate pages split an
 * artist and the big one must win. No owned albums/songs (a Record Shop card
 * for someone he doesn't own yet): the biggest exact-name page.
 * Returns null when nothing confirms, undefined when Deezer couldn't be asked.
 */
export async function findDeezerArtist(
  name: string,
  owned: { albums: string[]; titles: string[] },
  fetchJson: (url: string) => Promise<unknown>,
): Promise<DeezerArtist | null | undefined> {
  const want = nameKey(name)
  if (!want) return null
  const hits = new Map<number, DzArtist>()
  for (const q of [`artist:"${name}"`, name]) {
    const d = await fetchJson(`${API}/search/artist?q=${encodeURIComponent(q)}&limit=25`) as { data?: DzArtist[] } | undefined
    if (!d) return undefined
    for (const x of d.data ?? []) if (nameKey(x.name) === want) hits.set(x.id, x)
  }
  const ranked = [...hits.values()].sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))
  const pack = (x: DzArtist): DeezerArtist => ({ id: x.id, fans: x.nb_fan ?? 0, pic: x.picture_xl || x.picture_big })
  const albums = new Set(owned.albums.map(titleKey).filter(Boolean))
  const titles = new Set(owned.titles.map(titleKey).filter(Boolean))
  if (!albums.size && !titles.size) return ranked[0] ? pack(ranked[0]) : null
  const need = Math.min(2, titles.size)
  for (const x of ranked) {
    const al = await fetchJson(`${API}/artist/${x.id}/albums?limit=200`) as { data?: Array<{ title?: string }> } | undefined
    if (!al) return undefined
    const theirs = (al.data ?? []).map((a) => titleKey(a.title))
    if ([...albums].some((m) => theirs.some((t) => t === m || (m.length > 4 && (t.includes(m) || m.includes(t)))))) return pack(x)
    if (!need) continue
    const top = await fetchJson(`${API}/artist/${x.id}/top?limit=50`) as { data?: Array<{ title?: string }> } | undefined
    if (!top) return undefined
    const hitsTop = new Set((top.data ?? []).map((t) => titleKey(t.title)).filter((t) => titles.has(t)))
    if (hitsTop.size >= need) return pack(x)
  }
  return null
}

export interface ArtistFacts { dz?: number; fans?: number; pic?: string; none?: boolean; at: number }

export interface PhotoDeps {
  dir: string                     // userData/artist-images
  factsFile: string               // userData/artist-deezer.json — keyed by artist name
  owned(artist: string): Promise<{ albums: string[]; titles: string[] }>
  fetchJson(url: string): Promise<unknown>        // undefined on any failure
  download(url: string): Promise<Buffer | null>
  now?: () => number
  /** A photo Jake picked on homemini (artist-photo-picks.ts): never refreshed from Deezer. */
  picked?: (slug: string) => boolean
  /** Waited on before each look, so a launch's first photos come after the first picks pull
   *  (capped there at 1.5 s): Jake's pick is the first picture drawn, never the photo it replaces. */
  ready?: () => Promise<void>
  /** Pause between background refreshes (tests pass 0). */
  refreshGapMs?: number
}

export interface KnownPhotos { slugs: Record<string, string>; versions: Record<string, number>; none: string[] }

export function createArtistPhotos(deps: PhotoDeps): {
  get(artist: string): Promise<string | null>
  /**
   * What the disk says about these names, from one folder listing and no network:
   * `slugs` (name → slug) for a photo that is there, with `versions` (slug → the
   * file's mtime, so a replaced photo gets a new address), and `none` for the
   * names a recent look found no photo for (a fresh .miss).
   */
  known(names: readonly string[]): Promise<KnownPhotos>
  /** The photo file's mtime (0 when there is none): part of its address, so a replaced file is never drawn from memory. */
  version(slug: string): Promise<number>
  /** Resolves when no background refresh is queued or running (tests). */
  idle(): Promise<void>
} {
  const now = deps.now ?? Date.now
  const refreshGapMs = deps.refreshGapMs ?? REFRESH_GAP_MS
  const inFlight = new Map<string, Promise<string | null>>()
  let facts: Record<string, ArtistFacts> | null = null
  let writing = Promise.resolve()
  const loadFacts = async (): Promise<Record<string, ArtistFacts>> => {
    if (!facts) { try { facts = JSON.parse(await readFile(deps.factsFile, 'utf8')) as Record<string, ArtistFacts> } catch { facts = {} } }
    return facts
  }
  const saveFacts = (): Promise<void> => {
    writing = writing.then(async () => {
      const tmp = `${deps.factsFile}.tmp`
      await writeFile(tmp, JSON.stringify(facts)); await rename(tmp, deps.factsFile)
    }).catch(() => { /* a convenience cache — next save retries */ })
    return writing
  }
  const fresh = async (p: string, ttl: number): Promise<boolean> => { try { return now() - (await stat(p)).mtimeMs < ttl } catch { return false } }
  const exists = async (p: string): Promise<boolean> => { try { await stat(p); return true } catch { return false } }

  /** Confirmed identity for one artist, looked up (and remembered) when unknown or old. */
  const factFor = async (artist: string): Promise<ArtistFacts | undefined> => {
    const all = await loadFacts()
    const f = all[artist]
    if (f && now() - f.at <= PHOTO_MAX_AGE_MS) return f
    const found = await findDeezerArtist(artist, await deps.owned(artist), deps.fetchJson)
    if (found === undefined) return f
    all[artist] = found ? { dz: found.id, fans: found.fans, pic: found.pic, at: now() } : { none: true, at: now() }
    void saveFacts()
    return all[artist]
  }

  const saveJpg = async (jpg: string, buf: Buffer): Promise<void> => {
    // tmp + rename: the old photo is being served while its replacement lands.
    const tmp = `${jpg}.${process.pid}.tmp`
    await writeFile(tmp, buf)
    await rename(tmp, jpg).catch(async (err: unknown) => { await unlink(tmp).catch(() => {}); throw err })
  }

  // ── background refresh of a photo that is already on disk ──
  // One at a time, a pause between two, each artist at most once per
  // REFRESH_RETRY_MS. What may replace a photo is unchanged: only the Deezer
  // artist one of Jake's albums or songs confirms (factFor), never over his
  // own pick, and a refresh that finds nothing leaves the photo alone.
  const refreshQueue: Array<{ artist: string; slug: string }> = []
  const queued = new Set<string>()
  const lastTry = new Map<string, number>()
  let draining: Promise<void> | null = null
  const refreshOne = async (artist: string, slug: string): Promise<void> => {
    await deps.ready?.()                                             // never rejects (artist-photo-picks.ts)
    const jpg = join(deps.dir, `${slug}.jpg`), miss = join(deps.dir, `${slug}.miss`)
    if (deps.picked?.(slug)) return                                  // Jake's pick: Deezer never replaces it
    if (await fresh(jpg, photoMaxAgeMs(slug))) return                // refreshed meanwhile (a pick landed)
    if (await fresh(miss, MISS_TTL_MS)) return
    const f = await factFor(artist)
    if (!f || !f.pic) return                                         // Deezer away, or no confirmed photo: keep ours
    const buf = await deps.download(f.pic)
    if (!buf) return
    if (!(await exists(jpg))) return                                 // removed meanwhile (a pick withdrawn): the next look starts clean
    await saveJpg(jpg, buf)
    await unlink(miss).catch(() => {})
  }
  const drain = async (): Promise<void> => {
    while (refreshQueue.length) {
      const next = refreshQueue.shift()!
      queued.delete(next.slug)
      lastTry.set(next.slug, now())
      try { await refreshOne(next.artist, next.slug) } catch { /* the photo on disk stands */ }
      if (refreshQueue.length && refreshGapMs > 0) await new Promise((r) => setTimeout(r, refreshGapMs))
    }
  }
  const queueRefresh = (artist: string, slug: string): void => {
    if (queued.has(slug) || now() - (lastTry.get(slug) ?? -Infinity) < REFRESH_RETRY_MS) return
    queued.add(slug)
    refreshQueue.push({ artist, slug })
    if (!draining) draining = drain().finally(() => { draining = null })
  }

  const get = (artist: string): Promise<string | null> => {
    const slug = artistSlug(artist)
    if (slug === 'unknown') return Promise.resolve(null)
    const running = inFlight.get(slug)
    if (running) return running
    const task = (async (): Promise<string | null> => {
      // The first picks pull of a launch first (never rejects, capped at 1.5 s there,
      // already resolved after that): a pick made since the last run must be the
      // picture drawn, not the Deezer photo it replaces.
      await deps.ready?.()
      const jpg = join(deps.dir, `${slug}.jpg`), miss = join(deps.dir, `${slug}.miss`)
      // A photo on disk is the answer, at once, whatever its age (2026-11-10:
      // a photo past 30 days used to be held back until Deezer had been asked
      // again, so the card and the artist page sat without it). When it is
      // due, the refresh runs behind this answer.
      const st = await stat(jpg).catch(() => null)
      if (st) {
        if (now() - st.mtimeMs >= photoMaxAgeMs(slug)) queueRefresh(artist, slug)
        return slug
      }
      await mkdir(deps.dir, { recursive: true }).catch(() => {})
      if (await fresh(miss, MISS_TTL_MS)) return null
      const f = await factFor(artist)
      if (!f) return null                                            // Deezer unreachable: ask again next time
      if (!f.pic) {
        await writeFile(miss, '').catch(() => {})
        return null
      }
      const buf = await deps.download(f.pic)
      if (!buf) return null
      await saveJpg(jpg, buf)
      await unlink(miss).catch(() => {})
      return slug
    })()
    inFlight.set(slug, task)
    return task.finally(() => inFlight.delete(slug))
  }

  const known = async (names: readonly string[]): Promise<KnownPhotos> => {
    const out: KnownPhotos = { slugs: {}, versions: {}, none: [] }
    await deps.ready?.()                                             // as get(): after the launch's first picks pull
    let files: string[]
    try { files = await readdir(deps.dir) } catch { return out }
    const have = new Set<string>(), missed = new Set<string>()
    for (const f of files) {
      if (f.endsWith('.jpg')) have.add(f.slice(0, -4))
      else if (f.endsWith('.miss')) missed.add(f.slice(0, -5))
    }
    for (const name of names) {
      if (typeof name !== 'string' || !name) continue
      const slug = artistSlug(name)
      if (slug === 'unknown') continue
      if (have.has(slug)) {
        out.slugs[name] = slug
        if (!(slug in out.versions)) out.versions[slug] = await version(slug)
      } else if (missed.has(slug) && await fresh(join(deps.dir, `${slug}.miss`), MISS_TTL_MS)) {
        out.none.push(name)                                          // looked up within the last hours: there is none
      }
    }
    return out
  }

  const version = async (slug: string): Promise<number> => {
    try { return Math.floor((await stat(join(deps.dir, `${slug}.jpg`))).mtimeMs) } catch { return 0 }
  }

  const idle = async (): Promise<void> => { while (draining) await draining }

  return {
    get,
    known,
    version,
    idle,
  }
}

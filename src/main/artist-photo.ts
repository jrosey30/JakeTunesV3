/**
 * Artist photos (2026-10-11 rebuild). The old sources both died — Bandsintown
 * now answers 403, TheAudioDB's free key 404s — and a failed refresh wrote a
 * "miss" that hid photos already on disk (2Pac's from August), so the Artists
 * page went to initials.
 *
 * Now: Deezer, and only the Deezer artist one of Jake's albums or songs proves
 * is HIS (the MESH lesson: a name is not an identity). The confirmed artist's
 * fan count is kept too — the Artists page's Depth sort reads it. A photo already on disk is never hidden by a failed refresh.
 *
 * Electron-free; fetch, clock and file locations are injected for tests.
 */
import { join } from 'path'
import { createHash } from 'crypto'
import { readFile, writeFile, rename, stat, unlink, mkdir } from 'fs/promises'

export const PHOTO_MAX_AGE_MS = 30 * 24 * 3600 * 1000
export const MISS_TTL_MS = 6 * 3600 * 1000
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
}

export function createArtistPhotos(deps: PhotoDeps): {
  get(artist: string): Promise<string | null>
  fans(names: string[]): Promise<Record<string, number>>
} {
  const now = deps.now ?? Date.now
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

  const get = (artist: string): Promise<string | null> => {
    const slug = artistSlug(artist)
    if (slug === 'unknown') return Promise.resolve(null)
    const running = inFlight.get(slug)
    if (running) return running
    const task = (async (): Promise<string | null> => {
      const jpg = join(deps.dir, `${slug}.jpg`), miss = join(deps.dir, `${slug}.miss`)
      await mkdir(deps.dir, { recursive: true }).catch(() => {})
      const have = await exists(jpg)
      if (have && await fresh(jpg, PHOTO_MAX_AGE_MS)) return slug
      if (await fresh(miss, MISS_TTL_MS)) return have ? slug : null
      const f = await factFor(artist)
      if (!f) return have ? slug : null                              // Deezer unreachable: keep what we have
      if (!f.pic) {
        if (have) return slug                                        // never hide a photo we already have
        await writeFile(miss, '').catch(() => {})
        return null
      }
      const buf = await deps.download(f.pic)
      if (!buf) return have ? slug : null
      await writeFile(jpg, buf)
      await unlink(miss).catch(() => {})
      return slug
    })()
    inFlight.set(slug, task)
    return task.finally(() => inFlight.delete(slug))
  }

  return {
    get,
    /** Confirmed Deezer fan counts for these artists (unknown ones left out). */
    fans: async (names) => {
      const all = await loadFacts()
      const out: Record<string, number> = {}
      for (const n of names) { const f = all[n]; if (f && !f.none && typeof f.fans === 'number') out[n] = f.fans }
      return out
    },
  }
}

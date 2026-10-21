/**
 * The desktop artist discography: MusicBrainz release groups that passed the
 * release gate, each with its standard edition's tracklist. Used by
 * ArtistDetailView ("More from" and the per-album drill-down) and by the
 * Discover "You're missing" lane. Moved out of main/index.ts (2026-10-20)
 * when every release started going through common/release-gate.ts.
 *
 * Jake, 2026-10-20: "i mean you need a safety check but for making sure no
 * junk enters the fucking picture here!!!" Before the gate, this list took
 * any Album/EP release group MusicBrainz had (status was never checked), so
 * fan bootlegs filed as plain albums, a namesake's records and releases no
 * store carries all reached his artist pages.
 *
 * Cached to disk for 7 days per artist. A result the gate couldn't finish
 * (MusicBrainz or both stores unreachable) is returned but never cached, the
 * same rule as an incomplete identity check: an outage is not a fact about a
 * release, so the next visit asks again.
 */
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { createHash } from 'crypto'
import { foldAccents, nameKey } from '../common/fold-text.ts'
import { albumTitlesMatch, normAlbumTitle, type IdentityConfidence } from '../common/artist-identity.ts'
import { pickStandardRelease } from '../common/discography-pick.ts'
import {
  gateReleaseGroups, httpGateSources, fetchReleaseGroupsForGate, describeGate,
  type GetJson, type ReleaseSection,
} from '../common/release-gate.ts'

export interface DiscographyAlbum {
  title: string
  year: string  // 4-digit, or '' if unknown
  tracks: { title: string; position: number }[]
  mb?: { primaryType?: string; secondaryTypes?: string[] }  // release-group type → the artist page's sections (release-kind.ts)
}
export interface DiscographyResult {
  artist: string
  albums: DiscographyAlbum[]
  fetchedAt: number
  schemaVersion?: number
  /// The gate couldn't finish (a source was down): returned, never cached.
  incomplete?: boolean
  /// What the gate turned away, with its reasons (for audits; the renderer ignores it).
  rejected?: Array<{ title: string; reasons: string[]; notes: string[] }>
}

// Bump when the discography shape/filtering changes so old disk caches are
// ignored. v2: drop regional repackagings / hits comps via tracklist overlap
// (the US Capitol Beatles albums MusicBrainz doesn't flag as Compilation).
// 3: 2026-10-20 identity rule (Geese → Pop Songs / Duck). 4: standard
// edition, not a 3-disc bundle (3D Country); Jake's hidden releases.
// 5: the release gate (Official status, artist credit, store availability).
export const DISCO_SCHEMA_VERSION = 5
const DISCO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/// The desktop shows albums and EPs (live records have their own shelf).
const SECTIONS: ReleaseSection[] = ['album', 'ep']

type CanonicalForDiscography = { name: string; mbid: string; identity?: IdentityConfidence; incomplete?: boolean }

export interface ArtistDiscographyWorld {
  userDataDir: () => string
  appVersion: () => string
  /// The app-wide MusicBrainz throttle (one request in flight, ≥1.1s apart).
  mbThrottle: () => Promise<void>
  resolveCanonicalArtist: (name: string, opts: { libraryGenres?: string[]; libraryAlbums?: string[] }) => Promise<CanonicalForDiscography | null>
  getLibraryGenresForArtist: (name: string) => Promise<string[]>
  getLibraryAlbumsForArtist: (name: string) => Promise<string[]>
}
let world: ArtistDiscographyWorld | null = null
export function initArtistDiscography(w: ArtistDiscographyWorld): void { world = w }

function need(): ArtistDiscographyWorld {
  if (!world) throw new Error('artist-discography: initArtistDiscography was never called')
  return world
}

export function discoCachePath(artist: string): string {
  // Any script: [a-z0-9] put every Hebrew artist in one file, '_.json' — one artist's discography for all.
  const safe = Array.from(nameKey(artist, '_')).slice(0, 80).join('') || `_${createHash('md5').update(artist).digest('hex').slice(0, 12)}`
  return join(need().userDataDir(), 'discography-cache', `${safe}.json`)
}

// Stores are asked politely and one at a time: Deezer allows 50 requests
// per 5 s (we use a fraction), iTunes Search about 20 a minute.
function pacer(gapMs: number): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  let last = 0
  return () => {
    const mine = chain.then(async () => {
      const wait = Math.max(0, gapMs - (Date.now() - last))
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      last = Date.now()
    })
    chain = mine.catch(() => undefined)
    return mine
  }
}
const deezerPace = pacer(250)
const itunesPace = pacer(3000)

/// The gate's network door: MusicBrainz through the app-wide throttle (one
/// retry on 503), the stores through their own pacers. Every failure is
/// `ok: false`; the gate turns that into a transient rejection.
function gateGetJson(w: ArtistDiscographyWorld): GetJson {
  const headers = { 'User-Agent': `JakeTunes/${w.appVersion()} (jacobrosenbaum@gmail.com)`, Accept: 'application/json' }
  return async (url, source) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (source === 'musicbrainz') await w.mbThrottle()
      else await (source === 'deezer' ? deezerPace : itunesPace)()
      try {
        const res = await fetch(url, { headers: source === 'musicbrainz' ? headers : { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
        if (res.ok) return { ok: true, json: await res.json() }
        if (res.status === 503 && source === 'musicbrainz' && attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue }
        return { ok: false, status: res.status }
      } catch {
        return { ok: false, status: null }
      }
    }
    return { ok: false, status: 503 }
  }
}

async function writeCache(path: string, result: DiscographyResult): Promise<void> {
  try {
    await mkdir(join(need().userDataDir(), 'discography-cache'), { recursive: true })
    await writeFile(path, JSON.stringify(result), 'utf-8')
  } catch (err) {
    console.warn('[discography] cache write failed:', err)
  }
}

/// A cold run takes a while (MusicBrainz at 1 req/s, then the stores, then
/// the tracklists): the artist page and the Discover lane asking for the
/// same artist meanwhile join it instead of starting a second.
const inFlight = new Map<string, Promise<DiscographyResult | null>>()

export function fetchArtistDiscography(artist: string): Promise<DiscographyResult | null> {
  const key = nameKey(artist, '_') || artist
  const running = inFlight.get(key)
  if (running) return running
  const run = fetchArtistDiscographyOnce(artist).finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

async function fetchArtistDiscographyOnce(artist: string): Promise<DiscographyResult | null> {
  const w = need()
  const cachePath = discoCachePath(artist)
  // Cache hit
  try {
    const raw = await readFile(cachePath, 'utf-8')
    const cached = JSON.parse(raw) as DiscographyResult
    if (cached.schemaVersion === DISCO_SCHEMA_VERSION && !cached.incomplete && cached.fetchedAt && Date.now() - cached.fetchedAt < DISCO_CACHE_TTL_MS) {
      return cached
    }
  } catch { /* miss */ }

  const headers = {
    'User-Agent': `JakeTunes/${w.appVersion()} (jacobrosenbaum@gmail.com)`,
    'Accept': 'application/json',
  }
  const getJson = gateGetJson(w)

  try {
    // 1. Resolve artist MBID via the canonical resolver — uses library
    //    genre context to pick the right entity for common names. Old
    //    in-line `.find(exact-name-match) ?? first` consistently picked
    //    the wrong "Drake" / "Beck" / "Bush" MBID, giving the user
    //    someone else's discography on common-name artists.
    const libraryGenres = await w.getLibraryGenresForArtist(artist)
    const libraryAlbums = await w.getLibraryAlbumsForArtist(artist)
    const canon = await w.resolveCanonicalArtist(artist, { libraryGenres, libraryAlbums })
    if (!canon) return null
    const mbid = canon.mbid
    // A stranger's discography is worse than none (Jake, 10/20: "what is
    // duck and pop songs???"). Cached empty so the page stops asking.
    const refuse = async (why: string): Promise<DiscographyResult> => {
      console.warn(`[discography] ${artist}: ${why} — showing none`)
      const empty: DiscographyResult = { artist, albums: [], fetchedAt: Date.now(), schemaVersion: DISCO_SCHEMA_VERSION }
      await writeCache(cachePath, empty)
      return empty
    }
    // The gate admits nothing without a confirmed identity, so don't page a
    // namesake's whole catalogue to be told so (a 'weak' SebastiAn resolves
    // to a classical giant with thousands of release groups).
    if (canon.identity === 'ambiguous' || canon.identity === 'weak' || !canon.identity) {
      if (canon.incomplete) return null  // MusicBrainz hiccup — try again next visit, cache nothing
      return refuse(canon.identity === 'ambiguous' ? `namesakes the library can't tell apart (${mbid})` : `no MusicBrainz artist claims this exact name (best guess ${mbid})`)
    }

    // 2. Every Album/EP release group (with artist credits), then the gate:
    //    identity, Jake's hidden list, type, credit, bootleg vocabulary,
    //    Official status, store availability (common/release-gate.ts).
    const browse = await fetchReleaseGroupsForGate(mbid, SECTIONS, getJson)
    if (!browse.complete && browse.groups.length === 0) return null  // MusicBrainz down — nothing to judge, cache nothing
    const gate = await gateReleaseGroups({
      artist,
      artistNames: [canon.name],
      mbid,
      identity: canon.identity ?? null,
      identityIncomplete: canon.incomplete,
      sections: SECTIONS,
      releaseGroups: browse.groups,
      ownedAlbums: libraryAlbums,
    }, { fold: nameKey, normTitle: normAlbumTitle, albumMatch: albumTitlesMatch, ...httpGateSources(getJson, SECTIONS) })
    console.warn(`[discography] ${artist}: gate ${describeGate(gate)}`)
    if (!gate.identity.ok) {
      if (!gate.complete) return null
      return refuse(`${gate.identity.why} (${mbid})`)
    }
    let incomplete = !browse.complete || !gate.complete
    const byId = new Map(browse.groups.map((g) => [g.id, g]))
    const rgs = gate.verdicts
      .filter((v) => v.admitted)
      .map((v) => byId.get(v.id)!)
      .sort((x, y) => (y.firstReleaseDate || '').localeCompare(x.firstReleaseDate || ''))
      .slice(0, 30)  // cap at 30 release groups per artist — keeps fetch under ~35s worst-case
      // Then process OLDEST-first so the tracklist-overlap dedup below keeps the
      // ORIGINAL album and drops later repackagings of it.
      .sort((x, y) => (x.firstReleaseDate || '').localeCompare(y.firstReleaseDate || ''))

    const albums: DiscographyAlbum[] = []
    // Tracklist-overlap dedup: MusicBrainz tags the US Capitol/Vee-Jay Beatles
    // albums (Meet The Beatles!, Beatles VI, …) as plain "Album", so type alone
    // can't catch them. Track which song titles we've already kept (oldest-
    // first); if a later album is mostly the same songs, it's a repackaging.
    const seenTitles = new Set<string>()
    const normTrackTitle = (s: string) => foldAccents(s).replace(/[^a-z0-9]/g, '')
    // 3. For each release group, fetch one release with recordings (the
    // tracklist). Sequential because of the rate limit.
    for (const rg of rgs) {
      try {
        await w.mbThrottle()
        // Every edition, then pick the plain one — MB's first-listed release can
        // be a 3-disc bundle (3D Country: album + covers + live, all concatenated).
        const relUrl = `https://musicbrainz.org/ws/2/release?release-group=${rg.id}&inc=recordings&fmt=json&limit=25`
        const relRes = await fetch(relUrl, { headers })
        if (!relRes.ok) { incomplete = true; continue }
        const relData = await relRes.json() as {
          releases?: Array<{
            id: string
            date?: string
            status?: string | null
            disambiguation?: string
            media?: Array<{ tracks?: Array<{ title: string; position: number }> }>
          }>
        }
        const release = pickStandardRelease(relData.releases)
        if (!release) continue
        const tracks: { title: string; position: number }[] = []
        for (const m of release.media || []) {
          for (const t of m.tracks || []) {
            tracks.push({ title: t.title, position: t.position })
          }
        }
        if (tracks.length === 0) continue
        // If ≥30% of this album's songs already appeared on earlier albums,
        // it's a repackaging/hits comp — not a new studio record. Skip it.
        // 0.3 sits in the clean gap measured on the Beatles' catalog: real
        // studio albums score 0.00–0.14 overlap, the US Capitol comps 0.36+.
        const titles = tracks.map(t => normTrackTitle(t.title)).filter(Boolean)
        const overlap = titles.filter(t => seenTitles.has(t)).length
        if (titles.length >= 4 && overlap / titles.length > 0.3) continue
        for (const t of titles) seenTitles.add(t)
        const year = (rg.firstReleaseDate || release.date || '').slice(0, 4)
        albums.push({ title: rg.title, year, tracks, mb: { primaryType: rg.primaryType ?? undefined, secondaryTypes: rg.secondaryTypes } })
      } catch { incomplete = true /* skip this release group; the result isn't cached, so it's retried */ }
    }

    // Restore newest-first for display.
    albums.sort((a, b) => (b.year || '').localeCompare(a.year || ''))

    const result: DiscographyResult = {
      artist, albums, fetchedAt: Date.now(), schemaVersion: DISCO_SCHEMA_VERSION,
      ...(incomplete ? { incomplete: true } : {}),
      rejected: gate.verdicts.filter((v) => !v.admitted).map((v) => ({ title: v.title, reasons: v.reasons, notes: v.notes })),
    }
    if (incomplete) console.warn(`[discography] ${artist}: incomplete (a source was down) — not cached`)
    else await writeCache(cachePath, result)
    return result
  } catch (err) {
    console.warn('[discography] fetch failed:', err)
    return null
  }
}

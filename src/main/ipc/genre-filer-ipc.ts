/**
 * Genre filer wiring (2026-10-11): sweeps for songs whose genre isn't on
 * Jake's list (90 s after launch, then every 5 minutes), files them through the
 * app's own serialized override writer, mirrors the change into the renderer
 * live ('genre-filer:applied' → UPDATE_TRACKS), and serves his check list to
 * Settings → Library. Rules live in src/main/genre-filer.ts.
 */
import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, rename } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { runFilerSweep, resolveCheckEntry, trackFingerprint, checkEntryOpen, type FilerTrack, type FilerDeps, type CheckEntry, type Evidence, type OriginCache, originCacheFromV2 } from '../genre-filer.ts'
import { musicBrainzArtistCandidates, musicBrainzAlbum, confirmedArtist, musicBrainzCountryById } from '../artist-tags.ts'
import { lookupArtistOrigin, cleanAlbumTitle } from '../origin-lookup.ts'
import { exaSearch } from '../exa.ts'

export interface GenreFilerHost {
  libraryTracks(): Promise<FilerTrack[]>
  overrides(): Promise<Record<string, { fp?: string; fields?: Record<string, string> } | undefined>>
  persist(trackId: number, fields: Record<string, string>, fingerprint: string): Promise<void>
  send(channel: string, payload: unknown): void
  claude(system: string, user: string): Promise<string>
  mbThrottle(): Promise<void>
  userAgent: string
}

const CHECK_FILE = (): string => join(app.getPath('userData'), 'genre-check.json')
/** Origins already asked: {originCacheKey: OriginCacheEntry} — so an artist
 *  nobody knows isn't asked about every five minutes. */
// v2 (10/11): v1 answers came from name-only matches (MESH got Bristol's origin) — not reused.
// v3 (10/18): v2's "unknown"s were asked the old way — two albums, " - EP"
// titles, whole multi-artist credits — so they are asked once more; its
// known answers carry over.
const ORIGIN_FILE = (): string => join(app.getPath('userData'), 'origin-lookups-v3.json')
const ORIGIN_FILE_V2 = (): string => join(app.getPath('userData'), 'origin-lookups-v2.json')
const SWEEP_MS = 5 * 60_000
const FIRST_SWEEP_MS = 90_000

async function loadCheck(): Promise<CheckEntry[]> {
  try { const v = JSON.parse(await readFile(CHECK_FILE(), 'utf8')) as unknown; return Array.isArray(v) ? v as CheckEntry[] : [] } catch { return [] }
}
async function saveCheck(list: CheckEntry[]): Promise<void> {
  const tmp = `${CHECK_FILE()}.tmp`
  await writeFile(tmp, JSON.stringify(list, null, 2))
  await rename(tmp, CHECK_FILE())
}

async function loadOriginCache(): Promise<OriginCache> {
  try { return JSON.parse(await readFile(ORIGIN_FILE(), 'utf8')) as OriginCache } catch { /* no v3 yet */ }
  try { return originCacheFromV2(JSON.parse(await readFile(ORIGIN_FILE_V2(), 'utf8'))) } catch { return {} }
}
async function saveOriginCache(cache: OriginCache): Promise<void> {
  const tmp = `${ORIGIN_FILE()}.tmp`
  await writeFile(tmp, JSON.stringify(cache)); await rename(tmp, ORIGIN_FILE())
}

/** Library tracks with the desktop overrides' genre/origin applied (same fp rule as App.tsx). */
async function effectiveTracks(host: GenreFilerHost): Promise<FilerTrack[]> {
  const [tracks, ov] = await Promise.all([host.libraryTracks(), host.overrides()])
  return tracks.map((t) => {
    const e = ov[String(t.id)]
    if (!e?.fields || (e.fp && e.fp !== trackFingerprint(t))) return t
    return { ...t, genre: e.fields.genre ?? t.genre, origin: e.fields.origin ?? t.origin, genreApproved: e.fields.genre !== undefined }
  })
}

function deps(host: GenreFilerHost): FilerDeps {
  return {
    tracks: () => effectiveTracks(host),
    persist: (t, fields) => host.persist(t.id, fields, trackFingerprint(t)),
    applied: (updates) => host.send('genre-filer:applied', { updates }),
    evidence: async (u): Promise<Evidence> => {
      await host.mbThrottle()
      const cands = (await musicBrainzArtistCandidates(u.artist, host.userAgent)) ?? []
      let album: { tags: string[]; creditIds: string[] } | null = null
      if (!u.comp && u.album) { await host.mbThrottle(); album = await musicBrainzAlbum(u.artist, cleanAlbumTitle(u.album), host.userAgent) }
      // The artist's tags and origin count only when this album is credited to
      // them; otherwise the name may be a namesake's (MESH ≠ Bristol's Mesh).
      const a = confirmedArtist(cands, album?.creditIds ?? [])
      if (a && !a.origin && a.id) { await host.mbThrottle(); a.origin = (await musicBrainzCountryById(a.id, host.userAgent)) ?? undefined }
      const albumTags = album?.tags ?? []
      const artistTags = a?.tags ?? []
      // Press only when MusicBrainz is thin — the Telescreens lesson.
      const press = artistTags.length + albumTags.length >= 3 ? '' : await exaSearch(`${u.artist} ${u.comp ? u.title : u.album} band music review`, {
        numResults: 3, summaryQuery: `What genre or style of music does ${u.artist} play? Answer in under 15 words naming the genres, or say "unknown" if this page is not about that artist.`,
      }).catch(() => '')
      return { artistTags, albumTags, origin: a?.origin, press }
    },
    classify: (system, user) => host.claude(system, user),
    // Network only — the cache and the per-sweep budget live in fillOrigins.
    lookupOrigin: (artist, albums) => lookupArtistOrigin(artist, albums, { throttle: host.mbThrottle, userAgent: host.userAgent }),
    loadOriginCache,
    saveOriginCache,
    loadCheck,
    saveCheck,
    // warn, not log: main.log keeps only warn/error, and the filer's picks,
    // check-list parkings and origin hits/misses are what a later "why does
    // this say X" needs (10/18 — the origin backfill was dead for 6 days, silently).
    log: (m) => console.warn(m),
  }
}

export function startGenreFiler(host: GenreFilerHost): void {
  let running = false
  const sweep = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const r = await runFilerSweep(deps(host))
      if (r.filed || r.checked || r.origins || r.backfilled) console.warn(`[genre-filer] sweep: filed ${r.filed}, to check ${r.checked}, waiting ${r.deferred}, origins ${r.origins}${r.backfilled ? `, check-list albums filed by suggestion ${r.backfilled}` : ''}`)
    } catch (err) {
      console.warn('[genre-filer] sweep failed:', err instanceof Error ? err.message : err)
    } finally { running = false }
  }
  setTimeout(() => { void sweep(); setInterval(() => { void sweep() }, SWEEP_MS) }, FIRST_SWEEP_MS)
}

export function registerGenreFilerIpc(ipc: IpcRegistrar, host: GenreFilerHost): void {
  // The check list, minus anything Jake has since filed himself (Get Info).
  ipc.handle('genre-check:list', async () => {
    const list = await loadCheck()
    const byId = new Map((await effectiveTracks(host)).map((t) => [t.id, t]))
    const open = list.filter((c) => checkEntryOpen(c, byId))
    if (open.length !== list.length) await saveCheck(open)
    return open
  }, { refuse: REFUSED_SENDER })
  ipc.handle('genre-check:resolve', async (_e, key: string, genre: string) => resolveCheckEntry(deps(host), String(key), String(genre)), { refuse: REFUSED_SENDER })
  startGenreFiler(host)
}

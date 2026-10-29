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
import { runFilerSweep, resolveCheckEntry, trackFingerprint, checkEntryOpen, type FilerTrack, type FilerDeps, type CheckEntry, type Evidence, type OriginCache, type GenreWhy, originCacheFromV2 } from '../genre-filer.ts'
import { PROVENANCE_FILE, parseProvenance, genreOwner, type ProvenanceDoc } from '../genre-provenance.ts'
import { readUserEditsJournal } from '../user-edits-sync.ts'
import { writeJsonAtomic } from '../atomic-write.ts'
import { runGenreCorrections } from '../genre-corrections.ts'
import { musicBrainzArtistCandidates, musicBrainzAlbum, confirmedArtist, musicBrainzCountryById } from '../artist-tags.ts'
import { lookupArtistOrigin, cleanAlbumTitle } from '../origin-lookup.ts'
import { exaSearch } from '../exa.ts'
import { deezerAlbumGenres, discogsAlbumStyles } from '../genre-external-tags.ts'
import { getAudioIndexMap } from '../ai/audio-index.ts'
import { getMoodIndexMap } from '../ai/mood-index.ts'

export interface GenreFilerHost {
  libraryTracks(): Promise<FilerTrack[]>
  overrides(): Promise<Record<string, { fp?: string; fields?: Record<string, string> } | undefined>>
  /** The phone's edits (mobile-metadata-overrides.json) — a genre there is his. */
  phoneOverrides?(): Promise<Record<string, { fp?: string; fields?: Record<string, string> } | undefined>>
  /** Flush the edits file to disk (the corrections pass backs it up first). */
  flushOverrides?(): Promise<void>
  /** workmini: its genres come from the hub catalog (the MacBook), so the
   *  one-time corrections pass runs on the hub only. */
  isReplica?(): Promise<boolean>
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
const PROV_FILE = (): string => join(app.getPath('userData'), PROVENANCE_FILE)
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

/** The provenance record. One writer (this module), every write merged onto
 *  a FRESH read and serialized — never a held snapshot saved back. */
let provChain: Promise<unknown> = Promise.resolve()
async function loadProvenance(): Promise<ProvenanceDoc> {
  try { return parseProvenance(JSON.parse(await readFile(PROV_FILE(), 'utf8'))) } catch { return parseProvenance(null) }
}
export function updateProvenance(mutate: (doc: ProvenanceDoc) => void): Promise<void> {
  const run = provChain.then(async () => {
    const doc = await loadProvenance()
    mutate(doc)
    await writeJsonAtomic(PROV_FILE(), doc)
  })
  provChain = run.catch(() => undefined)
  return run
}
async function loadJournalGenres(): Promise<Map<string, { v: string; at: number; dur?: number }>> {
  const out = new Map<string, { v: string; at: number; dur?: number }>()
  try {
    const doc = await readUserEditsJournal(app.getPath('userData'))
    for (const [id, f] of Object.entries(doc?.edits ?? {})) if (f.genre) out.set(id, { v: f.genre.v, at: f.genre.at, dur: f.genre.dur })
  } catch { /* no journal yet */ }
  return out
}

/** Library tracks with the desktop overrides' genre/origin applied (same fp
 *  rule as App.tsx), and who set each genre (genre-provenance.ts). */
export async function effectiveTracks(host: GenreFilerHost): Promise<FilerTrack[]> {
  const [tracks, ov, phone, prov, journal] = await Promise.all([
    host.libraryTracks(), host.overrides(), host.phoneOverrides?.().catch(() => ({})) ?? Promise.resolve({}), loadProvenance(), loadJournalGenres(),
  ])
  return tracks.map((t0) => {
    const fp = trackFingerprint(t0)
    const e = ov[String(t0.id)]
    const valid = !!e?.fields && !(e.fp && e.fp !== fp)
    const t: FilerTrack = valid
      ? { ...t0, genre: e!.fields!.genre ?? t0.genre, origin: e!.fields!.origin ?? t0.origin, genreApproved: e!.fields!.genre !== undefined }
      : { ...t0, ...(e?.fields?.genre !== undefined && e.fp ? { overrideFpSeen: e.fp } : {}) }
    const pe = (phone as Record<string, { fp?: string; fields?: Record<string, string> } | undefined>)[String(t0.id)]
    const p = prov.tracks[String(t0.id)]
    t.genreBy = genreOwner({
      genre: t.genre, fp, duration: t0.duration, inOverrides: !!t.genreApproved, prov: p, journal: journal.get(String(t0.id)),
      phone: pe?.fields?.genre !== undefined && (!pe.fp || pe.fp === fp) ? pe.fields.genre : undefined,
    })
    if (t.genreBy === 'filer' && p) t.filerPick = { how: p.how, ...(p.confidence ? { confidence: p.confidence } : {}) }
    return t
  })
}

/** Persist through the app's override writer, then record who set the genre. */
async function persistWithProvenance(host: GenreFilerHost, t: FilerTrack, fields: Record<string, string>, why?: GenreWhy): Promise<void> {
  const fp = trackFingerprint(t)
  await host.persist(t.id, fields, fp)
  if (fields.genre === undefined || !why) return
  const at = new Date().toISOString()
  await updateProvenance((doc) => {
    doc.tracks[String(t.id)] = { genre: fields.genre, by: why.by, how: why.how, fp, at, ...(why.confidence ? { confidence: why.confidence } : {}) }
  })
}

function deps(host: GenreFilerHost): FilerDeps {
  return {
    tracks: () => effectiveTracks(host),
    persist: (t, fields, why) => persistWithProvenance(host, t, fields, why),
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
      // "music review", not "band music review": a producer (Sam Gellaitry)
      // is not a band, and the old query found other people's pages.
      const press = artistTags.length + albumTags.length >= 3 ? '' : await exaSearch(`${u.artist} ${u.comp ? u.title : u.album} music review`, {
        numResults: 3, summaryQuery: `What genre or style of music does ${u.artist} play? Answer in under 15 words naming the genres, or say "unknown" if this page is not about that artist.`,
      }).catch(() => '')
      // More outside tags (2026-10-28) — evidence lines, never answers.
      const title = cleanAlbumTitle(u.comp ? (u.title || '') : u.album)
      const [deezer, discogs] = await Promise.all([
        deezerAlbumGenres(u.artist, title),
        discogsAlbumStyles(u.artist, title, process.env.DISCOGS_API_TOKEN),
      ])
      return { artistTags, albumTags, origin: a?.origin, press, deezer, discogs }
    },
    classify: (system, user) => host.claude(system, user),
    // The sound-alike vote's spaces (genre-sound-alike.ts): both loaders are
    // mtime-cached and return an empty map when the file is absent.
    vectors: async () => ({ audio: await getAudioIndexMap(), mood: await getMoodIndexMap() }),
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
  let correctionsTried = false
  const sweep = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      // The one-time corrections pass (genre-corrections.ts) runs before the
      // first sweep — idempotent, so a later launch only finds it done.
      if (!correctionsTried) {
        correctionsTried = true
        const replica = (await host.isReplica?.().catch(() => true)) ?? false
        if (!replica) {
          await runGenreCorrections({ ...deps(host), userData: app.getPath('userData'), flushOverrides: host.flushOverrides, updateProvenance })
            .catch((err) => console.warn('[genre-corrections] failed:', err instanceof Error ? err.message : err))
        }
      }
      const r = await runFilerSweep(deps(host))
      if (r.filed || r.checked || r.origins || r.backfilled || r.rejudged) console.warn(`[genre-filer] sweep: filed ${r.filed}, to check ${r.checked}, waiting ${r.deferred}, origins ${r.origins}${r.backfilled ? `, check-list albums filed by suggestion ${r.backfilled}` : ''}${r.rejudged ? `, re-judged ${r.rejudged}` : ''}`)
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

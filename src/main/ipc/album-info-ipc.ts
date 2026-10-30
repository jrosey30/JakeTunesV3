/**
 * Album info + iTunes search IPC: factual credits (iTunes Search +
 * MusicBrainz, never LLM) and the add-recommendation autocomplete
 * shims. Extracted from main/index.ts (6.0 Phase 1) — bodies verbatim.
 */
import { app } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { pickAlbumReleaseDate, sanitizeAlbumCredits, tagYearStr } from '../../common/albumReleaseDate'
import { itunesAlbumTracks, pickItunesAlbumRow, searchItunesSuggestions } from '../download-search'
import { safeIpcError } from '../safe-ipc-error'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_DIR } from '../state-dir'
import { nameKey } from '../../common/fold-text'
import { mbReleaseLabel } from '../album-label'
import { createAlbumPersonnelService, type AlbumPersonnel } from '../album-personnel.ts'
import { albumCreditsKey, createAlbumCreditsStore, creditsFromPersonnel, type AlbumCredits } from '../album-credits.ts'
import { rankLibraryAlbums, startAlbumPersonnelPrefetch, type LibraryAlbum } from '../album-personnel-prefetch.ts'
import { registerRecordShopIpc } from './record-shop-ipc.ts'
import { registerNearEditionIpc } from './near-edition-ipc.ts'

/** index.ts ranks the library for `listAlbums` with this (re-exported so its
 *  one call line needs no import line of its own — the line-count ratchet). */
export { rankLibraryAlbums }

/** What index.ts may hand this module. Optional, so the existing one-argument
 *  call keeps working: the shared MusicBrainz throttle (index.ts mbThrottle)
 *  is worth passing so the album page and the background jobs take turns at
 *  MusicBrainz's one-request-a-second door instead of each keeping its own;
 *  the library's albums, ranked, are what the credits prefetch walks. */
export interface AlbumInfoHost {
  mbThrottle?: () => Promise<void>
  listAlbums?: () => Promise<readonly LibraryAlbum[]> | readonly LibraryAlbum[]
}

// The band's members (artist-members.json, MusicBrainz-grounded) so the album
// page lists the band before guests and production. Re-read at most once a
// minute; no file = no members known.
let membersCache: { at: number; map: Map<string, string[]> } | null = null
async function artistMembers(artist: string): Promise<readonly string[] | null> {
  const now = Date.now()
  if (!membersCache || now - membersCache.at > 60_000) {
    const map = new Map<string, string[]>()
    try {
      const raw = JSON.parse(await readFile(join(STATE_DIR, 'artist-members.json'), 'utf-8')) as Record<string, { members?: string[] }>
      for (const [name, v] of Object.entries(raw)) if (Array.isArray(v?.members)) map.set(nameKey(name), v.members)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[album-personnel] artist-members.json unreadable:', err instanceof Error ? err.message : String(err))
    }
    membersCache = { at: now, map }
  }
  return membersCache.map.get(nameKey(artist)) ?? null
}

export function registerAlbumInfoIpc(ipc: IpcRegistrar, host: AlbumInfoHost = {}): void {
  // Brief 122 Phase 2 — autocomplete source for the add-recommendation form.
  // iTunes Search is public + key-less; hit it straight from the main process
  // (no CORS, and no per-keystroke round-trip to the Mini backend). Returns a
  // small normalized suggestion list. Does NOT touch the music library.
  // ── Album detail page (4.5.0-115): factual credits + Music Man blurb ──
  // Credits come from real lookups (iTunes Search + MusicBrainz), never the
  // LLM, so we never invent a producer or date. Honest gaps where the APIs
  // don't have it. Blurb is the Music Man's editorial take (opinion, grounded —
  // it's told NOT to state hard credits). The credits are remembered on disk
  // (album-credits.ts; Jake 2026-10-30: "it shouldnt have to load everytime")
  // — they lived in a per-session Map before.
  const credits = createAlbumCreditsStore(app.getPath('userData'), { log: (m) => console.warn(m) })

  async function fetchItunesAlbum(artist: string, album: string): Promise<{ released?: string; label?: string } | null> {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${album}`)}&entity=album&limit=5`
      const res = await fetch(url)
      if (!res.ok) return null
      const data = await res.json() as { results?: Array<{ collectionName?: string; releaseDate?: string; copyright?: string }> }
      // This artist's row only — "Nirvana Nevermind" leads with a tribute
      // album on another label (Jake 2026-10-30: "isnt nevermind on sub pop
      // not robotic empire??"); no row of theirs = no iTunes answer.
      const best = pickItunesAlbumRow(data.results || [], album, artist)
      if (!best) return null
      const released = best.releaseDate ? best.releaseDate.slice(0, 10) : undefined
      let label: string | undefined
      if (best.copyright) {
        // "℗ 1972 Curtom Records. Marketed by Rhino…" → "Curtom Records".
        // Strip the ℗/© + year, then keep only the label name before the
        // first sentence break / "Marketed by" / "Distributed by" legalese.
        const stripped = best.copyright.replace(/^\s*[℗©]\s*/, '').replace(/^\d{4}\s*/, '').trim()
        const name = stripped.split(/\s*[.;]\s|,\s|\s+Marketed\b|\s+Distributed\b|\s+under\b|\s+a\s+(?:division|Warner|Universal|Sony)\b/i)[0].trim()
        if (name && name.length >= 2 && name.length < 60) label = name
      }
      return { released, label }
    } catch { return null }
  }

  async function fetchMusicBrainzAlbumCredits(artist: string, album: string): Promise<{ released?: string; producer?: string; label?: string } | null> {
    // Separate from searchMusicBrainz() (that returns a prose facts string for
    // the persona); this pulls STRUCTURED release-group data. Best-effort,
    // single timeout-bounded pass. MB asks for a descriptive User-Agent, and
    // for one request a second: every call waits its turn at the shared door.
    const headers = { 'User-Agent': `JakeTunes/${app.getVersion()} (jacobrosenbaum@gmail.com)` }
    const mb = async (url: string): Promise<Response> => { await host.mbThrottle?.(); return fetch(url, { headers }) }
    try {
      const q = `releasegroup:"${album}" AND artist:"${artist}"`
      const rgRes = await mb(`https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=1`)
      if (!rgRes.ok) return null
      const rg = await rgRes.json() as { 'release-groups'?: Array<{ id: string; 'first-release-date'?: string }> }
      const group = rg['release-groups']?.[0]
      if (!group) return null
      const released = group['first-release-date'] || undefined
      let producer: string | undefined
      try {
        const relRes = await mb(`https://musicbrainz.org/ws/2/release-group/${group.id}?inc=artist-rels&fmt=json`)
        if (relRes.ok) {
          const rel = await relRes.json() as { relations?: Array<{ type?: string; artist?: { name?: string } }> }
          const prod = (rel.relations || []).find((r) => /producer/i.test(r.type || ''))
          if (prod?.artist?.name) producer = prod.artist.name
        }
      } catch { /* relations are a bonus; ignore */ }
      // The label of the earliest official release (Nevermind → DGC): the
      // record's own label, not whatever iTunes row the search led with.
      let label: string | undefined
      try {
        const relsRes = await mb(`https://musicbrainz.org/ws/2/release?release-group=${group.id}&inc=labels&fmt=json&limit=25`)
        if (relsRes.ok) {
          const rels = await relsRes.json() as { releases?: Array<{ status?: string; date?: string; 'label-info'?: Array<{ label?: { name?: string } }> }> }
          label = mbReleaseLabel(rels.releases || [])
        }
      } catch { /* the label is a bonus; iTunes may still have it */ }
      return { released, producer, label }
    } catch { return null }
  }

  // ── Personnel (2026-10-30, Jake: "mention the album personnel somewhere") ──
  // Who played and produced what, and on which tracks, from MusicBrainz
  // relationships (never the LLM), remembered across restarts in
  // userData/album-personnel.json. The lookup, the acceptance rule and the
  // cache live in ../album-personnel.ts; this is the wire. The refusal
  // carries the full AlbumPersonnel shape so the renderer never sees a
  // missing `people`.
  const personnel = createAlbumPersonnelService({
    dir: app.getPath('userData'),
    userAgent: `JakeTunes/${app.getVersion()} (jacobrosenbaum@gmail.com)`,
    throttle: host.mbThrottle,
    membersOf: artistMembers,
  })
  ipc.handle('get-album-personnel', async (_e, artist: string, album: string): Promise<AlbumPersonnel> => personnel.get(artist, album),
    { refuse: { ok: false, people: [], trackCount: 0, error: REFUSED_SENDER.error } })

  // The facts the personnel lookup already carries — the album's first
  // release date, the record's label, the main producer — when it found the
  // record; null when it did not (no release group is this album by this
  // artist, or MusicBrainz did not answer). One MusicBrainz round serves the
  // page's Personnel and its credits line; a page's two calls share the lookup.
  const personnelFacts = async (artist: string, album: string): Promise<AlbumCredits | null> => {
    const r = await personnel.get(artist, album)
    if (!r.ok) return null
    const entry = await personnel.peek(artist, album)
    return entry ? creditsFromPersonnel(entry) : null
  }

  ipc.handle('get-album-info', async (_e, artist: string, album: string, year?: string | number): Promise<{ ok: boolean; credits?: AlbumCredits; error?: string }> => {
    if (!album) return { ok: true, credits: {} }
    const tagYear = tagYearStr(year)
    const key = albumCreditsKey(artist, album, tagYear)
    const cached = await credits.get(key)
    if (cached) {
      return { ok: true, credits: sanitizeAlbumCredits(tagYear, cached) }
    }
    try {
      const [facts, it] = await Promise.all([personnelFacts(artist, album), fetchItunesAlbum(artist, album)])
      // The loose release-group lookup only when the strict one found nothing.
      const mb = facts ? null : await fetchMusicBrainzAlbumCredits(artist, album)
      const merged: AlbumCredits = {}
      const released = pickAlbumReleaseDate(tagYear, facts?.released ?? mb?.released, it?.released)
      if (released) merged.released = released
      const label = facts?.label ?? mb?.label ?? it?.label
      if (label) merged.label = label
      const producer = facts?.producer ?? mb?.producer
      if (producer) merged.producer = producer
      const sanitized = sanitizeAlbumCredits(tagYear, merged)
      void credits.set(key, sanitized)
      return { ok: true, credits: sanitized }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { refuse: REFUSED_SENDER })

  // ── Already there (Jake 2026-10-30: "it shouldnt have to load everytime") ──
  // Ninety seconds after launch, the prefetch walks the library's albums —
  // loved, played and just-added first — through the same lookup, yielding to
  // any page's own and keeping MusicBrainz to a request every 2.5 s from this
  // machine; the credits line is filled from what each lookup learned, at no
  // extra request. Resumes across launches; daily for the stale ones.
  // JT_PERSONNEL_PREFETCH=0 turns it off. (album-personnel-prefetch.ts)
  const fillCredits = async (a: LibraryAlbum): Promise<void> => {
    const key = albumCreditsKey(a.artist, a.album, tagYearStr(a.year))
    if (await credits.has(key)) return
    const entry = await personnel.peek(a.artist, a.album)
    const facts = entry ? creditsFromPersonnel(entry) : null
    if (!facts) return   // no MusicBrainz facts: the page fills this one on open (iTunes + the loose lookup), once
    const merged: AlbumCredits = {}
    const released = pickAlbumReleaseDate(a.year, facts.released)
    if (released) merged.released = released
    if (facts.label) merged.label = facts.label
    if (facts.producer) merged.producer = facts.producer
    await credits.set(key, sanitizeAlbumCredits(a.year, merged))
  }
  startAlbumPersonnelPrefetch({
    dir: app.getPath('userData'),
    listAlbums: () => host.listAlbums?.() ?? [],
    service: personnel,
    fillCredits,
    log: (m) => console.log(m),
  })
  /** ⚠️ TWIN: src/renderer/types.ts (ItunesSuggestion). This crosses the IPC
   *  boundary, so a field added on one side and not the other is silently
   *  dropped rather than caught — change both together. */
  // Download search moved to download-search.ts (renovation P1C3). The two
  // registrations below are shims; every body, template and doctrine comment
  // lives in the module now.
  ipc.handle('search-itunes', async (_event, query: string) => searchItunesSuggestions(query),
    { refuse: { ok: false, results: [] } })

  ipc.handle('itunes-album-tracks', async (_event, ref: number | { artist?: string; album: string }) => itunesAlbumTracks(ref),
    { refuse: { ok: false, tracks: [] } })
  // The Record Shop's identity + ownership question rides the same catalogue lookup.
  registerRecordShopIpc(ipc)
  registerNearEditionIpc(ipc)
}

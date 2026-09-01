/**
 * Album info + iTunes search IPC: factual credits (iTunes Search +
 * MusicBrainz, never LLM) and the add-recommendation autocomplete
 * shims. Extracted from main/index.ts (6.0 Phase 1) — bodies verbatim.
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { pickAlbumReleaseDate, sanitizeAlbumCredits, tagYearStr } from '../../common/albumReleaseDate'
import { itunesAlbumTracks, searchItunesSuggestions } from '../download-search'
import { foldAccents } from '../../common/fold-text.ts'
import { safeIpcError } from '../safe-ipc-error'

export function registerAlbumInfoIpc(ipc: IpcRegistrar): void {
  // Brief 122 Phase 2 — autocomplete source for the add-recommendation form.
  // iTunes Search is public + key-less; hit it straight from the main process
  // (no CORS, and no per-keystroke round-trip to the Mini backend). Returns a
  // small normalized suggestion list. Does NOT touch the music library.
  // ── Album detail page (4.5.0-115): factual credits + Music Man blurb ──
  // Credits come from real lookups (iTunes Search + MusicBrainz), never the
  // LLM, so we never invent a producer or date. Honest gaps where the APIs
  // don't have it. Blurb is the Music Man's editorial take (opinion, grounded —
  // it's told NOT to state hard credits). Both cached in-memory per session.
  type AlbumCredits = { released?: string; label?: string; producer?: string; recorded?: string }
  const albumInfoCache = new Map<string, AlbumCredits>()
  const albumCacheKey = (artist: string, album: string) => `${(artist || '').toLowerCase().trim()}|${(album || '').toLowerCase().trim()}`

  async function fetchItunesAlbum(artist: string, album: string): Promise<{ released?: string; label?: string } | null> {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${album}`)}&entity=album&limit=5`
      const res = await fetch(url)
      if (!res.ok) return null
      const data = await res.json() as { results?: Array<{ collectionName?: string; releaseDate?: string; copyright?: string }> }
      const norm = (s: string) => foldAccents(s).replace(/[^a-z0-9]/g, '')
      const want = norm(album)
      const results = data.results || []
      const best = results.find((r) => norm(r.collectionName || '') === want) || results[0]
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

  async function fetchMusicBrainzAlbumCredits(artist: string, album: string): Promise<{ released?: string; producer?: string } | null> {
    // Separate from searchMusicBrainz() (that returns a prose facts string for
    // the persona); this pulls STRUCTURED release-group data. Best-effort,
    // single timeout-bounded pass. MB asks for a descriptive User-Agent.
    const headers = { 'User-Agent': 'JakeTunes/4.5 ( jakerosenbaum30@gmail.com )' }
    try {
      const q = `releasegroup:"${album}" AND artist:"${artist}"`
      const rgRes = await fetch(`https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=1`, { headers })
      if (!rgRes.ok) return null
      const rg = await rgRes.json() as { 'release-groups'?: Array<{ id: string; 'first-release-date'?: string }> }
      const group = rg['release-groups']?.[0]
      if (!group) return null
      const released = group['first-release-date'] || undefined
      let producer: string | undefined
      try {
        const relRes = await fetch(`https://musicbrainz.org/ws/2/release-group/${group.id}?inc=artist-rels&fmt=json`, { headers })
        if (relRes.ok) {
          const rel = await relRes.json() as { relations?: Array<{ type?: string; artist?: { name?: string } }> }
          const prod = (rel.relations || []).find((r) => /producer/i.test(r.type || ''))
          if (prod?.artist?.name) producer = prod.artist.name
        }
      } catch { /* relations are a bonus; ignore */ }
      return { released, producer }
    } catch { return null }
  }

  ipc.handle('get-album-info', async (_e, artist: string, album: string, year?: string | number): Promise<{ ok: boolean; credits?: AlbumCredits; error?: string }> => {
    if (!album) return { ok: true, credits: {} }
    const tagYear = tagYearStr(year)
    const key = `${albumCacheKey(artist, album)}|y:${tagYear || '?'}`
    const cached = albumInfoCache.get(key)
    if (cached) {
      return { ok: true, credits: sanitizeAlbumCredits(tagYear, cached) }
    }
    try {
      const [it, mb] = await Promise.all([fetchItunesAlbum(artist, album), fetchMusicBrainzAlbumCredits(artist, album)])
      const merged: AlbumCredits = {}
      const released = pickAlbumReleaseDate(tagYear, mb?.released, it?.released)
      if (released) merged.released = released
      if (it?.label) merged.label = it.label
      if (mb?.producer) merged.producer = mb.producer
      const sanitized = sanitizeAlbumCredits(tagYear, merged)
      albumInfoCache.set(key, sanitized)
      return { ok: true, credits: sanitized }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { refuse: REFUSED_SENDER })
  /** ⚠️ TWIN: src/renderer/types.ts (ItunesSuggestion). This crosses the IPC
   *  boundary, so a field added on one side and not the other is silently
   *  dropped rather than caught — change both together. */
  // Download search moved to download-search.ts (renovation P1C3). The two
  // registrations below are shims; every body, template and doctrine comment
  // lives in the module now.
  ipc.handle('search-itunes', async (_event, query: string) => searchItunesSuggestions(query),
    { refuse: { ok: false, results: [] } })

  ipc.handle('itunes-album-tracks', async (_event, collectionId: number) => itunesAlbumTracks(collectionId),
    { refuse: { ok: false, tracks: [] } })
}

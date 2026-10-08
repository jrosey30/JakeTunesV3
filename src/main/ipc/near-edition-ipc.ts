/**
 * near-edition:compare — the read-only comparison behind Compare editions.
 * Fetches the picked edition's tracklist (iTunes) and the found edition's
 * (from the verdict's judged tracklist, else the Bandcamp page, read-only),
 * runs the judge per track, and returns rows + counts + the two acquisition
 * sentences. It acquires NOTHING and writes nothing.
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import { itunesAlbumTracks } from '../download-search'
import { buildRequestedAlbum } from '../album-identity.ts'
import { loadLibraryTracksLite } from '../import-pipeline.ts'
import { judgeAlbumTracks, summarizeNearEdition } from '../near-edition.ts'
import type { AlternativeTrack } from '../../common/acquisition-identity.ts'
import type { CompareEditionsRequest, CompareEditionsResult } from '../../common/near-edition-types.ts'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'

async function bandcampAlbumUrl(artist: string, album: string): Promise<string | null> {
  try {
    const res = await fetch('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ search_text: `${artist} ${album}`.trim(), search_filter: 'a', fan_id: null, full_page: false }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const d = await res.json() as { auto?: { results?: Array<{ type?: string; name?: string; band_name?: string; item_url_path?: string }> } }
    const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const hit = (d.auto?.results || []).find((r) => r.type === 'a' && r.item_url_path && norm(String(r.name)) === norm(album) && norm(String(r.band_name)) === norm(artist))
    return hit?.item_url_path ?? null
  } catch { return null }
}

/** The public album page's own tracklist (title + duration). Read-only. */
export async function bandcampTracklist(url: string): Promise<{ title?: string; releaseYear?: number; tracks: AlternativeTrack[] } | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const html = await res.text()
    const m = /data-tralbum="([^"]*)"/.exec(html)
    if (!m) return null
    const decoded = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    const d = JSON.parse(decoded) as { current?: { title?: string; release_date?: string }; trackinfo?: Array<{ title?: string; track_num?: number; duration?: number }> }
    const year = d.current?.release_date ? new Date(d.current.release_date).getUTCFullYear() : undefined
    return {
      title: d.current?.title, releaseYear: Number.isFinite(year) ? year : undefined,
      tracks: (d.trackinfo || []).map((t, i) => ({ title: String(t.title || ''), trackNumber: t.track_num ?? i + 1, durationSec: typeof t.duration === 'number' ? t.duration : null })),
    }
  } catch { return null }
}

export function registerNearEditionIpc(ipc: IpcRegistrar): void {
  ipc.handle('near-edition:compare', async (_event, req: CompareEditionsRequest): Promise<CompareEditionsResult | { ok: false; error: string }> => {
    if (!req || typeof req !== 'object' || !req.album || !req.candidate) return { ok: false, error: 'bad-request' }
    const found = await itunesAlbumTracks(req.collectionId ?? { artist: req.artist, album: req.album }).catch(() => ({ ok: false, tracks: [] as Array<{ song: string; trackNumber?: number; discNumber?: number; durationSecs?: number }> }))
    if (!found.ok || !found.tracks.length) return { ok: false, error: 'picked-tracklist-unavailable' }
    const reqAlbum = buildRequestedAlbum({
      artist: req.artist, title: req.album, collectionId: req.collectionId, releaseYear: req.releaseYear,
      trackCount: req.trackCount ?? found.tracks.length,
      tracks: found.tracks.map((t) => ({ title: t.song, trackNumber: t.trackNumber, discNumber: t.discNumber, durationSec: t.durationSecs })),
    })
    let candTracks = req.candidate.tracks ?? null
    let url = req.candidate.url
    let candYear = req.candidate.releaseYear
    if ((!candTracks || !candTracks.length) && req.candidate.provider === 'bandcamp') {
      url = url || (await bandcampAlbumUrl(req.artist, req.album)) || undefined
      if (url) { const page = await bandcampTracklist(url); if (page) { candTracks = page.tracks; candYear = candYear ?? page.releaseYear } }
    }
    if (!candTracks || !candTracks.length) return { ok: false, error: 'found-tracklist-unavailable' }
    const library = await loadLibraryTracksLite().catch(() => [])
    const rows = judgeAlbumTracks(reqAlbum, candTracks, undefined, library)
    const pickedLabel = req.collectionId ? `iTunes ${req.collectionId}` : 'the edition you picked'
    const providerName = req.candidate.provider === 'bandcamp' ? 'Bandcamp' : req.candidate.provider
    const foundLabel = `${providerName} edition`
    const source = url ? url.replace(/^https?:\/\//, '') : `${providerName} · ${req.candidate.desc}`
    const summary = summarizeNearEdition(rows, { label: pickedLabel }, { label: foundLabel, source })
    return {
      ok: true,
      picked: { label: pickedLabel, trackCount: reqAlbum.tracks.length, releaseYear: req.releaseYear, collectionId: req.collectionId },
      found: { provider: req.candidate.provider, label: foundLabel, source, url, trackCount: candTracks.length, releaseYear: candYear },
      rows, summary, toleranceSec: 20,
    }
  }, { refuse: { ok: false, error: 'refused-sender' } as const })
}

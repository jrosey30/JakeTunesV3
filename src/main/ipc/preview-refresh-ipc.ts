/**
 * Preview refresh IPC — Deezer 30s preview URLs are SIGNED and TIME-LIMITED
 * (cdnt-preview.dzcdn.net links carry an HMAC + expiry). The discovery
 * supply caches them at card-build time, so day-old cards 403 with media
 * error code 4 — the 2026-09-01 "previews stopped working again" console
 * capture. This handler re-resolves a fresh URL at PLAY time by strict
 * artist+title match against the Deezer search API (same normalize-and-
 * match-exactly discipline as searchDeezerArt: wrong preview > no preview
 * is FALSE — anything less than a confident match returns none).
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import { normalizeArtTerm } from '../art-term.ts'

interface DeezerTrackRow {
  title?: string
  preview?: string
  artist?: { name?: string }
}

/** Pure matcher: first row whose artist matches exactly and whose title is
 *  an exact or clean-prefix match (both after edition-strip normalize). */
export function pickDeezerPreview(
  rows: DeezerTrackRow[],
  wantArtist: string,
  wantTitle: string,
): string | null {
  const wa = normalizeArtTerm(wantArtist)
  const wt = normalizeArtTerm(wantTitle)
  if (!wa || !wt) return null
  for (const r of rows) {
    if (!r?.preview) continue
    const ra = normalizeArtTerm(r.artist?.name || '')
    const rt = normalizeArtTerm(r.title || '')
    if (ra !== wa) continue
    const titleOk = rt === wt
      || (wt.length >= 3 && (rt.startsWith(wt) || wt.startsWith(rt)))
    if (titleOk) return r.preview
  }
  return null
}

export function registerPreviewRefreshIpc(ipc: IpcRegistrar): void {
  ipc.handle('refresh-deezer-preview', async (_e, artist: string, title: string): Promise<{ ok: boolean; previewUrl?: string }> => {
    try {
      const q = `artist:"${String(artist || '').trim()}" track:"${String(title || '').trim()}"`
      const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`)
      if (!res.ok) return { ok: false }
      const data = await res.json() as { data?: DeezerTrackRow[] }
      const url = pickDeezerPreview(data.data || [], artist, title)
      return url ? { ok: true, previewUrl: url } : { ok: false }
    } catch {
      return { ok: false }
    }
  }, { public: true })
}

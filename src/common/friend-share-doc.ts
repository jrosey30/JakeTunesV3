/**
 * Friend share (2026-10-29) — the wire contract of homemini's
 * GET /api/share/link?id=<trackId>&kind=song|album, read by the desktop's
 * share dialog. The rules (which link, which signature line, the iPod
 * counter Easter egg) live on homemini (JakeTunesMobile backend
 * util/shareLink.ts) so the phone and both Macs send the same thing.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/FriendShare.swift `ShareInfo`.
 */

export type ShareKind = 'song' | 'album'

export interface ShareInfo {
  kind: ShareKind
  title: string
  artist: string
  album?: string
  rank: number | null
  /** The iPod track counter on the card: a Top 1000 song's rank out of 1000,
   *  else its place on its album. */
  counter: { index: number; total: number } | null
  /** text = first line of the message; card = the line under the wordmark. */
  signature: { text: string; card: string }
  links: {
    primary: string | null
    appleMusic: string | null
    spotify: string | null
    deezer: string | null
    songLink: string | null
    youtubeMusicSearch: string | null
  }
  /** The message, ready to send: signature first, two links at most. */
  text: string
  partial: boolean
}

const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** A ShareInfo, or null when the answer isn't one (fail closed: the dialog
 *  then builds its offline text). */
export function parseShareInfo(raw: unknown): ShareInfo | null {
  const r = o(raw)
  const kind = r.kind === 'album' ? 'album' : r.kind === 'song' ? 'song' : null
  const title = s(r.title)
  const artist = s(r.artist)
  const text = s(r.text)
  const sig = o(r.signature)
  const sigText = s(sig.text)
  const sigCard = s(sig.card)
  if (!kind || !title || !artist || !text || !sigText || !sigCard) return null
  const c = o(r.counter)
  const ci = n(c.index)
  const ct = n(c.total)
  const l = o(r.links)
  const album = s(r.album)
  return {
    kind, title, artist,
    ...(album ? { album } : {}),
    rank: n(r.rank),
    counter: ci && ct ? { index: ci, total: ct } : null,
    signature: { text: sigText, card: sigCard },
    links: {
      primary: s(l.primary), appleMusic: s(l.appleMusic), spotify: s(l.spotify),
      deezer: s(l.deezer), songLink: s(l.songLink), youtubeMusicSearch: s(l.youtubeMusicSearch),
    },
    text,
    partial: r.partial === true,
  }
}

/** The message when homemini can't be asked: same shape, no links. */
export function offlineShareText(title: string, artist: string): string {
  return `From Jake's library\n${title} by ${artist}`
}

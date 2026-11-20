/**
 * The Record Shop's search → save funnel in the usage log (Brief 253).
 *
 * One event per search Jake actually looked at, `shop.search`, written when
 * its results are left behind (a new search, the box cleared, the tab left,
 * the window closing) and carrying what came of it: how many saves, how long
 * until the first, how many were albums. That is the link between a search
 * and a save, in one line, so the Friday digest can count searches that
 * ended in a save without joining anything.
 *
 * Never the words: `len` is how many characters were typed (usage-log.ts's
 * no-words rule drops any detail key that reads like a query or a search, so
 * none of these keys does). A search left within KEYSTROKE_MS with no save is
 * a step on the way to the next one ("pin", "pink f", "pink floyd") and is
 * not written.
 *
 * Pure: the clock is passed in (node --test covers it).
 */
import type { UsageDetail } from './usage-log.ts'

/** A search replaced sooner than this, with nothing saved, was typing. */
export const KEYSTROKE_MS = 1500

export type ShopSearchHow = 'typed' | 'list'

export interface ShopFunnelEvent {
  kind: 'action'
  name: 'shop.search'
  /** How long the catalogue took to answer. */
  ms: number
  ok: boolean
  detail: UsageDetail
}

interface OpenSearch {
  at: number
  len: number
  hits: number
  songs: number
  albums: number
  /** Artists shown (Brief 256's grouped search); absent from an older caller. */
  artists?: number
  answerMs: number
  how: ShopSearchHow
  saves: number
  albumSaves: number
  firstSaveMs: number | null
}

export interface ShopFunnel {
  /** A search answered (results on screen). Closes the one before it. */
  searched(o: { len: number; hits: number; songs: number; albums: number; artists?: number; answerMs: number; how: ShopSearchHow; ok?: boolean }): ShopFunnelEvent | null
  /** A save from the search's results (song or album). */
  saved(kind: 'song' | 'album'): void
  /** The results were left (box cleared, tab left, window closing). */
  left(): ShopFunnelEvent | null
}

export function createShopFunnel(now: () => number): ShopFunnel {
  let open: (OpenSearch & { ok: boolean }) | null = null

  const close = (): ShopFunnelEvent | null => {
    const s = open
    open = null
    if (!s) return null
    if (s.saves === 0 && now() - s.at < KEYSTROKE_MS) return null
    return {
      kind: 'action',
      name: 'shop.search',
      ms: Math.max(0, Math.round(s.answerMs)),
      ok: s.ok,
      detail: {
        len: s.len,
        hits: s.hits,
        songs: s.songs,
        albums: s.albums,
        ...(typeof s.artists === 'number' ? { artists: s.artists } : {}),
        how: s.how,
        saves: s.saves,
        albumSaves: s.albumSaves,
        firstSaveMs: s.firstSaveMs,
        lookedMs: Math.max(0, Math.round(now() - s.at)),
      },
    }
  }

  return {
    searched(o) {
      const ev = close()
      open = {
        at: now(), len: Math.max(0, Math.round(o.len)), hits: o.hits, songs: o.songs, albums: o.albums, artists: o.artists,
        answerMs: o.answerMs, how: o.how, saves: 0, albumSaves: 0, firstSaveMs: null, ok: o.ok ?? true,
      }
      return ev
    },
    saved(kind) {
      if (!open) return
      open.saves++
      if (kind === 'album') open.albumSaves++
      if (open.firstSaveMs === null) open.firstSaveMs = Math.max(0, Math.round(now() - open.at))
    },
    left: close,
  }
}

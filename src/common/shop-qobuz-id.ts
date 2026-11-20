/**
 * The Record Shop assumes it's on Qobuz (Brief 261).
 *
 * A row the shop shows (a song, an album) is resolved, in the background, to
 * the one Qobuz id it names, so Save does what a pasted link does: `rip id
 * qobuz <type> <id>`, no search walk, no candidates downloaded to be judged.
 * Two ways to an id, both held to the same rules as the lossless dot:
 *
 *  - the page's own Qobuz catalogue answer (the dot's question, now with ids);
 *  - songs: the recording's ISRC (Deezer's match of the row, by title, artist
 *    and length within 3 s), asked of Qobuz's catalogue search; albums: the
 *    release's UPC (Deezer's), picked out of Qobuz's album hits by barcode.
 *
 * Main checks the id again before and after it downloads (the explicit rule,
 * the album's listing against the edition, the file's own tags and clock) and
 * walks as before on any doubt. So a plan here is a shortcut, never a verdict:
 * no plan shows nothing and runs today's walk, and nothing here ever says "no".
 *
 * Pure: no I/O, no clock. node --test covers the rules.
 */
import { nameKey } from './fold-text.ts'
import { displayAlbumTitle } from './shop-search.ts'
import type { QobuzHit } from './shop-lossless.ts'
import type { UsageDetail } from './usage-log.ts'

export type PlanHow = 'catalog' | 'isrc' | 'upc' | 'preflight'

/** One row resolved to one Qobuz item. */
export interface QobuzPlan {
  id: string
  kind: 'album' | 'track'
  how: PlanHow
  explicit?: boolean
  hires?: boolean
}

/** What a shop row says about itself (Apple's listing of it). */
export interface PlanRow {
  kind: 'album' | 'song'
  artist: string
  /** The song's title, or the album's name. */
  title: string
  /** Songs: the album the row is on. */
  album?: string
  durationMs?: number
  /** Apple's explicitness: the row is the explicit cut, or the cleaned one. */
  explicit?: boolean
  cleaned?: boolean
  /** Albums: the edition's size. */
  trackCount?: number
}

/** The evidence beyond the page's hits: the recording's ISRC or the release's UPC. */
export interface PlanEvidence { isrc?: string; upc?: string }

/** Max length difference between Apple's row and Qobuz's track. ⚠️ TWIN of shareLink.ts SPOTIFY_DURATION_TOLERANCE_MS (JakeTunesMobile). */
export const PLAN_DURATION_TOLERANCE_MS = 3000

/** A Qobuz id main will hand to `rip id`: letters and digits only. */
export const isQobuzId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9]{1,40}$/.test(v)

const k = (s: string | undefined): string => nameKey(s ?? '', '')
const artistKeys = (a: string): string[] => [...new Set([k(a), k(a.replace(/^the\s+/i, ''))].filter(Boolean))]
const sameArtist = (want: string, got: string | undefined): boolean => {
  if (!got) return false
  const g = new Set(artistKeys(got))
  return artistKeys(want).some((a) => g.has(a))
}
/** Any credit on the hit names the artist ("A feat. B", "A & B", "B, A"): loose on purpose, used only where a match can only send Save down the walk. */
const anyCredit = (want: string, got: string | undefined): boolean => {
  if (!got) return false
  if (sameArtist(want, got)) return true
  const w = new Set(artistKeys(want))
  return got.split(/\s*(?:,|&|\band\b|\bfeat\.?|\bfeaturing\b|\bft\.?|\bwith\b|\bx\b|\/)\s*/i).some((part) => artistKeys(part).some((a) => w.has(a)))
}
/** A copy flagged explicit, or named so ("Song (Explicit)", version "Explicit"). */
const saysExplicitCopy = (h: QobuzHit): boolean => h.explicit === true || /\bexplicit\b/i.test(`${h.title} ${h.version ?? ''}`)
const titleKeys = (h: QobuzHit): string[] => [h.title, h.version ? `${h.title} (${h.version})` : ''].filter(Boolean).map((t) => k(t)).filter(Boolean)
/**
 * Version words that make an item another cut of the song: a live take, a demo, a remix, an
 * edit. Copied (common can't import main) from streamrip-match.ts VERSION_MARKER, which the
 * walk's judge holds every file to. "Remastered", "Explicit", "Album Version" are not here: a
 * remaster is the recording.
 */
const OTHER_VERSION = /^(live|unplugged|acoustic|rerecord|rerecorded|rerecording|rerecordings|rerecords|demo|demos|karaoke|tribute|instrumental|instrumentals|remix|remixed|remixes|reedit|mix|mixes|megamix|extended|mashup|mashups|medley|sped|spedup|slowed|reverb|nightcore|chopped|screwed|8d|soundalike|cover|covers|bootleg|session|sessions|rehearsal|rehearsals|alternate|alt|acapella|acappella|concert|dub|club|amended|amendedd|clean|cleaned|censored|edit|edited|radio)$/
const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
/**
 * Qobuz's version field names another cut the row's own title doesn't ask for ("Live", "Radio
 * Edit", "Taylor's Version"). Count-based like streamrip-match.ts unwantedVersionOf: "Live and
 * Let Die" asks for one "live", so "Live and Let Die (Live)" is still another cut. "Original
 * Mix" is the recording.
 */
export function versionIsAnotherCut(wantTitle: string, hitTitle: string, version: string | undefined): boolean {
  const v = (version ?? '').replace(/\boriginal\s+mix\b/gi, '')
  if (!v.trim()) return false
  if (/\p{L}['’]s\s+version/iu.test(v) && !/\p{L}['’]s\s+version/iu.test(wantTitle)) return true
  const budget = new Map<string, number>()
  for (const w of words(wantTitle)) budget.set(w, (budget.get(w) ?? 0) + 1)
  for (const w of words(`${hitTitle} ${v}`)) {
    const left = budget.get(w) ?? 0
    if (left > 0) { budget.set(w, left - 1); continue }
    if (OTHER_VERSION.test(w)) return true
  }
  return false
}
const sameTitle = (want: string, h: QobuzHit): boolean => {
  const w = k(want)
  return Boolean(w) && titleKeys(h).includes(w) && !versionIsAnotherCut(want, h.title, h.version)
}
/** "Nevermind (Remastered)" and "Nevermind" are the same album NAME here; the edition is the track count's job. */
const bareAlbum = (s: string | undefined): string => k(displayAlbumTitle(s ?? '').replace(/\s*[([{][^)\]}]*[)\]}]/g, ''))
const VARIOUS = /^(?:various(?: artists)?|va|v\.a\.)$/i
const isCompilation = (artist: string, h: QobuzHit): boolean => {
  const by = h.albumArtist?.trim()
  if (!by) return false
  return VARIOUS.test(by) || !sameArtist(artist, by)
}
const digits = (s: string | undefined): string => (s ?? '').replace(/\D/g, '').replace(/^0+/, '')

/**
 * The explicit rule, as the walk keeps it (exact-recording.ts judgeHitsByMeta):
 * explicit wins by default. An explicit row, or Apple's cleaned edition of an
 * explicit record, takes only a copy Qobuz flags explicit; any other row takes
 * the explicit copy when there is one among the matches.
 */
function explicitPool(row: PlanRow, cands: QobuzHit[]): QobuzHit[] {
  if (row.explicit || row.cleaned) return cands.filter((h) => h.explicit === true)
  return cands.some((h) => h.explicit === true) ? cands.filter((h) => h.explicit !== false) : cands
}

const withinClock = (h: QobuzHit, durationMs: number | undefined): boolean =>
  !durationMs || (typeof h.durationSec === 'number' && Math.abs(h.durationSec * 1000 - durationMs) <= PLAN_DURATION_TOLERANCE_MS)

/**
 * An explicit copy of the song among Qobuz's hits: the same title and artist, the same length
 * within 3 s (when one is known), on any of the artist's own albums (a compilation's flag
 * proves nothing about the recording: exact-recording.ts judgeHitsByMeta). While one exists a
 * copy flagged clean is the clean edit, whatever its ISRC says: the walk's "explicit wins by
 * default" is a comparison of copies, and an id alone can't make it. Not held to the row's
 * album on purpose: the "Deluxe" and the standard edition are one record, and a sibling that
 * only sends Save down the walk costs a few seconds, never the wrong file.
 */
export function explicitSibling(want: { artist: string; title: string; durationMs?: number }, hits: readonly QobuzHit[]): QobuzHit | null {
  return hits.find((h) => h.kind === 'track' && saysExplicitCopy(h) && anyCredit(want.artist, h.artist) && sameTitle(want.title, h)
    && !isCompilation(want.artist, h) && withinClock(h, want.durationMs)) ?? null
}

const planOf = (h: QobuzHit, how: PlanHow): QobuzPlan | null => h.id && isQobuzId(h.id)
  ? { id: h.id, kind: h.kind, how, ...(h.explicit !== undefined ? { explicit: h.explicit } : {}), ...(h.hires ? { hires: true } : {}) }
  : null

/**
 * The one Qobuz item a row names, or null (show nothing, walk as today).
 *
 * A song: the same title and artist, the same length within 3 s (or the same
 * ISRC), the explicit rule, and on the row's own album: a copy on another
 * album or a compilation is the walk's to weigh (Brief 231's real album), so
 * it is no plan. Several copies left are the same recording on the same album
 * (a reissue's twin ids): the hi-res one, else the first.
 *
 * An album: the same name and artist, the explicit rule, and the edition's
 * size. The release's UPC picks among editions, and never overrules the size:
 * a UPC Deezer matched to a Deluxe is a Deluxe. Two editions still standing
 * with no barcode to choose are no plan.
 *
 * Apple's cleaned song row is no plan: its length is the clean edit's, so
 * nothing here can prove which recording the explicit copy is.
 */
export function resolvePlan(row: PlanRow, hits: readonly QobuzHit[], ev: PlanEvidence = {}): QobuzPlan | null {
  // A song by ISRC: `hits` must hold the row's catalogue answer too (main passes both), or an
  // explicit sibling with another ISRC can't be seen and the clean edit would stand alone.
  if (!row.artist || !row.title) return null
  if (row.kind === 'song') {
    if (row.cleaned) return null
    const isrc = (ev.isrc ?? '').toUpperCase()
    let cands = hits.filter((h) => h.kind === 'track' && sameArtist(row.artist, h.artist) && sameTitle(row.title, h))
    if (!row.durationMs && !isrc) return null
    // The explicit rule first, over every copy of the song by name: an ISRC that points at the
    // clean edit must not leave it alone in the pool. An explicit copy at the row's length
    // means a copy flagged clean is never the plan.
    const sibling = row.explicit ? null : explicitSibling(row, hits)
    cands = row.explicit ? explicitPool(row, cands) : sibling ? cands.filter((h) => saysExplicitCopy(h)) : cands
    if (isrc) cands = cands.filter((h) => (h.isrc ?? '').toUpperCase() === isrc)
    if (row.durationMs) cands = cands.filter((h) => withinClock(h, row.durationMs))
    if (row.album) {
      const want = bareAlbum(row.album)
      cands = cands.filter((h) => bareAlbum(h.album) === want)
    }
    cands = cands.filter((h) => !isCompilation(row.artist, h) || (row.album && bareAlbum(h.album) === bareAlbum(row.album) && !VARIOUS.test(h.albumArtist ?? '')))
    if (!cands.length) return null
    const named = cands.filter(saysExplicitCopy)
    const pool = named.length ? named : cands
    const pick = pool.find((h) => h.hires) ?? pool[0]
    return planOf(pick, isrc ? 'isrc' : 'catalog')
  }
  const name = k(displayAlbumTitle(row.title))
  if (!name) return null
  let cands = hits.filter((h) => h.kind === 'album' && sameArtist(row.artist, h.artist) && titleKeys(h).includes(name))
  cands = explicitPool(row, cands)
  if (row.trackCount) cands = cands.filter((h) => h.tracksCount === row.trackCount)
  const upc = digits(ev.upc)
  if (upc) {
    const byCode = cands.filter((h) => digits(h.upc) === upc)
    if (byCode.length) return planOf(byCode.find((h) => h.hires) ?? byCode[0], 'upc')
  }
  if (!row.trackCount || cands.length !== 1) return null
  return planOf(cands[0], 'catalog')
}

/** A row as main receives it over IPC: only the fields above, of the right type and size; anything else is no row. */
export function planRowFrom(v: unknown): PlanRow | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const text = (x: unknown): string => (typeof x === 'string' ? x.trim().slice(0, 200) : '')
  const kind = o.kind === 'album' || o.kind === 'song' ? o.kind : null
  const artist = text(o.artist), title = text(o.title)
  if (!kind || !artist || !title) return null
  const row: PlanRow = { kind, artist, title }
  const album = text(o.album)
  if (album) row.album = album
  if (typeof o.durationMs === 'number' && o.durationMs >= 1000 && o.durationMs <= 4 * 3600_000) row.durationMs = Math.round(o.durationMs)
  if (o.explicit === true) row.explicit = true
  if (o.cleaned === true) row.cleaned = true
  if (Number.isSafeInteger(o.trackCount) && (o.trackCount as number) > 0 && (o.trackCount as number) <= 500) row.trackCount = o.trackCount as number
  return row
}

/** A shop job's row (the queue's QResult shape), or null when it isn't one a plan can answer. */
export function planRowOfJob(r: { kind?: string; mediaType?: string; artist?: string; title?: string; album?: string; durationMs?: number; explicitSource?: boolean; cleanedSource?: boolean; trackCount?: number; sourceEdition?: unknown; lossyOk?: boolean }): PlanRow | null {
  if (r.kind !== 'query' || r.sourceEdition || r.lossyOk || !r.artist) return null
  const album = r.mediaType === 'album'
  return planRowFrom({
    kind: album ? 'album' : 'song', artist: r.artist, title: album ? r.album : r.title, album: album ? undefined : r.album,
    durationMs: r.durationMs, explicit: r.explicitSource === true, cleaned: r.cleanedSource === true, trackCount: album ? r.trackCount : undefined,
  })
}

/** The cache key for a row: what makes it this request (the same words twice ask once). */
export function planKey(row: PlanRow): string {
  return [row.kind, k(row.artist), k(row.kind === 'album' ? displayAlbumTitle(row.title) : row.title), row.kind === 'song' ? bareAlbum(row.album) : '',
    row.durationMs ? Math.round(row.durationMs / 1000) : '', row.trackCount ?? '', row.explicit ? 'e' : row.cleaned ? 'c' : ''].join('|')
}

/** A plan worth saying "On Qobuz" for: a song by its ISRC or the page's exact match, an album by its barcode or its one edition. */
export const planIsSure = (p: QobuzPlan | null | undefined): p is QobuzPlan => Boolean(p && isQobuzId(p.id))

/** The words under the shop's mark when a plan, and not the dot, is what knows. */
export const planTitle = (p: QobuzPlan): string => p.hires ? 'On Qobuz in hi-res' : 'On Qobuz'

// ── Deezer: the ISRC and the UPC ─────────────────────────────────────────
// ⚠️ Copied (not imported) from JakeTunesMobile/backend/src/util/shareLink.ts:
// searchName, primaryArtist, titleMatches, artistMatches, pickBest, deezerIsrc,
// deezerUpc. The desktop has no backend import; a change there is a change here.

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const fold = (s: string): string => nameKey(s, '')
const bareName = (s: string): string => fold(searchName(s))

/** The title without brackets or a trailing " - …". */
export function searchName(s: string): string {
  const bare = s.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+[-–—]\s+.*$/, '').trim()
  return bare || s.trim()
}
/** First credited artist: "Nu Genea & Célia Kameni" → "Nu Genea". */
export function primaryArtist(s: string): string {
  return s.split(/\s+(?:feat\.?|ft\.?|featuring|with|x)\s+|\s*[,;/]\s*|\s+&\s+/i)[0]?.trim() || s.trim()
}
const titleMatches = (want: string, got: string): boolean => Boolean(want && got) && (fold(want) === fold(got) || bareName(want) === bareName(got))
const artistMatches = (want: string, got: string): boolean => {
  const w = fold(want), g = fold(got)
  if (!w || !g) return false
  if (w === g) return true
  const wp = fold(primaryArtist(want)), gp = fold(primaryArtist(got))
  return wp === gp || wp === g || w === gp
}

/** Deezer's search for a row: plain words (its advanced syntax misses records the plain search finds). */
export function deezerSearchPath(row: PlanRow): string {
  const q = `${primaryArtist(row.artist)} ${searchName(row.title)}`
  return `search${row.kind === 'album' ? '/album' : ''}?q=${encodeURIComponent(q)}&limit=25`
}

/**
 * Deezer's match of a row, or null. A song must be the same title and artist
 * and run within 3 s of Apple's length (no length, no match: the ISRC would
 * be a guess); the row's album breaks ties. An album: the same title and
 * artist, the same size when Deezer says it.
 */
export function pickDeezer(row: PlanRow, body: unknown): string | null {
  let best: { id: string; score: number } | null = null
  for (const d0 of arr(obj(body).data)) {
    const d = obj(d0)
    const id = str(d.id)
    const title = str(d.title)
    const artist = str(obj(d.artist).name)
    if (!id || !titleMatches(row.title, title) || !artistMatches(row.artist, artist)) continue
    let score = fold(row.title) === fold(title) ? 1 : 0
    if (row.kind === 'song') {
      if (!row.durationMs || typeof d.duration !== 'number' || Math.abs(d.duration * 1000 - row.durationMs) > PLAN_DURATION_TOLERANCE_MS) continue
      const album = str(obj(d.album).title)
      if (row.album && album) score += fold(row.album) === fold(album) ? 3 : bareName(row.album) === bareName(album) ? 2 : 0
    } else if (row.trackCount && typeof d.nb_tracks === 'number') {
      if (d.nb_tracks !== row.trackCount) continue
      score += 1
    }
    if (!best || score > best.score) best = { id, score }
  }
  return best?.id ?? null
}

export function deezerIsrc(body: unknown): string | null {
  const v = str(obj(body).isrc).trim().toUpperCase()
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v) ? v : null
}
export function deezerUpc(body: unknown): string | null {
  const v = str(obj(body).upc).trim()
  return /^\d{12,14}$/.test(v) ? v : null
}

/**
 * Deezer's public API allows 50 requests per 5 seconds. A window that never
 * lets more than `max` through in any `windowMs`: `wait()` says how long the
 * next request must wait (0 = now) and books its slot.
 */
export function createRateWindow(max: number, windowMs: number, now: () => number): { wait(): number } {
  const sent: number[] = []
  return {
    wait(): number {
      const t = now()
      while (sent.length && t - sent[0] >= windowMs) sent.shift()
      const at = sent.length < max ? t : sent[sent.length - max] + windowMs
      sent.push(at)
      return Math.max(0, at - t)
    },
  }
}
export const DEEZER_MAX_PER_WINDOW = 45   // under Deezer's 50; covers this feature's calls only, the app's other Deezer callers keep their own pace
export const DEEZER_WINDOW_MS = 5000

/** How long a plan (or no plan) is kept, and how many rows one ask may carry. */
export const PLAN_TTL_MS = 6 * 60 * 60_000
export const PLAN_FAIL_QUIET_MS = 10 * 60_000
export const PLAN_MAX_ENTRIES = 2000
export const PLAN_ROWS_PER_ASK = 20
export const PLAN_CONCURRENCY = 2

// ── The download's path, for the usage log ────────────────────────────────

/** Why a by-id download walked instead (main's words, fixed). */
export type ByIdFallback =
  | 'gone' | 'no-answer' | 'explicit' | 'listing' | 'no-clock' | 'wrong-recording' | 'other-album'
  | 'compilation' | 'stage' | 'judge' | 'canceled'

/**
 * One `shop.download-path` line per shop download: did it go by id, or walk,
 * and when an id was there and it walked anyway, why. No title, no id: fixed
 * words only (usage-log.ts's no-words rule).
 */
export function downloadPathEvent(o: { lane: 'album' | 'song'; via: 'id' | 'walk'; how?: PlanHow; fellBack?: ByIdFallback; ok: boolean; ms: number }): { kind: 'action'; name: 'shop.download-path'; ms: number; ok: boolean; detail: UsageDetail } {
  const detail: UsageDetail = { lane: o.lane, via: o.via }
  if (o.how) detail.how = o.how
  if (o.fellBack) detail.fell = o.fellBack
  return { kind: 'action', name: 'shop.download-path', ms: Math.max(0, Math.round(o.ms)), ok: o.ok, detail }
}

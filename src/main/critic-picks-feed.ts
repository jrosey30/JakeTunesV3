/**
 * Critic picks — the main half (2026-10-18). Fetches and caches the
 * blogger's sheet, plans today's wall against the served ledger, proves each
 * pick is a real record in the catalogue, and hands index.ts's feed builder
 * plain FeedCards on lane 'critic-picks'. From there a pick takes the SAME
 * path as every other shop album: filterFeed (owned / Not for me / Dislike),
 * the brain %, the genre bins, the iTunes hook sample, + List → Get.
 *
 * Read-only on taste: nothing here appends to the taste ledger, touches the
 * verdict stream or feeds the brain. The blogger's score orders this wall and
 * rides on the card as a credit line — it never becomes a signal. (Measured:
 * Spearman ≈ −0.03 vs Jake's plays over the 299 albums both share.)
 *
 * The sheet is GET-only, fetched at most once a local day, and cached on disk
 * so the wall stands offline. Policy (parser, ledger, pacing) is pure in
 * common/critic-picks.ts.
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from './atomic-write.ts'
import {
  CRITIC_LANE, CRITIC_PICKS_SOURCE, bareKey, criticCandidates, criticGenre, criticNote, criticRowKey,
  criticSheetCsvUrl, emptyCriticLedger, localDayKey, mergeCriticLedger, normalizeCriticLedger,
  parseCriticSheet, planCriticDay,
  type CriticAlbum, type CriticLedger, type CriticPick, type CriticRow, type CriticSource,
} from '../common/critic-picks.ts'
import { nameKey } from '../common/fold-text.ts'
import { searchTitle } from './streamrip-match.ts'
import {
  acceptableHit, artistContributors, baseTitleKey, cardKey, deezerVerify, itunesVerify,
  ownershipChecks, CARD_REST_VIEWS, type FeedCard,
} from './discover-feed.ts'

export const CRITIC_SHEET_FILE = 'critic-sheet.json'
export const CRITIC_LEDGER_FILE = 'critic-picks-ledger.json'

// ── Album identity ───────────────────────────────────────────────────

/** A title as comparable words: edition brackets out (baseTitleKey), any
 *  script folded, a leading article dropped. */
function titleWords(s: string): string[] {
  const w = nameKey(baseTitleKey(s)).split(' ').filter(Boolean)
  return w.length > 1 && /^(?:the|a|an)$/.test(w[0]) ? w.slice(1) : w
}
/** A word that makes a DIFFERENT record when it follows the shared title —
 *  "Led Zeppelin II" / "III", "Illmatic XX", "Saturation 3", "Vol. 2". */
const SEQUEL = /^(?:\d+|(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})|part|pt|vol|volume|chapter|season|book|act)$/
/** Left-over words that make it a different RECORDING ("Rumours Live"). */
const VERSION = /^(?:live|acoustic|demos?|remix(?:es)?|unplugged|instrumentals?|karaoke|sessions?|bootleg|outtakes?|rehearsals?)$/

/**
 * Is `got` the album the sheet means by `want`? The sheet is hand-typed —
 * "Low End Theory", "Court of the Crimson King", "My Beautiful Dark Twisted"
 * — so equality alone would lose real records, and a loose match would seat
 * the wrong one. Edition brackets, punctuation, spacing and a leading article
 * never count. Past that, the shorter title must be the start or the end of
 * the longer one, word for word, carrying at least half of it, and what it leaves
 * over must not open with a sequel number or name another version (live,
 * demo, remix…). A title the sheet itself marked cut off ("…") may be any
 * word-prefix. Self-titled records (either side) match EXACTLY — "Led
 * Zeppelin" is never "Led Zeppelin IV", nor "Fleetwood Mac" a live set.
 */
export function sameAlbumTitle(want: string, got: string, artist: string, truncated = false): boolean {
  const w = titleWords(want), g = titleWords(got)
  if (!w.length || !g.length) return false
  const wj = w.join(''), gj = g.join('')
  if (wj === gj) return true
  const self = bareKey(artist)
  if (wj === self || gj === self) return false
  if (truncated && wj.length >= 6 && w.length <= g.length
    && w.slice(0, -1).every((x, i) => x === g[i]) && g[w.length - 1].startsWith(w[w.length - 1])) return true
  const [short, long] = w.length <= g.length ? [w, g] : [g, w]
  if (short.length === long.length) return false
  const sj = short.join('')
  if (sj.length < 4 || sj.length / long.join('').length < 0.5) return false
  const off = long.length - short.length
  const isPrefix = short.every((x, i) => x === long[i])
  const isSuffix = !isPrefix && short.every((x, i) => x === long[off + i])
  if (!isPrefix && !isSuffix) return false
  const extra = isPrefix ? long.slice(short.length) : long.slice(0, off)
  if (extra.some((x) => VERSION.test(x))) return false
  // The word touching the shared title decides a sequel: "Led Zeppelin II".
  return !SEQUEL.test(isPrefix ? extra[0] : extra[extra.length - 1])
}

/**
 * Owned, asked the way the rest of the shop asks it (ownershipChecks — the
 * supply lanes' check, accent- and article-aware) plus one question only
 * the sheet needs: is an album he owns by this artist the same record under
 * the sheet's shorthand? Album titles only — a title track does not make
 * the album owned here. Over-matching only refuses a pick: the safe side.
 */
export function criticOwnership(
  owned: { artists: Set<string>; albumKeys: Set<string>; baseKeys: Set<string> },
  tracks: ReadonlyArray<{ artist?: string; albumArtist?: string; album?: string }>,
): (artist: string, title: string, truncated?: boolean) => boolean {
  const { ownsAlbum } = ownershipChecks(owned)
  const byArtist = new Map<string, Set<string>>()
  for (const t of tracks) {
    const album = String(t.album || '').trim()
    if (!album) continue
    for (const who of [t.artist, t.albumArtist]) {
      for (const name of artistContributors(String(who || ''))) {
        const k = bareKey(name)
        if (!k) continue
        const set = byArtist.get(k) ?? new Set<string>()
        set.add(album)
        byArtist.set(k, set)
      }
    }
  }
  return (artist, title, truncated = false) =>
    ownsAlbum(artist, title) || [...(byArtist.get(bareKey(artist)) ?? [])].some((a) => sameAlbumTitle(title, a, artist, truncated))
}

type ItunesFn = (term: string, entity: 'album', want: { artist: string; title: string }) => Promise<{ artist: string; title: string; year?: string; artUrl?: string; collectionId?: number } | null>
type DeezerFn = (artist: string, title: string) => Promise<{ artist: string; title: string; year?: string; artUrl?: string } | null>

/** The catalogue's word on a sheet row: iTunes first (its collection id is
 *  what the hook-sample pass needs), Deezer second (the underground Apple
 *  does not carry). Both must name the artist (acceptableHit — the shop's
 *  wrong-artist guard) and the album (sameAlbumTitle). No answer = no card.
 *  The title keeps the catalogue's spelling minus pure edition dressing
 *  (searchTitle): the blogger rated "Emotion", not its 10th Anniversary
 *  Edition — the edition is chosen in Browse at Get, like any shop album. */
export async function resolveCriticAlbum(r: CriticRow, deps: { itunes: ItunesFn; deezer: DeezerFn }): Promise<CriticAlbum | null> {
  const hint = { artist: r.artist, title: r.title }
  const v = await deps.itunes(`${r.artist} ${r.title}`, 'album', hint).catch(() => null)
  if (v && acceptableHit(hint, v) && sameAlbumTitle(r.title, v.title, r.artist, r.truncated)) {
    return { artist: v.artist, title: searchTitle(v.title), year: v.year, artUrl: v.artUrl, collectionId: v.collectionId }
  }
  const d = await deps.deezer(r.artist, r.title).catch(() => null)
  if (d?.artUrl && acceptableHit(hint, d) && sameAlbumTitle(r.title, d.title, r.artist, r.truncated)) {
    return { artist: d.artist, title: searchTitle(d.title), year: d.year, artUrl: d.artUrl }
  }
  return null
}

// ── The sheet, cached ────────────────────────────────────────────────

interface SheetCache { sourceId: string; sheetId: string; gid: string; day: string; fetchedAt: number; csv: string }
/** Per cache file: when its last fetch failed (no retry for an hour). */
const lastFetchFailAt = new Map<string, number>()

/** A Google login page or an error doc must never stand in for the sheet
 *  ("HTTP 200 is not the service"): the header must name the columns. */
export function looksLikeCriticSheet(csv: string): boolean {
  const head = String(csv || '').split(/\r?\n/, 1)[0].toLowerCase()
  return head.includes('"artist"') && head.includes('"score"') && head.includes('"title"')
}

async function fetchSheetText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`sheet HTTP ${res.status}`)
  return res.text()
}

/** Today's copy of the sheet: the disk cache when it was fetched today, else
 *  one GET (15 s timeout); on any failure the last good copy, whatever its
 *  age. A failed fetch is not retried for an hour. */
export async function loadCriticRows(
  stateDir: string,
  source: CriticSource,
  opts: { now: Date; fetchText?: (url: string) => Promise<string> },
): Promise<CriticRow[]> {
  const path = join(stateDir, CRITIC_SHEET_FILE)
  const today = localDayKey(opts.now)
  let cached: SheetCache | null = null
  try { cached = JSON.parse(await readFile(path, 'utf-8')) as SheetCache } catch { cached = null }
  const sameSheet = !!cached && cached.sheetId === source.sheetId && cached.gid === source.gid && typeof cached.csv === 'string'
  if (sameSheet && cached!.day === today) return parseCriticSheet(cached!.csv)
  if (opts.now.getTime() - (lastFetchFailAt.get(path) ?? 0) > 3_600_000) {
    try {
      const csv = await (opts.fetchText ?? fetchSheetText)(criticSheetCsvUrl(source))
      if (!looksLikeCriticSheet(csv)) throw new Error('response is not the ratings sheet')
      const rows = parseCriticSheet(csv)
      if (!rows.length) throw new Error('sheet parsed to zero rows')
      await writeJsonAtomic(path, { sourceId: source.id, sheetId: source.sheetId, gid: source.gid, day: today, fetchedAt: opts.now.getTime(), csv } satisfies SheetCache, false)
      return rows
    } catch (err) {
      lastFetchFailAt.set(path, opts.now.getTime())
      console.warn(`[critic-picks] sheet fetch failed — ${sameSheet ? `using the copy from ${cached!.day}` : 'no cached copy, the wall stays empty'}:`, err instanceof Error ? err.message : err)
    }
  }
  return sameSheet ? parseCriticSheet(cached!.csv) : []
}

// ── The served ledger ────────────────────────────────────────────────

/** null = the file exists but cannot be read: refuse to plan (a fresh empty
 *  ledger would serve every old pick again — the JsonFileCache safety lock). */
async function readLedger(path: string, sourceId: string): Promise<CriticLedger | null> {
  try {
    return normalizeCriticLedger(JSON.parse(await readFile(path, 'utf-8')), sourceId)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyCriticLedger(sourceId)
    console.warn('[critic-picks] ledger unreadable — the wall stays empty rather than repeat old picks:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Cards ────────────────────────────────────────────────────────────

/** ⚠️ TWIN: src/renderer/views/NewForYouView.tsx cardId — the key "Not for
 *  me" stamps its card rest under (discovery-not-for-me). */
const rendererCardId = (artist: string, title: string): string => `disc|${artist}|${title}`.toLowerCase()

export interface CriticGates {
  owns: (artist: string, title: string, truncated?: boolean) => boolean
  /** Rock DNA Dislike + the taste-profile genre gate (discovery-focus blocks). */
  blocks: (card: { artist: string; genre?: string }) => boolean
  notForMe: Record<string, unknown>
  served: Record<string, { views: number } | undefined>
  isOnList: (artist: string, title: string, kind?: 'song' | 'album') => boolean
}

export function criticExclusions(g: CriticGates): {
  row: (r: CriticRow) => boolean
  album: (a: CriticAlbum, genre: string) => 'owned' | 'excluded' | null
} {
  const vetoed = new Set<string>()
  for (const [k, v] of Object.entries(g.notForMe)) {
    vetoed.add(bareKey(k))
    const named = (v as { artist?: unknown } | null)?.artist
    if (typeof named === 'string') vetoed.add(bareKey(named))
  }
  const rested = (artist: string, title: string): boolean =>
    [cardKey({ artist, title }), rendererCardId(artist, title)].some((k) => (g.served[k]?.views ?? 0) >= CARD_REST_VIEWS)
  const out = (artist: string, title: string, genre: string): boolean =>
    vetoed.has(bareKey(artist)) || rested(artist, title) || g.blocks({ artist, genre }) || g.isOnList(artist, title, 'album')
  return {
    row: (r) => g.owns(r.artist, r.title, r.truncated) || out(r.artist, r.title, criticGenre(r)),
    album: (a, genre) => g.owns(a.artist, a.title) ? 'owned' : out(a.artist, a.title, genre) ? 'excluded' : null,
  }
}

/** A seated pick as a shop card. No `because` (the library didn't bridge to
 *  it — the blogger chose it) and no `desc` (the credit is not a sound; it
 *  must never reach the brain's embedding). The year is the sheet's — the
 *  record's own — where the catalogue's is often a reissue date. */
export function criticCard(p: CriticPick, source: CriticSource): FeedCard {
  return {
    lane: CRITIC_LANE, type: 'album',
    artist: p.album.artist, title: p.album.title,
    year: p.sheet.year ? String(p.sheet.year) : p.album.year,
    why: criticNote(source.credit, p.score),
    artUrl: p.album.artUrl,
    genre: criticGenre(p.sheet),
    collectionId: p.album.collectionId,
    source: { kind: 'person', id: source.id, name: source.credit.trim() },
  }
}

export interface CriticPickInput {
  stateDir: string
  tracks: ReadonlyArray<{ artist?: string; albumArtist?: string; album?: string }>
  owned: { artists: Set<string>; albumKeys: Set<string>; baseKeys: Set<string> }
  blocks: CriticGates['blocks']
  feedback: () => Promise<{ notForMe: CriticGates['notForMe']; served: CriticGates['served'] }>
  isOnList: () => Promise<CriticGates['isOnList']>
  source?: CriticSource
  now?: Date
  fetchText?: (url: string) => Promise<string>
  itunes?: ItunesFn
  deezer?: DeezerFn
  /** Apple politeness between lookups; tests pass 0. */
  sleepMs?: number
}

/**
 * Today's critic wall as feed cards — [] when the credit is unset (no fake
 * byline), the sheet is unavailable, or the ledger is unreadable. A day's
 * picks are planned once and kept on the ledger; each generation re-checks
 * them (owned since, Not for me, Disliked, listed) and shows the rest.
 */
export async function criticPickCards(input: CriticPickInput): Promise<FeedCard[]> {
  const source = input.source ?? CRITIC_PICKS_SOURCE
  if (!source.credit.trim()) return []
  const now = input.now ?? new Date()
  const today = localDayKey(now)
  const rows = await loadCriticRows(input.stateDir, source, { now, fetchText: input.fetchText })
  if (!rows.length) return []
  const path = join(input.stateDir, CRITIC_LEDGER_FILE)
  const ledger = await readLedger(path, source.id)
  if (!ledger) return []
  const fb = await input.feedback()
  const ex = criticExclusions({
    owns: criticOwnership(input.owned, input.tracks), blocks: input.blocks,
    notForMe: fb.notForMe ?? {}, served: fb.served ?? {}, isOnList: await input.isOnList(),
  })
  const sleepMs = input.sleepMs ?? 250
  const deps = {
    itunes: input.itunes ?? itunesVerify,
    deezer: input.deezer ?? ((a: string, t: string) => deezerVerify(a, t)),
  }
  const genreOf = new Map<string, string>()
  const candidates = criticCandidates(rows, source.minScore)
  let lookups = 0
  const plan = await planCriticDay({
    ledger, today, candidates, perDay: source.perDay,
    excluded: ex.row,
    resolve: async (r) => {
      if (lookups++ > 0 && sleepMs > 0) await new Promise((res) => setTimeout(res, sleepMs))
      const album = await resolveCriticAlbum(r, deps)
      if (album) genreOf.set(criticRowKey(album), criticGenre(r))
      return album
    },
    excludedAlbum: (a) => ex.album(a, genreOf.get(criticRowKey(a)) ?? ''),
  })
  let picks = plan.picks
  if (plan.changed) {
    // Onto the FRESH file, never the snapshot the plan started from.
    const disk = await readLedger(path, source.id)
    if (!disk) return []
    const merged = mergeCriticLedger(disk, plan.ledger, source.perDay)
    await writeJsonAtomic(path, merged)
    picks = merged.days[today] ?? []
  }
  const shown = picks.filter((p) => !ex.album(p.album, criticGenre(p.sheet)) && !ex.row({ ...p.sheet, score: p.score, row: 0, truncated: false }))
  const fresh = plan.changed ? picks.length - (ledger.days[today]?.length ?? 0) : 0
  console.log(`[critic-picks] ${today}: ${shown.length}/${picks.length} on the wall${fresh ? ` (${fresh} new, ${lookups} lookups)` : ''} · ${candidates.length} rows ≥ ${source.minScore}`)
  return shown.map((p) => criticCard(p, source))
}

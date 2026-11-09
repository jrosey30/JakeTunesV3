/**
 * The Record Shop's For You page, as data (2026-11-09 reorganization; Jake
 * approved ~/concert-repair/record-shop-organization.md as proposed).
 *
 * Each band answers one question, top to bottom:
 *   1. For Your iPods      — what my iPod lists are missing
 *   2. Out This Year       — what's really new (this year's releases only)
 *   3. The Crates          — what I should own, by genre (new to me)
 *   4. The Hosts' Picks    — already in my library (the WJLR personas)
 *   5. Behind the Counter  — already in my library, and overlooked
 *   6. What I've learned   — a quiet report at the bottom
 *
 * New-to-buy music comes first and owned music last. No record appears
 * twice: it is claimed by the first band that wants it (iPods, then Out This
 * Year, then the crates), and the same record from two lanes is one card.
 *
 * Every record is its own card (2026-11-09, the same afternoon; Jake: "dont
 * like the fold in"). The "+2 more by NOFX" fold is gone. Instead one artist
 * gets at most PER_ARTIST_ON_PAGE cards on the whole page, and two cards by
 * the same artist are never side by side when anything else could go
 * between them. Nothing else is capped and no crate is hidden for being small.
 *
 * Pure, node-tested (src/main/__tests__/record-shop-page.test.ts). The view
 * (renderer/views/NewForYouView.tsx) only draws what this returns.
 */
import { CRATES, fileGenre, isCrateId, type CrateId, type OtherSection } from './record-shop-bins.ts'
import { CRITIC_LANE } from './critic-picks.ts'

/** The page's bands, in the order they are drawn. */
export const SHOP_PAGE_SECTIONS = [
  'for-your-ipods', 'out-this-year', 'crates', 'hosts-picks', 'behind-the-counter', 'what-ive-learned',
] as const
export type ShopPageSection = typeof SHOP_PAGE_SECTIONS[number]

/** What each band is called on the page, and the line under it. */
export const SHOP_SECTION_TITLES: Record<ShopPageSection, { title: string; sub: string }> = {
  'for-your-ipods': { title: 'For Your iPods', sub: 'What your iPod lists are missing' },
  'out-this-year': { title: 'Out This Year', sub: 'Released this year' },
  crates: { title: 'The Crates', sub: 'New to you, filed by genre' },
  'hosts-picks': { title: "The Hosts' Picks", sub: 'Already in your library' },
  'behind-the-counter': { title: 'Behind the Counter', sub: 'Already in your library, and overlooked' },
  'what-ive-learned': { title: "What I've learned", sub: '' },
}

export interface PageCard {
  lane: string
  type: 'song' | 'album' | 'artist'
  artist: string
  title: string
  year?: string
  brainPct?: number
  genre?: string
  bin?: string
  because?: string
}

export interface WantedRow<C> { listId: string; listName: string; title: string; cards: C[] }
/** One card on a shelf; `label` is the small-section name in the mixed crate ("Reggae"). */
export interface ShelfCard<C> { card: C; label?: string }
export interface WantedShelfOut<C> { listId: string; listName: string; title: string; cards: ShelfCard<C>[] }
export interface CrateShelf<C> { id: CrateId; label: string; cards: ShelfCard<C>[] }

export interface ShopPage<C> {
  ipods: WantedShelfOut<C>[]
  outThisYear: ShelfCard<C>[]
  crates: CrateShelf<C>[]
  counts: ShopCounts
}

/** The most cards one artist gets on the whole page (iPods, Out This Year and the crates together). */
export const PER_ARTIST_ON_PAGE = 3

/** What is on the page, by where it came from. */
export interface ShopCounts {
  /** The daily records and songs. */
  records: number
  songs: number
  critic: number
  /** Every other new-to-you lane (brand new, time machine, songs to try …). */
  other: number
  outThisYear: number
  ipods: number
  /** Every card on the page's new-music bands. */
  total: number
}

const norm = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/^(?:the|a|an)\s+/, '').replace(/[^\p{L}\p{N}]+/gu, '')
/** A record's identity on the page: artist + title, spelling-insensitive. */
export const pageKey = (c: { artist: string; title: string }): string => `${norm(c.artist)}|${norm(c.title)}`
const artistKey = (c: { artist: string }): string => norm(c.artist)

const typeRank = (c: PageCard): number => (c.type === 'album' ? 0 : c.type === 'artist' ? 1 : 2)
/** Inside a crate: albums first, then the brain's best match, then as served. */
function byShelfOrder<C extends PageCard>(cards: C[]): C[] {
  return cards.map((c, i) => ({ c, i }))
    .sort((a, b) => (typeRank(a.c) - typeRank(b.c)) || ((b.c.brainPct ?? -1) - (a.c.brainPct ?? -1)) || (a.i - b.i))
    .map((x) => x.c)
}

/** Where a pick files: the crate main stamped, else its genre through Jake's rules. */
export function crateOf(c: Pick<PageCard, 'bin' | 'genre'>): { bin: CrateId; section?: OtherSection } {
  const f = fileGenre(c.genre)
  return isCrateId(c.bin) ? { bin: c.bin, section: c.bin === 'other' ? f.section : undefined } : f
}

/** The small-section label on a card in the mixed crate. A genre none of
 *  Jake's rules know shows its own name ("Comedy"), never "Oddities". */
export function shelfLabel(c: Pick<PageCard, 'genre'>, section?: OtherSection): string | undefined {
  if (!section) return undefined
  if (section !== 'ODDITIES') return sectionLabel(section)
  const g = (c.genre ?? '').trim()
  return g ? g.replace(/(^|[\s&/-])\p{Ll}/gu, (m) => m.toUpperCase()) : 'Other'
}

/** Never two cards by one artist side by side when another card could go
 *  between them. Keeps the order otherwise. */
export function spreadArtists<T>(items: T[], artistOf: (t: T) => string): T[] {
  const rest = [...items]
  const out: T[] = []
  while (rest.length) {
    const prev = out.length ? artistKey({ artist: artistOf(out[out.length - 1]) }) : null
    const i = rest.findIndex((t) => artistKey({ artist: artistOf(t) }) !== prev)
    out.push(...rest.splice(i < 0 ? 0 : i, 1))
  }
  return out
}

export function buildShopPage<C extends PageCard>(input: {
  lanes: Array<{ id: string; cards: C[] }>
  wanted: Array<WantedRow<C>>
  /** This year, as "2026". */
  year: string
  perArtist?: number
}): ShopPage<C> {
  const perArtist = input.perArtist ?? PER_ARTIST_ON_PAGE
  const claimed = new Set<string>()
  const onPage = new Map<string, number>()   // cards per artist, the whole page
  const room = (c: C): boolean => (onPage.get(artistKey(c)) ?? 0) < perArtist
  const seat = (c: C): void => { claimed.add(pageKey(c)); onPage.set(artistKey(c), (onPage.get(artistKey(c)) ?? 0) + 1) }

  // 1. For Your iPods — a record two lists want shows once, under the first.
  const ipods: WantedShelfOut<C>[] = []
  for (const row of input.wanted) {
    const cards: ShelfCard<C>[] = []
    for (const c of row.cards) {
      if (claimed.has(pageKey(c)) || !room(c)) continue
      seat(c)
      cards.push({ card: c })
    }
    if (cards.length) ipods.push({ listId: row.listId, listName: row.listName, title: row.title, cards: spreadArtists(cards, (s) => s.card.artist) })
  }

  // Every new-to-you card, once. The same record in two lanes is one card,
  // and the critic wall's copy wins (it names who recommends it).
  const pool = new Map<string, C>()
  for (const lane of input.lanes) for (const c of lane.cards) {
    const k = pageKey(c)
    if (claimed.has(k)) continue
    const had = pool.get(k)
    if (!had || (c.lane === CRITIC_LANE && had.lane !== CRITIC_LANE)) pool.set(k, c)
  }
  const isThisYear = (c: C): boolean => c.type !== 'artist' && String(c.year ?? '').slice(0, 4) === input.year

  // Best first (albums, then the brain's best match), so an artist's
  // PER_ARTIST_ON_PAGE cards are their best ones; this year's go to Out
  // This Year, the rest to their crate.
  const oty: ShelfCard<C>[] = []
  const crates: CrateShelf<C>[] = CRATES.map((cr) => ({ id: cr.id, label: cr.label, cards: [] as ShelfCard<C>[] }))
  const shelfOf = new Map(crates.map((sh) => [sh.id, sh]))
  const shown: C[] = []
  for (const c of byShelfOrder([...pool.values()])) {
    if (!room(c)) continue
    seat(c)
    shown.push(c)
    if (isThisYear(c)) { oty.push({ card: c }); continue }
    const f = crateOf(c)
    const label = shelfLabel(c, f.section)
    shelfOf.get(f.bin)!.cards.push(label ? { card: c, label } : { card: c })
  }
  for (const sh of crates) sh.cards = spreadArtists(sh.cards, (s) => s.card.artist)

  const laneCount = (id: string): number => shown.filter((c) => c.lane === id).length
  const quota = new Set(['fresh-albums', 'fresh-songs', CRITIC_LANE])
  const ipodCards = ipods.reduce((n, r) => n + r.cards.length, 0)
  return {
    ipods,
    outThisYear: spreadArtists(oty, (s) => s.card.artist),
    crates: crates.filter((sh) => sh.cards.length > 0),
    counts: {
      records: laneCount('fresh-albums'),
      songs: laneCount('fresh-songs'),
      critic: laneCount(CRITIC_LANE),
      other: shown.filter((c) => !quota.has(c.lane)).length,
      outThisYear: oty.length,
      ipods: ipodCards,
      total: ipodCards + shown.length,
    },
  }
}

/** The count line over the crates: "Today: 60 records · 60 songs · 5 critic picks · 12 other picks". */
export function shopCountLine(c: ShopCounts): string {
  const n = (k: number, one: string, many: string): string | null => (k > 0 ? `${k} ${k === 1 ? one : many}` : null)
  const parts = [
    n(c.records, 'record', 'records'),
    n(c.songs, 'song', 'songs'),
    n(c.critic, 'critic pick', 'critic picks'),
    n(c.other, 'other pick', 'other picks'),
  ].filter((p): p is string => !!p)
  return parts.length ? `Today: ${parts.join(' · ')}` : ''
}

/** The small chip on a card: what kind of pick it is. Only a record from
 *  this year says "New" (the old page called catalog records "New"). */
export function laneChip(c: Pick<PageCard, 'lane' | 'year'>, year: string): string {
  if (String(c.year ?? '').slice(0, 4) === year) return 'New release'
  return LANE_CHIPS[c.lane] ?? ''
}
export const LANE_CHIPS: Record<string, string> = {
  'brand-new': 'Recent', scene: 'Scene', missing: 'Gap', 'time-machine': 'Catalog', songs: 'Single',
  'fresh-albums': 'Daily', 'fresh-songs': 'Daily', [CRITIC_LANE]: 'Critic', 'ipod-wanted': 'iPod',
}
/** A lane's name in "What I've learned". */
export const LANE_NAMES: Record<string, string> = {
  'brand-new': 'Brand new', scene: 'Scene', missing: 'Gaps', 'time-machine': 'Time machine', songs: 'Songs to try',
  'fresh-albums': 'Daily records', 'fresh-songs': 'Daily songs', [CRITIC_LANE]: 'Critic picks', 'ipod-wanted': 'For your iPods',
}

/** The mixed crate's card label: "Reggae", "Brazil & Latin". */
export const sectionLabel = (s: OtherSection): string =>
  s.toLowerCase().replace(/(^|[\s&])\p{L}/gu, (m) => m.toUpperCase())

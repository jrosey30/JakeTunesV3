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
 * New-to-buy music comes first and owned music last. No card appears twice:
 * a record is claimed by the first band that wants it (iPods, then Out This
 * Year, then the crates), and the same record from two lanes is one card.
 * An artist has one card on the page; their other picks fold behind it
 * ("+2 more by NOFX"), in the first band that has them. Nothing is capped and
 * no crate is hidden for being small.
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
  'out-this-year': { title: 'Out This Year', sub: 'Released this year, newest first' },
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
export interface WantedShelfOut<C> { listId: string; listName: string; title: string; entries: CrateEntry<C>[] }
/** One artist's card in a crate, with their other cards folded behind it. */
export interface CrateEntry<C> { lead: C; more: C[]; section?: OtherSection }
export interface CrateShelf<C> { id: CrateId; label: string; entries: CrateEntry<C>[]; count: number }

export interface ShopPage<C> {
  ipods: WantedShelfOut<C>[]
  outThisYear: CrateEntry<C>[]
  crates: CrateShelf<C>[]
  counts: ShopCounts
}

export interface ShopCounts {
  /** The daily quota lanes, as served. */
  records: number
  songs: number
  critic: number
  /** Every other new-to-you lane (brand new, time machine, songs to try …). */
  other: number
  outThisYear: number
  ipods: number
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

export function buildShopPage<C extends PageCard>(input: {
  lanes: Array<{ id: string; cards: C[] }>
  wanted: Array<WantedRow<C>>
  /** This year, as "2026". */
  year: string
}): ShopPage<C> {
  const claimed = new Set<string>()
  const byArtist = new Map<string, CrateEntry<C>>()   // the artist's one card on the page

  // 1. For Your iPods — a record two lists want shows once, under the first.
  const ipods: WantedShelfOut<C>[] = []
  for (const row of input.wanted) {
    const entries: CrateEntry<C>[] = []
    for (const c of row.cards) {
      const k = pageKey(c)
      if (claimed.has(k)) continue
      claimed.add(k)
      const had = byArtist.get(artistKey(c))
      if (had) { had.more.push(c); continue }
      const e: CrateEntry<C> = { lead: c, more: [] }
      byArtist.set(artistKey(c), e)
      entries.push(e)
    }
    if (entries.length) ipods.push({ listId: row.listId, listName: row.listName, title: row.title, entries })
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
  const cards = [...pool.values()]

  // One artist, one card. An artist the iPods band already shows keeps their
  // picks folded there; an artist with a release from this year leads Out
  // This Year with it; everyone else leads a crate with their best card.
  const groups = new Map<string, C[]>()
  for (const c of byShelfOrder(cards)) {
    const k = artistKey(c)
    const g = groups.get(k) ?? []
    g.push(c)
    groups.set(k, g)
  }
  const oty: CrateEntry<C>[] = []
  const filed: CrateEntry<C>[] = []
  for (const [k, g] of groups) {
    const had = byArtist.get(k)
    if (had) { had.more.push(...g); continue }
    const lead = g.find(isThisYear) ?? g[0]
    const e: CrateEntry<C> = { lead, more: g.filter((c) => c !== lead) }
    byArtist.set(k, e)
    ;(isThisYear(lead) ? oty : filed).push(e)
  }

  const leadOrder = new Map(byShelfOrder(oty.map((e) => e.lead)).map((c, i) => [c, i]))
  oty.sort((a, b) => leadOrder.get(a.lead)! - leadOrder.get(b.lead)!)

  // 2. Out This Year, then 3. the crates in Jake's order; inside each,
  // albums first and then the best match (the leads, as sorted above).
  const crates: CrateShelf<C>[] = CRATES.map((cr) => ({ id: cr.id, label: cr.label, entries: [] as CrateEntry<C>[], count: 0 }))
  const shelfOf = new Map(crates.map((sh) => [sh.id, sh]))
  for (const e of filed) {
    const f = crateOf(e.lead)
    const shelf = shelfOf.get(f.bin)!
    shelf.entries.push(f.section ? { ...e, section: f.section } : e)
    shelf.count += 1 + e.more.length
  }

  const laneCount = (id: string): number => input.lanes.find((l) => l.id === id)?.cards.length ?? 0
  const quota = new Set(['fresh-albums', 'fresh-songs', CRITIC_LANE])
  return {
    ipods,
    outThisYear: oty,
    crates: crates.filter((sh) => sh.entries.length > 0),
    counts: {
      records: laneCount('fresh-albums'),
      songs: laneCount('fresh-songs'),
      critic: laneCount(CRITIC_LANE),
      other: input.lanes.filter((l) => !quota.has(l.id)).reduce((n, l) => n + l.cards.length, 0),
      outThisYear: cards.filter(isThisYear).length,
      ipods: ipods.reduce((n, r) => n + r.entries.length, 0),
    },
  }
}

/** The count line over the crates: "Today: 25 records · 25 songs · 5 critic picks · 8 more · 3 out this year". */
export function shopCountLine(c: ShopCounts): string {
  const n = (k: number, one: string, many: string): string | null => (k > 0 ? `${k} ${k === 1 ? one : many}` : null)
  const parts = [
    n(c.records, 'record', 'records'),
    n(c.songs, 'song', 'songs'),
    n(c.critic, 'critic pick', 'critic picks'),
    n(c.other, 'more', 'more'),
    c.outThisYear > 0 ? `${c.outThisYear} out this year` : null,
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

/** The fold under a lead card: "+2 more by NOFX". */
export const moreLabel = (e: CrateEntry<PageCard>): string =>
  e.more.length ? `+${e.more.length} more by ${e.lead.artist}` : ''

/** The mixed crate's card label: "Reggae", "Brazil & Latin". */
export const sectionLabel = (s: OtherSection): string =>
  s.toLowerCase().replace(/(^|[\s&])\p{L}/gu, (m) => m.toUpperCase())

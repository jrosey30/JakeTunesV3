/**
 * Critic picks — a public album-ratings sheet as a rotating staff-picks wall
 * in the Record Shop (2026-10-18). A TikTok music blogger keeps ~2,100 scored
 * albums in a Google Sheet; Jake chose: 5 new picks a day from the 9s and 10s
 * he does not own, 10s first, credited to the blogger's handle.
 *
 * NOT A TASTE SIGNAL. Measured on the 299 albums the sheet and the library
 * share: Spearman ≈ −0.03 against Jake's plays and 0.03 against his stars —
 * no agreement at all. So the blogger's score orders THIS wall and nothing
 * else: it never reaches the brain, the taste ledger or the verdict stream.
 * Only Jake's own actions on a pick (+ List / Get, Not for me, plays) count,
 * exactly as for any other shop card.
 *
 * Pure — config, the CSV parser, the served ledger and the daily pacing.
 * Fetching, caching and catalogue identity live in main/critic-picks-feed.ts.
 */
import { nameKey } from './fold-text.ts'
import { binForGenre } from './record-shop-bins.ts'

export interface CriticSource {
  id: string
  /** Shown on every card ("@handle · 10/10"). Empty = the wall shows NOTHING
   *  — never a made-up name in its place. */
  credit: string
  sheetId: string
  gid: string
  minScore: number
  perDay: number
}

/** The one configured sheet. Edit `credit` here to change the byline. */
export const CRITIC_PICKS_SOURCE: CriticSource = {
  id: 'tiktok-album-sheet',
  credit: '@jkennmafia',
  sheetId: '1_fKn2tWhfpfPhiTV-o1GKPkSRCxyjnHpW_SKFiwi_-g',
  gid: '107245838',
  minScore: 9,
  perDay: 5,
}

/** The lane id the wall's cards carry through the feed. */
export const CRITIC_LANE = 'critic-picks'

/** gviz CSV — readable without a login (the /export URL answers 401). */
export function criticSheetCsvUrl(s: Pick<CriticSource, 'sheetId' | 'gid'>): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(s.sheetId)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(s.gid)}`
}

/** The card's note: "@handle · 10/10". Empty credit = no note (and no card). */
export function criticNote(credit: string, score: number): string {
  const c = credit.trim()
  return c ? `${c} · ${score}/10` : ''
}

// ── Parser ────────────────────────────────────────────────────────────

export interface CriticRow {
  artist: string
  title: string
  genre: string
  subGenre: string
  score: number
  year?: number
  /** 0-based position among the data rows — the sheet's own order. */
  row: number
  /** The sheet cut the title short ("People's Instinctive Travels (…)"). */
  truncated: boolean
}

/** RFC 4180 fields: quotes, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const s = String(text || '').replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

const clean = (v: string | undefined): string => String(v ?? '').replace(/\s+/g, ' ').trim()
// "(…)", "…", "..." at the end — the sheet's own mark for a cut-off title.
const TRUNCATION = /\s*(?:\((?:…|\.{3})\)|…|\.{3,})\s*$/

/** The sheet's Music tab → scored album rows, in sheet order. Columns are
 *  found by header name (Artist, Genre, Sub-Genre, Score, Title, Year), so the
 *  stats panel to their right is never read. Header, stat and junk rows are
 *  dropped: no artist, no title, or a score that is not a number from 1–10. */
export function parseCriticSheet(csv: string): CriticRow[] {
  const table = parseCsv(csv)
  if (!table.length) return []
  const head = table[0].map((h) => clean(h).toLowerCase())
  const col = (name: string, fallback: number): number => { const i = head.indexOf(name); return i >= 0 ? i : fallback }
  const ci = { artist: col('artist', 0), genre: col('genre', 1), sub: col('sub-genre', 2), score: col('score', 3), title: col('title', 4), year: col('year', 5) }
  const out: CriticRow[] = []
  for (let r = 1; r < table.length; r++) {
    const cells = table[r]
    const artist = clean(cells[ci.artist])
    const rawTitle = clean(cells[ci.title])
    const scoreText = clean(cells[ci.score])
    if (!artist || !rawTitle || !/^\d{1,2}(?:\.\d+)?$/.test(scoreText)) continue
    const score = Number(scoreText)
    if (!(score >= 1 && score <= 10)) continue
    const truncated = TRUNCATION.test(rawTitle)
    const title = truncated ? rawTitle.replace(TRUNCATION, '').trim() : rawTitle
    if (!title || title.toLowerCase() === 'title') continue
    const yearText = clean(cells[ci.year])
    const year = /^\d{4}$/.test(yearText) ? Number(yearText) : undefined
    out.push({ artist, title, genre: clean(cells[ci.genre]), subGenre: clean(cells[ci.sub]), score, year, row: out.length, truncated })
  }
  return out
}

// ── Identity ──────────────────────────────────────────────────────────

/** Leading article out, then squashed: "The White Stripes" = "White Stripes". */
export function bareKey(s: string): string {
  return nameKey(s).replace(/^(?:the|a|an) /, '').replace(/ /g, '')
}

/** A sheet row's ledger identity (artist + title as the blogger wrote them). */
export const criticRowKey = (r: { artist: string; title: string }): string => `${bareKey(r.artist)}|${bareKey(r.title)}`

/** The genre string a pick files under — the sheet's Genre, unless it bins
 *  nowhere (then the Sub-Genre), and punk sub-genres of Rock go to Punk (the
 *  sheet files Dead Kennedys as "Rock / Hardcore"; Jake's shop leads with a
 *  PUNK bin). A Hip Hop "Hardcore" stays Hip Hop — only Rock refines. */
export function criticGenre(r: Pick<CriticRow, 'genre' | 'subGenre'>): string {
  const g = binForGenre(r.genre)
  const s = binForGenre(r.subGenre)
  if (g === 'Misc' && r.subGenre) return r.subGenre
  if (g === 'Rock' && s === 'Punk') return r.subGenre
  return r.genre || r.subGenre
}

/** Score ≥ minScore, highest score first, then the sheet's own order (stable,
 *  deterministic). A record listed twice is one candidate. */
export function criticCandidates(rows: readonly CriticRow[], minScore: number): CriticRow[] {
  const seen = new Set<string>()
  return rows
    .filter((r) => r.score >= minScore)
    .sort((a, b) => (b.score - a.score) || (a.row - b.row))
    .filter((r) => { const k = criticRowKey(r); if (seen.has(k)) return false; seen.add(k); return true })
}

// ── Served ledger + daily pacing ──────────────────────────────────────

/** What the catalogue confirmed the record is (canonical names, art, the
 *  iTunes collection the hook sample is drawn from). */
export interface CriticAlbum { artist: string; title: string; year?: string; artUrl?: string; collectionId?: number }

export interface CriticPick {
  /** criticRowKey of the sheet row. */
  key: string
  /** The same identity on the catalogue's names — a re-spelled sheet row
   *  cannot bring a served record back. */
  albumKey: string
  score: number
  sheet: { artist: string; title: string; genre: string; subGenre: string; year?: number }
  album: CriticAlbum
}

export interface CriticLedger {
  version: 1
  sourceId: string
  /** Local day (YYYY-MM-DD) → that day's picks, in wall order. */
  days: Record<string, CriticPick[]>
  /** Rows that could not be seated — a catalogue miss (retried after
   *  CRITIC_RETRY_DAYS.unverified: Apple 403s under load, so a miss may be
   *  the network's, not the record's) or owned under the catalogue's name
   *  (retried after CRITIC_RETRY_DAYS.owned) — never re-asked every day. */
  skipped: Record<string, { day: string; why: 'unverified' | 'owned' }>
}

export const CRITIC_RETRY_DAYS = { unverified: 3, owned: 14 } as const

export function emptyCriticLedger(sourceId: string): CriticLedger {
  return { version: 1, sourceId, days: {}, skipped: {} }
}

/** Tolerant read of the on-disk ledger: anything malformed is dropped, never thrown. */
export function normalizeCriticLedger(raw: unknown, sourceId: string): CriticLedger {
  const out = emptyCriticLedger(sourceId)
  const o = raw && typeof raw === 'object' ? raw as Partial<CriticLedger> : {}
  if (o.sourceId && o.sourceId !== sourceId) return out
  for (const [day, picks] of Object.entries(o.days ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(picks)) continue
    const ok = picks.filter((p): p is CriticPick => !!p && typeof p.key === 'string' && typeof p.albumKey === 'string' && !!p.album?.artist && !!p.album?.title && typeof p.score === 'number')
    if (ok.length) out.days[day] = ok
  }
  for (const [k, v] of Object.entries(o.skipped ?? {})) {
    if (v && typeof v.day === 'string' && (v.why === 'unverified' || v.why === 'owned')) out.skipped[k] = { day: v.day, why: v.why }
  }
  return out
}

/** The LOCAL calendar day — the wall turns over at Jake's midnight, not UTC's. */
export function localDayKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000)

export interface PlanInput {
  ledger: CriticLedger
  today: string
  candidates: readonly CriticRow[]
  perDay: number
  /** Leave a row out before any lookup (owned on the sheet's names, a
   *  Disliked / Not-for-me artist, already on the Listen List). Not recorded:
   *  it is re-asked every day, so an un-dislike brings the row back. */
  excluded: (r: CriticRow) => boolean
  /** Catalogue identity. null = no record answers to this row. */
  resolve: (r: CriticRow) => Promise<CriticAlbum | null>
  /** The same exclusions on the catalogue's names; 'owned' is remembered. */
  excludedAlbum: (a: CriticAlbum) => 'owned' | 'excluded' | null
  /** Bound on catalogue lookups per plan (default perDay × 4). */
  maxLookups?: number
}

/**
 * Today's wall. A day already on the ledger is returned as it stands (the
 * same five all day, across restarts), topped up only if it came up short.
 * Otherwise the next rows in candidate order that were never served, are not
 * excluded and resolve to a real record are seated. Nothing ever repeats:
 * every served row key AND catalogue key stays on the ledger forever.
 *
 * A plan that seats nothing records nothing — a catalogue outage must not
 * mark the whole sheet "unverified" for two weeks.
 */
export async function planCriticDay(input: PlanInput): Promise<{ ledger: CriticLedger; picks: CriticPick[]; changed: boolean }> {
  const { today, perDay } = input
  const ledger: CriticLedger = structuredClone(input.ledger)
  const existing = ledger.days[today] ?? []
  if (existing.length >= perDay) return { ledger, picks: existing, changed: false }
  const servedRows = new Set<string>()
  const servedAlbums = new Set<string>()
  for (const picks of Object.values(ledger.days)) for (const p of picks) { servedRows.add(p.key); servedAlbums.add(p.albumKey) }
  const fresh: CriticPick[] = []
  const skips: CriticLedger['skipped'] = {}
  let lookups = 0
  const maxLookups = input.maxLookups ?? perDay * 4
  for (const r of input.candidates) {
    if (existing.length + fresh.length >= perDay || lookups >= maxLookups) break
    const key = criticRowKey(r)
    if (servedRows.has(key)) continue
    const sk = ledger.skipped[key]
    if (sk && dayNumber(today) - dayNumber(sk.day) < CRITIC_RETRY_DAYS[sk.why]) continue
    if (input.excluded(r)) continue
    lookups++
    const album = await input.resolve(r)
    if (!album) { skips[key] = { day: today, why: 'unverified' }; continue }
    const albumKey = criticRowKey(album)
    if (servedAlbums.has(albumKey)) continue
    const why = input.excludedAlbum(album)
    if (why === 'owned') { skips[key] = { day: today, why: 'owned' }; continue }
    if (why) continue
    servedRows.add(key); servedAlbums.add(albumKey)
    fresh.push({ key, albumKey, score: r.score, sheet: { artist: r.artist, title: r.title, genre: r.genre, subGenre: r.subGenre, year: r.year }, album })
  }
  if (!fresh.length) return { ledger: input.ledger, picks: existing, changed: false }
  ledger.days[today] = [...existing, ...fresh]
  for (const [k, v] of Object.entries(skips)) ledger.skipped[k] = v
  return { ledger, picks: ledger.days[today], changed: true }
}

/**
 * Merge a plan onto the ledger as it is on disk NOW (never onto the snapshot
 * the plan started from): days union by row key with the disk's order first,
 * capped at perDay unless disk already holds more; skips keep the later day.
 */
export function mergeCriticLedger(disk: CriticLedger, ours: CriticLedger, perDay: number): CriticLedger {
  const out: CriticLedger = structuredClone(disk)
  for (const [day, picks] of Object.entries(ours.days)) {
    const have = out.days[day] ?? []
    const keys = new Set(have.map((p) => p.key))
    const merged = [...have, ...picks.filter((p) => !keys.has(p.key))]
    out.days[day] = merged.slice(0, Math.max(have.length, perDay))
  }
  for (const [k, v] of Object.entries(ours.skipped)) {
    const cur = out.skipped[k]
    if (!cur || cur.day < v.day) out.skipped[k] = v
  }
  return out
}

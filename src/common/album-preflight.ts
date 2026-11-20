/**
 * Album saves: the edition on the card, and a fast "no" (Brief 255, Record
 * Shop Phase 2).
 *
 * Before an album downloads, main asks Qobuz once whether it has that edition
 * (main/album-preflight.ts). A "no" ends the job at once with one plain line,
 * instead of 4 to 17 minutes of fallbacks first. Anything the question can't
 * settle ("unknown") runs today's walk, unchanged.
 *
 * Shared by main (the answer) and the renderer (the queue, the panel line,
 * the usage log). Pure: no I/O, no clock.
 */
import type { Alternative, DownloadOutcome } from './acquisition-identity.ts'
import type { UsageDetail } from './usage-log.ts'
import type { ShopOffer } from './closest-edition.ts'

/** Why Qobuz said no. */
export type PreflightNo =
  /** Nothing by that artist with that title. */
  | 'not-on-qobuz'
  /** Only a smaller edition, every song of it one of this one's ("6 of 9"). */
  | 'partial'
  /** Another edition of the record (a Deluxe, a 15-song one, a live one). */
  | 'edition-differs'
  /** The record is explicit and Qobuz only has the clean edit. */
  | 'clean-only'

/** Why the question couldn't be settled: today's walk runs. */
export type PreflightUnknown =
  | 'no-token'      // no Qobuz login in streamrip's config
  | 'no-answer'     // Qobuz didn't answer (search or a listing)
  | 'timeout'       // over the budget
  | 'error'
  | 'no-request'    // no artist or album to ask about
  | 'unsure'        // the walk would look at candidates the question didn't
  | 'bandcamp'      // Qobuz said no, and today's walk would try a Bandcamp page

export type AlbumPreflight =
  /** `id` (Brief 261): the Qobuz listing that passed, which the save then downloads by id. Absent when the library already has it. */
  | { answer: 'found'; id?: string }
  | {
      answer: 'no'
      why: PreflightNo
      /** partial: songs Qobuz has, of the edition's songs. */
      have?: number
      of?: number
      /** edition-differs: what Qobuz has instead, in words ("Deluxe", "live version"). */
      other?: string
      /** edition-differs with no label: how many songs Qobuz's edition has. */
      otherCount?: number
      /** edition-differs: Qobuz's copy is this edition with a track that reads differently. */
      near?: boolean
      /** The editions Qobuz listed and why each isn't this one (same shape as the walk's). */
      alternatives?: Alternative[]
      /** Bandcamp's search got no answer, so it wasn't asked and may still have the album. */
      bandcampUnasked?: boolean
      /** What can be had instead, each taken only with a tap (Brief 257). */
      offers?: ShopOffer[]
      /** The asked edition's label ("Deluxe", "Standard") and size, for the offer's words. */
      asked?: string
      askedCount?: number
    }
  | { answer: 'unknown'; why: PreflightUnknown }

/** What the renderer sends main. */
export interface AlbumPreflightRequest {
  artist: string
  album: string
  collectionId?: number
  trackCount?: number
  releaseYear?: number
  explicitSource?: boolean
}

/** How long the question may take before the walk runs anyway. */
export const PREFLIGHT_BUDGET_MS = 20_000

const songs = (n: number): string => `${n} song${n === 1 ? '' : 's'}`

/** The one plain line the Downloads panel (and the card) shows for a "no". */
export function preflightLine(p: AlbumPreflight): string | null {
  if (p.answer !== 'no') return null
  switch (p.why) {
    case 'not-on-qobuz': return 'Not on Qobuz'
    case 'clean-only': return 'Only the clean edition is on Qobuz'
    case 'partial': return p.have ? `Qobuz has ${p.have} of ${p.of ?? '?'} songs` : 'Not on Qobuz yet'
    case 'edition-differs':
      if (p.near) return 'Qobuz’s copy differs from this edition'
      if (p.other) return `Only the ${p.other} is on Qobuz`
      if (p.otherCount) return `Qobuz has a ${p.otherCount}-song edition, not this one`
      return 'Qobuz has a different edition'
  }
}

/** The sentence under it, in Details. Plain words, no ids. */
export function preflightDetail(p: AlbumPreflight): string | null {
  if (p.answer !== 'no') return null
  const said = preflightDetailQobuz(p)
  // The walk's own words when Bandcamp's search didn't answer (streamrip-store laneNotes).
  return said && p.bandcampUnasked ? `${said} Bandcamp wasn’t searched, so it may still have this.` : said
}

function preflightDetailQobuz(p: Extract<AlbumPreflight, { answer: 'no' }>): string | null {
  const nothing = 'Nothing was downloaded.'
  switch (p.why) {
    case 'not-on-qobuz': return `Qobuz doesn’t have this album. ${nothing}`
    case 'clean-only': return `This album is explicit, and Qobuz only has the clean edit. ${nothing}`
    case 'partial': return p.have
      ? `Qobuz has ${songs(p.have)} of this edition’s ${p.of ?? '?'}. Part of an album is never saved on its own. ${nothing}`
      : `Qobuz lists this album but can’t play its songs yet. ${nothing}`
    case 'edition-differs': {
      const theirs = p.near ? 'Qobuz has this record, but its songs don’t line up with this edition'
        : p.other ? `Qobuz has the ${p.other}${p.otherCount ? ` (${songs(p.otherCount)})` : ''}, not this edition`
        : p.otherCount ? `Qobuz has a ${p.otherCount}-song edition, not this one`
        : 'Qobuz has another edition of this record, not this one'
      return `${theirs}. ${nothing}`
    }
  }
}

/** A "no" as the job's verdict: the same fields main's walk returns, so the
 *  panel, the shop's rows and the Listen List read it the way they read any
 *  refusal (Choose edition, Details, Compare editions). */
export function preflightVerdict(p: AlbumPreflight): { outcome: DownloadOutcome; primary: string; detail: string; error: string; alternatives?: Alternative[] } | null {
  const primary = preflightLine(p)
  const detail = preflightDetail(p)
  if (!primary || !detail || p.answer !== 'no') return null
  return {
    outcome: p.why === 'not-on-qobuz' ? 'not-found' : 'exact-not-found',
    primary, detail, error: primary,
    ...(p.alternatives?.length ? { alternatives: p.alternatives } : {}),
  }
}

// ── Editions ────────────────────────────────────────────────────────────

/** One edition of a record, as Apple lists it. */
export interface AlbumEdition {
  collectionId: number
  name: string
  /** "Standard", "Deluxe Edition", "2011 Remaster", "Clean"… */
  label: string
  trackCount?: number
  releaseYear?: number
  /** Apple's collectionExplicitness: 'explicit' | 'cleaned' | 'notExplicit'. */
  explicitness?: string
}

export interface AlbumEditions {
  ok: boolean
  editions: AlbumEdition[]
  /** The one a one-click save takes; null = no edition could be named (main's walk resolves by name, as before). */
  chosenId: number | null
}

/** "Deluxe Edition · 19 songs · 2022". The year only when two labels read alike. */
export function editionOptionLabel(e: AlbumEdition, all: readonly AlbumEdition[]): string {
  const twin = all.some((o) => o !== e && o.label === e.label)
  return [e.label, e.trackCount ? songs(e.trackCount) : null, twin && e.releaseYear ? String(e.releaseYear) : null].filter(Boolean).join(' · ')
}

// ── Usage log ───────────────────────────────────────────────────────────

/** Where a save was clicked. */
export type AlbumSaveSurface = 'search' | 'for-you' | 'listen-list' | 'panel'
/** How the edition was named: on the card itself, resolved from the name, picked from the Edition menu, or not at all. */
export type AlbumSaveEdition = 'card' | 'resolved' | 'picked' | 'none'

export interface AlbumSaveEvent { kind: 'action'; name: 'shop.album-save'; ms: number; ok: boolean; detail: UsageDetail }

/**
 * One `shop.album-save` line per album save, written at its first answer:
 * the preflight's found / no, or, when the preflight couldn't tell, the
 * walk's own end. `ms` is click → that answer. Never a title or an artist:
 * every detail is a fixed word or a count (usage-log.ts's no-words rule).
 */
export function albumSaveEvent(o: {
  clickedAt: number
  answeredAt: number
  /** found / no from the preflight; done / failed when the walk answered. */
  answer: 'found' | 'no' | 'done' | 'failed'
  why?: PreflightNo | PreflightUnknown
  surface?: AlbumSaveSurface
  edition?: AlbumSaveEdition
  have?: number
  of?: number
  /** Brief 257: the kinds of offer a "no" carried ("edition+songs"). */
  offers?: readonly string[]
}): AlbumSaveEvent {
  const detail: UsageDetail = { answer: o.answer, by: o.answer === 'found' || o.answer === 'no' ? 'preflight' : 'walk' }
  if (o.why) detail.why = o.why
  if (o.surface) detail.surface = o.surface
  if (o.edition) detail.edition = o.edition
  if (typeof o.have === 'number') detail.have = o.have
  if (typeof o.of === 'number') detail.of = o.of
  if (o.offers?.length) detail.offer = o.offers.join('+')
  return { kind: 'action', name: 'shop.album-save', ms: Math.max(0, Math.round(o.answeredAt - o.clickedAt)), ok: o.answer === 'found' || o.answer === 'done', detail }
}

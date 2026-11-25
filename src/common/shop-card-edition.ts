/**
 * The edition on a Record Shop album card (Record Shop Phase 2, Jake's
 * approved picture, 2026-11-24): under every card that isn't in the library,
 * "Save album" and the edition it saves. One edition known: its name, plain
 * ("Standard"). Two or more: a small menu, and the one picked is the one
 * saved. "The edition you see on the card is the one it saves."
 *
 * A search card is one of Apple's editions already (its own collection id),
 * so it is the default; Jake's pick from this card's menu wins over it. A pick
 * belongs to the card it was made on (review of #486): two cards of one
 * record, say "Meddle" and "Meddle (2011 Remaster)", each keep their own.
 * Pure.
 */
import { editionOptionLabel, type AlbumEdition } from './album-preflight.ts'

/** The card's own edition, as Apple's album search gave it. */
export interface CardRecord {
  collectionId?: number
  name: string
  trackCount?: number
  releaseYear?: number
  explicitness?: string
}

/** What the editions lookup knows about the record (renderer/views/DownloadStore/albumEditions.ts EditionsState). */
export interface CardEditionsState {
  state: 'idle' | 'loading' | 'ready' | 'failed'
  editions: readonly AlbumEdition[]
  chosenId: number | null
  picked: boolean
}

export type CardEdition =
  | { kind: 'none' }
  | { kind: 'label'; label: string }
  | { kind: 'menu'; options: Array<{ id: number; label: string }>; selectedId: number; selected: AlbumEdition }

/**
 * Words in a bracket or a dash tail that name an edition and not the record:
 * "(Deluxe Edition)", " - 2011 Remaster", "(Mono)". A bracket with none of
 * them ("(36 Chambers)") is part of the record's name.
 */
const EDITION_WORDS = /\b(deluxe|expanded|remaster(ed)?|edition|version|anniversary|mono|stereo|bonus|special|super|legacy|reissue|collector'?s|definitive|clean)\b/i

/**
 * The card's own edition in a word, before the editions lookup has answered:
 * its edition words, else "Standard". Apple's " - Single" / " - EP" stamps say
 * what the release is, not which edition. ⚠️ TWIN (the careful one, with the
 * row's title): main/album-editions.ts editionLabelOf, whose label wins once
 * the lookup answers.
 */
export function cardEditionLabel(name: string, explicitness?: string): string {
  const t = String(name || '')
  const parts: string[] = []
  for (const m of t.matchAll(/[([{]([^()[\]{}]*)[)\]}]/g)) if (m[1].trim()) parts.push(m[1].trim())
  const dash = t.match(/\s+[-–—]\s+([^-–—]+)$/)
  if (dash) parts.push(dash[1].trim())
  const kept = parts.filter((p) => !/^(single|ep)$/i.test(p) && EDITION_WORDS.test(p))
  const label = kept.join(', ') || 'Standard'
  return explicitness === 'cleaned' ? (label === 'Standard' ? 'Clean' : `${label}, clean`) : label
}

/**
 * The record's own name: Apple's name without its edition words or its
 * Single / EP stamp ("Animals (Deluxe Edition)" is "Animals"; "Enter the
 * Wu-Tang (36 Chambers)" keeps its brackets, which are its name). For a
 * sentence that names the edition separately (the banner, review of #496).
 */
export function recordName(name: string): string {
  let t = String(name || '').trim()
  t = t.replace(/[([{]([^()[\]{}]*)[)\]}]/g, (m, inner: string) => (EDITION_WORDS.test(inner) || /^(single|ep)$/i.test(inner.trim()) ? '' : m))
  t = t.replace(/\s+[-–—]\s+([^-–—]+)$/, (m, tail: string) => (EDITION_WORDS.test(tail) || /^(single|ep)$/i.test(tail.trim()) ? '' : m))
  return t.replace(/\s{2,}/g, ' ').trim() || String(name || '').trim()
}

/** The card's own edition as the lookup would list it. */
function cardAsEdition(card: CardRecord): AlbumEdition | null {
  if (!card.collectionId) return null
  return { collectionId: card.collectionId, name: card.name, label: cardEditionLabel(card.name, card.explicitness), trackCount: card.trackCount, releaseYear: card.releaseYear, explicitness: card.explicitness }
}

/** What the card shows under Save album. `cardPick`: the edition picked on this card's own menu. */
export function cardEdition(card: CardRecord, s: CardEditionsState, cardPick: number | null = null): CardEdition {
  if (!card.name) return { kind: 'none' }
  const own = cardAsEdition(card)
  const listed = s.state === 'ready' ? [...s.editions] : []
  // The card's own edition is always one of the choices (a search hit can be an edition the name lookup filters out).
  const editions = own && !listed.some((e) => e.collectionId === own.collectionId) && listed.length ? [own, ...listed] : listed
  if (editions.length >= 2) {
    const want = cardPick ?? own?.collectionId ?? s.chosenId
    const selected = editions.find((e) => e.collectionId === want) ?? editions[0]
    return { kind: 'menu', options: editions.map((e) => ({ id: e.collectionId, label: editionOptionLabel(e, editions) })), selectedId: selected.collectionId, selected }
  }
  const named = own ? listed.find((e) => e.collectionId === own.collectionId) : undefined
  return { kind: 'label', label: named?.label ?? cardEditionLabel(card.name, card.explicitness) }
}

/**
 * The edition a Save album on this card takes: null for the card's own
 * (saved exactly as the card's job says), else the edition picked in its menu.
 */
export function cardSaveEdition(card: CardRecord, e: CardEdition): AlbumEdition | null {
  if (e.kind !== 'menu') return null
  return e.selectedId === card.collectionId ? null : e.selected
}

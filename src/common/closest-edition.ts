/**
 * When the exact edition isn't there (Brief 257, Record Shop Phase 4).
 *
 * A "no" from the album preflight used to end the job with nothing saved.
 * Now it carries what CAN be had, as offers Jake takes with one tap, never
 * on its own (his call, 2026-11-19: "ask, with one tap"; part of an album
 * "only when you tap"):
 *
 *   - edition:  another edition of the record that Qobuz has ("The Deluxe
 *               isn't on Qobuz. The Standard (11 songs) is. Save that?"),
 *               with the differences in plain words,
 *   - songs:    the songs of his edition that Qobuz has, the rest kept on the
 *               Listen List to try again ("Save the 6 that exist"),
 *   - bandcamp: only Bandcamp has it, and that copy is a lossy MP3 (said
 *               before he takes it),
 *   - songs-each: a walk that refused the album (a transfer that came back
 *               short): its songs one at a time.
 *
 * The matching (which edition is nearest, which songs exist) is main's
 * (main/closest-edition.ts), under the album identity rules unchanged. This
 * file is the shape both sides share and the words. Pure: no I/O, no clock.
 */
import type { AlbumEdition } from './album-preflight.ts'
import type { UsageDetail } from './usage-log.ts'

/** One song of an edition, as the offer carries it. */
export interface OfferSong { title: string; trackNumber?: number; discNumber?: number; durationSec?: number; explicitness?: string }

/** How the offered edition differs from the one asked for. */
export interface EditionDiff {
  /** Songs of the asked edition the offer doesn't have. */
  missing: string[]
  /** Songs the offer has that the asked edition doesn't. */
  added: string[]
  /** Songs on both that run a different length (offer minus asked, seconds). */
  lengths: Array<{ title: string; deltaSec: number }>
}

export type ShopOffer =
  | {
      kind: 'edition'
      /** Apple's edition, as a Save album of it would be queued (its own preflight, the walk unchanged). */
      edition: AlbumEdition
      diff: EditionDiff
      /** The row is explicit and this edition is the clean one: the words say so. */
      clean?: boolean
    }
  | {
      kind: 'songs'
      /** Songs of the asked edition Qobuz has and the library doesn't: saved one by one, each verified. */
      have: OfferSong[]
      /** Songs of the asked edition Qobuz doesn't have: they go on the Listen List. */
      missing: OfferSong[]
      /** Songs already in the library, left alone. */
      owned: number
      /** The asked edition's size. */
      of: number
      /** The size of Qobuz's edition they come from. */
      from?: number
    }
  | { kind: 'bandcamp'; url: string; name: string; band: string }
  | { kind: 'songs-each'; of?: number }

export type ShopOfferKind = ShopOffer['kind']

/** Within this much, two copies of a song run "the same length" in the words. */
export const LENGTH_WORDS_SEC = 5

const songs = (n: number): string => `${n} song${n === 1 ? '' : 's'}`
const q = (t: string): string => `“${t}”`
const mmss = (s: number): string => { const a = Math.round(Math.abs(s)); return `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}` }

/** "Without “A” and “B” · 8 more songs · “C” runs 0:40 longer". Plain words, the differences that matter. */
export function differenceWords(d: EditionDiff): string {
  const bits: string[] = []
  if (d.missing.length === 1) bits.push(`without ${q(d.missing[0])}`)
  else if (d.missing.length === 2) bits.push(`without ${q(d.missing[0])} and ${q(d.missing[1])}`)
  else if (d.missing.length > 2) bits.push(`${songs(d.missing.length)} missing`)
  if (d.added.length === 1) bits.push(`adds ${q(d.added[0])}`)
  else if (d.added.length === 2) bits.push(`adds ${q(d.added[0])} and ${q(d.added[1])}`)
  else if (d.added.length > 2) bits.push(`${d.added.length} more songs`)
  const long = d.lengths.filter((l) => Math.abs(l.deltaSec) > LENGTH_WORDS_SEC)
  if (long.length === 1) bits.push(`${q(long[0].title)} runs ${mmss(long[0].deltaSec)} ${long[0].deltaSec > 0 ? 'longer' : 'shorter'}`)
  else if (long.length > 1) bits.push(`${songs(long.length)} a different length`)
  if (!bits.length) return 'The same songs'
  const s = bits.join(' · ')
  return s[0].toUpperCase() + s.slice(1)
}

/** What the offered edition is called in a sentence: "Standard", "clean edition", "12-song edition". */
export function offeredName(o: Extract<ShopOffer, { kind: 'edition' }>, asked?: string): string {
  const n = o.edition.trackCount
  const label = o.edition.label
  if (/^clean$/i.test(label)) return 'clean edition'
  if (label === 'Standard' && (!asked || asked === 'Standard')) return n ? `${n}-song edition` : 'other edition'
  // Two Deluxes: the size tells them apart.
  if (asked && n && label.toLowerCase() === asked.toLowerCase()) return `${n}-song ${label}`
  return label
}

/** "clean 9-song edition", "clean Deluxe". */
function cleanName(o: Extract<ShopOffer, { kind: 'edition' }>, asked?: string): string {
  const n = o.edition.trackCount
  const label = o.edition.label.replace(/,\s*clean$/i, '')
  if (/^clean$/i.test(label) || label === 'Standard') return n ? `clean ${n}-song edition` : 'clean edition'
  return `clean ${offeredName({ ...o, edition: { ...o.edition, label } }, asked)}`
}

/** The asked edition in a sentence: "The Deluxe", "The 19-song edition", "The explicit edition", "This edition". */
export function askedWords(asked?: string, askedCount?: number, clean?: boolean): string {
  if (clean) return 'The explicit edition'
  if (asked && asked !== 'Standard') return `The ${asked}`
  if (askedCount) return `The ${askedCount}-song edition`
  return 'This edition'
}

/** The one line that asks. */
export function offerLine(o: ShopOffer, ctx: { asked?: string; askedCount?: number } = {}): string {
  switch (o.kind) {
    case 'edition': {
      const n = o.edition.trackCount
      // The clean edit of the very edition asked for: "The explicit edition isn't on Qobuz".
      // A clean edition of another size: the asked one by name, the offer called clean.
      const sameSize = !n || !ctx.askedCount || n === ctx.askedCount
      const name = o.clean && !sameSize ? cleanName(o, ctx.asked) : offeredName(o, ctx.asked)
      return `${askedWords(ctx.asked, ctx.askedCount, o.clean && sameSize)} isn’t on Qobuz. The ${name}${n ? ` (${songs(n)})` : ''} is. Save that?`
    }
    case 'songs': {
      const got = o.have.length + o.owned
      if (!o.missing.length) return `Qobuz has all ${o.of} songs, on ${o.from && o.from !== o.of ? `a ${o.from}-song edition` : 'another edition'}. Save ${o.have.length === 1 ? 'it' : `those ${o.have.length}`}?`
      return `Qobuz has ${got} of ${o.of} songs. Save ${o.have.length === 1 ? 'that one' : `those ${o.have.length}`} and keep the other ${o.missing.length} on your Listen List?`
    }
    case 'bandcamp': return 'Only Bandcamp has it, as a lossy MP3. Save that?'
    case 'songs-each': return 'Try its songs one at a time?'
  }
}

/** The button. */
export function offerButton(o: ShopOffer, ctx: { asked?: string } = {}): string {
  switch (o.kind) {
    case 'edition': {
      const name = offeredName(o, ctx.asked)
      return name === 'clean edition' ? 'Save the clean one' : name === 'other edition' ? 'Save that one' : /-song edition$/.test(name) ? `Save the ${name.replace(/ edition$/, '')} one` : `Save the ${name}`
    }
    case 'songs': return o.missing.length ? `Save the ${o.have.length} that exist` : `Save ${o.have.length === 1 ? 'the song' : `the ${o.have.length} songs`}`
    case 'bandcamp': return 'Save the MP3 (lossy)'
    case 'songs-each': return o.of ? `Save the ${o.of} songs one by one` : 'Save the songs one by one'
  }
}

/** The tooltip: the differences, or what goes on the list. */
export function offerTitle(o: ShopOffer): string {
  switch (o.kind) {
    case 'edition': return differenceWords(o.diff)
    case 'songs': return o.missing.length ? `On your Listen List: ${o.missing.map((s) => q(s.title)).join(', ')}` : 'Each song is checked before it’s saved'
    case 'bandcamp': return 'A 128 kbps MP3 from Bandcamp, not CD quality'
    case 'songs-each': return 'Each song is checked before it’s saved'
  }
}

/** Which offers a row shows: one per kind, at most three, in the order main gave them. */
export function offersToShow(offers: readonly ShopOffer[] | undefined): ShopOffer[] {
  const seen = new Set<string>()
  const out: ShopOffer[] = []
  for (const o of offers ?? []) {
    if (seen.has(o.kind)) continue
    if (o.kind === 'songs' && o.have.length === 0) continue
    seen.add(o.kind)
    out.push(o)
    if (out.length === 3) break
  }
  return out
}

/** A finished save whose file is lossy says so (the walk's own matchDesc names the lane). */
export function lossyNote(matchDesc?: string | null): string | null {
  const m = /\((Bandcamp|SoundCloud)\)\s*$/.exec(String(matchDesc || ''))
  return m ? `Lossy MP3 from ${m[1]}` : null
}

/** One `shop.offer` line when an offer is taken. Counts and fixed words only (usage-log.ts's no-words rule). */
export function offerTakenEvent(o: ShopOffer): { kind: 'action'; name: 'shop.offer'; ms: number; ok: boolean; detail: UsageDetail } {
  const detail: UsageDetail = { offer: o.kind }
  if (o.kind === 'songs') { detail.have = o.have.length; detail.missing = o.missing.length; detail.of = o.of }
  if (o.kind === 'edition') { if (o.edition.trackCount) detail.of = o.edition.trackCount; if (o.clean) detail.clean = 1 }
  if (o.kind === 'songs-each' && o.of) detail.of = o.of
  return { kind: 'action', name: 'shop.offer', ms: 0, ok: true, detail }
}

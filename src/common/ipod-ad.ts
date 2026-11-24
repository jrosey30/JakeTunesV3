/**
 * The iPod ad page (2026-11-14). Jake approved the second mock ("Yeah that'll
 * do"; the first was "too quirky and cartoony"): the page of an iPod list, and
 * of the Top 1000, opens on a white field with one iPod, one headline, one
 * line and one small grey line. Nothing else.
 *
 * This file is the words and the drawing's colours, pure, so node --test reads
 * them. The picture is renderer/components/IpodAd.tsx.
 *
 *   headline   homemini's `headline` for the list (Jake's, "Headline…"), else
 *              the list's name and a full stop. The Top 1000 with none:
 *              "The thousand that made it."
 *   copy       "<N> songs by <M> artists."
 *   grey line  "<name>. iPod <model>, <colour>. <N> of <cap> songs, <hours>
 *              hours. Last synced <date>." Whatever isn't known is left out.
 *   story      (2026-11-24) Jake's story for the iPod, under the ad: homemini's
 *              `story` (plain text, paragraphs by a blank line). None: nothing.
 *
 * ⚠️ TWIN: the headline's rules (1 to 60 characters, one line) are
 * JakeTunesMobile backend/src/util/ipodLists.ts checkHeadline; homemini
 * refuses what this refuses.
 */
import { ipodColorHex, isNamedIpodColor, normalizeIpodColor, type IpodModel } from './ipod-covers.ts'

export const HEADLINE_MAX = 60
export const TOP_1000_DEFAULT_HEADLINE = 'The thousand that made it.'

export type HeadlineCheck = { ok: true; headline: string | null } | { ok: false; error: string }

/**
 * What Jake typed in "Headline…". Empty = none (the page goes back to the
 * list's name), which is `headline: null` on the wire.
 */
export function checkHeadline(raw: unknown): HeadlineCheck {
  if (raw === null) return { ok: true, headline: null }
  if (typeof raw !== 'string') return { ok: false, error: 'Type a headline, or leave it empty for the name.' }
  const headline = raw.trim()
  if (!headline) return { ok: true, headline: null }
  if (/[\u0000-\u001f\u007f]/.test(headline)) return { ok: false, error: 'Keep it to one line.' }
  if (headline.length > HEADLINE_MAX) return { ok: false, error: `Keep it to ${HEADLINE_MAX} characters (this is ${headline.length}).` }
  return { ok: true, headline }
}

/** A stored or received headline: the string when it passes the rules, else null. */
export function cleanHeadline(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const c = checkHeadline(raw)
  return c.ok ? c.headline : null
}

/** The longest story homemini keeps (⚠️ TWIN: JakeTunesMobile backend/src/util/ipodStory.ts MAX_STORY). */
export const STORY_MAX = 3000

/**
 * A received story (2026-11-24): the text when it is one homemini would keep
 * (1 to 3000 characters, no control characters but the newline), line endings
 * made "\n" and the ends trimmed; anything else is null. The words are Jake's
 * and are never changed. ⚠️ TWIN: JakeTunesMobile backend/src/util/ipodStory.ts checkStory.
 */
export function cleanStory(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const story = raw.replace(/\r\n?/g, '\n').trim()
  if (!story || story.length > STORY_MAX) return null
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(story)) return null
  return story
}

/**
 * The story's paragraphs: split at each blank line (spaces on it aside), each
 * trimmed, the empty ones dropped; a single line break stays inside its
 * paragraph. None = []. ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/IpodAdCopy.swift storyParagraphs.
 */
export function storyParagraphs(story: string | null | undefined): string[] {
  const s = cleanStory(story)
  if (!s) return []
  return s.split(/\n[ \t]*\n\s*/).map((p) => p.trim()).filter(Boolean)
}

/** The headline a page shows. */
export function adHeadline(input: { headline?: string | null; name: string; top1000?: boolean }): string {
  const own = cleanHeadline(input.headline)
  if (own) return own
  if (input.top1000) return TOP_1000_DEFAULT_HEADLINE
  const name = input.name.trim()
  if (!name) return ''
  return /[.!?…]$/.test(name) ? name : `${name}.`
}

/**
 * The headline as it is set: at most two lines. Two sentences break between
 * them ("The Eighties." / "Singles only."); one longer sentence breaks at the
 * space nearest its middle ("Louder than" / "it looks."); a short one stays whole.
 * Sentences too uneven to make two good lines (one over 30 characters) break
 * at the middle too.
 */
const HEADLINE_SENTENCE_LINE = 30
export function headlineLines(headline: string): string[] {
  const h = headline.trim().replace(/\s+/g, ' ')
  if (!h) return []
  const sentence = /^(.+?[.!?…])\s+(.+)$/.exec(h)
  if (sentence && sentence[1].length <= HEADLINE_SENTENCE_LINE && sentence[2].length <= HEADLINE_SENTENCE_LINE) return [sentence[1], sentence[2]]
  if (h.length <= 14 || !h.includes(' ')) return [h]
  const mid = h.length / 2
  let at = -1
  for (let i = 0; i < h.length; i++) {
    if (h[i] === ' ' && (at < 0 || Math.abs(i - mid) < Math.abs(at - mid))) at = i
  }
  return [h.slice(0, at), h.slice(at + 1)]
}

/** The widest line the headline's full size has room for; a longer line is set smaller to fit. */
export const HEADLINE_FULL_CHARS = 20
export const HEADLINE_FULL_PX = 62
export const HEADLINE_MIN_PX = 26

/** The headline's size in px from its longest line: known before anything is drawn, so nothing moves. */
export function headlineSizePx(lines: readonly string[]): number {
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
  if (longest <= HEADLINE_FULL_CHARS) return HEADLINE_FULL_PX
  return Math.max(HEADLINE_MIN_PX, Math.floor((HEADLINE_FULL_PX * HEADLINE_FULL_CHARS) / longest))
}

const n = (v: number): string => v.toLocaleString('en-US')

/** "834 songs by 200 artists." */
export function adCopy(songs: number, artists: number): string {
  if (songs <= 0) return 'No songs yet.'
  const s = `${n(songs)} ${songs === 1 ? 'song' : 'songs'}`
  if (artists <= 0) return `${s}.`
  return `${s} by ${n(artists)} ${artists === 1 ? 'artist' : 'artists'}.`
}

export interface HomeminiCounts { songCount: number; artistCount: number }

/**
 * homemini's two counts for a list (2026-11-14, Mobile #798): `songCount` and
 * `artistCount`, whole numbers, counted by the main-artist rule, the phone's
 * numbers. On every row of GET /api/ipod-lists, on GET /api/ipod-lists/:id and
 * on GET /api/top1000/name (left out while the Top 1000 can't be built). Only
 * both together count: one without the other is nothing.
 */
export function homeminiCounts(raw: { songCount?: unknown; artistCount?: unknown } | null | undefined): HomeminiCounts | null {
  const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
  if (!raw || !whole(raw.songCount) || !whole(raw.artistCount)) return null
  return { songCount: raw.songCount, artistCount: raw.artistCount }
}

/**
 * The two numbers on the copy line: homemini's pair when it sent both (so every
 * screen says the same thing), else this Mac's own count of the songs it has.
 * Never one of each: a song count and an artist count from two different
 * countings can disagree with each other.
 */
export function adCounts(local: { songs: number; artists: number }, homemini: { songCount?: unknown; artistCount?: unknown } | null | undefined): { songs: number; artists: number } {
  const both = homeminiCounts(homemini)
  return both ? { songs: both.songCount, artists: both.artistCount } : local
}

/** How many different artists a list has. `keyOf` is the app's own artist key (the renderer passes canonicalArtist). */
export function countArtists(tracks: ReadonlyArray<{ artist?: string | null }>, keyOf: (artist: string) => string = (a) => a): number {
  const seen = new Set<string>()
  for (const t of tracks) {
    const raw = (t.artist ?? '').trim()
    if (!raw) continue
    seen.add(keyOf(raw).trim().toLocaleLowerCase('en-US'))
  }
  return seen.size
}

/** "iPod mini", "iPod, third generation". */
export function ipodModelWords(model: IpodModel): string {
  if (model === 'mini') return 'iPod mini'
  if (model === 'classic') return 'iPod classic'
  if (model === '3g') return 'iPod, third generation'
  return 'iPod'
}

/** "42.6 hours", "1 hour", "32 minutes"; '' when there is no time to speak of. */
export function hoursWords(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return ''
  const minutes = Math.round(durationMs / 60_000)
  if (minutes < 60) return minutes <= 0 ? '' : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.round(durationMs / 360_000) / 10
  return hours === 1 ? '1 hour' : `${hours.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} hours`
}

/** "Nov 8", or "Nov 8, 2025" for another year; '' for no date. */
export function syncedDateWords(when: string | number | null | undefined, now: Date): string {
  if (when == null || when === '') return ''
  const d = new Date(when)
  if (Number.isNaN(d.getTime())) return ''
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

export interface AdLegalInput {
  name: string
  model?: IpodModel | null
  /** A named iPod colour or '#rrggbb'. Only a named one is said. */
  color?: string | null
  songs: number
  cap?: number | null
  durationMs?: number | null
  lastSyncedAt?: string | number | null
  now: Date
}

/** The small grey line. Each sentence is there only when what it says is known. */
export function adLegal(input: AdLegalInput): string {
  const parts: string[] = []
  const name = input.name.trim()
  if (name) parts.push(/[.!?…]$/.test(name) ? name : `${name}.`)
  if (input.model) {
    const color = normalizeIpodColor(input.color)
    parts.push(`${ipodModelWords(input.model)}${color && isNamedIpodColor(color) ? `, ${color}` : ''}.`)
  }
  if (input.songs > 0) {
    const cap = typeof input.cap === 'number' && Number.isInteger(input.cap) && input.cap >= input.songs ? input.cap : null
    const count = cap ? `${n(input.songs)} of ${n(cap)} songs` : `${n(input.songs)} ${input.songs === 1 ? 'song' : 'songs'}`
    const hours = hoursWords(input.durationMs ?? 0)
    parts.push(`${count}${hours ? `, ${hours}` : ''}.`)
  }
  const synced = syncedDateWords(input.lastSyncedAt, input.now)
  if (synced) parts.push(`Last synced ${synced}.`)
  return parts.join(' ')
}

// ── The drawing's colours ────────────────────────────────────────────────

type Rgb = [number, number, number]
const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb
const hexOf = (c: Rgb): string => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
const mix = (a: string, b: string, t: number): string => {
  const x = rgbOf(a), y = rgbOf(b)
  return hexOf([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}
/** 0 (black) to 1 (white), as the eye weighs it. */
const luma = (hex: string): number => { const [r, g, b] = rgbOf(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 }
const chroma = (hex: string): number => { const c = rgbOf(hex); return (Math.max(...c) - Math.min(...c)) / 255 }

export interface IpodDrawingColors {
  model: IpodModel
  /** The case. */
  body: string
  /** The wheel's face: null = the white wheel (its own soft gradient). */
  wheel: string | null
  /** MENU and the three marks. */
  glyph: string
  /** The centre button: null = the white button. */
  hub: string | null
}

/**
 * What each part of the drawn iPod is filled with, for a model in any colour
 * (a named iPod colour or '#rrggbb'; anything else is the model's silver).
 *
 *   mini      anodised case, white wheel and button, marks in the case's colour
 *             (a pale case darkens them so they still read on white)
 *   classic   anodised case, white wheel with grey marks, button in the case's colour
 *   3g        one colour all over: case, four touch keys, wheel, button; the marks glow red-orange
 *   default   glossy case, button in the case's colour; a white wheel with grey marks,
 *             a grey wheel with white marks on a pale case, a dark wheel on a dark case
 */
export function ipodDrawingColors(model: IpodModel, color: string | null | undefined): IpodDrawingColors {
  const c = normalizeIpodColor(color)
  const body = c ? ipodColorHex(c) : '#d5d7da'
  const dark = luma(body) < 0.2
  const pale = luma(body) > 0.62
  if (model === 'mini') {
    return { model, body, wheel: null, hub: null, glyph: pale ? mix(body, '#000000', 0.28) : dark ? mix(body, '#ffffff', 0.25) : body }
  }
  if (model === '3g') {
    return { model, body, wheel: body, hub: body, glyph: '#ff7646' }
  }
  if (model === 'classic') {
    return dark
      ? { model, body, wheel: mix(body, '#ffffff', 0.07), hub: body, glyph: '#d4d4d8' }
      : { model, body, wheel: null, hub: body, glyph: '#a4a7ad' }
  }
  if (dark) return { model, body, wheel: mix(body, '#ffffff', 0.07), hub: body, glyph: '#d4d4d8' }
  if (pale && chroma(body) < 0.15) return { model, body, wheel: mix(body, '#000000', 0.085), hub: mix(body, '#ffffff', 0.3), glyph: '#ffffff' }
  return { model, body, wheel: '#f3f3f4', hub: body, glyph: '#b9bbc0' }
}

/** The name on the drawn screen's title bar: the list's name, cut to what the bar holds. */
export function ipodScreenTitle(name: string, max = 18): string {
  const t = name.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

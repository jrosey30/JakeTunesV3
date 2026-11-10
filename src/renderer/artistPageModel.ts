/**
 * The artist page's first-frame rules (2026-11-10) — pure, so every one of
 * them runs under node --test (__tests__/artist-page-frame-one.test.ts).
 *
 * Jake on the desktop artist page: "slow to appear, artist photos lag, look
 * sloppy. not smooth". The page used to draw its first frame with no profile,
 * no artist photo and no bio, even when all three were on this Mac; each then
 * landed on its own, with no reserved space and no fade. The header showed the
 * most played record's cover, then the artist photo, then the profile's
 * credited photo. The rules here are the phone's "frame-1 rule" on the desktop:
 *
 *   headerPick      — which picture the header shows, decided from what is
 *                     known NOW: a photo known to be on this Mac, else the
 *                     record cover. The header is never left blank waiting
 *                     on a lookup (341 of 2,348 artists have no photo on
 *                     disk; offline that lookup takes 8 s to give up).
 *   heroLayers      — a later, better picture cross-fades in over the one
 *                     showing, in the same box. Never a hard swap, never a
 *                     moment with no picture between two pictures.
 *   bioPlan         — the Wikipedia summary is fetched alongside homemini's
 *                     profile but only SHOWN once homemini has said there is
 *                     no profile (or has not answered within a short grace),
 *                     so one bio is never painted and then replaced.
 *   shownProfileState — real text that was painted stays painted for this
 *                     visit. A profile whose text changed while the page is
 *                     open waits for the next visit (the calmer of the two
 *                     behaviours: nothing moves under the reader); photos of
 *                     the SAME profile fill their reserved tiles as they
 *                     land. An empty About ("No biography found") is not
 *                     text anyone is reading: a profile is let in over it.
 */
import { headerPhotoChoice } from '../common/artist-page.ts'
import type { ArtistProfile, ArtistProfileSource, ArtistProfileState } from '../common/artist-profile.ts'

// ── the header's picture ──────────────────────────────────────────────────

export type HeaderPick =
  | { kind: 'hero'; src: string; url: string; credit?: string }
  | { kind: 'artist'; src: string; slug: string }
  | { kind: 'cover'; src: string }
  /** Ink: no photo and no record cover either. */
  | { kind: 'none' }

/** `version` is the file's mtime (artistPhotoVersions): a photo replaced under the same slug gets a new address. */
export const artistImageUrl = (slug: string, size = 0, version = 0): string => {
  const q = [version > 0 ? `v=${version}` : '', size > 0 ? `s=${size}` : ''].filter(Boolean).join('&')
  return `artist-image://${slug}.jpg${q ? `?${q}` : ''}`
}

export interface HeaderPickInput {
  profile: ArtistProfile | null
  /** Profile photo url → the slug it is saved under on this Mac. */
  photos: Record<string, string>
  /** The credited header photo that failed to draw, if one did. */
  brokenHero: string | null
  /** The app's artist photo: a slug, null (looked up: there is none), undefined (not known yet). */
  artistSlug: string | null | undefined
  /** That photo file's mtime, when known. */
  artistVersion?: number
  /** The artist photo failed to draw. */
  artistPhotoFailed: boolean
  /** The most played record's cover (else the newest record's), if there is one. */
  coverSrc: string | null
}

/**
 * The header's picture, from what is known now (common/artist-page.ts
 * headerPhotoChoice says which KIND wins):
 *  1. the profile's credited header photo, once it is saved on this Mac —
 *     from the first frame when the profile is cached;
 *  2. heroNeedsPhoto: the record cover, never the artist image;
 *  3. the artist image, when one is KNOWN to be on this Mac (the lookup's
 *     slug, else the slug the profile names);
 *  4. otherwise the record cover, from the first frame — whether the lookup
 *     said there is no photo, has not answered yet, or failed. A photo that
 *     does turn up later cross-fades in over it (heroLayers).
 */
export function headerPick(i: HeaderPickInput): HeaderPick {
  const choice = headerPhotoChoice(i.profile)
  const hero = i.profile?.hero
  if (choice === 'hero' && hero && i.photos[hero.url] && i.brokenHero !== hero.url) {
    return { kind: 'hero', src: artistImageUrl(i.photos[hero.url]), url: hero.url, credit: hero.credit }
  }
  const cover: HeaderPick = i.coverSrc ? { kind: 'cover', src: i.coverSrc } : { kind: 'none' }
  if (choice === 'cover') return cover
  const slug = i.artistSlug || i.profile?.heroPhoto || null
  if (slug && !i.artistPhotoFailed) return { kind: 'artist', src: artistImageUrl(slug, 0, slug === i.artistSlug ? i.artistVersion : 0), slug }
  return cover
}

// ── the header's cross-fade ───────────────────────────────────────────────

export interface HeroLayer {
  src: string
  /** loading: in the DOM, invisible, decoding. in: the picture showing. out: fading away under the new one. */
  phase: 'loading' | 'in' | 'out'
  /** The picture's own size, known from the moment it is shown (its framing never changes while visible). */
  natural?: { width: number; height: number }
  /** Shown without a fade (the first picture of a page you came Back to). */
  instant?: boolean
}

export type HeroEvent =
  | { type: 'want'; src: string | null }
  | { type: 'loaded'; src: string; width: number; height: number; instant?: boolean }
  | { type: 'failed'; src: string }
  | { type: 'gone'; src: string }

/**
 * The pictures stacked in the header's box. A new picture loads invisibly
 * above the one showing and fades in when it has decoded; the old one fades
 * out beneath it and is then removed. So between two pictures there is always
 * a picture on screen, and the box (its size, its place) never changes.
 */
export function heroLayers(layers: readonly HeroLayer[], ev: HeroEvent): readonly HeroLayer[] {
  switch (ev.type) {
    case 'want': {
      const current = [...layers].reverse().find((l) => l.phase !== 'out')
      if (ev.src === null) {
        if (!layers.some((l) => l.phase !== 'out')) return layers
        return layers.filter((l) => l.phase !== 'loading').map((l) => (l.phase === 'in' ? { ...l, phase: 'out' as const, instant: false } : l))
      }
      if (current && current.src === ev.src) return layers
      const shown = layers.find((l) => l.phase === 'in')
      if (shown && shown.src === ev.src) return layers.filter((l) => l.phase !== 'loading')   // back to the one showing
      return [...layers.filter((l) => l.phase !== 'loading' && l.src !== ev.src), { src: ev.src, phase: 'loading' }]
    }
    case 'loaded': {
      if (!layers.some((l) => l.src === ev.src && l.phase === 'loading')) return layers
      return layers.map((l) => {
        if (l.src === ev.src && l.phase === 'loading') return { ...l, phase: 'in' as const, natural: { width: ev.width, height: ev.height }, instant: !!ev.instant }
        return l.phase === 'in' ? { ...l, phase: 'out' as const, instant: false } : l
      })
    }
    case 'failed':
      return layers.some((l) => l.src === ev.src && l.phase !== 'out') ? layers.filter((l) => !(l.src === ev.src && l.phase !== 'out')) : layers
    case 'gone':
      return layers.some((l) => l.src === ev.src && l.phase === 'out') ? layers.filter((l) => !(l.src === ev.src && l.phase === 'out')) : layers
  }
}

// ── the bio ───────────────────────────────────────────────────────────────

/** How long the Wikipedia summary waits for homemini's first answer before it is shown anyway. */
export const WIKI_GRACE_MS = 700

export interface BioPlanInput {
  hasProfile: boolean
  /** The cached copy has been read (or there is none). */
  cacheRead: boolean
  source: ArtistProfileSource
  /** homemini has answered (or failed to) at least once this session. */
  settled: boolean
  /** WIKI_GRACE_MS have passed since the page opened. */
  graceOver: boolean
  /** The Wikipedia summary was already shown for this artist this session (Back paints it at once). */
  wikiShownBefore: boolean
}

/**
 * The fallback bio. Fetch it as soon as the cache says there is no profile, so
 * it is ready; show it only when a profile is not about to replace it:
 * homemini said 404 before ('missing'), has answered this session, the grace
 * ran out (away from home its 6 s timeout must not hold the bio), or this
 * same text was on the page before.
 */
export function bioPlan(i: BioPlanInput): { fetchWiki: boolean; showWiki: boolean } {
  if (i.hasProfile || !i.cacheRead) return { fetchWiki: false, showWiki: false }
  return { fetchWiki: true, showWiki: i.wikiShownBefore || i.source === 'missing' || i.settled || i.graceOver }
}

// ── what was painted stays painted ────────────────────────────────────────

const sameDoc = (a: ArtistProfile | null, b: ArtistProfile | null): boolean =>
  a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b))

export interface ShownContext {
  /** Real bio text (homemini's or Wikipedia's) is on the page. The "No biography found" line is not: nobody is reading it. */
  textPainted: boolean
  /** The reader has scrolled away from the top. */
  scrolled: boolean
}

/**
 * The profile the page draws, given the one it is drawing and the newest one
 * known. Same document: take the newest (only its photos or its source
 * changed, and photos land in reserved tiles). A different document: take it
 * only when nothing would move under the reader — the page has no profile
 * yet, no bio text has been painted, and the reader is still at the top.
 * Otherwise the page keeps what it painted and the newer text shows on the
 * next visit.
 */
export function shownProfileState(shown: ArtistProfileState | null, latest: ArtistProfileState, ctx: ShownContext): ArtistProfileState {
  if (!shown || shown === latest) return latest
  if (shown.name.trim().toLowerCase() !== latest.name.trim().toLowerCase()) return latest
  if (sameDoc(shown.profile, latest.profile)) return latest
  if (!shown.profile && !ctx.textPainted && !ctx.scrolled) return latest
  return shown
}

// ── scroll ────────────────────────────────────────────────────────────────

/**
 * Where a page opens. Arriving (a click on an artist) starts at the top;
 * returning (Back / Forward) restores the scroll you left, and so does the
 * page the app reopens on after a relaunch ('restore'). Before 2026-11-10 the
 * saved position was applied on every mount, so a click on an artist could
 * land mid-Discography, where you had last left that artist.
 */
export function initialScroll(arrival: 'arrive' | 'return' | 'restore', saved: { top: number; left: number } | undefined): { top: number; left: number } | null {
  return arrival !== 'arrive' && saved ? saved : null
}

// ── what the page remembers for the session ───────────────────────────────

/** How long the page keeps an answer before it asks main again — main's own holds. */
export const KEEP_WIKI_MS = 24 * 3600 * 1000          // main's Wikipedia cache
export const KEEP_WIKI_NONE_MS = 3600 * 1000           // "no page found": asked again within the hour
export const KEEP_DISCO_MS = 7 * 24 * 3600 * 1000     // a finished MusicBrainz discography
export const KEEP_DISCO_INCOMPLETE_MS = 6 * 3600 * 1000 // an unfinished one (a source was down)

export interface Kept<T> { value: T; until: number }

/** Remember `value` under `key` until `ttlMs` from now. */
export function keep<T>(memo: Map<string, Kept<T>>, key: string, value: T, ttlMs: number, now: number): void {
  memo.set(key, { value, until: now + ttlMs })
}

/** What is remembered under `key`, unless its time is up (then it is forgotten, and main is asked again). */
export function kept<T>(memo: Map<string, Kept<T>>, key: string, now: number): T | undefined {
  const hit = memo.get(key)
  if (!hit) return undefined
  if (now >= hit.until) { memo.delete(key); return undefined }
  return hit.value
}

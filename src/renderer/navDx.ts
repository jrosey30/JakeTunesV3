/**
 * dx.nav — one row per page navigation, into main.log through the existing
 * renderer → flight-recorder pipe (preload dxRecord → main 'dx-record').
 *
 * OFF by default. On with `"navDx": true` in ui-state.json or JT_NAV_DX=1 in
 * the app's environment (navDxDom.ts reads the flag once, at boot). Nothing is
 * listened to, observed or recorded while it is off.
 *
 * The diagnosis of 2026-11-10 ("slow to appear, artist photos lag, look
 * sloppy") could time the parts — the page's script, the network, the files,
 * the CSS — but not the whole: click to first paint, click to settled, how
 * many times the header's picture changed, how much the layout shifted. A
 * week of these rows from Jake's own use gives the cold, warm and away
 * numbers, and proves each fix.
 *
 * This file is the row itself — pure, so node --test checks its shape and
 * that it stays under main's 2,000-character cap for one dx detail (a longer
 * one is replaced by {truncated:true} there). navDxDom.ts feeds it from the
 * page.
 */

export type NavHow = 'click' | 'back' | 'forward' | 'swipe'

export interface NavDxBegin {
  from: string
  to: string
  how: NavHow
  kind: 'arrive' | 'return'
  /** The page was mounted fresh (false: an already-mounted page was shown again). */
  remount: boolean
  /** When the pointer went down for this navigation, on the same clock as `now` (null: keyboard, menu). */
  tClick: number | null
}

export interface NavDxImage { scheme: string; size: number; natural: [number, number]; ms: number }

export interface NavDxRow {
  from: string
  to: string
  how: NavHow
  kind: 'arrive' | 'return'
  remount: boolean
  /** Milliseconds from the click (from the commit when there was no click). */
  t: { click: number | null; commit: number | null; paint: number | null; settled: number | null }
  /** Each thing the artist page asked for: how long it took and where the answer came from. */
  src: Record<string, { ms: number; from: string }>
  /** Every change of the header's picture, with its time. */
  hero: Array<{ t: number; src: string }>
  img: { n: number; byScheme: Record<string, number>; slow: NavDxImage[] }
  shift: { n: number; score: number }
  long: { n: number; ms: number }
  scroll: { saved: number | null; restored: number | null; settled: number | null }
}

export interface NavDx {
  begin(nav: NavDxBegin): void
  mark(name: 'commit' | 'paint'): void
  source(name: string, ms: number, from: string): void
  hero(src: string | null): void
  image(image: NavDxImage): void
  shift(score: number): void
  longTask(ms: number): void
  scroll(part: { saved?: number | null; restored?: number | null }): void
  /** Emit the open row (its settled time is now). No row open: nothing. */
  settle(scrollTop: number | null): void
  /** The row being collected (tests, and the settle watcher's "is one open?"). */
  open(): boolean
}

export const NAV_DX_TAG = 'nav'
const MAX_HERO = 6
const MAX_SLOW = 4
const MAX_SOURCES = 10
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const r1 = (n: number): number => Math.round(n * 10) / 10

export function createNavDx(opts: {
  now: () => number
  emit: (tag: string, detail: NavDxRow) => void
  enabled: () => boolean
}): NavDx {
  let row: NavDxRow | null = null
  let t0 = 0
  const rel = (): number => Math.round(opts.now() - t0)

  const flush = (scrollTop: number | null): void => {
    if (!row) return
    row.t.settled = rel()
    row.scroll.settled = scrollTop === null ? null : Math.round(scrollTop)
    row.shift.score = Math.round(row.shift.score * 10000) / 10000
    row.long.ms = Math.round(row.long.ms)
    const done = row
    row = null
    opts.emit(NAV_DX_TAG, done)
  }

  return {
    begin(nav) {
      if (!opts.enabled()) return
      if (row) flush(null)                      // the last page never settled: its row is still worth having
      const started = opts.now()
      t0 = nav.tClick !== null && started - nav.tClick < 5000 ? nav.tClick : started
      row = {
        from: clip(nav.from, 80), to: clip(nav.to, 80), how: nav.how, kind: nav.kind, remount: nav.remount,
        t: { click: t0 === nav.tClick ? 0 : null, commit: null, paint: null, settled: null },
        src: {}, hero: [], img: { n: 0, byScheme: {}, slow: [] },
        shift: { n: 0, score: 0 }, long: { n: 0, ms: 0 },
        scroll: { saved: null, restored: null, settled: null },
      }
    },
    mark(name) { if (row && row.t[name] === null) row.t[name] = rel() },
    source(name, ms, from) {
      if (!row) return
      const k = clip(name, 24)
      if (!(k in row.src) && Object.keys(row.src).length >= MAX_SOURCES) return
      row.src[k] = { ms: Math.round(ms), from: clip(from, 16) }
    },
    hero(src) {
      if (!row) return
      if (row.hero.length >= MAX_HERO) { row.hero[MAX_HERO - 1] = { t: rel(), src: `+more: ${clip(src ?? 'none', 40)}` }; return }
      row.hero.push({ t: rel(), src: clip(src ?? 'none', 56) })
    },
    image(image) {
      if (!row) return
      row.img.n++
      const scheme = clip(image.scheme, 14)
      row.img.byScheme[scheme] = (row.img.byScheme[scheme] ?? 0) + 1
      row.img.slow.push({ scheme, size: image.size, natural: image.natural, ms: Math.round(image.ms) })
      row.img.slow.sort((a, b) => b.ms - a.ms)
      if (row.img.slow.length > MAX_SLOW) row.img.slow.length = MAX_SLOW
    },
    shift(score) { if (row) { row.shift.n++; row.shift.score += score } },
    longTask(ms) { if (row) { row.long.n++; row.long.ms += ms } },
    scroll(part) {
      if (!row) return
      if (part.saved !== undefined) row.scroll.saved = part.saved === null ? null : r1(part.saved)
      if (part.restored !== undefined) row.scroll.restored = part.restored === null ? null : r1(part.restored)
    },
    settle(scrollTop) { flush(scrollTop) },
    open: () => row !== null,
  }
}

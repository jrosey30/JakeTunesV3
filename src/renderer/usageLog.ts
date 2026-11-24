/**
 * The usage log, renderer side (2026-11-14). main/usage-log-start.ts has the
 * whole list; this file sends main what only the page can see:
 *
 *   launch   the library loaded, and the first frame with it on screen (App.tsx)
 *   screen   every page shown (MainContent's layout effect, beside dx.nav): click or
 *            commit to first paint, and to settled (the page quiet for 300 ms)
 *   play     an <audio> element asked to play and how long until sound
 *   stall    playing, then waiting for data, and for how long
 *   action   seeks (how long the seek took), clicks on buttons (by class, never text)
 *   error    window errors, unhandled rejections, render crashes (all through
 *            CrashNet's report), media errors; a failed IPC is main's
 *   slow     long tasks over 150 ms, coalesced per 10 s
 *
 * Nothing here edits the playback code: <audio> is observed by wrapping
 * HTMLMediaElement.prototype.play, which attaches listeners to each element the
 * first time it plays. Web Audio buffers (the gapless preload) have no element
 * and are not seen; main's playback.active / stopped rows cover them.
 *
 * Events leave in one IPC message per 2 s (preload usageLog → main
 * 'usage-log:events'), where they are scrubbed like everything else
 * (common/usage-log.ts scrubEvent). A file path keeps only its library-relative part.
 */
import { isUnloadPlaceholderError, scrubPath, type UsageDetail, type UsageKind } from '../common/usage-log'

interface Pending { t: string; kind: UsageKind; name: string; ms?: number; ok?: boolean; detail?: UsageDetail }

const FLUSH_MS = 2000
const MAX_QUEUE = 200
const LONG_TASK_MS = 150
const LONG_TASK_REPORT_MS = 10_000
const SETTLE_QUIET_MS = 300
const SETTLE_CAP_MS = 8000

let queue: Pending[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let armed = false

function flush(): void {
  if (timer) { clearTimeout(timer); timer = null }
  if (!queue.length) return
  const batch = queue.slice(0, MAX_QUEUE)
  queue = queue.slice(MAX_QUEUE)
  try { window.electronAPI.usageLog?.(batch) } catch { /* observation only */ }
  if (queue.length) timer = setTimeout(flush, 0)
}

/** One event for the log. Never throws. */
export function usage(kind: UsageKind, name: string, opts: { ms?: number; ok?: boolean; detail?: UsageDetail } = {}): void {
  try {
    queue.push({ t: new Date().toISOString(), kind, name, ...opts })
    if (queue.length > 5 * MAX_QUEUE) queue.splice(0, queue.length - 5 * MAX_QUEUE)
    if (queue.length >= MAX_QUEUE) flush()
    else if (!timer) timer = setTimeout(flush, FLUSH_MS)
  } catch { /* observation only */ }
}

const launched = new Set<string>()
/** A launch milestone, once per run; timed from the page's own start, after the next two frames. */
export function noteLaunch(name: 'launch.library-loaded' | 'launch.library-painted'): void {
  if (launched.has(name)) return
  launched.add(name)
  const report = (): void => usage('launch', name, { ms: Math.round(performance.now()) })
  if (name === 'launch.library-painted') requestAnimationFrame(() => requestAnimationFrame(report))
  else report()
}

/** A render crash, a window error, an unhandled rejection (CrashNet's report). */
export function noteError(kind: string, message: string): void {
  usage(kind === 'render-crash' ? 'crash' : 'error', `renderer.${kind}`, { detail: { message: message.slice(0, 200) } })
}

// ── screens ──
let lastPointerDown = 0
let settleObserver: MutationObserver | null = null
let settleTimer: ReturnType<typeof setInterval> | null = null

/** What a page key says about the page: its kind, and the one id or name it is for. */
export function screenOf(key: string): { name: string; subject: string | null } {
  const k = key.startsWith('kept:') ? key.slice(5) : key
  const i = k.indexOf(':')
  const kind = (i < 0 ? k : k.slice(0, i)) || 'unknown'
  const subject = i < 0 ? null : k.slice(i + 1) || null
  return { name: `screen.${kind}`, subject }
}

/** A page was committed (MainContent's layout effect, beside navDxNavigated). */
export function noteScreen(nav: { from: string; to: string; kind: 'arrive' | 'return'; remount: boolean }): void {
  try {
    const committed = performance.now()
    const clickAt = committed - lastPointerDown < 2000 ? lastPointerDown : null
    const { name, subject } = screenOf(nav.to)
    const from = screenOf(nav.from).name.replace(/^screen\./, '')
    let paintMs = 0
    requestAnimationFrame(() => requestAnimationFrame(() => { paintMs = performance.now() - committed }))
    // Settled: nothing on the page changed for 300 ms (images, rows arriving), at most 8 s.
    if (settleTimer) { clearInterval(settleTimer); settleTimer = null }
    settleObserver?.disconnect()
    let lastChange = committed
    const root = document.querySelector('.main-content') ?? document.body
    settleObserver = new MutationObserver(() => { lastChange = performance.now() })
    settleObserver.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'class'] })
    settleTimer = setInterval(() => {
      const now = performance.now()
      if (now - lastChange < SETTLE_QUIET_MS && now - committed < SETTLE_CAP_MS) return
      if (settleTimer) { clearInterval(settleTimer); settleTimer = null }
      settleObserver?.disconnect()
      settleObserver = null
      const settled = Math.round(lastChange - committed)
      const base = clickAt ?? committed
      usage('screen', name, {
        ms: Math.round(committed - base + (paintMs || 0)),
        detail: {
          from,
          ...(subject && /^(album|artist|playlist|smart)$/.test(name.slice(7)) ? { subject } : {}),
          how: nav.kind === 'return' ? 'back' : 'open',
          remount: nav.remount,
          paintMs: Math.round(paintMs),
          settleMs: settled,
          capped: now - committed >= SETTLE_CAP_MS,
          ...(clickAt !== null ? { fromClickMs: Math.round(committed - clickAt + settled) } : {}),
        },
      })
    }, 100)
  } catch { /* observation only */ }
}

// ── <audio> ──
const watchedMedia = new WeakSet<HTMLMediaElement>()
function fileOf(el: HTMLMediaElement): string {
  const src = el.currentSrc || el.src || ''
  if (!src) return ''
  if (/^https?:/i.test(src)) {
    try { return new URL(src).pathname.replace(/\/\d+(?=\/|$)/g, '/:id').slice(0, 120) } catch { return '' }
  }
  return scrubPath(src)
}
function watchMedia(el: HTMLMediaElement): void {
  if (watchedMedia.has(el)) return
  watchedMedia.add(el)
  const st = { askedAt: 0, stallAt: 0, seekAt: 0, started: false }
  ;(el as HTMLMediaElement & { __usage?: typeof st }).__usage = st
  el.addEventListener('playing', () => {
    const now = performance.now()
    if (st.askedAt) { usage('play', 'play.start', { ms: Math.round(now - st.askedAt), detail: { file: fileOf(el) } }); st.askedAt = 0 }
    if (st.stallAt) { usage('stall', 'play.stall', { ms: Math.round(now - st.stallAt), detail: { file: fileOf(el), at: Math.round(el.currentTime) } }); st.stallAt = 0 }
    st.started = true
  })
  el.addEventListener('waiting', () => { if (st.started && !el.paused && !st.stallAt && !st.seekAt) st.stallAt = performance.now() })
  el.addEventListener('seeking', () => { st.seekAt = performance.now() })
  el.addEventListener('seeked', () => {
    if (st.seekAt) usage('action', 'seek', { ms: Math.round(performance.now() - st.seekAt), detail: { to: Math.round(el.currentTime) } })
    st.seekAt = 0
  })
  el.addEventListener('emptied', () => { st.started = false; st.stallAt = 0 })
  el.addEventListener('error', () => {
    // Howler's unload placeholder, not a failed song (common/usage-log.ts).
    if (isUnloadPlaceholderError(el.getAttribute('src'))) { st.askedAt = 0; st.stallAt = 0; return }
    const e = el.error
    usage('error', 'play.error', { ok: false, detail: { code: e?.code ?? null, message: (e?.message ?? '').slice(0, 200), file: fileOf(el) } })
    st.askedAt = 0
    st.stallAt = 0
  })
}

/** Install the observers once (main.tsx, before the first render). */
export function initUsageLog(): void {
  if (armed || typeof window === 'undefined') return
  armed = true
  window.addEventListener('pointerdown', () => { lastPointerDown = performance.now() }, { capture: true, passive: true })
  window.addEventListener('pagehide', flush)

  // Buttons by what they are, never by what they say.
  document.addEventListener('click', (e) => {
    const el = (e.target as Element | null)?.closest?.('button, [role="button"], a')
    if (!el) return
    const tag = el.getAttribute('data-usage') || (typeof el.className === 'string' ? el.className.split(/\s+/).find((c) => c && !/^(is-|has-)/.test(c)) : '') || el.tagName.toLowerCase()
    usage('action', `click.${tag}`.slice(0, 80))
  }, { capture: true, passive: true })

  // Window errors and unhandled rejections arrive through CrashNet's report (noteError).

  try {
    const proto = HTMLMediaElement.prototype
    const play = proto.play
    proto.play = function usageObservedPlay(this: HTMLMediaElement): Promise<void> {
      try {
        watchMedia(this)
        const st = (this as HTMLMediaElement & { __usage?: { askedAt: number } }).__usage
        if (st && this.paused) st.askedAt = performance.now()
      } catch { /* observation only */ }
      return play.call(this)
    }
  } catch { /* no media here */ }

  if (typeof PerformanceObserver !== 'undefined') {
    let count = 0
    let max = 0
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.duration >= LONG_TASK_MS) { count++; max = Math.max(max, e.duration) }
      }).observe({ type: 'longtask', buffered: false })
      setInterval(() => {
        if (!count) return
        usage('slow', 'renderer.long-task', { ms: Math.round(max), detail: { count, max: Math.round(max), windowMs: LONG_TASK_REPORT_MS } })
        count = 0
        max = 0
      }, LONG_TASK_REPORT_MS)
    } catch { /* not supported here */ }
  }
}

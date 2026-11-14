/**
 * The usage log, wired into the app (2026-11-14). The rules are in
 * common/usage-log.ts, the disk and the sending in usage-log-store.ts; this is
 * where the events come from on the main side:
 *
 *   launch    the process starting, the window's first load, the renderer's
 *             first library paint (sent by the renderer, timed from process start)
 *   action /  every IPC invoke that changes something, with its time and
 *   sync      outcome (edits, imports, CD rips, iPod plan / sync / onboarding,
 *             playlists and headlines, covers, downloads, Music Man asks);
 *             reads only when slow or failed (ipc-register.ts observeIpc)
 *   play      playback starting and stopping (set-playback-active)
 *   network   homemini calls by route: each failure or slow one, and a
 *             10-minute summary per route (status, ms; never a query, never a header)
 *   slow      the main event loop held over 150 ms; a window unresponsive
 *   error     unhandled rejections in main; failed IPC
 *   crash     an uncaught exception in main; a renderer or helper process gone
 *   memory    hourly high-water marks: main, renderer, GPU, all
 *   action    an iPod plugged in or out (the device-changed push)
 * plus whatever the renderer sends (renderer/usageLog.ts: screens, playback
 * starts and stalls, seeks, long tasks, renderer errors).
 *
 * Sending: 20 s after launch, then every minute, never while an iPod sync or a
 * CD rip runs (the POST and its disk reads stay out of their way); after a
 * failure it waits 1, 2, 4 … 30 minutes. Until homemini's route is deployed
 * (404) everything simply waits on disk.
 */
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import { hostname as osHostname } from 'node:os'
import { deviceFromHostname, ipcEvent, MAX_EVENTS_PER_IPC, routeOf, USAGE_ROUTE, type UsageDetail, type UsageKind } from '../common/usage-log.ts'
import { createUsageStore, USAGE_LOG_DIR, type UsageStore } from './usage-log-store.ts'
import { ipcInFlight, observeIpc } from './ipc-register.ts'
import { withCompanionInit } from './hub-companion.ts'

export interface UsageLogDeps {
  userData: string
  /** Short git sha of this build ('dev' for a dev run). */
  build: string
  version: string
  /** homemini, e.g. http://homemini:3000 (no /audio). */
  hubBase: string
  syncInFlight: () => boolean
}

export interface UsageLog {
  log: (kind: UsageKind, name: string, opts?: { ms?: number; ok?: boolean; detail?: UsageDetail }) => void
  /** Why an install or a send should wait right now (an iPod sync, a CD rip), or null. */
  busyReason: () => string | null
  store: UsageStore
}

const SEND_FIRST_MS = 20_000
const SEND_EVERY_MS = 60_000
const BACKOFF_MAX_MS = 30 * 60_000
const LOOP_TICK_MS = 100
const LOOP_HELD_MS = 150
const LOOP_REPORT_MS = 10_000
const NET_SLOW_MS = 2000
const NET_SUMMARY_MS = 10 * 60_000
const MEMORY_SAMPLE_MS = 60_000
const MEMORY_REPORT_MS = 60 * 60_000
const POST_TIMEOUT_MS = 20_000

const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024))

let started: UsageLog | null = null

export function startUsageLog(deps: UsageLogDeps): UsageLog {
  if (started) return started
  const device = deviceFromHostname(osHostname())
  const hub = deps.hubBase.replace(/\/+$/, '')
  let hubHost = ''
  try { hubHost = new URL(hub).host } catch { /* no network logging without a host */ }
  const realFetch = globalThis.fetch.bind(globalThis)

  const store = createUsageStore({
    dir: join(deps.userData, USAGE_LOG_DIR),
    device,
    build: deps.build,
    post: async (body) => {
      const res = await realFetch(`${hub}${USAGE_ROUTE}`, withCompanionInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      }))
      await res.arrayBuffer().catch((err: unknown) => { console.warn('[usage-log] answer unread:', err instanceof Error ? err.message : err) })
      return { status: res.status }
    },
  })

  const log: UsageLog['log'] = (kind, name, opts = {}) => {
    store.log({ t: new Date().toISOString(), kind, name, ...opts })
  }

  const busyReason = (): string | null => {
    if (deps.syncInFlight()) return 'an iPod sync is running'
    if (ipcInFlight('rip-cd-tracks')) return 'a CD rip is running'
    return null
  }

  // ── launch ──
  log('launch', 'launch.main', { ms: Math.round(process.uptime() * 1000), detail: { version: deps.version, build: deps.build, device } })
  app.on('before-quit', () => { log('launch', 'app.quit', { ms: Math.round(process.uptime() * 1000) }) })
  app.on('will-quit', () => { store.flushSync() })

  // ── every IPC invoke (ipc-register.ts) ──
  observeIpc((o) => {
    const ev = ipcEvent(o)
    if (ev) log(ev.kind, ev.name, { ms: ev.ms, ok: ev.ok, detail: ev.detail })
  })

  // ── the renderer's events (renderer/usageLog.ts) ──
  const ours = (wc: WebContents): boolean => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents === wc)
  ipcMain.on('usage-log:events', (e, batch: unknown) => {
    if (!ours(e.sender) || !Array.isArray(batch) || batch.length > MAX_EVENTS_PER_IPC) return
    for (const raw of batch) {
      const r = raw as { kind?: unknown; name?: unknown; detail?: Record<string, unknown> }
      // The first library paint is timed from the PROCESS start, which only main knows.
      if (r && r.kind === 'launch' && r.name === 'launch.library-painted') {
        store.log({ ...r, detail: { ...(r.detail ?? {}), sinceProcessStartMs: Math.round(process.uptime() * 1000) } })
      } else store.log(raw)
    }
  })

  // ── playback starting / stopping (index.ts listens too) ──
  let playing = false
  let playingSince = 0
  ipcMain.on('set-playback-active', (_e, active: unknown) => {
    const on = !!active
    if (on === playing) return
    playing = on
    if (on) { playingSince = Date.now(); log('play', 'playback.active') }
    else log('play', 'playback.stopped', { ms: Date.now() - playingSince })
  })

  // ── homemini calls, by route ──
  type Bucket = { count: number; failures: number; ms: number[] }
  const buckets = new Map<string, Bucket>()
  const urlOf = (input: unknown): string => {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url)
    return ''
  }
  if (hubHost) {
    globalThis.fetch = async function usageObservedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
      const url = urlOf(input)
      let mine = false
      try { mine = new URL(url).host === hubHost } catch { /* not a URL we watch */ }
      if (!mine) return realFetch(input, init)
      const route = routeOf(url)
      const method = (init?.method ?? (typeof input === 'object' && input && 'method' in input ? String((input as Request).method) : 'GET')).toUpperCase()
      const began = performance.now()
      const done = (status: number | null, error?: string): void => {
        const ms = Math.round(performance.now() - began)
        const ok = status !== null && status < 400
        const key = `${method} ${route}`
        const b = buckets.get(key) ?? { count: 0, failures: 0, ms: [] }
        b.count++
        if (!ok) b.failures++
        if (b.ms.length < 2000) b.ms.push(ms)
        buckets.set(key, b)
        if (!ok || ms >= NET_SLOW_MS) {
          log('network', 'net.call', { ms, ok, detail: { route, method, status, ...(error ? { error } : {}) } })
        }
      }
      try {
        const res = await realFetch(input, init)
        done(res.status)
        return res
      } catch (err) {
        const name = err instanceof Error ? err.name : 'Error'
        done(null, name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : (err instanceof Error ? err.message : String(err)).slice(0, 120))
        throw err
      }
    } as typeof fetch
  }
  const netSummary = setInterval(() => {
    for (const [key, b] of buckets) {
      const sorted = [...b.ms].sort((x, y) => x - y)
      const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
      const [method, route] = key.split(' ')
      log('network', 'net.summary', { ms: at(0.5), ok: b.failures === 0, detail: { route, method, count: b.count, failures: b.failures, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 } })
    }
    buckets.clear()
  }, NET_SUMMARY_MS)
  netSummary.unref()

  // ── the main event loop held ──
  let expected = performance.now() + LOOP_TICK_MS
  let holds = 0
  let holdMax = 0
  const loop = setInterval(() => {
    const t = performance.now()
    const late = t - expected
    expected = t + LOOP_TICK_MS
    if (late > LOOP_HELD_MS) { holds++; holdMax = Math.max(holdMax, Math.round(late)) }
  }, LOOP_TICK_MS)
  loop.unref()
  const loopReport = setInterval(() => {
    if (!holds) return
    log('slow', 'main.loop-held', { ms: holdMax, detail: { count: holds, max: holdMax, windowMs: LOOP_REPORT_MS } })
    holds = 0
    holdMax = 0
  }, LOOP_REPORT_MS)
  loopReport.unref()

  // ── memory high-water, hourly ──
  const peak = { mainRss: 0, mainHeap: 0, renderer: 0, gpu: 0, total: 0 }
  const sample = (): void => {
    try {
      const m = process.memoryUsage()
      peak.mainRss = Math.max(peak.mainRss, m.rss)
      peak.mainHeap = Math.max(peak.mainHeap, m.heapUsed)
      let renderer = 0, gpu = 0, total = 0
      for (const p of app.getAppMetrics()) {
        const kb = p.memory?.workingSetSize ?? 0
        total += kb
        if (p.type === 'Tab') renderer += kb
        else if (p.type === 'GPU') gpu += kb
      }
      peak.renderer = Math.max(peak.renderer, renderer * 1024)
      peak.gpu = Math.max(peak.gpu, gpu * 1024)
      peak.total = Math.max(peak.total, total * 1024)
    } catch { /* metrics are best effort */ }
  }
  const memSample = setInterval(sample, MEMORY_SAMPLE_MS)
  memSample.unref()
  const memReport = setInterval(() => {
    sample()
    log('memory', 'memory.hour', { detail: { mainRssMb: mb(peak.mainRss), mainHeapMb: mb(peak.mainHeap), rendererMb: mb(peak.renderer), gpuMb: mb(peak.gpu), totalMb: mb(peak.total) } })
    peak.mainRss = 0; peak.mainHeap = 0; peak.renderer = 0; peak.gpu = 0; peak.total = 0
  }, MEMORY_REPORT_MS)
  memReport.unref()

  // ── errors and crashes in main ──
  process.on('unhandledRejection', (reason) => {
    log('error', 'main.unhandled-rejection', { detail: { message: (reason instanceof Error ? reason.message : String(reason)).slice(0, 200), build: deps.build } })
  })
  // The monitor sees an uncaught exception without changing what happens next.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    log('crash', 'main.uncaught', { detail: { message: (err instanceof Error ? err.message : String(err)).slice(0, 200), origin, build: deps.build } })
    store.flushSync()
  })
  app.on('render-process-gone', (_e, _wc, details) => {
    log('crash', 'renderer.gone', { detail: { reason: details.reason, exitCode: details.exitCode, build: deps.build } })
    store.flushSync()
  })
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    log('crash', 'child.gone', { detail: { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name ?? null } })
  })

  // ── windows: unresponsive spells, the first load, an iPod coming and going ──
  const watched = new WeakSet<BrowserWindow>()
  const watch = (win: BrowserWindow): void => {
    if (watched.has(win)) return
    watched.add(win)
    let hungAt = 0
    win.on('unresponsive', () => { hungAt = Date.now(); log('slow', 'window.unresponsive') })
    win.on('responsive', () => { if (hungAt) log('slow', 'window.responsive-again', { ms: Date.now() - hungAt }); hungAt = 0 })
    win.webContents.once('did-finish-load', () => { log('launch', 'launch.window-loaded', { ms: Math.round(process.uptime() * 1000) }) })
    const wc = win.webContents
    const send = wc.send.bind(wc)
    wc.send = (channel: string, ...args: unknown[]): void => {
      if (channel === 'ipod-device-changed') log('action', 'ipod.device-changed')
      send(channel, ...args)
    }
  }
  for (const w of BrowserWindow.getAllWindows()) watch(w)
  app.on('browser-window-created', (_e, win) => watch(win))

  // ── sending ──
  let backoff = 0
  let nextAt = Date.now() + SEND_FIRST_MS
  let lastFailure: string | null = null
  const sender = setInterval(() => {
    if (Date.now() < nextAt || busyReason()) return
    void store.send().then((r) => {
      if (r.ok) {
        if (lastFailure) console.log(`[usage-log] homemini takes the log again (${r.sent} sent)`)
        lastFailure = null
        backoff = 0
        nextAt = Date.now() + SEND_EVERY_MS
        return
      }
      const why = r.status === null ? (r.error ?? 'no answer') : `HTTP ${r.status}`
      if (why !== lastFailure) console.warn(`[usage-log] could not send the log (${why}); it waits on disk`)
      lastFailure = why
      backoff = Math.min(BACKOFF_MAX_MS, backoff ? backoff * 2 : 60_000)
      nextAt = Date.now() + backoff
    })
  }, 5000)
  sender.unref()

  started = { log, busyReason, store }
  return started
}

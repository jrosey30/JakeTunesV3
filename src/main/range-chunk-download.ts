/**
 * Range-chunk downloads (2026-10-19) — how a background full-file download
 * stays light on a thin link without reading a socket slowly.
 *
 * #179/#180 paced downloads on the RECEIVE side (pacedBody: read the fetch
 * body at 96 KB/s). Measured on workmini the same evening, under its own
 * runtime: the 2.9 MB cover aa82bc48… came down 3/3 at full speed in 2.8 s,
 * but paced at 96 KB/s it failed 2 of 3 times at ~30.7 s with
 * `TypeError: terminated` (UND_ERR_SOCKET) — often AFTER every byte had
 * arrived. curl --limit-rate 70k over the same link finished in 40 s, so it
 * is undici reading slowly, not homemini cutting connections. Spool,
 * live-proxy and artwork-mirror failures went from 14/h to 35–45/h.
 *
 * So the pacing moves to BETWEEN requests: the file comes down as
 * sequential HTTP Range requests, each one read at wire speed (it completes
 * in a fraction of a second), with a sleep between requests so the average
 * holds at the target bytes/s. No socket ever sits half-read, and the link
 * only ever sees short bursts — the #179 goal (never take the whole pipe
 * while a song plays) with a mechanism undici survives.
 *
 *   • The total comes from Content-Range on the first 206; every later 206
 *     must name the same total and start exactly where we asked.
 *   • A 200 means the server ignores Range (homemini's /artwork/:hash does):
 *     that one response is the whole file, read at wire speed, and
 *     `paceDebtMs` tells the caller how long to wait before its next
 *     download so the average still holds.
 *   • A dropped request resumes at the exact byte it reached (a few tries
 *     per chunk); a stalled one is cut by the inactivity guard and resumed.
 *   • Abortable throughout (fetches, bodies, the sleeps between requests),
 *     and the final size is verified against the total.
 *   • bytesPerSec 0 = one plain request at wire speed, exactly the
 *     pre-pacing behaviour (fat links).
 *
 * Electron-free (fetch, clock and sleep injected) so node --test loads it.
 */
import { open, stat, unlink } from 'node:fs/promises'
import { withCompanionInit } from './hub-companion.ts'
import { withBodyInactivityTimeout } from './stream-body-timeout.ts'

/** Smallest / largest single request. */
export const CHUNK_MIN_BYTES = 256 * 1024
export const CHUNK_MAX_BYTES = 1024 * 1024

/**
 * Bytes per request for a target rate: about one second of the budget,
 * 256 KiB–1 MiB. The daytime thin-link rate (96 KB/s) gets 256 KiB — under
 * a second of wire time on the office link, one request every ~2.7 s; the
 * night rate (1 MB/s) gets ~1 MB, so per-request round trips don't eat it.
 */
export function chunkBytesFor(bytesPerSec: number): number {
  if (!(bytesPerSec > 0)) return CHUNK_MAX_BYTES
  return Math.min(CHUNK_MAX_BYTES, Math.max(CHUNK_MIN_BYTES, Math.round(bytesPerSec)))
}

/** Zero body bytes this long inside one ranged request = stalled (resumed). */
const CHUNK_STALL_MS = 20_000
/** Headers budget for every request after the first. The FIRST may wait on a
 *  homemini transcode — the caller's signal bounds that one. */
const CHUNK_HEADER_TIMEOUT_MS = 30_000
const ATTEMPTS_PER_CHUNK = 3
const RETRY_DELAY_MS = 1_000

/** A non-2xx from the server (404 = not there; 416 = empty; 5xx = trouble). */
export class RangeHttpError extends Error {
  readonly status: number
  constructor(status: number) { super(`HTTP ${status}`); this.status = status; this.name = 'RangeHttpError' }
}

/** Not worth retrying: the server broke the contract, or the file changed. */
class RangeProtocolError extends Error {
  constructor(msg: string) { super(msg); this.name = 'RangeProtocolError' }
}

export interface FirstResponseInfo { status: number; total: number; contentType: string }

export interface RangeChunkOptions {
  fetchFn?: typeof fetch
  /** Average ceiling over the whole file. 0 = one plain request at wire speed. */
  bytesPerSec: number
  /** Override the per-request size (default chunkBytesFor(bytesPerSec)). */
  chunkBytes?: number
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Single-request mode: zero body bytes this long = stalled (0 = no guard).
   *  Ranged requests always carry a guard (this, or 20 s when 0). */
  stallMs?: number
  chunkHeaderTimeoutMs?: number
  attemptsPerChunk?: number
  retryDelayMs?: number
  /** Refuse (and stop reading) anything bigger. */
  maxBytes?: number
  /** Called once, on the first response, before its status is judged. A throw
   *  here aborts the download (e.g. the wrong content type). */
  onFirstResponse?: (info: FirstResponseInfo) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface RangeChunkResult {
  bytes: number
  /** 0 only when a plain 200 named no Content-Length. */
  total: number
  contentType: string
  /** True when the server honoured Range (206s). */
  ranged: boolean
  requests: number
  /** ms still owed to hold the average (a whole-file 200 arrives at wire
   *  speed) — the caller waits this out before its next download. */
  paceDebtMs: number
}

/** Receives the bytes, strictly in order. */
export type ChunkSink = (chunk: Uint8Array) => Promise<void> | void

const abortError = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('This operation was aborted', 'AbortError')

/** Settles with `p`, or rejects the moment `signal` aborts. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  if (signal.aborted) {
    p.catch(() => undefined)   // its own rejection (if any) is moot: we are aborting
    return Promise.reject(abortError(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/** `bytes a-b/T` → numbers; null when absent or not that shape. */
export function parseContentRange(h: string | null): { start: number; end: number; total: number } | null {
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i.exec(h ?? '')
  if (!m) return null
  const start = Number(m[1]), end = Number(m[2]), total = Number(m[3])
  return end >= start && total > end ? { start, end, total } : null
}

/**
 * Fetch `url` into `sink`, paced between requests. Throws on any failure
 * (RangeHttpError for a non-2xx; the caller's abort reason when aborted).
 */
export async function fetchInRangeChunks(url: string, sink: ChunkSink, opts: RangeChunkOptions): Promise<RangeChunkResult> {
  const fetchFn = opts.fetchFn ?? fetch
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const signal = opts.signal
  const rate = opts.bytesPerSec > 0 ? opts.bytesPerSec : 0
  const chunk = Math.max(1, Math.floor(opts.chunkBytes ?? chunkBytesFor(rate)))
  const stallMs = opts.stallMs ?? 0
  const ranged = rate > 0
  const chunkStallMs = stallMs > 0 ? stallMs : CHUNK_STALL_MS
  const headerMs = opts.chunkHeaderTimeoutMs ?? CHUNK_HEADER_TIMEOUT_MS
  const attempts = Math.max(1, opts.attemptsPerChunk ?? ATTEMPTS_PER_CHUNK)
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS
  const maxBytes = opts.maxBytes ?? Infinity

  let bytes = 0
  let total = 0
  let contentType = ''
  let requests = 0
  let first = true
  let startedAt = 0
  let sawRanges = false

  /** One request. Writes what arrives; returns normally only when the body ends. */
  const request = async (from: number, to: number | null): Promise<'whole' | 'range'> => {
    const rq = new AbortController()
    const onAbort = (): void => rq.abort(abortError(signal!))
    if (signal?.aborted) throw abortError(signal)
    signal?.addEventListener('abort', onAbort, { once: true })
    // The first request's header wait is the caller's to bound (transcodes).
    const headerTimer = !first && headerMs > 0 ? setTimeout(() => rq.abort(new Error(`no headers within ${headerMs}ms`)), headerMs) : null
    try {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) }
      if (to !== null) headers['Range'] = `bytes=${from}-${to}`
      requests++
      const res = await abortable(fetchFn(url, withCompanionInit({ signal: rq.signal, headers })), rq.signal)
      if (headerTimer) clearTimeout(headerTimer)
      const isFirst = first
      if (isFirst) {
        first = false
        startedAt = now()
        contentType = res.headers.get('content-type') || ''
        const cr = res.status === 206 ? parseContentRange(res.headers.get('content-range')) : null
        const info = { status: res.status, total: cr?.total ?? (Number(res.headers.get('content-length')) || 0), contentType }
        opts.onFirstResponse?.(info)
      }
      if (res.status === 206 && to !== null) {
        const cr = parseContentRange(res.headers.get('content-range'))
        if (!cr) throw new RangeProtocolError(`206 without a usable Content-Range (${res.headers.get('content-range')})`)
        if (cr.start !== from) throw new RangeProtocolError(`asked for byte ${from}, got ${cr.start}`)
        if (isFirst) {
          total = cr.total
          sawRanges = true
          if (total > maxBytes) throw new RangeProtocolError(`oversized: ${total} > ${maxBytes}`)
        } else if (cr.total !== total) {
          throw new RangeProtocolError(`file changed mid-download (total ${total} → ${cr.total})`)
        }
        if (cr.end > Math.min(to, total - 1)) throw new RangeProtocolError(`asked for ${from}-${to}, got ${cr.start}-${cr.end}`)
        if (!res.body) throw new Error('206 with no body')
        const end = from + (cr.end - cr.start + 1)
        await drain(res.body as unknown as ReadableStream<Uint8Array>, end, chunkStallMs, rq.signal)
        // A body that ends early is a dropped request: resumed from `bytes`.
        if (bytes < end) throw new Error(`body ended early at byte ${bytes} of ${end}`)
        return 'range'
      }
      if (res.ok && isFirst) {
        // No Range support (or a plain request): this response IS the file.
        total = Number(res.headers.get('content-length')) || 0
        if (total > maxBytes) throw new RangeProtocolError(`oversized: ${total} > ${maxBytes}`)
        if (!res.body) throw new RangeHttpError(res.status)
        await drain(res.body as unknown as ReadableStream<Uint8Array>, total > 0 ? total : maxBytes, ranged ? chunkStallMs : stallMs, rq.signal)
        return 'whole'
      }
      if (res.ok) throw new RangeProtocolError(`range support vanished mid-download (HTTP ${res.status} at byte ${from})`)
      throw new RangeHttpError(res.status)
    } finally {
      if (headerTimer) clearTimeout(headerTimer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Copy one body into the sink, never past `limit` (absolute offset). */
  const drain = async (raw: ReadableStream<Uint8Array>, limit: number, guardMs: number, rqSignal: AbortSignal): Promise<void> => {
    const body = guardMs > 0 ? withBodyInactivityTimeout(raw, guardMs) : raw
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), rqSignal)
        if (done) return
        if (!value?.byteLength) continue
        if (bytes + value.byteLength > limit) {
          throw new RangeProtocolError(limit === maxBytes ? `oversized: more than ${maxBytes} bytes` : `server sent past byte ${limit}`)
        }
        await sink(value)
        bytes += value.byteLength
      }
    } finally {
      reader.cancel().catch(() => undefined)
    }
  }

  const retryable = (err: unknown): boolean =>
    !(signal?.aborted) && !(err instanceof RangeProtocolError) &&
    !(err instanceof RangeHttpError && err.status < 500)

  const finish = (wasRanged: boolean): RangeChunkResult => {
    if (total > 0 && bytes !== total) throw new Error(`download short: ${bytes}/${total}`)
    const paceDebtMs = rate > 0 ? Math.max(0, Math.round(startedAt + (bytes / rate) * 1000 - now())) : 0
    return { bytes, total: total > 0 ? total : bytes, contentType, ranged: wasRanged, requests, paceDebtMs }
  }

  // ── Single request: fat links (no pacing at all) ─────────────────────
  if (!ranged) {
    await request(0, null)
    return finish(false)
  }

  // ── Ranged: request, wait, request … ──────────────────────────────────
  let failures = 0
  for (;;) {
    if (sawRanges && bytes >= total) return finish(true)
    if (!first) {
      // Hold the average: a request starts no sooner than its share of the budget.
      const wait = startedAt + (bytes / rate) * 1000 - now()
      if (wait > 0) await abortable(sleep(wait), signal)
    }
    const from = bytes
    // Chunk-aligned, so a resumed request finishes the chunk it broke off in.
    const to = first ? chunk - 1 : Math.min(total - 1, from - (from % chunk) + chunk - 1)
    try {
      if ((await request(from, to)) === 'whole') return finish(false)
      failures = 0
    } catch (err) {
      // A whole-file 200 can't be resumed (the server ignores Range), and a
      // contract break or a 4xx won't get better by asking again.
      if (!retryable(err) || (!first && !sawRanges) || ++failures >= attempts) throw err
      await abortable(sleep(retryDelayMs * failures), signal)
    }
  }
}

/**
 * fetchInRangeChunks into `dest` (a .part path the caller renames). The
 * written size is checked against the total; on ANY failure — abort
 * included — `dest` is removed before the error propagates.
 */
export async function downloadInRangeChunks(url: string, dest: string, opts: RangeChunkOptions): Promise<RangeChunkResult> {
  const fh = await open(dest, 'w')
  let closed = false
  try {
    let pos = 0
    const out = await fetchInRangeChunks(url, async (c) => {
      await fh.write(c, 0, c.byteLength, pos)
      pos += c.byteLength
    }, opts)
    await fh.close()
    closed = true
    const written = (await stat(dest)).size
    if (written !== out.bytes || (out.total > 0 && written !== out.total)) throw new Error(`download short on disk: ${written}/${out.total}`)
    return out
  } catch (err) {
    if (!closed) await fh.close().catch(() => undefined)
    await unlink(dest).catch(() => undefined)
    throw err
  }
}

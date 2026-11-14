/**
 * The usage log on disk, and its way to homemini (2026-11-14).
 *
 * Every event is on this Mac's disk before anything tries to send it, so a
 * quit, a crash or a week away from homemini loses nothing but what the cap
 * drops (and that is counted, in the log itself). The shape is the tag
 * write-back queue's (#415, tag-writeback-queue.ts): one serialized line of
 * work for everything that touches the files, unique temp names for every
 * rewrite, and a send that only ever clears what homemini accepted.
 *
 *   <dir>/current.jsonl          appended to (one JSON event per line)
 *   <dir>/seg-<time>-<n>.jsonl   sealed: current.jsonl renamed once it reaches
 *                                SEGMENT_BYTES, or when a send starts. Only the
 *                                sender changes a sealed file after that: it
 *                                rewrites it without the lines homemini took
 *                                (temp + rename), and removes it when none are left.
 *
 *   • Events are kept in memory for at most FLUSH_MS (or FLUSH_AT events),
 *     then appended in one write. A quit appends what is left synchronously.
 *   • The whole folder is capped at CAP_BYTES (50 MB). Past it the oldest
 *     sealed segments go, never the one being sent, and a `dropped` event says
 *     how many events went. Memory is capped too (MAX_BUFFERED), counted the same way.
 *   • One send at a time; a second asker gets the first one's answer.
 *   • A batch homemini answers 413 or 400 is halved and sent again; a single
 *     event it still refuses is dropped and counted. 404 (the route is not
 *     deployed yet), 401/403, 5xx or no answer: everything stays on disk and the
 *     caller tries later (usage-log-start.ts backs off).
 *
 * Electron-free: the folder, the clock and the POST arrive injected
 * (__tests__/usage-log-store.test.ts runs 200 rounds of overlapping writers).
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { batchBody, planBatches, scrubEvent, type UsageDevice } from '../common/usage-log.ts'

export const USAGE_LOG_DIR = 'usage-log'
export const CURRENT_FILE = 'current.jsonl'
export const SEGMENT_BYTES = 1024 * 1024
export const CAP_BYTES = 50 * 1024 * 1024
export const FLUSH_MS = 1000
export const FLUSH_AT = 200
export const MAX_BUFFERED = 5000

export interface PostAnswer { status: number }

export interface UsageStoreDeps {
  dir: string
  device: UsageDevice
  build: string
  /** POST one body to homemini. Resolves with the status; rejects when there was no answer. */
  post: (body: string) => Promise<PostAnswer>
  now?: () => number
  segmentBytes?: number
  capBytes?: number
  flushMs?: number
  flushAt?: number
  maxBuffered?: number
  /** Events per POST (the contract's 500; tests use fewer). */
  maxEvents?: number
  maxBytes?: number
  warn?: (msg: string) => void
}

export type SendResult =
  | { ok: true; sent: number; dropped: number }
  /** Stopped: everything not sent is still on disk. */
  | { ok: false; sent: number; dropped: number; status: number | null; error?: string }

export interface UsageStoreStats {
  logged: number
  sent: number
  /** Dropped for the cap, for memory, or refused by homemini one by one. */
  dropped: number
  buffered: number
  posts: number
  failedPosts: number
}

export interface UsageStore {
  /** One event (anything; scrubEvent decides what it becomes). Never throws. */
  log: (raw: unknown) => void
  /** Buffer → disk. */
  flush: () => Promise<void>
  /** The quit path: what is buffered goes to disk before the process leaves. */
  flushSync: () => void
  /** Send what is on disk, oldest first. */
  send: () => Promise<SendResult>
  /** Nothing writing, nothing sending (tests). */
  idle: () => Promise<void>
  stats: () => UsageStoreStats
  /** Bytes in the folder right now (tests). */
  diskBytes: () => Promise<number>
  stop: () => void
}

const SEG = /^seg-\d+-\d+-[a-z0-9]+\.jsonl$/

/**
 * How many of Jake's events these lines stand for. A `dropped` line stands for
 * the events it counted, so when the cap takes it the count carries on into
 * the next one and what homemini is told always adds up.
 */
/** Lines that are events of their own (not a count of earlier ones). */
export function freshIn(lines: string[]): number {
  return lines.filter((l) => l.trim() && !l.includes('"usage-log.dropped"')).length
}

export function eventsIn(lines: string[]): number {
  let n = 0
  for (const l of lines) {
    if (!l.trim()) continue
    if (l.includes('"usage-log.dropped"')) {
      try { n += Number((JSON.parse(l) as { detail?: { count?: unknown } }).detail?.count) || 0 } catch { n += 1 }
    } else n += 1
  }
  return n
}

export function createUsageStore(deps: UsageStoreDeps): UsageStore {
  const now = deps.now ?? Date.now
  const segmentBytes = deps.segmentBytes ?? SEGMENT_BYTES
  const capBytes = deps.capBytes ?? CAP_BYTES
  const flushMs = deps.flushMs ?? FLUSH_MS
  const flushAt = deps.flushAt ?? FLUSH_AT
  const maxBuffered = deps.maxBuffered ?? MAX_BUFFERED
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const currentPath = join(deps.dir, CURRENT_FILE)
  const envelope = batchBody(deps.device, deps.build, []).length

  let buffer: string[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let seq = 0
  let currentBytes: number | null = null
  let sendingSeg: string | null = null
  let sending: Promise<SendResult> | null = null
  let stopped = false
  const s = { logged: 0, sent: 0, dropped: 0, posts: 0, failedPosts: 0 }
  let warnedWrite = false
  /** Events the memory cap took since the last flush. */
  let memDropped = 0

  // ── one line of work for the files ──
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  const tmpName = (dest: string): string => `${dest}.${process.pid}.${now()}.${Math.random().toString(36).slice(2, 10)}.tmp`

  /** `count` events are gone for good (`fresh` of them newly: the rest were counted before). */
  const counted = (count: number, reason: string, fresh = count): void => {
    if (count <= 0) return
    s.dropped += fresh
    const ev = scrubEvent({ kind: 'dropped', name: 'usage-log.dropped', detail: { count, reason } }, now())
    if (ev) buffer.push(JSON.stringify(ev))
    schedule()
  }

  const schedule = (): void => {
    if (stopped || flushTimer) return
    flushTimer = setTimeout(() => { flushTimer = null; void flush() }, buffer.length >= flushAt ? 0 : flushMs)
    flushTimer.unref?.()
  }

  const log = (raw: unknown): void => {
    try {
      const ev = scrubEvent(raw, now())
      if (!ev) return
      buffer.push(JSON.stringify(ev))
      s.logged++
      if (buffer.length > maxBuffered) {
        // Disk can't keep up (or is refusing): the oldest in memory go, counted.
        const over = buffer.length - maxBuffered
        // One running count, written as one line at the next flush: a "dropped" line held in
        // memory would itself take the room it reports on.
        const gone = buffer.splice(0, over)
        memDropped += eventsIn(gone)
        s.dropped += freshIn(gone)
      }
      if (buffer.length >= flushAt && flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      schedule()
    } catch { /* the log never takes the app down */ }
  }

  const listSegments = async (): Promise<string[]> => {
    let names: string[] = []
    try { names = await readdir(deps.dir) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return names.filter((n) => SEG.test(n)).sort()
  }

  const sizeOf = async (p: string): Promise<number> => {
    try { return (await stat(p)).size } catch { return 0 }
  }

  /** current.jsonl → a sealed segment (inside the chain). */
  const sealCurrent = async (): Promise<void> => {
    const size = currentBytes ?? await sizeOf(currentPath)
    if (size === 0) { currentBytes = 0; return }
    const name = `seg-${String(now()).padStart(15, '0')}-${String(seq++).padStart(6, '0')}-${Math.random().toString(36).slice(2, 8)}.jsonl`
    try {
      await rename(currentPath, join(deps.dir, name))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    currentBytes = 0
  }

  const linesOf = async (p: string): Promise<string[]> => {
    try { return (await readFile(p, 'utf-8')).split('\n') } catch { return [] }
  }

  /** Over the cap: the oldest sealed segments go (never the one being sent), counted. Inside the chain. */
  const enforceCap = async (): Promise<void> => {
    const segs = await listSegments()
    const sizes = await Promise.all(segs.map((n) => sizeOf(join(deps.dir, n))))
    let total = sizes.reduce((a, b) => a + b, 0) + (currentBytes ?? await sizeOf(currentPath))
    let lost = 0
    let fresh = 0
    for (let i = 0; i < segs.length && total > capBytes; i++) {
      if (segs[i] === sendingSeg) continue
      const p = join(deps.dir, segs[i])
      const lines = await linesOf(p)
      lost += eventsIn(lines)
      fresh += freshIn(lines)
      try { await unlink(p) } catch { /* gone already */ }
      total -= sizes[i]
    }
    if (lost) counted(lost, 'cap', fresh)
  }

  const flush = (): Promise<void> => serial(async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (memDropped) {
      const ev = scrubEvent({ kind: 'dropped', name: 'usage-log.dropped', detail: { count: memDropped, reason: 'memory' } }, now())
      if (ev) buffer.unshift(JSON.stringify(ev))
      memDropped = 0
    }
    if (!buffer.length) return
    const lines = buffer
    buffer = []
    const body = `${lines.join('\n')}\n`
    try {
      await mkdir(deps.dir, { recursive: true })
      await appendFile(currentPath, body, 'utf-8')
      warnedWrite = false
      currentBytes = currentBytes === null ? await sizeOf(currentPath) : currentBytes + Buffer.byteLength(body)
      if (currentBytes >= segmentBytes) await sealCurrent()
      await enforceCap()
    } catch (err) {
      // Kept in memory for the next try, ahead of anything newer.
      buffer = [...lines, ...buffer]
      if (!warnedWrite) { warnedWrite = true; warn(`[usage-log] could not write the log: ${err instanceof Error ? err.message : String(err)}`) }
    }
    if (buffer.length) schedule()
  })

  const flushSync = (): void => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (memDropped) {
      const ev = scrubEvent({ kind: 'dropped', name: 'usage-log.dropped', detail: { count: memDropped, reason: 'memory' } }, now())
      if (ev) buffer.unshift(JSON.stringify(ev))
      memDropped = 0
    }
    if (!buffer.length) return
    try {
      mkdirSync(deps.dir, { recursive: true })
      appendFileSync(currentPath, `${buffer.join('\n')}\n`, 'utf-8')
      buffer = []
      currentBytes = null
    } catch (err) {
      warn(`[usage-log] could not write the log at quit: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** What is left of a segment once homemini has taken the lines before it. Inside the chain. */
  const keepRest = async (name: string, rest: string[]): Promise<void> => {
    const p = join(deps.dir, name)
    if (!rest.length) {
      try { await unlink(p) } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
      return
    }
    const tmp = tmpName(p)
    try {
      await writeFile(tmp, `${rest.join('\n')}\n`, 'utf-8')
      await rename(tmp, p)
    } catch (err) {
      await unlink(tmp).catch((e: unknown) => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warn(`[usage-log] could not remove ${tmp}`) })
      throw err
    }
  }

  const sendOnce = async (): Promise<SendResult> => {
    let sent = 0
    let dropped = 0
    await flush()
    await serial(sealCurrent)
    const segs = await serial(listSegments)
    for (const name of segs) {
      if (stopped) break
      const lines = await serial(async () => {
        sendingSeg = name
        try { return (await readFile(join(deps.dir, name), 'utf-8')).split('\n').filter((l) => l.trim()) } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null   // the cap took it before we got here
          throw err
        }
      })
      if (lines === null) continue
      let rest = lines
      let limit = deps.maxEvents
      try {
        while (rest.length) {
          const batch = planBatches(rest, envelope, limit, deps.maxBytes)[0]
          let status: number
          try {
            s.posts++
            status = (await deps.post(batchBody(deps.device, deps.build, batch))).status
          } catch (err) {
            s.failedPosts++
            return { ok: false, sent, dropped, status: null, error: err instanceof Error ? err.message : String(err) }
          }
          if (status >= 200 && status < 300) {
            rest = rest.slice(batch.length)
            sent += batch.length
            s.sent += batch.length
            limit = deps.maxEvents
            await serial(() => keepRest(name, rest))
          } else if (status === 413 || status === 400) {
            s.failedPosts++
            if (batch.length > 1) { limit = Math.max(1, Math.floor(batch.length / 2)); continue }
            rest = rest.slice(1)
            dropped++
            await serial(async () => { await keepRest(name, rest); counted(1, status === 413 ? 'too-big' : 'refused') })
          } else {
            s.failedPosts++
            return { ok: false, sent, dropped, status }
          }
        }
      } finally {
        sendingSeg = null
      }
    }
    return { ok: true, sent, dropped }
  }

  const send = (): Promise<SendResult> => {
    if (sending) return sending
    sending = sendOnce().catch((err: unknown) => ({ ok: false as const, sent: 0, dropped: 0, status: null, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { sending = null })
    return sending
  }

  return {
    log,
    flush,
    flushSync,
    send,
    idle: async () => { while (sending || flushTimer) { if (sending) await sending; if (flushTimer) await flush() } await serial(async () => undefined) },
    stats: () => ({ ...s, buffered: buffer.length }),
    diskBytes: async () => {
      const segs = await listSegments()
      const sizes = await Promise.all([...segs.map((n) => sizeOf(join(deps.dir, n))), sizeOf(currentPath)])
      return sizes.reduce((a, b) => a + b, 0)
    },
    stop: () => { stopped = true; if (flushTimer) { clearTimeout(flushTimer); flushTimer = null } },
  }
}

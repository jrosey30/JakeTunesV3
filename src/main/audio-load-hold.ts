/**
 * One load reads one file (2026-11-14).
 *
 * The media element fetches a song in pieces: a first request, then Range
 * requests for as long as it plays (Jake's "Stalks (Greenpoint Mix)": the
 * next one came 50 s in). The ipod-audio:// handler used to open the file BY
 * PATH for every piece. play-cache-serve-pin.ts kept one load on one path,
 * but a path is not a file: when the tag write-back renamed a rewritten copy
 * over the song (audio-write-guard.ts writeVerified), the next piece came out
 * of the new file at an offset taken from the old file's header. mutagen had
 * moved the audio to make room for the longer tags, so those bytes were the
 * wrong ones: "DEMUXER_ERROR … PTS is not defined", a failed reload, a skip.
 *
 * So a load opens its file ONCE, on its first request, and every later piece
 * of that load is read from that open file. A rename or an unlink over the
 * path no longer reaches it: the open file is the old inode until it is
 * closed. (A writer that edits the same inode in place still can; the tag
 * write-back's in-place path, for hardlinked files, waits for the song to be
 * done instead: song-in-use.ts.)
 *
 * When a hold closes: its key gets a new load (the old hold closes once its
 * last piece has been sent), nobody has read it for `idleMs`, or more than
 * `max` holds are open (the least recently read idle one goes). A hold with a
 * piece still being sent is never closed under it.
 *
 * A key's version is remembered after its hold closes. A later piece of that
 * load arriving for a file that is no longer that version is refused (409)
 * rather than spliced: an error the player recovers from is better than bytes
 * it decodes as garbage.
 *
 * The URL. Measured in Electron 30 (a muted, hidden window; scratch proof
 * in the PR): Chromium keeps a song's bytes per URL across media elements. A
 * second element on the same URL, made at once or 7 s after the first was
 * released, never asked for byte 0 again, with or without
 * `Cache-Control: no-store`: it read the old header from memory and asked
 * only for the middle. So the main process cannot put a version into a
 * reload's URL (a redirect needs a request for byte 0 that never comes); the
 * renderer has to build it (`?v=`, in useAudio.ts, which is Do-Not-Touch).
 * The handler already strips `?v=` from the path and holds each marked URL
 * as its own load (`splitAudioUrl`, `holdKey`), so that change is one line on
 * the renderer side. Until then: while a load is held, a reload's pieces
 * come from the same file as the header it remembers (proved in the same
 * window: no error, sound, where reading by path gave PIPELINE_ERROR_DECODE),
 * and once the hold is gone a changed file is refused, never spliced.
 *
 * Electron-free (Node's fs, stream and fetch Response only);
 * __tests__/audio-load-hold.test.ts.
 */
import { parseRangeHeader } from './range-header.ts'

export interface HoldFileStat { size: number; mtimeMs: number; ino?: number }
/**
 * The part of fs/promises' FileHandle a hold uses. Only positional reads:
 * `FileHandle.createReadStream` closes the HANDLE when its stream is
 * destroyed, `autoClose: false` or not (Node 22, measured: fd -1 after one
 * cancelled piece), and the player cancels pieces all the time.
 */
export interface HoldFileHandle {
  stat(): Promise<HoldFileStat>
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/** Bytes start..end (inclusive) of an open file, read as the consumer pulls; `done` once, at the end or on cancel. */
function rangeStream(fh: HoldFileHandle, start: number, end: number, done: () => void): ReadableStream<Uint8Array> {
  let pos = start
  let over = false
  const finish = (): void => { if (!over) { over = true; done() } }
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (pos > end) { ctrl.close(); finish(); return }
      const len = Math.min(256 * 1024, end - pos + 1)
      const buf = new Uint8Array(len)
      try {
        const { bytesRead } = await fh.read(buf, 0, len, pos)
        if (bytesRead === 0) { ctrl.close(); finish(); return }   // the file is shorter than it was said to be
        pos += bytesRead
        ctrl.enqueue(bytesRead === len ? buf : buf.subarray(0, bytesRead))
      } catch (err) {
        ctrl.error(err)
        finish()
      }
    },
    cancel() { finish() },
  })
}

export interface LoadHoldDeps {
  open: (path: string) => Promise<HoldFileHandle>
  now?: () => number
  /** A hold nobody has read for this long is closed. */
  idleMs?: number
  /** Most holds open at once; past it the least recently read idle one closes. */
  max?: number
  warn?: (msg: string) => void
}

export const LOAD_HOLD_IDLE_MS = 15 * 60_000
export const LOAD_HOLD_MAX = 24

/** A file's version for the URL marker: its mtime and size. */
export function fileVersion(st: HoldFileStat): string {
  return `${Math.round(st.mtimeMs).toString(36)}-${st.size.toString(36)}`
}

/**
 * Does this request start a load? No Range, or a Range from byte 0. A suffix
 * range ("bytes=-N", an MP4's index at the end) is a piece of a load, never
 * the start of one.
 */
export function startsLoad(rangeHeader: string | null): boolean {
  if (!rangeHeader) return true
  return /^bytes=0-\d*$/.test(rangeHeader.trim())
}

/** `ipod-audio://<encoded path>?v=x` → its path part and its `v`, if any. */
export function splitAudioUrl(url: string, scheme = 'ipod-audio://'): { base: string; version: string | null } {
  const q = url.indexOf('?')
  const base = q < 0 ? url : url.slice(0, q)
  if (q < 0 || !base.startsWith(scheme)) return { base, version: null }
  const v = new URLSearchParams(url.slice(q + 1)).get('v')
  return { base, version: v && /^[0-9a-z-]{1,40}$/.test(v) ? v : null }
}

/** The key a load is held under: the URL without anything but its `v`. */
export function holdKey(base: string, version: string | null): string {
  return version ? versionedUrl(base, version) : base
}

export function versionedUrl(base: string, version: string): string {
  return `${base}?v=${version}`
}

interface Held {
  fh: HoldFileHandle
  /** The file actually read (the song, or its play-cache copy). */
  path: string
  /** The song's own path: what "in use" is asked about. */
  source: string
  size: number
  version: string
  headers: ServeHeaders
  active: number
  lastUse: number
  retired: boolean
  closed: boolean
}

export interface ServeHeaders { contentType: string; source: string }

export interface LoadHold {
  /**
   * A load starts (`startsLoad`): open `path` now and serve this request from
   * it, held under `key`. Any earlier hold for that key closes once its
   * pieces are sent.
   */
  load(key: string, path: string, source: string, rangeHeader: string | null, headers: ServeHeaders): Promise<Response>
  /** A piece of a load already held: served from the file it opened. Null = no hold for this key. */
  continue(key: string, rangeHeader: string | null): Response | null
  /**
   * A piece of a load whose hold has closed (idle): open the path again, but
   * only if it is still the version this key last served. 409 otherwise.
   */
  reopen(key: string, path: string, source: string, rangeHeader: string | null, headers: ServeHeaders): Promise<Response>
  /** Is any load holding this song's file open? (song-in-use.ts) */
  holdsSource(source: string): boolean
  /** The version this key last served, if remembered. */
  versionOf(key: string): string | null
  /** Close holds nobody is reading. Runs on every call too. */
  sweep(): void
  /** Close everything (quit). */
  closeAll(): Promise<void>
  stats(): { open: number; reading: number; opened: number; closed: number; refused: number }
}

export function createLoadHold(deps: LoadHoldDeps): LoadHold {
  const now = deps.now ?? Date.now
  const idleMs = deps.idleMs ?? LOAD_HOLD_IDLE_MS
  const max = deps.max ?? LOAD_HOLD_MAX
  const warn = deps.warn ?? (() => {})
  const holds = new Map<string, Held>()          // key → the current hold
  const retired = new Set<Held>()                // replaced, still sending a piece
  const versions = new Map<string, string>()     // key → version last served (bounded)
  const st = { opened: 0, closed: 0, refused: 0 }

  const close = (h: Held): void => {
    if (h.closed) return
    h.closed = true
    retired.delete(h)
    st.closed++
    h.fh.close().catch((err: unknown) => warn(`[audio-load-hold] close failed for ${h.path}: ${err instanceof Error ? err.message : String(err)}`))
  }
  const retire = (h: Held): void => {
    h.retired = true
    if (h.active === 0) close(h)
    else retired.add(h)
  }
  const remember = (key: string, version: string): void => {
    versions.delete(key)
    versions.set(key, version)
    if (versions.size > 2000) versions.delete(versions.keys().next().value as string)
  }
  const install = (key: string, h: Held): void => {
    const old = holds.get(key)
    holds.set(key, h)
    if (old && old !== h) retire(old)
    remember(key, h.version)
  }

  const sweep = (): void => {
    const t = now()
    for (const [key, h] of holds) {
      if (h.active === 0 && t - h.lastUse >= idleMs) { holds.delete(key); close(h) }
    }
    if (holds.size > max) {
      const idle = [...holds].filter(([, h]) => h.active === 0).sort((a, b) => a[1].lastUse - b[1].lastUse)
      for (const [key, h] of idle) {
        if (holds.size <= max) break
        holds.delete(key); close(h)
      }
    }
  }

  const respond = (h: Held, rangeHeader: string | null): Response => {
    h.lastUse = now()
    const base = { 'Content-Type': h.headers.contentType, 'Accept-Ranges': 'bytes', 'X-JT-Audio-Source': h.headers.source }
    let start = 0, end = h.size - 1, partial = false
    if (rangeHeader) {
      const parsed = parseRangeHeader(rangeHeader, h.size)
      if (parsed === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${h.size}` } })
      if (parsed) { start = parsed.start; end = parsed.end; partial = true }
    }
    if (h.size === 0) return new Response(new Uint8Array(0), { status: 200, headers: { ...base, 'Content-Length': '0' } })
    h.active++
    const stream = rangeStream(h.fh, start, end, () => {
      h.active--
      h.lastUse = now()
      if (h.retired && h.active === 0) close(h)
    })
    return new Response(stream, {
      status: partial ? 206 : 200,
      headers: { ...base, 'Content-Length': String(end - start + 1), ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${h.size}` } : {}) },
    })
  }

  const openHold = async (path: string, source: string, headers: ServeHeaders): Promise<Held> => {
    const fh = await deps.open(path)
    try {
      const s = await fh.stat()
      st.opened++
      return { fh, path, source, size: s.size, version: fileVersion(s), headers, active: 0, lastUse: now(), retired: false, closed: false }
    } catch (err) {
      await fh.close().catch(() => undefined)
      throw err
    }
  }

  return {
    async load(key, path, source, rangeHeader, headers) {
      sweep()
      const h = await openHold(path, source, headers)
      install(key, h)
      sweep()
      return respond(h, rangeHeader)
    },
    continue(key, rangeHeader) {
      sweep()
      const h = holds.get(key)
      if (!h || h.closed) return null
      return respond(h, rangeHeader)
    },
    async reopen(key, path, source, rangeHeader, headers) {
      sweep()
      const h = await openHold(path, source, headers)
      const was = versions.get(key)
      if (was && was !== h.version) {
        close(h)
        st.refused++
        warn(`[audio-load-hold] ${path}: the file changed under a load (was ${was}, now ${h.version}); refused, the player reloads it`)
        return new Response('The file changed under this load', { status: 409 })
      }
      install(key, h)
      return respond(h, rangeHeader)
    },
    holdsSource(source) {
      sweep()
      for (const h of holds.values()) if (!h.closed && h.source === source) return true
      for (const h of retired) if (!h.closed && h.source === source) return true
      return false
    },
    versionOf: (key) => versions.get(key) ?? null,
    sweep,
    async closeAll() {
      for (const h of [...holds.values(), ...retired]) close(h)
      holds.clear()
    },
    stats: () => ({
      open: [...holds.values()].filter((h) => !h.closed).length + retired.size,
      reading: [...holds.values(), ...retired].reduce((n, h) => n + h.active, 0),
      ...st,
    }),
  }
}

/**
 * The ipod-audio:// handler's local serve, both of its branches: a request
 * that starts a load opens the file (`load`); a piece of a load that is no
 * longer held opens it again only if it is the version that load had
 * (`reopen`). (A piece of a held load never gets here: the handler answers it
 * from the hold before anything else.) Anything that can't be read is 404,
 * as the two inline serves it replaced answered.
 */
export async function serveHeldFile(hold: LoadHold, req: {
  url: string
  /** The file to read: the song, or its play-cache copy. */
  path: string
  /** The song's library path (colon form): what "in use" asks about. */
  source: string
  range: string | null
  contentType: string
  label: string
  warn?: (msg: string) => void
}): Promise<Response> {
  const { base, version } = splitAudioUrl(req.url)
  const key = holdKey(base, version)
  const headers = { contentType: req.contentType, source: req.label }
  try {
    return startsLoad(req.range)
      ? await hold.load(key, req.path, req.source, req.range, headers)
      : await hold.reopen(key, req.path, req.source, req.range, headers)
  } catch (err) {
    req.warn?.(`[ipod-audio] ${req.label} serve failed: ${err instanceof Error ? err.message : String(err)}`)
    return new Response('Not Found', { status: 404 })
  }
}

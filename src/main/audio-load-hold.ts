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
 * last piece has been sent), nobody has read it for `idleMs` (pieces still
 * "being sent" or not), or more than `max` holds are open (the least
 * recently read idle one goes). A piece that is being read is never closed
 * under.
 *
 * Review of #425: Electron can drop a response without cancelling its body,
 * and 200 such pieces kept a hold, and so the song's "in use", open until a
 * restart: its tag edit never landed. So a hold closes when nobody has read
 * ANY of its pieces for `idleMs`, whether pieces are still "being sent" or
 * not, the current hold and a replaced one alike; whatever is left of them
 * then counts as abandoned. A piece unread for `pieceStaleMs` no longer
 * counts as being read (`stats().reading`), but its file is NOT closed for
 * that: a playing song whose body the player has simply not pulled for a few
 * minutes (it has enough buffered) must still read on when it comes back,
 * even after a second load of the same URL (repeat one) replaced its hold.
 * If a reader does come back after its file closed, the read fails and the
 * player reloads; FileHandle refuses reads after close, so a reused
 * descriptor can never be read through it.
 *
 * A key's version is remembered after its hold closes, with what the file's
 * bytes looked like (`contentSignature`: size, the first and last 64 KB, and
 * an MP4's audio offset). A later piece of that load whose file now has
 * another date but the same bytes is served (a touch, a copy of the same
 * file); one whose bytes changed is refused (409) rather than spliced: an
 * error the player recovers from is better than bytes it decodes as garbage.
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
import { createHash } from 'crypto'
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

type PieceEnd = 'ended' | 'cancelled' | 'failed' | 'abandoned'
/** One response body being sent. `finish` is idempotent. */
interface Piece { lastPull: number; finish: (how: PieceEnd) => void }

/**
 * Bytes start..end (inclusive) of an open file, read as the consumer pulls.
 * `piece.finish` once: at the end, on cancel, on an error, or by the sweep.
 */
function rangeStream(fh: HoldFileHandle, start: number, end: number, piece: Piece, pulled: () => void): ReadableStream<Uint8Array> {
  let pos = start
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      pulled()
      if (pos > end) { ctrl.close(); piece.finish('ended'); return }
      const len = Math.min(256 * 1024, end - pos + 1)
      const buf = new Uint8Array(len)
      try {
        const { bytesRead } = await fh.read(buf, 0, len, pos)
        if (bytesRead === 0) { ctrl.close(); piece.finish('ended'); return }   // the file is shorter than it was said to be
        pos += bytesRead
        ctrl.enqueue(bytesRead === len ? buf : buf.subarray(0, bytesRead))
      } catch (err) {
        ctrl.error(err)
        piece.finish('failed')
      }
    },
    cancel() { piece.finish('cancelled') },
  })
}

const SIG_EDGE = 64 * 1024

/** The offset of an MP4's top-level `mdat` (where its audio starts), or null. A few 8/16-byte reads. */
async function mp4AudioOffset(fh: HoldFileHandle, size: number): Promise<number | null> {
  const head = new Uint8Array(16)
  let pos = 0
  for (let i = 0; i < 64 && pos + 8 <= size; i++) {
    const { bytesRead } = await fh.read(head, 0, 16, pos)
    if (bytesRead < 8) return null
    const dv = new DataView(head.buffer)
    let len = dv.getUint32(0)
    const type = String.fromCharCode(head[4], head[5], head[6], head[7])
    if (i === 0 && type !== 'ftyp') return null
    if (len === 1 && bytesRead >= 16) len = Number(dv.getBigUint64(8))
    else if (len === 0) len = size - pos
    if (type === 'mdat') return pos
    if (len < 8) return null
    pos += len
  }
  return null
}

/**
 * What a file's bytes look like, cheaply: its size, a hash of its first and
 * last 64 KB, and (an MP4) where its audio starts. Two files with the same
 * signature read the same at the offsets a player already has.
 */
export async function contentSignature(fh: HoldFileHandle, size: number): Promise<string> {
  const h = createHash('sha1')
  const edge = async (pos: number, len: number): Promise<void> => {
    if (len <= 0) return
    const buf = new Uint8Array(len)
    const { bytesRead } = await fh.read(buf, 0, len, pos)
    h.update(buf.subarray(0, bytesRead))
  }
  await edge(0, Math.min(SIG_EDGE, size))
  await edge(Math.max(0, size - SIG_EDGE), Math.min(SIG_EDGE, size))
  return `${size}:${await mp4AudioOffset(fh, size)}:${h.digest('hex')}`
}

export interface LoadHoldDeps {
  open: (path: string) => Promise<HoldFileHandle>
  now?: () => number
  /** A hold nobody has read for this long is closed. */
  idleMs?: number
  /** Most holds open at once; past it the least recently read idle one closes. */
  max?: number
  /** A piece nobody has read for this long no longer counts as being read (stats only). */
  pieceStaleMs?: number
  warn?: (msg: string) => void
}

export const LOAD_HOLD_IDLE_MS = 15 * 60_000
export const LOAD_HOLD_MAX = 24
export const LOAD_HOLD_PIECE_STALE_MS = 2 * 60_000

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
  signature: string
  headers: ServeHeaders
  pieces: Set<Piece>
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
  stats(): { open: number; reading: number; stale: number; opened: number; closed: number; refused: number; sameBytes: number; ended: number; cancelled: number; failed: number; abandoned: number }
}

export function createLoadHold(deps: LoadHoldDeps): LoadHold {
  const now = deps.now ?? Date.now
  const idleMs = deps.idleMs ?? LOAD_HOLD_IDLE_MS
  const max = deps.max ?? LOAD_HOLD_MAX
  const pieceStaleMs = deps.pieceStaleMs ?? LOAD_HOLD_PIECE_STALE_MS
  const warn = deps.warn ?? (() => {})
  const holds = new Map<string, Held>()          // key → the current hold
  const retired = new Set<Held>()                // replaced, still sending a piece
  const versions = new Map<string, { version: string; signature: string }>()   // key → what it last served (bounded)
  const st = { opened: 0, closed: 0, refused: 0, sameBytes: 0, ended: 0, cancelled: 0, failed: 0, abandoned: 0 }

  const close = (h: Held): void => {
    if (h.closed) return
    h.closed = true
    for (const p of [...h.pieces]) p.finish('abandoned')   // a piece read after this fails: FileHandle refuses reads once closed
    retired.delete(h)
    st.closed++
    h.fh.close().catch((err: unknown) => warn(`[audio-load-hold] close failed for ${h.path}: ${err instanceof Error ? err.message : String(err)}`))
  }
  const retire = (h: Held): void => {
    h.retired = true
    if (h.active === 0) close(h)
    else retired.add(h)
  }
  const remember = (key: string, h: Held): void => {
    versions.delete(key)
    versions.set(key, { version: h.version, signature: h.signature })
    if (versions.size > 2000) versions.delete(versions.keys().next().value as string)
  }
  const install = (key: string, h: Held): void => {
    const old = holds.get(key)
    holds.set(key, h)
    if (old && old !== h) retire(old)
    remember(key, h)
  }

  const sweep = (): void => {
    const t = now()
    // Nobody has read the hold for idleMs: it closes, pieces "in flight" or not
    // (a dropped response never ends by itself).
    for (const [key, h] of holds) {
      if (t - h.lastUse >= idleMs) { holds.delete(key); close(h) }
    }
    for (const h of [...retired]) if (t - h.lastUse >= idleMs) close(h)
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
    let over = false
    const piece: Piece = {
      lastPull: now(),
      finish: (how) => {
        if (over) return
        over = true
        st[how]++
        h.pieces.delete(piece)
        h.active--
        if (h.retired && h.active === 0) close(h)
      },
    }
    h.pieces.add(piece)
    const stream = rangeStream(h.fh, start, end, piece, () => { piece.lastPull = h.lastUse = now() })
    return new Response(stream, {
      status: partial ? 206 : 200,
      headers: { ...base, 'Content-Length': String(end - start + 1), ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${h.size}` } : {}) },
    })
  }

  const openHold = async (path: string, source: string, headers: ServeHeaders): Promise<Held> => {
    const fh = await deps.open(path)
    try {
      const s = await fh.stat()
      const signature = await contentSignature(fh, s.size)
      st.opened++
      return { fh, path, source, size: s.size, version: fileVersion(s), signature, headers, pieces: new Set(), active: 0, lastUse: now(), retired: false, closed: false }
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
      if (was && was.version !== h.version) {
        if (was.signature !== h.signature) {
          close(h)
          st.refused++
          warn(`[audio-load-hold] ${path}: the file's bytes changed under a load (was ${was.version}, now ${h.version}); refused, the player reloads it`)
          return new Response('The file changed under this load', { status: 409 })
        }
        st.sameBytes++                                   // a new date on the same bytes: nothing to splice
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
    versionOf: (key) => versions.get(key)?.version ?? null,
    sweep,
    async closeAll() {
      for (const h of [...holds.values(), ...retired]) close(h)
      holds.clear()
    },
    stats: () => {
      const t = now()
      const pieces = [...holds.values(), ...retired].flatMap((h) => [...h.pieces])
      const reading = pieces.filter((p) => t - p.lastPull < pieceStaleMs).length
      return { open: [...holds.values()].filter((h) => !h.closed).length + retired.size, reading, stale: pieces.length - reading, ...st }
    },
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

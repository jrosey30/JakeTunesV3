/**
 * Guards for writes that edit library audio files in place.
 *
 * 2026-10-17: 44 songs imported Oct 10–11 stopped decoding. The cause was
 * tag write-back, not the import. mutagen (core/tag_writer.py) grows an
 * MP4's tags by shifting everything after them, which means the whole mdat
 * (tens of MB) when the file has no tag padding yet. A copied-in ALAC has
 * none, and since #52 every Bandcamp ALAC is copied in as-is. The
 * save-metadata-override hook starts one tag_writer.py per FIELD and does
 * not wait for it, so a multi-field save (albumArtist, genre, trackCount,
 * discNumber, discCount on a fresh album) ran five writers on one file at
 * once. Each shifted the audio by ~55 KB against a layout another writer
 * had already changed. Every writer exited 0, so nothing logged the damage.
 *
 * Two rules, enforced here:
 *  1. One writer per file at a time (withFileWriteLock).
 *  2. A writer edits a clone. The clone replaces the file only if it still
 *     decodes (writeVerified). A failed or killed write never touches the
 *     master.
 *
 * Leaf module: node built-ins only, so plain-Node tests can load it.
 */
import { spawn } from 'child_process'
import { constants as fsConstants } from 'fs'
import { copyFile, lstat, rename, rm } from 'fs/promises'
import { randomBytes } from 'crypto'
import { basename, dirname, extname, join, resolve } from 'path'

const chains = new Map<string, Promise<void>>()

/** Runs fn after every earlier job on the same file has settled. Jobs on
 *  different files still run in parallel. A rejected job does not block
 *  the next one. */
export function withFileWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(path)
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(fn)
  const tail = run.then(() => undefined, () => undefined)
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}

/** ok: true = decodes clean. ok: false = ffmpeg reported an error.
 *  ok: null = not checked (no ffmpeg, a container this does not check,
 *  or a timeout). A null never refuses anything. */
export type DecodeCheck =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: null; reason: string }

/** MP4 (ALAC/AAC) and FLAC decode silently at -v error when intact. MP3
 *  decoders log recoverable junk frames on healthy files, so MP3 is not
 *  checked. */
const CHECKED_EXT = /\.(m4a|mp4|m4b|alac|flac)$/i

/**
 * Apple's ALAC encoder (afconvert, our own Mac import step included)
 * sometimes ends a file with a flush frame that declares zero samples.
 * ffmpeg rejects it ("invalid samples per frame: 0") although it holds no
 * audio. 46 library files end in the same 8-byte frame (2026-10-17
 * sweep, tag-written or not), and Apple's decoder played every one tried
 * to the end.
 * One such frame and its follow-on line, and nothing else, is not
 * damage.
 */
export function onlyAlacFlushFrame(errorLines: string[]): boolean {
  if (errorLines.length === 0 || errorLines.length > 2) return false
  const zero = errorLines.filter((l) => /\binvalid samples per frame: 0$/.test(l)).length
  const follow = errorLines.filter((l) =>
    /(Decoding error|Error submitting packet to decoder): Invalid data found when processing input$/.test(l)).length
  return zero === 1 && zero + follow === errorLines.length
}

export async function decodeCheck(
  path: string,
  opts: { timeoutMs?: number; ffmpeg?: string } = {},
): Promise<DecodeCheck> {
  if (!CHECKED_EXT.test(path)) return { ok: null, reason: 'container not checked' }
  const timeoutMs = opts.timeoutMs ?? 120000
  return new Promise<DecodeCheck>((done) => {
    let settled = false
    const finish = (r: DecodeCheck): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(r)
    }
    const child = spawn(opts.ffmpeg ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-map', '0:a:0', '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4096) stderr += d.toString()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: null, reason: `decode check timed out after ${timeoutMs} ms` })
    }, timeoutMs)
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ ok: null, reason: err.code === 'ENOENT' ? 'ffmpeg is not on PATH' : err.message })
    })
    child.on('close', (code) => {
      const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
      if (code === 0 && (lines.length === 0 || onlyAlacFlushFrame(lines))) finish({ ok: true })
      else finish({ ok: false, error: lines[0] || `ffmpeg exit ${code}` })
    })
  })
}

export interface VerifiedWriteResult {
  ok: boolean
  error?: string
}

/**
 * Run `write` against an APFS clone of `path` (a plain copy where cloning
 * is unsupported), decode-check the clone, then rename it over `path`.
 * The original is untouched unless the edited file still decodes.
 *
 * Refuses symlinks: a streamed track is a symlink to a placeholder, and
 * a rename would replace the link with a regular file. Hardlinked files
 * are written in place (still under the caller's lock), since a rename
 * would split the link.
 */
export async function writeVerified(
  path: string,
  write: (target: string) => Promise<VerifiedWriteResult>,
  opts: { check?: (p: string) => Promise<DecodeCheck> } = {},
): Promise<VerifiedWriteResult> {
  const check = opts.check ?? decodeCheck
  const st = await lstat(path)
  if (st.isSymbolicLink()) return { ok: false, error: 'not a regular file (streamed placeholder); left as-is' }
  if (!st.isFile()) return { ok: false, error: 'not a regular file; left as-is' }
  if (st.nlink > 1) {
    const w = await write(path)
    if (!w.ok) return w
    const c = await check(path)
    if (c.ok === false) return { ok: false, error: `written in place (hardlinked) and it no longer decodes: ${c.error}` }
    return { ok: true }
  }

  const tmp = join(dirname(path), `.${basename(path)}.tagwrite-${randomBytes(4).toString('hex')}${extname(path)}`)
  await copyFile(path, tmp, fsConstants.COPYFILE_FICLONE)
  let swapped = false
  try {
    const w = await write(tmp)
    if (!w.ok) return w
    const c = await check(tmp)
    if (c.ok === false) return { ok: false, error: `the edited copy does not decode (${c.error}); original kept` }
    await rename(tmp, path)
    swapped = true
    return { ok: true }
  } finally {
    if (!swapped) {
      await rm(tmp, { force: true }).catch((err) => {
        console.warn(`[audio-write-guard] leftover ${tmp}:`, err instanceof Error ? err.message : err)
      })
    }
  }
}

/**
 * Where an import builds a file before publishing it at `dest`: a hidden
 * sibling in the same directory (so the final rename stays on one volume
 * and is atomic), ending in dest's own extension (encoders, the tag writer
 * and decodeCheck all key on it).
 *
 * 2026-10-18: the import encoded, tagged and faststarted straight onto the
 * final library path, and carriers copied it mid-write. Hop 1 of the
 * Mobile laptop→homemini sync took 12804 while mutagen was shifting its
 * mdat, and 11981/12339/12676 while the encode was still growing. Add-only
 * carriers keep their first copy forever. Readers of the final path must
 * see either the 0-byte reservation or the finished file, nothing between.
 * The dot keeps every music-leg rsync off it (they all exclude '.*').
 */
export function importWorkPath(dest: string): string {
  return join(dirname(dest), `.${basename(dest)}.importing-${randomBytes(4).toString('hex')}${extname(dest)}`)
}

/**
 * Import-side check: the file that landed in the library must decode.
 * If it does not, a source that does not decode either is refused
 * outright. Otherwise the copy/convert runs once more (`redo`), and a
 * second failure is refused. Null checks pass.
 */
export async function ensureLandedDecodes(
  src: string,
  dest: string,
  redo: () => Promise<void>,
  check: (p: string) => Promise<DecodeCheck> = decodeCheck,
): Promise<VerifiedWriteResult> {
  const first = await check(dest)
  if (first.ok !== false) return { ok: true }
  const source = await check(src)
  if (source.ok === false) return { ok: false, error: `source audio does not decode: ${source.error}` }
  console.warn(`[import] ${dest} did not decode (${first.error}); writing it again`)
  await redo()
  const second = await check(dest)
  if (second.ok === false) return { ok: false, error: `imported audio does not decode: ${second.error}` }
  return { ok: true }
}

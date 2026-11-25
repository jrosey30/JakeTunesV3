/**
 * The iTunesDB describes the file that is on the iPod (Brief 265 Part 3, 2026-11-24).
 *
 * fileSize (mhit 0x24) was already taken from the file on the card. sampleRate
 * (0x3C), bitrate (0x38) and duration (0x28) came from the library row, which
 * describes the MASTER: a 96 kHz ALAC master converted to 44.1 kHz AAC went on
 * stamped 96000 Hz and ~4600 kbps. Here all four come from the file that will
 * sit on the device (the master, its AAC/MP3 mirror, or its iPod-safe ALAC),
 * probed once and remembered by path + size + mtime, so an unchanged song is
 * never probed twice and an incremental sync stays cheap.
 *
 * Both sync engines call applyFileStamps on the same rows they hand to
 * core/db_reader.py --write; the writer packs what it is given (0x38 from
 * bitRate, 0x3C via sample_rate_for_itunesdb, 0x28 from duration).
 * ⚠️ TWIN: core/db_reader.py build_mhit_record (packs these fields);
 * src/main/ipod-reconcile.ts sampleRateForItunesDb (never 0).
 *
 * Nothing else about the DB changes: playlists, artwork, plays, ratings and
 * order are untouched. A file that can't be probed keeps the row's own values.
 */
import { execFile } from 'node:child_process'
import { readFile, rename, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { atBackgroundPriority } from './background-priority.ts'
import { sampleRateForItunesDb } from './ipod-reconcile.ts'

export interface FileStamps {
  sampleRate?: number
  /** kbps, rounded */
  bitrateKbps?: number
  durationMs?: number
}

/** `afinfo` text → stamps. Its duration honours iTunSMPB (gapless), which ffprobe's doesn't. */
export function parseAfinfo(text: string): FileStamps {
  const out: FileStamps = {}
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    let m = /^Data format:\s*\d+\s*ch,\s*(\d+)\s*Hz/i.exec(line)
    if (m && out.sampleRate === undefined) out.sampleRate = Number(m[1])
    m = /^estimated duration:\s*([\d.]+)\s*sec/i.exec(line)
    if (m) out.durationMs = Math.round(Number(m[1]) * 1000)
    m = /^bit rate:\s*(\d+)\s*bits per second/i.exec(line)
    if (m) out.bitrateKbps = Math.round(Number(m[1]) / 1000)
  }
  return clean(out)
}

/** `ffprobe -print_format json -show_format -show_streams -select_streams a:0` → stamps. */
export function parseFfprobeJson(text: string): FileStamps {
  let j: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }
  try { j = JSON.parse(text) } catch { return {} }
  const s = (j.streams && j.streams[0]) || {}
  const f = j.format || {}
  const bps = Number(s.bit_rate) || Number(f.bit_rate) || 0
  return clean({
    sampleRate: Number(s.sample_rate) || undefined,
    bitrateKbps: bps ? Math.round(bps / 1000) : undefined,
    durationMs: Number(f.duration) ? Math.round(Number(f.duration) * 1000) : undefined,
  })
}

function clean(s: FileStamps): FileStamps {
  const out: FileStamps = {}
  if (s.sampleRate && s.sampleRate >= 8000 && s.sampleRate <= 192000) out.sampleRate = s.sampleRate
  if (s.bitrateKbps && s.bitrateKbps > 0 && s.bitrateKbps < 100000) out.bitrateKbps = s.bitrateKbps
  if (s.durationMs && s.durationMs > 0) out.durationMs = s.durationMs
  return out
}

/**
 * The row's DB stamps with the file's facts laid over them. sampleRate never 0
 * (sampleRateForItunesDb); a fact the probe didn't give keeps the row's value.
 */
export function stampRowFromFile<T extends Record<string, unknown>>(row: T, file: FileStamps): T {
  const t = row as Record<string, unknown>
  t.sampleRate = sampleRateForItunesDb((file.sampleRate ?? t.sampleRate) as number | undefined)
  if (file.bitrateKbps) {
    t.bitRate = file.bitrateKbps
    if ('bitrate' in t) t.bitrate = file.bitrateKbps
  }
  if (file.durationMs) t.duration = file.durationMs
  return row
}

export type ProbeFile = (absPath: string) => Promise<FileStamps>

/** afinfo on macOS (gapless-exact duration), ffprobe elsewhere; background priority. */
export const probeFileStamps: ProbeFile = async (absPath) => {
  const execP = promisify(execFile)
  try {
    if (process.platform === 'darwin') {
      const [f, a] = atBackgroundPriority('afinfo', [absPath])
      const { stdout } = await execP(f, a, { timeout: 15000 })
      const s = parseAfinfo(stdout)
      if (s.sampleRate) return s
    }
    const [f, a] = atBackgroundPriority('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'a:0', absPath])
    const { stdout } = await execP(f, a, { timeout: 15000 })
    return parseFfprobeJson(stdout)
  } catch (err) {
    console.warn(`[ipod-stamps] could not probe ${absPath}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`)
    return {}
  }
}

/**
 * Remembers each file's stamps by path + size + mtime, on disk (one small JSON in
 * userData), so a re-sync of unchanged songs probes nothing.
 */
export function createFileStampCache(opts: { file: string; probe?: ProbeFile; maxEntries?: number }) {
  const probe = opts.probe ?? probeFileStamps
  const max = opts.maxEntries ?? 60000
  let map: Map<string, FileStamps> | null = null
  let dirty = false
  const load = async (): Promise<Map<string, FileStamps>> => {
    if (map) return map
    try {
      const raw = JSON.parse(await readFile(opts.file, 'utf-8')) as Record<string, FileStamps>
      map = new Map(Object.entries(raw))
    } catch { map = new Map() }
    return map
  }
  return {
    async stampsFor(absPath: string): Promise<FileStamps> {
      const st = await stat(absPath).catch(() => null)
      if (!st || !st.isFile()) return {}
      const key = `${absPath}|${st.size}|${Math.round(st.mtimeMs)}`
      const m = await load()
      const hit = m.get(key)
      if (hit) return hit
      // Remembered either way: a file that can't be probed is not asked again until it changes.
      const s = await probe(absPath)
      m.set(key, s)
      dirty = true
      while (m.size > max) m.delete(m.keys().next().value as string)
      return s
    },
    async flush(): Promise<void> {
      if (!dirty || !map) return
      try {
        await mkdir(dirname(opts.file), { recursive: true })
        const tmp = `${opts.file}.${process.pid}.tmp`
        await writeFile(tmp, JSON.stringify(Object.fromEntries(map)))
        await rename(tmp, opts.file)
        dirty = false
      } catch (err) {
        console.warn(`[ipod-stamps] could not save the stamp cache: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

export type FileStampCache = ReturnType<typeof createFileStampCache>

/**
 * Lay each row's file facts over it. `fileFor(row)` names the file whose bytes are on the
 * iPod: the local copy that was transferred when its size equals the card's (same bytes,
 * read locally and cheaply), else the card's own file. Returns how many rows changed.
 */
export async function applyFileStamps<T extends Record<string, unknown>>(
  rows: T[],
  fileFor: (row: T) => Promise<string | null | undefined> | string | null | undefined,
  cache: Pick<FileStampCache, 'stampsFor'>,
): Promise<number> {
  let changed = 0
  for (const row of rows) {
    const file = await fileFor(row)
    if (!file) continue
    const s = await cache.stampsFor(file)
    const before = `${row.sampleRate}|${row.bitRate}|${row.duration}`
    stampRowFromFile(row, s)
    if (`${row.sampleRate}|${row.bitRate}|${row.duration}` !== before) changed++
  }
  return changed
}

/**
 * Which file to probe for a row, or none:
 *   • the card's file is missing → none (the on-card gates name it);
 *   • the transferred local source is the same size as the card's file (the copy is byte for
 *     byte; confirmWriteOnCard checked the size): a converted mirror in the sync-convert
 *     cache is probed there, locally; the library master itself is NOT probed, because the
 *     row already describes it (so an ALAC Mini's sync probes nothing and stamps as before);
 *   • otherwise (no source, or a different size) → the card's own file.
 */
export async function fileToStamp(cardPath: string | undefined, localSource: string | undefined, convertCacheDir: string): Promise<string | undefined> {
  if (!cardPath) return undefined
  const card = await stat(cardPath).catch(() => null)
  if (!card) return undefined
  if (localSource) {
    const loc = await stat(localSource).catch(() => null)
    if (loc && loc.size === card.size) return isInside(localSource, convertCacheDir) ? localSource : undefined
  }
  return cardPath
}

function isInside(p: string, dir: string): boolean {
  const d = dir.endsWith('/') || dir.endsWith('\\') ? dir : dir + (dir.includes('\\') ? '\\' : '/')
  return !!dir && p.startsWith(d)
}

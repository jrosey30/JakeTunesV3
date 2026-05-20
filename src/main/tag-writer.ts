// Brief 020 — Write JakeTunes overrides into embedded file tags so Plex
// (and any other consumer reading file tags directly) sees the corrected
// metadata. Pairs with metadata-overrides.json — overrides remain the
// authoritative source; this module pushes them downstream into the files.
//
// Architecture: reuses the existing Python pipeline (core/tag_writer.py,
// mutagen) that already handles ALL JakeTunes' tag-writing (CD imports,
// reembed maintenance). Same spawn pattern as embedTags() in platform.ts.
// No new npm deps — music-metadata (already a dep) is used only for the
// pre-write sidecar backup.
//
// Sidecar backup: before the first overwrite of any audio file, the
// current tag set is serialized to <path>.original-tags.json next to
// the file. Subsequent writes skip the backup (sidecar already exists),
// so the FIRST original state is preserved no matter how many edits land.
// Makes overrides reversible without UI work.
//
// WRITABLE_FIELDS whitelist below is intentional: bpm/keyRoot/audioAnalysisAt/
// playCount/lastPlayedAt/skipCount/rating/camelotKey/keyMode are JakeTunes-
// internal and have no business in a Plex-readable tag.

import { join } from 'path'
import { stat, readFile, writeFile, access } from 'fs/promises'
import { spawn } from 'child_process'
import { app } from 'electron'
import { PYTHON_CMD, IS_WINDOWS } from './platform'

// Fields safe to propagate to embedded file tags. Anything not in this
// set is JakeTunes-internal (analysis results, listener stats, ratings)
// and must NOT touch the file — Plex, Navidrome, Airfoil don't care
// about those and writing them risks tag-corruption edge cases in
// mutagen's EasyMP4/EasyID3 strict mode.
export const WRITABLE_FIELDS = new Set([
  'title',
  'artist',
  'album',
  'albumArtist',
  'genre',
  'year',
  'trackNumber',
  'trackCount',
  'discNumber',
  'discCount',
])

export interface TagWriteRequest {
  // Absolute on-disk path to the audio file. Callers must resolve
  // colon-format library paths via the LOCAL_MOUNT + colon→slash dance
  // before calling — this module deals in absolute paths only.
  audioFilePath: string
  // Per-field overrides to push into the file. Keys outside
  // WRITABLE_FIELDS are silently filtered out (defense in depth — the
  // hook in save-metadata-override already gates by WRITABLE_FIELDS).
  overrides: Record<string, string | number>
}

export interface TagWriteResult {
  ok: boolean
  filePath: string
  fieldsWritten: string[]
  fieldsSkipped: string[]      // present in input but filtered (not in WRITABLE_FIELDS)
  sidecarBackup?: string       // path to the sidecar; absent if pre-existing
  error?: string
}

function filterWritable(overrides: Record<string, string | number>): {
  payload: Record<string, string | number>
  skipped: string[]
} {
  const payload: Record<string, string | number> = {}
  const skipped: string[] = []
  for (const [k, v] of Object.entries(overrides)) {
    if (WRITABLE_FIELDS.has(k)) {
      if (v === undefined || v === null || v === '') continue
      payload[k] = v
    } else {
      skipped.push(k)
    }
  }
  return { payload, skipped }
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

// Backup the current embedded tags to <path>.original-tags.json. Only
// runs if no sidecar yet — the FIRST original state is what matters,
// not the state after some intermediate edit. Returns the sidecar path
// when newly written, or undefined when one already existed.
async function backupOriginalTags(audioFilePath: string): Promise<string | undefined> {
  const sidecar = audioFilePath + '.original-tags.json'
  if (await fileExists(sidecar)) return undefined
  try {
    // music-metadata is already a dependency (used by the import path
    // and the artwork backfill). Dynamic import matches how the rest
    // of main/index.ts loads it.
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(audioFilePath, { duration: false, skipCovers: true })
    const c = metadata.common || {}
    const backup = {
      backupAt: new Date().toISOString(),
      fields: {
        title: c.title,
        artist: c.artist,
        album: c.album,
        albumArtist: c.albumartist,
        genre: Array.isArray(c.genre) ? c.genre.join('; ') : c.genre,
        year: c.year,
        trackNumber: c.track?.no ?? undefined,
        trackCount: c.track?.of ?? undefined,
        discNumber: c.disk?.no ?? undefined,
        discCount: c.disk?.of ?? undefined,
      },
    }
    await writeFile(sidecar, JSON.stringify(backup, null, 2))
    return sidecar
  } catch (err) {
    // Backup failure should NOT block the tag write — losing the
    // sidecar is a recoverability cost, not a correctness one. Log
    // and proceed.
    console.warn(`[tag-writer] sidecar backup failed for ${audioFilePath}:`, err instanceof Error ? err.message : err)
    return undefined
  }
}

// Spawn python3 core/tag_writer.py <path> and pipe the payload to stdin.
// Same pattern as embedTags() in platform.ts. ~30-80ms per file on local
// SSD (mutagen mostly).
function runPythonTagWriter(audioFilePath: string, payload: Record<string, string | number>): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const script = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/tag_writer.py')
    const py = spawn(PYTHON_CMD ?? 'python3', [script, audioFilePath])
    let stderr = ''
    py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    py.stdin.on('error', (err) => {
      // EPIPE on stdin if the python process dies before we finish
      // writing — same defense-in-depth as every other spawn site
      // since the 4.1.x EPIPE-Uncaught-Exception crash class.
      resolve({ ok: false, error: `stdin: ${err.message}` })
    })
    py.on('error', (err) => {
      resolve({ ok: false, error: `spawn: ${err.message}` })
    })
    py.on('close', (code) => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: stderr.trim() || `exit ${code}` })
    })
    try {
      py.stdin.write(JSON.stringify(payload))
      py.stdin.end()
    } catch (err) {
      resolve({ ok: false, error: `stdin-write: ${err instanceof Error ? err.message : String(err)}` })
    }
  })
}

export async function writeTagsToFile(req: TagWriteRequest): Promise<TagWriteResult> {
  const { audioFilePath, overrides } = req
  // Absolute-path sanity check. iPod colon-paths would silently fail
  // here ("file not found" deep in mutagen), so reject up front with a
  // clearer error.
  if (!audioFilePath || audioFilePath.startsWith(':')) {
    return {
      ok: false,
      filePath: audioFilePath,
      fieldsWritten: [],
      fieldsSkipped: [],
      error: 'audioFilePath must be absolute (got colon-format or empty)',
    }
  }
  try {
    await stat(audioFilePath)
  } catch {
    return {
      ok: false,
      filePath: audioFilePath,
      fieldsWritten: [],
      fieldsSkipped: [],
      error: 'file not found on disk',
    }
  }

  const { payload, skipped } = filterWritable(overrides)
  if (Object.keys(payload).length === 0) {
    return {
      ok: true,
      filePath: audioFilePath,
      fieldsWritten: [],
      fieldsSkipped: skipped,
    }
  }

  const sidecarBackup = await backupOriginalTags(audioFilePath)
  const writeResult = await runPythonTagWriter(audioFilePath, payload)
  return {
    ok: writeResult.ok,
    filePath: audioFilePath,
    fieldsWritten: writeResult.ok ? Object.keys(payload) : [],
    fieldsSkipped: skipped,
    sidecarBackup,
    error: writeResult.error,
  }
}

export interface BatchProgress {
  done: number
  total: number
  succeeded: number
  failed: number
  currentPath?: string
}

export interface BatchResult {
  total: number
  succeeded: number
  failed: number
  results: TagWriteResult[]
}

// Batched write. Chunks of N requests to keep the event loop responsive
// (each spawn is async but pinning ~50 concurrent python processes is
// still hostile to a Mac mini under load). N=8 is conservative — feels
// fast on local SSD without saturating I/O.
export async function writeTagsBatch(
  requests: TagWriteRequest[],
  onProgress?: (p: BatchProgress) => void,
): Promise<BatchResult> {
  const CONCURRENCY = 8
  const total = requests.length
  const results: TagWriteResult[] = []
  let succeeded = 0
  let failed = 0

  for (let i = 0; i < requests.length; i += CONCURRENCY) {
    const chunk = requests.slice(i, i + CONCURRENCY)
    const chunkResults = await Promise.all(chunk.map(req => writeTagsToFile(req)))
    for (let j = 0; j < chunkResults.length; j++) {
      const r = chunkResults[j]
      results.push(r)
      if (r.ok && r.fieldsWritten.length > 0) succeeded++
      else if (!r.ok) failed++
    }
    if (onProgress) {
      onProgress({
        done: Math.min(i + CONCURRENCY, total),
        total,
        succeeded,
        failed,
        currentPath: chunk[chunk.length - 1]?.audioFilePath,
      })
    }
  }

  return { total, succeeded, failed, results }
}

// Resolve a colon-format library path (":iPod_Control:Music:F13:GYUR.m4a")
// to an absolute on-disk path under the local mount.
//
// Matches the pattern used at src/main/index.ts:1961-1965 and elsewhere.
// Exposed so the batch builder (which doesn't have MUSIC_DIR in scope
// without an import) and the save-metadata-override hook can both use
// the same conversion.
export function colonPathToAbsolute(colonPath: string, musicDir: string): string {
  const localMount = musicDir.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  const pathSep = IS_WINDOWS ? '\\' : '/'
  const relPath = colonPath.replace(/:/g, pathSep)
  // Leading colon produces a leading sep — join handles that fine.
  return join(localMount, relPath)
}

// For pair-fields (trackNumber+trackCount, discNumber+discCount), tag_writer.py
// emits "N/M" format only when both are present. If a save-metadata-override
// hook fires for just one of the pair, we'd lose the other side of the
// "/" if we passed only the changed field. This helper merges the pair
// from the in-memory track record so writes preserve "5/13" semantics.
//
// Caller provides the `track` object (the library.json entry); we read
// the SIBLING field and add it to the payload when applicable.
export function augmentPairFields(
  field: string,
  value: string,
  track: Record<string, unknown> | null | undefined,
): Record<string, string | number> {
  const out: Record<string, string | number> = { [field]: value }
  if (!track) return out
  if (field === 'trackNumber' && track.trackCount) out.trackCount = String(track.trackCount)
  else if (field === 'trackCount' && track.trackNumber) out.trackNumber = String(track.trackNumber)
  else if (field === 'discNumber' && track.discCount) out.discCount = String(track.discCount)
  else if (field === 'discCount' && track.discNumber) out.discNumber = String(track.discNumber)
  return out
}

/**
 * Brief 265: remove the obsolete ffmpeg-made AAC mirrors from the sync-convert cache.
 * The one deletion Jake approved (2026-11-24); a separate, logged step, never run by the app.
 *
 *   node --experimental-strip-types scripts/remove-ffmpeg-aac-mirrors.ts           # dry run: lists, deletes nothing
 *   node --experimental-strip-types scripts/remove-ffmpeg-aac-mirrors.ts --apply   # deletes, one log line per file
 *
 * A file goes only if it is AAC in an .m4a with ffmpeg's encoder tag (isFfmpegAacMirror).
 * Every other cached copy (Apple AAC, iPod-safe ALAC, MP3) is left alone. Run it when no iPod is
 * syncing (nothing reads these files any more, but a sync could be writing next to them).
 * Log: <userData>/logs/remove-ffmpeg-aac-mirrors-<stamp>.jsonl
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SYNC_CONVERT_CACHE_SUBDIR, isFfmpegAacMirror } from '../src/main/sync-convert-cache.ts'

const execP = promisify(execFile)
const apply = process.argv.includes('--apply')
const userData = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const dir = join(userData, SYNC_CONVERT_CACHE_SUBDIR)

async function probe(path: string): Promise<{ codec: string; encoder: string }> {
  const { stdout } = await execP('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name:format_tags=encoder', '-of', 'json', path], { timeout: 15000 })
  const j = JSON.parse(stdout) as { streams?: Array<{ codec_name?: string }>; format?: { tags?: Record<string, string> } }
  const tags = Object.fromEntries(Object.entries(j.format?.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  return { codec: j.streams?.[0]?.codec_name ?? '', encoder: tags.encoder ?? '' }
}

const names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.m4a') && !n.includes('.partial.'))
const victims: Array<{ name: string; size: number; encoder: string }> = []
let kept = 0
for (const name of names) {
  const p = await probe(join(dir, name)).catch(() => null)
  if (p && isFfmpegAacMirror(name, p)) victims.push({ name, size: (await stat(join(dir, name))).size, encoder: p.encoder })
  else kept++
}
const bytes = victims.reduce((n, v) => n + v.size, 0)
console.log(`${names.length} .m4a in ${dir}: ${victims.length} ffmpeg-made AAC (${(bytes / 1e9).toFixed(2)} GB) to remove, ${kept} kept`)
if (!apply) { console.log('dry run: nothing deleted (add --apply)'); process.exit(0) }
await mkdir(join(userData, 'logs'), { recursive: true })
const log = join(userData, 'logs', `remove-ffmpeg-aac-mirrors-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
let removed = 0
let freed = 0
for (const v of victims) {
  try {
    await unlink(join(dir, v.name))
    removed++; freed += v.size
    await appendFile(log, JSON.stringify({ at: new Date().toISOString(), removed: join(dir, v.name), size: v.size, encoder: v.encoder }) + '\n')
  } catch (err) {
    await appendFile(log, JSON.stringify({ at: new Date().toISOString(), failed: join(dir, v.name), error: err instanceof Error ? err.message : String(err) }) + '\n')
  }
}
await appendFile(log, JSON.stringify({ at: new Date().toISOString(), summary: { removed, freedBytes: freed, kept } }) + '\n')
console.log(`removed ${removed} file(s), ${(freed / 1e9).toFixed(2)} GB freed; log ${log}`)

// READ-ONLY. Lists audio files on disk under the music library that are NOT
// referenced by library.json (orphans), enriched with tag metadata + file
// mtime, newest first. Used to scope data-loss recovery: the recent orphans
// are the user's lost imports; older orphans may be intentional deletions.
//
//   cd ~/JakeTunesV3 && node scripts/orphan-scan.mjs

import { readFileSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join, basename, extname } from 'path'
import { homedir } from 'os'
import * as mm from 'music-metadata'

const LIB = join(homedir(), 'Library/Application Support/JakeTunes/library.json')
const MUSIC = join(homedir(), 'Music2/JakeTunesLibrary/iPod_Control/Music')
const AUDIO = new Set(['.m4a', '.mp3', '.flac', '.aac', '.wav', '.alac', '.aiff', '.m4p', '.m4b'])

const lib = JSON.parse(readFileSync(LIB, 'utf8'))
const tracks = Array.isArray(lib.tracks) ? lib.tracks : []
// Match on basename — imported_NNNN.ext filenames are unique, so this is robust
// against any colon-path vs absolute-path formatting differences.
const indexed = new Set(tracks.map((t) => basename(String(t.path || '').replace(/:/g, '/'))))

async function walk(dir) {
  let out = []
  let ents = []
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out = out.concat(await walk(p))
    else if (AUDIO.has(extname(e.name).toLowerCase())) out.push(p)
  }
  return out
}

const files = await walk(MUSIC)
const orphans = files.filter((f) => !indexed.has(basename(f)))
console.log(`index: ${tracks.length} tracks | disk: ${files.length} audio files | orphans: ${orphans.length}\n`)

const rows = []
for (const f of orphans) {
  const s = await stat(f)
  let title = '', artist = '', album = ''
  try {
    const md = await mm.parseFile(f, { duration: false })
    title = md.common.title || ''; artist = md.common.artist || ''; album = md.common.album || ''
  } catch { /* unreadable tags — still list it */ }
  rows.push({ f, mtime: s.mtime, title, artist, album })
}
rows.sort((a, b) => b.mtime - a.mtime)

// histogram by day
const byDay = {}
for (const r of rows) { const d = r.mtime.toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + 1 }
console.log('=== orphans by day (file mtime) ===')
for (const d of Object.keys(byDay).sort().reverse()) console.log(`  ${d}: ${byDay[d]}`)

console.log('\n=== orphan list (newest first) ===')
for (const r of rows) {
  const meta = (r.artist || r.title) ? `${r.artist} — ${r.title}` : '(no tags)'
  console.log(`${r.mtime.toISOString().slice(0, 16).replace('T', ' ')}  ${basename(r.f).padEnd(24)} ${meta.slice(0, 62)}`)
}

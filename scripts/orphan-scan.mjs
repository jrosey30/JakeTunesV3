// READ-ONLY. Lists audio files on disk under the music library that are NOT
// referenced by library.json (orphans), enriched with tag metadata + file
// mtime, newest first.
//
//   cd ~/JakeTunesV3 && node scripts/orphan-scan.mjs

import { stat } from 'fs/promises'
import { basename } from 'path'
import * as mm from 'music-metadata'
import {
  resolveMusicDir,
  loadLibrary,
  walkAudioFiles,
  isOrphanFile,
} from './lib-orphan-shared.mjs'

const { musicDir, source } = resolveMusicDir()
const { tracks, indexed } = loadLibrary()

console.log(`music root: ${musicDir} (${source})`)

const files = await walkAudioFiles(musicDir)
const orphans = files.filter((f) => isOrphanFile(f, indexed).orphan)
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

const byDay = {}
for (const r of rows) { const d = r.mtime.toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + 1 }
console.log('=== orphans by day (file mtime) ===')
for (const d of Object.keys(byDay).sort().reverse()) console.log(`  ${d}: ${byDay[d]}`)

console.log('\n=== orphan list (newest first) ===')
for (const r of rows) {
  const meta = (r.artist || r.title) ? `${r.artist} — ${r.title}` : '(no tags)'
  console.log(`${r.mtime.toISOString().slice(0, 16).replace('T', ' ')}  ${basename(r.f).padEnd(24)} ${meta.slice(0, 62)}`)
}

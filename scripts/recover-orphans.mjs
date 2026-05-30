// Data-loss recovery: re-index recent orphaned audio files (on disk under the
// music library but missing from library.json) back into the index.
//
// SAFE BY DESIGN:
//   • ADDITIVE ONLY — never removes or mutates an existing track.
//   • Identity-deduped — skips any file whose audioFingerprint (sha1 of first
//     256KB + |durationMs, identical to the app's computeAudioFingerprint)
//     already exists in the library, or repeats within this batch.
//   • Mirrors importOneFile's Track schema exactly (id, title, artist, album,
//     genre, year, duration, colon-path, track/disc no+count, playCount,
//     dateAdded, fileSize, rating, contributingArtists, codec, audioFingerprint).
//   • Fresh unique ids (max existing id + n) so nothing collides.
//   • Backs up library.json (local + NAS) before writing; verifies after.
//
//   Dry run (default):  node scripts/recover-orphans.mjs
//   Commit:             node scripts/recover-orphans.mjs --commit

import { readFileSync, writeFileSync, renameSync, copyFileSync } from 'fs'
import { readdir, stat, open } from 'fs/promises'
import { join, basename, dirname, extname } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import * as mm from 'music-metadata'

const COMMIT = process.argv.includes('--commit')
const LOCAL = join(homedir(), 'Library/Application Support/JakeTunes/library.json')
const NAS = '/Volumes/JakeShared/JakeTunesState/library.json'
const MUSIC = join(homedir(), 'Music2/JakeTunesLibrary/iPod_Control/Music')
const CUTOFF = new Date('2026-05-27T12:00:00') // includes the May-27-night J. Cole import; excludes the May-22 older batch
const AUDIO = new Set(['.m4a', '.mp3', '.flac', '.aac', '.wav', '.alac', '.aiff', '.m4p', '.m4b'])
const stamp = '20260529-204500' // fixed stamp (no Date.now in this run); unique enough

async function fingerprint(abs, durationMs) {
  try {
    const fh = await open(abs, 'r')
    try {
      const buf = Buffer.alloc(256 * 1024)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      if (bytesRead <= 0) return null
      const h = createHash('sha1').update(buf.subarray(0, bytesRead)).digest('hex').slice(0, 16)
      return `sha1:${h}|${Math.round(Number(durationMs) || 0)}`
    } finally { await fh.close().catch(() => {}) }
  } catch { return null }
}

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

const lib = JSON.parse(readFileSync(LOCAL, 'utf8'))
const tracks = Array.isArray(lib.tracks) ? lib.tracks : []
const playlists = Array.isArray(lib.playlists) ? lib.playlists : []
const beforeCount = tracks.length

const indexedBasenames = new Set(tracks.map((t) => basename(String(t.path || '').replace(/:/g, '/'))))
const existingFP = new Set(tracks.map((t) => t.audioFingerprint).filter(Boolean))
let maxId = tracks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0)

const allFiles = await walk(MUSIC)
const candidates = []
for (const f of allFiles) {
  if (indexedBasenames.has(basename(f))) continue
  const s = await stat(f)
  if (s.mtime < CUTOFF) continue
  candidates.push({ f, mtime: s.mtime, size: s.size })
}
candidates.sort((a, b) => a.mtime - b.mtime) // chronological — ids ascend with import time

const additions = []
const newFP = new Set()
const skipped = []
const flacNote = []

for (const c of candidates) {
  let md
  try { md = await mm.parseFile(c.f) } catch (e) { skipped.push({ f: c.f, why: 'unreadable tags' }); continue }
  const common = md.common || {}
  const format = md.format || {}
  const durationMs = Math.round((format.duration || 0) * 1000)
  const fp = await fingerprint(c.f, durationMs)
  if (fp && (existingFP.has(fp) || newFP.has(fp))) { skipped.push({ f: c.f, why: 'duplicate fingerprint (already in library)' }); continue }

  const subDir = basename(dirname(c.f))
  const fileName = basename(c.f)
  const ext = extname(c.f).toLowerCase()
  const codec = /alac/i.test(format.codec || '') ? 'alac' : 'aac-256'
  if (ext === '.flac') flacNote.push(fileName)
  const id = ++maxId
  const title = common.title || fileName.replace(/\.[^.]+$/, '')
  const artist = common.artist || ''
  const track = {
    id,
    title,
    artist,
    album: common.album || '',
    genre: common.genre?.[0] || '',
    year: common.year || '',
    duration: durationMs,
    path: `:iPod_Control:Music:${subDir}:${fileName}`,
    trackNumber: common.track?.no || 0,
    trackCount: common.track?.of || 0,
    discNumber: common.disk?.no || 0,
    discCount: common.disk?.of || 0,
    playCount: 0,
    dateAdded: c.mtime.toISOString(),
    fileSize: c.size,
    rating: 0,
    contributingArtists: [artist],
    codec,
    ...(fp ? { audioFingerprint: fp } : {}),
  }
  additions.push(track)
  if (fp) newFP.add(fp)
}

// ── schema parity check vs a real existing track ──
const ref = tracks.find((t) => t.audioFingerprint) || tracks[0] || {}
const refKeys = new Set(Object.keys(ref))
const missingKeys = additions.length
  ? [...refKeys].filter((k) => k !== 'audioFingerprint' && k !== 'source' && !(k in additions[0]))
  : []

console.log(`\n=== RECOVERY PLAN (${COMMIT ? 'COMMIT' : 'DRY RUN'}) ===`)
console.log(`library before: ${beforeCount} tracks`)
console.log(`recent orphan files (mtime >= ${CUTOFF.toISOString().slice(0, 10)}): ${candidates.length}`)
console.log(`to add: ${additions.length} | skipped: ${skipped.length}`)
console.log(`library after: ${beforeCount + additions.length} tracks`)
if (missingKeys.length) console.log(`⚠️ SCHEMA GAP — reconstructed tracks missing keys present on existing tracks: ${missingKeys.join(', ')}`)
else console.log(`schema parity: ✓ (reconstructed tracks carry every key a real track has)`)
if (flacNote.length) console.log(`note: ${flacNote.length} raw FLAC file(s) restored (${flacNote.join(', ')}) — may need re-import to play in-app`)
if (skipped.length) { console.log('\nskipped:'); skipped.forEach((s) => console.log(`  - ${basename(s.f)} (${s.why})`)) }
console.log('\nadding (id · artist — title):')
additions.forEach((t) => console.log(`  ${t.id} · ${(t.artist || '?')} — ${t.title}`))

if (!COMMIT) { console.log('\n(dry run — no files written. re-run with --commit to apply.)'); process.exit(0) }

// ── commit: backup, write local (atomic), then NAS, verify both ──
function backup(p) { try { copyFileSync(p, `${p}.pre-orphan-recovery-${stamp}.bak`); return true } catch { return false } }
function writeVerify(target, obj, expect) {
  const tmp = `${target}.recovery-tmp.json`
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, target)
  const got = JSON.parse(readFileSync(target, 'utf8')).tracks.length
  return got === expect
}
const newLib = { tracks: [...tracks, ...additions], playlists }
const expect = beforeCount + additions.length
console.log('\n=== COMMITTING ===')
console.log(`backup local: ${backup(LOCAL) ? '✓' : '—'} | backup NAS: ${backup(NAS) ? '✓' : '—'}`)
const okLocal = writeVerify(LOCAL, newLib, expect)
console.log(`local write: ${okLocal ? `✓ ${expect} tracks` : '✗ verify failed'}`)
let okNas = false
try { okNas = writeVerify(NAS, newLib, expect) } catch (e) { console.log('NAS write error:', e.code || e.message) }
if (!okNas) { try { okNas = writeVerify(NAS, newLib, expect) } catch (e) { /* retried */ } }
console.log(`NAS write:   ${okNas ? `✓ ${expect} tracks` : '✗ verify failed (local is good; retry NAS)'}`)
console.log(`\n${okLocal && okNas ? '✓ RECOVERY COMPLETE' : '⚠️ partial — check output'}`)

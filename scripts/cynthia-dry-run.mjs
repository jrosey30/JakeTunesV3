#!/usr/bin/env node
// Cynthia overhaul — READ-ONLY dry run of the deterministic sweep layers
// over the real library. No writes, no model calls, no MusicBrainz
// network (local scanner only by default; pass --mb to include cached-MB
// diffs for albums already in mb-release-cache.json).
//
// This is the precision gate: eyeball the would-be findings/auto-applies
// for false positives BEFORE trusting the live sweep.
//
// Usage:  node scripts/cynthia-dry-run.mjs [--verbose] [--mb]
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const verbose = process.argv.includes('--verbose')
const withMb = process.argv.includes('--mb')

const { scanAlbum } = await import(join(__dirname, '../src/main/cynthia-scan.ts'))
const { diffAgainstMusicBrainz } = await import(join(__dirname, '../src/main/cynthia-mb-diff.ts'))
const { scanLibraryConsistency } = await import(join(__dirname, '../src/main/cynthia-library-scan.ts'))

const stateDir = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const lib = JSON.parse(readFileSync(join(stateDir, 'library.json'), 'utf8'))
const tracks = lib.tracks || []

const byAlbum = new Map()
for (const t of tracks) {
  const key = `${(t.albumArtist || t.artist || 'Unknown Artist').toLowerCase().trim()}|||${(t.album || 'Unknown').toLowerCase().trim()}`
  if (!byAlbum.has(key)) byAlbum.set(key, [])
  byAlbum.get(key).push(t)
}

let mbCache = {}
if (withMb) {
  const p = join(stateDir, 'mb-release-cache.json')
  if (existsSync(p)) mbCache = JSON.parse(readFileSync(p, 'utf8'))
}

const stats = {
  albums: 0,
  albumsWithFindings: 0,
  provable: 0,
  judgment: 0,
  flags: 0,
  mbDiffed: 0,
  byReason: new Map(),
}
const samples = { provable: [], judgment: [] }

for (const [key, albumTracks] of byAlbum) {
  stats.albums++
  const scan = scanAlbum(albumTracks)
  let findings = [...scan.findings]
  let flags = [...scan.flags]

  if (withMb) {
    const artist = String(albumTracks[0].albumArtist || albumTracks[0].artist || '')
    const album = String(albumTracks[0].album || '')
    const hit = mbCache[`${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`]
    if (hit) {
      try {
        const diff = diffAgainstMusicBrainz(albumTracks, JSON.parse(hit.raw), { artist, album })
        findings = [...findings, ...diff.findings]
        flags = [...flags, ...diff.flags]
        stats.mbDiffed++
      } catch { /* skip */ }
    }
  }

  if (findings.length > 0) stats.albumsWithFindings++
  stats.flags += flags.length
  for (const f of findings) {
    const bucket = f.reason.replace(/[0-9]+/g, 'N').replace(/'[^']*'/g, 'X')
    stats.byReason.set(bucket, (stats.byReason.get(bucket) || 0) + 1)
    if (f.provable) {
      stats.provable++
      if (samples.provable.length < 15) samples.provable.push({ album: key.split('|||')[1], field: f.field, old: f.oldValue, new: f.newValue, reason: f.reason })
    } else {
      stats.judgment++
      if (samples.judgment.length < 15) samples.judgment.push({ album: key.split('|||')[1], field: f.field, old: f.oldValue, new: f.newValue, reason: f.reason })
    }
  }
  if (verbose && findings.length > 0) {
    console.log(`\n── ${key}`)
    for (const f of findings) console.log(`  [${f.provable ? 'AUTO' : 'ask '}] ${f.field}: '${f.oldValue}' -> '${f.newValue}' (${f.reason})`)
  }
}

// Library-wide neat-freak pass (cross-album vocabulary).
const libFindings = scanLibraryConsistency(tracks)
const libStats = { provable: 0, judgment: 0, byField: new Map() }
const libSamples = []
for (const f of libFindings) {
  if (f.provable) libStats.provable++; else libStats.judgment++
  libStats.byField.set(f.field, (libStats.byField.get(f.field) || 0) + 1)
  if (libSamples.length < 20) libSamples.push({ field: f.field, old: f.oldValue, new: f.newValue, reason: f.reason, auto: f.provable })
}

console.log(JSON.stringify({
  albums: stats.albums,
  albumsWithFindings: stats.albumsWithFindings,
  wouldAutoApply: stats.provable,
  judgmentFindings: stats.judgment,
  observationFlags: stats.flags,
  mbDiffedAlbums: stats.mbDiffed,
  topReasons: [...stats.byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  libraryPass: {
    findings: libFindings.length,
    wouldAutoApply: libStats.provable,
    judgment: libStats.judgment,
    byField: [...libStats.byField.entries()],
  },
}, null, 1))
console.log('\nSAMPLE library-pass findings:')
for (const s2 of libSamples) console.log(` - [${s2.auto ? 'AUTO' : 'ask '}] ${s2.field}: '${s2.old}' -> '${s2.new}'  (${s2.reason})`)
console.log('\nSAMPLE would-auto-apply:')
for (const s of samples.provable) console.log(` - [${s.field}] '${s.old}' -> '${s.new}'  (${s.album}) ${s.reason}`)
console.log('\nSAMPLE judgment findings:')
for (const s of samples.judgment) console.log(` - [${s.field}] '${s.old}' -> '${s.new}'  (${s.album}) ${s.reason}`)

// READ-ONLY. Finds duplicate tracks (same artist + same exact title) in
// library.json and classifies them: how many are byte-identical (same
// audioFingerprint — safe to auto-dedupe), and how many involve a track the
// 2026-05-29 recovery added (ids 7972–8034) duplicating a pre-existing track.
//
//   cd ~/JakeTunesV3 && node scripts/dupe-scan.mjs

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LIB = join(homedir(), 'Library/Application Support/JakeTunes/library.json')
const tracks = (JSON.parse(readFileSync(LIB, 'utf8')).tracks) || []
const norm = (s) => (s || '').toString().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')
// recovery added ids 7972..8034 (63 tracks)
const RECOVERED = new Set(Array.from({ length: 63 }, (_, i) => 7972 + i))

const groups = new Map()
for (const t of tracks) {
  const k = norm(t.artist) + '|' + norm(t.title)
  if (k === '|') continue
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(t)
}

let dupGroups = 0, redundant = 0, recoveredDupes = 0, fpIdenticalGroups = 0, recoveryOnlyGroups = 0
const examples = []
for (const [, ts] of groups) {
  if (ts.length < 2) continue
  dupGroups++
  redundant += ts.length - 1
  const rec = ts.filter((t) => RECOVERED.has(Number(t.id)))
  const orig = ts.filter((t) => !RECOVERED.has(Number(t.id)))
  if (rec.length && orig.length) recoveredDupes += rec.length
  if (rec.length && !orig.length) recoveryOnlyGroups++ // dupes WITHIN the recovered batch
  const fps = new Set(ts.map((t) => t.audioFingerprint).filter(Boolean))
  const allHaveFp = ts.every((t) => t.audioFingerprint)
  if (allHaveFp && fps.size === 1) fpIdenticalGroups++
  if (examples.length < 30) {
    examples.push(`  ${ts.length}x  ${ts[0].artist} — ${ts[0].title}  [ids ${ts.map((t) => t.id).join(',')}]` +
      (rec.length && orig.length ? '  ⚠️ recovery dupe of existing' : rec.length && !orig.length ? '  (dupe within recovered batch)' : '') +
      (allHaveFp && fps.size === 1 ? '  «byte-identical»' : ''))
  }
}

console.log(`total tracks: ${tracks.length}`)
console.log(`duplicate groups (same artist + exact title): ${dupGroups}`)
console.log(`redundant copies overall: ${redundant}`)
console.log(`  ↳ recovered tracks duplicating a PRE-EXISTING track: ${recoveredDupes}`)
console.log(`  ↳ dupe groups existing only within the recovered batch: ${recoveryOnlyGroups}`)
console.log(`  ↳ groups that are BYTE-IDENTICAL (safe to auto-dedupe): ${fpIdenticalGroups}`)
console.log('\nexamples (up to 30):')
console.log(examples.join('\n'))

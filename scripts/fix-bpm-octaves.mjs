#!/usr/bin/env node
/**
 * BPM octave repair (LEGACY genre heuristic — prefer re-analysis).
 *
 * Prefer Music Man → "Re-measure tempos". That re-runs core/audio_analysis.py
 * with the onset-strength octave arbiter and writes fingerprint-gated
 * metadata-overrides.json — the same layer the app actually reads. This
 * script's genre half/double guess is a weaker offline cousin (⚠️ TWIN of the
 * arbiter in core/audio_analysis.py::_arbitrate_bpm_octave) and must not
 * invent a third truth.
 *
 * Historical context: the analyser used to fold every tempo into ~70–160.
 * Punk/hardcore sat at half; reggae mirrored. Genre ranges below catch the
 * unambiguous cases when you cannot re-decode audio.
 *
 * Usage:
 *   node scripts/fix-bpm-octaves.mjs            # dry run, prints the plan
 *   node scripts/fix-bpm-octaves.mjs --apply    # writes library.json
 *     (avoid --apply while the app is running; overrides are safer)
 */
import { readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LIB = process.env.JT_LIBRARY || join(homedir(), 'Library', 'Application Support', 'JakeTunes', 'library.json')
const APPLY = process.argv.includes('--apply')

// [regex, low, high]. Ranges are deliberately GENEROUS — the point is to catch
// unambiguous half/double errors, not to police tempo.
const FAMILIES = [
  [/drum.?(and|&|n).?bass|\bdnb\b|jungle/i, 155, 190],
  [/hardcore|grindcore|thrash|\bpunk\b|\bska\b/i, 145, 210],
  [/speed.?metal|black.?metal|death.?metal/i, 140, 220],
  [/reggae|\bdub\b|dancehall|roots/i, 58, 100],
  [/ambient|drone|new.?age/i, 40, 95],
  [/\bhouse\b|disco|garage/i, 108, 136],
  [/techno|trance|hardstyle/i, 120, 160],
  [/dubstep/i, 130, 150],
  [/bossa|samba/i, 90, 140],
  [/waltz|classical|baroque|chamber/i, 40, 160],
]

function familyFor(genre) {
  const g = String(genre || '')
  for (const [re, lo, hi] of FAMILIES) if (re.test(g)) return [lo, hi]
  return null
}

const raw = JSON.parse(readFileSync(LIB, 'utf8'))
const tracks = Array.isArray(raw) ? raw : raw.tracks
const changes = []

for (const t of tracks) {
  const bpm = Number(t.bpm) || 0
  if (bpm <= 0) continue
  const fam = familyFor(t.genre)
  if (!fam) continue
  const [lo, hi] = fam
  if (bpm >= lo && bpm <= hi) continue          // already plausible
  // 8% inset: a value that only just scrapes into the range is not evidence of
  // the true tempo, it's evidence the range is wide enough to catch anything.
  const pad = (hi - lo) * 0.08
  const inWell = (v) => v >= lo + pad && v <= hi - pad
  const dbl = bpm * 2
  const half = bpm / 2
  let next = null
  if (inWell(dbl)) next = dbl
  else if (inWell(half)) next = half
  if (next == null) continue                     // neither octave helps — leave it
  changes.push({ id: t.id, artist: t.artist, title: t.title, genre: t.genre, from: bpm, to: Math.round(next * 10) / 10 })
}

const byDir = { doubled: changes.filter(c => c.to > c.from).length, halved: changes.filter(c => c.to < c.from).length }
console.log(`  ${tracks.length} tracks · ${changes.length} would change (${byDir.doubled} doubled, ${byDir.halved} halved)`)
const byGenre = {}
for (const c of changes) {
  const k = String(c.genre).slice(0, 26)
  byGenre[k] = (byGenre[k] || 0) + 1
}
console.log('  by genre:')
for (const [g, n] of Object.entries(byGenre).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    ${String(n).padStart(5)} ${g}`)
}
console.log('  samples:')
for (const c of changes.slice(0, 8)) {
  console.log(`    ${String(c.from).padStart(6)} -> ${String(c.to).padStart(6)}   ${String(c.genre).slice(0, 18).padEnd(20)} ${String(c.artist).slice(0, 22)} — ${String(c.title).slice(0, 28)}`)
}

if (!APPLY) {
  console.log('\n  DRY RUN — nothing written. Re-run with --apply to write.')
  process.exit(0)
}

const map = new Map(changes.map(c => [c.id, c.to]))
for (const t of tracks) if (map.has(t.id)) t.bpm = map.get(t.id)
const bak = LIB + '.bak-bpm-' + Date.now()
copyFileSync(LIB, bak)
const tmp = LIB + '.tmp'
writeFileSync(tmp, JSON.stringify(raw))
// parse the temp file back before it replaces anything — a torn write must
// never become library.json
JSON.parse(readFileSync(tmp, 'utf8'))
renameSync(tmp, LIB)
console.log(`\n  APPLIED ${changes.length} corrections`)
console.log(`  backup: ${bak}`)

#!/usr/bin/env node
// mood_texts_reconstruct — 2026-08-14 nightly (READ-ONLY).
//
// Reconstructs the mood-index embed text for every track by extracting
// tempoEnergy() + moodText() FROM THE TRAINER SOURCE ITSELF (no hand-port,
// so reconstruction can't drift from the twin), then emits JSONL rows
//   { id, base, decade }
// where `decade` = base + "\nera: {YYY0}s" (grounded from library year).
// This feeds the P3 counterfactual (decade token in moodText — see
// REPORT-20260811). Writes only mood-texts.jsonl next to this script.
//
// Usage: node mood_texts_reconstruct.mjs <trainer.mjs> <state_dir>
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const [trainerPath, stateDir] = process.argv.slice(2)
if (!trainerPath || !stateDir) {
  console.error('usage: node mood_texts_reconstruct.mjs <brain-trainer.mjs> <state_dir>')
  process.exit(1)
}

const src = readFileSync(trainerPath, 'utf8')
function extract(name) {
  const m = src.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm'))
  if (!m) { console.error(`[fatal] function ${name} not found in ${trainerPath}`); process.exit(1) }
  return m[0]
}
const fns = new Function(`${extract('tempoEnergy')}\n${extract('moodText')}\nreturn { tempoEnergy, moodText }`)()

// 2026-08-27: the trainer applies metadata-overrides (laptop-authored bpm/key/
// genre) BEFORE embedding — fresh imports can carry bpm ONLY in the overrides
// (first seen: 10 Parcels tracks, teb=130 vs library bpm=null → 40/50 fidelity
// gate). Extract the trainer's own applyMetadataOverrides + its numeric-field
// set so the reconstruction sees the exact same track view. Same no-hand-port
// rule as moodText above.
const numMatch = src.match(/^const NUMERIC_OVERRIDE_FIELDS = new Set\(\[[\s\S]*?\]\)/m)
if (!numMatch) { console.error('[fatal] NUMERIC_OVERRIDE_FIELDS not found'); process.exit(1) }
const applyOverrides = new Function('OVERRIDES', 'existsSync', 'readFileSync', 'log',
  `${numMatch[0]}\n${extract('applyMetadataOverrides')}\nreturn applyMetadataOverrides`)

const lib = JSON.parse(readFileSync(join(stateDir, 'library.json'), 'utf8'))
const tracks = Array.isArray(lib) ? lib : lib.tracks
{
  const { existsSync } = await import('node:fs')
  applyOverrides(join(stateDir, 'metadata-overrides.json'), existsSync, readFileSync,
    (...a) => console.error('[overrides]', ...a))(tracks)
}
const desc = JSON.parse(readFileSync(join(stateDir, 'brain-descriptors.json'), 'utf8'))

const rows = []
let withDesc = 0, withEra = 0
for (const t of tracks) {
  const id = Number(t.id)
  if (!Number.isFinite(id)) continue
  const d = desc[String(t.id)]?.d
  const base = fns.moodText(t, d)
  if (!base) continue
  if (d) withDesc++
  const y = Number(t.year) || 0
  let decade = base
  if (y >= 1900 && y <= 2039) { decade = base + `\nera: ${Math.floor(y / 10) * 10}s`; withEra++ }
  rows.push({ id, base, decade })
}

const out = join(dirname(fileURLToPath(import.meta.url)), 'mood-texts.jsonl')
writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
console.log(`wrote ${rows.length} rows (${withDesc} with descriptor, ${withEra} with era line) -> ${out}`)

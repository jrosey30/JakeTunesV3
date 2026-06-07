// Verify the Taste Model against the real library.
//   node --experimental-strip-types scripts/taste-probe.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { computeTasteFingerprint, scoreCandidate } from '../src/main/taste-model.ts'

const lib = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/JakeTunes/library.json'), 'utf8'))
const fp = computeTasteFingerprint(lib.tracks || [])

console.log('SUMMARY:', fp.summary)
console.log('\nSPINES:')
fp.spines.forEach((s) => console.log(`  ${String(Math.round(s.weight * 100)).padStart(3)}%  ${s.name} (${s.tracks})`))
console.log('\nTOP GENRES (weight):')
fp.topGenres.slice(0, 8).forEach((g) => console.log(`  ${g.weight.toFixed(2)}  ${g.genre}`))
console.log('\nSAMPLE CANDIDATE SCORES (how the radar would rank new releases):')
const cands = [
  { artist: 'Overmono', genre: 'Electronic', year: 2023 },
  { artist: 'Wednesday', genre: 'Indie Rock', year: 2023 },
  { artist: 'JPEGMAFIA', genre: 'Hip-Hop', year: 2023 },
  { artist: 'Daft Punk', genre: 'House', year: 2013 },
  { artist: 'Yo-Yo Ma', genre: 'Classical', year: 2020 },
]
for (const c of cands) {
  const s = scoreCandidate(fp, c)
  console.log(`  ${s.score.toFixed(2)} ${s.owned ? '[OWNED] ' : ''}${c.artist} (${c.genre}, ${c.year}) — ${s.reasons.join('; ') || 'no taste signal'}`)
}

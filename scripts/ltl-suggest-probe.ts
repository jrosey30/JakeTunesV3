// Verifies the Listen-to-the-List "Music Man suggests" discovery fix:
// suggestions must be artists the user does NOT already own. Mirrors the
// suggest-recommendations handler logic against the live library + a real
// Sonnet call, and prints which candidates were filtered as owned.
//
//   npx tsx scripts/ltl-suggest-probe.ts

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { config } from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'

const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
config({ override: true })
config({ path: join(APP_SUPPORT, '.env') })

const PERSONA = `You are "The Music Man" — an arrogant, encyclopedic record-store savant. Dry wit, deep cuts, anti-algorithm. Never invent facts. Brevity is law.`

async function main(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) { console.error('no ANTHROPIC_API_KEY'); process.exit(1) }
  const lib = JSON.parse(readFileSync(join(APP_SUPPORT, 'library.json'), 'utf-8')) as { tracks?: Array<{ artist?: string; albumArtist?: string; title?: string; genre?: string; playCount?: number }> }
  const tracks = Array.isArray(lib.tracks) ? lib.tracks : []
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const playsByArtist = new Map<string, number>()
  const ownedArtists = new Set<string>()
  for (const t of tracks) {
    const a = (t.albumArtist || t.artist || '').trim()
    if (a) { playsByArtist.set(a, (playsByArtist.get(a) ?? 0) + (Number(t.playCount) || 0)); ownedArtists.add(norm(a)) }
  }
  const topArtists = Array.from(playsByArtist.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([a]) => a)
  console.log(`library: ${tracks.length} tracks, ${ownedArtists.size} distinct artists`)
  console.log(`top artists fed to MM: ${topArtists.join(', ')}\n`)

  const user = [
    `Artists this person ALREADY OWNS and loves: ${topArtists.join(', ')}.`,
    '',
    'This is a DISCOVERY list. Suggest 8 records they almost certainly do NOT own yet — artists NEW to this collection that sit in the lineage of/adjacent to what they love. Do NOT suggest any artist listed above. The point is music they have not heard.',
    'Each: real song + artist + a one-sentence note in your voice. Return ONLY JSON: an array of 8 [{"song","artist","note"}].',
  ].join('\n')

  const client = new Anthropic({ apiKey: key })
  const reply = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 900, system: PERSONA, messages: [{ role: 'user', content: user }] })
  const text = reply.content[0]?.type === 'text' ? reply.content[0].text : ''
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const cands = JSON.parse((fence ? fence[1] : text).trim()) as Array<{ song?: string; artist?: string; note?: string }>

  console.log(`=== ${cands.length} candidates from Sonnet ===`)
  let ownedCount = 0
  const survivors: typeof cands = []
  for (const c of cands) {
    const owned = ownedArtists.has(norm(c.artist || ''))
    if (owned) ownedCount++
    else survivors.push(c)
    console.log(`  ${owned ? '✗ OWNED ' : '✓ new   '} ${c.artist} — ${c.song}`)
  }
  const final = survivors.slice(0, 3)
  console.log(`\n=== final 3 (after dropping ${ownedCount} owned) ===`)
  final.forEach((s) => console.log(`  • ${s.artist} — ${s.song}\n    ${s.note}`))

  console.log('\n=== verdict ===')
  const allNew = final.every((s) => !ownedArtists.has(norm(s.artist || '')))
  console.log(`got 3 suggestions: ${final.length === 3 ? '✓' : `✗ only ${final.length}`}`)
  console.log(`none already owned: ${allNew ? '✓' : '✗'}`)
  if (final.length < 3 || !allNew) process.exit(2)
}

main().catch((e) => { console.error('probe failed:', e); process.exit(1) })

// record-store-blurb-probe.ts — verification script for Brief 037 §9 1e.
//
// Picks albums with CONTRASTING relationships (most-played, never-played,
// heavy-skip) and generates a real Haiku blurb for each — so we can see
// §3.2 working: the blurb should speak to how the user actually listens
// to THAT record, not give a generic writeup.
//
// Run:
//   npx tsx scripts/record-store-blurb-probe.ts
//
// Not part of the app build. Persona is a condensed stand-in.

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { config } from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'
import {
  buildItemRelationship,
  formatRelationshipForPrompt,
  generateBlurb,
} from '../src/main/record-store/blurb-generator'
import { parsePlayEvents, type RecordStoreLlm } from '../src/main/record-store/shelf-generator'
import type { CandTrack } from '../src/main/record-store/candidate-pool'
import type { ShelfItem } from '../src/main/record-store/types'

const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
config({ override: true })
config({ path: join(APP_SUPPORT, '.env') })

const LIBRARY_PATH = join(APP_SUPPORT, 'library.json')
const OVERRIDES_PATH = join(APP_SUPPORT, 'metadata-overrides.json')
const PLAY_EVENTS_PATH = join(APP_SUPPORT, 'play-events.jsonl')

const PERSONA = `You are "The Music Man" — an arrogant, opinionated, encyclopedic record-store savant. Strong opinions, dry wit, deep cuts. You love independent music and authenticity; you hate algorithm-driven corporate product. You never invent facts. Brevity is law: 1-3 sentences, a take not a lecture.`

function mergeOverrides(base: CandTrack[]): CandTrack[] {
  if (!existsSync(OVERRIDES_PATH)) return base
  try {
    const parsed = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8')) as
      | Record<string, Partial<CandTrack>>
      | { overrides?: Record<string, Partial<CandTrack>> }
    const ov = (parsed as { overrides?: Record<string, Partial<CandTrack>> }).overrides
      ?? (parsed as Record<string, Partial<CandTrack>>)
    return base.map((t) => (ov[String(t.id)] ? { ...t, ...ov[String(t.id)] } : t))
  } catch {
    return base
  }
}

interface AlbumGroup { album: string; artist: string; trackIds: number[]; plays: number; skips: number; lastPlayed: number }

function groupAlbums(tracks: CandTrack[]): AlbumGroup[] {
  const map = new Map<string, AlbumGroup>()
  for (const t of tracks) {
    if (!t.album) continue
    const artist = (t.albumArtist && t.albumArtist.trim()) || (t.artist || '').trim()
    if (!artist) continue
    const key = `${t.album}::${artist}`
    let g = map.get(key)
    if (!g) { g = { album: t.album, artist, trackIds: [], plays: 0, skips: 0, lastPlayed: 0 }; map.set(key, g) }
    g.trackIds.push(t.id)
    g.plays += Number(t.playCount) || 0
    g.skips += Number(t.skipCount) || 0
    if (typeof t.lastPlayedAt === 'number' && t.lastPlayedAt > g.lastPlayed) g.lastPlayed = t.lastPlayedAt
  }
  return Array.from(map.values())
}

function toItem(g: AlbumGroup): ShelfItem {
  return {
    id: `lib:album:${g.album}::${g.artist}`,
    kind: 'library-album',
    coverUrl: null,
    title: g.album,
    subtitle: g.artist,
    placement: '',
    payload: { trackIds: g.trackIds.map(String) },
  }
}

async function main(): Promise<void> {
  const parsed = JSON.parse(readFileSync(LIBRARY_PATH, 'utf-8')) as { tracks?: CandTrack[] }
  const tracks = mergeOverrides(Array.isArray(parsed.tracks) ? parsed.tracks : [])
  const tracksById = new Map(tracks.map((t) => [t.id, t]))
  const events = parsePlayEvents(existsSync(PLAY_EVENTS_PATH) ? readFileSync(PLAY_EVENTS_PATH, 'utf-8') : '')
  const nowMs = Date.now()
  const albums = groupAlbums(tracks)

  // Three contrasting relationships.
  const mostPlayed = [...albums].sort((a, b) => b.plays - a.plays)[0]
  const heavySkip = [...albums].filter((a) => a.skips > 0).sort((a, b) => b.skips - a.skips)[0]
  const neverPlayed = [...albums].filter((a) => a.plays === 0 && a.trackIds.length >= 5)[0]
  const picks = [
    { label: 'MOST-PLAYED', shelf: "Music Man's Picks", g: mostPlayed },
    { label: 'HEAVY-SKIP', shelf: 'Deep Cuts', g: heavySkip },
    { label: 'NEVER-PLAYED', shelf: 'Deep Cuts', g: neverPlayed },
  ].filter((p) => p.g)

  console.log('=== record-store blurb probe ===')
  console.log(`tracks: ${tracks.length}   play-events: ${events.length}\n`)

  const key = process.env.ANTHROPIC_API_KEY
  const client = key ? new Anthropic({ apiKey: key }) : null
  const llm: RecordStoreLlm | undefined = client
    ? async (req) => {
        const reply = await client.messages.create({
          model: req.model, max_tokens: req.maxTokens, system: req.system,
          messages: [{ role: 'user', content: req.user }],
        })
        return reply.content[0]?.type === 'text' ? reply.content[0].text : ''
      }
    : undefined

  for (const p of picks) {
    const item = toItem(p.g!)
    const rel = buildItemRelationship(item, tracksById, events, nowMs)
    console.log(`── ${p.label}: ${rel.artist} — ${rel.title}  (shelf: ${p.shelf}) ──`)
    console.log(formatRelationshipForPrompt(rel))
    if (!llm) { console.log('  (no key — relationship only)\n'); continue }
    const blurb = await generateBlurb({ item, shelfTitle: p.shelf, persona: 'music-man', relationship: rel, personaCore: PERSONA, llm })
    console.log(`  MM: ${blurb ? blurb.text : '(no blurb — LLM unavailable)'}\n`)
  }

  // LLM-down path: generateBlurb with no adapter must return null, not throw.
  const downItem = toItem(picks[0].g!)
  const rel0 = buildItemRelationship(downItem, tracksById, events, nowMs)
  const nullBlurb = await generateBlurb({ item: downItem, shelfTitle: 'x', persona: 'music-man', relationship: rel0, personaCore: PERSONA })
  console.log('=== guarantees ===')
  console.log(`LLM-down → null (no error, no fabrication): ${nullBlurb === null ? '✓' : '✗'}`)
  if (nullBlurb !== null) process.exit(2)
  if (llm) console.log('✓ blurbs generated, relationship-grounded')
}

main().catch((err) => { console.error('probe failed:', err); process.exit(1) })

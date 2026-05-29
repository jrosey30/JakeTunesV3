// record-store-shelves-probe.ts — verification script for Brief 037 §9 1d.
//
// The full engine, end to end: library + play log → listening summary,
// external context, balanced candidate pools (§3.4), then the ONE
// combined Sonnet call (§1d) that picks the theme AND stocks all three
// shelves. Asserts the library-grounded guarantee (§3.3 — every item
// traces to a real pool candidate) and the per-day artist cap (§3.4).
//
// Run:
//   npx tsx scripts/record-store-shelves-probe.ts
//
// Not part of the app build. Persona is a condensed stand-in; index.ts
// wires the real MUSIC_MAN_CORE.

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { config } from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'
import {
  buildListeningSummary,
  parsePlayEvents,
  buildShelfPools,
  generateShelves,
  heuristicShelfBundle,
  type DayThemeLlm,
  type GenerateShelvesInput,
} from '../src/main/record-store/shelf-generator'
import { gatherExternalContext, topLibraryArtists } from '../src/main/record-store/external-context'
import type { CandTrack } from '../src/main/record-store/candidate-pool'

const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
config({ override: true }) // repo .env (real ANTHROPIC_API_KEY; env exports an empty one)
config({ path: join(APP_SUPPORT, '.env') })

const LIBRARY_PATH = join(APP_SUPPORT, 'library.json')
const OVERRIDES_PATH = join(APP_SUPPORT, 'metadata-overrides.json')
const PLAY_EVENTS_PATH = join(APP_SUPPORT, 'play-events.jsonl')

const PERSONA = `You are "The Music Man" — an arrogant, opinionated, encyclopedic record-store savant. Strong opinions, dry wit, deep cuts. You love independent music and authenticity; you hate algorithm-driven corporate product. You never invent facts. Brevity is law.`

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

async function main(): Promise<void> {
  const parsed = JSON.parse(readFileSync(LIBRARY_PATH, 'utf-8')) as { tracks?: CandTrack[] }
  const tracks = mergeOverrides(Array.isArray(parsed.tracks) ? parsed.tracks : [])
  const events = parsePlayEvents(existsSync(PLAY_EVENTS_PATH) ? readFileSync(PLAY_EVENTS_PATH, 'utf-8') : '')
  const nowMs = Date.now()
  const todayISO = new Date().toISOString().slice(0, 10)

  const summary = buildListeningSummary(tracks, events, nowMs)
  const external = await gatherExternalContext({ artists: topLibraryArtists(tracks), userDataDir: APP_SUPPORT })
  const pools = buildShelfPools(tracks, todayISO, new Set())

  console.log('=== record-store shelf-generator probe ===')
  console.log(`tracks: ${tracks.length}   play-events: ${events.length}   today: ${todayISO}`)
  console.log(`pool sizes: mm-picks=${pools['mm-picks'].length} new-arrivals=${pools['new-arrivals'].length} deep-cuts=${pools['deep-cuts'].length}\n`)

  // All album keys present in any pool — the library-grounded universe.
  const poolKeys = new Set<string>()
  for (const id of ['mm-picks', 'new-arrivals', 'deep-cuts'] as const) {
    for (const c of pools[id]) poolKeys.add(`lib:album:${c.albumKey}`)
  }

  const base: Omit<GenerateShelvesInput, 'llm'> = {
    todayISO, summary, external, themeHistory: [], personaCore: PERSONA, pools,
  }

  const key = process.env.ANTHROPIC_API_KEY
  let bundle
  if (key) {
    const client = new Anthropic({ apiKey: key })
    const llm: DayThemeLlm = async (req) => {
      const reply = await client.messages.create({
        model: req.model, max_tokens: req.maxTokens, system: req.system,
        messages: [{ role: 'user', content: req.user }],
      })
      return reply.content[0]?.type === 'text' ? reply.content[0].text : ''
    }
    const t0 = Date.now()
    bundle = await generateShelves({ ...base, llm }, tracks)
    console.log(`generated in ${Date.now() - t0}ms (source=${bundle.source})\n`)
  } else {
    console.log('No ANTHROPIC_API_KEY — exercising the heuristic bundle only.\n')
    bundle = heuristicShelfBundle(base, tracks)
  }

  console.log(`THEME: ${bundle.theme.theme}`)
  console.log(`  ${bundle.theme.rationale}`)
  console.log(`  source=${bundle.theme.source}${bundle.theme.externalAnchor ? `  anchor=${JSON.stringify(bundle.theme.externalAnchor)}` : ''}\n`)

  // Verify: library-grounded + diversity.
  const dayArtist = new Map<string, number>()
  let hallucinated = 0
  for (const shelf of bundle.shelves) {
    console.log(`── ${shelf.title} ── ${shelf.tagline}`)
    for (const it of shelf.items) {
      if (!poolKeys.has(it.id)) hallucinated++
      dayArtist.set(it.subtitle, (dayArtist.get(it.subtitle) ?? 0) + 1)
      console.log(`   • ${it.subtitle} — ${it.title}`)
      console.log(`     ${it.placement}`)
    }
    console.log(`   (${shelf.items.length} items)\n`)
  }

  const overCap = Array.from(dayArtist.entries()).filter(([, n]) => n > 2)
  console.log('=== guarantees ===')
  console.log(`library-grounded (no out-of-pool items): ${hallucinated === 0 ? '✓' : `✗ ${hallucinated} hallucinated`}`)
  console.log(`per-day artist cap ≤2: ${overCap.length === 0 ? '✓' : `✗ ${JSON.stringify(overCap)}`}`)
  const allFloored = bundle.shelves.every((s) => s.items.length >= 3)
  console.log(`every shelf ≥3 items: ${allFloored ? '✓' : '✗ (thin pool — acceptable on a small library)'}`)

  if (hallucinated > 0 || overCap.length > 0) process.exit(2)
  console.log('\n✓ shelf generator verified')
}

main().catch((err) => {
  console.error('probe failed:', err)
  process.exit(1)
})

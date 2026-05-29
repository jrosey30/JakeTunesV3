// record-store-theme-probe.ts — verification script for Brief 037 §9 1c.
//
// Exercises the day-theme picker end-to-end against the live library,
// play-events log, and external feeds:
//   1. reads library.json + metadata-overrides.json + play-events.jsonl
//   2. builds the ListeningSummary (30d windowed plays, rediscover pool)
//   3. gathers ExternalContext (shows/releases/press/calendar)
//   4. calls pickDayTheme() with a REAL Sonnet adapter (if a key is in
//      the userData .env) and prints the theme + rationale + weighting
//   5. ALSO prints the heuristic fallback so the LLM-down path is
//      verifiable without a key
//
// Run:
//   npx tsx scripts/record-store-theme-probe.ts
//
// Not part of the app build. The persona here is a condensed stand-in;
// Phase 1d wires the real MUSIC_MAN_CORE from index.ts.

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { config } from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'
import {
  buildListeningSummary,
  parsePlayEvents,
  formatListeningSummaryForPrompt,
  heuristicDayTheme,
  pickDayTheme,
  type DayThemeLlm,
} from '../src/main/record-store/shelf-generator'
import { gatherExternalContext, topLibraryArtists } from '../src/main/record-store/external-context'
import type { CandTrack } from '../src/main/record-store/candidate-pool'

const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
// Repo .env has the real ANTHROPIC_API_KEY the app uses in dev. Use
// override:true — this environment exports an EMPTY ANTHROPIC_API_KEY,
// and dotenv's default (override:false) won't replace an already-set
// (even if empty) var. Then layer userData .env for any feed keys.
config({ override: true }) // ./.env at repo root
config({ path: join(APP_SUPPORT, '.env') })

const LIBRARY_PATH = join(APP_SUPPORT, 'library.json')
const OVERRIDES_PATH = join(APP_SUPPORT, 'metadata-overrides.json')
const PLAY_EVENTS_PATH = join(APP_SUPPORT, 'play-events.jsonl')

// Condensed Music Man — the real MUSIC_MAN_CORE is wired in Phase 1d.
const PERSONA = `You are "The Music Man" — an arrogant, opinionated, encyclopedic record-store savant. Strong opinions, dry wit, deep cuts. You love independent music and authenticity; you hate algorithm-driven corporate product. You never invent facts. Brevity is law: a take, not a lecture.`

if (!existsSync(LIBRARY_PATH)) {
  console.error(`library.json not found at ${LIBRARY_PATH}`)
  process.exit(1)
}

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

  console.log('=== record-store day-theme probe ===')
  console.log(`tracks: ${tracks.length}   play-events: ${events.length}   today: ${todayISO}\n`)

  const summary = buildListeningSummary(tracks, events, nowMs)
  console.log('── listening summary ──')
  console.log(formatListeningSummaryForPrompt(summary))
  console.log(`(30d total plays: ${summary.totalRecentPlays})\n`)

  const external = await gatherExternalContext({
    artists: topLibraryArtists(tracks),
    userDataDir: APP_SUPPORT,
  })

  // Heuristic path — always verifiable, no key needed.
  const heur = heuristicDayTheme(todayISO, summary, tracks)
  console.log('── heuristic fallback theme (LLM-down path) ──')
  console.log(`  theme:     ${heur.theme.theme}`)
  console.log(`  rationale: ${heur.theme.rationale}`)
  console.log(`  source:    ${heur.theme.source}   weighting: ${JSON.stringify(heur.weighting)}\n`)

  // Real LLM path — only if a key is present.
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    console.log('No ANTHROPIC_API_KEY — skipping the live Sonnet call. Heuristic above is the fallback the store would serve.')
    return
  }
  const client = new Anthropic({ apiKey: key })
  const llm: DayThemeLlm = async (req) => {
    const reply = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    })
    return reply.content[0]?.type === 'text' ? reply.content[0].text : ''
  }

  const t0 = Date.now()
  const result = await pickDayTheme(
    { todayISO, summary, external, themeHistory: [], personaCore: PERSONA, llm },
    tracks,
  )
  console.log(`── LIVE day-theme (Sonnet, ${Date.now() - t0}ms, source=${result.source}) ──`)
  console.log(`  theme:     ${result.theme.theme}`)
  console.log(`  rationale: ${result.theme.rationale}`)
  console.log(`  source:    ${result.theme.source}`)
  if (result.theme.externalAnchor) console.log(`  anchor:    ${JSON.stringify(result.theme.externalAnchor)}`)
  console.log(`  weighting: ${JSON.stringify(result.weighting)}`)
  if (result.source !== 'llm') {
    console.error('\n✗ expected an LLM theme but got heuristic — the Sonnet call or JSON parse failed (see warnings above)')
    process.exit(2)
  }
  console.log('\n✓ live day-theme picked, parsed, and validated')
}

main().catch((err) => {
  console.error('probe failed:', err)
  process.exit(1)
})

// record-store-integration-probe.ts — verification for the Phase-1
// IPC integration (Brief 037 §6). Drives resolveShelves / resolveBlurb
// — the exact code paths the get-shelves / get-blurb handlers call —
// with the same deps index.ts wires, against the real cache dir.
//
// Confirms: shelves generate (source llm), the bundle caches (2nd call
// is a cache hit), the theme lands in the cooldown history, and a blurb
// resolves + caches for a record actually on the wall.
//
// Run:
//   npx tsx scripts/record-store-integration-probe.ts
//
// NOTE: writes a real ShelfBundle for today into the user-data cache —
// same thing the app does on first-open-of-day.

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { config } from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'
import { RecordStoreCache } from '../src/main/record-store/cache'
import { resolveShelves, resolveBlurb, type RecordStoreDeps } from '../src/main/record-store'
import { parsePlayEvents } from '../src/main/record-store/shelf-generator'
import type { CandTrack } from '../src/main/record-store/candidate-pool'

const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
config({ override: true })
config({ path: join(APP_SUPPORT, '.env') })

const PERSONA = `You are "The Music Man" — an arrogant, opinionated, encyclopedic record-store savant. Strong opinions, dry wit, deep cuts. You love independent music; you hate algorithm-driven corporate product. You never invent facts. Brevity is law.`

async function main(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) { console.error('No ANTHROPIC_API_KEY — integration probe needs it for the live path.'); process.exit(1) }
  const client = new Anthropic({ apiKey: key })

  const deps: RecordStoreDeps = {
    userDataDir: APP_SUPPORT,
    getMainWindow: () => null,
    getTracks: async () => {
      const lib = JSON.parse(readFileSync(join(APP_SUPPORT, 'library.json'), 'utf-8')) as { tracks?: CandTrack[] }
      return Array.isArray(lib.tracks) ? lib.tracks : []
    },
    getPlayEvents: async () => {
      const p = join(APP_SUPPORT, 'play-events.jsonl')
      return parsePlayEvents(existsSync(p) ? readFileSync(p, 'utf-8') : '')
    },
    llm: async (req) => {
      const reply = await client.messages.create({
        model: req.model, max_tokens: req.maxTokens, system: req.system,
        messages: [{ role: 'user', content: req.user }],
      })
      return reply.content[0]?.type === 'text' ? reply.content[0].text : ''
    },
    personaCore: PERSONA,
  }

  const cache = new RecordStoreCache(APP_SUPPORT)
  const today = new Date().toISOString().slice(0, 10)
  const historyBefore = (await cache.getThemeHistory()).length

  console.log('=== record-store integration probe ===\n')

  // 1. Force-generate (mirrors first-open-of-day with a refresh).
  const t0 = Date.now()
  const bundle = await resolveShelves(cache, deps, { forceRefresh: true })
  console.log(`resolveShelves(force): ${Date.now() - t0}ms  source=${bundle.source}`)
  console.log(`  theme: ${bundle.theme.theme}`)
  for (const s of bundle.shelves) console.log(`  ${s.title}: ${s.items.length} items`)

  // 2. Second call (no force) must hit the cache.
  const t1 = Date.now()
  const cached = await resolveShelves(cache, deps)
  const cacheHit = Date.now() - t1 < 500 && cached.generatedAt === bundle.generatedAt
  console.log(`\nresolveShelves() again: ${Date.now() - t1}ms  cache-hit=${cacheHit}`)

  // 3. Theme history grew (cooldown bookkeeping) for an LLM bundle.
  const historyAfter = (await cache.getThemeHistory()).length
  const themeLogged = bundle.source !== 'llm' || historyAfter > historyBefore ||
    (await cache.getThemeHistory()).some((h) => h.date === today && h.theme === bundle.theme.theme)
  console.log(`theme logged to cooldown history: ${themeLogged}`)

  // 4. Blurb for a real item on the wall, then cached.
  const firstItem = bundle.shelves.flatMap((s) => s.items)[0]
  let blurbOk = true
  if (firstItem) {
    const b1 = await resolveBlurb(cache, deps, { itemId: firstItem.id, persona: 'music-man' })
    console.log(`\nblurb for ${firstItem.subtitle} — ${firstItem.title}:`)
    console.log(`  MM: ${b1 ? b1.text : '(null)'}`)
    const tc = Date.now()
    const b2 = await resolveBlurb(cache, deps, { itemId: firstItem.id, persona: 'music-man' })
    const blurbCacheHit = Date.now() - tc < 200 && b2?.text === b1?.text
    console.log(`  re-fetch cache-hit=${blurbCacheHit}`)
    blurbOk = !!b1 && blurbCacheHit
  }

  // 5. Unknown item id → null, not a throw.
  const unknown = await resolveBlurb(cache, deps, { itemId: 'lib:album:does::not-exist', persona: 'music-man' })

  console.log('\n=== guarantees ===')
  const checks: Array<[string, boolean]> = [
    ['shelves generated (source llm)', bundle.source === 'llm'],
    ['every shelf ≥3 items', bundle.shelves.every((s) => s.items.length >= 3)],
    ['second call cache-hit', cacheHit],
    ['theme logged to cooldown', themeLogged],
    ['blurb generated + cached', blurbOk],
    ['unknown item → null', unknown === null],
  ]
  let pass = true
  for (const [label, ok] of checks) { console.log(`  ${ok ? '✓' : '✗'} ${label}`); if (!ok) pass = false }
  if (!pass) process.exit(2)
  console.log('\n✓ Phase-1 IPC integration verified')
}

main().catch((err) => { console.error('probe failed:', err); process.exit(1) })

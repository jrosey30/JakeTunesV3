/**
 * 2026-10-10 model upgrade (Jake: "upgrade the models"): Sonnet 4.6 → 5.5,
 * Haiku 4.5 → 5.5, named in ONE place (src/common/ai-models.ts), and every
 * request made safe for the 5.x models by withModelPolicy:
 *   - `temperature` is refused outright (400 "deprecated for this model");
 *   - thinking is on by default and every call site reads content[0] with
 *     small budgets — measured: Sonnet 5.5 at max_tokens 60 returned only a
 *     thinking block. Sonnet says "off" as between_tools, Haiku as disabled.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_SMART, MODEL_FAST, KNOWN_MODELS, withModelPolicy } from '../../common/ai-models.ts'

describe('the model policy', () => {
  it('names the current models', () => {
    assert.equal(MODEL_SMART, 'claude-sonnet-5-5')
    assert.equal(MODEL_FAST, 'claude-haiku-5-5')
  })

  it('turns thinking off the way each model accepts', () => {
    assert.deepEqual((withModelPolicy({ model: MODEL_SMART, max_tokens: 300 }) as { thinking?: unknown }).thinking, { type: 'between_tools' })
    assert.deepEqual((withModelPolicy({ model: MODEL_FAST, max_tokens: 120 }) as { thinking?: unknown }).thinking, { type: 'disabled' })
  })

  it('every model it knows has a thinking-off rule (a new model cannot slip in thinking)', () => {
    for (const m of KNOWN_MODELS) {
      assert.ok((withModelPolicy({ model: m }) as { thinking?: unknown }).thinking, `${m} has no thinking-off rule`)
    }
  })

  it('drops temperature for the models that refuse it', () => {
    const out = withModelPolicy({ model: MODEL_SMART, max_tokens: 10, temperature: 1 }) as { temperature?: unknown }
    assert.equal('temperature' in out, false)
  })

  it('leaves a caller-chosen thinking setting and an unlisted model alone', () => {
    const chosen = { type: 'adaptive' }
    assert.equal((withModelPolicy({ model: MODEL_SMART, thinking: chosen }) as { thinking?: unknown }).thinking, chosen)
    const old = { model: 'claude-sonnet-4-6', temperature: 0.5 }
    assert.deepEqual(withModelPolicy(old), old)
  })

  it('does not mutate the caller\'s params', () => {
    const p = { model: MODEL_SMART, temperature: 1 }
    withModelPolicy(p)
    assert.equal(p.temperature, 1)
  })
})

describe('no hard-coded model names in the app', () => {
  // The one exemption: Activity Sync (src/main/workout-sync-ipc.ts) is not
  // touched by this upgrade — that code is off-limits to this author; it
  // stays on its model until its owner moves it.
  const EXEMPT = new Set(['main/workout-sync-ipc.ts', 'common/ai-models.ts'])
  const SRC = join(import.meta.dirname, '..', '..')
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === '__tests__' || name === 'node_modules') continue
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(name)) out.push(p)
    }
    return out
  }
  it('every Claude model is named through ai-models.ts', () => {
    const offenders: string[] = []
    for (const f of walk(SRC)) {
      const rel = f.slice(SRC.length + 1)
      if (EXEMPT.has(rel)) continue
      const hits = readFileSync(f, 'utf-8').match(/['"`]claude-(sonnet|haiku|opus)-[\w.-]+['"`]/g)
      if (hits) offenders.push(`${rel}: ${hits.join(', ')}`)
    }
    assert.deepEqual(offenders, [], 'name the model via MODEL_SMART / MODEL_FAST in src/common/ai-models.ts')
  })
})

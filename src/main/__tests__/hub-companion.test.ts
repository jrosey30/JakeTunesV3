/**
 * Companion header for hub requests. The token is a test stand-in
 * (`test-token`); the real value stays out of the repo.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPANION_HEADER,
  COMPANION_TOKEN_ENV,
  ensureCompanionTokenFromEnvFile,
  parseCompanionToken,
  readCompanionToken,
  withCompanionInit,
} from '../hub-companion.ts'
import { liveRecoHub } from '../reco-hub.ts'
import { refreshPhoneMirrors } from '../phone-mirrors.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const saved = process.env[COMPANION_TOKEN_ENV]

afterEach(() => {
  if (saved === undefined) delete process.env[COMPANION_TOKEN_ENV]
  else process.env[COMPANION_TOKEN_ENV] = saved
})

function headerOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get(COMPANION_HEADER)
}

describe('companion token', () => {
  it('uses the header name and env var from the vendored contracts', () => {
    const vendor = JSON.parse(readFileSync(join(repoRoot, 'vendor', 'jaketunes-contracts', 'contracts.json'), 'utf8')) as {
      companion: { header: string; env: string }
    }
    assert.equal(COMPANION_HEADER, vendor.companion.header)
    assert.equal(COMPANION_TOKEN_ENV, vendor.companion.env)
  })

  it('reads a userData .env line and does not replace a token already in the environment', () => {
    assert.equal(parseCompanionToken('OTHER=1\nMOBILE_API_TOKEN=test-token\n'), 'test-token')
    assert.equal(parseCompanionToken('export MOBILE_API_TOKEN="test-token"\n'), 'test-token')
    assert.equal(parseCompanionToken("MOBILE_API_TOKEN='test-token'\n"), 'test-token')
    assert.equal(parseCompanionToken('NO_TOKEN=1\n'), '')

    const env: NodeJS.ProcessEnv = {}
    ensureCompanionTokenFromEnvFile('MOBILE_API_TOKEN=test-token\n', env)
    assert.equal(env.MOBILE_API_TOKEN, 'test-token')
    ensureCompanionTokenFromEnvFile('MOBILE_API_TOKEN=other-token\n', env)
    assert.equal(env.MOBILE_API_TOKEN, 'test-token')
  })

  it('sends the header only when a token is configured, and never logs it', () => {
    const lines: string[] = []
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
    const prev = methods.map((m) => console[m])
    for (const m of methods) {
      console[m] = (...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      }
    }
    try {
      delete process.env[COMPANION_TOKEN_ENV]
      const bare = { headers: { accept: 'application/json' } }
      assert.equal(withCompanionInit(bare), bare)
      assert.equal(headerOf(bare), null)
      assert.equal(readCompanionToken(), '')

      process.env[COMPANION_TOKEN_ENV] = '   '
      assert.equal(withCompanionInit(bare), bare)

      process.env[COMPANION_TOKEN_ENV] = 'test-token'
      const sent = withCompanionInit({ headers: { accept: 'application/json' } })
      assert.equal(headerOf(sent), 'test-token')
      assert.equal(new Headers(sent?.headers).get('accept'), 'application/json')
      ensureCompanionTokenFromEnvFile('MOBILE_API_TOKEN=test-token\n')
    } finally {
      methods.forEach((m, i) => { console[m] = prev[i] })
    }
    assert.equal(lines.join('\n').includes('test-token'), false)
  })

  it('phone sidecar and recommendation calls carry the header, and omit it when unset', async () => {
    delete process.env[COMPANION_TOKEN_ENV]
    const seen: Array<string | null> = []
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen.push(headerOf(init))
      return { ok: true, status: 200, json: async () => ({ mtimeMs: 1, body: '{}' }) }
    }) as typeof fetch
    await refreshPhoneMirrors({
      files: ['mobile-imports.json'],
      localDir: '/tmp/does-not-matter-companion',
      nasDir: '/nonexistent',
      backendUrl: 'http://hub',
      nasAvailable: async () => false,
      fetchFn,
    })
    assert.deepEqual(seen, [null])

    process.env[COMPANION_TOKEN_ENV] = 'test-token'
    const calls: Array<{ url: string; header: string | null }> = []
    const hubFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, header: headerOf(init) })
      return { ok: true, status: 200, json: async () => [] }
    }) as unknown as Parameters<typeof liveRecoHub>[1]
    const hub = liveRecoHub('http://hub', hubFetch)
    await hub.list()
    await hub.add({ id: 'x' })
    assert.equal(calls.length, 2)
    assert.ok(calls.every((c) => c.header === 'test-token'))
    assert.ok(calls.every((c) => c.url.startsWith('http://hub/api/recommendations')))
  })
})

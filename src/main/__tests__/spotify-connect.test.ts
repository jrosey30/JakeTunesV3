/** Spotify connect (2026-08-28) — PKCE shapes, DW picking, and the whole
 *  loopback round-trip against a fake token endpoint. No Spotify needed. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp } from 'fs/promises'
import {
  pkcePair, b64url, authorizeUrl, tokenStale, pickDiscoverWeekly,
  connectSpotify, fetchDiscoverWeekly, loadAuth, saveAuth,
  SPOTIFY_REDIRECT_URI,
} from '../spotify-connect.ts'

describe('PKCE', () => {
  test('challenge is the S256 of the verifier, base64url', () => {
    const { verifier, challenge } = pkcePair()
    assert.equal(challenge, b64url(createHash('sha256').update(verifier).digest()))
    assert.ok(!/[+/=]/.test(challenge), 'must be base64url')
    assert.ok(verifier.length >= 43, 'RFC 7636 minimum')
  })

  test('authorize URL carries client id, S256, loopback redirect', () => {
    const u = new URL(authorizeUrl('client123', 'chal', 'st8'))
    assert.equal(u.searchParams.get('client_id'), 'client123')
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(u.searchParams.get('redirect_uri'), SPOTIFY_REDIRECT_URI)
    assert.equal(u.searchParams.get('state'), 'st8')
  })
})

describe('tokenStale', () => {
  test('missing token, missing expiry, or <60s left = stale', () => {
    assert.equal(tokenStale({}), true)
    assert.equal(tokenStale({ accessToken: 'x', expiresAt: Date.now() + 30_000 }), true)
    assert.equal(tokenStale({ accessToken: 'x', expiresAt: Date.now() + 3_600_000 }), false)
  })
})

describe('pickDiscoverWeekly', () => {
  test('exact name AND spotify-owned — a user playlist named the same never matches', () => {
    const items = [
      { name: 'Discover Weekly', id: 'fake', owner: { id: 'jake' } },
      { name: 'Discover Weekly', id: 'real', owner: { id: 'spotify' } },
    ]
    assert.equal(pickDiscoverWeekly(items), 'real')
    assert.equal(pickDiscoverWeekly([{ name: 'Release Radar', id: 'x', owner: { id: 'spotify' } }]), null)
  })
})

describe('connectSpotify — loopback round trip', () => {
  test('opens consent, catches the callback, exchanges the code, persists tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spot-'))
    const file = join(dir, 'spotify-auth.json')
    await saveAuth({ clientId: 'client123' }, file)

    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('accounts.spotify.com/api/token')) {
        const body = new URLSearchParams(String(init?.body))
        assert.equal(body.get('grant_type'), 'authorization_code')
        assert.equal(body.get('code'), 'CODE42')
        assert.ok(body.get('code_verifier'), 'verifier must travel')
        return { ok: true, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) }
      }
      return { ok: false, status: 404, text: async () => '' }
    }) as unknown as typeof fetch

    let consentUrl = ''
    const done = connectSpotify(file, (u) => { consentUrl = u }, fakeFetch, 10_000)
    // The "browser": wait for the listener, then hit the callback like Spotify would.
    await new Promise((r) => setTimeout(r, 150))
    const state = new URL(consentUrl).searchParams.get('state')
    await fetch(`${SPOTIFY_REDIRECT_URI}?code=CODE42&state=${state}`)
    const r = await done
    assert.equal(r.ok, true, r.error)
    const auth = await loadAuth(file)
    assert.equal(auth.accessToken, 'AT')
    assert.equal(auth.refreshToken, 'RT')
    assert.ok((auth.expiresAt ?? 0) > Date.now())
  })

  test('a wrong state is refused — no token exchange happens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spot-'))
    const file = join(dir, 'spotify-auth.json')
    await saveAuth({ clientId: 'client123' }, file)
    let exchanged = false
    const fakeFetch = (async () => { exchanged = true; return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
    const done = connectSpotify(file, () => {}, fakeFetch, 10_000)
    await new Promise((r) => setTimeout(r, 150))
    await fetch(`${SPOTIFY_REDIRECT_URI}?code=EVIL&state=WRONG`)
    const r = await done
    assert.equal(r.ok, false)
    assert.equal(exchanged, false)
  })
})

describe('fetchDiscoverWeekly', () => {
  test('walks playlist pages, maps tracks, refreshes a stale token first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spot-'))
    const file = join(dir, 'spotify-auth.json')
    await saveAuth({ clientId: 'c', refreshToken: 'RT', accessToken: 'OLD', expiresAt: 0 }, file)
    const fakeFetch = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      const u = String(url)
      if (u.includes('/api/token')) return { ok: true, json: async () => ({ access_token: 'FRESH', expires_in: 3600 }) }
      assert.equal(init?.headers?.Authorization, 'Bearer FRESH', 'must use the refreshed token')
      if (u.includes('/me/playlists')) {
        if (!u.includes('page2')) return { ok: true, json: async () => ({ items: [{ name: 'Not It', id: 'x', owner: { id: 'y' } }], next: 'https://api.spotify.com/v1/me/playlists?page2' }) }
        return { ok: true, json: async () => ({ items: [{ name: 'Discover Weekly', id: 'DW', owner: { id: 'spotify' } }], next: null }) }
      }
      if (u.includes('/playlists/DW/tracks')) {
        return { ok: true, json: async () => ({ items: [
          { track: { name: 'Song A', artists: [{ name: 'Artist A' }], album: { name: 'Album A' } } },
          { track: { name: '', artists: [{ name: 'X' }] } },
        ] }) }
      }
      return { ok: false }
    }) as unknown as typeof fetch
    const r = await fetchDiscoverWeekly(file, fakeFetch)
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(r.tracks, [{ song: 'Song A', artist: 'Artist A', album: 'Album A' }])
  })

  test('not connected = clean refusal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spot-'))
    const r = await fetchDiscoverWeekly(join(dir, 'nope.json'), (async () => ({ ok: false })) as unknown as typeof fetch)
    assert.equal(r.ok, false)
  })
})

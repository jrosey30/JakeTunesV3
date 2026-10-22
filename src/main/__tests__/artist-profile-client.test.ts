// Artist profile (2026-10-20) — the desktop's half of homemini's pre-built
// artist pages. The document parser (common/artist-profile.ts), the client
// and its cache (main/artist-profile-client.ts) against a fake homemini:
// first fetch + photos, the If-None-Match → 304 visit, the 404 fallback,
// homemini away (cache stands / nothing), junk replies, the throttle, and
// Jake's member-photo override. Plus the wiring: registered through a sibling,
// so main/index.ts did not grow.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  artistPhotoFileOf, parseArtistProfile, photoCacheSlug, profileCacheFile, memberPhotoPath, artistProfilePath, profilePhotoUrls,
} from '../../common/artist-profile.ts'
import { createArtistProfileClient, PROFILE_MIN_GAP_MS, type ProfileFetchLike } from '../artist-profile-client.ts'

const GEESE = {
  version: 1,
  name: 'Geese',
  mbid: 'e0c97a4d-c392-41a9-a374-57af3e3eeab3',
  kind: 'group',
  oneLiner: 'American rock band from New York City, formed in 2016.',
  origin: { place: 'Brooklyn, New York', since: '2016' },
  heroPhoto: 'geese',
  bio: { lede: 'Geese were still in high school…', body: 'Since then the four of them…', sources: [{ label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Geese_(band)' }], checkedAt: '2026-10-20T21:00:00Z' },
  facts: [{ label: 'Formed', value: '2016 · Brooklyn, New York' }, { label: 'Website', value: 'geeseband.com', url: 'https://geeseband.com/' }],
  members: {
    mode: 'current',
    people: [
      { name: 'Cameron Winter', roles: ['Lead vocals', 'guitar', 'keys'], libraryArtist: 'Cameron Winter', photo: { url: '/api/artist-photo/face-cameron.jpg', credit: 'Lygonstreet, Wikimedia Commons, CC BY-SA 4.0', source: 'commons', faceScore: 0.52 } },
      { name: 'Emily Green', roles: ['Guitar'], photo: { url: '/api/artist-photo/jake-emily.jpg', source: 'jake' } },
    ],
    photoCredit: 'Cameron Winter photo: Lygonstreet, Wikimedia Commons, CC BY-SA 4.0',
  },
  updatedAt: '2026-10-20T21:00:00Z',
}

describe('the profile document', () => {
  it('parses the contract and keeps every field the page draws', () => {
    const p = parseArtistProfile(GEESE)!
    assert.equal(p.name, 'Geese')
    assert.equal(p.kind, 'group')
    assert.deepEqual(p.origin, { place: 'Brooklyn, New York', since: '2016' })
    assert.equal(p.bio?.sources[0].label, 'Wikipedia')
    assert.equal(p.facts[1].url, 'https://geeseband.com/')
    assert.equal(p.members?.people.length, 2)
    assert.equal(p.members?.people[0].libraryArtist, 'Cameron Winter')
    assert.equal(p.members?.people[0].photo?.source, 'commons')
  })
  it('refuses what is not a profile (wrong version, HTML, arrays, no name)', () => {
    assert.equal(parseArtistProfile({ ...GEESE, version: 2 }), null)
    assert.equal(parseArtistProfile('<html>'), null)
    assert.equal(parseArtistProfile([GEESE]), null)
    assert.equal(parseArtistProfile({ ...GEESE, name: '  ' }), null)
  })
  it('drops bad parts one by one instead of sinking the page', () => {
    const p = parseArtistProfile({
      ...GEESE,
      facts: [{ label: 'Website', value: 'x', url: 'javascript:alert(1)' }, { label: '', value: 'y' }],
      members: { mode: 'current', people: [{ roles: ['Bass'] }, { name: 'Max Bassin', roles: ['Drums'], photo: { url: 'http://evil.example/x.jpg', source: 'jake' } }] },
      bio: { lede: 'L', body: 'B', sources: [{ label: 'W', url: 'file:///etc/passwd' }] },
    })!
    assert.deepEqual(p.facts, [{ label: 'Website', value: 'x' }], 'a non-http link is dropped, the fact kept')
    assert.equal(p.members?.people.length, 1, 'a member with no name is dropped')
    assert.equal(p.members?.people[0].photo, undefined, 'a photo that is not /api/artist-photo/ is dropped')
    assert.deepEqual(p.bio?.sources, [])
  })
  it('contract additions 10/20 (#490): origin.until, needsPhoto, a credited hero, deezer', () => {
    const p = parseArtistProfile({
      ...GEESE,
      name: 'Nirvana',
      origin: { place: 'Aberdeen, Washington', since: '1987', until: '1994' },
      hero: { url: '/api/artist-photo/1857f06283720e62.jpg', source: 'commons', credit: 'The Come Up Show, Wikimedia Commons, CC BY 2.0' },
      members: { mode: 'classic', era: '1991–1994', people: [
        { name: 'Kurt Cobain', roles: ['Lead vocals'], photo: { url: '/api/artist-photo/d7523d1e47db9d5b.jpg', source: 'deezer' } },
        { name: 'Brad Petering', roles: ['Lead vocals'], needsPhoto: true },
        { name: 'Someone', roles: [], photo: { url: '/api/artist-photo/0123456789abcdef.jpg', source: 'a-source-from-2027' } },
      ] },
    })!
    assert.deepEqual(p.origin, { place: 'Aberdeen, Washington', since: '1987', until: '1994' })
    assert.equal(p.hero?.credit, 'The Come Up Show, Wikimedia Commons, CC BY 2.0')
    assert.equal(p.members?.people[0].photo?.source, 'deezer')
    assert.equal(p.members?.people[1].needsPhoto, true)
    assert.equal(parseArtistProfile({ ...GEESE, heroNeedsPhoto: true })?.heroNeedsPhoto, true)
    assert.equal(parseArtistProfile({ ...GEESE, heroNeedsPhoto: 'yes' })?.heroNeedsPhoto, undefined, 'only a real true counts')
    assert.equal(p.members?.people[1].photo, undefined)
    assert.equal(p.members?.people[2].photo?.source, 'unknown', 'an unknown source keeps the photo')
    assert.deepEqual(profilePhotoUrls(p), ['/api/artist-photo/1857f06283720e62.jpg', '/api/artist-photo/d7523d1e47db9d5b.jpg', '/api/artist-photo/0123456789abcdef.jpg'])
    assert.equal(parseArtistProfile({ ...GEESE, hero: { url: 'http://elsewhere/x.jpg', source: 'commons' } })?.hero, undefined, 'a hero off the photo route is dropped')
    assert.deepEqual(profilePhotoUrls(parseArtistProfile({ ...GEESE, members: undefined, hero: { url: '/api/artist-photo/d1ed927a4829beaf.jpg', source: 'library' } })), ['/api/artist-photo/d1ed927a4829beaf.jpg'], 'a library hero is the app image re-framed for the wide header: its own file')
  })
  it('a photo url names a FILE — never a host or a path out of the folder', () => {
    assert.equal(artistPhotoFileOf('/api/artist-photo/face-cameron.jpg'), 'face-cameron.jpg')
    assert.equal(artistPhotoFileOf('http://homemini:3000/api/artist-photo/jake-max.jpg?v=2'), 'jake-max.jpg')
    assert.equal(artistPhotoFileOf('/api/artist-photo/..%2F..%2Fetc%2Fpasswd'), null)
    assert.equal(artistPhotoFileOf('/api/artist-photo/a/b.jpg'), null)
    assert.equal(artistPhotoFileOf('/elsewhere/x.jpg'), null)
  })
  it('photo slugs fit artist-image:// and never collide', () => {
    const a = photoCacheSlug('Jake_Emily.jpg'), b = photoCacheSlug('jake-emily.jpg')
    assert.match(a, /^ap-[a-z0-9-]+-[0-9a-f]{8}$/)
    assert.notEqual(a, b)
    assert.equal(photoCacheSlug('jake-emily.jpg'), b, 'stable')
  })
  it('route paths encode the names', () => {
    assert.equal(memberPhotoPath('Simon & Garfunkel', 'Art Garfunkel'), '/api/artist/Simon%20%26%20Garfunkel/members/Art%20Garfunkel/photo')
    assert.equal(artistProfilePath('Simon & Garfunkel'), '/api/artist/Simon%20%26%20Garfunkel/profile')
  })
})

// ── the client against a fake homemini ──

interface Hub {
  mode: 'up' | 'down' | 'missing' | 'garbage' | 'error'
  body: unknown
  etag: string
  postMode: 'ok' | 'missing' | 'down' | 'refused'
  calls: Array<{ method: string; url: string; ifNoneMatch: string | null; type: string | null; body?: unknown }>
}

function headerOf(init: Record<string, unknown> | undefined, name: string): string | null {
  const h = init?.headers as Headers | Record<string, string> | undefined
  if (!h) return null
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name)
  const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())
  return hit ? hit[1] : null
}

function fakeHub(hub: Hub): ProfileFetchLike {
  return async (url, init) => {
    const method = String(init?.method ?? 'GET')
    hub.calls.push({ method, url, ifNoneMatch: headerOf(init, 'If-None-Match'), type: headerOf(init, 'Content-Type'), body: init?.body })
    if (method === 'PUT') {
      if (hub.postMode === 'down') throw new Error('ECONNREFUSED')
      if (hub.postMode === 'missing') return { ok: false, status: 404, json: async () => ({}) }
      if (hub.postMode === 'refused') return { ok: false, status: 422, json: async () => ({ ok: false, error: 'no face found' }) }
      hub.etag = '"v2"'
      return { ok: true, status: 200, json: async () => ({ ok: true, photo: { url: '/api/artist-photo/0123456789abcdef.jpg', source: 'jake' } }) }
    }
    if (hub.mode === 'down') throw new Error('ECONNREFUSED')
    if (url.includes('/api/artist-photo/')) {
      return { ok: true, status: 200, json: async () => null, arrayBuffer: async () => new Uint8Array([255, 216, 255, 224]).buffer, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'image/jpeg' : null) } }
    }
    if (hub.mode === 'missing') return { ok: false, status: 404, json: async () => ({ error: 'not built' }) }
    if (hub.mode === 'error') return { ok: false, status: 503, json: async () => ({}) }
    if (hub.mode === 'garbage') return { ok: true, status: 200, json: async () => ({ hello: 'proxy page' }), headers: { get: () => null } }
    if (headerOf(init, 'If-None-Match') === hub.etag) return { ok: false, status: 304, json: async () => null }
    return { ok: true, status: 200, json: async () => hub.body, headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? hub.etag : null) } }
  }
}

describe('artist profile client', () => {
  let dir: string
  let hub: Hub
  let now: number
  const make = () => createArtistProfileClient({
    baseUrl: 'http://homemini:3000/',
    profileDir: join(dir, 'artist-profiles'),
    photoDir: join(dir, 'artist-images'),
    fetchImpl: fakeHub(hub),
    now: () => now,
    warn: () => {},
  })
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jt-artist-profile-'))
    hub = { mode: 'up', body: GEESE, etag: '"v1"', postMode: 'ok', calls: [] }
    now = Date.UTC(2026, 9, 20, 22)
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('nothing cached → read is "none" and touches no network', async () => {
    const c = make()
    const s = await c.read('Geese')
    assert.equal(s.source, 'none')
    assert.equal(s.profile, null)
    assert.equal(hub.calls.length, 0)
  })

  it('refresh fetches, caches, and saves every member photo once', async () => {
    const c = make()
    const s = await c.refresh('Geese')
    assert.equal(s.source, 'homemini')
    assert.equal(s.profile?.name, 'Geese')
    assert.equal(hub.calls[0].url, 'http://homemini:3000/api/artist/Geese/profile')
    assert.equal(Object.keys(s.photos).length, 2)
    assert.equal(s.photos['/api/artist-photo/face-cameron.jpg'], photoCacheSlug('face-cameron.jpg'))
    const saved = await readdir(join(dir, 'artist-images'))
    assert.deepEqual(saved.sort(), [`${photoCacheSlug('face-cameron.jpg')}.jpg`, `${photoCacheSlug('jake-emily.jpg')}.jpg`].sort())
    // A later visit: one conditional GET (304), no photo downloads.
    now += PROFILE_MIN_GAP_MS + 1
    hub.calls = []
    const again = await c.refresh('Geese')
    assert.equal(again.source, 'homemini')
    assert.deepEqual(hub.calls.map((x) => [x.method, x.ifNoneMatch]), [['GET', '"v1"']])
  })

  it('the credited hero photo is saved with the member photos', async () => {
    hub.body = { ...GEESE, hero: { url: '/api/artist-photo/1857f06283720e62.jpg', source: 'commons', credit: 'X, Wikimedia Commons, CC BY 2.0' } }
    const s = await make().refresh('Geese')
    assert.equal(s.photos['/api/artist-photo/1857f06283720e62.jpg'], photoCacheSlug('1857f06283720e62.jpg'))
    assert.equal(Object.keys(s.photos).length, 3)
  })

  it('a new client paints from the disk cache instantly', async () => {
    await make().refresh('Geese')
    hub.calls = []
    const s = await make().read('Geese')
    assert.equal(s.source, 'cache')
    assert.equal(s.profile?.oneLiner, GEESE.oneLiner)
    assert.equal(Object.keys(s.photos).length, 2)
    assert.equal(hub.calls.length, 0)
  })

  it('404 → "missing" (the Wikipedia fallback) and an old copy is dropped', async () => {
    const c = make()
    await c.refresh('Geese')
    hub.mode = 'missing'
    now += PROFILE_MIN_GAP_MS + 1
    const s = await c.refresh('Geese')
    assert.equal(s.source, 'missing')
    assert.equal(s.profile, null)
    assert.equal((await make().read('Geese')).source, 'missing')
  })

  it('homemini away or unwell → the cache stands; with nothing cached → "none"', async () => {
    await make().refresh('Geese')
    hub.mode = 'down'
    now += PROFILE_MIN_GAP_MS + 1
    const s = await make().refresh('Geese')
    assert.equal(s.source, 'cache')
    assert.equal(s.profile?.name, 'Geese')
    hub.mode = 'error'
    now += PROFILE_MIN_GAP_MS + 1
    assert.equal((await make().refresh('Geese')).profile?.name, 'Geese')
    const nothing = await make().refresh('Talking Heads')
    assert.equal(nothing.source, 'none')
    assert.equal(nothing.profile, null)
  })

  it('a reply that is not a profile never replaces a good copy', async () => {
    const c = make()
    await c.refresh('Geese')
    hub.mode = 'garbage'
    now += PROFILE_MIN_GAP_MS + 1
    const s = await c.refresh('Geese')
    assert.equal(s.profile?.name, 'Geese')
  })

  it('visits closer than the gap reuse the last answer; force asks again', async () => {
    const c = make()
    await c.refresh('Geese')
    hub.calls = []
    await c.refresh('Geese')
    assert.equal(hub.calls.length, 0)
    await c.refresh('Geese', { force: true })
    assert.equal(hub.calls.length, 1)
  })

  it('the cache file is per artist and names its artist', async () => {
    await make().refresh('Geese')
    const raw = JSON.parse(await readFile(join(dir, 'artist-profiles', profileCacheFile('Geese')), 'utf-8'))
    assert.equal(raw.name, 'Geese')
    assert.equal(raw.etag, '"v1"')
  })

  it("Jake's member photo: PUT as JPEG bytes to the member's route, then the profile is re-read", async () => {
    const c = make()
    await c.refresh('Geese')
    hub.calls = []
    const jpeg = new Uint8Array([255, 216, 255, 224, 1, 2])
    const r = await c.putMemberPhoto('Geese', 'Emily Green', jpeg)
    assert.equal(r.ok, true)
    const put = hub.calls.find((x) => x.method === 'PUT')!
    assert.equal(put.url, 'http://homemini:3000/api/artist/Geese/members/Emily%20Green/photo')
    assert.equal(put.type, 'image/jpeg')
    assert.equal(put.body, jpeg)
    assert.ok(hub.calls.some((x) => x.method === 'GET' && x.url.endsWith('/profile')), 'profile re-read after the PUT')
  })

  it('member photo failures come back as readable errors, never silently', async () => {
    const c = make()
    await c.refresh('Geese')
    for (const [mode, re] of [['missing', /does not take member photos yet/], ['down', /unreachable/], ['refused', /no face found/]] as const) {
      hub.postMode = mode
      const r = await c.putMemberPhoto('Geese', 'Emily Green', new Uint8Array([255, 216]))
      assert.equal(r.ok, false)
      assert.match((r as { error: string }).error, re)
    }
    const stranger = await c.putMemberPhoto('Geese', 'Not In The Band', new Uint8Array([255, 216]))
    assert.equal(stranger.ok, false)
  })
})

describe('WIRING — the artist page reads the profile through main, and index.ts did not grow', () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf-8')
  it('registered by its sibling on the artist page, not in index.ts', () => {
    assert.match(read('ipc/release-kinds-ipc.ts'), /registerArtistProfileIpc\(ipc\)/)
    assert.equal(/registerArtistProfileIpc/.test(read('index.ts')), false)
  })
  it('the page asks for the profile and falls back to the validated Wikipedia summary', () => {
    const view = readFileSync(join(import.meta.dirname, '../../renderer/views/ArtistDetailView.tsx'), 'utf-8')
    assert.match(view, /useArtistProfile\(lookupName\)/)
    assert.match(view, /getArtistWiki\(/)
    assert.match(view, /playsEverywhere\(/, 'plays count everywhere, like the rest of the app')
    assert.match(view, /topSongs\(/)
  })
})

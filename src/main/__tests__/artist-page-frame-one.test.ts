// The artist page's frame-1 rules (2026-11-10). Jake on the desktop artist
// page: "slow to appear, artist photos lag, look sloppy. not smooth". The page
// drew its first frame with no profile, no photo and no bio even when all
// three were on this Mac, then let each land on its own with no reserved
// space and no fade. These are the rules that replace that, each run here
// without a window: what is known is on the first frame, a slow or absent
// homemini never holds it, and what arrives later arrives without a swap.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  headerPick, heroLayers, bioPlan, shownProfileState, initialScroll, artistImageUrl, WIKI_GRACE_MS,
  type HeroLayer, type HeroEvent,
} from '../../renderer/artistPageModel.ts'
import { createArtistProfileStore, type ProfileApi } from '../../renderer/artistProfileStore.ts'
import { viewTransitionKey } from '../../renderer/keptView.ts'
import { emptyProfileState, parseArtistProfile, type ArtistProfile, type ArtistProfileState } from '../../common/artist-profile.ts'

const renderer = (...p: string[]): string => readFileSync(join(import.meta.dirname, '..', '..', 'renderer', ...p), 'utf-8')

const HERO_URL = '/api/artist-photo/hero.jpg'
const GEESE: ArtistProfile = parseArtistProfile({
  version: 1, name: 'Geese', kind: 'group', oneLiner: 'American rock band from New York City.',
  origin: { place: 'Brooklyn, New York', since: '2016' },
  heroPhoto: 'geese',
  hero: { url: HERO_URL, source: 'commons', credit: 'X, CC BY 2.0' },
  bio: { lede: 'Geese were still in high school…', body: 'Since then…', sources: [], checkedAt: '2026-10-20T21:00:00Z' },
  facts: [{ label: 'Formed', value: '2016' }],
  members: { mode: 'current', people: [{ name: 'Cameron Winter', roles: ['Vocals'], photo: { url: '/api/artist-photo/cam.jpg', source: 'commons' } }] },
  updatedAt: '2026-10-20T21:00:00Z',
})!
const cached = (photos: Record<string, string> = { [HERO_URL]: 'ap-hero-1', '/api/artist-photo/cam.jpg': 'ap-cam-2' }): ArtistProfileState =>
  ({ name: 'Geese', profile: GEESE, source: 'cache', photos, fetchedAt: 1 })

/** A main that never answers: homemini away, the 6 s / 15 s timeouts still running. */
const hangingApi = (): { api: ProfileApi; calls: string[] } => {
  const calls: string[] = []
  const never = new Promise<undefined>(() => {})
  return { calls, api: { artistProfileGet: (n) => { calls.push(`get:${n}`); return never }, artistProfileRefresh: (n) => { calls.push(`refresh:${n}`); return never } } }
}

describe('frame 1: the cached profile is known before the page asks for anything', () => {
  it('a cached profile is in hand synchronously, with homemini not answering at all', () => {
    const { api, calls } = hangingApi()
    const store = createArtistProfileStore(() => api, () => {})
    store.seed([cached()], true)
    const first = store.peek('Geese')                       // what the first render reads — no await anywhere
    assert.equal(first.cacheRead, true)
    assert.equal(first.state.profile?.bio?.lede, GEESE.bio!.lede)
    assert.equal(first.state.profile?.members?.people.length, 1)
    assert.equal(Object.keys(first.state.photos).length, 2, 'and which of its photos are on this Mac')
    void store.open('Geese')                                // the refresh behind it hangs
    assert.deepEqual(calls, ['refresh:Geese'], 'the cache is not asked for again — it is already here')
    assert.equal(store.peek('Geese'), first, 'and nothing on the page changes while homemini is silent')
  })

  it('names are matched however the page spells them', () => {
    const store = createArtistProfileStore(() => hangingApi().api, () => {})
    store.seed([cached()], true)
    assert.equal(store.peek('  geese ').state.profile?.name, 'Geese')
  })

  it('with the whole cache seeded, "not cached" is known on the first frame too', () => {
    const { api, calls } = hangingApi()
    const store = createArtistProfileStore(() => api, () => {})
    store.seed([cached()], true)
    const e = store.peek('Talking Heads')
    assert.equal(e.cacheRead, true)
    assert.equal(e.state.source, 'none')
    void store.open('Talking Heads')
    assert.deepEqual(calls, ['refresh:Talking Heads'], 'no disk round-trip to learn there is nothing')
  })

  it('before the seed lands (or when it was cut short) the page asks main, as it always did', async () => {
    let answer: (v: { ok: boolean; state?: ArtistProfileState }) => void = () => {}
    const calls: string[] = []
    const api: ProfileApi = {
      artistProfileGet: (n) => { calls.push(`get:${n}`); return new Promise((r) => { answer = r }) },
      artistProfileRefresh: (n) => { calls.push(`refresh:${n}`); return new Promise(() => {}) },
    }
    const store = createArtistProfileStore(() => api, () => {})
    store.seed([], false)
    assert.equal(store.peek('Geese').cacheRead, false)
    void store.open('Geese')
    assert.deepEqual(calls, ['get:Geese'])
    answer({ ok: true, state: cached() })
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(store.peek('Geese').state.profile?.name, 'Geese')
    assert.deepEqual(calls, ['get:Geese', 'refresh:Geese'])
  })

  it('the refresh, when it does answer, lands behind: listeners hear it, and a photo pushed by main fills in', async () => {
    let answer: (v: { ok: boolean; state?: ArtistProfileState }) => void = () => {}
    const api: ProfileApi = { artistProfileRefresh: () => new Promise((r) => { answer = r }) }
    const store = createArtistProfileStore(() => api, () => {})
    store.seed([cached({})], true)
    let heard = 0
    store.subscribe(() => { heard++ })
    const opened = store.open('Geese')
    assert.equal(store.peek('Geese').settled, false)
    answer({ ok: true, state: { ...cached({}), source: 'homemini' } })
    await opened
    assert.equal(store.peek('Geese').settled, true)
    assert.equal(store.peek('Geese').state.source, 'homemini')
    store.apply({ ...cached({ [HERO_URL]: 'ap-hero-1' }), source: 'homemini' })
    assert.equal(store.peek('Geese').state.photos[HERO_URL], 'ap-hero-1')
    assert.ok(heard >= 2)
    store.apply({ ...cached(), name: 'Somebody Else' })
    assert.equal(store.peek('Geese').state.photos[HERO_URL], 'ap-hero-1', "another artist's push never lands here")
  })

  it('a refresh that fails changes nothing but "settled" (the fallback may now show)', async () => {
    const api: ProfileApi = { artistProfileRefresh: async () => { throw new Error('ETIMEDOUT') } }
    const store = createArtistProfileStore(() => api, () => {})
    store.seed([], true)
    await store.open('Talking Heads')
    const e = store.peek('Talking Heads')
    assert.equal(e.settled, true)
    assert.equal(e.state.profile, null)
  })
})

describe('the header picture is decided from what is known, once', () => {
  const base = { profile: null, photos: {}, brokenHero: null, artistPhotoFailed: false, coverSrc: 'album-art://cover.jpg' }

  it('the cached credited header photo is the picture from the first frame', () => {
    const s = cached()
    const pick = headerPick({ ...base, profile: s.profile, photos: s.photos, artistSlug: undefined })
    assert.deepEqual(pick, { kind: 'hero', src: 'artist-image://ap-hero-1.jpg', url: HERO_URL, credit: 'X, CC BY 2.0' })
    // …and the artist-photo lookup answering later does not change it: no swap.
    assert.deepEqual(headerPick({ ...base, profile: s.profile, photos: s.photos, artistSlug: 'geese' }), pick)
  })

  it('a photo on disk is the picture from the first frame, and its lookup answering changes nothing', () => {
    const first = headerPick({ ...base, artistSlug: 'geese' })
    assert.deepEqual(first, { kind: 'artist', src: 'artist-image://geese.jpg', slug: 'geese' })
    assert.deepEqual(headerPick({ ...base, artistSlug: 'geese' }), first)
  })

  it('while the photo is not known the header is ink — never the record cover a photo would then replace', () => {
    assert.deepEqual(headerPick({ ...base, artistSlug: undefined }), { kind: 'none', pending: true })
  })

  it('the cover takes the slot only once the lookup has said there is no photo', () => {
    assert.deepEqual(headerPick({ ...base, artistSlug: null }), { kind: 'cover', src: 'album-art://cover.jpg' })
    assert.deepEqual(headerPick({ ...base, artistSlug: null, coverSrc: null }), { kind: 'none', pending: false })
  })

  it("the slug the cached profile names stands in while the lookup hasn't answered", () => {
    const p = { ...GEESE, hero: undefined }
    assert.deepEqual(headerPick({ ...base, profile: p, artistSlug: undefined }), { kind: 'artist', src: 'artist-image://geese.jpg', slug: 'geese' })
  })

  it('heroNeedsPhoto: the cover, never the artist image, known or not', () => {
    const p = { ...GEESE, hero: undefined, heroNeedsPhoto: true }
    for (const artistSlug of ['geese', null, undefined]) assert.equal(headerPick({ ...base, profile: p, artistSlug }).kind, 'cover')
  })

  it('a credited photo still downloading: the artist image meanwhile (it cross-fades when it lands)', () => {
    assert.equal(headerPick({ ...base, profile: GEESE, photos: {}, artistSlug: 'geese' }).kind, 'artist')
  })

  it('a picture that fails to draw steps down, never to a broken image', () => {
    const s = cached()
    assert.equal(headerPick({ ...base, profile: s.profile, photos: s.photos, brokenHero: HERO_URL, artistSlug: 'geese' }).kind, 'artist')
    assert.equal(headerPick({ ...base, artistSlug: 'geese', artistPhotoFailed: true }).kind, 'cover')
  })

  it('the tier a tile asks for is in the address', () => {
    assert.equal(artistImageUrl('ap-cam-2', 480), 'artist-image://ap-cam-2.jpg?s=480')
    assert.equal(artistImageUrl('geese'), 'artist-image://geese.jpg')
  })
})

describe('a later picture cross-fades in the same box', () => {
  const run = (events: HeroEvent[], from: readonly HeroLayer[] = []): Array<readonly HeroLayer[]> => {
    const states: Array<readonly HeroLayer[]> = []
    let s = from
    for (const e of events) { s = heroLayers(s, e); states.push(s) }
    return states
  }
  const visible = (s: readonly HeroLayer[]): string[] => s.filter((l) => l.phase === 'in').map((l) => l.src)
  const loaded = (src: string, instant = false): HeroEvent => ({ type: 'loaded', src, width: 1000, height: 1000, instant })

  it('the first picture is invisible until it has decoded, then shown — framed from its own size', () => {
    const [wanted, shown] = run([{ type: 'want', src: 'a' }, loaded('a')])
    assert.deepEqual(wanted, [{ src: 'a', phase: 'loading' }])
    assert.deepEqual(shown, [{ src: 'a', phase: 'in', natural: { width: 1000, height: 1000 }, instant: false }])
  })

  it('A → B: B loads above A; when it has decoded A fades out UNDER it; then A leaves', () => {
    const states = run([{ type: 'want', src: 'a' }, loaded('a'), { type: 'want', src: 'b' }, loaded('b'), { type: 'gone', src: 'a' }])
    assert.deepEqual(states[2].map((l) => `${l.src}:${l.phase}`), ['a:in', 'b:loading'], 'A stays up while B decodes: no blank between them')
    assert.deepEqual(states[3].map((l) => `${l.src}:${l.phase}`), ['a:out', 'b:in'], 'both in the box for the fade — never a hard swap')
    assert.deepEqual(states[4].map((l) => `${l.src}:${l.phase}`), ['b:in'])
  })

  it('there is never a moment with no picture between two pictures, and never two shown', () => {
    const states = run([{ type: 'want', src: 'a' }, loaded('a'), { type: 'want', src: 'b' }, { type: 'want', src: 'c' }, loaded('c'), { type: 'want', src: 'a' }, loaded('a'), { type: 'gone', src: 'c' }])
    for (const s of states.slice(1)) {
      assert.equal(visible(s).length, 1, JSON.stringify(s))
      for (const l of s) if (l.phase !== 'loading') assert.ok(l.natural, 'a picture is only ever visible with its size known (its framing never changes on screen)')
    }
    assert.deepEqual(states[3].map((l) => `${l.src}:${l.phase}`), ['a:in', 'c:loading'], 'a picture superseded before it decoded is dropped, not shown late')
  })

  it('asking again for the picture showing, or loading, changes nothing', () => {
    const s = run([{ type: 'want', src: 'a' }, loaded('a')]).at(-1)!
    assert.equal(heroLayers(s, { type: 'want', src: 'a' }), s)
    const l = heroLayers([], { type: 'want', src: 'a' })
    assert.equal(heroLayers(l, { type: 'want', src: 'a' }), l)
    assert.equal(heroLayers(s, loaded('zzz')), s, 'a load for a picture nobody wants is ignored')
  })

  it('back to the one showing while another decodes: the other is dropped', () => {
    const s = run([{ type: 'want', src: 'a' }, loaded('a'), { type: 'want', src: 'b' }, { type: 'want', src: 'a' }]).at(-1)!
    assert.deepEqual(s.map((l) => `${l.src}:${l.phase}`), ['a:in'])
  })

  it('a picture that fails leaves the one showing where it is; no picture wanted fades to ink', () => {
    const states = run([{ type: 'want', src: 'a' }, loaded('a'), { type: 'want', src: 'b' }, { type: 'failed', src: 'b' }, { type: 'want', src: null }])
    assert.deepEqual(states[3].map((l) => `${l.src}:${l.phase}`), ['a:in'])
    assert.deepEqual(states[4].map((l) => `${l.src}:${l.phase}`), ['a:out'])
  })

  it('the box is reserved: always rendered, in the page\'s ink, and the picture never changes its size', () => {
    const hero = renderer('components', 'artist', 'HeroPhoto.tsx')
    assert.match(hero, /<div className="ad-hero-photo" ref=\{boxRef\}>/, 'the box is not conditional on having a picture')
    assert.doesNotMatch(renderer('views', 'ArtistDetailView.tsx'), /\{heroSrc && \(/)
    const css = renderer('styles', 'artist-detail.css')
    assert.match(css, /\.ad-hero-photo \{[^}]*position: absolute;[^}]*width: 61%;[^}]*background: var\(--ad-ink\);/s)
    assert.match(css, /\.ad-hero-layer \{[^}]*position: absolute;[^}]*inset: 0;[^}]*opacity: 0;[^}]*transition: opacity var\(--ad-fade\)/s)
    assert.match(css, /\.ad-hero-layer\.is-in \{ opacity: 1; \}/)
  })
})

describe('one bio, never a bio and then another', () => {
  const plan = (o: Partial<Parameters<typeof bioPlan>[0]>) =>
    bioPlan({ hasProfile: false, cacheRead: true, source: 'none', settled: false, graceOver: false, wikiShownBefore: false, ...o })

  it('a cached profile: the Wikipedia summary is neither fetched nor shown', () => {
    assert.deepEqual(plan({ hasProfile: true, source: 'cache' }), { fetchWiki: false, showWiki: false })
  })
  it('nothing cached: fetched at once so it is ready, but held while homemini may still answer', () => {
    assert.deepEqual(plan({}), { fetchWiki: true, showWiki: false })
  })
  it('homemini answered with no profile (or failed): shown', () => {
    assert.equal(plan({ settled: true }).showWiki, true)
    assert.equal(plan({ source: 'missing' }).showWiki, true, 'a 404 cached from an earlier visit: shown from the first frame')
  })
  it('away from home: the 6 s timeout never holds the bio — it shows when the short grace is up', () => {
    assert.ok(WIKI_GRACE_MS <= 1000)
    assert.equal(plan({ graceOver: true }).showWiki, true)
  })
  it('the text that was on the page before is there again at once (Back does not re-fetch under a restored scroll)', () => {
    assert.equal(plan({ wikiShownBefore: true }).showWiki, true)
    const view = renderer('views', 'ArtistDetailView.tsx')
    assert.match(view, /const kept = wikiMemo\.get\(lookupName\)/)
    assert.match(view, /wikiMemo\.set\(name, \{ extract: r\.extract, pageUrl: r\.pageUrl \}\)/)
  })
  it('before the cache has been read nothing is planned', () => {
    assert.deepEqual(plan({ cacheRead: false, graceOver: true, settled: true }), { fetchWiki: false, showWiki: false })
  })
})

describe('what was painted stays painted: a newer bio waits for the next visit', () => {
  const top = { textPainted: false, scrolled: false }
  const none = emptyProfileState('Geese', 'none')
  const newer: ArtistProfileState = { ...cached(), profile: { ...GEESE, bio: { ...GEESE.bio!, lede: 'A rewritten lede.' } }, source: 'homemini' }

  it('photos of the same profile always apply (their tiles are reserved)', () => {
    const before = cached({})
    const after = { ...cached(), source: 'homemini' as const }
    assert.equal(shownProfileState(before, after, { textPainted: true, scrolled: true }), after)
  })
  it('a bio rewritten while the page is open does not replace the one being read', () => {
    const shown = cached()
    assert.equal(shownProfileState(shown, newer, top), shown)
    assert.equal(shownProfileState(shown, newer, { textPainted: true, scrolled: true }), shown)
  })
  it('a first profile arriving on an untouched page applies (nothing to yank yet)', () => {
    assert.equal(shownProfileState(none, newer, top), newer)
  })
  it('…but not once the Wikipedia text is on the page, or the reader has scrolled', () => {
    assert.equal(shownProfileState(none, newer, { textPainted: true, scrolled: false }), none)
    assert.equal(shownProfileState(none, newer, { textPainted: false, scrolled: true }), none)
  })
  it('a profile withdrawn (404) while its page is open stays for this visit', () => {
    const shown = cached()
    assert.equal(shownProfileState(shown, emptyProfileState('Geese', 'missing'), top), shown)
  })
  it('"none" → "missing" (still no profile) follows the newest: that is what lets the fallback show', () => {
    const missing = emptyProfileState('Geese', 'missing')
    assert.equal(shownProfileState(none, missing, { textPainted: true, scrolled: true }), missing)
  })
  it("another artist's state is never kept on the page", () => {
    const th = emptyProfileState('Talking Heads')
    assert.equal(shownProfileState(cached(), th, { textPainted: true, scrolled: true }), th)
  })
  it('the page draws through it, and Jake\'s own member photo shows at once', () => {
    const view = renderer('views', 'ArtistDetailView.tsx')
    assert.match(view, /const profileState = shownProfileState\(shownProfile, latestProfileState, \{/)
    assert.match(view, /const onMemberPhotoSet = useCallback\(\(st: typeof latestProfileState\) => \{ replaceProfile\(st\); setShownProfile\(st\) \}/)
    assert.match(view, /onPhotoSet=\{onMemberPhotoSet\}/)
  })
})

describe('scroll: arriving starts at the top, Back restores where you left', () => {
  it('the rule', () => {
    assert.equal(initialScroll('arrive', { top: 2400, left: 0 }), null, 'a click on an artist does not land where that artist was last left')
    assert.deepEqual(initialScroll('return', { top: 2400, left: 0 }), { top: 2400, left: 0 })
    assert.equal(initialScroll('return', undefined), null)
  })
  it('the page tells the scroll memory how it was reached, and an arrival forgets the old position', () => {
    assert.match(renderer('views', 'ArtistDetailView.tsx'), /useScrollPersistence\(`artist-detail:\$\{artist\}`, scrollRef, arrival\)/)
    const hook = renderer('hooks', 'useScrollPersistence.ts')
    assert.match(hook, /const saved = arrival === undefined \? remembered : \(initialScroll\(arrival, remembered\) \?\? undefined\)/)
    assert.match(hook, /if \(arrival === 'arrive' && remembered !== undefined\) \{\s+scrollCache\.delete\(key\)/, 'so the next Back lands where you left the page this time, not last week')
    const main = renderer('components', 'MainContent.tsx')
    assert.match(main, /<NavArrivalContext\.Provider value=\{arrival\}>\{viewElement\}<\/NavArrivalContext\.Provider>/)
  })
  it('every other page keeps restoring on every mount (the option is opt-in)', () => {
    for (const f of ['HomeView.tsx', 'AlbumsView.tsx']) {
      const m = /useScrollPersistence\(([^)]*)\)/.exec(renderer('views', f))
      if (m) assert.equal(m[1].split(',').length, 2, f)
    }
  })
})

describe('artist → artist is a new page', () => {
  it('the page is keyed by its artist, so the new artist mounts fresh: its own photo, the top, the entrance', () => {
    const a = viewTransitionKey('artist-detail', { activeArtist: 'Geese' })
    const b = viewTransitionKey('artist-detail', { activeArtist: 'Cameron Winter' })
    assert.notEqual(a, b)
    assert.equal(a, 'artist:Geese')
    assert.equal(viewTransitionKey('artist-detail', { activeArtist: 'Geese' }), a, 'the same artist is the same page')
  })
  it('the other keys are what they were', () => {
    assert.equal(viewTransitionKey('playlist', { activePlaylistId: 'p1' }), 'playlist:p1')
    assert.equal(viewTransitionKey('smart-playlist', { activeSmartPlaylist: 'top-1000' }), 'smart:top-1000')
    assert.equal(viewTransitionKey('album-detail', { albumKey: 'a|||b' }), 'album:a|||b')
    assert.equal(viewTransitionKey('songs', { activeArtist: 'Geese' }), 'songs')
  })
  it('MainContent keys its pages with it', () => {
    assert.match(renderer('components', 'MainContent.tsx'), /const transitionKey = viewTransitionKey\(view, \{/)
  })
})

describe('the entrance is one knob, 250 ms or less', () => {
  const css = renderer('styles', 'artist-detail.css')
  const ms = (name: string): number => {
    const m = new RegExp(`${name}:\\s*([0-9.]+)(ms|s)\\b`).exec(css)
    assert.ok(m, `${name} is set`)
    return Number(m![1]) * (m![2] === 's' ? 1000 : 1)
  }
  it('the whole entrance — the last block standing still — takes at most 250 ms', () => {
    const total = ms('--ad-enter-total')
    assert.ok(total > 0 && total <= 250, `--ad-enter-total is ${total} ms`)
    const rise = /\.ad-rise \{ animation: ad-rise calc\(var\(--ad-enter-total\) \* ([0-9.]+)\)/.exec(css)
    assert.ok(rise, 'the rise is a share of the knob')
    const delays = [...css.matchAll(/\.ad-d[1-6] \{ animation-delay: calc\(var\(--ad-enter-total\) \* ([0-9.]+)\); \}/g)].map((m) => Number(m[1]))
    assert.equal(delays.length, 6, 'every stagger step is a share of the knob')
    assert.ok(Number(rise![1]) + Math.max(...delays) <= 1.0001, 'the last block has finished when the knob is up')
  })
  it('nothing in the entrance is a number of its own any more', () => {
    assert.doesNotMatch(css, /\.ad-rise \{ animation: ad-rise 0\.\d+s/)
    assert.doesNotMatch(css, /\.ad-d[1-6] \{ animation-delay: 0\.\d+s; \}/)
  })
  it('reduced motion: no rise, no drift, and pictures appear without a fade', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    assert.match(reduced, /\.ad-drift, \.ad-rise,[^{]*\{ animation: none; \}/)
    assert.match(reduced, /\.ad-hero-layer, \.ad-member-img \{ transition: none; \}/)
  })
  it('Back still skips the entrance altogether', () => {
    assert.match(renderer('styles', 'main-content.css'), /\.main-content-view\[data-nav='return'\] :is\(\s*\.ad-rise,/)
  })
})

describe('member tiles: a fit size, a reserved box, a fade', () => {
  const tile = renderer('components', 'artist', 'MemberTile.tsx')
  const css = renderer('styles', 'artist-detail.css')
  it('the face is asked for at tile size, not as the 2160x2700 file', () => {
    assert.match(tile, /export const MEMBER_PHOTO_SIZE = 480/)
    assert.match(tile, /src=\{artistImageUrl\(photoSlug, MEMBER_PHOTO_SIZE\)\}/)
    assert.doesNotMatch(tile, /src=\{`artist-image:\/\/\$\{photoSlug\}\.jpg`\}/)
  })
  it('the box is a fixed square whether or not the photo is here', () => {
    assert.match(css, /\.ad-member-photo \{[^}]*aspect-ratio: 1;/s)
  })
  it('the photo fades in once decoded, and shows at once when it already was', () => {
    assert.match(css, /\.ad-member-img \{[^}]*opacity: 0;[^}]*transition: opacity var\(--ad-fade\)/)
    assert.match(css, /\.ad-member-img\.is-in \{ opacity: 1; \}/)
    assert.match(tile, /shownRef\.current = el\.complete && el\.naturalWidth > 0/)
    assert.match(tile, /onLoad=\{onImgLoad\}/)
  })
})

describe('nothing is drawn only to be replaced', () => {
  const view = renderer('views', 'ArtistDetailView.tsx')
  it('no "Looking up … on MusicBrainz" line under the covers: the list arriving is one move, not two', () => {
    assert.doesNotMatch(view, /Looking up the rest of/)
    assert.doesNotMatch(view, /ad-more--loading/)
  })
  it('the About placeholder waits out the bio\'s grace, so it is never the text a bio replaces', () => {
    assert.match(view, /useDelayedFlag\(aboutPending, WIKI_GRACE_MS \+ 400\)/)
  })
})

describe('WIRING: the first frame is drawn from memory', () => {
  const view = renderer('views', 'ArtistDetailView.tsx')
  it('the header photo starts from what a grid already looked up or what is on disk', () => {
    assert.match(view, /const \[photoEntry, setPhotoEntry\] = useState\(\(\) => seedPhoto\(lookupName\)\)/)
    assert.match(view, /const known = name \? knownArtistPhoto\(name\) : undefined/)
    assert.match(view, /sessionArtistImages\.set\(name, r\.slug\)/, 'and the answer is written back for the next page')
    const portrait = renderer('utils', 'artistPortrait.ts')
    assert.match(portrait, /if \(sessionArtistImages\.has\(name\)\) return sessionArtistImages\.get\(name\)\s+return diskArtistPhotos\.get\(name\)/)
  })
  it('main hands over the cached profiles and the photos on disk once, after the library loads', () => {
    const seed = renderer('artistPageSeed.ts')
    assert.match(seed, /artistProfileStore\.seed\(r\.states, r\.complete === true\)/)
    assert.match(seed, /diskArtistPhotos\.set\(name, slug\)/)
    assert.match(renderer('components', 'MainContent.tsx'), /prewarmArtistLibraryIndex\(state\.tracks, foldName, primeArtistPage\)/)
    const main = (p: string): string => readFileSync(join(import.meta.dirname, '..', p), 'utf-8')
    assert.match(main('ipc/artist-profile-ipc.ts'), /ipc\.handle\('artist-profile:all', async \(\) => \(\{ ok: true, \.\.\.\(await client\.readAll\(\)\) \}\)/)
    assert.match(main('ipc/artist-profile-ipc.ts'), /webContents\.send\('artist-profile:updated', state\)/)
    assert.match(main('index.ts'), /ipc\.handle\('artist-photos:known'/)
    const preload = readFileSync(join(import.meta.dirname, '..', '..', 'preload', 'index.ts'), 'utf-8')
    for (const ch of ['artist-profile:all', 'artist-photos:known', 'artist-profile:updated']) assert.ok(preload.includes(`'${ch}'`), ch)
  })
  it('the hook reads the store synchronously and refreshes behind it', () => {
    const hook = renderer('artistProfile.ts')
    assert.match(hook, /useSyncExternalStore\(artistProfileStore\.subscribe, \(\) => artistProfileStore\.peek\(name\)\)/)
    assert.match(hook, /void artistProfileStore\.open\(name\)/)
  })
})

/**
 * Origin sources beyond the strict album proof (Jake-approved 2026-10-18):
 * (A) the lone same-name MusicBrainz artist, (B) the Wikidata / Bandcamp
 * links ON a MusicBrainz artist that passed strict or (A). Every answer
 * carries its source so it can be audited and reverted. No network: the web
 * is a fake that records every URL.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lookupArtistOrigin, placeToCountry, bandcampLocation, wdBest, type OriginLookup } from '../origin-lookup.ts'
import { fillOrigins, originCacheKey, type FilerTrack, type FilerDeps, type OriginCache } from '../genre-filer.ts'
import { countryName } from '../artist-tags.ts'
import { normName } from '../taste-profile.ts'

type Artist = { id: string; name: string; score: number; country?: string; area?: { id?: string; name?: string }; aliases?: Array<{ name: string }> }
interface Web {
  artists?: Record<string, Artist[]>
  releaseGroups?: Array<{ title: string; credit: string; ids: string[] }>
  details?: Record<string, unknown>          // MBID → artist lookup body
  areas?: Record<string, unknown>            // area id → area lookup body
  entities?: Record<string, unknown>         // QID → { claims }
  claims?: Record<string, Record<string, unknown[]>>   // QID → prop → claims
  pages?: Record<string, string>             // url → html
  status?: (u: URL) => number | undefined
}
const unq = (s: string): string => s.replace(/\\(.)/g, '$1')
function web(w: Web) {
  const urls: string[] = []
  const fetchFn = (async (input: string) => {
    const url = String(input)
    urls.push(url)
    const u = new URL(url)
    const st = w.status?.(u)
    if (st) return new Response('x', { status: st })
    const q = u.searchParams.get('query') ?? ''
    if (u.host === 'musicbrainz.org') {
      if (u.pathname === '/ws/2/artist') return Response.json({ artists: w.artists?.[unq(q.match(/^artist:"((?:[^"\\]|\\.)*)"/)![1])] ?? [] })
      if (u.pathname === '/ws/2/release-group') {
        const m = q.match(/^releasegroup:"((?:[^"\\]|\\.)*)" AND artist:"((?:[^"\\]|\\.)*)"$/)!
        const hits = (w.releaseGroups ?? []).filter((r) => normName(r.title).includes(normName(unq(m[1]))) && normName(r.credit).includes(normName(unq(m[2]))))
        return Response.json({ 'release-groups': hits.map((r) => ({ title: r.title, 'artist-credit': r.ids.map((id) => ({ artist: { id } })) })) })
      }
      const a = u.pathname.match(/^\/ws\/2\/artist\/([^/]+)$/)
      if (a) return w.details?.[a[1]] ? Response.json(w.details[a[1]]) : new Response('nf', { status: 404 })
      const ar = u.pathname.match(/^\/ws\/2\/area\/([^/]+)$/)
      if (ar) return w.areas?.[ar[1]] ? Response.json(w.areas[ar[1]]) : new Response('nf', { status: 404 })
    }
    if (u.host === 'www.wikidata.org') {
      const e = u.pathname.match(/^\/wiki\/Special:EntityData\/(Q\d+)\.json$/)
      if (e) return w.entities?.[e[1]] ? Response.json({ entities: { [e[1]]: w.entities[e[1]] } }) : new Response('nf', { status: 404 })
      if (u.pathname === '/w/api.php' && u.searchParams.get('action') === 'wbgetclaims') {
        const qid = u.searchParams.get('entity')!, prop = u.searchParams.get('property')!
        return Response.json({ claims: { [prop]: w.claims?.[qid]?.[prop] ?? [] } })
      }
    }
    if (w.pages?.[url] !== undefined) return new Response(w.pages[url], { status: 200 })
    return new Response('nf', { status: 404 })
  }) as unknown as typeof fetch
  return { urls, net: { throttle: async () => {}, userAgent: 'test', fetchFn } }
}
const item = (id: string, rank = 'normal') => ({ mainsnak: { snaktype: 'value', datavalue: { value: { id } } }, rank })
const str = (v: string, rank = 'normal') => ({ mainsnak: { snaktype: 'value', datavalue: { value: v } }, rank })
const COUNTRY_CODES = { Q30: { P297: [str('US')] }, Q16: { P297: [str('CA')] }, Q145: { P297: [str('GB')] }, Q183: { P297: [str('DE')] }, Q55: { P297: [str('NL')] }, Q8646: { P297: [str('HK')] } }
const asFound = (r: OriginLookup) => (r.kind === 'found' ? { origin: r.origin, source: r.source, via: r.via } : r.kind)

describe('(A) the lone same-name match', () => {
  const dvtr: Artist = { id: 'dvtr', name: 'DVTR', score: 100, area: { id: 'mtl', name: 'Montréal' } }
  const montreal = {
    details: { dvtr: { id: 'dvtr', area: { id: 'mtl', name: 'Montréal' } } },
    areas: { mtl: { id: 'mtl', name: 'Montréal', relations: [{ type: 'part of', direction: 'backward', area: { id: 'qc', name: 'Quebec', 'iso-3166-2-codes': ['CA-QC'] } }] } },
  }

  it('DVTR: the only MusicBrainz artist of that name, in Montréal → Canada (area walked up to Quebec, CA-QC)', async () => {
    const w = web({ artists: { DVTR: [dvtr] }, ...montreal })
    assert.deepEqual(asFound(await lookupArtistOrigin('DVTR', ['BONJOUR (BIS)'], w.net)), { origin: 'Canada', source: 'mb-lone-name', via: undefined })
  })

  it('Scarlet Rose: refused — two artists share the name (Germany vs Netherlands), even though one has a country', async () => {
    const w = web({
      artists: { 'Scarlet Rose': [{ id: 'sr-de', name: 'Scarlet Rose', score: 100 }, { id: 'sr-nl', name: 'Scarlet Rose', score: 98, country: 'NL', area: { name: 'Netherlands' } }] },
      details: { 'sr-nl': { relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q1' } }] } },
    })
    const r = await lookupArtistOrigin('Scarlet Rose', ['Pangea'], w.net)
    assert.equal(r.kind, 'unknown')
    assert.match(r.kind === 'unknown' ? r.note : '', /2 artists named "Scarlet Rose"/)
    assert.ok(!w.urls.some((u) => u.includes('/ws/2/artist/') || u.includes('wikidata')), 'no links followed from an unproven artist')
  })

  it('a second same-name artist at ANY score refuses it — a 40-score namesake, or one that only shares an alias', async () => {
    const low = web({ artists: { DVTR: [dvtr, { id: 'other', name: 'DVTR', score: 40 }] }, ...montreal })
    assert.equal((await lookupArtistOrigin('DVTR', ['BONJOUR (BIS)'], low.net)).kind, 'unknown')
    const alias = web({ artists: { DVTR: [dvtr, { id: 'aka', name: 'Daft Vintage Rec', score: 85, aliases: [{ name: 'DVTR' }] }] }, ...montreal })
    assert.equal((await lookupArtistOrigin('DVTR', ['BONJOUR (BIS)'], alias.net)).kind, 'unknown')
  })

  it('refused without a country or an area (The Creem)', async () => {
    const w = web({ artists: { 'The Creem': [{ id: 'creem', name: 'The Creem', score: 100 }] }, details: { creem: { relations: [{ type: 'bandcamp', url: { resource: 'https://thecreem.bandcamp.com/' } }] } } })
    assert.equal((await lookupArtistOrigin('The Creem', ['A Taste Of Cherry'], w.net)).kind, 'unknown')
    assert.ok(!w.urls.some((u) => u.includes('bandcamp')))
  })

  it('refused when his album is credited to a different MusicBrainz artist', async () => {
    const w = web({ artists: { DVTR: [dvtr] }, releaseGroups: [{ title: 'BONJOUR (BIS)', credit: 'DVTR', ids: ['not-dvtr'] }], ...montreal })
    const r = await lookupArtistOrigin('DVTR', ['BONJOUR (BIS)'], w.net)
    assert.equal(r.kind, 'unknown')
  })

  it('only for the primary name: the one MusicBrainz "Love" is never "Love, DEAN"', async () => {
    const w = web({ artists: { Love: [{ id: 'love', name: 'Love', score: 100, country: 'US' }] } })
    assert.equal((await lookupArtistOrigin('Love, DEAN', ['Love, DEAN'], w.net)).kind, 'unknown')
  })

  it('MusicBrainz busy during the search is busy, not a refusal', async () => {
    const w = web({ artists: { DVTR: [dvtr] }, ...montreal, status: (u) => (u.pathname.startsWith('/ws/2/area') ? 503 : undefined) })
    assert.equal((await lookupArtistOrigin('DVTR', ['BONJOUR (BIS)'], w.net)).kind, 'busy')
  })
})

describe('(B) Wikidata, then Bandcamp — only from a proven MusicBrainz artist', () => {
  const tempo = (relations: unknown[]): Web => ({
    artists: { 'Surely Tempo': [{ id: 'st', name: 'Surely Tempo', score: 100 }] },
    releaseGroups: [{ title: 'Mr. Metronome', credit: 'Surely Tempo', ids: ['st'] }],
    details: { st: { id: 'st', relations } },
  })
  const wdLink = { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q42' } }
  const bcLink = { type: 'bandcamp', url: { resource: 'https://surelytempo.bandcamp.com/' } }

  it('P495 country of origin → its ISO code → the library\'s country name', async () => {
    const w = web({ ...tempo([wdLink]), entities: { Q42: { claims: { P31: [item('Q215380')], P495: [item('Q30')] } } }, claims: COUNTRY_CODES })
    assert.deepEqual(asFound(await lookupArtistOrigin('Surely Tempo', ['Mr. Metronome'], w.net)), { origin: 'United States', source: 'wikidata', via: 'mb' })
  })

  it('P740 place of formation → the place\'s country (P17) → ISO code', async () => {
    const w = web({ ...tempo([wdLink]), entities: { Q42: { claims: { P740: [item('Q16559')] } } }, claims: { ...COUNTRY_CODES, Q16559: { P17: [item('Q30')] } } })
    assert.deepEqual(asFound(await lookupArtistOrigin('Surely Tempo', ['Mr. Metronome'], w.net)), { origin: 'United States', source: 'wikidata', via: 'mb' })
  })

  it('P27 citizenship only for a person (P31 = human); a band\'s P27 is ignored', async () => {
    const person = web({ ...tempo([wdLink]), entities: { Q42: { claims: { P31: [item('Q5')], P27: [item('Q145')] } } }, claims: COUNTRY_CODES })
    assert.deepEqual(asFound(await lookupArtistOrigin('Surely Tempo', ['Mr. Metronome'], person.net)), { origin: 'United Kingdom', source: 'wikidata', via: 'mb' })
    const band = web({ ...tempo([wdLink]), entities: { Q42: { claims: { P31: [item('Q215380')], P27: [item('Q145')] } } }, claims: COUNTRY_CODES })
    assert.equal((await lookupArtistOrigin('Surely Tempo', ['Mr. Metronome'], band.net)).kind, 'unknown')
  })

  it('a property naming two countries is skipped, not guessed; preferred rank wins; deprecated never counts', async () => {
    const two = web({ ...tempo([wdLink]), entities: { Q42: { claims: { P495: [item('Q30'), item('Q16')], P740: [item('Q183')] } } }, claims: COUNTRY_CODES })
    assert.deepEqual(asFound(await lookupArtistOrigin('Surely Tempo', ['Mr. Metronome'], two.net)), { origin: 'Germany', source: 'wikidata', via: 'mb' })
    assert.deepEqual(wdBest([item('Q30'), item('Q16', 'preferred')]).map((v) => (v as { id: string }).id), ['Q16'])
    assert.deepEqual(wdBest([item('Q30', 'deprecated')]), [])
  })

  it('Bandcamp\'s stated location when Wikidata has nothing', async () => {
    const html = '<p id="band-name-location"><span class="title">Surely Tempo</span><span class="location secondaryText">Austin, Texas</span></p>'
    const w = web({ ...tempo([wdLink, bcLink]), entities: { Q42: { claims: {} } }, pages: { 'https://surelytempo.bandcamp.com/': html } })
    assert.deepEqual(asFound(await lookupArtistOrigin('Surely Tempo', ['Mr. Metronome'], w.net)), { origin: 'United States', source: 'bandcamp', via: 'mb' })
  })

  it('links reached through (A) say so: via mb-lone-name', async () => {
    const w = web({
      artists: { zebrahead: [{ id: 'zh', name: 'Zebrahead', score: 100, area: { id: 'oc', name: 'Orange County' } }] },   // keyed by the name asked
      details: { zh: { id: 'zh', area: { id: 'oc', name: 'Orange County' }, relations: [wdLink] } },
      areas: { oc: { id: 'oc', name: 'Orange County', relations: [] } },
      entities: { Q42: { claims: { P495: [item('Q30')] } } }, claims: COUNTRY_CODES,
    })
    assert.deepEqual(asFound(await lookupArtistOrigin('zebrahead', ['The Early Years - Revisited'], w.net)), { origin: 'United States', source: 'wikidata', via: 'mb-lone-name' })
  })

  it('only a real bandcamp.com link is fetched; Wikidata busy is busy', async () => {
    const odd = web({ ...tempo([{ type: 'bandcamp', url: { resource: 'https://evil.example.com/' } }]) })
    assert.equal((await lookupArtistOrigin('Surely Tempo', ['Mr. Metronome'], odd.net)).kind, 'unknown')
    assert.ok(!odd.urls.some((u) => u.includes('example.com')))
    const busy = web({ ...tempo([wdLink]), status: (u) => (u.host === 'www.wikidata.org' ? 503 : undefined) })
    assert.equal((await lookupArtistOrigin('Surely Tempo', ['Mr. Metronome'], busy.net)).kind, 'busy')
  })
})

describe('credits from the Various Artists comps', () => {
  it('a remixer in brackets and a "vs." partner are not the artist', async () => {
    const { originNames } = await import('../origin-lookup.ts')
    assert.deepEqual(originNames('Heartbeat Brothers (Freddy Fresh & Fanagla Remix)').names, ['Heartbeat Brothers'])
    assert.deepEqual(originNames('Mobski (Damajaj Rework)').names, ['Mobski'])
    assert.deepEqual(originNames('Mr. Fox vs. Freddy Fresh').names, ['Mr. Fox vs. Freddy Fresh', 'Mr. Fox'])
    assert.deepEqual(originNames('D.A. vs The Invisible Man').names, ['D.A. vs The Invisible Man', 'D.A.'])
    assert.deepEqual(originNames('Sunn O)))').names, ['Sunn O)))'], 'a name with brackets of its own stays whole')
    assert.deepEqual(originNames('The Remixes').names, ['The Remixes'])
  })
})

describe('places → the library\'s origin words', () => {
  it('Bandcamp locations', () => {
    assert.equal(placeToCountry('Austin, Texas'), 'United States')
    assert.equal(placeToCountry('Brooklyn, New York'), 'United States')
    assert.equal(placeToCountry('Washington, D.C.'), 'United States')
    assert.equal(placeToCountry('London, UK'), 'United Kingdom')
    assert.equal(placeToCountry('Glasgow, Scotland'), 'United Kingdom')
    assert.equal(placeToCountry('Montréal, Québec'), 'Canada')
    assert.equal(placeToCountry('Lyon, France'), 'France')
    assert.equal(placeToCountry('Melbourne, Australia'), 'Australia')
    assert.equal(placeToCountry('Tbilisi, Georgia'), undefined, 'Georgia is a state and a country — no answer')
    assert.equal(placeToCountry('the moon'), undefined)
    assert.equal(placeToCountry(''), undefined)
  })
  it('reads the location under the band name, entities decoded', () => {
    assert.equal(bandcampLocation('<p id="band-name-location">\n <span class="title">X</span>\n <span class="location secondaryText">S&atilde;o Paulo, Brazil</span></p>'), 'S&atilde;o Paulo, Brazil')
    assert.equal(bandcampLocation('<p id="band-name-location"><span class="title">X</span><span class="location secondaryText">Fort Worth, Texas &amp; Elsewhere</span></p>'), 'Fort Worth, Texas & Elsewhere')
    assert.equal(bandcampLocation('<span class="location secondaryText">Nowhere</span>'), undefined, 'only under the band name')
  })
  it('one spelling per country, the library\'s', () => {
    assert.equal(countryName('HK'), 'Hong Kong', 'the library says Hong Kong, not "Hong Kong SAR China"')
    assert.equal(countryName('TT'), 'Trinidad and Tobago', 'and Trinidad and Tobago, not "Trinidad & Tobago"')
    assert.equal(placeToCountry('Port of Spain, Trinidad and Tobago'), 'Trinidad and Tobago')
    assert.equal(placeToCountry('Port of Spain, Trinidad & Tobago'), 'Trinidad and Tobago')
    assert.equal(countryName('US'), 'United States')
    assert.equal(countryName('GB'), 'United Kingdom')
  })
})

describe('the filer remembers each answer\'s source', () => {
  it('mb-lone-name and wikidata answers are cached with source, via and MBID — auditable, revertible', async () => {
    const tracks: FilerTrack[] = [{ id: 1, title: 'a', artist: 'DVTR', album: 'BONJOUR (BIS)', genre: 'Punk', genreApproved: true }, { id: 2, title: 'b', artist: 'Surely Tempo', album: 'Mr. Metronome', genre: 'Punk', genreApproved: true }]
    let cache: OriginCache = {}
    const answers: Record<string, OriginLookup> = {
      DVTR: { kind: 'found', origin: 'Canada', source: 'mb-lone-name', mbid: 'dvtr', evidence: 'the only MusicBrainz artist named "DVTR"' },
      'Surely Tempo': { kind: 'found', origin: 'United States', source: 'wikidata', via: 'mb', mbid: 'st', evidence: 'Wikidata Q42 P495' },
    }
    const logs: string[] = []
    const deps = {
      tracks: async () => tracks, persist: async () => {}, applied: () => {}, loadCheck: async () => [], saveCheck: async () => {},
      evidence: async () => ({ artistTags: [], albumTags: [], press: '' }), classify: async () => '[]', now: () => new Date(1_800_000_000_000),
      lookupOrigin: async (a: string) => answers[a], loadOriginCache: async () => cache, saveOriginCache: async (c: OriginCache) => { cache = c }, log: (m: string) => logs.push(m),
    } as FilerDeps
    await fillOrigins(deps, tracks, new Map(), new Set())
    assert.deepEqual(cache[originCacheKey('DVTR')], { origin: 'Canada', at: 1_800_000_000_000, source: 'mb-lone-name', mbid: 'dvtr', note: 'the only MusicBrainz artist named "DVTR"' })
    assert.deepEqual(cache[originCacheKey('Surely Tempo')], { origin: 'United States', at: 1_800_000_000_000, source: 'wikidata', via: 'mb', mbid: 'st', note: 'Wikidata Q42 P495' })
    assert.ok(logs.includes('[genre-filer] origin: Surely Tempo → United States (wikidata via mb, Wikidata Q42 P495; 1 song)'))
  })
})

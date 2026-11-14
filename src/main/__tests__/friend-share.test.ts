/**
 * Friend share (2026-10-29): the desktop reads homemini's share answer
 * (common/friend-share-doc.ts), asks for it with the companion header, and
 * draws the card by the phone's rules (common/friend-share-card.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShareInfo, offlineShareText } from '../../common/friend-share-doc.ts'
import { createFriendShareClient } from '../friend-share-client.ts'
import { counterText, scrubTimes, wrapText, titleSize, artistSize, detailSize, px, cardFileName, cardName, CARD_SIZE, STORY_SAFE, SCREEN_WIDTH, SQUARE_STEPS, squareChrome, pickSquareStep } from '../../common/friend-share-card.ts'

const answer = {
  v: 1, kind: 'song', title: 'I Can See For Miles', artist: 'The Who', album: 'Best Of The Who',
  rank: 212, counter: { index: 212, total: 1000 },
  signature: { text: "#212 in Jake's Top 1000", card: "from Jake's Top 1000" },
  links: {
    primary: 'https://open.spotify.com/track/64SFBGTQvXgEHds3F01rpc',
    appleMusic: 'https://music.apple.com/us/album/1?i=2',
    spotify: 'https://open.spotify.com/track/64SFBGTQvXgEHds3F01rpc',
    deezer: null, songLink: 'https://song.link/s/64SFBGTQvXgEHds3F01rpc', youtubeMusicSearch: null,
  },
  text: "#212 in Jake's Top 1000: I Can See For Miles by The Who\nSpotify: https://open.spotify.com/track/64SFBGTQvXgEHds3F01rpc\nApple Music: https://music.apple.com/us/album/1?i=2",
  cached: true, partial: false,
}

test('parseShareInfo reads the route and fails closed on junk', () => {
  const i = parseShareInfo(answer)
  assert.ok(i)
  assert.equal(i.counter?.index, 212)
  assert.equal(i.links.spotify, 'https://open.spotify.com/track/64SFBGTQvXgEHds3F01rpc')
  assert.equal(i.text.split('\n')[0], "#212 in Jake's Top 1000: I Can See For Miles by The Who")
  assert.ok(i.text.split('\n')[1].startsWith('Spotify: https://open.spotify.com/track/'))
  assert.equal(parseShareInfo({ ...answer, text: '' }), null)
  assert.equal(parseShareInfo(null), null)
  assert.equal(parseShareInfo({ ...answer, counter: null })?.counter, null)
})

test('offline text keeps the signature-first shape', () => {
  assert.equal(offlineShareText('Banana Pancakes', 'Jack Johnson'), "From Jake's library\nBanana Pancakes by Jack Johnson")
})

test('client: asks /api/share/link with id + kind, maps 404 and transport errors', async () => {
  const seen: string[] = []
  const ok = createFriendShareClient({ baseUrl: 'http://homemini:3000/', fetchImpl: async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => answer } } })
  const r = await ok.info(42, 'album')
  assert.ok(r.ok)
  assert.equal(seen[0], 'http://homemini:3000/api/share/link?id=42&kind=album')
  const nf = createFriendShareClient({ baseUrl: 'http://h', fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) })
  assert.deepEqual(await nf.info(1, 'song'), { ok: false, error: 'homemini doesn’t have this song yet.' })
  const down = createFriendShareClient({ baseUrl: 'http://h', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal((await down.info(1, 'song')).ok, false)
})

test('card rules match the phone: sizes, integral Chicago sizes, the counter Easter egg', () => {
  assert.deepEqual(CARD_SIZE.story, { w: 1080, h: 1920 })
  assert.deepEqual(CARD_SIZE.square, { w: 1080, h: 1080 })
  // Instagram's safe zone, twin of the phone's StoryShare.safeTop / safeBottom.
  assert.deepEqual(STORY_SAFE, { top: 250, bottom: 340 })
  assert.equal(SCREEN_WIDTH.story, 560)
  assert.equal(titleSize('Short', 640), 31)
  assert.equal(titleSize('I Can See For Miles', 640), 26)
  assert.ok(Number.isInteger(px(23, 760)))
  assert.equal(counterText({ index: 212, total: 1000 }), '212 of 1000')
  assert.equal(counterText(null), null)
  assert.deepEqual(scrubTimes(245_000), { elapsed: '1:30', remaining: '-2:35' })
  assert.equal(scrubTimes(0), null)
})

test('wrapText: two lines max, ellipsis only when something is left over', () => {
  const m = (s: string) => s.length * 10
  assert.deepEqual(wrapText('I Can See For Miles', 120, 2, m), ['I Can See', 'For Miles'])
  assert.deepEqual(wrapText('Sorry I m Late I Didn t Want To Come', 120, 2, m), ['Sorry I m', 'Late I Didn…'])
  assert.deepEqual(wrapText('Short', 120, 1, m), ['Short'])
})

test('card file names are safe', () => {
  assert.equal(cardFileName(cardName('I Can See For Miles', 'The Who', 'story')), 'The Who - I Can See For Miles (Story).png')
  assert.equal(cardFileName('../../etc/passwd'), 'etc passwd.png')
  assert.equal(cardFileName(''), 'JakeTunes.png')
})

// The longest real names in Jake's library (2026-10-29): album 132 chars,
// title 103, artist 91. Names never clip: they step down a size, then wrap
// as far as they need — never an ellipsis.
const LONGEST_ALBUM = 'Dancefloor Fever 2016 (The Best of Clubbing Music: Electro, Techno, Deep-House. Including a Special House Mix By Yellow Productions)'
const LONGEST_TITLE = '2122 & Now I Wanna Sniff Some Glue by The Ramones (Live from Forest Hills, New York, October 3rd, 2026)'
const LONGEST_ARTIST = 'Spiller, Sophie Ellis-Bextor, William Kiss, Jordan Brando, Luke Alessi, not without friends'

test('names never clip: a long name steps down, then wraps in full', () => {
  const m = (s: string) => s.length * 11
  for (const name of [LONGEST_ALBUM, LONGEST_TITLE, LONGEST_ARTIST, '20th Century Masters: The Millennium Collection: Best Of The Who']) {
    const lines = wrapText(name, 290, 99, m)
    assert.equal(lines.join(' '), name.split(/\s+/).join(' '), 'every word survives, in order')
    assert.ok(!lines.some((l) => l.endsWith('…')), 'no ellipsis')
  }
  assert.equal(titleSize(LONGEST_TITLE, 640), 20)
  assert.equal(artistSize(LONGEST_ARTIST, 640), 20)
  assert.equal(detailSize(LONGEST_ALBUM, 640), 19)
})

test('square steps down until the screen fits, eyebrow first', () => {
  assert.equal(SQUARE_STEPS[0].eyebrow, true)
  assert.equal(pickSquareStep(() => 400), 0)
  const big = (s: typeof SQUARE_STEPS[number]) => 1080 - squareChrome(s) + (s.art > 0.5 ? 1 : 0)
  assert.equal(SQUARE_STEPS[pickSquareStep(big)].art <= 0.5, true)
  assert.equal(pickSquareStep(() => 5000), SQUARE_STEPS.length - 1)
})

// ── Share by service (2026-11-14) ─────────────────────────────────────────

import { parseFriendServices, chipFor, copiedNote, serviceTag } from '../../common/friend-services-doc.ts'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const byService = {
  apple: { url: 'https://music.apple.com/us/album/1?i=2', text: "#212 in Jake's Top 1000: I Can See For Miles by The Who\nhttps://music.apple.com/us/album/1?i=2" },
  spotify: null,
}
const people = { people: [
  { key: 'mom', name: 'Mom', service: 'apple', setBy: 'jake', at: 'x', seed: true },
  { key: 'lorin bloom', name: 'Lorin Bloom', service: 'spotify', setBy: 'jake', at: 'x', seed: true },
  { key: 'dana', name: 'Dana', service: 'unknown', setBy: 'jake', at: 'x', seed: false },
  { key: '', name: 'No Key', service: 'apple' },
  { key: 'bad', name: 'Bad', service: 'tidal' },
] }

test('parseShareInfo keeps byService and an old answer without it still reads', () => {
  const i = parseShareInfo({ ...answer, byService })!
  assert.equal(i.byService?.apple?.url, 'https://music.apple.com/us/album/1?i=2')
  assert.equal(i.byService?.spotify, null)
  assert.equal(parseShareInfo(answer)!.byService, undefined)
  assert.equal(parseShareInfo({ ...answer, byService: { apple: { url: 'javascript:x', text: 't' } } })!.byService?.apple, null)
})

test('parseFriendServices keeps the route order and drops rows that do not read', () => {
  const p = parseFriendServices(people)
  assert.deepEqual(p.map((x) => x.name), ['Mom', 'Lorin Bloom', 'Dana'])
  assert.deepEqual(parseFriendServices(null), [])
  assert.equal(serviceTag('apple'), 'APPLE')
  assert.equal(serviceTag('unknown'), null)
})

test('SEND TO: each person gets their app\'s message; no proven link greys them; unknown gets both', () => {
  const [mom, lorin, dana] = parseFriendServices(people)
  const i = parseShareInfo({ ...answer, byService })!
  assert.deepEqual(chipFor(mom!, i), { state: 'ready', text: byService.apple.text })
  assert.deepEqual(chipFor(lorin!, i), { state: 'no-link' })
  assert.deepEqual(chipFor(dana!, i), { state: 'ready', text: answer.text })
  assert.deepEqual(chipFor(mom!, null), { state: 'waiting' })
  // A homemini from before share-by-service: everyone gets the two-link text.
  assert.deepEqual(chipFor(lorin!, parseShareInfo(answer)), { state: 'ready', text: answer.text })
})

test('SEND TO says plainly what was copied and that Messages cannot be addressed from here', () => {
  const [mom, lorin, dana] = parseFriendServices(people)
  assert.equal(copiedNote(lorin!), 'Lorin’s Spotify message is copied. The desktop can’t open Messages to one person, so paste it in Messages to Lorin.')
  assert.match(copiedNote(mom!), /^Mom’s Apple Music message is copied\./)
  assert.match(copiedNote(dana!), /message \(both links\)/)
})

test('client: friends() asks /api/friend-services and fails soft', async () => {
  const seen: string[] = []
  const c = createFriendShareClient({ baseUrl: 'http://homemini:3000', fetchImpl: async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => people } } })
  const r = await c.friends()
  assert.ok(r.ok)
  assert.equal(seen[0], 'http://homemini:3000/api/friend-services')
  const down = createFriendShareClient({ baseUrl: 'http://h', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal((await down.friends()).ok, false)
})

test('the dialog draws SEND TO from the route and copies through the main process', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../renderer/components/FriendShareDialog.tsx'), 'utf8')
  assert.match(src, /friendShareFriends\?\.\(\)/, 'asks for the people')
  assert.match(src, /chipFor\(p, loading \? null : info\)/, 'each person by the shared rule')
  assert.match(src, /friendShareCopy\?\.\(\{ text: chip\.text \}\)/, 'copies that person\'s message (clipboard via IPC, never navigator.clipboard)')
  assert.match(src, /copiedNote\(p\)/, 'and says so')
  assert.doesNotMatch(src, /navigator\.clipboard/)
})

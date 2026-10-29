/**
 * Friend share (2026-10-29): the desktop reads homemini's share answer
 * (common/friend-share-doc.ts), asks for it with the companion header, and
 * draws the card by the phone's rules (common/friend-share-card.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShareInfo, offlineShareText } from '../../common/friend-share-doc.ts'
import { createFriendShareClient } from '../friend-share-client.ts'
import { counterText, scrubTimes, wrapText, titleSize, px, cardFileName, cardName, CARD_SIZE, STORY_SAFE, SCREEN_WIDTH } from '../../common/friend-share-card.ts'

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

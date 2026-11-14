/**
 * Where Jake is when he asks (renderer/musicManSubject.ts), and the rule that
 * the Music Man only gives an opinion when asked (2026-11-13): no surface
 * writes or shows a take by itself.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { askSubjectFor, askSubjectHint, type SubjectPage } from '../../renderer/musicManSubject.ts'
import { parseAskSubject, larryChimesIn } from '../ipc/music-man-ask-ipc.ts'

const SRC = join(import.meta.dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf-8')

const page = (over: Partial<SubjectPage> = {}): SubjectPage => ({
  currentView: 'songs', activeArtist: null, pendingAlbumKey: null, activePlaylistId: null, activeSmartPlaylist: null,
  playlists: [{ id: 'p1', name: 'Road', trackIds: [3, 1] }, { id: 'p2', name: 'Empty', trackIds: [] }],
  tracks: [
    { id: 1, artist: 'Twisted Teens', albumArtist: 'Twisted Teens', album: 'The Holy Cross Tigers', year: 2026 },
    { id: 3, artist: 'Geese', album: '3D Country', year: 2023 },
  ],
  ...over,
})

describe('what the mic asks about', () => {
  test('an album page: that album, by its album artist and year', () => {
    assert.deepEqual(
      askSubjectFor(page({ currentView: 'album-detail', pendingAlbumKey: 'twisted teens|||the holy cross tigers' }), { id: 3 }),
      { kind: 'album', artist: 'Twisted Teens', album: 'The Holy Cross Tigers', year: '2026' },
    )
  })
  test('an artist page: that artist', () => {
    assert.deepEqual(askSubjectFor(page({ currentView: 'artist-detail', activeArtist: 'Twisted Teens' }), { id: 3 }), { kind: 'artist', name: 'Twisted Teens' })
  })
  test('a playlist: that playlist and its songs', () => {
    assert.deepEqual(askSubjectFor(page({ currentView: 'playlist', activePlaylistId: 'p1' }), null), { kind: 'list', what: 'playlist', name: 'Road', trackIds: [3, 1] })
  })
  test("an iPod's list: the list and what it is for", () => {
    const lists = [{ id: 'abc', name: 'punkPod', purpose: 'Punk', ids: [1, 3] }]
    assert.deepEqual(
      askSubjectFor(page({ currentView: 'smart-playlist', activeSmartPlaylist: 'ipod-list-abc' }), null, lists),
      { kind: 'list', what: 'ipod', name: 'punkPod', trackIds: [1, 3], purpose: 'Punk' },
    )
  })
  test('anywhere else: the song playing', () => {
    assert.deepEqual(askSubjectFor(page(), { id: 3 }), { kind: 'song', trackId: 3 })
    assert.deepEqual(askSubjectFor(page({ currentView: 'home' }), { id: 1 }), { kind: 'song', trackId: 1 })
  })
  test('a page whose subject is gone falls back to the song playing', () => {
    assert.deepEqual(askSubjectFor(page({ currentView: 'album-detail', pendingAlbumKey: 'nobody|||nothing' }), { id: 3 }), { kind: 'song', trackId: 3 })
    assert.deepEqual(askSubjectFor(page({ currentView: 'playlist', activePlaylistId: 'p2' }), { id: 3 }), { kind: 'song', trackId: 3 })
    // activeArtist lingers after leaving the artist page: it is not the subject there.
    assert.deepEqual(askSubjectFor(page({ currentView: 'songs', activeArtist: 'Geese' }), { id: 1 }), { kind: 'song', trackId: 1 })
  })
  test('nothing on screen and nothing playing: nothing to ask', () => {
    assert.equal(askSubjectFor(page(), null), null)
    assert.match(askSubjectHint(null), /open an album, an artist or a playlist, or play something/)
  })
  test('the tooltip names what a press will ask about', () => {
    assert.match(askSubjectHint({ kind: 'album', artist: 'Twisted Teens', album: 'The Holy Cross Tigers' }), /about the album “The Holy Cross Tigers”/)
    assert.match(askSubjectHint({ kind: 'artist', name: 'Twisted Teens' }), /about Twisted Teens/)
    assert.match(askSubjectHint({ kind: 'song', trackId: 1 }), /about this song/)
  })
  test("the album key is the album page's own (utils/albumKey.ts)", () => {
    assert.match(read('renderer/utils/albumKey.ts'), /return `\$\{\(artist \|\| 'Unknown Artist'\)\.toLowerCase\(\)\.trim\(\)\}\|\|\|\$\{\(album \|\| 'Unknown'\)\.toLowerCase\(\)\.trim\(\)\}`/)
  })
})

describe('what main accepts from the renderer', () => {
  test('well-formed subjects pass, trimmed', () => {
    assert.deepEqual(parseAskSubject({ kind: 'album', artist: ' A ', album: ' B ', year: 2026 }), { kind: 'album', artist: 'A', album: 'B', year: undefined })
    assert.deepEqual(parseAskSubject({ kind: 'album', artist: 'A', album: 'B', year: '2026' }), { kind: 'album', artist: 'A', album: 'B', year: '2026' })
    assert.deepEqual(parseAskSubject({ kind: 'artist', name: 'A' }), { kind: 'artist', name: 'A' })
    assert.deepEqual(parseAskSubject({ kind: 'song', trackId: 7 }), { kind: 'song', trackId: 7 })
    assert.deepEqual(parseAskSubject({ kind: 'list', what: 'ipod', name: 'L', trackIds: [1, 'x', 2.5, 3], purpose: 'P' }), { kind: 'list', what: 'ipod', name: 'L', trackIds: [1, 3], purpose: 'P' })
  })
  test('anything else is no subject', () => {
    for (const bad of [null, undefined, 'album', {}, { kind: 'album', artist: 'A' }, { kind: 'artist' }, { kind: 'song', trackId: '7' }, { kind: 'list', name: 'L', trackIds: [] }, { kind: 'radio' }]) {
      assert.equal(parseAskSubject(bad), null)
    }
  })
  test('"Larry chimes in" is on until Jake turns it off', () => {
    assert.equal(larryChimesIn(null), true)
    assert.equal(larryChimesIn({ ai: {} }), true)
    assert.equal(larryChimesIn({ ai: { larryChimesIn: true } }), true)
    assert.equal(larryChimesIn({ ai: { larryChimesIn: false } }), false)
  })
})

describe('no take without an ask', () => {
  const renderer = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? renderer(full) : /\.tsx?$/.test(name) ? [full] : []
  })

  test('no page asks for a take as it opens: the old door is gone from main, preload and every view', () => {
    assert.doesNotMatch(read('main/ipc/ai-ipc.ts'), /ipc\.handle\('get-album-take'/)
    assert.doesNotMatch(read('preload/index.ts'), /get-album-take|getAlbumTake/)
    for (const file of renderer(join(SRC, 'renderer'))) {
      assert.doesNotMatch(readFileSync(file, 'utf-8'), /getAlbumTake|Music Man’s take|Music Man's take/, file)
    }
  })

  test('the only callers of the ask are the mic button and the chat Jake types into', () => {
    const callers = renderer(join(SRC, 'renderer')).filter((f) => /electronAPI\.musicmanAsk\(/.test(readFileSync(f, 'utf-8')))
    assert.deepEqual(callers.map((f) => f.slice(SRC.length + 1)), ['renderer/components/playback/Toolbar.tsx'])
    const toolbar = read('renderer/components/playback/Toolbar.tsx')
    // Inside the click handler, nowhere else.
    const handler = toolbar.slice(toolbar.indexOf('const handleDjClick = useCallback'), toolbar.indexOf('// Auto-DJ / Radio Mode: listen for track transitions'))
    assert.match(handler, /window\.electronAPI\.musicmanAsk\(subject, undefined, pb\.nowPlaying\?\.id \?\? null\)/)
    assert.equal(toolbar.split('electronAPI.musicmanAsk(').length - 1, 1)
    assert.match(toolbar, /onClick=\{handleDjClick\}/)
  })

  test('the mic asks about the page, and the chat is handed the same subject', () => {
    assert.match(read('renderer/components/playback/Toolbar.tsx'), /askSubjectFor\(lib, pb\.nowPlaying, ipodLists\)/)
    assert.match(read('renderer/components/MusicManDrawer.tsx'), /askSubjectFor\(lib, pb\.nowPlaying, ipodLists\)/)
    assert.match(read('renderer/components/MusicManChat.tsx'), /musicmanChat\(newMessages, contextLine \|\| undefined, subject \?\? null, nowPlayingId \?\? null\)/)
    assert.match(read('main/index.ts'), /musicManGrounding\.chatBlock\(subject, nowPlayingId, messages\.filter\(m => m\.role === 'user'\)\.pop\(\)\?\.content\)/)
    // A question about something that isn't the page and isn't in the library is left alone.
    assert.match(read('main/index.ts'), /!grounded \|\| grounded\.offPage \? credited\.text : await musicManGrounding\.rescueChat/)
    assert.match(read('main/index.ts'), /musicManGrounding\.rescueChat\(grounded\.input, credited\.text/)
  })

  test('the judge is the small model, asked for one word, and only through the ask', () => {
    const ipc = read('main/ipc/music-man-ask-ipc.ts')
    assert.match(ipc, /claudeCall\('musicman-ask-judge', \{ model: MODEL_FAST, max_tokens: 5,/)
    assert.match(ipc, /v === 'non-answer' \|\| \(v === 'unsure' && await judge\(/)
  })

  test('a take is never kept: the ask writes nothing to disk', () => {
    for (const f of ['main/music-man-ask.ts', 'main/ipc/music-man-ask-ipc.ts']) {
      assert.doesNotMatch(read(f), /writeFile|writeJsonAtomic|albumNotesStore/, f)
    }
  })

  test('no key ever reaches the renderer through the ask', () => {
    for (const f of ['renderer/musicManSubject.ts', 'common/music-man-packet.ts', 'common/music-man-ask-prompt.ts', 'common/non-answer.ts']) {
      assert.doesNotMatch(read(f), /API_KEY|apiKey|process\.env|anthropic/i, f)
    }
  })
})

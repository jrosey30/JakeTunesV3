/**
 * What the screen shows as playing is what is sounding — by the track
 * itself, never by an index (2026-11-14, Jake: "you do realize love takes
 * miles is playing right now right").
 *
 * The incident (audio-events.log, 19:11): "Stalks (Greenpoint Mix)" hit a
 * demuxer error at 1:43, the stuck-watchdog rebuilt it, the rebuild failed
 * to load, and Brief 160's failure skip (failAdvance) loaded "Love Takes
 * Miles (Greenpoint Mix)" — without telling the playback state. Now
 * Playing, the artwork and the list's speaker icon kept naming Stalks over
 * Love Takes Miles' sound (0:18 / -3:00 is Love Takes Miles' 3:18). The
 * playlist removal in the screenshot was a bystander: removing from a
 * playlist never touches the play queue.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locateTrackIndex, resolveSeamAdvance, nowPlayingFollows } from '../../renderer/queue-seam.ts'

const ROOT = join(import.meta.dirname, '../..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
const useAudio = read('renderer/hooks/useAudio.ts')

type T = { id: number; title: string; duration: number }
const stalks: T = { id: 101, title: 'Stalks (Greenpoint Mix)', duration: 198_000 }
const love: T = { id: 102, title: 'Love Takes Miles (Greenpoint Mix)', duration: 198_400 }
const third: T = { id: 103, title: 'Third', duration: 200_000 }

/** What the reducer does with a PLAY_TRACK that has locateInQueue and no
 *  queue (PlaybackContext.tsx): nowPlaying is the action's track; the index
 *  is wherever that track sits in the live queue (hint for duplicates). */
function applyPlay(state: { queue: T[]; queueIndex: number; nowPlaying: T | null }, a: ReturnType<typeof nowPlayingFollows<T>>) {
  const li = locateTrackIndex(state.queue, a.track.id, a.queueIndex)
  return { ...state, nowPlaying: a.track, queueIndex: li >= 0 ? li : a.queueIndex }
}

/** failAdvance, as useAudio.ts runs it, with the engine reduced to "what
 *  is sounding". Returns the screen state and the sounding track. */
function failSkip(state: { queue: T[]; queueIndex: number; nowPlaying: T | null; repeat: 'off' | 'all' | 'one' }, failed: T) {
  if (!state.nowPlaying || state.nowPlaying.id !== failed.id) return { screen: state, sounding: null as T | null, stale: true }
  const seam = resolveSeamAdvance(state.queue, failed.id, state.queueIndex, state.repeat)
  const next = seam.nextIndex >= 0 ? state.queue[seam.nextIndex] : undefined
  if (!next || next.id === failed.id) return { screen: { ...state, nowPlaying: null }, sounding: null, stale: false }
  const screen = { ...applyPlay(state, nowPlayingFollows(next, seam.nextIndex)), repeat: state.repeat }
  return { screen, sounding: next, stale: false }
}

describe('the failure skip names the song it starts', () => {
  test('the incident: shuffled Greenpoint Mixes, Stalks fails, Love Takes Miles sounds AND shows', () => {
    const st = { queue: [stalks, love], queueIndex: 0, nowPlaying: stalks, repeat: 'off' as const }
    const r = failSkip(st, stalks)
    assert.equal(r.sounding?.id, love.id)
    assert.equal(r.screen.nowPlaying?.id, love.id, 'the screen still names the failed song')
    assert.equal(r.screen.queueIndex, 1)
  })

  test('a second failure — of the song now sounding — is acted on, not dropped as stale', () => {
    const st = { queue: [stalks, love, third], queueIndex: 0, nowPlaying: stalks, repeat: 'off' as const }
    const a = failSkip(st, stalks)
    const b = failSkip(a.screen, love)
    assert.equal(b.stale, false, 'Love Takes Miles failing was ignored: silence shown as playing')
    assert.equal(b.sounding?.id, third.id)
    assert.equal(b.screen.nowPlaying?.id, third.id)
  })

  test('queue edited before the failure (a song removed before / after the playing one): identity still wins', () => {
    // removed before: the playing song shifted down one slot, the hint is stale
    const before = failSkip({ queue: [stalks, love], queueIndex: 1, nowPlaying: stalks, repeat: 'off' }, stalks)
    assert.equal(before.screen.nowPlaying?.id, before.sounding?.id)
    assert.equal(before.sounding?.id, love.id)
    // removed after: the next song is the one after the gap
    const after = failSkip({ queue: [stalks, third], queueIndex: 0, nowPlaying: stalks, repeat: 'off' }, stalks)
    assert.equal(after.screen.nowPlaying?.id, third.id)
    assert.equal(after.sounding?.id, third.id)
  })

  test('the failed song itself left the queue mid-play: the song in its old slot plays and shows', () => {
    const r = failSkip({ queue: [love, third], queueIndex: 0, nowPlaying: stalks, repeat: 'off' }, stalks)
    assert.equal(r.sounding?.id, love.id)
    assert.equal(r.screen.nowPlaying?.id, love.id)
    assert.equal(r.screen.queueIndex, 0)
  })

  test('a duplicate in the queue: the occurrence at the skip, not the first one', () => {
    const r = failSkip({ queue: [love, stalks, love], queueIndex: 1, nowPlaying: stalks, repeat: 'off' }, stalks)
    assert.equal(r.screen.queueIndex, 2)
    assert.equal(r.screen.nowPlaying?.id, love.id)
  })

  test('the action carries the track itself and its duration in seconds', () => {
    const a = nowPlayingFollows(love, 1)
    assert.equal(a.type, 'PLAY_TRACK')
    assert.equal(a.track, love)
    assert.equal(a.locateInQueue, true)
    assert.equal(a.duration, 198.4)
  })
})

/** Every call that loads a song into the engine. */
function loadCalls(src: string): Array<{ at: number; arg: string }> {
  const out: Array<{ at: number; arg: string }> = []
  const re = /loadAndPlay\((\w+),/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push({ at: m.index, arg: m[1] })
  return out
}

describe('useAudio: every song the engine starts is announced (source lock)', () => {
  // Sites that start a song WITHOUT a PLAY_TRACK right before it, each for
  // a reason that keeps the screen honest:
  //   repeat-one — replays the song already showing;
  //   crossfade  — PLAY_TRACK is sent when the fade completes (updatePosition).
  const EXEMPT = [
    { marker: "branch: 'repeat-one'", why: 'replays the track already on screen' },
    { marker: 'loadAndPlay(track, queue, queueIndex, true)', why: 'crossfade: dispatched at fade end' },
  ]

  test('each loadAndPlay of another song is preceded by a PLAY_TRACK for that same track', () => {
    const calls = loadCalls(useAudio)
    assert.ok(calls.length >= 6, `expected the known load sites, found ${calls.length}`)
    const bad: string[] = []
    for (const c of calls) {
      const tail = useAudio.slice(c.at, c.at + 200)
      if (EXEMPT.some(e => tail.startsWith(e.marker) || useAudio.slice(c.at, c.at + 400).includes(e.marker))) continue
      // Look back to the previous load site (or 900 chars) for the announce.
      const prev = calls.filter(o => o.at < c.at).pop()
      const from = Math.max(prev ? prev.at + 1 : 0, c.at - 900)
      const window = useAudio.slice(from, c.at)
      const named = new RegExp(
        `nowPlayingFollows\\(${c.arg},|type: 'PLAY_TRACK',\\s*track: ${c.arg}\\b` +
        (c.arg === 'track' ? `|type: 'PLAY_TRACK',\\s*track[,\\s]` : ''),
      )
      if (!named.test(window)) {
        const line = useAudio.slice(0, c.at).split('\n').length
        bad.push(`useAudio.ts:${line} loadAndPlay(${c.arg}, …) starts a song the screen is never told about`)
      }
    }
    assert.deepEqual(bad, [])
  })

  test('failAdvance announces the next song before loading it, and its stale guard is still by id', () => {
    const i = useAudio.indexOf('failAdvanceRef.current = (failed, why) =>')
    assert.notEqual(i, -1, 'failAdvance binding moved — update this lock')
    const body = useAudio.slice(i, useAudio.indexOf('runNaturalEndRef.current =', i))
    assert.match(body, /s\.nowPlaying\.id !== failed\.id/)
    const announce = body.indexOf('dispatchRef.current(nowPlayingFollows(next, seam.nextIndex))')
    const load = body.indexOf('loadAndPlay(next, s.queue, seam.nextIndex)')
    assert.ok(announce >= 0, 'failAdvance loads the next song without naming it')
    assert.ok(load > announce, 'failAdvance must name the song before loading it')
  })

  test('the exemptions are still what they claim', () => {
    const r1 = useAudio.indexOf("dx.repeat.branch.repeat-one")
    assert.ok(r1 >= 0)
    assert.match(useAudio.slice(r1, r1 + 500), /loadAndPlay\(track, s\.queue, currentQueueIndex\)/,
      'repeat-one no longer replays the same track')
    assert.match(useAudio, /crossfadePendingTrack = track/)
    assert.match(useAudio, /Fade complete — promote the new track to nowPlaying/)
  })
})

describe('edits elsewhere never move what is sounding out from under the screen', () => {
  test('removing from a playlist, and its Undo, never touch the play queue', () => {
    const pv = read('renderer/views/PlaylistView.tsx')
    const rm = pv.slice(pv.indexOf('const removeFromPlaylist = useCallback'), pv.indexOf('const removeSelected = useCallback'))
    assert.ok(rm.includes('REMOVE_TRACKS_FROM_PLAYLIST'))
    assert.doesNotMatch(rm, /pbDispatch|playTrack|QUEUE/)
    const undo = pv.slice(pv.indexOf('<UndoToast'), pv.indexOf('onDismiss={() => setUndoState(null)}'))
    assert.ok(undo.includes('RESTORE_TRACKS_TO_PLAYLIST'))
    assert.doesNotMatch(undo, /pbDispatch|playTrack|QUEUE/)
  })

  test('the queue panel can only remove songs AFTER the playing one', () => {
    const qp = read('renderer/components/playback/QueuePanel.tsx')
    const removes = qp.match(/type: 'REMOVE_FROM_QUEUE', index: [^}]+/g) ?? []
    assert.ok(removes.length > 0)
    for (const r of removes) assert.match(r, /state\.queueIndex \+ 1 \+/)
  })

  test('a library change that removes the playing song stops the sound and the screen together', () => {
    const app = read('renderer/App.tsx')
    const i = app.indexOf('if (!stillExists) stopPlayback()')
    assert.ok(i >= 0, 'library removal of the playing song no longer goes through stopPlayback')
    const sp = useAudio.slice(useAudio.indexOf('const stopPlayback = useCallback'))
    assert.match(sp.slice(0, 600), /sharedHowl\.unload\(\)/)
    assert.match(sp.slice(0, 600), /type: 'STOP'/)
  })
})

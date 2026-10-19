// "Let the Music Man introduce it" (src/renderer/launch/musicManIntro.ts):
// his line, the duck around it, then the album from track 1 — and every
// cancel path reverses exactly what its start made (CLAUDE.md rule).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createMusicManIntro, type IntroClip, type IntroDeps, type IntroPhase } from '../../renderer/launch/musicManIntro.ts'

interface Rig {
  deps: IntroDeps
  log: string[]
  phases: IntroPhase[]
  clips: FakeClip[]
  resolveSpeak: (r: { ok: boolean; audio?: string; error?: string }) => void
  rejectSpeak: (e: Error) => void
  releaseDuck: () => void
}

interface FakeClip extends IntroClip { end(): void; failPlay?: boolean }

function rig(opts: { failPlay?: boolean } = {}): Rig {
  const log: string[] = []
  const phases: IntroPhase[] = []
  const clips: FakeClip[] = []
  let resolveSpeak!: Rig['resolveSpeak']
  let rejectSpeak!: Rig['rejectSpeak']
  let releaseDuck!: () => void
  const deps: IntroDeps = {
    speak: (line) => {
      log.push(`speak:${line}`)
      return new Promise((res, rej) => { resolveSpeak = res; rejectSpeak = rej })
    },
    makeClip: (b64) => {
      let cb: (() => void) | null = null
      const clip: FakeClip = {
        play: async () => { log.push(`play-clip:${b64}`); if (opts.failPlay) throw new Error('NotAllowedError') },
        onEnd: (fn) => { cb = fn },
        attach: () => log.push('attach'),
        detach: () => log.push('detach'),
        release: () => log.push('release'),
        end: () => cb?.(),
      }
      clips.push(clip)
      return clip
    },
    emit: (e) => log.push(e),
    waitForDuck: () => new Promise<void>((r) => { releaseDuck = r }),
    playAlbum: () => log.push('play-album'),
    onPhase: (p) => phases.push(p),
    notice: (m) => log.push(`notice:${m}`),
  }
  return {
    deps, log, phases, clips,
    resolveSpeak: (r) => resolveSpeak(r),
    rejectSpeak: (e) => rejectSpeak(e),
    releaseDuck: () => releaseDuck(),
  }
}

const tick = () => new Promise((r) => setImmediate(r))

describe('the Music Man introduces the record', () => {
  test('his line → duck → speech → un-duck → the album from track 1', async () => {
    const r = rig()
    const intro = createMusicManIntro(r.deps)
    const run = intro.start('Tonight we do it properly.')
    assert.equal(intro.phase(), 'preparing')
    r.resolveSpeak({ ok: true, audio: 'MP3' })
    await tick()
    r.releaseDuck()
    await run
    assert.equal(intro.phase(), 'speaking')
    r.clips[0].end()
    assert.equal(intro.phase(), 'idle')
    assert.deepEqual(r.log, [
      'speak:Tonight we do it properly.',
      'musicman-speaking-start',
      'attach',
      'play-clip:MP3',
      'detach',
      'release',
      'musicman-speaking-end',
      'play-album',
    ])
    assert.deepEqual(r.phases, ['preparing', 'speaking', 'idle'])
  })

  test('a second start while he is on is ignored (the button reads "Stop" then)', async () => {
    const r = rig()
    const intro = createMusicManIntro(r.deps)
    void intro.start('one')
    void intro.start('two')
    assert.equal(r.log.filter((l) => l.startsWith('speak:')).length, 1)
  })
})

describe('cancel reverses every side effect of start', () => {
  test('while his voice is on its way: nothing was started, nothing plays, no stray un-duck', async () => {
    const r = rig()
    const intro = createMusicManIntro(r.deps)
    const run = intro.start('line')
    intro.cancel()
    assert.equal(intro.phase(), 'idle')
    r.resolveSpeak({ ok: true, audio: 'MP3' })
    await run
    assert.deepEqual(r.log, ['speak:line'])
    assert.equal(r.clips.length, 0)
  })

  test('while the music ducks: the duck is undone, no clip is made, nothing plays', async () => {
    const r = rig()
    const intro = createMusicManIntro(r.deps)
    const run = intro.start('line')
    r.resolveSpeak({ ok: true, audio: 'MP3' })
    await tick()
    intro.cancel()
    r.releaseDuck()
    await run
    assert.deepEqual(r.log, ['speak:line', 'musicman-speaking-start', 'musicman-speaking-end'])
    assert.equal(r.clips.length, 0)
    assert.equal(intro.phase(), 'idle')
  })

  test('mid-speech: clip unhooked, detached, released; un-duck; the album never starts', async () => {
    const r = rig()
    const intro = createMusicManIntro(r.deps)
    const run = intro.start('line')
    r.resolveSpeak({ ok: true, audio: 'MP3' })
    await tick()
    r.releaseDuck()
    await run
    intro.cancel()
    r.clips[0].end()                                       // a late 'ended' after cancel does nothing
    assert.deepEqual(r.log, ['speak:line', 'musicman-speaking-start', 'attach', 'play-clip:MP3', 'detach', 'release', 'musicman-speaking-end'])
    assert.ok(!r.log.includes('play-album'))
    assert.equal(intro.phase(), 'idle')
    intro.cancel()                                         // idempotent: no second un-duck
    assert.equal(r.log.filter((l) => l === 'musicman-speaking-end').length, 1)
  })
})

describe('failures never strand the button', () => {
  test('TTS refused: a notice, then the record anyway — and no duck was ever made', async () => {
    const r = rig()
    const intro = createMusicManIntro(r.deps)
    const run = intro.start('line')
    r.resolveSpeak({ ok: false, error: 'TTS rate limit' })
    await run
    assert.deepEqual(r.log, ['speak:line', 'notice:The Music Man can’t speak right now — playing the record.', 'play-album'])
    assert.equal(intro.phase(), 'idle')
  })

  test('TTS threw: same', async () => {
    const r = rig()
    const intro = createMusicManIntro(r.deps)
    const run = intro.start('line')
    r.rejectSpeak(new Error('ipc gone'))
    await run
    assert.ok(r.log.includes('play-album'))
    assert.ok(!r.log.includes('musicman-speaking-start'))
  })

  test('Voice off in Settings (empty clip): straight to the record, silently', async () => {
    const r = rig()
    const intro = createMusicManIntro(r.deps)
    const run = intro.start('line')
    r.resolveSpeak({ ok: true, audio: '' })
    await run
    assert.deepEqual(r.log, ['speak:line', 'play-album'])
  })

  test('a clip that will not start: undone like a natural end, then the record', async () => {
    const r = rig({ failPlay: true })
    const intro = createMusicManIntro(r.deps)
    const run = intro.start('line')
    r.resolveSpeak({ ok: true, audio: 'MP3' })
    await tick()
    r.releaseDuck()
    await run
    assert.deepEqual(r.log.slice(-4), ['detach', 'release', 'musicman-speaking-end', 'play-album'])
    assert.equal(intro.phase(), 'idle')
  })
})

/**
 * "Let the Music Man introduce it" (launch page "G", 2026-10-18).
 *
 * start(line): his line through the existing TTS path (musicman-speak — his
 * voice, his voice settings, pitch/pace knobs, the Voice toggle), with the
 * app-wide speech duck around it (musicman-speaking-start → Toolbar fades
 * the music down and answers musicman-fade-ready; musicman-speaking-end
 * fades it back), then the album from track 1.
 *
 * cancel() reverses every side effect start() made, in reverse order
 * (CLAUDE.md: every cancel path undoes its start path):
 *   - the TTS request in flight  → its answer is ignored (token bump)
 *   - the speech clip            → unhooked, detached from the broadcast graph,
 *                                  paused, its blob URL released, ref nulled
 *   - the duck                   → musicman-speaking-end, ONLY if we sent -start
 *                                  (a stray -end would un-duck someone else's speech)
 *   - the phase flag             → back to 'idle'
 *   - the album                  → never started
 * The Home calls cancel() on unmount and before its own Play button.
 *
 * Failures never strand the button: TTS refused / errored → a notice and the
 * record plays anyway (he was only ever the intro); Voice off in Settings
 * (an empty clip) → the record plays straight away.
 *
 * DOM-free — every effect is injected, so the sequencing runs under node:test
 * (src/main/__tests__/music-man-intro.test.ts).
 */

export type IntroPhase = 'idle' | 'preparing' | 'speaking'

/** One speech clip (the DOM side wraps audioFromBase64Mpeg + the broadcast graph). */
export interface IntroClip {
  play(): Promise<void>
  /** Called once when the clip ends or errors; null unhooks. */
  onEnd(cb: (() => void) | null): void
  /** Into / out of the broadcast graph (attachClipToBroadcast / detachClipFromBroadcast). */
  attach(): void
  detach(): void
  /** Pause and let go of the clip's media (its blob URL). */
  release(): void
}

export interface IntroDeps {
  speak: (line: string) => Promise<{ ok: boolean; audio?: string; error?: string }>
  makeClip: (base64Mpeg: string) => IntroClip
  emit: (event: 'musicman-speaking-start' | 'musicman-speaking-end') => void
  /** Resolves when the music has ducked (musicman-fade-ready) or after a cap. */
  waitForDuck: () => Promise<void>
  /** The album from track 1. */
  playAlbum: () => void
  onPhase: (phase: IntroPhase) => void
  notice: (message: string) => void
}

export interface MusicManIntro {
  start(line: string): Promise<void>
  cancel(): void
  phase(): IntroPhase
}

export function createMusicManIntro(deps: IntroDeps): MusicManIntro {
  let phase: IntroPhase = 'idle'
  let token = 0
  let clip: IntroClip | null = null
  let ducked = false

  const setPhase = (p: IntroPhase): void => {
    if (phase === p) return
    phase = p
    deps.onPhase(p)
  }

  /** Undo the clip + the duck (shared by finish and cancel). */
  function teardown(): void {
    if (clip) {
      const c = clip
      clip = null
      c.onEnd(null)
      c.detach()
      c.release()
    }
    if (ducked) {
      ducked = false
      deps.emit('musicman-speaking-end')
    }
  }

  function cancel(): void {
    token++
    teardown()
    setPhase('idle')
  }

  async function start(line: string): Promise<void> {
    if (phase !== 'idle') return
    const mine = ++token
    const live = (): boolean => mine === token
    setPhase('preparing')
    let tts: { ok: boolean; audio?: string; error?: string }
    try {
      tts = await deps.speak(line)
    } catch (err) {
      tts = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (!live()) return                                   // cancelled while his voice was on its way
    if (!tts.ok) {
      setPhase('idle')
      deps.notice('The Music Man can’t speak right now — playing the record.')
      deps.playAlbum()
      return
    }
    if (!tts.audio) {                                     // Voice is off in Settings
      setPhase('idle')
      deps.playAlbum()
      return
    }
    ducked = true
    deps.emit('musicman-speaking-start')
    await deps.waitForDuck()
    if (!live()) return                                   // cancel() already sent -end
    const c = deps.makeClip(tts.audio)
    clip = c
    c.attach()
    setPhase('speaking')
    const finish = (): void => {
      if (!live() || clip !== c) return
      token++
      teardown()
      setPhase('idle')
      deps.playAlbum()
    }
    c.onEnd(finish)
    try {
      await c.play()
    } catch {
      finish()                                            // a clip that won't start never strands the button
    }
  }

  return { start, cancel, phase: () => phase }
}

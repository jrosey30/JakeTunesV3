/**
 * 4.5 Radio rebuild (radioV2) — the RadioEngine.
 *
 * All radio orchestration in ONE place, out of the 1,733-line Toolbar: generate
 * a talk break, synthesize it, sequence the lines through the pill, manage the
 * show. Toolbar will just call start()/stop() (Phase 1's final wiring step).
 *
 * Phase 1 status: the PLAYBACK CORE below is implemented (generate → structure →
 * synthesize → sequence → stop), reproducing V1's behavior on the structured
 * data model + the unified cast registry. The LIFECYCLE (start / onTransition /
 * prefetch / clock) is the next step, ported faithfully from V1's Toolbar
 * orchestration. Generation here wraps the EXISTING musicman-radio (tagged text,
 * structured via the cast); Phase 2 swaps it for native JSON — no parsing.
 *
 * Reuses the proven primitives: musicmanSpeak (TTS), the activity.ts pill store,
 * the eq.ts broadcast audio routing, the stingers. NEVER pins Howler.ctx (see
 * feedback_audiocontext_pin) — it only routes <audio> elements into the existing
 * master analyser via attach*ToBroadcast.
 */
import type { RadioLine, RadioSegment, SpeakerId } from './types'
import { audioFromBase64Mpeg } from '../audio/base64-audio'
import { setBroadcastTimed, setRadio } from '../activity'
import { attachClipToBroadcast, attachAnnouncerToBroadcast, detachClipFromBroadcast } from '../audio/eq'
import { playStinger, randomPreStinger, randomEndStinger } from '../audio/stingers'

interface CastMember { id: string; tag: string; label: string; voiceId?: string; kind: string }

interface TrackMeta { title: string; artist: string; album: string; genre: string; year: string | number }

/** Inputs for one generated talk break — mirrors the musicman-radio IPC args. */
export interface SegmentRequest {
  track: TrackMeta
  nextTrack?: TrackMeta
  opener?: boolean
  forceAnnouncer?: boolean
  callerSegment?: boolean
  djHandsSegment?: boolean
  callerId?: string
  archetypeId?: string
  slot?: number
  hourCounter?: number
  miniId?: boolean
}

/** Strip inline audio tags ("[laughs]") so the pill caption is clean speech. */
function stripAudioTags(s: string): string {
  return s.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim()
}

export class RadioEngine {
  private byId = new Map<string, CastMember>()
  private byTag = new Map<string, CastMember>()
  private currentAudio: HTMLAudioElement | null = null
  private stopped = false
  private seq = 0
  private cache = new Map<string, RadioSegment>()
  private inFlight = new Set<string>()

  /** Load the cast registry once from main (the single source of truth). */
  async init(): Promise<void> {
    this.stopped = false
    try {
      const res = await window.electronAPI.radioGetCast()
      if (res?.ok && res.cast) {
        for (const m of res.cast) {
          this.byId.set(m.id, m)
          this.byTag.set(m.tag.toUpperCase(), m)
        }
      }
    } catch (err) {
      console.warn('[radioV2] cast load failed:', err)
    }
  }

  /** Generate one talk break: call the generator, structure its tagged text into
   *  a RadioSegment via the cast registry. (Phase 2 replaces this with native
   *  JSON generation — speaker becomes a real field, no parsing.) */
  async generateSegment(req: SegmentRequest): Promise<RadioSegment | null> {
    const res = await window.electronAPI.musicmanRadio(
      req.track, req.nextTrack, req.opener, req.forceAnnouncer, req.callerSegment,
      req.djHandsSegment, req.callerId, req.archetypeId, req.slot, req.hourCounter, req.miniId,
    )
    if (!res?.ok || !res.text) return null
    const lines = this.parse(res.text)
    if (!lines.length) return null
    return {
      id: `seg-${++this.seq}`,
      slot: req.slot ?? 0,
      archetypeId: req.archetypeId,
      speakers: [...new Set(lines.map((l) => l.speaker))],
      lines,
      prevTrack: `${req.track.title} — ${req.track.artist}`,
      nextTrack: req.nextTrack ? `${req.nextTrack.title} — ${req.nextTrack.artist}` : undefined,
    }
  }

  /** Tagged text → RadioLine[] via the cast tag set. An untagged line folds into
   *  the previous line (V1's safety net); a leading untagged line is dropped.
   *  This parsing only exists to bridge the V1 generator; Phase 2 deletes it. */
  private parse(text: string): RadioLine[] {
    const lines: RadioLine[] = []
    for (const raw of text.split('\n')) {
      const t = raw.trim()
      if (!t) continue
      const m = t.match(/^\[([A-Za-z_]+)\]\s*(.+)/)
      const member = m ? this.byTag.get(m[1].toUpperCase()) : undefined
      if (m && member) {
        lines.push({ speaker: member.id as SpeakerId, text: m[2].trim() })
      } else if (lines.length) {
        lines[lines.length - 1].text += ' ' + t
      }
    }
    return lines
  }

  /** TTS every line, in parallel with a small concurrency cap (matches V1). */
  async synthesize(seg: RadioSegment): Promise<void> {
    const CAP = 4
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < seg.lines.length) {
        const line = seg.lines[i++]
        if (!line) break
        const voiceId = this.byId.get(line.speaker)?.voiceId
        try {
          const tts = await window.electronAPI.musicmanSpeak(line.text, false, voiceId)
          if (tts.ok && tts.audio) line.audio = tts.audio
          else console.warn(`[radioV2] TTS dropped [${line.speaker}]:`, tts.error || '')
        } catch (err) {
          console.warn(`[radioV2] TTS error [${line.speaker}]:`, err)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CAP, seg.lines.length) }, () => worker()))
  }

  /** Play a segment's lines in order — the sequencer. Phase 1 reproduces V1
   *  (strictly sequential). Phase 2 adds intentional inter-line beats and REAL
   *  overlap when `line.overlap` is set (the stiff-pacing fix). */
  async playSegment(seg: RadioSegment): Promise<void> {
    for (const line of seg.lines) {
      if (this.stopped) return
      if (!line.audio) continue
      await this.playLine(line)
    }
  }

  private playLine(line: RadioLine): Promise<void> {
    return new Promise((resolve) => {
      const member = this.byId.get(line.speaker)
      const caption = stripAudioTags(line.text)
      const audio = audioFromBase64Mpeg(line.audio || '')
      this.currentAudio = audio
      const finish = (): void => {
        try { detachClipFromBroadcast(audio) } catch { /* ignore */ }
        resolve()
      }
      const sync = async (): Promise<void> => {
        await this.waitMeta(audio)
        const durationMs = audio.duration > 0 && !isNaN(audio.duration) ? audio.duration * 1000 : 3000
        line.durationMs = durationMs
        setBroadcastTimed({ speaker: member?.label || '', text: caption }, durationMs)
      }
      if (line.speaker === 'announcer') {
        attachAnnouncerToBroadcast(audio)
        const preDur = playStinger(randomPreStinger())
        audio.onended = () => { playStinger(randomEndStinger()); setTimeout(finish, 200) }
        audio.onerror = finish
        void sync()
        setTimeout(() => { audio.play().catch(() => finish()) }, Math.max(50, preDur * 700))
      } else {
        attachClipToBroadcast(audio)
        audio.onended = finish
        audio.onerror = finish
        void sync().then(() => { audio.play().catch(() => finish()) })
      }
    })
  }

  private waitMeta(audio: HTMLAudioElement): Promise<void> {
    if (!isNaN(audio.duration) && audio.duration > 0) return Promise.resolve()
    return new Promise((resolve) => {
      const onMeta = (): void => { audio.removeEventListener('loadedmetadata', onMeta); resolve() }
      audio.addEventListener('loadedmetadata', onMeta)
      setTimeout(() => { audio.removeEventListener('loadedmetadata', onMeta); resolve() }, 1000)
    })
  }

  /** Pre-generate + synthesize the next break into the cache so transitions are
   *  instant. Guarded against double-fetch (matches V1's prefetch). */
  async prefetch(req: SegmentRequest, cacheKey: string): Promise<void> {
    if (this.cache.has(cacheKey) || this.inFlight.has(cacheKey)) return
    this.inFlight.add(cacheKey)
    try {
      const seg = await this.generateSegment(req)
      if (seg) {
        await this.synthesize(seg)
        if (seg.lines.some((l) => l.audio)) this.cache.set(cacheKey, seg)
      }
    } catch (err) {
      console.warn('[radioV2] prefetch failed:', err)
    } finally {
      this.inFlight.delete(cacheKey)
    }
  }

  /** Play the talk break for a track transition: use the prefetched segment if
   *  ready, else generate + synthesize live. Returns true if anything played.
   *  The caller starts the next track after this resolves — the banter fills the
   *  dead-air gap between songs, so no ducking is needed. */
  async handleTransition(req: SegmentRequest, cacheKey: string): Promise<boolean> {
    this.stopped = false
    let seg: RadioSegment | undefined = this.cache.get(cacheKey)
    if (seg) this.cache.delete(cacheKey)
    if (!seg) {
      seg = (await this.generateSegment(req)) ?? undefined
      if (seg) await this.synthesize(seg)
    }
    if (!seg || !seg.lines.some((l) => l.audio)) return false
    await this.playSegment(seg)
    return true
  }

  /** Generate + play the show open (called when radio starts). */
  async playOpener(req: SegmentRequest): Promise<boolean> {
    this.stopped = false
    const seg = await this.generateSegment({ ...req, opener: true })
    if (!seg) return false
    await this.synthesize(seg)
    if (!seg.lines.some((l) => l.audio)) return false
    await this.playSegment(seg)
    return true
  }

  /** Stop the current line, drop the prefetch cache, clear the pill status. */
  stop(): void {
    this.stopped = true
    if (this.currentAudio) {
      try { this.currentAudio.pause() } catch { /* ignore */ }
      try { detachClipFromBroadcast(this.currentAudio) } catch { /* ignore */ }
      this.currentAudio = null
    }
    this.cache.clear()
    this.inFlight.clear()
    setRadio(null)
  }

  // The React triggers — the track-change / 120s-remaining prefetch effects, the
  // musicman-dj-transition listener (which calls handleTransition then starts the
  // next track), the slot-param hour-clock, and the 90-min cap/tick that drives
  // setRadio status — stay in Toolbar for Phase 1; they're the unavoidable React/
  // playback glue. This engine owns all the actual WORK: generate → structure →
  // synthesize → sequence → cache. Phase 2/3 can thin the glue further.
}

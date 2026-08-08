/**
 * TapeMonitor — TRUE tape physics, enforced (Jake: "absolutely true time
 * limits on side A and B. if i run out of space. too bad.").
 *
 * Always mounted (renders nothing). While a mixtape play session is
 * active, watches the live playback position; when the boundary song
 * reaches the moment the cassette runs out, it CUTS — mid-word,
 * mid-chorus, wherever the tape ends:
 *   Side A boundary → NEXT_TRACK (the flip to Side B)
 *   Side B boundary → STOP (that's the whole tape)
 * The session dies the moment playback leaves the tape's tracks — pick
 * any other song and you've ejected the cassette.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { effectiveDurationFn } from '../../common/tape-physics'
import { getTapeSession, setTapeSession, getMixtapes, getPendingTapeSeek, setPendingTapeSeek, subscribeMixtapes } from '../mixtapes'
import { initTapeDeck, tapeMotorStart, tapeFlipRitual } from '../tapeDeck'

// Cassette voicing rides the same session lifecycle this monitor enforces.
initTapeDeck()

export default function TapeMonitor() {
  const { state: lib } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { seek } = useAudio()
  const seekedForRef = useRef<number | null>(null)
  const session = useSyncExternalStore(subscribeMixtapes, getTapeSession)
  const mixtapes = useSyncExternalStore(subscribeMixtapes, getMixtapes)
  // Talkovers already played this session (one shot each per playthrough)
  // + live overlay audio elements for cleanup.
  const playedTalkRef = useRef<Set<string>>(new Set())
  const overlayRef = useRef<HTMLAudioElement[]>([])
  // A cut fires once per landing on the boundary song. Re-arm when the
  // playing track changes (rewinding the tape lets it cut again — physics).
  const firedForRef = useRef<number | null>(null)

  const nowId = pb.nowPlaying?.id

  useEffect(() => {
    if (firedForRef.current !== null && firedForRef.current !== nowId) {
      firedForRef.current = null
    }
    if (seekedForRef.current !== null && seekedForRef.current !== nowId) {
      seekedForRef.current = null
    }
  }, [nowId])
  const nowIdRef = useRef<number | undefined>(nowId)
  nowIdRef.current = nowId

  // The motor is lazy: every time the music STARTS while a tape is in
  // (play, resume after pause, landing after a wind), it drawls up to
  // speed — no matter which button did it, even the toolbar's.
  const wasPlayingRef = useRef(false)
  useEffect(() => {
    const playing = pb.isPlaying
    if (playing && !wasPlayingRef.current && getTapeSession()) tapeMotorStart()
    wasPlayingRef.current = playing
  }, [pb.isPlaying])

  // Session changed → fresh playthrough: reset one-shots, kill overlays.
  useEffect(() => {
    playedTalkRef.current = new Set()
    for (const a of overlayRef.current) a.pause()
    overlayRef.current = []
  }, [session])
  useEffect(() => () => { for (const a of overlayRef.current) a.pause() }, [])

  useEffect(() => {
    if (!session || nowId == null) return
    // Ejected: playback left the tape entirely.
    //
    // Two independent tests, because "is this song on the tape?" is not the
    // same question as "am I playing the tape?".
    //
    // 2026-08-08 — Jake made a tape out of a WHOLE album (all 8 Jigitz
    // tracks of "all my exes live in brooklyn"), then went to the songs
    // list to hear one of them on its own. Every song he could click was on
    // the tape, so the id test below never fired: the session stayed alive
    // and the deck kept running the cassette over ordinary playback. The
    // pill scrubbed across all of Side B (13:04) instead of the 2:24 track,
    // talkovers fired, and the no-skip law held him in. "booooooo."
    //
    // The queue is the honest signal. Starting a tape installs exactly the
    // tape's tracks as the queue (MixtapeView.startQueueAt); playing from
    // anywhere else installs that place's list. Compared as a SET, not in
    // order, so shuffling the tape's own queue doesn't read as an eject.
    const tapeIds = new Set(session.tapeTrackIds)
    const queueIsTheTape = pb.queue.length === session.tapeTrackIds.length
      && pb.queue.every((t) => tapeIds.has(t.id))
    if (!queueIsTheTape || !session.tapeTrackIds.includes(nowId)) {
      setTapeSession(null)
      for (const a of overlayRef.current) a.pause()
      overlayRef.current = []
      return
    }
    // ── Talkovers: Jake's voice, laid down WITH the music, plays over
    // the song at its pinned spot on the side. Fire when the tape's
    // side-elapsed crosses atMs (position ticks ~1s — tape-accurate).
    const tape = mixtapes.find((m) => m.id === session.mixtapeId)
    // Spooling: a FF/REW that crossed into this slot seeks mid-song the
    // moment it starts — the tape lands wherever the reels stopped.
    const psk = getPendingTapeSeek()
    if (psk && psk.trackId === nowId) {
      const durMs = lib.tracks.find((t) => t.id === nowId)?.duration || 0
      if (durMs > 0 && pb.position * 1000 < psk.seekMs - 500) {
        seek(Math.min(0.99, psk.seekMs / durMs))
      }
      setPendingTapeSeek(null)
      seekedForRef.current = nowId // suppress the offset auto-seek for this landing
    }
    // A slot recorded mid-song plays from its offset — seek there once
    // when the track starts (the tape only has the tail).
    if (tape) {
      const off = tape.startOffsets?.[String(nowId)] || 0
      if (off > 0 && seekedForRef.current !== nowId && pb.position * 1000 < off - 1500) {
        const durMs = lib.tracks.find((t) => t.id === nowId)?.duration || 0
        if (durMs > 0) {
          seekedForRef.current = nowId
          seek(Math.min(0.99, off / durMs))
        }
      }
      if (seekedForRef.current !== null && seekedForRef.current !== nowId && (tape.startOffsets?.[String(seekedForRef.current)] || 0) > 0) {
        // moved on — allow a future replay of that slot to seek again
      }
    }
    if (tape?.talkovers?.length) {
      const side: 'A' | 'B' | null = tape.sideA.includes(nowId) ? 'A' : tape.sideB.includes(nowId) ? 'B' : null
      if (side) {
        const effDur = effectiveDurationFn((id) => lib.tracks.find((t) => t.id === id)?.duration || undefined, tape.startOffsets)
        const ids = side === 'A' ? tape.sideA : tape.sideB
        const idx = ids.indexOf(nowId)
        let before = 0
        for (let i = 0; i < idx; i++) before += effDur(ids[i])
        const off = tape.startOffsets?.[String(nowId)] || 0
        const elapsed = before + Math.max(0, pb.position * 1000 - off)
        for (const tk of tape.talkovers) {
          if (tk.side !== side) continue
          const key = `${tk.side}|${tk.atMs}|${tk.path}`
          if (playedTalkRef.current.has(key)) continue
          if (elapsed >= tk.atMs && elapsed - tk.atMs < 4000) {
            playedTalkRef.current.add(key)
            const a = new Audio('ipod-audio://' + encodeURIComponent(tk.path))
            overlayRef.current.push(a)
            a.onended = () => { overlayRef.current = overlayRef.current.filter((x) => x !== a) }
            void a.play().catch(() => {})
          }
        }
      }
    }
    const cut = session.cuts.find((c) => c.trackId === nowId)
    if (!cut || firedForRef.current === nowId) return
    if (pb.position >= cut.cutSec) {
      firedForRef.current = nowId
      if (cut.thenStop) {
        pbDispatch({ type: 'STOP' })
        setTapeSession(null)
      } else {
        // Side A runs out → THE FLIP. The deck ducks to dead air and plays
        // the whole ritual (door, cassette turned in hand, door, PLAY);
        // Side B's first song starts when the duck lifts — from 0:00, the
        // way Side B always did. If the user grabs the transport or the
        // boundary song ends naturally during the ritual, we stand down.
        const sessionAtCut = session
        const idAtCut = nowId
        tapeFlipRitual()
        window.setTimeout(() => {
          if (getTapeSession() === sessionAtCut && nowIdRef.current === idAtCut) {
            pbDispatch({ type: 'NEXT_TRACK' })
          }
        }, 1380)
      }
    }
  }, [session, nowId, pb.position, pb.queue, pbDispatch, mixtapes, lib.tracks, seek])

  return null
}

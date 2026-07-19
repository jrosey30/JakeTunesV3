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
import { usePlayback } from '../context/PlaybackContext'
import { getTapeSession, setTapeSession, subscribeMixtapes } from '../mixtapes'

export default function TapeMonitor() {
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const session = useSyncExternalStore(subscribeMixtapes, getTapeSession)
  // A cut fires once per landing on the boundary song. Re-arm when the
  // playing track changes (rewinding the tape lets it cut again — physics).
  const firedForRef = useRef<number | null>(null)

  const nowId = pb.nowPlaying?.id

  useEffect(() => {
    if (firedForRef.current !== null && firedForRef.current !== nowId) {
      firedForRef.current = null
    }
  }, [nowId])

  useEffect(() => {
    if (!session || nowId == null) return
    // Ejected: playback left the tape entirely.
    if (!session.tapeTrackIds.includes(nowId)) {
      setTapeSession(null)
      return
    }
    const cut = session.cuts.find((c) => c.trackId === nowId)
    if (!cut || firedForRef.current === nowId) return
    if (pb.position >= cut.cutSec) {
      firedForRef.current = nowId
      if (cut.thenStop) {
        pbDispatch({ type: 'STOP' })
        setTapeSession(null)
      } else {
        pbDispatch({ type: 'NEXT_TRACK' })
      }
    }
  }, [session, nowId, pb.position, pbDispatch])

  return null
}

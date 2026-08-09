/**
 * MixtapeView — the cassette itself. Shell + rotating spools + the
 * handwritten label, then the unfolded J-card: dedication, Music Man's
 * blurb, ONE tracklist with liner-note scribbles.
 *
 * 2026-08-08: no more Side A / Side B. A tape is one sequence of at most 25
 * songs, merged into one gapless file that plays start to finish. Tapes Jake
 * recorded under the two-sided rules are grandfathered — read through
 * tapeTracks(), played song-by-song, and still dubbed as two sides, because
 * that is physically what they are.
 *
 * Play Tape: Jake's 1979 intro first (if recorded), then the tape.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import ConfirmDialog from '../components/ConfirmDialog'
import MixtapeSheet from '../components/MixtapeSheet'
import { getMixtapeId, getMixtapes, getDeckState, subscribeMixtapes, refreshMixtapes, pickInk, setTapeSession, setDeckState, liveTapeCounter, spoolTarget, setPendingTapeSeek, setWindDisplay } from '../mixtapes'
import { startWindSound, stopWindSound, mechanicalSound, tapeMotorPause } from '../tapeDeck'
import { effectiveDurationFn, tapeTracks } from '../../common/tape-physics'
import type { Track, Mixtape } from '../types'
import '../styles/mixtape.css'

function fmt(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The cassette mark — a QUIET nod, not a prop.
 *
 * 2026-08-09, Jake: the tape pages were "corny, tacky and gross. need a
 * complete redo", and he chose to keep a tape FEEL done tastefully. This
 * used to be a 320x200 moulded plastic shell: two-tone body, four screws, a
 * ruled paper label, a black window, hub teeth, a brown ribbon and the
 * bottom capstan holes. Photorealism at that size reads as clip art.
 *
 * What's left is the SILHOUETTE: the outline, two reels and the ribbon
 * between them, drawn in the page's own ink at the tape's accent colour.
 * The reels still turn while the tape rolls and race while it winds —
 * motion was never the tacky part.
 */
export function CassetteSvg({ ink, spinning, wind }: {
  ink: string
  spinning: boolean
  /** Winding: 1 = FF (fast), -1 = REW (fast, reversed), undefined = normal. */
  wind?: 1 | -1
}) {
  const spoolCls = spinning || wind
    ? `spool spool--spin${wind ? ' spool--fast' : ''}${wind === -1 ? ' spool--rev' : ''}`
    : 'spool'
  const hub = (cx: number) => (
    <g className={spoolCls} style={{ transformOrigin: `${cx}px 34px` }}>
      <circle cx={cx} cy="34" r="11" fill="none" stroke={ink} strokeWidth="1.5" opacity="0.9" />
      {[0, 60, 120].map((a) => (
        <line key={a} x1={cx} y1="25" x2={cx} y2="43" stroke={ink} strokeWidth="1.5"
          opacity="0.5" transform={`rotate(${a} ${cx} 34)`} />
      ))}
    </g>
  )
  return (
    <svg className="cassette" viewBox="0 0 120 68" width="120" height="68" aria-hidden>
      <rect x="1.5" y="1.5" width="117" height="65" rx="7"
        fill="none" stroke={ink} strokeWidth="1.5" opacity="0.55" />
      {hub(42)}
      {hub(78)}
      <line x1="53" y1="34" x2="67" y2="34" stroke={ink} strokeWidth="2.5" opacity="0.35" />
    </svg>
  )
}

export default function MixtapeView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb } = usePlayback()
  const { playTrack, togglePlayPause, stopPlayback, seek } = useAudio()
  const mixtapes = useSyncExternalStore(subscribeMixtapes, getMixtapes)
  const mixtapeId = useSyncExternalStore(subscribeMixtapes, getMixtapeId)
  const deckState = useSyncExternalStore(subscribeMixtapes, getDeckState)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const mixPageRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('mixtapes-page', mixPageRef)
  // Inline rename (2026-07-31, Jake: "ability to name my mixtapes"). Inline
  // input, never window.prompt — that returns null silently in Electron's
  // renderer and the rename would just quietly not happen.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [remixing, setRemixing] = useState(false)
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    window.electronAPI.listMixtapeVoices?.().then((r) => { if (r?.ok) setVoices(r.voices) }).catch(() => {})
  }, [])
  const [dubbing, setDubbing] = useState(false)
  const [dubNotice, setDubNotice] = useState('')
  const mountRef = useRef<string>('')
  useEffect(() => {
    window.electronAPI?.getMusicLibraryPath?.().then((p: string) => { mountRef.current = p }).catch(() => {})
  }, [])
  const [introPlaying, setIntroPlaying] = useState(false)
  const introRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => { void refreshMixtapes() }, [])
  // Cancel mirrors start: leaving the view kills a playing intro.
  useEffect(() => () => {
    if (introRef.current) { introRef.current.pause(); introRef.current = null }
  }, [])

  const tape: Mixtape | undefined = mixtapes.find((m) => m.id === mixtapeId)

  const byId = useMemo(() => new Map(lib.tracks.map((t) => [t.id, t])), [lib.tracks])
  const sideATracks = useMemo(() => (tape?.sideA || []).map((id) => byId.get(id)).filter((t): t is Track => !!t), [tape, byId])
  const sideBTracks = useMemo(() => (tape?.sideB || []).map((id) => byId.get(id)).filter((t): t is Track => !!t), [tape, byId])
  // The tape in play order. tapeTracks() reads `tracks` on tapes made under
  // the 2026-08-08 rules and falls back to A-then-B for the ones Jake
  // recorded before that, which is the order they always played in.
  const allTracks = useMemo(
    () => (tape ? tapeTracks(tape).map((id) => byId.get(id)).filter((t): t is Track => !!t) : []),
    [tape, byId],
  )
  const notes = useMemo(() => new Map((tape?.linerNotes || []).map((n) => [n.id, n.note])), [tape])

  // SPOOL WIND — holding FF/REW winds the tape for real: the head lifts
  // (playback pauses), the spools accelerate 8x→32x, the deck squeals,
  // and the counter races. Release and playback drops in wherever the
  // ribbon landed — mid-song, next song, wherever. One ribbon.
  const [winding, setWinding] = useState<null | { dir: 1 | -1; usedMs: number }>(null)
  const windTimer = useRef<number | null>(null)
  const windMeta = useRef<{ wasPlaying: boolean; startedAt: number }>({ wasPlaying: false, startedAt: 0 })
  // Leaving the view mid-wind: kill the motor (mirrors start, house rule).
  useEffect(() => () => {
    if (windTimer.current != null) { clearInterval(windTimer.current); windTimer.current = null; stopWindSound() }
  }, [])

  const stopIntro = useCallback(() => {
    if (introRef.current) { introRef.current.pause(); introRef.current = null }
    setIntroPlaying(false)
  }, [])

  /**
   * Start the tape. ALWAYS from the top — Jake, 2026-08-08: "you cant start
   * from anywhere either. has to be from the beginning."
   *
   * The songs stay separate files and play as an ordinary queue; what makes
   * this a TAPE is the presentation (one continuous length in the pill) and
   * the rules (no skipping), not the audio. An earlier pass here actually
   * concatenated the tape into a single ALAC and played that — wrong: "they
   * arent actually merged, but if i want to export it as a merged file, i
   * can."
   */
  const startQueueAt = useCallback((_idx?: number) => {
    stopIntro()
    const t = allTracks[0]
    if (!t || !tape) return
    // TRUE tape physics: arm the cut points before the reels move. The
    // Side A cut is the flip; the Side B cut is the end of the tape.
    // A boundary song with a start offset plays from the offset — its
    // cut lands at offset + tape-remaining in SONG time.
    const cutPos = (id: number, cutMs: number) => ((tape.startOffsets?.[String(id)] || 0) + cutMs) / 1000
    const cuts: Array<{ trackId: number; cutSec: number; thenStop: boolean }> = []
    if (tape.sideACutMs && tape.sideA.length > 0) {
      const id = tape.sideA[tape.sideA.length - 1]
      cuts.push({ trackId: id, cutSec: cutPos(id, tape.sideACutMs), thenStop: false })
    }
    if (tape.sideBCutMs && tape.sideB.length > 0) {
      const id = tape.sideB[tape.sideB.length - 1]
      cuts.push({ trackId: id, cutSec: cutPos(id, tape.sideBCutMs), thenStop: true })
    }
    setTapeSession({ mixtapeId: tape.id, tapeTrackIds: allTracks.map((x) => x.id), cuts })
    playTrack(t, allTracks, 0, undefined, true)
  }, [allTracks, playTrack, stopIntro, tape])

  // EXPORT AS ONE FILE — the tape rendered to a single continuous audio
  // file on the Desktop (intro at the head, talkovers mixed at their pins,
  // offsets honored). Jake, 2026-08-08: the tape is NOT merged for playback
  // — "they arent actually merged, but if i want to export it as a merged
  // file, i can." This is that export, and it is the only one: a second
  // merge-for-playback path briefly existed here and has been removed.
  const dubToCassette = async () => {
    if (!tape || dubbing) return
    setDubbing(true)
    setDubNotice('Exporting… rendering the tape.')
    try {
      const abs = (t: Track) => mountRef.current + String(t.path || '').replace(/:/g, '/')
      const mkSide = (label: 'A' | 'B', tracksOnSide: Track[], cutMs?: number) => ({
        label,
        songs: tracksOnSide.map((t, i) => ({
          absPath: abs(t),
          cutMs: cutMs !== undefined && i === tracksOnSide.length - 1 ? cutMs : undefined,
          startMs: tape.startOffsets?.[String(t.id)] || undefined,
        })),
        talkovers: (tape.talkovers || []).filter((tv) => tv.side === label).map((tv) => ({ atMs: tv.atMs, path: tv.path })),
        introPath: label === 'A' ? tape.introPath : undefined,
      })
      // A tape made under the 2026-08-08 rules is one continuous run, so it
      // dubs as ONE file. A grandfathered two-sided tape still dubs as two,
      // because that's physically what it is.
      const twoSided = !Array.isArray(tape.tracks) && (tape.sideA.length > 0 || tape.sideB.length > 0)
      const r = await window.electronAPI.dubMixtape?.({
        title: tape.title,
        sides: twoSided
          ? [mkSide('A', sideATracks, tape.sideACutMs), mkSide('B', sideBTracks, tape.sideBCutMs)]
          : [mkSide('A', allTracks, undefined)],
      })
      setDubNotice(r?.ok
        ? `Exported to Desktop → JakeTunes Dubs → ${tape.title}.`
        : (r?.error || 'Export failed.'))
    } catch (err) {
      setDubNotice(String(err))
    }
    setDubbing(false)
    setTimeout(() => setDubNotice(''), 12_000)
  }

  const playTape = useCallback(() => {
    if (allTracks.length === 0) return
    if (tape?.introPath) {
      stopIntro()
      const a = new Audio('ipod-audio://' + encodeURIComponent(tape.introPath))
      introRef.current = a
      setIntroPlaying(true)
      a.onended = () => { setIntroPlaying(false); introRef.current = null; startQueueAt(0) }
      void a.play().catch(() => { setIntroPlaying(false); introRef.current = null; startQueueAt(0) })
    } else {
      startQueueAt(0)
    }
  }, [allTracks.length, tape, startQueueAt, stopIntro])

  if (!tape) {
    return <div className="mixtape-view"><div className="mixtape-missing">That tape isn't on the shelf anymore.</div></div>
  }

  const ink = tape.inkColor || pickInk(tape.id)
  const currentId = pb.nowPlaying?.id
  const onThisTape = currentId != null && tapeTracks(tape).includes(currentId)
  const tapeActive = introPlaying || (onThisTape && pb.isPlaying)
  // The spools spin; there is no side to letter any more.
  const side: 'A' | 'B' | null = tapeActive ? 'A' : null
  const nowSongId = currentId
  const effDur = effectiveDurationFn((id) => byId.get(id)?.duration || undefined, tape.startOffsets)
  const tapeDur = allTracks.reduce((s, t) => s + effDur(t.id), 0)

  // ONE tracklist — the J-card no longer splits at a flip (2026-08-08).
  // The merged-tape song, if one is playing, is resolved from cues rather
  // than from nowPlaying (which is the tape itself).
  const renderTracklist = () => (
    <div className="jcard-side">
      <div className="jcard-side-head">
        <span className="jcard-side-label" style={{ color: ink }}>THE TAPE</span>
        <span className="jcard-side-time">{allTracks.length} song{allTracks.length === 1 ? '' : 's'} · {fmt(tapeDur)}</span>
      </div>
      {allTracks.map((t, i) => {
        const isNow = nowSongId === t.id
        return (
          <div key={t.id} className={`jcard-row${isNow ? ' jcard-row--now' : ''}`}>
            <span className="jcard-row-num">{i + 1}.</span>
            <span className="jcard-row-title">{t.title}</span>
            <span className="jcard-row-artist">{t.artist}</span>
            <span className="jcard-row-time">{fmt(effDur(t.id))}</span>
            {(tape.startOffsets?.[String(t.id)] || 0) > 0 && (
              <span className="jcard-row-note" style={{ color: ink }}>picked up mid-song — from {fmt(tape.startOffsets![String(t.id)])}</span>
            )}
            {notes.has(t.id) && <span className="jcard-row-note" style={{ color: ink }}>{notes.get(t.id)}</span>}
          </div>
        )
      })}
    </div>
  )

  // Save through the existing mixtape-save, which already does a read-modify-
  // write by id — so renaming can't disturb sides, liner notes or the intro.
  // Empty/unchanged input is a no-op, not a blank tape name.
  const commitRename = async (): Promise<void> => {
    const next = (renaming ?? '').trim()
    setRenaming(null)
    if (!next || !tape || next === tape.title) return
    await window.electronAPI.saveMixtape?.({ ...tape, title: next })
    await refreshMixtapes()
  }

  return (
    <div className="mixtape-view" ref={mixPageRef}>
      <div className="mixtape-hero">
        <CassetteSvg ink={ink} spinning={tapeActive} wind={winding?.dir} />
        <div className="mixtape-hero-info">
          {renaming !== null ? (
            <input
              className="mixtape-title mixtape-title--edit"
              value={renaming}
              autoFocus
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
                if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
              }}
              aria-label="Mixtape name"
            />
          ) : (
            <h1
              className="mixtape-title mixtape-title--editable"
              title="Click to rename"
              onClick={() => setRenaming(tape.title)}
            >{tape.title}</h1>
          )}
          {tape.dedication && <div className="mixtape-dedication" style={{ color: ink }}>for: {tape.dedication}</div>}
          <p className="mixtape-commentary">{tape.commentary}</p>
          {(() => {
            const loaded = deckState?.mixtapeId === tape.id
            const armed = loaded && !!deckState?.recArmed
            const micOn = loaded && !!deckState?.micOn
            const load = (over: { recArmed?: boolean; micOn?: boolean; micVoiceId?: string }) => {
              const cur = getDeckState()
              if (cur?.mixtapeId === tape.id) setDeckState({ ...cur, ...over })
              else setDeckState({ mixtapeId: tape.id, recArmed: false, micOn: false, ...over })
            }
            // "On the tape" covers both playback shapes: the merged tape
            // (nowPlaying IS the tape) and a per-song queue (old/unmerged).
            const currentOnTape = onThisTape
            const pressPlay = () => {
              if (armed) { if (!pb.isPlaying && pb.nowPlaying) togglePlayPause(); return }
              if (currentOnTape) { if (!pb.isPlaying) togglePlayPause(); return }
              playTape()
            }
            // SPOOL WIND — hold FF/REW and the tape WINDS (Jake: "like an
            // actual tape... thats how old mixtapes merge with each other").
            // The head lifts, the spools accelerate, the deck squeals;
            // release and you land wherever the ribbon stopped — straight
            // through the middle of songs. Locked while REC is latched.
            const WIND_TICK = 90
            const startWind = (dir: 1 | -1) => {
              if (armed || winding) return
              // Winds the WHOLE tape now — one ribbon, no sides (2026-08-08).
              const tapeTotal = allTracks.reduce((sum, t) => sum + effDur(t.id), 0)
              if (tapeTotal <= 0) return
              windMeta.current = { wasPlaying: pb.isPlaying, startedAt: Date.now() }
              if (pb.isPlaying) togglePlayPause()
              startWindSound()
              setWinding({ dir, usedMs: counter.elapsedMs })
              setWindDisplay({ posMs: counter.elapsedMs })
              windTimer.current = window.setInterval(() => {
                setWinding((w) => {
                  if (!w) return w
                  const held = (Date.now() - windMeta.current.startedAt) / 1000
                  const speed = Math.min(32, 8 * Math.pow(2, held))
                  const next = w.usedMs + w.dir * speed * WIND_TICK
                  const clamped = Math.max(0, Math.min(tapeTotal - 1500, next))
                  setWindDisplay({ posMs: clamped })
                  return { ...w, usedMs: clamped }
                })
              }, WIND_TICK)
            }
            const finishWind = () => {
              if (!winding) return
              if (windTimer.current != null) { clearInterval(windTimer.current); windTimer.current = null }
              stopWindSound()
              setWindDisplay(null)
              const { usedMs } = winding
              setWinding(null)
              const durOfId = (id: number) => byId.get(id)?.duration || undefined
              const tgt = spoolTarget(tape, usedMs, 0, durOfId)
              if (!tgt) return
              if (currentId === tgt.trackId) {
                const durMs = byId.get(tgt.trackId)?.duration || 0
                if (durMs > 0) seek(Math.min(0.99, tgt.fileSeekMs / durMs))
                if (windMeta.current.wasPlaying && !pb.isPlaying) togglePlayPause()
                return
              }
              // landed past a splice: drop in mid-song on that slot
              const idx = allTracks.findIndex((t) => t.id === tgt.trackId)
              if (idx < 0) return
              setPendingTapeSeek({ trackId: tgt.trackId, seekMs: tgt.fileSeekMs })
              startQueueAt(idx)
            }
            const rolling = armed && pb.isPlaying
            // The counter window — how much tape is left on this side,
            // rolling live while the tail song records or plays.
            const counter = liveTapeCounter(
              tape, currentId, pb.position, pb.isPlaying,
              (id: number) => byId.get(id)?.duration || undefined,
            )
            const displayLeft = Math.max(0, counter.totalMs - counter.elapsedMs)
            return (
              <>
                <div className="faceplate">
                  {/* The A/B tabs are gone — a tape is one sequence now, so
                      there is nothing to flip to (2026-08-08). */}
                  <div className={`fp-counter${rolling || winding ? ' fp-counter--rolling' : ''}`}
                    title="How much tape is on this reel — rolls while you record">
                    <span className="fp-counter-side">{counter.songs}/{counter.maxSongs}</span>
                    <span className="fp-counter-digits">
                      {winding
                        ? fmt(winding.usedMs)
                        : pb.isPlaying && currentOnTape
                          ? fmt(displayLeft)
                          : fmt(counter.totalMs)}
                    </span>
                    <span className="fp-counter-sub">
                      {winding
                        ? (winding.dir > 0 ? '›› winding' : '‹‹ winding')
                        : counter.songsLeft === 0
                          ? 'tape full'
                          : pb.isPlaying && currentOnTape ? 'left' : `${counter.songsLeft} more fit`}
                    </span>
                  </div>
                  <button className={`fp-key fp-key--rec${armed ? ' is-down' : ''}`} onClick={() => { mechanicalSound('rec'); load({ recArmed: !armed }) }}
                    title="RECORD — whatever plays goes on this tape. Press mid-song and it records from right there.">
                    <span className="fp-shape fp-shape--circle" /><span className="fp-label">REC</span>
                  </button>
                  <button className={`fp-key${winding?.dir === -1 ? ' is-down' : ''}`} disabled={armed}
                    onMouseDown={() => startWind(-1)} onMouseUp={finishWind} onMouseLeave={finishWind}
                    title="REWIND — hold it down and the tape winds back, screaming past the song joins. Let go to drop back in. Locked while REC is down.">
                    <span className="fp-shape fp-shape--rew" /><span className="fp-label">REW</span>
                  </button>
                  <button className="fp-key fp-key--play" onClick={() => { mechanicalSound('play'); pressPlay() }}
                    title={armed ? 'PLAY — roll the music you are recording' : 'PLAY — play this tape'}>
                    <span className="fp-shape fp-shape--tri" /><span className="fp-label">PLAY</span>
                  </button>
                  <button className={`fp-key${winding?.dir === 1 ? ' is-down' : ''}`} disabled={armed}
                    onMouseDown={() => startWind(1)} onMouseUp={finishWind} onMouseLeave={finishWind}
                    title="FAST-FORWARD — hold it down and the tape winds ahead, straight through the middle of songs. Let go to drop back in. Locked while REC is down.">
                    <span className="fp-shape fp-shape--ff" /><span className="fp-label">FF</span>
                  </button>
                  <button className={`fp-key fp-key--mic${micOn ? ' is-down' : ''}`} onClick={() => { mechanicalSound('mic'); load({ micOn: !micOn }) }}
                    title="MIC — mic on means mic ready. Your voice records onto the tape only while REC is down.">
                    <span className="fp-shape fp-shape--mic"><MicShape /></span><span className="fp-label">MIC</span>
                  </button>
                  <button className="fp-key fp-key--eject" onClick={() => { if (loaded) { mechanicalSound('eject'); setDeckState(null) } }} disabled={!loaded}
                    title="EJECT — take the tape out of the deck">
                    <span className="fp-shape fp-shape--eject" /><span className="fp-label">EJECT</span>
                  </button>
                </div>
                <div className="fp-voicerow">
                  <span className="fp-voicerow-label">MIC VOICE</span>
                  <select
                    className="fp-voice-select"
                    value={(loaded && deckState?.micVoiceId) || 'me'}
                    onChange={(e) => load({ micVoiceId: e.target.value })}
                    title="Whose voice goes on the tape — yours, or anyone from the station (your take, their voice)"
                  >
                    {(voices.length ? voices : [{ id: 'me', name: 'My voice' }]).map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
                <div className={`fp-status${rolling ? ' fp-status--recording' : armed ? ' fp-status--armed' : ''}`}>
                  {rolling ? `● RECORDING — ${String(pb.nowPlaying?.title || '').slice(0, 30)} → tape${micOn ? ' · MIC LIVE' : ''}`
                    : armed ? 'REC DOWN — press PLAY'
                    : loaded ? 'in the deck — not recording'
                    : 'on the shelf — press REC to record onto it'}
                </div>
              </>
            )
          })()}
          <div className="mixtape-smallrow">
            <button className="mixtape-link" onClick={() => setRemixing(true)}>Open on the deck</button>
            <span>·</span>
            <button className="mixtape-link" disabled={dubbing} onClick={() => { void dubToCassette() }}>{dubbing ? 'Exporting…' : 'Export as one file'}</button>
            <span>·</span>
            <button className="mixtape-link" onClick={() => setConfirmDelete(true)}>Delete Tape</button>
          </div>
          {dubNotice && <div className="mixtape-dub-notice">{dubNotice}</div>}
        </div>
      </div>

      <div className="jcard">
        {renderTracklist()}
      </div>

      {remixing && (
        <MixtapeSheet tracks={allTracks} existing={tape} onClose={() => { setRemixing(false); void refreshMixtapes() }} />
      )}
      {confirmDelete && (
        <ConfirmDialog
          message={`Throw out “${tape.title}”?`}
          detail="The tape and its recorded intro are deleted. The songs stay in your library."
          confirmLabel="Throw it out"
          onConfirm={() => {
            setConfirmDelete(false)
            void window.electronAPI.deleteMixtape?.(tape.id)
              .then(() => refreshMixtapes())
              .then(() => libDispatch({ type: 'SET_VIEW', view: 'home' }))
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}


function MicShape() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
    </svg>
  )
}

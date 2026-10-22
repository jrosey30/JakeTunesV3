/**
 * 4.5: "Your Mixes" — surfaces the SAME daily mixes the iOS app shows, pulled
 * from the mobile backend on homemini (GET /api/mixes via the get-mobile-mixes
 * IPC). ONE source of truth, so desktop ↔ mobile match exactly: the backend
 * themes + caches the mixes daily and merges phone+desktop play history, and
 * both clients render the same set. "Make me a vibe" → POST /api/mixes/vibe.
 *
 * The backend returns track ids from the shared library.json; we resolve them
 * to local Track objects so playback uses the desktop's own files. Ephemeral —
 * cards play, nothing is saved. Design mirrors ios/JakeTunesMobile/MixesSection.swift
 * (cover-art cards + gradient + title; "Make me a vibe" sheet with mood chips).
 *
 * 2026-10-22 (parity gap #9) — the phone's rail: homemini mints each day's
 * mixes into AI MIXTAPES, and the row shows TODAY'S TAPES (the daily batch
 * not kept) instead of the mix cards, falling back to the mix cards only when
 * there are none. Right-click a tape → Keep: it leaves the row on this frame
 * and lands on the MIXTAPES shelf in the sidebar, where tapes kept on the
 * phone already are. A tape plays by the tape rules (MixtapeView): from the
 * top, no skipping, one clock.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/MixesSection.swift — `dailyTapes`,
 *   the header ("MIXTAPES" once there are tapes, else "YOUR MIXES"), the
 *   Keep context menu, "Dubbing today’s tapes…", and the mix-card fallback.
 */
import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { setTapeSession, getTapeSession, setMixtapeId, getMixtapes, subscribeMixtapes } from '../mixtapes'
import { getAiMixtapes, subscribeAiMixtapes, ensureAiMixtapesLoaded, refreshAiMixtapes } from '../aiMixtapes'
import { dailyAiTapes, type AiMixtape } from '../../common/ai-mixtapes'
import { CassetteSvg, CASSETTE_BADGE_INK } from '../views/MixtapeView'
import { useHomeItemMenus } from './HomeItemMenus'
import MixArtwork from './MixArtwork'
import { PlayIcon } from './TransportIcons'
import { openMix, type VibeMix as Mix } from '../utils/activeMix'
import { setAlbumDragPayload } from '../utils/trackDrag'
import type { Track } from '../types'
import '../styles/home-madeforyou.css'

// Cache-first paint across Home revisits (mirrors iOS MixesSection seeding from cache).
let sessionMixes: Mix[] | null = null

const VIBE_PRESETS = ['Chill', 'Hype', 'Late night', 'Focus', 'Throwback', 'Sunny', 'Moody', 'Workout']

export default function MadeForYou() {
  const { state: lib, dispatch } = useLibrary()
  const { state: pb } = usePlayback()
  const { playTrack } = useAudio()
  const aiTapes = useSyncExternalStore(subscribeAiMixtapes, getAiMixtapes)
  const localTapes = useSyncExternalStore(subscribeMixtapes, getMixtapes)
  // Re-render when a tape starts or stops, so the playing tape's reels turn.
  const tapeSession = useSyncExternalStore(subscribeMixtapes, getTapeSession)
  // The Home's one menu host (HomeItemMenus): Keep on a daily tape.
  const menus = useHomeItemMenus()

  // Resolve backend track ids → the desktop's own Track objects (local files).
  const byId = useMemo(() => new Map(lib.tracks.map(t => [t.id, t])), [lib.tracks])
  const resolve = useCallback((ids: number[]): Track[] =>
    ids.map(id => byId.get(id)).filter((t): t is Track => !!t), [byId])

  const [mixes, setMixes] = useState<Mix[]>(sessionMixes || [])
  const [loading, setLoading] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [building, setBuilding] = useState(false)
  const [custom, setCustom] = useState('')

  const loadMixes = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.getMobileMixes?.()
      if (res?.ok && res.mixes) {
        const built = res.mixes
          .map(m => ({ id: m.id, title: m.title, subtitle: m.subtitle, tracks: resolve(m.trackIds) }))
          .filter(m => m.tracks.length > 0)
        if (built.length) { sessionMixes = built; setMixes(built) }
      }
    } catch { /* homemini backend unreachable → section degrades silently */ }
    // /api/mixes is what MINTS today's tapes on homemini, so the tapes are
    // read straight after it (the phone's MixesSection.load() order). A failed
    // read keeps the cached tapes; homemini away → the row quietly shows
    // what it had, or the mix cards, or nothing.
    try { await refreshAiMixtapes(true) } finally { setLoading(false) }
  }, [resolve])

  // Paint the cached tapes at once (main's cache), before any network.
  useEffect(() => { ensureAiMixtapesLoaded() }, [])

  // Cache-first paint, then refresh — mirrors the iOS MixesSection.load().
  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current || lib.tracks.length === 0) return
    didInit.current = true
    void loadMixes()
  }, [lib.tracks.length, loadMixes])

  // A mix plays as a TAPE from here too — same rules as its detail page:
  // whole-mix clock in the pill, no skipping, always from the top. Without
  // this, the home-page card was a second door into the old behaviour.
  const playMix = useCallback((m: Mix) => {
    if (!m.tracks.length) return
    setTapeSession({ mixtapeId: `mix:${m.id}`, tapeTrackIds: m.tracks.map((t) => t.id), cuts: [] })
    playTrack(m.tracks[0], m.tracks, 0, undefined, true, /* preserveOrder — a mix's arc IS the product */ true)
  }, [playTrack])

  const pickVibe = useCallback(async (vibe: string) => {
    if (building) return
    setBuilding(true)
    try {
      const res = await window.electronAPI.getMobileVibeMix?.(vibe)
      if (res?.ok && res.mix) {
        const tracks = resolve(res.mix.trackIds)
        if (tracks.length) {
          const m: Mix = { id: res.mix.id, title: res.mix.title, subtitle: res.mix.subtitle, tracks }
          setMixes(prev => [m, ...prev.filter(p => p.id !== m.id)])
          setSheetOpen(false); setCustom('')
          playMix(m)
        }
      }
    } catch { /* keep the sheet open for a retry */ }
    finally { setBuilding(false) }
  }, [building, resolve, playMix])

  // TODAY'S TAPES — the disposable daily batch only, resolved to this Mac's
  // own files. Keeping a tape makes it permanent and moves it to the shelf
  // (the sidebar's MIXTAPES), which is what makes Keep visible the moment
  // it is pressed: the tape leaves this row.
  const dailyTapes = useMemo(() => dailyAiTapes(aiTapes)
    .map((tape) => ({ tape, tracks: resolve(tape.trackIds) }))
    .filter((d) => d.tracks.length > 0), [aiTapes, resolve])
  const hasTapes = aiTapes.length > 0 || localTapes.length > 0

  if (lib.tracks.length === 0) return null
  // Don't leave a hollow "Your Mixes" chapter when the backend is down
  // or the day's mixes haven't arrived — the header with nothing under
  // it made Home look unfinished.
  if (!loading && mixes.length === 0 && dailyTapes.length === 0) return null

  const openTape = (tape: AiMixtape): void => {
    setMixtapeId(tape.id)
    dispatch({ type: 'SET_VIEW', view: 'mixtape-detail' })
  }

  return (
    <section className="home-section home-mixes">
      <div className="home-section-header">
        <h2 className="home-section-title">{hasTapes ? 'Mixtapes' : 'Your Mixes'}</h2>
        <button type="button" className="home-mixes-vibe-btn" onClick={() => setSheetOpen(true)} disabled={building}>
          <span className="home-mixes-spark" aria-hidden="true">✦</span> Make me a vibe
        </button>
      </div>

      {dailyTapes.length > 0 && (
        <div className="home-mixes-row">
          {dailyTapes.map(({ tape, tracks }) => {
            // The reels turn only while THIS tape is the one playing.
            const rolling = tapeSession?.mixtapeId === tape.id && pb.isPlaying
            return (
              <div key={tape.id} className="home-mix-cell">
                <button
                  type="button"
                  className="home-mix-card"
                  onClick={() => openTape(tape)}
                  // Right-click is the desktop's long-press (the phone's
                  // context menu on the rail): Keep.
                  onContextMenu={(e) => menus?.openTapeMenu(e, tape)}
                  title={tape.commentary ? `${tape.title} — ${tape.commentary}` : `${tape.title} · ${tracks.length} songs`}
                >
                  <div className="home-mix-art">
                    <MixArtwork tracks={tracks} alt={tape.title} />
                    <span className="mixtape-cover-badge" aria-hidden="true">
                      <CassetteSvg ink={CASSETTE_BADGE_INK} spinning={rolling} />
                    </span>
                  </div>
                  {/* Below the art and wrapped in full: names never clip. */}
                  <div className="home-tape-title">{tape.title}</div>
                </button>
              </div>
            )
          })}
        </div>
      )}
      {dailyTapes.length === 0 && mixes.length > 0 && (
        <div className="home-mixes-row">
          {mixes.map((m) => {
            // The play button is a SIBLING laid over the art, not a child —
            // a button can't nest in a button. Clicking the card still opens
            // the mix; the button plays it from the top as a tape (playMix).
            return (
              <div key={m.id} className="home-mix-cell">
                <button
                  className="home-mix-card"
                  onClick={() => { openMix(m, lib.currentView); dispatch({ type: 'SET_VIEW', view: 'mix-detail' }) }}
                  // Drag the mix — its songs in the mix's order — onto Up Next
                  // or a playlist, like any run of library songs (2026-10-20).
                  draggable
                  onDragStart={(e) => setAlbumDragPayload(e, m.tracks.map((t) => t.id))}
                  title={m.subtitle ? `${m.title} — ${m.subtitle}` : `${m.title} · ${m.tracks.length} songs`}
                >
                  <div className="home-mix-art">
                    <MixArtwork tracks={m.tracks} />
                    <div className="home-mix-scrim" aria-hidden="true" />
                    <div className="home-mix-title">{m.title}</div>
                  </div>
                </button>
                <button
                  type="button"
                  className="home-mix-play"
                  onClick={(e) => { e.stopPropagation(); playMix(m) }}
                  title={`Play ${m.title}`}
                  aria-label={`Play ${m.title}`}
                >
                  <PlayIcon size={16} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {loading && mixes.length === 0 && dailyTapes.length === 0 && (
        <div className="home-mixes-loading">Dubbing today’s tapes…</div>
      )}

      {sheetOpen && createPortal(
        <div className="home-vibe-backdrop" onClick={() => !building && setSheetOpen(false)}>
          <div className="home-vibe-sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label="Make me a vibe">
            <div className="home-vibe-title">What are you in the mood for?</div>
            <div className="home-vibe-chips">
              {VIBE_PRESETS.map(p => (
                <button key={p} className="home-vibe-chip" disabled={building} onClick={() => void pickVibe(p)}>{p}</button>
              ))}
            </div>
            <div className="home-vibe-custom">
              <input
                className="home-vibe-input"
                placeholder="or describe a vibe…"
                value={custom}
                disabled={building}
                onChange={e => setCustom(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && custom.trim()) void pickVibe(custom.trim()) }}
                autoFocus
              />
              <button
                className="home-vibe-go"
                disabled={building || !custom.trim()}
                onClick={() => custom.trim() && void pickVibe(custom.trim())}
              >Go</button>
            </div>
            {building
              ? <div className="home-vibe-building">Building your set…</div>
              : <button className="home-vibe-cancel" onClick={() => setSheetOpen(false)}>Cancel</button>}
          </div>
        </div>,
        document.body,
      )}
    </section>
  )
}

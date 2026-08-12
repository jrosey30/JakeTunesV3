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
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { setTapeSession } from '../mixtapes'
import MixArtwork from './MixArtwork'
import { openMix, type VibeMix as Mix } from '../utils/activeMix'
import type { Track } from '../types'
import '../styles/home-madeforyou.css'

// Cache-first paint across Home revisits (mirrors iOS MixesSection seeding from cache).
let sessionMixes: Mix[] | null = null

const VIBE_PRESETS = ['Chill', 'Hype', 'Late night', 'Focus', 'Throwback', 'Sunny', 'Moody', 'Workout']

export default function MadeForYou() {
  const { state: lib, dispatch } = useLibrary()
  const { playTrack } = useAudio()

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
    finally { setLoading(false) }
  }, [resolve])

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
    playTrack(m.tracks[0], m.tracks, 0, undefined, true)
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

  if (lib.tracks.length === 0) return null
  // Don't leave a hollow "Your Mixes" chapter when the backend is down
  // or the day's mixes haven't arrived — the header with nothing under
  // it made Home look unfinished.
  if (!loading && mixes.length === 0) return null

  return (
    <section className="home-section home-mixes">
      <div className="home-section-header">
        <h2 className="home-section-title">Your Mixes</h2>
        <button type="button" className="home-mixes-vibe-btn" onClick={() => setSheetOpen(true)} disabled={building}>
          <span className="home-mixes-spark" aria-hidden="true">✦</span> Make me a vibe
        </button>
      </div>

      {mixes.length > 0 && (
        <div className="home-mixes-row">
          {mixes.map((m) => {
            return (
              <button
                key={m.id}
                className="home-mix-card"
                onClick={() => { openMix(m, lib.currentView); dispatch({ type: 'SET_VIEW', view: 'mix-detail' }) }}
                title={m.subtitle ? `${m.title} — ${m.subtitle}` : `${m.title} · ${m.tracks.length} songs`}
              >
                <div className="home-mix-art">
                  <MixArtwork tracks={m.tracks} />
                  <div className="home-mix-scrim" aria-hidden="true" />
                  <div className="home-mix-title">{m.title}</div>
                </div>
              </button>
            )
          })}
        </div>
      )}
      {loading && mixes.length === 0 && (
        <div className="home-mixes-loading">Cooking up today’s mixes…</div>
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

import { useState, useCallback, useRef, useEffect } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useLibrary } from '../../context/LibraryContext'
import { useAudio, setAutoDjMode, getAudioSinkId, setAudioSinkId } from '../../hooks/useAudio'
import TransportControls from './TransportControls'
import NowPlaying from './NowPlaying'
import VolumeSlider from './VolumeSlider'
import SearchPill from './SearchPill'

function QueueIcon() {
  return (
    <svg width="28" height="26" viewBox="0 0 22 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M2 4h12" />
      <path d="M2 9h12" />
      <path d="M2 14h8" />
      <path d="M16 10v8" />
      <path d="M13 14h6" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="18" height="22" viewBox="0 0 18 22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="5" y="1" width="8" height="12" rx="4" />
      <path d="M2 10a7 7 0 0014 0" />
      <path d="M9 17v4M6 21h6" />
    </svg>
  )
}

function RadioIcon() {
  return (
    <svg width="24" height="28" viewBox="0 -1 24 29" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {/* Tower mast */}
      <path d="M12 6v18" strokeWidth="2" />
      {/* Base feet */}
      <path d="M12 24L7 26" />
      <path d="M12 24L17 26" />
      {/* Cross bars */}
      <path d="M9 13h6" />
      <path d="M10 18h4" />
      {/* Tower taper lines */}
      <path d="M12 8L8 24" strokeWidth="1.2" />
      <path d="M12 8L16 24" strokeWidth="1.2" />
      {/* Signal waves */}
      <path d="M8.5 5a4.5 4.5 0 017 0" strokeWidth="1.4" />
      <path d="M6 2.5a8 8 0 0112 0" strokeWidth="1.3" />
      {/* Antenna tip */}
      <circle cx="12" cy="5.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

function AirPlayIcon({ active }: { active?: boolean }) {
  return (
    <svg width="20" height="18" viewBox="0 0 20 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {/* Screen */}
      <path d="M2 1h16a1 1 0 011 1v10a1 1 0 01-1 1H14" />
      <path d="M6 13H2a1 1 0 01-1-1V2a1 1 0 011-1" />
      {/* Triangle (AirPlay symbol) */}
      <polygon points="10,10 5,17 15,17" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

export default function Toolbar({ onToggleQueue, onOpenQueue, showQueue }: { onToggleQueue: () => void; onOpenQueue: () => void; showQueue: boolean }) {
  const { state: pb } = usePlayback()
  const { state: lib } = useLibrary()
  const { setVolume, playTrack } = useAudio()
  const [autoDj, setAutoDj] = useState(false)
  const [djActive, setDjActive] = useState(false)
  const [djText, setDjText] = useState('')
  const [djLoading, setDjLoading] = useState(false)
  const [showBubble, setShowBubble] = useState(true)
  const [djExiting, setDjExiting] = useState(false)
  const savedVolumeRef = useRef(0.8)
  const djAudioRef = useRef<HTMLAudioElement | null>(null)

  const fadeVolumeIn = useCallback(() => {
    const target = savedVolumeRef.current
    const start = target * 0.15
    let step = 0
    const fade = setInterval(() => {
      step++
      if (step >= 30) {
        setVolume(target)
        clearInterval(fade)
      } else {
        setVolume(start + (target - start) * (step / 30))
      }
    }, 50)
  }, [setVolume])

  const fadeVolumeOut = useCallback((): Promise<void> => {
    return new Promise(resolve => {
      const start = savedVolumeRef.current
      const target = start * 0.15
      let step = 0
      const fade = setInterval(() => {
        step++
        if (step >= 20) {
          setVolume(target)
          clearInterval(fade)
          resolve()
        } else {
          setVolume(start - (start - target) * (step / 20))
        }
      }, 50)
    })
  }, [setVolume])

  // Global fade for any Music Man speech (MusicManView, SmartPlaylistView, etc.)
  const isFadedRef = useRef(false)
  useEffect(() => {
    const handleStart = async () => {
      if (isFadedRef.current) return
      isFadedRef.current = true
      savedVolumeRef.current = pb.volume
      await fadeVolumeOut()
      window.dispatchEvent(new Event('musicman-fade-ready'))
    }
    const handleEnd = () => {
      if (!isFadedRef.current) return
      isFadedRef.current = false
      fadeVolumeIn()
    }
    window.addEventListener('musicman-speaking-start', handleStart)
    window.addEventListener('musicman-speaking-end', handleEnd)
    return () => {
      window.removeEventListener('musicman-speaking-start', handleStart)
      window.removeEventListener('musicman-speaking-end', handleEnd)
    }
  }, [pb.volume, fadeVolumeOut, fadeVolumeIn])

  // Cancel DJ when user manually plays a track
  useEffect(() => {
    const handler = () => {
      if (djAudioRef.current) {
        djAudioRef.current.pause()
        djAudioRef.current = null
        setVolume(savedVolumeRef.current)
      }
      setAutoDj(false)
      setDjActive(false)
      setDjLoading(false)
      setDjText('')
    }
    window.addEventListener('musicman-dj-cancel', handler)
    return () => window.removeEventListener('musicman-dj-cancel', handler)
  }, [setVolume])

  // Sync auto-DJ mode to audio module
  useEffect(() => {
    setAutoDjMode(autoDj)
  }, [autoDj])

  // Click mic: if actively speaking/loading, stop. Otherwise fire one-shot.
  const handleDjClick = useCallback(async () => {
    if (djActive) {
      if (djAudioRef.current) {
        djAudioRef.current.pause()
        djAudioRef.current = null
        setVolume(savedVolumeRef.current)
      }
      setAutoDj(false)
      setDjActive(false)
      setDjLoading(false)
      setDjText('')
      return
    }

    if (!pb.nowPlaying) return
    setAutoDj(true)
    setDjActive(true)
    setDjLoading(true)
    setDjText('')
    savedVolumeRef.current = pb.volume

    try {
      const track = pb.nowPlaying
      const result = await window.electronAPI.musicmanDj({
        title: track.title || '', artist: track.artist || '',
        album: track.album || '', genre: track.genre || '', year: track.year || '',
      })
      console.log('[DJ] Claude response:', result)
      if (result.ok && result.text) {
        const tts = await window.electronAPI.musicmanSpeak(result.text, false)
        console.log('[DJ] TTS response:', tts.ok, tts.error || '')
        setDjLoading(false)
        if (tts.ok && tts.audio) {
          setDjText(result.text)
          const audio = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
          djAudioRef.current = audio
          audio.onended = () => {
            fadeVolumeIn()
            djAudioRef.current = null
            setDjActive(false)
            setTimeout(() => {
              setDjExiting(true)
              setTimeout(() => { setDjText(''); setDjExiting(false) }, 400)
            }, 3000)
          }
          audio.onerror = (err) => {
            console.error('[DJ] Audio playback error:', err)
            setVolume(savedVolumeRef.current)
            djAudioRef.current = null
            setDjActive(false)
            setDjText('')
          }
          await fadeVolumeOut()
          await audio.play()
          return
        } else {
          console.warn('[DJ] TTS failed or no audio:', tts.error)
        }
      } else {
        console.warn('[DJ] Claude returned no text:', result)
      }
    } catch (err) {
      console.error('[DJ] Error:', err)
    }
    setDjActive(false)
    setDjLoading(false)
    setDjText('')
  }, [djActive, pb.nowPlaying, pb.volume, setVolume, fadeVolumeOut, fadeVolumeIn])

  // Auto-DJ: listen for track transitions
  useEffect(() => {
    if (!autoDj) return

    const handler = async (e: Event) => {
      const { prevTrack, nextTrack, nextIdx, queue } = (e as CustomEvent).detail
      setDjActive(true)
      setDjLoading(true)
      setDjText('')

      try {
        const result = await window.electronAPI.musicmanDj(
          { title: prevTrack.title || '', artist: prevTrack.artist || '', album: prevTrack.album || '', genre: prevTrack.genre || '', year: prevTrack.year || '' },
          { title: nextTrack.title || '', artist: nextTrack.artist || '', album: nextTrack.album || '', genre: nextTrack.genre || '', year: nextTrack.year || '' }
        )
        if (result.ok && result.text) {
          const tts = await window.electronAPI.musicmanSpeak(result.text, false)
          setDjLoading(false)
          if (tts.ok && tts.audio) {
            setDjText(result.text)
            const audio = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
            djAudioRef.current = audio
            audio.onended = () => {
              djAudioRef.current = null
              setDjActive(false)
              fadeVolumeIn()
              isFadedRef.current = false
              playTrack(nextTrack, queue, nextIdx, true)
              setTimeout(() => {
                setDjExiting(true)
                setTimeout(() => { setDjText(''); setDjExiting(false) }, 400)
              }, 3000)
            }
            audio.onerror = () => {
              djAudioRef.current = null
              setDjActive(false)
              setDjText('')
              fadeVolumeIn()
              isFadedRef.current = false
              playTrack(nextTrack, queue, nextIdx, true)
            }
            savedVolumeRef.current = pb.volume
            await fadeVolumeOut()
            await audio.play()
            return
          }
        }
      } catch {}
      setDjActive(false)
      setDjLoading(false)
      setDjText('')
      playTrack(nextTrack, queue, nextIdx, true)
    }

    window.addEventListener('musicman-dj-transition', handler)
    return () => window.removeEventListener('musicman-dj-transition', handler)
  }, [autoDj, playTrack])

  // ── AirPlay / Audio Output ──
  const [airplayOpen, setAirplayOpen] = useState(false)
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [activeSinkId, setActiveSinkId] = useState('')
  const airplayRef = useRef<HTMLDivElement>(null)

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const outputs = devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== '')
      setAudioDevices(outputs)
      setActiveSinkId(getAudioSinkId())
    } catch (e) {
      console.warn('[AirPlay] enumerateDevices failed:', e)
    }
  }, [])

  const handleAirplayClick = useCallback(() => {
    if (airplayOpen) {
      setAirplayOpen(false)
    } else {
      refreshDevices()
      setAirplayOpen(true)
    }
  }, [airplayOpen, refreshDevices])

  const handleSelectDevice = useCallback((deviceId: string) => {
    setAudioSinkId(deviceId)
    setActiveSinkId(deviceId)
    setAirplayOpen(false)
  }, [])

  // Close airplay menu on outside click
  useEffect(() => {
    if (!airplayOpen) return
    const handler = (e: MouseEvent) => {
      if (airplayRef.current && !airplayRef.current.contains(e.target as Node)) {
        setAirplayOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [airplayOpen])

  // Listen for device changes (e.g. AirPlay device connects/disconnects)
  useEffect(() => {
    const handler = () => { if (airplayOpen) refreshDevices() }
    navigator.mediaDevices.addEventListener('devicechange', handler)
    return () => navigator.mediaDevices.removeEventListener('devicechange', handler)
  }, [airplayOpen, refreshDevices])

  // ── DJ Mode (Spotify-style AI DJ) ──
  const [djModeActive, setDjModeActive] = useState(false)
  const [djModeLoading, setDjModeLoading] = useState(false)
  const [djModeTheme, setDjModeTheme] = useState('')
  const djRecentIds = useRef<number[]>([])

  const startDjSet = useCallback(async () => {
    setDjModeLoading(true)
    setDjActive(true)
    setDjLoading(true)
    setDjText('')
    savedVolumeRef.current = pb.volume

    try {
      const compact = lib.tracks.map(t => ({
        id: t.id, title: t.title, artist: t.artist, album: t.album,
        genre: t.genre, year: t.year,
      }))
      const result = await window.electronAPI.musicmanDjSet(compact, djRecentIds.current)
      if (!result.ok || !result.trackIds || result.trackIds.length === 0) {
        console.error('[DJ Mode] Failed to get set:', result.error)
        setDjModeActive(false)
        setDjModeLoading(false)
        setDjActive(false)
        setDjLoading(false)
        return
      }

      // Resolve track IDs to Track objects
      const trackMap = new Map(lib.tracks.map(t => [t.id, t]))
      const setTracks = result.trackIds
        .map(id => trackMap.get(id))
        .filter((t): t is NonNullable<typeof t> => !!t)

      if (setTracks.length === 0) {
        setDjModeActive(false)
        setDjModeLoading(false)
        setDjActive(false)
        setDjLoading(false)
        return
      }

      // Remember these as recently played
      djRecentIds.current = [...djRecentIds.current, ...setTracks.map(t => t.id)].slice(-50)

      setDjModeTheme(result.theme || '')

      // Speak the intro
      if (result.intro) {
        const tts = await window.electronAPI.musicmanSpeak(result.intro, false)
        setDjLoading(false)
        if (tts.ok && tts.audio) {
          setDjText(result.intro)
          const audio = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
          djAudioRef.current = audio
          await fadeVolumeOut()
          await new Promise<void>((resolve) => {
            audio.onended = () => {
              djAudioRef.current = null
              fadeVolumeIn()
              isFadedRef.current = false
              resolve()
            }
            audio.onerror = () => {
              djAudioRef.current = null
              fadeVolumeIn()
              isFadedRef.current = false
              resolve()
            }
            audio.play()
          })
        } else {
          setDjLoading(false)
          setDjText(result.intro)
        }
      } else {
        setDjLoading(false)
      }

      // Start playing the DJ set with auto-DJ transitions enabled
      setAutoDj(true)
      setDjActive(false)
      setDjModeLoading(false)
      playTrack(setTracks[0], setTracks, 0, true)

      // Fade out the intro text after a few seconds
      setTimeout(() => {
        setDjExiting(true)
        setTimeout(() => { setDjText(''); setDjExiting(false) }, 400)
      }, 4000)

    } catch (err) {
      console.error('[DJ Mode] Error:', err)
      setDjModeActive(false)
      setDjModeLoading(false)
      setDjActive(false)
      setDjLoading(false)
      setDjText('')
    }
  }, [lib.tracks, pb.volume, playTrack, setVolume])

  const handleDjModeClick = useCallback(() => {
    if (djModeActive) {
      // Stop DJ mode
      setDjModeActive(false)
      setDjModeTheme('')
      setAutoDj(false)
      if (djAudioRef.current) {
        djAudioRef.current.pause()
        djAudioRef.current = null
      }
      setDjActive(false)
      setDjLoading(false)
      setDjText('')
      return
    }

    // Start DJ mode
    setDjModeActive(true)
    startDjSet()
  }, [djModeActive, startDjSet])

  // When the DJ set queue ends and DJ mode is still active, fetch another set
  useEffect(() => {
    if (!djModeActive || !autoDj) return

    const handler = () => {
      // The STOP action fires when queue ends — fetch a new set
      if (djModeActive) {
        startDjSet()
      }
    }
    window.addEventListener('musicman-dj-set-ended', handler)
    return () => window.removeEventListener('musicman-dj-set-ended', handler)
  }, [djModeActive, autoDj, startDjSet])

  return (
    <div className="toolbar">
      <TransportControls />
      <NowPlaying />
      <VolumeSlider />
      <div className="airplay-wrapper" ref={airplayRef}>
        <button
          className={`transport-toggle airplay-btn ${activeSinkId ? 'airplay-btn--active' : ''}`}
          onClick={handleAirplayClick}
          title="Audio Output (AirPlay)"
        >
          <AirPlayIcon active={!!activeSinkId} />
        </button>
        {airplayOpen && (
          <div className="airplay-menu">
            <div className="airplay-menu-header">Audio Output</div>
            <div
              className={`airplay-menu-item ${!activeSinkId ? 'airplay-menu-item--active' : ''}`}
              onClick={() => handleSelectDevice('')}
            >
              <span className="airplay-check">{!activeSinkId ? '\u2713' : ''}</span>
              <span className="airplay-device-icon">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M1 3a1 1 0 011-1h8a1 1 0 011 1v5a1 1 0 01-1 1H7l-1 2-1-2H2a1 1 0 01-1-1V3z"/></svg>
              </span>
              System Default
            </div>
            {audioDevices.filter(d => d.deviceId !== 'default').map(d => {
              const label = d.label || d.deviceId
              const isAirplay = /airplay|homepod|apple\s*tv/i.test(label)
              const isBluetooth = /bluetooth|bt|airpods|beats|bose|sony|jabra|jbl/i.test(label)
              return (
                <div
                  key={d.deviceId}
                  className={`airplay-menu-item ${activeSinkId === d.deviceId ? 'airplay-menu-item--active' : ''}`}
                  onClick={() => handleSelectDevice(d.deviceId)}
                >
                  <span className="airplay-check">{activeSinkId === d.deviceId ? '\u2713' : ''}</span>
                  <span className="airplay-device-icon">
                    {isAirplay ? (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="1" width="10" height="7" rx="0.5"/><polygon points="6,7 3,11 9,11" fill="currentColor"/></svg>
                    ) : isBluetooth ? (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M3 3l6 3-6 3M6 0v12M9 3L6 0v5"/><path d="M9 9L6 12V7"/></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M1 5v2h2l3 3V2L3 5H1z"/><path d="M8.5 3.5a3.5 3.5 0 010 5" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
                    )}
                  </span>
                  {label}
                </div>
              )
            })}
            <div className="airplay-menu-divider" />
            <div
              className="airplay-menu-item airplay-menu-item--settings"
              onClick={() => {
                setAirplayOpen(false)
                window.electronAPI?.openSoundSettings?.()
              }}
            >
              <span className="airplay-check" />
              <span className="airplay-device-icon">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="6" cy="6" r="2"/><path d="M6 1v1M6 10v1M1 6h1M10 6h1M2.5 2.5l.7.7M8.8 8.8l.7.7M9.5 2.5l-.7.7M3.2 8.8l-.7.7"/></svg>
              </span>
              Sound Settings...
            </div>
          </div>
        )}
      </div>
      <button
        className={`transport-toggle dj-mode-btn ${djModeActive ? 'dj-mode-btn--active' : ''} ${djModeLoading ? 'dj-btn--loading' : ''}`}
        onClick={handleDjModeClick}
        title={djModeActive ? `DJ Mode: ${djModeTheme || 'On'} (click to stop)` : 'Start DJ Mode'}
      >
        <RadioIcon />
      </button>
      <div className="dj-btn-wrapper">
        <button
          className={`transport-toggle dj-btn ${djActive && !djModeActive ? 'dj-btn--active' : ''} ${djLoading && !djModeActive ? 'dj-btn--loading' : ''}`}
          onClick={handleDjClick}
          onContextMenu={(e) => { e.preventDefault(); setShowBubble(s => !s) }}
          disabled={!pb.nowPlaying}
          title="Music Man comment (right-click: toggle bubble)"
        >
          <MicIcon />
        </button>
        {showBubble && (djLoading || djText) && (
          <div className={`dj-bubble ${djExiting ? 'dj-bubble--exiting' : ''}`}>
            {djLoading ? (
              <>
                <span className="dj-bubble-label">The Music Man</span>{' '}
                <span className="dj-loading-dots">is listening</span>
              </>
            ) : (
              <>
                <span className="dj-bubble-label">The Music Man:</span> {djText}
              </>
            )}
          </div>
        )}
      </div>
      <button
        className={`transport-toggle queue-toggle ${showQueue ? 'queue-toggle--active' : ''}`}
        onClick={onToggleQueue}
        title="Up Next"
        onDragOver={(e) => {
          e.preventDefault()
          if (!showQueue) onOpenQueue()
        }}
      >
        <QueueIcon />
      </button>
      <SearchPill />
    </div>
  )
}

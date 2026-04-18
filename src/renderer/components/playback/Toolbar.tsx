import { useState, useCallback, useRef, useEffect } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useLibrary } from '../../context/LibraryContext'
import { useAudio, setAutoDjMode } from '../../hooks/useAudio'
import TransportControls from './TransportControls'
import NowPlaying from './NowPlaying'
import VolumeSlider from './VolumeSlider'
import SearchPill from './SearchPill'

function QueueIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 5h12" />
      <path d="M2 10h12" />
      <path d="M2 15h7" />
      <path d="M15 11v6" />
      <path d="M12 14h6" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="7" y="2" width="6" height="9" rx="3" />
      <path d="M4 10a6 6 0 0012 0" />
      <path d="M10 16v3M7 19h6" />
    </svg>
  )
}

function RadioIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 5v12" strokeWidth="1.8" />
      <path d="M10 17L6 19M10 17L14 19" />
      <path d="M8 10h4" />
      <path d="M9 13h2" />
      <path d="M10 7L7 17" strokeWidth="1" />
      <path d="M10 7L13 17" strokeWidth="1" />
      <path d="M7 4.5a4 4 0 016 0" strokeWidth="1.3" />
      <path d="M5 2.5a7 7 0 0110 0" strokeWidth="1.2" />
      <circle cx="10" cy="4.2" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function AirPlayIcon({ active }: { active?: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 2h14a1 1 0 011 1v9a1 1 0 01-1 1h-3" />
      <path d="M6 13H3a1 1 0 01-1-1V3a1 1 0 011-1" />
      <polygon points="10,11 6,18 14,18" fill={active ? 'currentColor' : 'none'} strokeWidth="1.5" />
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
      djCancelledRef.current = true
      setAutoDjMode(false) // immediately clear module-level flag
      if (djAudioRef.current) {
        djAudioRef.current.pause()
        djAudioRef.current = null
        setVolume(savedVolumeRef.current)
      }
      setAutoDj(false)
      setDjActive(false)
      setDjLoading(false)
      setDjText('')
      setDjModeActive(false)
      setDjModeTheme('')
    }
    window.addEventListener('musicman-dj-cancel', handler)
    return () => window.removeEventListener('musicman-dj-cancel', handler)
  }, [setVolume])

  // Sync auto-DJ mode to audio module
  useEffect(() => {
    setAutoDjMode(autoDj)
  }, [autoDj])


  // Click mic: one-shot DJ comment on current track. Click again to stop.
  const handleDjClick = useCallback(async () => {
    // If actively speaking or autoDj is lingering from a previous mic click, stop everything
    if (djActive || autoDj) {
      djCancelledRef.current = true
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
    djCancelledRef.current = false
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
      if (djCancelledRef.current) return
      console.log('[DJ] Claude response:', result)
      if (result.ok && result.text) {
        const tts = await window.electronAPI.musicmanSpeak(result.text, false)
        if (djCancelledRef.current) return
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
            setAutoDj(false)
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
            setAutoDj(false)
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
  }, [djActive, autoDj, pb.nowPlaying, pb.volume, setVolume, fadeVolumeOut, fadeVolumeIn])

  // Auto-DJ: listen for track transitions
  useEffect(() => {
    if (!autoDj) return

    const handler = async (e: Event) => {
      // Acknowledge so useAudio knows we're handling this
      window.dispatchEvent(new Event('musicman-dj-transition-ack'))
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
  interface AudioDevice { id: number; name: string; transport: string; isDefault: boolean }
  const [airplayOpen, setAirplayOpen] = useState(false)
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [defaultDeviceId, setDefaultDeviceId] = useState<number | null>(null)
  const airplayRef = useRef<HTMLDivElement>(null)

  const refreshDevices = useCallback(async () => {
    try {
      const result = await window.electronAPI.listAudioDevices()
      if (result.ok) {
        setAudioDevices(result.devices)
        const def = result.devices.find(d => d.isDefault)
        setDefaultDeviceId(def ? def.id : null)
      }
    } catch (e) {
      console.warn('[AirPlay] listAudioDevices failed:', e)
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

  const handleSelectDevice = useCallback(async (deviceId: number) => {
    const result = await window.electronAPI.setAudioDevice(deviceId)
    if (result.ok) {
      setDefaultDeviceId(deviceId)
    }
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

  // Check if a non-builtin device is active (for icon highlight)
  const isExternalOutput = audioDevices.length > 0 && defaultDeviceId != null &&
    audioDevices.find(d => d.id === defaultDeviceId)?.transport !== 'builtin'

  // ── DJ Mode (Spotify-style AI DJ) ──
  const [djModeActive, setDjModeActive] = useState(false)
  const [djModeLoading, setDjModeLoading] = useState(false)
  const [djModeTheme, setDjModeTheme] = useState('')
  const djRecentIds = useRef<number[]>([])
  const djCancelledRef = useRef(false)

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

      // Bail out if DJ was cancelled while we were waiting for API
      if (djCancelledRef.current) return

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

        // Bail out if cancelled during TTS
        if (djCancelledRef.current) return

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

      // Bail out if cancelled during intro playback
      if (djCancelledRef.current) return

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
      // Stop DJ mode — kill everything immediately
      djCancelledRef.current = true
      setDjModeActive(false)
      setDjModeLoading(false)
      setDjModeTheme('')
      setAutoDj(false)
      setAutoDjMode(false) // immediately clear module-level flag
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
    djCancelledRef.current = false
    setDjModeActive(true)
    startDjSet()
  }, [djModeActive, startDjSet])

  // Listen for DJ Mode toggle from sidebar button
  useEffect(() => {
    const handler = () => handleDjModeClick()
    window.addEventListener('toggle-dj-mode', handler)
    return () => window.removeEventListener('toggle-dj-mode', handler)
  }, [handleDjModeClick])

  // When the DJ set queue ends and DJ mode is still active, fetch another set
  useEffect(() => {
    if (!djModeActive || !autoDj) return

    const handler = () => {
      // Acknowledge so useAudio knows we're handling this
      window.dispatchEvent(new Event('musicman-dj-set-ended-ack'))
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
      <div className="now-playing-group">
        <NowPlaying />
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
      </div>
      <div className="volume-group">
      <VolumeSlider />
      <div className="airplay-wrapper" ref={airplayRef}>
        <button
          className={`transport-toggle airplay-btn ${isExternalOutput ? 'airplay-btn--active' : ''}`}
          onClick={handleAirplayClick}
          title="Audio Output (AirPlay)"
        >
          <AirPlayIcon active={isExternalOutput} />
        </button>
        {airplayOpen && (
          <div className="airplay-menu">
            <div className="airplay-menu-header">Audio Output</div>
            {audioDevices.map(d => {
              const icon = d.transport === 'airplay' ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="1" width="10" height="7" rx="0.5"/><polygon points="6,7 3,11 9,11" fill="currentColor"/></svg>
              ) : d.transport === 'bluetooth' ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M3 3l6 3-6 3M6 0v12M9 3L6 0v5"/><path d="M9 9L6 12V7"/></svg>
              ) : d.transport === 'builtin' ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M1 3a1 1 0 011-1h8a1 1 0 011 1v5a1 1 0 01-1 1H7l-1 2-1-2H2a1 1 0 01-1-1V3z"/></svg>
              ) : d.transport === 'usb' || d.transport === 'hdmi' ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M1 5v2h2l3 3V2L3 5H1z"/><path d="M8.5 3.5a3.5 3.5 0 010 5" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5"><path d="M1 5v2h2l3 3V2L3 5H1z"/></svg>
              )
              return (
                <div
                  key={d.id}
                  className={`airplay-menu-item ${d.id === defaultDeviceId ? 'airplay-menu-item--active' : ''}`}
                  onClick={() => handleSelectDevice(d.id)}
                >
                  <span className="airplay-check">{d.id === defaultDeviceId ? '\u2713' : ''}</span>
                  <span className="airplay-device-icon">{icon}</span>
                  {d.name}
                </div>
              )
            })}
            <div className="airplay-menu-divider" />
            <div
              className="airplay-menu-item airplay-menu-item--settings"
              onClick={() => {
                setAirplayOpen(false)
                window.electronAPI.openSoundSettings()
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
      </div>
      <div className="toolbar-icons">
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
      </div>
      <SearchPill />
    </div>
  )
}

/**
 * The mic button — record a voice intro onto the tape, instantly.
 * getUserMedia → MediaRecorder (webm/opus) → main runs the 1979 cassette
 * chain (ffmpeg: tape bandwidth + wow + saturation + hiss) → preview the
 * PROCESSED result through ipod-audio://. What you hear is what the tape
 * gets. Cancel/re-record fully reverses: stream stopped, audio paused
 * and nulled, temp state cleared (cancel-mirrors-start rule).
 */
import { useEffect, useRef, useState } from 'react'

interface Props {
  /** Existing processed intro (editing a tape that already has one). */
  existingPath?: string
  onProcessed: (path: string | null) => void
}

type MicState = 'idle' | 'recording' | 'processing' | 'ready' | 'error'

export default function MixtapeMic({ existingPath, onProcessed }: Props) {
  const [mic, setMic] = useState<MicState>(existingPath ? 'ready' : 'idle')
  const [path, setPath] = useState<string | null>(existingPath || null)
  const [error, setError] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopEverything = () => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop()
    recRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    setPreviewing(false)
  }

  useEffect(() => stopEverything, [])

  const startRecording = async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      recRef.current = rec
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
        setMic('processing')
        try {
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
          const buf = await blob.arrayBuffer()
          const r = await window.electronAPI.saveMixtapeIntro?.(buf)
          if (r?.ok && r.path) {
            setPath(r.path)
            setMic('ready')
            onProcessed(r.path)
          } else {
            setError(r?.error || 'Processing failed.')
            setMic('error')
          }
        } catch (err) {
          setError(String(err))
          setMic('error')
        }
      }
      rec.start()
      setSeconds(0)
      tickRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
      setMic('recording')
    } catch (err) {
      // TCC denial lands here too — say something useful.
      setError('Microphone unavailable — check System Settings → Privacy → Microphone.')
      setMic('error')
      console.warn('[mixtape-mic] getUserMedia failed:', err)
    }
  }

  const stopRecording = () => {
    if (recRef.current && recRef.current.state === 'recording') recRef.current.stop()
  }

  const preview = () => {
    if (!path) return
    if (previewing) {
      audioRef.current?.pause()
      audioRef.current = null
      setPreviewing(false)
      return
    }
    const a = new Audio('ipod-audio://' + encodeURIComponent(path))
    audioRef.current = a
    a.onended = () => { setPreviewing(false); audioRef.current = null }
    setPreviewing(true)
    void a.play().catch(() => setPreviewing(false))
  }

  const discard = () => {
    stopEverything()
    setPath(null)
    setMic('idle')
    onProcessed(null)
  }

  return (
    <div className="mixtape-mic">
      {mic === 'idle' && (
        <button type="button" className="mixtape-mic-btn" onClick={() => { void startRecording() }}
          title="Record a few seconds of your voice onto the tape — it comes out sounding like 1979">
          <MicIcon /> Record intro
        </button>
      )}
      {mic === 'recording' && (
        <button type="button" className="mixtape-mic-btn mixtape-mic-btn--rec" onClick={stopRecording}
          title="Stop recording">
          <span className="mixtape-mic-dot" /> Recording… {seconds}s — click to stop
        </button>
      )}
      {mic === 'processing' && (
        <span className="mixtape-mic-status">Dubbing to tape…</span>
      )}
      {mic === 'ready' && (
        <span className="mixtape-mic-ready">
          <button type="button" className="mixtape-mic-btn" onClick={preview}>
            {previewing ? '■ Stop' : '▶ Hear the tape'}
          </button>
          <button type="button" className="mixtape-mic-btn mixtape-mic-btn--ghost" onClick={() => { discard(); void startRecording() }}>
            Re-record
          </button>
          <button type="button" className="mixtape-mic-btn mixtape-mic-btn--ghost" onClick={discard}>
            Remove
          </button>
        </span>
      )}
      {mic === 'error' && (
        <span className="mixtape-mic-status mixtape-mic-status--error">
          {error}{' '}
          <button type="button" className="mixtape-mic-btn mixtape-mic-btn--ghost" onClick={() => { setMic(path ? 'ready' : 'idle'); setError('') }}>OK</button>
        </span>
      )}
    </div>
  )
}

function MicIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8" />
    </svg>
  )
}

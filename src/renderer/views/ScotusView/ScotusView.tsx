import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { ScotusArchiveData, ScotusSegment } from '../../types'
import './scotus.css'

// The Beck v. Prupis exhibit — Michael Rosenbaum's ("Poppy's") 1999 Supreme
// Court argument. The audio + transcript live in a private vault (never the
// music library); this view is the hub: a synced player, the Justice colonnade
// that lights up as each one speaks, the case story, and Amicus — a plain-
// English guide you can ask anything as you listen.

function fmt(s: number): string {
  if (!s || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
function lastName(name: string): string {
  return name.split(' ').pop() || name
}
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('')
}

// Amicus speaks in Jake's chosen ElevenLabs voice (reuses the musicman-speak
// pipeline, which takes a voiceId override).
const AMICUS_VOICE = 'L0Dsvb3SLTyegXwtm47J'

export default function ScotusView() {
  const [data, setData] = useState<ScotusArchiveData | null>(null)
  const [loading, setLoading] = useState(true)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [amicus, setAmicus] = useState<{ loading: boolean; answer: string } | null>(null)
  const [question, setQuestion] = useState('')
  const [voiceOn, setVoiceOn] = useState(true)
  const [speaking, setSpeaking] = useState(false)
  const amicusAudioRef = useRef<HTMLAudioElement | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const activeSegRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    window.electronAPI.scotusGetArchive?.().then((r) => {
      if (!cancelled && r?.ok) setData(r as ScotusArchiveData)
    }).catch(() => { /* empty state */ }).finally(() => { if (!cancelled) setLoading(false) })
    window.electronAPI.scotusGetAudio?.().then((r) => {
      if (cancelled || !r?.ok || !r.bytes) return
      url = URL.createObjectURL(new Blob([r.bytes], { type: 'audio/mpeg' }))
      setAudioUrl(url)
    }).catch(() => { /* no audio */ })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [])

  const segments: ScotusSegment[] = useMemo(() => data?.segments || [], [data])

  // Active segment = the last one whose start time has passed (binary search).
  const activeIdx = useMemo(() => {
    if (!segments.length) return -1
    let lo = 0, hi = segments.length - 1, ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (segments[mid].start <= time + 0.05) { ans = mid; lo = mid + 1 } else hi = mid - 1
    }
    return ans
  }, [segments, time])
  const currentSpeaker = activeIdx >= 0 ? segments[activeIdx].speaker : ''

  const seekTo = useCallback((t: number) => {
    const a = audioRef.current
    if (a) { a.currentTime = t; if (a.paused) void a.play() }
  }, [])

  // Pin the live line near the TOP of the box — you read downward into what's
  // coming, never scrolling up to find the current line. (offsetTop is
  // box-relative because .scotus-transcript is position:relative.)
  useEffect(() => {
    const el = activeSegRef.current, box = transcriptRef.current
    if (el && box) box.scrollTo({ top: Math.max(0, el.offsetTop - 14), behavior: 'smooth' })
  }, [activeIdx])

  const toggle = () => { const a = audioRef.current; if (!a) return; if (a.paused) void a.play(); else a.pause() }

  const stopAmicusVoice = useCallback(() => {
    const a = amicusAudioRef.current
    if (a) { a.pause(); a.src = ''; amicusAudioRef.current = null }
    setSpeaking(false)
  }, [])
  const speakAmicus = useCallback(async (text: string) => {
    stopAmicusVoice()
    if (!voiceOn || !text) return
    try {
      const tts = await window.electronAPI.musicmanSpeak(text, false, AMICUS_VOICE)
      if (tts?.ok && tts.audio) {
        const a = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
        amicusAudioRef.current = a
        a.onended = () => setSpeaking(false)
        setSpeaking(true)
        await a.play().catch(() => setSpeaking(false))
      }
    } catch { setSpeaking(false) }
  }, [voiceOn, stopAmicusVoice])
  // Stop Amicus's voice when leaving the exhibit.
  useEffect(() => () => stopAmicusVoice(), [stopAmicusVoice])

  const explain = useCallback(async () => {
    audioRef.current?.pause() // don't let Amicus talk over the argument
    setAmicus({ loading: true, answer: '' })
    const r = await window.electronAPI.scotusAmicus?.({ mode: 'explain', time }).catch(() => null)
    const ans = r?.ok ? (r.answer || '') : (r?.error || 'Amicus is unavailable right now.')
    setAmicus({ loading: false, answer: ans })
    if (r?.ok) void speakAmicus(ans)
  }, [time, speakAmicus])
  const ask = useCallback(async () => {
    const q = question.trim()
    if (!q) return
    audioRef.current?.pause()
    setAmicus({ loading: true, answer: '' }); setQuestion('')
    const r = await window.electronAPI.scotusAmicus?.({ mode: 'ask', time, question: q }).catch(() => null)
    const ans = r?.ok ? (r.answer || '') : (r?.error || 'Amicus is unavailable right now.')
    setAmicus({ loading: false, answer: ans })
    if (r?.ok) void speakAmicus(ans)
  }, [question, time, speakAmicus])

  // Transcript list — memoized on activeIdx so it isn't rebuilt every time-tick.
  const transcriptEls = useMemo(() => segments.map((s, i) => (
    <div
      key={i}
      ref={i === activeIdx ? activeSegRef : undefined}
      className={`scotus-seg scotus-seg--${s.role} ${i === activeIdx ? 'scotus-seg--active' : ''}`}
      onClick={() => seekTo(s.start)}
      title={`Jump to ${fmt(s.start)}`}
    >
      <span className="scotus-seg-speaker">{s.speaker}</span>
      <span className="scotus-seg-text">{s.text}</span>
    </div>
  )), [segments, activeIdx, seekTo])

  if (loading) return <div className="scotus-view"><div className="scotus-loading">Opening the archive…</div></div>
  if (!data?.exists || !data.case) {
    return (
      <div className="scotus-view">
        <div className="scotus-empty">
          The <em>Beck v. Prupis</em> recording isn’t in this machine’s archive yet — it lives only where the MP3 was vaulted.
        </div>
      </div>
    )
  }
  const c = data.case

  return (
    <div className="scotus-view">
      <header className="scotus-hero">
        <div className="scotus-hero-kicker">Supreme Court of the United States · Oral Argument</div>
        <h1 className="scotus-hero-title">{c.name}</h1>
        <div className="scotus-hero-cite">{c.citation} · {c.docket}</div>
        <div className="scotus-hero-dates">Argued {c.argued} · Decided {c.decided}</div>
        <div className="scotus-hero-poppy">
          Argued by <strong>{c.poppy}</strong> — Poppy — for the respondents.{' '}
          <span className="scotus-won">Won, {c.vote}.</span>
        </div>
      </header>

      {/* The colonnade — each Justice lights up while they speak */}
      <section className="scotus-court" aria-label="The Court">
        {(data.justices || []).map((j) => (
          <div
            key={j.slug}
            className={`scotus-justice ${currentSpeaker === j.name ? 'scotus-justice--speaking' : ''}`}
            title={`${j.name}\n${j.title}${j.note ? '\n' + j.note : ''}`}
          >
            {j.portrait
              ? <img src={j.portrait} alt={j.name} draggable={false} />
              : <div className="scotus-justice-ph">{initials(j.name)}</div>}
            <div className="scotus-justice-name">{lastName(j.name)}</div>
          </div>
        ))}
      </section>

      <div className="scotus-nowspeaking">
        {currentSpeaker ? <>Now speaking: <strong>{currentSpeaker}</strong></> : 'Press play to step into the room.'}
      </div>

      <div className="scotus-player">
        <button className="scotus-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="scotus-time">{fmt(time)}</span>
        <input
          className="scotus-seek" type="range" min={0} max={duration || 3635} step={0.1}
          value={time} onChange={(e) => seekTo(+e.target.value)} aria-label="Seek"
        />
        <span className="scotus-time scotus-time--total">{fmt(duration || 3635)}</span>
      </div>

      <div className="scotus-main">
        <div className="scotus-transcript" ref={transcriptRef}>{transcriptEls}</div>
        <aside className={`scotus-amicus ${speaking ? 'scotus-amicus--speaking' : ''}`}>
          <div className="scotus-amicus-head">
            <span className="scotus-amicus-name">Amicus</span>
            <span className="scotus-amicus-tag">your guide in the room</span>
            <button
              className="scotus-amicus-voice"
              onClick={() => { stopAmicusVoice(); setVoiceOn((v) => !v) }}
              title={voiceOn ? 'Voice on — click to mute' : 'Voice off — click to unmute'}
              aria-label="Toggle Amicus voice"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M3.2 6h2L8 3.6v8.8L5.2 10h-2z" />
                {voiceOn
                  ? <path d="M10.4 5.4a3.4 3.4 0 0 1 0 5.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  : <path d="M10.6 6.4 13.4 9.6M13.4 6.4 10.6 9.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
              </svg>
            </button>
          </div>
          <button className="scotus-amicus-explain" onClick={() => void explain()}>Explain this moment</button>
          <div className="scotus-amicus-body">
            {amicus?.loading
              ? <div className="scotus-amicus-loading">Amicus is reading the room…</div>
              : amicus?.answer
                ? <p>{amicus.answer}</p>
                : <p className="scotus-amicus-hint">Lost in the legalese? Hit “Explain this moment” whenever you’re unsure — or ask me anything about what’s being argued.</p>}
          </div>
          <div className="scotus-amicus-ask">
            <input
              value={question} onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void ask() }}
              placeholder="Ask Amicus…" spellCheck={false}
            />
            <button onClick={() => void ask()} disabled={!question.trim()}>Ask</button>
          </div>
        </aside>
      </div>

      <section className="scotus-case">
        <h2 className="scotus-h2">The Case</h2>
        <div className="scotus-case-grid">
          <div className="scotus-case-card"><h3>Background</h3><p>{c.background}</p></div>
          <div className="scotus-case-card"><h3>The Question</h3><p>{c.question}</p></div>
          <div className="scotus-case-card"><h3>The Result</h3><p>{c.holding}</p></div>
          <div className="scotus-case-card"><h3>Why It Matters</h3><p>{c.significance}</p></div>
        </div>
      </section>

      <section className="scotus-players">
        <h2 className="scotus-h2">The Advocates</h2>
        <div className="scotus-advocates">
          {(data.advocates || []).map((a) => (
            <div key={a.name} className={`scotus-adv scotus-adv--${a.side}`}>
              <div className="scotus-adv-name">{a.name}</div>
              <div className="scotus-adv-role">{a.role}</div>
              {a.note && <div className="scotus-adv-note">{a.note}</div>}
            </div>
          ))}
        </div>

        <h2 className="scotus-h2">The Court — {c.court}</h2>
        <div className="scotus-roster">
          {(data.justices || []).map((j) => (
            <div key={j.slug} className="scotus-roster-j">
              {j.portrait
                ? <img src={j.portrait} alt={j.name} draggable={false} />
                : <div className="scotus-roster-ph">{initials(j.name)}</div>}
              <div className="scotus-roster-info">
                <div className="scotus-roster-name">{j.name}</div>
                <div className="scotus-roster-title">{j.title}</div>
                <div className={`scotus-roster-vote scotus-roster-vote--${j.vote}`}>
                  {j.vote === 'majority' ? 'Majority' : 'Dissent'}{j.note ? ` · ${j.note}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="scotus-footer">
        Recording &amp; transcript: official U.S. Supreme Court audio via Oyez. Facts verified against Oyez,
        Justia, and Cornell LII. A one-of-one exhibit — kept out of your music library, by design.
      </footer>

      <audio
        ref={audioRef}
        src={audioUrl || undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />
    </div>
  )
}

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { ScotusArchiveData, ScotusOpinionDoc, ScotusSegment } from '../../types'
import './scotus.css'

// The Beck v. Prupis exhibit — Michael Rosenbaum's ("Poppy's") 1999 Supreme
// Court argument. The audio + transcript live in a private vault (never the
// music library); this view is the hub: a synced player, the Justice colonnade
// that lights up as each one speaks, the case story, and Amicus — a plain-
// English guide you can read or have read aloud, and ask anything.

function fmt(s: number): string {
  if (!s || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
function lastName(name: string): string {
  return name.split(' ').pop() || name
}
/**
 * Apostrophe-proof name equality. The roster writes "Sandra Day O’Connor"
 * with a typographic apostrophe; the transcript's speaker field uses an
 * ASCII one — `===` silently failed ONLY for her, so her tile never lit
 * while she spoke.
 * ⚠️ TWIN: src/main/scotus-archive/index.ts sameName() — same rule feeds
 * portraitSlug() on the main side. Keep in sync.
 */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
  return norm(a) === norm(b)
}
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('')
}

// Amicus speaks in Jake's chosen ElevenLabs voice (reuses the musicman-speak
// pipeline, which takes a voiceId override).
const AMICUS_VOICE = '8Ln42OXYupYsag45MAUy'

// Session caches (module scope). The hour-long MP3 is pulled over IPC once
// per app session — the blob URL is deliberately never revoked while the app
// runs. Position + speed survive tab switches: leave the exhibit, come back,
// and you're exactly where you left off (paused).
let cachedAudioUrl: string | null = null
let savedPositionSec = 0
let savedRate = 1
const RATE_ORDER = [1, 1.25, 1.5, 0.75]

export default function ScotusView() {
  const [data, setData] = useState<ScotusArchiveData | null>(null)
  const [loading, setLoading] = useState(true)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  // Amicus chat thread — the back-and-forth is visible, and the history rides
  // along on each call so follow-ups ("what does that mean?") resolve.
  // Amicus replies may carry cues: moments on the tape he cited, rendered as
  // jump chips under the bubble.
  const [chat, setChat] = useState<Array<{ role: 'user' | 'amicus'; text: string; cues?: Array<{ time: number; label: string }> }>>([])
  const [thinking, setThinking] = useState(false)
  const [question, setQuestion] = useState('')
  const [speakingIdx, setSpeakingIdx] = useState(-1)
  const [speakNote, setSpeakNote] = useState('')
  // The Decision section — which opinion documents are unfolded.
  const [openOps, setOpenOps] = useState<{ majority: boolean; dissent: boolean }>({ majority: false, dissent: false })
  const amicusAudioRef = useRef<HTMLAudioElement | null>(null)
  const chatBoxRef = useRef<HTMLDivElement | null>(null)
  const chatRef = useRef<typeof chat>([])
  useEffect(() => { chatRef.current = chat }, [chat])
  // Keep the newest exchange in view.
  useEffect(() => {
    const el = chatBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat, thinking])
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const activeSegRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.scotusGetArchive?.().then((r) => {
      if (!cancelled && r?.ok) setData(r as ScotusArchiveData)
    }).catch(() => { /* empty state */ }).finally(() => { if (!cancelled) setLoading(false) })
    if (cachedAudioUrl) {
      setAudioUrl(cachedAudioUrl)
    } else {
      window.electronAPI.scotusGetAudio?.().then((r) => {
        if (cancelled || !r?.ok || !r.bytes) return
        cachedAudioUrl = URL.createObjectURL(new Blob([new Uint8Array(r.bytes)], { type: 'audio/mpeg' }))
        setAudioUrl(cachedAudioUrl)
      }).catch(() => { /* no audio */ })
    }
    return () => { cancelled = true }
  }, [])

  // Remember position + speed when leaving the exhibit (restored on return).
  useEffect(() => () => {
    const a = audioRef.current
    if (a) { savedPositionSec = a.currentTime; savedRate = a.playbackRate }
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
  // Podcast-style transport: ±15s skip (buttons and ←/→) — keeps play state.
  const seekBy = useCallback((delta: number) => {
    const a = audioRef.current
    if (!a) return
    a.currentTime = Math.min(Math.max(0, a.currentTime + delta), (a.duration || 3635) - 0.5)
  }, [])
  const [rate, setRate] = useState(savedRate)
  const cycleRate = useCallback(() => {
    setRate((r) => {
      const next = RATE_ORDER[(RATE_ORDER.indexOf(r) + 1) % RATE_ORDER.length]
      const a = audioRef.current
      if (a) a.playbackRate = next
      return next
    })
  }, [])

  // Pin the live line to the TOP of the box so you read downward into what's
  // coming. Bounding-rect math (not offsetTop) makes this correct regardless
  // of the box's positioning context.
  useEffect(() => {
    const el = activeSegRef.current, box = transcriptRef.current
    if (!el || !box) return
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top
    box.scrollTo({ top: box.scrollTop + delta - 12, behavior: 'smooth' })
  }, [activeIdx])

  const toggle = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) void a.play(); else a.pause()
  }, [])

  // Keyboard transport while the exhibit is open: Space = play/pause the
  // ARGUMENT, ←/→ = ±15s. Capture-phase + stopPropagation so App.tsx's
  // global space-toggles-music handler doesn't also fire underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); toggle() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); seekBy(-15) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekBy(15) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [toggle, seekBy])

  // Smoothly fade the argument's volume (duck/restore) — like the Music Man mic.
  // Generation counter: starting a new fade CANCELS any in-flight one. Without
  // this, stopSpeak's fade-up (400ms) raced the duck's fade-down (300ms) and,
  // finishing last, silently restored FULL volume under Amicus — the duck
  // never held.
  const fadeGenRef = useRef(0)
  const fadeVolume = useCallback((target: number, ms: number) => {
    const a = audioRef.current
    if (!a) return
    const gen = ++fadeGenRef.current
    const from = a.volume
    const t0 = performance.now()
    const step = () => {
      if (fadeGenRef.current !== gen) return // superseded by a newer fade
      const el = audioRef.current
      if (!el) return
      const p = Math.min(1, (performance.now() - t0) / ms)
      el.volume = from + (target - from) * p
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [])

  // ── Amicus voice: ON DEMAND, exactly like the Music Man mic button. The click
  // is a fresh user gesture (so playback isn't blocked), and the argument DUCKS
  // — fades down, never pauses — while Amicus talks, then rises back. ──
  const stopSpeak = useCallback(() => {
    const a = amicusAudioRef.current
    if (a) { a.pause(); a.src = ''; amicusAudioRef.current = null }
    setSpeakingIdx(-1)
    fadeVolume(1, 400)
  }, [fadeVolume])
  const speakBubble = useCallback(async (idx: number, raw: string) => {
    if (speakingIdx === idx) { stopSpeak(); return }
    stopSpeak()
    if (!raw) return
    // Flash TTS hallucinates a garbled "yelp" at the end when the text doesn't
    // finish on a clean, complete sentence. Trim any dangling tail to the last
    // sentence-ending punctuation, and guarantee a terminal mark, so the voice
    // always has a clean place to stop.
    let text = raw.replace(/\s+/g, ' ').trim()
    const lastEnd = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'))
    if (lastEnd >= 20) text = text.slice(0, lastEnd + 1)
    if (!/[.!?]$/.test(text)) text += '.'
    setSpeakNote('')
    setSpeakingIdx(idx)
    // Duck the argument under Amicus — don't pause it. 0.04, far deeper than
    // the Music Man's 0.15 music duck: this is speech under speech, and two
    // voices at once just fight each other. Near-mute, still audibly "there."
    fadeVolume(0.04, 300)
    const restore = () => { setSpeakingIdx(-1); fadeVolume(1, 600) }
    try {
      // fast=true → ElevenLabs flash: speech starts in ~1s, not ~10s.
      const tts = await window.electronAPI.musicmanSpeak(text, true, AMICUS_VOICE)
      if (tts?.ok && tts.audio) {
        const a = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
        amicusAudioRef.current = a
        a.onended = restore
        await a.play().catch(restore)
      } else {
        restore()
        setSpeakNote('Amicus’s voice needs the AI voice turned on (Preferences → AI).')
      }
    } catch {
      restore()
      setSpeakNote('Couldn’t reach the voice just now — try again.')
    }
  }, [speakingIdx, stopSpeak, fadeVolume])
  // Stop Amicus's voice when leaving the exhibit.
  useEffect(() => () => stopSpeak(), [stopSpeak])

  // Shared send path: show the user's side of the exchange, call Amicus with
  // the thread so far, append his reply.
  const sendToAmicus = useCallback(async (mode: 'explain' | 'ask', userText: string, q?: string) => {
    stopSpeak()
    setSpeakNote('')
    const history = chatRef.current.slice(-6)
    setChat((c) => [...c, { role: 'user', text: userText }])
    setThinking(true)
    const r = await window.electronAPI.scotusAmicus?.({ mode, time, question: q, history }).catch(() => null)
    setThinking(false)
    setChat((c) => [...c, {
      role: 'amicus',
      text: r?.ok ? (r.answer || '') : (r?.error || 'Amicus is unavailable right now.'),
      cues: r?.ok && Array.isArray(r.cues) ? r.cues : undefined,
    }])
  }, [time, stopSpeak])
  const explain = useCallback(() => sendToAmicus('explain', `Explain this moment — ${fmt(time)}`), [sendToAmicus, time])
  const ask = useCallback(() => {
    const q = question.trim()
    if (!q) return
    setQuestion('')
    void sendToAmicus('ask', q, q)
  }, [question, sendToAmicus])

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

  // One opinion document — collapsed to its nameplate; unfolds to the full
  // verbatim slip-opinion text (blocks + footnotes from vault opinion.json).
  const renderOpinion = (doc: ScotusOpinionDoc, side: 'majority' | 'dissent') => {
    const open = openOps[side]
    const j = (data.justices || []).find((x) => x.slug === doc.slug)
    return (
      <article className={`scotus-op scotus-op--${side}`}>
        <button
          className="scotus-op-head"
          onClick={() => setOpenOps((o) => ({ ...o, [side]: !o[side] }))}
          aria-expanded={open}
        >
          {j?.portrait
            ? <img className="scotus-op-face" src={j.portrait} alt={doc.author} draggable={false} />
            : <span className="scotus-op-face scotus-op-face--ph">{initials(doc.author)}</span>}
          <span className="scotus-op-id">
            <span className="scotus-op-label">{doc.label}</span>
            <span className="scotus-op-author">Justice {doc.author}</span>
            <span className="scotus-op-joined">{doc.joined}</span>
          </span>
          <span className="scotus-op-toggle">{open ? 'Close ▴' : 'Read the full text ▾'}</span>
        </button>
        {open && (
          <div className="scotus-op-doc">
            {doc.blocks.map((b, i) =>
              b.kind === 'head'
                ? <div key={i} className="scotus-op-sec">{b.text}</div>
                : (
                  <p key={i} className={`scotus-op-p${b.kind === 'opener' ? ' scotus-op-p--opener' : ''}${b.kind === 'end' ? ' scotus-op-p--end' : ''}`}>
                    {b.text}
                  </p>
                ))}
            {doc.notes.length > 0 && (
              <div className="scotus-op-notes">
                <div className="scotus-op-notes-h">Notes</div>
                {doc.notes.map((n) => (
                  <p key={n.n} className="scotus-op-note"><span className="scotus-op-note-n">{n.n}.</span> {n.text}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </article>
    )
  }

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

      {/* The pill — the audio + who's speaking, in one place */}
      <div className="scotus-pill">
        <button className="scotus-skip" onClick={() => seekBy(-15)} title="Back 15 seconds (←)" aria-label="Back 15 seconds">
          <span className="scotus-skip-arrow">↺</span>15
        </button>
        <button className="scotus-pill-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (space)">
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="scotus-skip" onClick={() => seekBy(15)} title="Forward 15 seconds (→)" aria-label="Forward 15 seconds">
          15<span className="scotus-skip-arrow">↻</span>
        </button>
        <div className="scotus-pill-main">
          <div className="scotus-pill-name">
            {currentSpeaker ? <>Now speaking: <strong>{currentSpeaker}</strong></> : 'Press play to step into the room.'}
          </div>
          <div className="scotus-pill-scrub">
            <span className="scotus-pill-time">{fmt(time)}</span>
            <input
              className="scotus-pill-seek" type="range" min={0} max={duration || 3635} step={0.1}
              value={time} onChange={(e) => seekTo(+e.target.value)} aria-label="Seek"
              style={{ '--p': `${((time / (duration || 3635)) * 100).toFixed(2)}%` } as React.CSSProperties}
            />
            <span className="scotus-pill-time">{fmt(duration || 3635)}</span>
          </div>
        </div>
        <button className="scotus-rate" onClick={cycleRate} title="Playback speed" aria-label="Playback speed">
          {rate}×
        </button>
      </div>

      {/* Below the pill — the Justices, then the two advocates; each lights up while speaking */}
      <section className="scotus-court" aria-label="The Court and advocates">
        <div className="scotus-court-row">
          {(data.justices || []).map((j) => (
            <div
              key={j.slug}
              className={`scotus-justice ${sameName(currentSpeaker, j.name) ? 'scotus-justice--speaking' : ''}`}
              title={`${j.name}\n${j.title}${j.note ? '\n' + j.note : ''}`}
            >
              {j.portrait
                ? <img src={j.portrait} alt={j.name} draggable={false} />
                : <div className="scotus-justice-ph">{initials(j.name)}</div>}
              <div className="scotus-justice-name">{lastName(j.name)}</div>
            </div>
          ))}
        </div>
        <div className="scotus-court-label">At the podium</div>
        <div className="scotus-court-advocates">
          {(data.advocates || []).map((a) => (
            <div
              key={a.name}
              className={`scotus-justice scotus-justice--adv ${sameName(currentSpeaker, a.name) ? 'scotus-justice--speaking' : ''}`}
              title={`${a.name}\n${a.role}`}
            >
              {a.photo
                ? <img src={a.photo} alt={a.name} draggable={false} />
                : <div className="scotus-justice-ph">{initials(a.name)}</div>}
              <div className="scotus-justice-name">{lastName(a.name)}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="scotus-main">
        <div className="scotus-transcript" ref={transcriptRef}>{transcriptEls}</div>
        <aside className={`scotus-amicus ${speakingIdx >= 0 ? 'scotus-amicus--speaking' : ''}`}>
          <div className="scotus-amicus-head">
            <span className="scotus-amicus-name">Amicus</span>
            <span className="scotus-amicus-tag">your guide in the room</span>
            {chat.length > 0 && (
              <button className="scotus-chat-clear" onClick={() => { stopSpeak(); setChat([]) }} title="Clear the conversation">
                Clear
              </button>
            )}
          </div>
          <button className="scotus-amicus-explain" onClick={() => void explain()}>Explain this moment</button>
          <div className="scotus-chat" ref={chatBoxRef}>
            {chat.length === 0 && !thinking && (
              <p className="scotus-amicus-hint">Lost in the legalese? Hit “Explain this moment” whenever you’re unsure — or ask me anything. Our exchange stays right here, and I remember it, so follow-ups work.</p>
            )}
            {chat.map((m, i) => m.role === 'user'
              ? <div key={i} className="scotus-msg scotus-msg--user">{m.text}</div>
              : (
                <div key={i} className="scotus-msg scotus-msg--amicus">
                  <p>{m.text}</p>
                  {(m.cues?.length ?? 0) > 0 && (
                    <div className="scotus-msg-cues">
                      {m.cues!.map((cue) => (
                        <button
                          key={`${cue.time}-${cue.label}`}
                          className="scotus-msg-cue"
                          onClick={() => seekTo(cue.time)}
                          title={`Play from ${fmt(cue.time)}`}
                        >
                          <span className="scotus-msg-cue-time">▶ {fmt(cue.time)}</span> {cue.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    className={`scotus-amicus-speak scotus-amicus-speak--sm ${speakingIdx === i ? 'is-speaking' : ''}`}
                    onClick={() => void speakBubble(i, m.text)}
                  >
                    {speakingIdx === i
                      ? <><span className="scotus-speak-ic">■</span> Stop</>
                      : <><span className="scotus-speak-ic">▶</span> Hear it</>}
                  </button>
                </div>
              ))}
            {thinking && <div className="scotus-msg scotus-msg--amicus scotus-msg--thinking">Amicus is reading the room…</div>}
            {speakNote && <div className="scotus-amicus-note">{speakNote}</div>}
          </div>
          <div className="scotus-amicus-ask">
            <input
              value={question} onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void ask() }}
              placeholder="Ask Amicus a question…" spellCheck={false}
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

      {(data.quotes?.length ?? 0) > 0 && (
        <section className="scotus-quotes">
          <h2 className="scotus-h2">From the Argument</h2>
          <p className="scotus-quotes-sub">The hall of fame — click any exchange to hear it.</p>
          <div className="scotus-quotes-grid">
            {data.quotes!.map((q) => (
              <button key={q.time} className="scotus-quote" onClick={() => seekTo(q.time)} title={`Play from ${fmt(q.time)}`}>
                <div className="scotus-quote-head">
                  <span className="scotus-quote-title">{q.title}</span>
                  <span className="scotus-quote-time">▶ {fmt(q.time)}</span>
                </div>
                {q.lines.map((l, i) => (
                  <p key={i} className={`scotus-quote-line ${l.speaker.includes('Rosenbaum') ? 'scotus-quote-line--poppy' : ''}`}>
                    <span className="scotus-quote-speaker">{l.speaker}:</span> “{l.text}”
                  </p>
                ))}
                {q.note && <div className="scotus-quote-note">{q.note}</div>}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="scotus-players">
        <h2 className="scotus-h2">The Advocates</h2>
        <div className="scotus-advocates">
          {(data.advocates || []).map((a) => (
            <div key={a.name} className={`scotus-adv scotus-adv--${a.side}`}>
              {a.photo
                ? <img className="scotus-adv-photo" src={a.photo} alt={a.name} draggable={false} />
                : <div className="scotus-adv-photo scotus-adv-photo--ph">{initials(a.name)}</div>}
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
              <div className="scotus-roster-head">
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
              {j.bio && <p className="scotus-roster-bio">{j.bio}</p>}
              <div className="scotus-roster-facts">
                {j.nominatedBy && (
                  <div className="scotus-roster-fact">
                    <span className="scotus-roster-fact-k">Nominated by</span>
                    <span>{j.nominatedBy}</span>
                  </div>
                )}
                {j.service && (
                  <div className="scotus-roster-fact">
                    <span className="scotus-roster-fact-k">On the Court</span>
                    <span>{j.service}</span>
                  </div>
                )}
                {/* Only the deceased get this row — a living Justice simply has none. */}
                {j.died && (
                  <div className="scotus-roster-fact">
                    <span className="scotus-roster-fact-k">Died</span>
                    <span>{j.died}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* The Decision — how it ended: the opinion that won it, and the dissent */}
      {data.opinion && (
        <section className="scotus-decision">
          <h2 className="scotus-h2">The Decision</h2>
          <p className="scotus-decision-lineup">{data.opinion.lineup}</p>
          {renderOpinion(data.opinion.majority, 'majority')}
          {renderOpinion(data.opinion.dissent, 'dissent')}
          <p className="scotus-decision-src">
            Verbatim slip-opinion text, {data.opinion.decided} — via Cornell Law School’s Legal Information Institute.
          </p>
        </section>
      )}

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
        onLoadedMetadata={(e) => {
          const a = e.currentTarget
          setDuration(a.duration)
          a.playbackRate = rate
          // Resume where you left off (paused) — unless you'd finished.
          if (savedPositionSec > 1 && savedPositionSec < a.duration - 5) {
            a.currentTime = savedPositionSec
            setTime(savedPositionSec)
          }
        }}
      />
    </div>
  )
}

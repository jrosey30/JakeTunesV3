/**
 * The Top 1000 Quiz (Jake, 2026-10-23: "to help get me to my 1000 favorite
 * songs faster, i want constant quizzes....to help expedite the AI brain
 * learning about what i like...similar to rocksurgence quiz...but more in
 * depth"). The Original iPod is his top 1000; this finds them.
 *
 * Endless: one question after another, every answer saved on homemini the
 * moment it's given, stop any time. homemini picks each question (songs near
 * the #1000 line the brain is least sure about) and keeps the ranking —
 * main/top1000-client.ts → common/top1000-doc.ts; this view only asks.
 *
 * Tap to hear: a 20-second snippet from about a third of the way in (no hook
 * detection yet), through the same ipod-audio:// path the player uses, so it
 * works on every Mac. Starting a snippet pauses whatever is playing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AlbumArtImage from '../components/AlbumArtImage'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { albumKeyOf } from '../utils/albumKey'
import { buildNormalizedArtworkIndex, lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import {
  QUIZ_REASONS, type QuizListEntry, type QuizProgress, type QuizQuestion, type QuizReason, type QuizSongRef,
} from '../../common/top1000-doc'
import type { Track } from '../types'
import '../styles/top1000-quiz.css'

const SNIPPET_MS = 20_000
/** Ask "what got you?" after every Nth decisive pick — often enough to teach, rare enough not to nag. */
const REASON_EVERY = 4

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done' }
  | { kind: 'ask'; q: QuizQuestion }
  | { kind: 'why'; q: QuizQuestion; winner: QuizSongRef }

const PROMPT: Record<QuizQuestion['kind'], string> = {
  pick: 'Which do you love more?',
  inout: 'Is this in your top 1000?',
  still: 'You starred this a while ago. Still love it?',
  best: 'Best of this sound?',
}

let musicRoot: string | null = null
async function snippetUrl(colonPath: string): Promise<string | null> {
  if (!colonPath) return null
  if (musicRoot === null) musicRoot = await window.electronAPI.getMusicLibraryPath().catch(() => '')
  return 'ipod-audio://' + encodeURIComponent((musicRoot || '') + colonPath.replace(/:/g, '/'))
}

export default function Top1000QuizView(): JSX.Element {
  const { state: lib, dispatch } = useLibrary()
  const { state: pb } = usePlayback()
  const { togglePlayPause } = useAudio()
  const [tab, setTab] = useState<'quiz' | 'list'>('quiz')
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [progress, setProgress] = useState<QuizProgress | null>(null)
  const [today, setToday] = useState(0)
  const [saving, setSaving] = useState(false)
  const [reasons, setReasons] = useState<QuizReason[]>([])
  const [hearing, setHearing] = useState<number | null>(null)
  const [list, setList] = useState<QuizListEntry[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const decisivePicks = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stopTimer = useRef<number | null>(null)

  const byId = useMemo(() => {
    const m = new Map<number, Track>()
    for (const t of lib.tracks) m.set(t.id, t)
    return m
  }, [lib.tracks])

  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const artFor = useCallback((t: Track | undefined): string | undefined => {
    if (!t) return undefined
    const key = albumKeyOf(t)
    if (lib.artworkMap[key]) return lib.artworkMap[key]
    return lookupArtwork(lib.artworkMap, artIndex, t.albumArtist || t.artist || '', t.album || '')
  }, [lib.artworkMap, artIndex])

  // ── snippets ── every start path below has its stop path in stopSnippet.
  const stopSnippet = useCallback(() => {
    if (stopTimer.current !== null) { window.clearTimeout(stopTimer.current); stopTimer.current = null }
    const a = audioRef.current
    if (a) { a.pause(); a.removeAttribute('src'); a.load() }
    audioRef.current = null
    setHearing(null)
  }, [])

  useEffect(() => stopSnippet, [stopSnippet])

  const hear = useCallback(async (song: QuizSongRef) => {
    if (hearing === song.id) { stopSnippet(); return }
    stopSnippet()
    const url = await snippetUrl(byId.get(song.id)?.path || '')
    if (!url) return
    if (pb.isPlaying) togglePlayPause()
    const a = new Audio(url)
    audioRef.current = a
    setHearing(song.id)
    a.addEventListener('loadedmetadata', () => {
      if (audioRef.current !== a) return
      if (song.hookMs > 0 && Number.isFinite(a.duration) && song.hookMs / 1000 < a.duration - 5) a.currentTime = song.hookMs / 1000
      void a.play().catch(() => { if (audioRef.current === a) stopSnippet() })
    }, { once: true })
    a.addEventListener('ended', () => { if (audioRef.current === a) stopSnippet() }, { once: true })
    a.addEventListener('error', () => { if (audioRef.current === a) stopSnippet() }, { once: true })
    stopTimer.current = window.setTimeout(() => { if (audioRef.current === a) stopSnippet() }, SNIPPET_MS + 4000)
  }, [hearing, stopSnippet, byId, pb.isPlaying, togglePlayPause])

  // ── questions ──
  const fetchNext = useCallback(async () => {
    stopSnippet()
    setReasons([])
    const r = await window.electronAPI.top1000Next?.().catch(() => null)
    if (!r) { setPhase({ kind: 'error', message: 'This build can’t reach the quiz.' }); return }
    if (!r.ok) { setPhase({ kind: 'error', message: r.error }); return }
    setProgress(r.value.progress)
    setPhase(r.value.question ? { kind: 'ask', q: r.value.question } : { kind: 'done' })
  }, [stopSnippet])

  useEffect(() => { void fetchNext() }, [fetchNext])

  // Covers for the songs on screen.
  useEffect(() => {
    if (phase.kind !== 'ask' && phase.kind !== 'why') return
    const missing = phase.q.songs
      .map((s) => byId.get(s.id))
      .filter((t): t is Track => !!t && !artFor(t))
      .map((t) => ({ artist: t.albumArtist || t.artist || '', album: t.album || '' }))
    if (missing.length) queueArtworkResolutions(missing, dispatch)
  }, [phase, byId, artFor, dispatch])

  const send = useCallback(async (q: QuizQuestion, choice: string, why?: QuizReason[]) => {
    if (saving) return
    setSaving(true)
    stopSnippet()
    try {
      const r = await window.electronAPI.top1000Answer?.({
        kind: q.kind, ids: q.songs.map((s) => String(s.id)), choice, reasons: why?.length ? why : undefined,
      }).catch(() => null)
      if (!r || !r.ok) {
        setPhase({ kind: 'error', message: r && !r.ok ? r.error : 'That answer wasn’t saved.' })
        return
      }
      setProgress(r.value)
      setToday((n) => n + 1)
      await fetchNext()
    } finally {
      setSaving(false)
    }
  }, [saving, stopSnippet, fetchNext])

  /** A song chosen on a pick / best question — sometimes ask why first. */
  const choose = useCallback((q: QuizQuestion, winner: QuizSongRef) => {
    decisivePicks.current++
    if (decisivePicks.current % REASON_EVERY === 0) {
      stopSnippet()
      setReasons([])
      setPhase({ kind: 'why', q, winner })
      return
    }
    void send(q, String(winner.id))
  }, [send, stopSnippet])

  // 1 / 2 / 3 pick the matching card.
  useEffect(() => {
    if (tab !== 'quiz' || phase.kind !== 'ask' || (phase.q.kind !== 'pick' && phase.q.kind !== 'best')) return
    const q = phase.q
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= q.songs.length) { e.preventDefault(); choose(q, q.songs[n - 1]!) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, phase, choose])

  // ── the list ──
  useEffect(() => {
    if (tab !== 'list') return
    let alive = true
    setListError(null)
    void window.electronAPI.top1000List?.().then((r) => {
      if (!alive || !r) return
      if (r.ok) { setList(r.value.list); setProgress(r.value.progress) } else setListError(r.error)
    })
    return () => { alive = false }
  }, [tab])

  const settledPct = progress ? Math.round((progress.settled / Math.max(1, progress.settled + progress.moving)) * 100) : 0

  const songCard = (q: QuizQuestion, s: QuizSongRef, i: number, choosable: boolean) => {
    const t = byId.get(s.id)
    const hash = artFor(t)
    return (
      <div key={s.id} className={`t1k-song${choosable ? ' t1k-song--choosable' : ''}`}>
        <button
          type="button"
          className="t1k-song-pick"
          disabled={!choosable || saving}
          onClick={() => choose(q, s)}
          title={choosable ? `Choose “${s.title}” (${i + 1})` : undefined}
        >
          <div className="t1k-art">
            {hash ? <AlbumArtImage hash={hash} alt={s.album || s.title} size={320} /> : <div className="t1k-art-empty" />}
            {choosable && <span className="t1k-key" aria-hidden="true">{i + 1}</span>}
          </div>
          <div className="t1k-title">{s.title}</div>
          <div className="t1k-artist">{s.artist}</div>
          {s.album && <div className="t1k-album">{s.album}{t?.year ? ` · ${t.year}` : ''}</div>}
        </button>
        <button type="button" className={`t1k-hear${hearing === s.id ? ' is-on' : ''}`} onClick={() => { void hear(s) }} disabled={!t?.path}>
          {hearing === s.id ? 'Stop' : 'Hear it'}
        </button>
      </div>
    )
  }

  return (
    <div className="t1k-view">
      <header className="t1k-head">
        <div className="t1k-head-row">
          <h1 className="t1k-h1">Top 1000</h1>
          <div className="t1k-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'quiz'} className={tab === 'quiz' ? 'is-on' : ''} onClick={() => setTab('quiz')}>Quiz</button>
            <button type="button" role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'is-on' : ''} onClick={() => setTab('list')}>The list</button>
          </div>
        </div>
        <p className="t1k-lede">Finding your 1000 favorite songs, the ones the Original iPod carries. Every answer teaches the brain; stop whenever you like.</p>
        {progress && (
          <div className="t1k-progress" aria-label="Progress">
            <div className="t1k-meter"><div className="t1k-meter-fill" style={{ width: `${settledPct}%` }} /></div>
            <span><b>{progress.settled.toLocaleString()}</b> settled · {progress.moving.toLocaleString()} still moving · {progress.answered.toLocaleString()} answered{today > 0 ? ` (${today} today)` : ''}</span>
          </div>
        )}
      </header>

      {tab === 'quiz' && (
        <section className="t1k-stage" aria-live="polite">
          {phase.kind === 'loading' && <p className="t1k-note">Picking a question…</p>}
          {phase.kind === 'error' && (
            <div className="t1k-note">
              <p>{phase.message}</p>
              <button type="button" className="t1k-btn" onClick={() => { setPhase({ kind: 'loading' }); void fetchNext() }}>Try again</button>
            </div>
          )}
          {phase.kind === 'done' && <p className="t1k-note">No questions left right now — come back after a few more plays.</p>}

          {phase.kind === 'ask' && (
            <>
              <h2 className="t1k-prompt">{PROMPT[phase.q.kind]}</h2>
              <div className={`t1k-songs t1k-songs--${phase.q.songs.length}`}>
                {phase.q.songs.map((s, i) => songCard(phase.q, s, i, phase.q.kind === 'pick' || phase.q.kind === 'best'))}
              </div>
              <div className="t1k-actions">
                {phase.q.kind === 'pick' && (
                  <>
                    <button type="button" className="t1k-btn" disabled={saving} onClick={() => { void send(phase.q, 'both') }}>Both are top 1000</button>
                    <button type="button" className="t1k-btn" disabled={saving} onClick={() => { void send(phase.q, 'neither') }}>Neither</button>
                  </>
                )}
                {phase.q.kind === 'inout' && (
                  <>
                    <button type="button" className="t1k-btn t1k-btn--yes" disabled={saving} onClick={() => { void send(phase.q, 'in') }}>In</button>
                    <button type="button" className="t1k-btn t1k-btn--no" disabled={saving} onClick={() => { void send(phase.q, 'out') }}>Out</button>
                  </>
                )}
                {phase.q.kind === 'still' && (
                  <>
                    <button type="button" className="t1k-btn t1k-btn--yes" disabled={saving} onClick={() => { void send(phase.q, 'yes') }}>Still love it</button>
                    <button type="button" className="t1k-btn t1k-btn--no" disabled={saving} onClick={() => { void send(phase.q, 'no') }}>Not anymore</button>
                  </>
                )}
                <span className="t1k-actions-gap" />
                <button type="button" className="t1k-link" disabled={saving} onClick={() => { void send(phase.q, 'unknown') }}>
                  {phase.q.songs.length > 1 ? 'I don’t know these well enough' : 'I don’t know it well enough'}
                </button>
                <button type="button" className="t1k-link" disabled={saving} onClick={() => { void send(phase.q, 'skip') }}>Ask me later</button>
              </div>
            </>
          )}

          {phase.kind === 'why' && (
            <>
              <h2 className="t1k-prompt">What got you about “{phase.winner.title}”?</h2>
              <p className="t1k-sub">Pick any that fit. This is how the brain learns why, not just what.</p>
              <div className="t1k-chips" role="group" aria-label="Reasons">
                {QUIZ_REASONS.map((r) => {
                  const on = reasons.includes(r.id)
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      className={`t1k-chip${on ? ' is-on' : ''}`}
                      onClick={() => setReasons((cur) => (on ? cur.filter((x) => x !== r.id) : [...cur, r.id]))}
                    >{r.label}</button>
                  )
                })}
              </div>
              <div className="t1k-actions">
                <button type="button" className="t1k-btn t1k-btn--yes" disabled={saving} onClick={() => { void send(phase.q, String(phase.winner.id), reasons) }}>Save</button>
                <button type="button" className="t1k-link" disabled={saving} onClick={() => { void send(phase.q, String(phase.winner.id)) }}>Just the pick</button>
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'list' && (
        <section className="t1k-list">
          {listError && <p className="t1k-note">{listError}</p>}
          {!listError && !list && <p className="t1k-note">Loading your Top 1000…</p>}
          {list && (
            <ol className="t1k-rows">
              {list.map((e) => {
                const t = byId.get(e.id)
                if (!t) return null
                const settled = e.pIn >= 0.85
                return (
                  <li key={e.id} className="t1k-row">
                    <span className="t1k-rank">{e.rank}</span>
                    <span className="t1k-row-title">{t.title}</span>
                    <span className="t1k-row-artist">{t.artist}</span>
                    <span className={`t1k-state${settled ? ' is-settled' : ''}`}>{settled ? 'Settled' : 'Moving'}</span>
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      )}
    </div>
  )
}

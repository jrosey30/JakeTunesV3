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
 *
 * Wrong clicks (Jake, after 2,634 answers: "i feel like i may have accidently
 * hit the wrong songs sometimes"): only the cover picks a song — the title
 * block used to be part of the pick button, right on top of "Hear it". A
 * press that started before the question appeared, any answer in its first
 * 250 ms, and held-down keys never count. The last answer is echoed under the
 * question with Undo (Backspace), back through this session's answers.
 *
 * The tournament (Jake: "it has to almost work like a tournament....the more
 * you ask me about certain songs it feels like i am deciding between
 * children" — "i like heats....but when we gotta make tough
 * decisions....bracket one on one duels"). homemini serves HEATS — up to five
 * undecided songs; tap the covers (or 1–5) of the ones that move on, exactly
 * as many as it asks for, then Move them on (Enter) — moving on isn't making
 * the 1000, and a song is only out after two losses — and DUELS for
 * the songs still on the line after their heat: one on one, no "love both".
 * Every undecided song gets one heat a round; the meter shows the round and
 * what is left of it.
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
/** A click or key landing this soon after a question appears was meant for the one before. */
const CARRY_OVER_GUARD_MS = 250
/** Undo walks back at most this many of this session's answers (homemini keeps the same limit). */
const UNDO_DEPTH = 25
/** Ask "what got you?" after every Nth decisive pick — often enough to teach, rare enough not to nag. */
const REASON_EVERY = 4

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done' }
  | { kind: 'ask'; q: QuizQuestion }
  | { kind: 'why'; q: QuizQuestion; winner: QuizSongRef }

const PROMPT: Record<Exclude<QuizQuestion['kind'], 'heat'>, string> = {
  pick: 'Which do you love more?',
  duel: 'Tough call — only one gets the seat. Which advances?',
  // Jake (2026-10-23): "is this song in your top 1000" is a bad question — his yes means
  // "I love it". homemini asks it only when that is still open; seats come from this-or-that.
  inout: 'Do you love this song?',
  still: 'You starred this a while ago. Still love it?',
  best: 'Best of this sound?',
}

function promptFor(q: QuizQuestion): string {
  // Jake: "just because i pick songs to go to the next round doesnt mean they make the 1000".
  if (q.kind === 'heat') return `Which ${q.quota} move on?`
  return PROMPT[q.kind]
}

/**
 * The meter in plain words. Jake (after "seats decided" kept jumping): a countdown that only
 * goes down — the round of three and what is left of it — songs out (only up), and how sure the
 * brain is of the whole 1000 (the steady number). After the last round the 1000 is set and the
 * quiz keeps sharpening the close calls. An older homemini without the finish line gets the
 * round line it had.
 */
function meterLine(p: QuizProgress): string {
  const n = (x: number) => x.toLocaleString()
  const plural = (k: number, one: string, many: string) => `${n(k)} ${k === 1 ? one : many}`
  const parts: string[] = []
  if (p.round !== undefined) {
    const left = p.heatsLeft ? `${plural(p.heatsLeft, 'heat', 'heats')} left` : `${plural(p.duelsLeft ?? 0, 'tough call', 'tough calls')} left`
    if (p.totalRounds === undefined) parts.push(`Round ${n(p.round)} · ${left}`)
    else if (p.round <= p.totalRounds) parts.push(`Round ${n(p.round)} of ${n(p.totalRounds)} · ${left}`)
    else parts.push(`Your 1000 is set · sharpening round ${n(p.round - p.totalRounds)} · ${plural(p.duelsLeft ?? 0, 'close call', 'close calls')} left`)
  }
  if (p.out !== undefined) parts.push(`${n(p.out)} songs out`)
  if (p.sure !== undefined) parts.push(`the brain is ${Math.round(p.sure * 100)}% sure of the 1000`)
  if (p.round === undefined || p.totalRounds === undefined) {
    const fixed = p.fixed ? ` (${n(p.fixed)} by your lists)` : ''
    parts.push(`${n(p.settled)} seats decided${fixed}`, `${n(p.moving)} still open`)
  }
  parts.push(`${n(p.answered)} answered`)
  return parts.join(' · ')
}

/** The bar: how far through the tournament (rounds of three); after the finish line, how sure the brain is. */
function meterPct(p: QuizProgress): number {
  if (p.round !== undefined && p.totalRounds !== undefined && p.roundDone !== undefined) {
    if (p.round <= p.totalRounds) return Math.round((100 * ((p.round - 1) + p.roundDone)) / p.totalRounds)
    return Math.round(100 * (p.sure ?? 1))
  }
  return Math.round((p.settled / Math.max(1, p.settled + p.moving)) * 100)
}

interface SentAnswer { q: QuizQuestion; choice: string; picked?: number[] }

const quoted = (s: QuizSongRef | undefined): string => `“${s?.title ?? ''}”`

/** The answer just saved, in plain words. */
function describeAnswer({ q, choice, picked }: SentAnswer): string {
  const [a, b] = q.songs
  if (q.kind === 'heat' && choice === 'picked' && picked) {
    const inSongs = q.songs.filter((s) => picked.includes(s.id))
    const outSongs = q.songs.filter((s) => !picked.includes(s.id))
    return `Moved on: ${inSongs.map(quoted).join(', ')} · another shot next round: ${outSongs.map(quoted).join(', ')}`
  }
  switch (choice) {
    case 'skip': return 'Skipped'
    case 'unknown': return q.songs.length > 1
      ? `Didn’t know ${q.songs.map(quoted).join(' or ')} well enough`
      : `${quoted(a)} — don’t know it well enough`
    case 'both': return `Love both: ${quoted(a)} and ${quoted(b)}`
    case 'neither': return `Neither: ${quoted(a)} and ${quoted(b)}`
    case 'all': return `Love all three: ${q.songs.map(quoted).join(', ')}`
    case 'none': return `None of them: ${q.songs.map(quoted).join(', ')}`
    case 'in': return `${quoted(a)} — love it`
    case 'out': return `${quoted(a)} — not really`
    case 'yes': return `${quoted(a)} — still love it`
    case 'no': return `${quoted(a)} — not anymore`
  }
  const winner = q.songs.find((s) => String(s.id) === choice)
  if (!winner) return 'Saved'
  if (q.kind === 'duel') return `${quoted(winner)} advances over ${quoted(q.songs.find((s) => s !== winner))}`
  return `You picked ${quoted(winner)} over ${q.songs.filter((s) => s !== winner).map(quoted).join(' and ')}`
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
  /** This session's saved answers, newest last — what Undo walks back through. */
  const [history, setHistory] = useState<SentAnswer[]>([])
  const [undoNote, setUndoNote] = useState<string | null>(null)
  /** A heat's covers he has tapped so far (song ids). */
  const [picked, setPicked] = useState<number[]>([])
  const decisivePicks = useRef(0)
  /** When the current question appeared, and when the last press started (performance.now()). */
  const shownAt = useRef(0)
  const downAt = useRef(0)
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

  // ── wrong-click guards ──
  useEffect(() => {
    if (phase.kind === 'ask' || phase.kind === 'why') shownAt.current = performance.now()
  }, [phase])

  useEffect(() => {
    const onDown = () => { downAt.current = performance.now() }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  /** False for an answer meant for the previous question. Pass the click; keys pass nothing. */
  const ready = useCallback((click?: { detail: number }): boolean => {
    if (performance.now() - shownAt.current < CARRY_OVER_GUARD_MS) return false
    // detail 0 = a click made with the keyboard, which has no press to check
    if (click && click.detail > 0 && downAt.current < shownAt.current) return false
    return true
  }, [])

  const send = useCallback(async (q: QuizQuestion, choice: string, why?: QuizReason[], heatPicks?: number[]) => {
    if (saving) return
    setSaving(true)
    setUndoNote(null)
    stopSnippet()
    try {
      const r = await window.electronAPI.top1000Answer?.({
        kind: q.kind, ids: q.songs.map((s) => String(s.id)), choice, reasons: why?.length ? why : undefined,
        ...(q.kind === 'heat' ? { picked: (heatPicks ?? []).map(String), quota: q.quota } : {}),
      }).catch(() => null)
      if (!r || !r.ok) {
        setPhase({ kind: 'error', message: r && !r.ok ? r.error : 'That answer wasn’t saved.' })
        return
      }
      setProgress(r.value)
      setToday((n) => n + 1)
      setHistory((h) => [...h, { q, choice, picked: heatPicks }].slice(-UNDO_DEPTH))
      await fetchNext()
    } finally {
      setSaving(false)
    }
  }, [saving, stopSnippet, fetchNext])

  /** A song chosen on a pick / best question — sometimes ask why first. A duel just advances it. */
  const choose = useCallback((q: QuizQuestion, winner: QuizSongRef) => {
    if (saving) return
    if (q.kind === 'duel') { void send(q, String(winner.id)); return }
    decisivePicks.current++
    if (decisivePicks.current % REASON_EVERY === 0) {
      stopSnippet()
      setReasons([])
      setPhase({ kind: 'why', q, winner })
      return
    }
    void send(q, String(winner.id))
  }, [saving, send, stopSnippet])

  /** Take back the last saved answer and ask its question again. */
  const undo = useCallback(async () => {
    if (saving || history.length === 0) return
    setSaving(true)
    setUndoNote(null)
    stopSnippet()
    try {
      const r = await window.electronAPI.top1000Undo?.().catch((err: unknown) => {
        console.warn('[top1000] undo failed:', err)
        return null
      })
      if (!r) { setUndoNote('Undo isn’t available yet.'); return }
      if (!r.ok) { setUndoNote(r.error); return }
      setProgress(r.value.progress)
      const { undone, question } = r.value
      if (!undone) { setHistory([]); return }
      setToday((n) => Math.max(0, n - 1))
      // Only step this session's list back when homemini undid the answer it
      // shows; anything else (another Mac answered in between) clears it.
      setHistory((h) => {
        const top = h[h.length - 1]
        const same = !!top && top.choice === undone.choice && top.q.kind === undone.kind
          && top.q.songs.map((x) => String(x.id)).join(',') === undone.ids.join(',')
        return same ? h.slice(0, -1) : []
      })
      if (question) { setReasons([]); setPhase({ kind: 'ask', q: question }) }
    } finally {
      setSaving(false)
    }
  }, [saving, history.length, stopSnippet])

  /** "What got you?" comes before the pick is saved: undo there just un-picks. */
  const backFromWhy = useCallback(() => {
    if (phase.kind !== 'why' || saving) return
    decisivePicks.current = Math.max(0, decisivePicks.current - 1)
    setReasons([])
    setPhase({ kind: 'ask', q: phase.q })
  }, [phase, saving])

  // A new question starts with nothing tapped.
  useEffect(() => { if (phase.kind === 'ask') setPicked([]) }, [phase])

  /** Tap a heat cover: in, or back out. Never more than the quota. */
  const toggleHeat = useCallback((q: QuizQuestion, song: QuizSongRef) => {
    if (saving || q.kind !== 'heat') return
    setPicked((cur) => (cur.includes(song.id) ? cur.filter((x) => x !== song.id) : cur.length < (q.quota ?? 0) ? [...cur, song.id] : cur))
  }, [saving])

  const lockIn = useCallback((q: QuizQuestion) => {
    if (q.kind !== 'heat' || picked.length !== q.quota) return
    void send(q, 'picked', undefined, picked)
  }, [picked, send])

  // Keys: 1–5 pick (a heat: tap) the matching card, Enter locks a heat in, B both / all three, N neither / none, Backspace undo.
  useEffect(() => {
    if (tab !== 'quiz') return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Backspace') {
        e.preventDefault()
        if (e.repeat) return
        if (phase.kind === 'why') backFromWhy()
        else void undo()
        return
      }
      if (phase.kind !== 'ask') return
      const q = phase.q
      const key = e.key.toLowerCase()
      const n = Number(e.key)
      let act: (() => void) | null = null
      if (q.kind === 'heat' && n >= 1 && n <= q.songs.length) act = () => toggleHeat(q, q.songs[n - 1]!)
      else if (q.kind === 'heat' && e.key === 'Enter') act = () => lockIn(q)
      else if ((q.kind === 'pick' || q.kind === 'best' || q.kind === 'duel') && n >= 1 && n <= q.songs.length) act = () => choose(q, q.songs[n - 1]!)
      else if (q.kind === 'pick' && key === 'b') act = () => { void send(q, 'both') }
      else if (q.kind === 'pick' && key === 'n') act = () => { void send(q, 'neither') }
      else if (q.kind === 'best' && key === 'b') act = () => { void send(q, 'all') }
      else if (q.kind === 'best' && key === 'n') act = () => { void send(q, 'none') }
      if (!act) return
      e.preventDefault()
      // Holding a key never answers several questions.
      if (e.repeat || !ready()) return
      act()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, phase, choose, send, undo, backFromWhy, ready, toggleHeat, lockIn])

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

  const settledPct = progress ? meterPct(progress) : 0

  const songCard = (q: QuizQuestion, s: QuizSongRef, i: number, choosable: boolean) => {
    const t = byId.get(s.id)
    const hash = artFor(t)
    const isHeat = q.kind === 'heat'
    const isPicked = isHeat && picked.includes(s.id)
    const art = (
      <div className={`t1k-art${isPicked ? ' is-picked' : ''}`}>
        {hash ? <AlbumArtImage hash={hash} alt={s.album || s.title} size={320} /> : <div className="t1k-art-empty" />}
        {choosable && <span className="t1k-key" aria-hidden="true">{i + 1}</span>}
        {isPicked && <span className="t1k-in" aria-hidden="true">Moves on</span>}
      </div>
    )
    // Only the cover picks. The words under it are plain text, so a near-miss
    // on "Hear it" lands on nothing.
    return (
      <div key={s.id} className={`t1k-song${choosable ? ' t1k-song--choosable' : ''}`}>
        {choosable ? (
          <button
            type="button"
            className="t1k-song-pick"
            disabled={saving}
            onClick={(e) => { if (ready(e)) { if (isHeat) toggleHeat(q, s); else choose(q, s) } }}
            aria-pressed={isHeat ? isPicked : undefined}
            aria-label={isHeat ? `“${s.title}” by ${s.artist} moves on (${i + 1})` : `Choose “${s.title}” by ${s.artist} (${i + 1})`}
            title={isHeat ? `Move on: “${s.title}” (${i + 1})` : `Choose “${s.title}” (${i + 1})`}
          >
            {art}
          </button>
        ) : art}
        <div className="t1k-meta">
          <div className="t1k-title">{s.title}</div>
          <div className="t1k-artist">{s.artist}</div>
          {s.album && <div className="t1k-album">{s.album}{t?.year ? ` · ${t.year}` : ''}</div>}
        </div>
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
        <p className="t1k-lede">Finding your 1000 favorite songs, the ones the Original iPod carries. A tournament in three rounds: in each heat, pick the songs that move on; the tough calls go one on one. A song is only out after two losses. After round three your 1000 is set, and the quiz keeps sharpening the close calls. Stop whenever you like.</p>
        {progress && (
          <div className="t1k-progress" aria-label="Progress">
            <div className="t1k-meter"><div className="t1k-meter-fill" style={{ width: `${settledPct}%` }} /></div>
            <span>{meterLine(progress)}{today > 0 ? ` (${today} today)` : ''}</span>
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
              <h2 className="t1k-prompt">{promptFor(phase.q)}</h2>
              <div className={`t1k-songs t1k-songs--${phase.q.songs.length}`}>
                {phase.q.songs.map((s, i) => songCard(phase.q, s, i, ['pick', 'best', 'duel', 'heat'].includes(phase.q.kind)))}
              </div>
              <div className="t1k-actions">
                {phase.q.kind === 'heat' && (
                  <>
                    <button type="button" className="t1k-btn t1k-btn--yes" disabled={saving || picked.length !== phase.q.quota} onClick={(e) => { if (ready(e)) lockIn(phase.q) }}>
                      Move them on<kbd className="t1k-kbd">↵</kbd>
                    </button>
                    <span className="t1k-count">{picked.length} of {phase.q.quota} picked · moving on isn’t making the 1000, and nobody is cut in one heat: it takes two losses</span>
                  </>
                )}
                {phase.q.kind === 'pick' && (
                  <>
                    <button type="button" className="t1k-btn" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'both') }}>Love both<kbd className="t1k-kbd">B</kbd></button>
                    <button type="button" className="t1k-btn" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'neither') }}>Neither<kbd className="t1k-kbd">N</kbd></button>
                  </>
                )}
                {phase.q.kind === 'best' && (
                  <>
                    <button type="button" className="t1k-btn" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'all') }}>Love all three<kbd className="t1k-kbd">B</kbd></button>
                    <button type="button" className="t1k-btn" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'none') }}>None of them<kbd className="t1k-kbd">N</kbd></button>
                  </>
                )}
                {phase.q.kind === 'inout' && (
                  <>
                    <button type="button" className="t1k-btn t1k-btn--yes" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'in') }}>Love it</button>
                    <button type="button" className="t1k-btn t1k-btn--no" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'out') }}>Not really</button>
                  </>
                )}
                {phase.q.kind === 'still' && (
                  <>
                    <button type="button" className="t1k-btn t1k-btn--yes" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'yes') }}>Still love it</button>
                    <button type="button" className="t1k-btn t1k-btn--no" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'no') }}>Not anymore</button>
                  </>
                )}
                <span className="t1k-actions-gap" />
                <button type="button" className="t1k-link" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'unknown') }}>
                  {phase.q.songs.length > 1 ? 'I don’t know these well enough' : 'I don’t know it well enough'}
                </button>
                <button type="button" className="t1k-link" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'skip') }}>Ask me later</button>
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
                <button type="button" className="t1k-btn t1k-btn--yes" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, String(phase.winner.id), reasons) }}>Save</button>
                <button type="button" className="t1k-link" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, String(phase.winner.id)) }}>Just the pick</button>
                <span className="t1k-actions-gap" />
                <button type="button" className="t1k-link" disabled={saving} onClick={backFromWhy}>Wrong song? Undo<kbd className="t1k-kbd">⌫</kbd></button>
              </div>
            </>
          )}

          {phase.kind !== 'why' && phase.kind !== 'loading' && (history.length > 0 || undoNote) && (
            <p className="t1k-last">
              {history.length > 0 && <span>{describeAnswer(history[history.length - 1]!)}</span>}
              {history.length > 0 && (
                <button type="button" className="t1k-link" disabled={saving} onClick={() => { void undo() }}>Undo<kbd className="t1k-kbd">⌫</kbd></button>
              )}
              {undoNote && <span className="t1k-last-note">{undoNote}</span>}
            </p>
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

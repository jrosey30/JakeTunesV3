/**
 * The blind check (2026-11-24): about 280 two-song questions over a few
 * weeks, 15 a day, opened from the Top 1000 quiz page and shown in the quiz's
 * place. Blind on purpose: each song is its cover, title and artist, and
 * nothing else — no rank, plays, stars, scores or which list prefers which.
 *
 * homemini picks the questions and keeps the answers
 * (common/top1000-audit-doc.ts); main keeps each answer on this Mac's disk
 * before sending it (main/top1000-audit-outbox.ts), so no signal loses none.
 *
 * Keys: 1 / 2 pick, = about the same, ? don't know one of them, Space plays
 * or stops the preview. The quiz's wrong-click guards apply: nothing counts in
 * a question's first 250 ms, a press that began before it appeared, or a held key.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import AlbumArtImage from '../components/AlbumArtImage'
import { useLibrary } from '../context/LibraryContext'
import { queueArtworkResolutions } from '../utils/artworkLookup'
import { useQuizSnippet } from '../hooks/useQuizSnippet'
import { claimTransportKeys } from '../input-mode'
import {
  AUDIT_DONE_LINE, AUDIT_PROMPT, auditChoiceForKey, auditProgressLine, auditRestingLine,
  type AuditChoice, type AuditProgress, type AuditQuestion,
} from '../../common/top1000-audit-doc'
import type { QuizSongRef } from '../../common/top1000-doc'
import type { Track } from '../types'

const CARRY_OVER_GUARD_MS = 250

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done' }
  | { kind: 'resting' }
  | { kind: 'ask'; q: AuditQuestion }

interface Props {
  byId: Map<number, Track>
  artFor: (t: Track | undefined) => string | undefined
  onClose: () => void
}

export default function Top1000AuditPanel({ byId, artFor, onClose }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [progress, setProgress] = useState<AuditProgress | null>(null)
  const [saving, setSaving] = useState(false)
  const { hearing, hear, stopSnippet } = useQuizSnippet(byId)
  /** The song Space played last, so the next Space plays the other one. */
  const lastHeard = useRef<number | null>(null)
  const shownAt = useRef(0)
  const downAt = useRef(0)
  const { dispatch } = useLibrary()

  const fetchNext = useCallback(async () => {
    stopSnippet()
    lastHeard.current = null
    const r = await window.electronAPI.top1000AuditNext?.().catch((err: unknown) => {
      console.warn('[top1000-audit] next failed:', err)
      return null
    })
    if (!r) { setPhase({ kind: 'error', message: 'This build can’t reach the blind check.' }); return }
    if (!r.ok) { setPhase({ kind: 'error', message: r.error }); return }
    const s = r.value
    if (s.kind === 'off') { onClose(); return }
    if (s.progress) setProgress(s.progress)
    if (s.kind === 'done') setPhase({ kind: 'done' })
    else if (s.kind === 'resting') setPhase({ kind: 'resting' })
    else setPhase({ kind: 'ask', q: s.question })
  }, [stopSnippet, onClose])

  useEffect(() => { void fetchNext() }, [fetchNext])

  // Covers for the two songs on screen (as the quiz does).
  useEffect(() => {
    if (phase.kind !== 'ask') return
    const missing = phase.q.songs
      .map((s) => byId.get(s.id))
      .filter((t): t is Track => !!t && !artFor(t))
      .map((t) => ({ artist: t.albumArtist || t.artist || '', album: t.album || '' }))
    if (missing.length) queueArtworkResolutions(missing, dispatch)
  }, [phase, byId, artFor, dispatch])

  // ── wrong-click guards (the quiz's) ──
  useEffect(() => { if (phase.kind === 'ask') shownAt.current = performance.now() }, [phase])
  useEffect(() => {
    const onDown = () => { downAt.current = performance.now() }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])
  const ready = useCallback((click?: { detail: number }): boolean => {
    if (performance.now() - shownAt.current < CARRY_OVER_GUARD_MS) return false
    if (click && click.detail > 0 && downAt.current < shownAt.current) return false
    return true
  }, [])

  const send = useCallback(async (q: AuditQuestion, choice: AuditChoice) => {
    if (saving) return
    setSaving(true)
    stopSnippet()
    try {
      const r = await window.electronAPI.top1000AuditAnswer?.({ qid: q.qid, choice }).catch((err: unknown) => {
        console.warn('[top1000-audit] answer failed:', err)
        return null
      })
      if (!r || !r.ok) {
        setPhase({ kind: 'error', message: r && !r.ok ? r.error : 'That answer wasn’t saved. Try again.' })
        return
      }
      if (r.value.progress) setProgress(r.value.progress)
      setPhase({ kind: 'loading' })
      await fetchNext()
    } finally {
      setSaving(false)
    }
  }, [saving, stopSnippet, fetchNext])

  const spacePlay = useCallback((q: AuditQuestion) => {
    if (hearing !== null) { stopSnippet(); return }
    const [a, b] = q.songs
    const song = lastHeard.current === a.id ? b : a
    lastHeard.current = song.id
    void hear(song)
  }, [hearing, stopSnippet, hear])

  // App.tsx toggles the music on Space in the capture phase on window, before any view hears it.
  // While a question is up, Space is the preview's (as the Listen List does): claim it, and listen in
  // the capture phase too, so Space never starts or stops the library's music here.
  const asking = phase.kind === 'ask'
  useEffect(() => {
    if (!asking) return
    return claimTransportKeys('top1000-audit', ['Space'])
  }, [asking])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (phase.kind !== 'ask') return
      const q = phase.q
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) spacePlay(q)
        return
      }
      const choice = auditChoiceForKey(e.key)
      if (!choice) return
      e.preventDefault()
      if (e.repeat || !ready()) return
      void send(q, choice)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase, send, ready, spacePlay])

  const card = (q: AuditQuestion, s: QuizSongRef, i: number) => {
    const t = byId.get(s.id)
    const hash = artFor(t)
    const choice: AuditChoice = i === 0 ? 'first' : 'second'
    return (
      <div key={s.id} className="t1k-song t1k-song--choosable">
        <button
          type="button"
          className="t1k-song-pick"
          disabled={saving}
          onClick={(e) => { if (ready(e)) void send(q, choice) }}
          aria-label={`Choose “${s.title}” by ${s.artist} (${i + 1})`}
          title={`Choose “${s.title}” (${i + 1})`}
        >
          <div className="t1k-art">
            {hash ? <AlbumArtImage hash={hash} alt={s.title} size={320} /> : <div className="t1k-art-empty" />}
            <span className="t1k-key" aria-hidden="true">{i + 1}</span>
          </div>
        </button>
        <div className="t1k-meta">
          <div className="t1k-title">{s.title}</div>
          <div className="t1k-artist">{s.artist}</div>
        </div>
        <button
          type="button"
          className={`t1k-hear${hearing === s.id ? ' is-on' : ''}`}
          onClick={() => { lastHeard.current = s.id; void hear(s) }}
          disabled={!t?.path}
        >
          {hearing === s.id ? 'Stop' : 'Hear it'}
        </button>
      </div>
    )
  }

  return (
    <section className="t1k-stage t1k-audit" aria-live="polite">
      <div className="t1k-audit-head">
        <span className="t1k-audit-label">Blind check</span>
        {progress && <span className="t1k-audit-progress">{auditProgressLine(progress)}</span>}
        <span className="t1k-actions-gap" />
        <button type="button" className="t1k-link" onClick={() => { stopSnippet(); onClose() }}>Back to the quiz</button>
      </div>

      {phase.kind === 'loading' && <p className="t1k-note">Getting the next one…</p>}
      {phase.kind === 'error' && (
        <div className="t1k-note">
          <p>{phase.message}</p>
          <button type="button" className="t1k-btn" onClick={() => { setPhase({ kind: 'loading' }); void fetchNext() }}>Try again</button>
        </div>
      )}
      {phase.kind === 'resting' && <p className="t1k-note">{progress ? auditRestingLine(progress) : 'That’s today’s set. More tomorrow.'}</p>}
      {phase.kind === 'done' && <p className="t1k-note">{AUDIT_DONE_LINE}</p>}

      {phase.kind === 'ask' && (
        <>
          <h2 className="t1k-prompt">{AUDIT_PROMPT}</h2>
          <div className="t1k-songs t1k-songs--2">
            {phase.q.songs.map((s, i) => card(phase.q, s, i))}
          </div>
          <div className="t1k-actions">
            <button type="button" className="t1k-btn" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'equal') }}>
              About the same<kbd className="t1k-kbd">=</kbd>
            </button>
            <span className="t1k-actions-gap" />
            <button type="button" className="t1k-link" disabled={saving} onClick={(e) => { if (ready(e)) void send(phase.q, 'unknown') }}>
              Don’t know one of them<kbd className="t1k-kbd">?</kbd>
            </button>
          </div>
        </>
      )}
    </section>
  )
}

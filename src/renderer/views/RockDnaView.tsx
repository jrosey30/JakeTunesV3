/**
 * Rock DNA — Rocksurgence step 2 (2026-10-11), the Record Shop's fourth tab.
 * A taste assessment, one question per screen, saved after every answer.
 * Questions, branching and the profile live in src/common/rock-dna.ts (pure,
 * node-tested); this view only walks them. Covers and "in your library"
 * notes come from Jake's own library; owned songs play through the existing
 * player (useAudio) — no new playback, no previews from outside.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import AlbumArtImage from '../components/AlbumArtImage'
import ConfirmDialog from '../components/ConfirmDialog'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../utils/artworkLookup'
import {
  SECTIONS, RATINGS, LEVEL_LABEL, TURNOFF_LABEL, EMPTY_DNA, activeScreens, screenById, isAnswered, resumeScreen, nextScreen, prevScreen,
  progress, retake, buildProfile, dnaPromptLine, normalizeDnaState,
  type DnaState, type DnaScreen, type DnaOption, type Rating, type TraitId, type TraitLevel,
} from '../../common/rock-dna'
import type { Track } from '../types'
import '../styles/rock-dna.css'

const nk = (s: string | undefined): string => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
/** "Black Dog (Remaster)" and "Black Dog - 2012 Remaster" are the song "Black Dog". */
const songKey = (s: string | undefined): string => nk(String(s || '').replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+-\s+.*$/, ''))

type Mode = 'intro' | 'quiz' | 'profile'

export default function RockDnaView(): JSX.Element {
  const { state: lib } = useLibrary()
  const { playTrack } = useAudio()
  const [dna, setDna] = useState<DnaState | null>(null)
  const [exceptions, setExceptions] = useState<Array<{ artist: string; genre: string }>>([])
  const [mode, setMode] = useState<Mode>('intro')
  const [cur, setCur] = useState<string | null>(null)
  const [returnToProfile, setReturnToProfile] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRetake, setConfirmRetake] = useState(false)

  useEffect(() => {
    let live = true
    window.electronAPI.rockDnaLoad?.().then((r) => {
      if (!live) return
      const st = normalizeDnaState(r.state)
      setDna(st)
      setExceptions(r.exceptions ?? [])
      setMode(st.completedAt ? 'profile' : 'intro')
    }).catch(() => { if (live) setDna({ ...EMPTY_DNA }) })
    return () => { live = false }
  }, [])

  const save = useCallback((next: DnaState): void => {
    setDna(next)
    window.electronAPI.rockDnaSave?.(next).then((r) => setError(r.ok ? null : `Couldn't save: ${r.error ?? 'unknown error'}`))
      .catch((e) => setError(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`))
  }, [])

  // ── The library, for covers, notes and playable songs ──
  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const byArtist = useMemo(() => {
    const m = new Map<string, Track[]>()
    for (const t of lib.tracks) {
      for (const a of new Set([nk(t.albumArtist), nk(t.artist)])) {
        if (!a) continue
        const list = m.get(a) ?? []
        list.push(t)
        m.set(a, list)
      }
    }
    return m
  }, [lib.tracks])
  const artistInfo = useCallback((name: string) => {
    const ts = byArtist.get(nk(name)) ?? []
    const plays = new Map<string, number>()
    for (const t of ts) if (t.album) plays.set(t.album, (plays.get(t.album) ?? 0) + (t.playCount || 0) + 1)
    let hash: string | undefined
    for (const [album] of [...plays.entries()].sort((a, b) => b[1] - a[1])) {
      hash = lookupArtwork(lib.artworkMap, artIndex, ts.find((t) => t.album === album)?.albumArtist || name, album)
      if (hash) break
    }
    const starred = ts.filter((t) => (t.rating || 0) >= 4).length
    const note = ts.length ? `${ts.length.toLocaleString()} song${ts.length === 1 ? '' : 's'} in your library${starred ? ` · ${starred} starred` : ''}` : 'Not in your library'
    return { hash, note, count: ts.length }
  }, [byArtist, lib.artworkMap, artIndex])
  const ownedSong = useCallback((artist: string, title: string): Track | undefined => {
    const want = songKey(title)
    return (byArtist.get(nk(artist)) ?? []).filter((t) => songKey(t.title) === want).sort((a, b) => (b.playCount || 0) - (a.playCount || 0))[0]
  }, [byArtist])

  if (!dna) return <div className="dna dna--loading" />

  const screens = activeScreens(dna)
  const { answered, total } = progress(dna)
  const now = (): string => new Date().toISOString()

  /** Done: stamp it, show the profile. The Record Shop regenerates with the
   *  profile once, the first time a run finishes. */
  const complete = (st: DnaState): void => {
    save({ ...st, completedAt: st.completedAt ?? now(), position: undefined })
    setMode('profile')
    setReturnToProfile(false)
    if (!st.completedAt) void window.electronAPI.getDiscoverFeed?.(true)
  }
  const open = (s: DnaScreen | null): void => {
    if (!s) { complete(dna); return }
    setCur(s.id)
    setMode('quiz')
    save({ ...dna, position: s.id, startedAt: dna.startedAt ?? now() })
  }
  const advance = (next: DnaState, fromId: string): void => {
    if (returnToProfile) { save({ ...next, position: undefined }); setMode('profile'); setReturnToProfile(false); return }
    const n = nextScreen(next, fromId) ?? resumeScreen({ ...next, position: undefined })
    if (!n || n.id === fromId) { complete(next); return }
    setCur(n.id)
    save({ ...next, position: n.id })
  }
  const answer = (s: DnaScreen, a: DnaState['answers'][string]): void => {
    advance({ ...dna, answers: { ...dna.answers, [s.id]: { ...a, at: now() } } }, s.id)
  }

  // ── Intro ──
  if (mode === 'intro') {
    const resume = resumeScreen(dna)
    return (
      <div className="dna">
        <div className="dna-intro">
          <div className="dna-eyebrow">Rocksurgence</div>
          <h1 className="dna-title">Rock DNA</h1>
          <p className="dna-lede">Not trivia. There are no right answers. Your answers about the bands that made rock teach JakeTunes <em>why</em> you love what you love, so the Record Shop can dig for the new bands that will hit the same way.</p>
          <ul className="dna-facts">
            <li>About {screens.length} questions, one at a time, 10 to 15 minutes.</li>
            <li>Skip anything. Stop anywhere. Every answer saves as you go.</li>
            <li>Picking one band never counts against the others.</li>
          </ul>
          <div className="dna-actions">
            <button type="button" className="dna-btn dna-btn--primary" onClick={() => open(resume ?? screens[0])}>
              {answered > 0 ? `Resume (${answered} of ${total} answered)` : 'Start'}
            </button>
            {answered > 0 && <button type="button" className="dna-btn" onClick={() => setMode('profile')}>See your profile so far</button>}
          </div>
        </div>
      </div>
    )
  }

  // ── Profile ──
  if (mode === 'profile') {
    const p = buildProfile(dna, exceptions)
    const editTrait = (id: TraitId, v: string): void => {
      const traitEdits = { ...dna.traitEdits }
      if (v === 'auto') delete traitEdits[id]; else traitEdits[id] = v as TraitLevel
      save({ ...dna, traitEdits })
    }
    const rate = (artist: string, r: Rating): void => save({ ...dna, ratings: { ...dna.ratings, [artist]: r } })
    const answeredScreens = screens.filter((s) => isAnswered(dna, s) && s.kind !== 'rate')
    const answerText = (s: DnaScreen): string => {
      const a = dna.answers[s.id]
      if (a?.skipped) return 'Skipped'
      if (a?.unsure) return s.unsureLabel ?? 'Not sure'
      return (a?.picks ?? []).map((id) => { const o = s.options?.find((x) => x.id === id); return o ? (o.song ? `${o.label} — ${o.song.artist}` : o.label) : '' }).filter(Boolean).join(', ')
    }
    const artistGroups: Array<{ r: Rating; title: string; note?: string; list: string[] }> = [
      { r: 'love', title: 'Love', list: p.loves },
      { r: 'like', title: 'Like', list: p.likes },
      { r: 'respect', title: 'Respect', note: 'Talent you recognize — never counted as taste.', list: p.respects },
      { r: 'dislike', title: 'Dislike', note: 'Kept out of the Record Shop, unless they are on Rocksurgence.', list: p.dislikes },
      { r: 'unfamiliar', title: 'Unfamiliar', list: p.unfamiliar },
    ]
    const promptLine = dnaPromptLine(p)
    return (
      <div className="dna dna--scroll">
        <div className="dna-profile">
          <header className="dna-profile__head">
            <div>
              <div className="dna-eyebrow">Rocksurgence</div>
              <h1 className="dna-title">Rock DNA</h1>
              <p className="dna-meta">Built from {answered} of {total} answers{dna.updatedAt ? ` · updated ${new Date(dna.updatedAt).toLocaleDateString()}` : ''}. Every line says which answers it came from. Change any of it.</p>
            </div>
            <div className="dna-actions">
              {!p.finished && <button type="button" className="dna-btn dna-btn--primary" onClick={() => open(resumeScreen(dna))}>Keep going ({total - answered} left)</button>}
              <button type="button" className="dna-btn" onClick={() => setConfirmRetake(true)}>Retake</button>
            </div>
          </header>
          {error && <p className="dna-error">{error}</p>}

          <section className="dna-card">
            <h2 className="dna-h2">Where your rock comes from</h2>
            {p.traditions.length ? (
              <>
                <p className="dna-note">These threads sit side by side. JakeTunes never averages them into one.</p>
                <div className="dna-threads">
                  {p.traditions.map((t) => (
                    <div key={t.id} className="dna-thread">
                      <div className="dna-thread__name">{t.name}</div>
                      <div className="dna-thread__bar"><span style={{ width: `${Math.min(100, (t.score / p.traditions[0].score) * 100)}%` }} /></div>
                      <div className="dna-thread__from">{t.artists.join(', ')}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : <p className="dna-note">Not enough answers yet.</p>}
          </section>

          {p.dims.map((d) => {
            const shown = d.traits.filter((t) => t.level !== 'none')
            const quiet = d.traits.filter((t) => t.level === 'none')
            const labels = d.id === 'turnoffs' ? TURNOFF_LABEL : LEVEL_LABEL
            return (
              <section key={d.id} className="dna-card">
                <h2 className="dna-h2">{d.title}</h2>
                {d.summary && <p className="dna-summary">{d.summary}</p>}
                {shown.map((t) => (
                  <div key={t.id} className="dna-trait">
                    <div className="dna-trait__label">{t.label}</div>
                    <select className="dna-trait__level" value={t.edited ? t.level : 'auto'} onChange={(e) => editTrait(t.id, e.target.value)} aria-label={`${t.label}: level`}>
                      <option value="auto">{labels[t.level]}{t.edited ? '' : ' (from answers)'}</option>
                      {(['strong', 'some', 'mixed', 'low'] as TraitLevel[]).map((l) => <option key={l} value={l}>{labels[l]}</option>)}
                    </select>
                    <div className="dna-trait__from">{t.edited ? 'Your correction.' : `From: ${t.from.join(' · ')}`}</div>
                  </div>
                ))}
                {quiet.length > 0 && <p className="dna-note">Not enough answers yet: {quiet.map((t) => t.label.split(' — ')[0]).join(', ')}.</p>}
              </section>
            )
          })}

          <section className="dna-card">
            <h2 className="dna-h2">Artists</h2>
            {artistGroups.filter((g) => g.list.length).map((g) => (
              <div key={g.r} className="dna-artists">
                <div className="dna-artists__title">{g.title}{g.note && <span className="dna-artists__note">{g.note}</span>}</div>
                <div className="dna-chips">
                  {g.list.map((a) => (
                    <label key={a} className={`dna-chip dna-chip--${g.r}`}>
                      {a}
                      <select value={g.r} onChange={(e) => rate(a, e.target.value as Rating)} aria-label={`How you feel about ${a}`}>
                        {RATINGS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            {!Object.keys(dna.ratings).length && <p className="dna-note">Not enough answers yet.</p>}
          </section>

          {p.exceptions.length > 0 && (
            <section className="dna-card">
              <h2 className="dna-h2">Genre exceptions</h2>
              {p.exceptions.map((e) => (
                <p key={e.artist} className="dna-line"><strong>{e.artist}</strong> — loved despite {e.genre || 'the genre'}{e.why.length ? `. Why: ${e.why.join(', ').toLowerCase()}.` : '.'} It never opens the door to {e.genre || 'the genre'}.</p>
              ))}
            </section>
          )}

          {p.specifics.length > 0 && (
            <section className="dna-card">
              <h2 className="dna-h2">Specifics</h2>
              {p.specifics.map((s) => <p key={s.label} className="dna-line">{s.label}: <strong>{s.answer}</strong></p>)}
            </section>
          )}

          <section className="dna-card">
            <h2 className="dna-h2">Discovery philosophy</h2>
            {p.philosophy.map((l) => <p key={l} className="dna-line">{l}</p>)}
            {promptLine && (
              <details className="dna-details">
                <summary>What the Record Shop reads</summary>
                <p className="dna-mono">{promptLine}</p>
              </details>
            )}
          </section>

          {answeredScreens.length > 0 && (
            <section className="dna-card">
              <h2 className="dna-h2">Your answers</h2>
              {answeredScreens.map((s) => (
                <div key={s.id} className="dna-answer">
                  <div className="dna-answer__q">{s.text}</div>
                  <div className="dna-answer__a">{answerText(s)}</div>
                  <button type="button" className="dna-link" onClick={() => { setReturnToProfile(true); setCur(s.id); setMode('quiz') }}>Change</button>
                </div>
              ))}
            </section>
          )}
        </div>
        {confirmRetake && (
          <ConfirmDialog
            message="Retake Rock DNA?"
            detail="Your answers start over. This run is kept as your previous one until you finish the new run."
            confirmLabel="Retake"
            onCancel={() => setConfirmRetake(false)}
            onConfirm={() => { setConfirmRetake(false); const fresh = retake(dna, now()); save(fresh); setCur(null); setMode('intro') }}
          />
        )}
      </div>
    )
  }

  // ── A question ──
  const s = screenById(cur ?? '') ?? resumeScreen(dna) ?? screens[0]
  const section = SECTIONS.find((x) => x.id === s.section)!
  const a = dna.answers[s.id]
  const picks = a?.picks ?? []
  const idx = screens.findIndex((x) => x.id === s.id)

  const choose = (o: DnaOption): void => {
    if (s.kind === 'multi') {
      const next = picks.includes(o.id) ? picks.filter((x) => x !== o.id) : [...picks, o.id]
      save({ ...dna, answers: { ...dna.answers, [s.id]: { picks: next, at: now() } } })
    } else answer(s, { picks: [o.id] })
  }
  const back = (): void => {
    if (returnToProfile) { setMode('profile'); setReturnToProfile(false); return }
    const p = prevScreen(dna, s.id)
    if (p) { setCur(p.id); save({ ...dna, position: p.id }) } else setMode('intro')
  }
  const skip = (): void => answer(s, { skipped: true })

  return (
    <div className="dna dna--scroll">
      <div className="dna-q">
        <div className="dna-q__top">
          <div className="dna-eyebrow">Section {section.id} · {section.title}</div>
          <div className="dna-count">{idx + 1} / {screens.length}</div>
        </div>
        <div className="dna-segments" aria-hidden="true">
          {SECTIONS.map((sec) => {
            const own = screens.filter((x) => x.section === sec.id)
            const done = own.filter((x) => isAnswered(dna, x)).length
            return <span key={sec.id} className={sec.id === s.section ? 'dna-seg dna-seg--on' : 'dna-seg'}><i style={{ width: `${own.length ? (done / own.length) * 100 : 0}%` }} /></span>
          })}
        </div>
        {s.after && <div className="dna-followup">A follow-up, because of your last answer</div>}

        {s.about && (() => { const info = artistInfo(s.about); return (
          <div className="dna-hero">
            {info.hash ? <AlbumArtImage hash={info.hash} alt={s.about} className="dna-hero__art" size={160} /> : <div className="dna-hero__art dna-blank">{s.about.slice(0, 1)}</div>}
            <div><div className="dna-hero__name">{s.about}</div><div className="dna-hero__note">{info.note}</div></div>
          </div>
        ) })()}

        <h2 className="dna-question">{s.text}</h2>
        {s.kind === 'multi' && <p className="dna-hint">Pick as many as fit.</p>}

        {s.kind === 'rate' ? (
          <RateScreen artists={s.artists ?? []} ratings={dna.ratings} info={artistInfo}
            onRate={(artist, r) => save({ ...dna, ratings: { ...dna.ratings, [artist]: r } })} />
        ) : (
          <div className="dna-options">
            {(s.options ?? []).map((o) => {
              const art = o.artist ?? o.song?.artist
              const info = art ? artistInfo(art) : null
              const track = o.song ? ownedSong(o.song.artist, o.song.title) : undefined
              const on = picks.includes(o.id)
              return (
                <div key={o.id} role="button" tabIndex={0} aria-pressed={on}
                  className={`dna-opt${on ? ' dna-opt--on' : ''}${info ? '' : ' dna-opt--text'}`}
                  onClick={() => choose(o)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(o) } }}>
                  {info && (info.hash ? <AlbumArtImage hash={info.hash} alt={art!} className="dna-opt__art" size={120} /> : <span className="dna-opt__art dna-blank">{art!.slice(0, 1)}</span>)}
                  <span className="dna-opt__text">
                    <span className="dna-opt__label">{o.label}</span>
                    {o.sub && <span className="dna-opt__sub">{o.sub}</span>}
                    {o.song ? (
                      <span className="dna-opt__note">{track ? 'In your library' : 'Not in your library'}</span>
                    ) : info && !o.sub ? <span className="dna-opt__note">{info.note}</span> : null}
                  </span>
                  {track && (
                    <button type="button" className="dna-play" aria-label={`Play ${o.song!.title}`}
                      onKeyDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); playTrack(track, [track], 0) }}>
                      <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0l10 6-10 6z" fill="currentColor" /></svg>
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {s.unsureLabel && (
          <button type="button" className={`dna-unsure${a?.unsure ? ' dna-unsure--on' : ''}`} onClick={() => answer(s, { unsure: true })}>{s.unsureLabel}</button>
        )}
        {error && <p className="dna-error">{error}</p>}

        <div className="dna-foot">
          <div className="dna-actions">
            <button type="button" className="dna-btn dna-btn--quiet" onClick={back}>Back</button>
            <button type="button" className="dna-btn" onClick={skip}>Skip</button>
            {(s.kind === 'multi' || s.kind === 'rate') && (
              <button type="button" className="dna-btn dna-btn--primary" disabled={!isAnswered(dna, s)} onClick={() => advance(dna, s.id)}>Continue</button>
            )}
          </div>
          <button type="button" className="dna-link" onClick={() => { save({ ...dna, position: s.id }); setMode('profile'); setReturnToProfile(false) }}>
            Saved · see profile so far
          </button>
        </div>
      </div>
    </div>
  )
}

function RateScreen({ artists, ratings, info, onRate }: {
  artists: string[]
  ratings: Record<string, Rating>
  info: (name: string) => { hash?: string; note: string }
  onRate: (artist: string, r: Rating) => void
}): JSX.Element {
  return (
    <div className="dna-rate">
      <p className="dna-hint">{RATINGS.map((r) => `${r.label}: ${r.meaning.toLowerCase()}`).join(' · ')}</p>
      {artists.map((artist) => {
        const i = info(artist)
        return (
          <div key={artist} className="dna-rate__row">
            {i.hash ? <AlbumArtImage hash={i.hash} alt={artist} className="dna-rate__art" size={80} /> : <span className="dna-rate__art dna-blank">{artist.slice(0, 1)}</span>}
            <div className="dna-rate__name"><div>{artist}</div><div className="dna-opt__note">{i.note}</div></div>
            <div className="dna-seg-btns" role="radiogroup" aria-label={`How you feel about ${artist}`}>
              {RATINGS.map((r) => (
                <button key={r.id} type="button" role="radio" aria-checked={ratings[artist] === r.id} title={r.meaning}
                  className={`dna-rbtn dna-rbtn--${r.id}${ratings[artist] === r.id ? ' dna-rbtn--on' : ''}`}
                  onClick={() => onRate(artist, r.id)}>{r.label}</button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

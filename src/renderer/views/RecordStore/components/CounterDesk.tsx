// The Counter — Step Inside's presentation of the shared Record Shop
// session. Same items, edition details, ownership states, results and
// verbs as the regular shop; only the room around them is different.
// Nothing here decides what an item may do: `shopActions` does, from the
// model's facts, and the verbs go to the one command bus.
//
// Keyboard: ↑/↓ or j/k move the pointer, Enter takes the first offered
// verb, Escape steps back to the shop. Every button is focusable.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShopItem, ShopSession, Snapshot } from '../../../../common/record-shop'
import { shopActions, ownershipLabel, editionLabel, jobLabel, refusedSelection, type ShopCommands, type ShopVerb } from '../../../../common/record-shop-commands'

const VERB_LABEL: Record<ShopVerb, string> = {
  saveItem: 'Save', inspectSelection: 'Inspect', previewItem: 'Preview', playOwned: 'Play', getSelection: 'Get', cancelJob: 'Cancel', retryJob: 'Retry', chooseEdition: 'Choose edition',
}
/** Verb wording that follows the item: a refused song offers a version, a refused record an edition. */
const verbLabel = (v: ShopVerb, item: Snapshot<ShopItem>, refused: boolean): string =>
  v === 'chooseEdition' ? (item.kind === 'recording' ? 'Choose version' : 'Choose edition')
  : v === 'inspectSelection' && refused ? 'Details' : VERB_LABEL[v]
const BLOCKED_LABEL = {
  'browse-only': 'Browse only — an artist or a concert is not a download',
  'select-edition': 'Pick the edition first',
  'select-recording': 'Pick the recording first',
  'owned': 'Already in your library',
  'in-flight': 'Getting it now',
  'refused': 'The sources refused this choice — pick another edition rather than repeating it',
  'retry': 'Retry resumes this import with the same selection',
} as const

const kindWord = (item: Snapshot<ShopItem>): string =>
  item.kind === 'release' ? 'Record' : item.kind === 'recording' ? 'Song' : item.kind === 'artist' ? 'Artist' : item.kind === 'concert' ? 'Concert' : 'Note'

export function CounterDesk({ session, commands, onBack, fixtureMode, loading = false }: {
  session: ShopSession
  commands: ShopCommands
  onBack: () => void
  fixtureMode: boolean
  loading?: boolean
}) {
  const items = session.items
  const [idx, setIdx] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])
  const savedIds = useMemo(() => new Set(session.entries.map((e) => e.item.itemId)), [session.entries])

  const go = useCallback((d: number) => setIdx((i) => Math.max(0, Math.min(items.length - 1, i + d))), [items.length])
  useEffect(() => { rowRefs.current[idx]?.scrollIntoView({ block: 'nearest' }) }, [idx])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(1) }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(-1) }
      else if (e.key === 'Escape') { e.preventDefault(); if (openId) setOpenId(null); else onBack() }
      else if (e.key === 'Enter') {
        const item = items[idx]; if (!item) return
        const a = shopActions(item, session.ownership[item.itemId], session.jobs[item.itemId], savedIds.has(item.itemId))
        const first = a.verbs.find((v) => v !== 'saveItem') ?? a.verbs[0]
        if (first) { e.preventDefault(); run(first, item) }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, items, openId, go, onBack, savedIds])

  const run = (verb: ShopVerb, item: Snapshot<ShopItem>): void => {
    const job = session.jobs[item.itemId]
    if (verb === 'cancelJob' || verb === 'retryJob') { if (job) commands[verb](job.jobId); return }
    if (verb === 'inspectSelection') setOpenId((o) => (o === item.itemId ? null : item.itemId))
    commands[verb](item.itemId)
  }

  return (
    <div className="counter" role="region" aria-label="The counter">
      <div className="counter__head">
        <button type="button" className="crate__back" onClick={onBack}>← back to the shop</button>
        <div className="crate__heading">
          <h2 className="crate__title">At the Counter</h2>
          <p className="crate__tagline">Everything you've saved, what's on order, and what's already on your shelf.</p>
        </div>
        {fixtureMode && <span className="counter__pill" title="Showing the fixture set — live data is wired after visual review">Prototype · fixtures</span>}
      </div>

      {items.length === 0 && (
        <p className="counter__empty">{loading ? 'Reading your list…' : 'Nothing at the counter yet. Jot a song or a record in the Listen List and it turns up here.'}</p>
      )}
      <ol className="counter__list">
        {items.map((item, i) => {
          const own = session.ownership[item.itemId]
          const job = session.jobs[item.itemId]
          const recs = session.recommendations.filter((r) => r.itemId === item.itemId)
          const a = shopActions(item, own, job, savedIds.has(item.itemId))
          const refused = refusedSelection(job)
          const active = i === idx
          const open = openId === item.itemId
          const result = job?.result
          const who = recs.map((r) => r.source.kind === 'person' ? r.source.name : r.source.kind === 'ai' ? 'the shop' : r.source.name).filter(Boolean)
          return (
            <li key={item.itemId} className={`counter__row${active ? ' is-active' : ''}${own?.status === 'complete' ? ' is-owned' : ''}`}>
              <div ref={(el) => { rowRefs.current[i] = el }} className="counter__card" onClick={() => setIdx(i)}>
                <div className="counter__art">
                  {item.display.artworkUrl && !item.display.artworkUrl.startsWith('fixture://')
                    ? <img src={item.display.artworkUrl} alt="" />
                    : <span className="counter__art-blank" aria-hidden="true">{item.display.title.slice(0, 2)}</span>}
                </div>
                <div className="counter__body">
                  <div className="counter__name-row">
                    <span className="counter__kind">{kindWord(item)}</span>
                    <span className="counter__name">{item.display.title}</span>
                    {item.display.artist && item.kind !== 'artist' && <span className="counter__artist">{item.display.artist}</span>}
                  </div>
                  <div className="counter__facts">
                    {editionLabel(item) && <span className="counter__edition">{editionLabel(item)}</span>}
                    <span className={`counter__own counter__own--${own?.status ?? 'unknown'}`}>{ownershipLabel(own)}</span>
                    {job && <span className={`counter__job counter__job--${job.status}`}>{jobLabel(job)}{job.attempt > 1 ? ` · attempt ${job.attempt}` : ''}</span>}
                  </div>
                  {(who.length > 0 || recs[0]?.reason) && (
                    <p className="counter__why">
                      {who.length > 0 && <span className="counter__from">{who.length > 1 ? `from ${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}` : `from ${who[0]}`}</span>}
                      {recs[0]?.reason && <span> · {recs[0].reason}</span>}
                    </p>
                  )}
                  {job?.status === 'failed' && result?.detail && (
                    <details className="counter__detail" open={open || undefined}>
                      <summary>{result.primary || 'Failed'}</summary>
                      <p>{result.detail}</p>
                      {result.alternatives && result.alternatives.length > 0 && (
                        <ul className="counter__alts">
                          {result.alternatives.map((alt, k) => <li key={k}><b>{alt.provider}</b> {alt.desc} <span>{alt.reason}</span></li>)}
                        </ul>
                      )}
                    </details>
                  )}
                  {open && item.selection && (
                    <div className="counter__inspect" role="region" aria-label="Selected edition">
                      {item.selection.kind === 'release' ? (
                        <>
                          <p className="counter__inspect-head">{item.selection.request.title} <span>{item.selection.request.artist}</span></p>
                          <ol className="counter__tracks">
                            {item.selection.request.tracks.map((t, k) => {
                              const owned = own && own.status !== 'unknown' && own.matches.some((m) => m.position === k)
                              const mm = t.durationSec ? `${Math.floor(t.durationSec / 60)}:${String(Math.round(t.durationSec % 60)).padStart(2, '0')}` : ''
                              return (
                                <li key={k} className={owned ? 'is-owned' : ''}>
                                  <span className="counter__track-no">{k + 1}</span>
                                  <span className="counter__track-title">{t.title}</span>
                                  <span className="counter__track-own">{owned ? 'in library' : ''}</span>
                                  <span className="counter__track-time">{mm}</span>
                                </li>
                              )
                            })}
                          </ol>
                          <p className="counter__inspect-meta">
                            {ownershipLabel(own)}
                            {item.selection.request.providerIds.itunesCollectionId ? ` · iTunes collection ${item.selection.request.providerIds.itunesCollectionId}` : ''}
                            {` · ${item.selection.request.tracks.length} tracks`}
                          </p>
                        </>
                      ) : (
                        <p className="counter__inspect-head">{item.selection.request.title} — {item.selection.request.artist} · {item.selection.request.album}{item.selection.request.requestedMarkers.length ? ` · ${item.selection.request.requestedMarkers.join(', ')}` : ''}</p>
                      )}
                    </div>
                  )}
                </div>
                <div className="counter__actions" onClick={(e) => e.stopPropagation()}>
                  {a.verbs.map((v) => (
                    <button key={v} type="button" className={`counter__btn counter__btn--${v}`} onClick={() => run(v, item)}>{verbLabel(v, item, refused)}</button>
                  ))}
                  {a.getBlocked && <span className="counter__blocked" title={BLOCKED_LABEL[a.getBlocked]}>{a.getBlocked === 'owned' ? 'On your shelf' : a.getBlocked === 'in-flight' || a.getBlocked === 'retry' ? '' : a.getBlocked === 'browse-only' ? 'Browse' : a.getBlocked === 'refused' ? 'Refused' : 'Pick edition'}</span>}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <p className="counter__hint">↑ ↓ move · Enter acts · Esc back</p>
    </div>
  )
}

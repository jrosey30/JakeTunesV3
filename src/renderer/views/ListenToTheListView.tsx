/**
 * Listen to the List v2 — the capture-anything inbox (2026-07-14 rebuild).
 *
 * Ground-up rethink on the PROVEN sync layer (Briefs 126/127 identity
 * deletes stay). What changed is the experience:
 *
 *  - ONE omnibox. Type a sloppy guess OR paste a link (Spotify / YouTube /
 *    TikTok / anything) — links resolve to a song guess via main's
 *    capture-resolve-link, then iTunes Search verifies. No more spelling
 *    anxiety: you SEE the real song with artwork and click it. One click
 *    on a candidate ADDS it (no fill-then-submit two-step).
 *  - Friend attribution: tag who sent it ("From"), building a local
 *    Scouts ledger — adds / gots / tosses per friend — so the strip up
 *    top shows who actually has the ear.
 *  - Raw jots still save un-resolved on Enter (grounded: never force a
 *    match), exactly like the old flow.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import EmptyState from '../components/EmptyState'
import ConfirmDialog from '../components/ConfirmDialog'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { useLibrary } from '../context/LibraryContext'
import { getPreviewSnapshot, stopPreview } from '../previewPlayer'
import type { Recommendation, ItunesSuggestion } from '../types'
import { RecoRow } from '../listen-to-the-list/components'
import { useItunesAutocomplete } from '../listen-to-the-list/useItunesAutocomplete'
import { useListenToTheList } from '../listen-to-the-list/useListenToTheList'
import type { AddFormState } from '../listen-to-the-list/useListenToTheList'
import {
  canDownloadReco,
  getLtlDownloadSnapshot,
  prefillDownloadView,
  queueAllRecoDownloads,
  subscribeLtlDownload,
} from '../listen-to-the-list/ltlDownload'
import '../styles/listen-to-the-list.css'

interface Friend { name: string; adds: number; got: number; tossed: number; lastAt: number }

/** Who sent this rec, parsed back out of the synced note ("… · from Ben · …"). */
function friendOf(rec: Recommendation): string | null {
  const m = String(rec.note || '').match(/(?:^|· )from ([^·]+?)(?: ·|$)/)
  return m ? m[1].trim() : null
}

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim())

export default function ListenToTheListView() {
  const { dispatch } = useLibrary()
  const {
    recs, loading, adding,
    addFromForm, deleteRecommendation, EMPTY_FORM,
  } = useListenToTheList()

  const [form, setForm] = useState<AddFormState>(EMPTY_FORM)
  const [omni, setOmni] = useState('')
  const [from, setFrom] = useState('')
  const [linkInfo, setLinkInfo] = useState<{ kind: string; link: string } | null>(null)
  const [resolving, setResolving] = useState(false)
  const [friends, setFriends] = useState<Friend[]>([])
  const [contacts, setContacts] = useState<string[]>([])
  const [deleteTarget, setDeleteTarget] = useState<Recommendation | null>(null)
  const omniRef = useRef<HTMLInputElement>(null)

  // The omnibox drives the iTunes verifier directly (song = raw text).
  const { suggestions, searching, pick, clearSuggestions } = useItunesAutocomplete(form.song, form.artist)

  const viewRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('listen-to-the-list', viewRef)

  useEffect(() => {
    void window.electronAPI.getFriends?.().then((r) => { if (r?.ok) setFriends(r.friends) })
  }, [recs.length])

  // macOS Contacts names feed the From typeahead (one TCC prompt, then cached
  // in main). Free-typing still works — contacts are suggestions, not a gate.
  useEffect(() => {
    void window.electronAPI.getContacts?.().then((r) => { if (r?.ok) setContacts(r.names) })
  }, [])

  // iMessage capture needs Full Disk Access ONCE — show the setup hint only
  // while it's missing, re-check each minute, disappear forever after.
  const [imsgDenied, setImsgDenied] = useState(false)
  useEffect(() => {
    let alive = true
    const check = () => {
      void window.electronAPI.imessageCaptureStatus?.().then((r) => {
        if (alive && r?.ok) setImsgDenied(r.access === 'denied')
      })
    }
    check()
    const t = setInterval(check, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // Omnibox → form. A pasted URL resolves through main (oEmbed/OG) into a
  // song/artist guess; plain text just becomes the search seed.
  const handleOmni = async (raw: string) => {
    setOmni(raw)
    if (isUrl(raw)) {
      setResolving(true)
      try {
        const r = await window.electronAPI.captureResolveLink?.(raw.trim())
        if (r?.ok) {
          setLinkInfo({ kind: r.kind || 'link', link: raw.trim() })
          const seed = r.title || r.raw || ''
          setForm((f) => ({ ...f, song: seed, artist: r.artist || '', link: raw.trim() }))
          setOmni(seed ? `${seed}${r.artist ? ` — ${r.artist}` : ''}` : raw)
        }
      } finally { setResolving(false) }
    } else {
      setForm((f) => ({ ...f, song: raw, artist: '', link: linkInfo?.link || '' }))
    }
  }

  const resetCapture = () => {
    setOmni(''); setForm(EMPTY_FORM); setLinkInfo(null); clearSuggestions()
    omniRef.current?.focus()
  }

  // One click on a verified candidate = ON THE LIST. The no-typing promise.
  const quickAdd = async (s: ItunesSuggestion) => {
    if (adding) return
    const picked = pick(s)
    const draft: AddFormState = { ...form, ...picked, from: from.trim(), link: linkInfo?.link || form.link }
    resetCapture()
    const res = await addFromForm(draft)
    if (!res.ok) { setForm(draft); setOmni(draft.song) }
  }

  // Enter with no candidate picked = raw jot, saved as typed (never forced).
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!omni.trim() || adding) return
    const draft: AddFormState = { ...form, song: form.song || omni.trim(), from: from.trim(), link: linkInfo?.link || '' }
    resetCapture()
    const res = await addFromForm(draft)
    if (!res.ok) { setForm(draft); setOmni(draft.song) }
  }

  const handleDelete = (rec: Recommendation) => {
    if (getPreviewSnapshot().playingId === rec.id) stopPreview()
    const f = friendOf(rec)
    if (f) void window.electronAPI.friendEvent?.(f, 'tossed')
    void deleteRecommendation(rec)
  }

  const openDownloadForReco = (rec: Recommendation) => {
    const f = friendOf(rec)
    if (f) void window.electronAPI.friendEvent?.(f, 'got')
    prefillDownloadView(rec)
    dispatch({ type: 'SET_VIEW', view: 'download' })
  }

  const jots = recs.filter((r) => (r.source ?? 'user') === 'user')
  const suggested = recs.filter((r) => r.source === 'mm' || r.source === 'radar')
  const downloadable = recs.filter(canDownloadReco)
  const dlMap = useSyncExternalStore(subscribeLtlDownload, getLtlDownloadSnapshot)
  const dlActive = [...dlMap.values()].some((s) => s.state === 'queued' || s.state === 'downloading')

  const scouts = friends.filter((f) => f.adds > 0).slice(0, 8)

  return (
    <div className="ltl-view" ref={viewRef}>
      <div className="ltl-header">
        <h1 className="ltl-title">Listen to the List</h1>
        <span className="ltl-count">{recs.length} {recs.length === 1 ? 'reco' : 'recos'}</span>
        {downloadable.length > 0 && (
          <button
            type="button"
            className="ltl-download-all"
            onClick={() => queueAllRecoDownloads(downloadable)}
            disabled={dlActive}
            title="Download all via Qobuz (one at a time)"
          >
            {dlActive ? 'Downloading…' : `Download all (${downloadable.length})`}
          </button>
        )}
      </div>

      {imsgDenied && (
        <div className="ltl-imsg-setup">
          Songs texted to you can land here automatically — JakeTunes just needs
          Full Disk Access to see Messages.{' '}
          <button
            type="button"
            className="ltl-imsg-setup-btn"
            onClick={() => { void window.electronAPI.openExternalUrl?.('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles') }}
          >
            Open System Settings
          </button>
          <span className="ltl-imsg-setup-sub"> — flip on JakeTunes under Full Disk Access. No relaunch needed.</span>
        </div>
      )}

      {/* ── Capture: one box for everything ── */}
      <div className="ltl-add-wrap">
        <form className="ltl-capture" onSubmit={handleSubmit}>
          <input
            ref={omniRef}
            className="ltl-omni"
            placeholder="Drop a song, a Spotify/YouTube/TikTok link, or a hunch…"
            value={omni}
            onChange={(e) => void handleOmni(e.target.value)}
            spellCheck={false}
          />
          <input
            className="ltl-from"
            placeholder="From…"
            title="Who sent you this? Builds your Friends ranking."
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            list="ltl-friends-list"
            spellCheck={false}
          />
          <datalist id="ltl-friends-list">
            {[...new Set([...friends.map((f) => f.name), ...contacts])].map((n) => <option key={n} value={n} />)}
          </datalist>
          <button className="ltl-add-btn" type="submit" disabled={!omni.trim() || adding}>
            {adding ? 'Adding…' : 'Jot it'}
          </button>
        </form>
        {linkInfo && (
          <div className="ltl-linkinfo">
            via {linkInfo.kind}{resolving ? ' — reading…' : ' — pick the match below (or edit the text)'}
            <button type="button" className="ltl-linkinfo-x" onClick={resetCapture} aria-label="Clear">✕</button>
          </div>
        )}
        {(suggestions.length > 0 || searching) && omni.trim() && (
          <div className="ltl-suggestions">
            {searching && suggestions.length === 0 && (
              <div className="ltl-suggest-empty">Checking…</div>
            )}
            {suggestions.map((s, i) => (
              <button
                type="button"
                key={`${s.song}-${s.artist}-${i}`}
                className="ltl-suggest-row"
                title="Click to add to your list"
                onClick={() => void quickAdd(s)}
              >
                {s.artworkUrl
                  ? <img className="ltl-suggest-art" src={s.artworkUrl} alt="" loading="lazy" />
                  : <span className="ltl-suggest-art ltl-suggest-art--ph" aria-hidden="true">♪</span>}
                <span className="ltl-suggest-text">
                  <span className="ltl-suggest-song">{s.song}</span>
                  <span className="ltl-suggest-artist">{s.artist}</span>
                  {s.album && <span className="ltl-suggest-album">{s.album}</span>}
                </span>
                <span className="ltl-suggest-add" aria-hidden="true">+ Add</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Scouts: who actually has the ear ── */}
      {scouts.length > 0 && (
        <div className="ltl-scouts">
          <span className="ltl-scouts-label">Friends</span>
          {scouts.map((f) => {
            const verdicts = f.got + f.tossed
            const rate = verdicts > 0 ? Math.round((f.got / verdicts) * 100) : null
            return (
              <button
                type="button"
                key={f.name}
                className="ltl-scout"
                title={`${f.adds} sent · ${f.got} got · ${f.tossed} tossed`}
                onClick={() => setFrom(f.name)}
              >
                {f.name}
                <span className="ltl-scout-stat">{rate != null ? `${rate}%` : `${f.adds}`}</span>
              </button>
            )
          })}
        </div>
      )}

      {loading ? (
        <div className="ltl-loading">Loading…</div>
      ) : recs.length === 0 ? (
        <EmptyState noun="recommendations" subMessage="Drop a song, a link, or a hunch above — friends' picks get tracked too." />
      ) : (
        <div className="ltl-list">
          {jots.length > 0 && (
            <div className="ltl-section">
              <div className="ltl-section-head">
                Your jots<span className="ltl-section-count">{jots.length}</span>
              </div>
              {jots.map((rec) => (
                <RecoRow key={rec.id} rec={rec} onDelete={() => setDeleteTarget(rec)} onOpenDownload={openDownloadForReco} />
              ))}
            </div>
          )}
          {suggested.length > 0 && (
            <div className="ltl-section">
              <div className="ltl-section-head">
                Suggested for you<span className="ltl-section-count">{suggested.length}</span>
              </div>
              {suggested.map((rec) => (
                <RecoRow key={rec.id} rec={rec} onDelete={() => setDeleteTarget(rec)} onOpenDownload={openDownloadForReco} />
              ))}
            </div>
          )}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          message="Remove this from your list?"
          detail="This deletes the recommendation everywhere (mobile too). This cannot be undone."
          confirmLabel="Remove"
          onConfirm={() => { handleDelete(deleteTarget); setDeleteTarget(null) }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}

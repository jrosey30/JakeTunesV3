import React, { useLayoutEffect, useCallback, useMemo, useState, useEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react'
import { sentencePreview } from '../../common/sentences'
import { isWeakBlurb } from '../../common/weak-blurb'
import { arrangePersonnel, personnelPreview } from '../../common/personnel-roles'
import { nameKey } from '../../common/fold-text'
import type { AlbumPerson } from '../types'
import { useDelayedFlag } from '../hooks/useDelayedFlag'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { albumKeyOf } from '../utils/albumKey'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import { compareAlbumNames } from '../utils/artistSort'
import { albumCreditReleaseDate, formatReleaseDateDisplay } from '../utils/albumReleaseDate'
import { albumDetailBackLabel } from '../utils/albumBackLabel'
import { useBackLabel } from '../hooks/useBackLabel'
import BackButton from '../components/chrome/BackButton'
import { useNavigation } from '../context/NavigationContext'
import { lookupArtwork, buildNormalizedArtworkIndex } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumArtImage from '../components/AlbumArtImage'
import ContextMenu from '../components/ContextMenu'
import SongTable, { type SongTableLead } from '../components/SongTable'
import { useListSort } from '../hooks/useListSort'
import { sortSongs } from '../utils/songTableRules'
import { shuffle } from '../../common/shuffle'
import { formatDuration } from '../../common/format-duration'
import ConfirmDialog from '../components/ConfirmDialog'
import RemoveConcertDialog, { REMOVE_CONCERT_LABEL } from '../components/RemoveConcertDialog'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import { setNotice } from '../activity'
import { usePlaysElsewhere } from '../playsElsewhere'
// V5 Live Concert Mode — declared-set store + declare orchestration.
import { subscribeLiveSets, getLiveSetsSnapshot, ensureLiveSetsLoaded, liveSetFor, unregisterLiveSet, cueAt, promoteTrackToLibrary, cleanLiveTitle } from '../liveSets'
import { attachConcert, detachConcert, subscribeConcertCrowd, isConcertCrowdEnabled, setConcertCrowdEnabled } from '../concertCrowd'
import { declareLiveSet, isDeclareInFlight } from '../liveSetDeclare'
import { verifyLiveSetCompleteness } from '../utils/liveSetCompleteness'
import type { Track, LiveSetCue } from '../types'
import '../styles/songs.css'
import '../styles/album-page.css'
import { planConcertStart } from '../../common/concert-start'
import { jewelCasePhotoVars } from '../../common/jewel-case-photo'

/** The jewel case's proportions (fractions of the cover) for album-page.css. */
const SLEEVE_VARS = jewelCasePhotoVars('--apd-f-') as CSSProperties


/** Music Man sometimes returns a meta "I don't know this album" riff — hide it. */
function formatTotalDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  const hrs = Math.floor(totalSecs / 3600)
  const mins = Math.round((totalSecs % 3600) / 60)
  if (hrs > 0) return `${hrs} hr ${mins} min`
  return `${mins} min`
}

/** Clock offset for the setlist AT column — 4:24, 1:05:03. Matches
 *  ConcertDetailView's hms so the two sheets read identically. */
function startClock(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/** Status-line clock for the whole record — 35:05, 1:12:40. */
function totalClock(ms: number): string {
  return startClock(Math.max(0, ms))
}


const ICON_PLAY = (
  <svg width="10" height="11" viewBox="0 0 10 11" aria-hidden="true"><path d="M1.5 1.2v8.6L9 5.5z" fill="currentColor" /></svg>
)
const ICON_SHUFFLE = (
  <svg width="14" height="11" viewBox="0 0 14 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 2.5h2.5c2.5 0 3.5 6 6 6H13M1 8.5h2.5c1.1 0 1.9-1.1 2.6-2.4M8.2 4.3c.5-1 1.1-1.8 2-1.8H13M11 .8l2 1.7-2 1.7M11 6.8l2 1.7-2 1.7" /></svg>
)
const ICON_MIC = (
  <svg width="11" height="13" viewBox="0 0 11 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><rect x="3.3" y="1" width="4.4" height="7" rx="2.2" /><path d="M1.3 6.2a4.2 4.2 0 008.4 0M5.5 10.4V12" /></svg>
)
const ICON_LEFT = (
  <svg width="7" height="10" viewBox="0 0 7 10" aria-hidden="true"><path d="M5 1L1.5 5 5 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const ICON_RIGHT = (
  <svg width="7" height="10" viewBox="0 0 7 10" aria-hidden="true"><path d="M2 1l3.5 4L2 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const ICON_NOTE_BIG = (
  <svg width="84" height="91" viewBox="0 0 12 13" aria-hidden="true"><path d="M4.5 1.5l6-1.2v8.2a2 2 0 11-1.3-1.9V3L5.8 3.7v6.8a2 2 0 11-1.3-1.9z" fill="currentColor" /></svg>
)

/** What the tray card's spine can say through the case's hinge, longest
 *  first: "ARTIST · ALBUM", then the album alone. The page measures the
 *  rendered text against the run between the hinge pins and falls back —
 *  nothing rather than a clipped word (house rule: names never clip). */
function spineCandidates(artist: string, album: string): string[] {
  const both = [artist, album].filter(Boolean).join(' · ')
  return [...new Set([both, album].filter(Boolean))]
}
/** Personnel lines shown before "All N": the band and the producer, not every guest. */
const PEOPLE_SHOWN = 6
/** The head's narrow branch (album-page.css `@container apd-head`): the 240px
 *  case, four people, a shorter history preview — so the songs stay in view
 *  in a 600px-tall window. */
const NARROW_HEAD_PX = 900
/** The people worth a line. MusicBrainz credits some members as a bare
 *  "performer" (In Rainbows: all five), which says nothing — the name alone
 *  reads fine; and it credits a band as itself, which is not a person. */
function presentablePeople(people: AlbumPerson[], albumArtist: string): AlbumPerson[] {
  const self = nameKey(albumArtist)
  const out: AlbumPerson[] = []
  for (const p of people) {
    const roles = p.roles.filter((r) => r !== 'performer')
    if (!roles.length && nameKey(p.name) === self) continue
    out.push(roles.length === p.roles.length ? p : { ...p, roles, credits: (p.credits ?? []).filter((c) => c.role !== 'performer') })
  }
  return out
}

export default function AlbumDetailView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const elsewhere = usePlaysElsewhere()

  const albumKeyRef = useRef<string>('')
  if (lib.pendingAlbumKey) albumKeyRef.current = lib.pendingAlbumKey
  const albumKey = albumKeyRef.current || lib.pendingAlbumKey || ''
  // Page memory, per album — reopening the same record lands where you left.
  // Direction D: the whole page scrolls as one sheet (header, setlist, table);
  // the table header sticks under it.
  const tracklistRef = useRef<HTMLDivElement>(null)
  useScrollPersistence(`album-detail:${albumKey}`, tracklistRef)

  const { canGoBack, goBack: navBack } = useNavigation()
  const navBackLabel = useBackLabel()
  const returnView = lib.albumDetailReturnView || 'albums'
  // The label names where the click lands: history when there is history
  // (useBackLabel — the one naming every back pill shares), else the stored
  // return view — the same two branches as goBack below.
  const backLabel = (canGoBack && navBackLabel) || albumDetailBackLabel(lib.albumDetailReturnView)
  // On its way out (the Island Albums disc handoff holds this page on screen
  // for the frame its View Transition captures — discHandoff.ts) the history
  // has already moved: show the label you clicked, or "← Home" flips to the
  // page before Home inside the shrinking snapshot. While the page is up
  // (currentView is the album page) it IS backLabel.
  const shownBackLabelRef = useRef(backLabel)
  if (lib.currentView === 'album-detail') shownBackLabelRef.current = backLabel
  const shownBackLabel = shownBackLabelRef.current
  // Prefer the real history (so this matches the titlebar ‹ and ⌘[); fall back
  // to the stored return view only when there's nothing to go back to.
  const goBack = useCallback(() => {
    if (canGoBack) navBack()
    else libDispatch({ type: 'SET_VIEW', view: returnView })
  }, [canGoBack, navBack, libDispatch, returnView])

  // The album's tracks, ordered by disc then track number — same ordering
  // AlbumsView uses so the tracklist reads top-to-bottom like the record.
  const tracks = useMemo(() => {
    const ts = lib.tracks.filter((t) => albumKeyOf(t) === albumKey)
    return sortAlbumTracks(ts)
  }, [lib.tracks, albumKey])

  // Album-level facts derived from the track set (most-common / first non-empty).
  const albumName = tracks[0]?.album || 'Unknown Album'
  const albumArtist = tracks[0]?.albumArtist || tracks[0]?.artist || 'Unknown Artist'
  const year = tracks.find((t) => t.year)?.year || ''
  const genre = tracks.find((t) => t.genre)?.genre || ''
  const totalMs = tracks.reduce((s, t) => s + (Number(t.duration) || 0), 0)

  // nav #4 — flip through this artist's other albums without backing out.
  // Owned albums by the same artist, newest-first (matches the artist page).
  const siblingAlbums = useMemo(() => {
    const norm = (s: string) => (s || '').trim().toLowerCase()
    const target = norm(albumArtist)
    const byKey = new Map<string, { key: string; name: string; year: string }>()
    for (const t of lib.tracks) {
      if (norm(t.albumArtist || t.artist) !== target) continue
      const k = albumKeyOf(t)
      if (!byKey.has(k)) byKey.set(k, { key: k, name: t.album || 'Unknown', year: String(t.year || '') })
    }
    return [...byKey.values()].sort((a, b) => (b.year || '').localeCompare(a.year || '') || compareAlbumNames(a.name, b.name))
  }, [lib.tracks, albumArtist])
  const curIdx = useMemo(() => siblingAlbums.findIndex(a => a.key === albumKey), [siblingAlbums, albumKey])
  const prevAlbum = curIdx > 0 ? siblingAlbums[curIdx - 1] : null
  const nextAlbum = curIdx >= 0 && curIdx < siblingAlbums.length - 1 ? siblingAlbums[curIdx + 1] : null

  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const artHash = lookupArtwork(lib.artworkMap, artIndex, albumArtist, albumName)

  useEffect(() => {
    if (artHash) prefetchAlbumArtHashes([artHash])
  }, [artHash])

  // Right-click a setlist song → reimport that one track into the regular
  // library (promote). The concert stays intact; only that song re-appears.
  const [cueCtx, setCueCtx] = useState<{ x: number; y: number; cue: LiveSetCue } | null>(null)

  // ── V5 Live Concert Mode ──
  // Declared-set state for THIS album; merge progress; undeclare confirm.
  useEffect(() => { void ensureLiveSetsLoaded() }, [])
  useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  const liveSet = liveSetFor(albumKey, lib.tracks)
  const mergedTrack = liveSet ? (lib.tracks.find(t => t.id === liveSet.mergedTrackId) ?? null) : null
  // Don't offer declaring ON a merged set's own album page (it'd merge
  // the merge) — UI-visibility check only, never a destructive gate.
  const isLiveSetAlbumPage = albumName.endsWith(' (Live Set)')
  // Jake's rule: Live Mode IF AND ONLY IF the album is complete. This
  // pre-check drives the disabled state + reason line; declareLiveSet
  // re-verifies as the hard gate.
  const completeness = useMemo(() => verifyLiveSetCompleteness(tracks), [tracks])
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeLabel, setMergeLabel] = useState('')
  const [undeclareConfirm, setUndeclareConfirm] = useState(false)
  // When the files can't prove the total (verifiedTotal=false), declaring
  // routes through this explicit confirm — Jake is the canonical source.
  const [completenessConfirm, setCompletenessConfirm] = useState(false)
  useEffect(() => {
    if (!mergeBusy) return
    return window.electronAPI.onLiveSetProgress((p) => setMergeLabel(p.label))
  }, [mergeBusy])
  const runDeclare = useCallback(async (confirmedComplete: boolean) => {
    if (mergeBusy || isDeclareInFlight()) return
    setMergeBusy(true)
    setMergeLabel('Preparing…')
    try {
      await declareLiveSet({ albumKey, name: albumName, artist: albumArtist, genre, year, tracks }, { confirmedComplete })
      setNotice(`Live album ready — ${albumName}`)
    } catch (err) {
      setNotice(`Live album failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setMergeBusy(false)
      setMergeLabel('')
    }
  }, [mergeBusy, albumKey, albumName, albumArtist, genre, year, tracks])
  const handleDeclare = useCallback(() => {
    if (!completeness.complete) return
    if (completeness.verifiedTotal) void runDeclare(false)
    else setCompletenessConfirm(true)
  }, [completeness, runDeclare])
  const handleUndeclare = useCallback(async () => {
    if (!liveSet) return
    // Identity-gated: only the exact merged track id recorded at declare
    // time is ever deleted. save-library's existing unlink path (with its
    // UNLINK_CAP guard) removes the audio file; originals are untouched
    // by construction.
    libDispatch({ type: 'DELETE_TRACKS', ids: [liveSet.mergedTrackId] })
    await unregisterLiveSet(albumKey)
    setUndeclareConfirm(false)
    setNotice('Live album removed. The songs are unchanged.')
  }, [liveSet, albumKey, libDispatch])
  const setPlaying = !!(mergedTrack && pb.nowPlaying?.id === mergedTrack.id)
  const activeCue = liveSet && setPlaying ? cueAt(liveSet, pb.position * 1000) : null

  // LC-7 crowd ambience: load "that night's crowd" for this concert while the
  // page is open; the engine only swells it when the set is playing + toggled on.
  const crowdOn = useSyncExternalStore(subscribeConcertCrowd, isConcertCrowdEnabled)
  const crowdMergedId = mergedTrack?.id
  const crowdCues = liveSet?.cues
  const crowdTotalMs = liveSet?.totalDurationMs
  useEffect(() => {
    if (crowdMergedId == null || !crowdCues || !crowdTotalMs) return
    void attachConcert(crowdMergedId, crowdCues.map((c) => c.startMs / 1000), crowdTotalMs / 1000)
    return () => { detachConcert() }
  }, [crowdMergedId, crowdCues, crowdTotalMs])
  // A concert starts at the top. Full stop (common/concert-start.ts — the
  // phone's LiveConcertsView startShow()). The setlist below is a map, not a
  // menu: a row click, like Play Live Set, starts the show from 0:00, and
  // does nothing while this show is already the current track.
  const startShow = useCallback(() => {
    if (!mergedTrack) return
    const plan = planConcertStart({ showIsCurrent: setPlaying, repeat: pb.repeat })
    if (plan.action === 'none') return
    // A stale repeat-one would loop the entire merged set.
    if (plan.clearRepeatOne) pbDispatch({ type: 'SET_REPEAT', mode: 'off' })
    playTrack(mergedTrack, [mergedTrack], 0, undefined, true)
  }, [mergedTrack, setPlaying, pb.repeat, pbDispatch, playTrack])

  // Factual credits (MusicBrainz + iTunes) and the Music Man blurb. Both
  // fetched per-album, fail-soft (sections just stay hidden on error).
  const [credits, setCredits] = useState<{ released?: string; label?: string; producer?: string; recorded?: string } | null>(null)
  const [blurb, setBlurb] = useState<string>('')
  const [infoLoading, setInfoLoading] = useState(false)
  const [infoError, setInfoError] = useState(false)
  // No take here (Jake, 2026-11-13: "he also should only give his opinion if i ask"): the Music
  // Man answers about this album when the mic is pressed on this page (musicManSubject.ts).
  const [bioExpanded, setBioExpanded] = useState(false)
  // Personnel — who played and who made it, from MusicBrainz (never the AI;
  // Jake 2026-10-30: "mention the album personnel somewhere"). Nothing until
  // it's known, nothing when it isn't.
  const [people, setPeople] = useState<AlbumPerson[]>([])
  // The release's track total — what "on every track" is measured against
  // when a part carries its track numbers ("lead vocals (5, 15)").
  const [peopleTrackCount, setPeopleTrackCount] = useState(0)
  const [peopleAll, setPeopleAll] = useState(false)
  // The head's width decides the narrow branch (see NARROW_HEAD_PX) — the
  // same threshold as the CSS container query, known to the page too.
  const headRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = headRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setNarrow(w > 0 && w <= NARROW_HEAD_PX)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // The history opens on its first whole sentences and never cuts one short
  // (Jake 2026-10-30: "the description stops mid sentence"); Read more shows
  // the rest. Unclamped, a long history pushed the songs below the window.
  // (Hooks stay above the empty-album return below: the page must not crash
  // when its last song is deleted.)
  const bioPreview = useMemo(() => sentencePreview(blurb, narrow ? 200 : 330), [blurb, narrow])
  const bioHasMore = bioPreview.length < blurb.length
  const peopleShown = narrow ? 4 : PEOPLE_SHOWN
  // The sleeve's lines: band, guests, production; parts summarised, each with
  // its track numbers when it is not on the whole record (common/personnel-roles.ts
  // — Jake 2026-10-30: "this is no way to list personnel"; "i want to know
  // which personnel sings on which tracks").
  const personnelLines = useMemo(() => arrangePersonnel(people, peopleTrackCount), [people, peopleTrackCount])
  // The spine text must sit between the hinge pins: the rendered candidate is
  // measured (vertical text — its height is its length) and the next one
  // tried; past the last, the spine stays blank.
  const spineOptions = useMemo(() => spineCandidates(albumArtist, albumName), [albumArtist, albumName])
  const [spineIdx, setSpineIdx] = useState(0)
  const spineRef = useRef<HTMLSpanElement>(null)
  const knuckleTopRef = useRef<HTMLSpanElement>(null)
  const knuckleBottomRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => { setSpineIdx(0) }, [spineOptions, narrow])
  useLayoutEffect(() => {
    const el = spineRef.current
    const top = knuckleTopRef.current
    const bottom = knuckleBottomRef.current
    if (!el || !top || !bottom) return
    const free = bottom.getBoundingClientRect().top - top.getBoundingClientRect().bottom - 12
    if (el.getBoundingClientRect().height > free) setSpineIdx((i) => i + 1)
  }, [spineIdx, spineOptions, narrow])
  const spineText = spineOptions[spineIdx]

  // The songs: the one song table (V7), sortable like every list; its own
  // order (null) is the record's running order. The album page leaves out the
  // Album column, and Artist unless the record has more than one.
  const [sort, setSort] = useListSort(`album:${albumKey}`)
  const shown = useMemo(() => sortSongs(tracks, sort, elsewhere), [tracks, sort, elsewhere])
  const multiArtist = new Set(tracks.map((t) => (t.artist || '').trim().toLowerCase())).size > 1
  const lead = useMemo((): SongTableLead => ({
    label: '#',
    width: 48,
    // The record's own number; the speaker while it plays.
    render: (track, idx, playing) => (playing ? <SpeakerPlayingIcon /> : (track.trackNumber || idx + 1)),
  }), [])

  // Fetch factual credits + Music Man blurb when the album changes.
  // Deferred so the track list paints before Claude/MB IPC competes.
  // ── one-paint gate ────────────────────────────────────────────────────────
  // The tracklist used to paint instantly and the credits/blurb block arrive
  // whenever its IPC returned — the page assembled in two visible steps
  // (Jake: "features on every page need to load at same time"). Hold one
  // skeleton until the info settles, with a 2.5s cap: a cold blurb is an LLM
  // call, and past the cap the page paints with that one section in its
  // existing loading state rather than holding the whole album hostage.
  const [infoSettled, setInfoSettled] = useState(false)
  const [infoCapHit, setInfoCapHit] = useState(false)
  useEffect(() => {
    setInfoSettled(false); setInfoCapHit(false)
    const cap = setTimeout(() => setInfoCapHit(true), 2500)
    return () => clearTimeout(cap)
  }, [albumArtist, albumName])
  const pageReady = tracks.length === 0 || infoSettled || infoCapHit
  const infoLoadingShown = useDelayedFlag(infoLoading)

  useEffect(() => {
    if (tracks.length === 0) return
    let cancelled = false
    setCredits(null); setBlurb(''); setBioExpanded(false); setInfoLoading(true); setInfoError(false)
    setPeople([]); setPeopleTrackCount(0); setPeopleAll(false)
    const timer = window.setTimeout(() => {
      // Personnel rides on its own promise too: a cold MusicBrainz lookup is
      // a few seconds; the page never waits for it.
      window.electronAPI.getAlbumPersonnel?.(albumArtist, albumName)
        .then((r) => {
          if (cancelled || !r?.ok || !r.people?.length) return
          setPeople(presentablePeople(r.people, albumArtist))
          setPeopleTrackCount(typeof r.trackCount === 'number' && r.trackCount > 0 ? r.trackCount : 0)
        })
        .catch(() => { /* unknown reads as nothing, like the credits */ })
      void (async () => {
        try {
          const [info, b] = await Promise.all([
            window.electronAPI.getAlbumInfo?.(albumArtist, albumName, String(year || '')),
            window.electronAPI.getAlbumBlurb?.(albumArtist, albumName, String(year || '')),
          ])
          if (cancelled) return
          if (info?.ok && info.credits) setCredits(info.credits)
          if (b?.ok && b.blurb) setBlurb(b.blurb)
          if (!(info?.ok && info.credits) && !(b?.ok && b.blurb)) setInfoError(true)
        } catch {
          if (!cancelled) setInfoError(true)
        } finally { if (!cancelled) { setInfoLoading(false); setInfoSettled(true) } }
      })()
    }, 280)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [albumArtist, albumName, year, tracks.length])

  if (tracks.length === 0) {
    return (
      <div className="album-page album-page--empty">
        <div className="album-page-topbar">
          <BackButton label={shownBackLabel} onClick={goBack} />
        </div>
        <p className="album-page-notfound">That album isn't in your library anymore.</p>
      </div>
    )
  }

  const hasCredits = !!(credits && (credits.released || credits.label || credits.producer || credits.recorded))

  const releaseDisplay = albumCreditReleaseDate(year, credits?.released)

  // Right-hand credits (direction D): the facts we have, in a fixed order.
  // Genre + Length are local, so the list is never empty.
  const creditRows: Array<[string, string]> = [
    ...(releaseDisplay ? [['Released', formatReleaseDateDisplay(releaseDisplay)] as [string, string]] : []),
    ...(credits?.label ? [['Label', credits.label] as [string, string]] : []),
    ...(credits?.producer ? [['Producer', credits.producer] as [string, string]] : []),
    // Genre and length are on the facts line just above — once is enough.
  ]

  const showBlurb = !!blurb && !isWeakBlurb(blurb)

  // Artist column only when the record really has more than one artist.

  // 2026-09-02 — no whole-page gate: the tracks are in memory, so the album
  // paints on frame one; the history blurb lands in its own line, with a
  // placeholder only after 400 ms (see ArtistDetailView for the why).
  void pageReady

  return (
    <div className="album-page album-page--d">
      <div className="apd-scroll" ref={tracklistRef}>
        <div className="apd-head" ref={headRef}>
          <div className="album-page-topbar apd-top">
            <BackButton label={shownBackLabel} onClick={goBack} />
            {siblingAlbums.length > 1 && curIdx >= 0 && (
              <div className="album-page-flip apd-more" title={`${albumArtist} — album ${curIdx + 1} of ${siblingAlbums.length}`}>
                <span className="apd-more-label">More by {albumArtist}</span>
                <span className="apd-pager">
                  <button
                    type="button"
                    className="album-page-flip-btn apd-pager-btn"
                    disabled={!prevAlbum}
                    onClick={() => prevAlbum && libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: prevAlbum.key })}
                    title={prevAlbum ? `Newer: ${prevAlbum.name}${prevAlbum.year ? ` (${prevAlbum.year})` : ''}` : 'Newest album'}
                    aria-label="Newer album"
                  >{ICON_LEFT}</button>
                  <span className="album-page-flip-pos apd-pager-pos">{curIdx + 1} of {siblingAlbums.length}</span>
                  <button
                    type="button"
                    className="album-page-flip-btn apd-pager-btn"
                    disabled={!nextAlbum}
                    onClick={() => nextAlbum && libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: nextAlbum.key })}
                    title={nextAlbum ? `Older: ${nextAlbum.name}${nextAlbum.year ? ` (${nextAlbum.year})` : ''}` : 'Oldest album'}
                    aria-label="Older album"
                  >{ICON_RIGHT}</button>
                </span>
              </div>
            )}
          </div>

          <div className="apd-sleeve" style={SLEEVE_VARS}>
            {/* A photographed CD jewel case, closed, straight on (the layers
                in assets/jewel-case/, their proportions in
                common/jewel-case-photo.ts): the contact shadow; the frame —
                the plastic with the booklet window cut out — with the spine
                text printed on its ribbed hinge strip and the two hinge-pin
                marks the spine measurement needs; the cover = the booklet in
                the window; the lid's optics over all of it. .album-page-cover
                stays the plain square — the disc handoff (discHandoff.ts /
                disc-handoff.css) morphs exactly that box, and names the lid. */}
            <div className="apd-art">
              <span className="apd-case-shadow" aria-hidden="true" />
              <div className="apd-case" aria-hidden="true">
                <span className="apd-case-spine">
                  {spineText && <span ref={spineRef} className="apd-case-spine-text">{spineText}</span>}
                </span>
                <span ref={knuckleTopRef} className="apd-case-knuckle apd-case-knuckle--top" />
                <span ref={knuckleBottomRef} className="apd-case-knuckle apd-case-knuckle--bottom" />
              </div>
              <div className="album-page-cover apd-cover">
                {artHash
                  ? <AlbumArtImage hash={artHash} alt={albumName} priority />
                  : <div className="album-page-cover-placeholder apd-cover-placeholder">{ICON_NOTE_BIG}</div>}
              </div>
              <div className="apd-case-lid" aria-hidden="true" />
            </div>

            <div className="apd-meta">
              {albumArtist ? (
                <button
                  type="button"
                  className="apd-artist"
                  onClick={() => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: albumArtist })}
                  title={`Go to ${albumArtist}`}
                >{albumArtist}</button>
              ) : null}
              <h1 className="apd-title">{albumName}</h1>
              <div className="apd-facts">
                {[year && String(year), `${tracks.length} song${tracks.length === 1 ? '' : 's'}`, formatTotalDuration(totalMs), genre].filter(Boolean).map((f, i) => (
                  <span key={i}>{f}</span>
                ))}
              </div>
              <div className="apd-ctrls">
                <button type="button" className="apd-btn apd-btn--orange" onClick={() => playTrack(tracks[0], tracks, 0, undefined, true)}>{ICON_PLAY}Play</button>
                <button type="button" className="apd-btn" onClick={() => { const s = shuffle(tracks); if (s.length) playTrack(s[0], s, 0, undefined, true) }}>{ICON_SHUFFLE}Shuffle</button>
                {/* V5 Live Concert Mode — declare / play-set / undeclare.
                    Declaring is allowed IF AND ONLY IF the album is complete
                    (every track present, verified against declared counts). */}
                {!isLiveSetAlbumPage && <span className="apd-ctrls-gap" aria-hidden="true" />}
                {!isLiveSetAlbumPage && (liveSet && mergedTrack ? (
                  <>
                    <button type="button" className="apd-btn apd-btn--orange album-page-liveset-play" onClick={startShow}>{ICON_PLAY}Play Live Album</button>
                    <button
                      type="button"
                      className={`apd-btn album-page-liveset-crowd${crowdOn ? ' album-page-liveset-crowd--on' : ''}`}
                      onClick={() => setConcertCrowdEnabled(!crowdOn)}
                    >
                      {crowdOn ? '◉ Crowd on' : '◎ Crowd'}
                    </button>
                    <button type="button" className="apd-btn album-page-liveset-undeclare" onClick={() => setUndeclareConfirm(true)}>{REMOVE_CONCERT_LABEL}</button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="apd-btn album-page-liveset-declare"
                    onClick={handleDeclare}
                    disabled={mergeBusy || !completeness.complete}
                    title={!completeness.complete
                      ? `Live Mode needs the complete album — ${completeness.reason}`
                      : completeness.verifiedTotal
                        ? "Copy + merge this album's tracks into one continuous live set"
                        : "The files can't confirm the total — you'll be asked to confirm the show is complete"}
                  >
                    {ICON_MIC}{mergeBusy ? (mergeLabel || 'Merging…') : 'Declare Live Concert Mode'}
                  </button>
                ))}
              </div>
              {!isLiveSetAlbumPage && !liveSet && !completeness.complete && (
                <div className="album-page-liveset-blocked apd-blocked">
                  Live Mode needs the complete album — {completeness.reason}
                </div>
              )}

              <div className="apd-body">
                <div className="apd-text">
                  {showBlurb && <p className="apd-bio">{bioExpanded ? blurb : bioPreview}</p>}
                  {showBlurb && bioHasMore && (
                    <button
                      type="button"
                      className={`apd-take-more apd-bio-more${bioExpanded ? ' is-open' : ''}`}
                      onClick={() => setBioExpanded((v) => !v)}
                      aria-expanded={bioExpanded}
                    >
                      {bioExpanded ? 'Show less' : 'Read more'}
                      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 3l2 2 2-2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
                    </button>
                  )}
                  {infoLoadingShown && !blurb && (
                    <p className="album-page-loading apd-status-note">Loading album history…</p>
                  )}
                  {infoError && !infoLoading && !blurb && !hasCredits && (
                    <p className="album-page-loading apd-status-note">Couldn&apos;t load album info.</p>
                  )}
                </div>
                {/* Credits as one row under the history: as a column beside it
                    (or under the sleeve) they left dead space (Jake 2026-10-30). */}
                {creditRows.length > 0 && (
                  <dl className="apd-cred">
                    {creditRows.map(([k, v]) => (
                      <div className="apd-cred-item" key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {personnelLines.length > 0 && (
                  <section className="apd-people" aria-label="Personnel">
                    <h4 className="apd-people-label">Personnel</h4>
                    <ul className="apd-people-list">
                      {(peopleAll ? personnelLines : personnelPreview(personnelLines, peopleShown)).map((l, i, arr) => (
                        <li
                          className={`apd-person apd-person--${l.group}${i > 0 && arr[i - 1]!.group !== l.group ? ' apd-person--group-start' : ''}`}
                          key={`${l.name}#${i}`}
                          title={l.allRoles.join(', ') !== l.roles.join(', ') ? l.allRoles.join(', ') : undefined}
                        >
                          <span className="apd-person-name">{l.name}</span>
                          <span className="apd-person-roles">{l.roles.join(', ')}</span>
                        </li>
                      ))}
                    </ul>
                    {personnelLines.length > peopleShown && (
                      <button
                        type="button"
                        className={`apd-take-more apd-people-more${peopleAll ? ' is-open' : ''}`}
                        onClick={() => setPeopleAll((v) => !v)}
                        aria-expanded={peopleAll}
                      >
                        {peopleAll ? 'Fewer' : `All ${personnelLines.length}`}
                        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 3l2 2 2-2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
                      </button>
                    )}
                  </section>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* V5 Live Concert Mode — the set list. Active song highlights while
            the merged set plays. A click starts the set from the top when it
            isn't playing, and never jumps around in it (Jake 8/8: "it should
            start from track 1 thats it"). */}
        {liveSet && mergedTrack && (() => {
          // The printed setlist sheet — same prop as ConcertDetailView (shared
          // .concert-sheet / .cj-* language from concert-detail.css), minus the
          // journey rail. Length bars scale to the night's longest song; the ✓
          // renders only when it distinguishes rows; guest cues get a chip.
          const promoted = new Set(liveSet.promotedTrackIds || [])
          const allPromoted = liveSet.cues.every((c) => promoted.has(c.trackId))
          const maxDurMs = Math.max(1, ...liveSet.cues.map((c) => c.durationMs))
          const artistLc = albumArtist.toLowerCase().trim()
          const dividers = new Map<number, string>()
          for (const s of liveSet.concert?.segments || []) {
            if (s && typeof s.before === 'number' && s.label) dividers.set(s.before, s.label)
          }
          return (
            <div className="concert-sheet album-page-sheet">
              <div className="cs-head">
                {/* "Songs in this show", not "Set List": Jake 2026-10-28 couldn't tell
                    what "Setlist" was, and setlist.fm's "What they've been
                    playing" / "What they played" now live on the concert cards. */}
                <span className="cs-head-title">Songs in This Show</span>
                <span className="cs-head-rule" aria-hidden="true" />
                <span className="cs-head-stat">
                  {liveSet.cues.length} songs · {formatTotalDuration(liveSet.totalDurationMs)}
                  {setPlaying && activeCue ? ` · now ${activeCue.index + 1}/${liveSet.cues.length}` : ''}
                </span>
              </div>
              <div className="cs-cols cs-cols--norail" aria-hidden="true">
                <span className="cs-cols-song">Song</span>
                <span className="cs-cols-len">Length</span>
                <span className="cs-cols-at">At</span>
              </div>
              <div className="aps-rows">
                {liveSet.cues.map((cue, i) => {
                  const inLibrary = !allPromoted && promoted.has(cue.trackId)
                  const guest = (cue.artist || '').toLowerCase().trim() !== artistLc ? cue.artist : null
                  const state = activeCue ? (activeCue.index === i ? '--active' : i < activeCue.index ? '--played' : '') : ''
                  const divider = dividers.get(i + 1)
                  return (
                    <React.Fragment key={`${cue.trackId}-${i}`}>
                      {divider && (
                        <div className="cs-divider cs-divider--norail" aria-label={divider}>
                          <span className="cs-divider-rule" /><span className="cs-divider-label">{divider}</span><span className="cs-divider-rule" />
                        </div>
                      )}
                      <div
                        className={`cj-song aps-row${state ? ` aps-row${state}` : ''}`}
                        onClick={startShow}
                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCueCtx({ x: e.clientX, y: e.clientY, cue }) }}
                        title={setPlaying ? 'Right-click a song to add it to your library' : 'Play the live album from the top — right-click a song to add it to your library'}
                        role="button"
                      >
                        <span className="cj-num">{String(i + 1).padStart(2, '0')}</span>
                        <span className="cj-name">
                          <span className="cj-name-text">{cleanLiveTitle(cue.title)}</span>
                          {guest && <span className="cj-guest">{guest}</span>}
                          {inLibrary && <span className="cj-inlib" title="In your library">✓</span>}
                        </span>
                        <span className="cj-lane" aria-hidden="true"><span className="cj-lane-bar" style={{ width: `${Math.max(6, Math.round((cue.durationMs / maxDurMs) * 100))}%` }} /></span>
                        <span className="cj-len">{formatDuration(cue.durationMs)}</span>
                        <span className="cj-at">{startClock(cue.startMs)}</span>
                      </div>
                    </React.Fragment>
                  )
                })}
              </div>
            </div>
          )
        })()}

        <SongTable
          listKey={`album:${albumKey}`}
          scroll="page"
          className="apd-songs"
          tracks={shown}
          active={lib.currentView === 'album-detail'}
          sort={sort}
          onSort={setSort}
          lead={lead}
          omitColumns={multiArtist ? ['album'] : ['album', 'artist']}
        />

      </div>

      <div className="apd-statusbar">
        <span className="apd-statusbar-hint">Double-click a song to play from there · right-click for the full song menu</span>
        <span className="apd-statusbar-total">{tracks.length} song{tracks.length === 1 ? '' : 's'}, {totalClock(totalMs)} total time</span>
        <span aria-hidden="true" />
      </div>

      {cueCtx && (
        <ContextMenu
          x={cueCtx.x}
          y={cueCtx.y}
          items={
            (liveSet?.promotedTrackIds || []).includes(cueCtx.cue.trackId)
              ? [{ label: 'Already in your library', onClick: () => {}, disabled: true }]
              : [{
                  label: `Add "${cueCtx.cue.title}" to My Library`,
                  onClick: () => { void promoteTrackToLibrary(albumKey, cueCtx.cue.trackId) },
                }]
          }
          onClose={() => setCueCtx(null)}
        />
      )}
      {undeclareConfirm && liveSet && (
        <RemoveConcertDialog
          name={albumName}
          onConfirm={() => { void handleUndeclare() }}
          onCancel={() => setUndeclareConfirm(false)}
        />
      )}
      {completenessConfirm && completeness.complete && (
        <ConfirmDialog
          message={`Is this the complete show?`}
          detail={`The files don't declare the album's total track count, so it can't be verified automatically. What's here checks out: ${completeness.total} tracks, numbered with no gaps or duplicates. Only declare Live Mode if this is every track of the show.`}
          confirmLabel="It's complete — merge"
          // A question, not a destroy: it creates the concert, so it is not
          // red and Enter answers yes (spec-03 keeps Enter=Cancel for destroys).
          destructive={false}
          onConfirm={() => { setCompletenessConfirm(false); void runDeclare(true) }}
          onCancel={() => setCompletenessConfirm(false)}
        />
      )}
    </div>
  )
}

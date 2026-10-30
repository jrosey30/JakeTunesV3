import React, { useCallback, useMemo, useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { sentencePreview } from '../../common/sentences'
import type { AlbumPerson } from '../types'
import { useDelayedFlag } from '../hooks/useDelayedFlag'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio, prefetchTrackForPlay, prefetchTrackImmediate } from '../hooks/useAudio'
import { useCynthia } from '../context/CynthiaContext'
import { toCynthiaTrack } from '../utils/cynthia'
import { albumKeyOf } from '../utils/albumKey'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { canonicalArtist } from '../utils/artistAlias'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import { albumCreditReleaseDate, formatReleaseDateDisplay } from '../utils/albumReleaseDate'
import { albumDetailBackLabel, backLabelForLocation } from '../utils/albumBackLabel'
import { useNavigation } from '../context/NavigationContext'
import { lookupArtwork, buildNormalizedArtworkIndex, clearArtworkNegativeCache } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumArtImage from '../components/AlbumArtImage'
import { ratingMenuEntries } from '../components/StarRating'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import { downloadMenuEntries } from '../utils/downloadStore'
import GetInfoModal from '../components/GetInfoModal'
import ConfirmDialog from '../components/ConfirmDialog'
import RemoveConcertDialog, { REMOVE_CONCERT_LABEL } from '../components/RemoveConcertDialog'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import { setNotice } from '../activity'
import { usePlaysElsewhere } from '../playsElsewhere'
import { playsEverywhere } from '../../common/plays-elsewhere'
// V5 Live Concert Mode — declared-set store + declare orchestration.
import { subscribeLiveSets, getLiveSetsSnapshot, ensureLiveSetsLoaded, liveSetFor, unregisterLiveSet, cueAt, promoteTrackToLibrary, cleanLiveTitle } from '../liveSets'
import { attachConcert, detachConcert, subscribeConcertCrowd, isConcertCrowdEnabled, setConcertCrowdEnabled } from '../concertCrowd'
import { declareLiveSet, isDeclareInFlight } from '../liveSetDeclare'
import { verifyLiveSetCompleteness } from '../utils/liveSetCompleteness'
import type { Track, LiveSetCue } from '../types'
import '../styles/songs.css'
import '../styles/album-page.css'
import { addToPlaylistEntry, addToIpodPoolEntry, queueMenuEntries } from '../utils/playlistMenu'
import { getInfoTarget, type GetInfoTarget } from '../../common/get-info-target'
import { planConcertStart } from '../../common/concert-start'

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

/** Music Man sometimes returns a meta "I don't know this album" riff — hide it. */
function isWeakBlurb(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('drawing a blank')
    || lower.includes("didn't stick")
    || lower.includes('pulling a name')
    || lower.includes('land a take worth hearing')
  )
}

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

// Album table (direction D, 2026-10-27): the classic iTunes columns —
// #, Name, [Artist only on multi-artist albums], Plays, Star, Time.
function gridCols(multiArtist: boolean): string {
  return multiArtist
    ? '48px minmax(0, 1.4fr) minmax(0, 1fr) 64px 52px 64px'
    : '48px minmax(0, 1fr) 64px 52px 64px'
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
const ICON_BACK = (
  <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true"><path d="M6 1L2 5l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const ICON_LEFT = (
  <svg width="7" height="10" viewBox="0 0 7 10" aria-hidden="true"><path d="M5 1L1.5 5 5 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const ICON_RIGHT = (
  <svg width="7" height="10" viewBox="0 0 7 10" aria-hidden="true"><path d="M2 1l3.5 4L2 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const ICON_NOTE = (
  <svg width="12" height="13" viewBox="0 0 12 13" aria-hidden="true"><path d="M4.5 1.5l6-1.2v8.2a2 2 0 11-1.3-1.9V3L5.8 3.7v6.8a2 2 0 11-1.3-1.9z" fill="currentColor" /></svg>
)
const ICON_NOTE_BIG = (
  <svg width="84" height="91" viewBox="0 0 12 13" aria-hidden="true"><path d="M4.5 1.5l6-1.2v8.2a2 2 0 11-1.3-1.9V3L5.8 3.7v6.8a2 2 0 11-1.3-1.9z" fill="currentColor" /></svg>
)

/** What the tray card's spine says through the case's hinge: "ARTIST · ALBUM"
 *  when it fits the case's height, the album alone when only that fits —
 *  nothing rather than a clipped word. A short label fits the narrow (240px)
 *  case too (album-page.css hides --mid there). */
const SPINE_SHORT = 24
const SPINE_MID = 36
/** Personnel shown before "All N": the band and the producer, not every guest. */
const PEOPLE_SHOWN = 8
const foldName = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
/** The people worth a line. MusicBrainz credits some members as a bare
 *  "performer" (In Rainbows: all five), which says nothing — the name alone
 *  reads fine; and it credits a band as itself, which is not a person. */
function presentablePeople(people: AlbumPerson[], albumArtist: string): AlbumPerson[] {
  const self = foldName(albumArtist)
  const out: AlbumPerson[] = []
  for (const p of people) {
    const roles = p.roles.filter((r) => r !== 'performer')
    if (!roles.length && foldName(p.name) === self) continue
    out.push(roles.length === p.roles.length ? p : { ...p, roles })
  }
  return out
}
function spineLabel(artist: string, album: string): { text: string; size: 'short' | 'mid' } | null {
  for (const text of [[artist, album].filter(Boolean).join(' · '), album]) {
    if (!text) continue
    if (text.length <= SPINE_SHORT) return { text, size: 'short' }
    if (text.length <= SPINE_MID) return { text, size: 'mid' }
  }
  return null
}

export default function AlbumDetailView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const { openCynthia } = useCynthia()
  const elsewhere = usePlaysElsewhere()

  const albumKeyRef = useRef<string>('')
  if (lib.pendingAlbumKey) albumKeyRef.current = lib.pendingAlbumKey
  const albumKey = albumKeyRef.current || lib.pendingAlbumKey || ''
  // Page memory, per album — reopening the same record lands where you left.
  // Direction D: the whole page scrolls as one sheet (header, setlist, table);
  // the table header sticks under it.
  const tracklistRef = useRef<HTMLDivElement>(null)
  useScrollPersistence(`album-detail:${albumKey}`, tracklistRef)
  const tableRef = useRef<HTMLDivElement>(null)

  const { canGoBack, goBack: navBack, backTo, backToSearch } = useNavigation()
  const returnView = lib.albumDetailReturnView || 'albums'
  // The label names where the click lands: history when there is history,
  // else the stored return view — the same two branches as goBack below.
  const backLabel = (canGoBack && backLabelForLocation(backTo, backToSearch)) || albumDetailBackLabel(lib.albumDetailReturnView)
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
    return [...byKey.values()].sort((a, b) => (b.year || '').localeCompare(a.year || '') || a.name.localeCompare(b.name))
  }, [lib.tracks, albumArtist])
  const curIdx = useMemo(() => siblingAlbums.findIndex(a => a.key === albumKey), [siblingAlbums, albumKey])
  const prevAlbum = curIdx > 0 ? siblingAlbums[curIdx - 1] : null
  const nextAlbum = curIdx >= 0 && curIdx < siblingAlbums.length - 1 ? siblingAlbums[curIdx + 1] : null

  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const artHash = lookupArtwork(lib.artworkMap, artIndex, albumArtist, albumName)

  useEffect(() => {
    if (artHash) prefetchAlbumArtHashes([artHash])
  }, [artHash])

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; idx: number } | null>(null)
  // Right-click a setlist song → reimport that one track into the regular
  // library (promote). The concert stays intact; only that song re-appears.
  const [cueCtx, setCueCtx] = useState<{ x: number; y: number; cue: LiveSetCue } | null>(null)
  const [getInfoState, setGetInfoState] = useState<GetInfoTarget<Track> | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[]; count: number } | null>(null)

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
      setNotice(`Live set ready — ${albumName}`)
    } catch (err) {
      setNotice(`Live set failed: ${err instanceof Error ? err.message : String(err)}`)
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
    setNotice('Concert removed. The songs are unchanged.')
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
  // The Music Man's take — an open block under the history (direction D):
  // fetched with the album info, shown clamped, "Read all" opens the rest.
  const [take, setTake] = useState<string>('')
  const [takeExpanded, setTakeExpanded] = useState(false)
  const [takeOverflows, setTakeOverflows] = useState(false)
  const [bioExpanded, setBioExpanded] = useState(false)
  const [takeLoading, setTakeLoading] = useState(false)
  const [takeError, setTakeError] = useState(false)
  // Personnel — who played and who made it, from MusicBrainz (never the AI;
  // Jake 2026-10-30: "mention the album personnel somewhere"). Nothing until
  // it's known, nothing when it isn't.
  const [people, setPeople] = useState<AlbumPerson[]>([])
  const [peopleAll, setPeopleAll] = useState(false)

  const lastClickedIdx = useRef<number>(-1)
  // Keyboard cursor in the table (↑/↓/Return — see the keydown effect below).
  const focusedIdx = useRef<number>(-1)
  const takeRef = useRef<HTMLParagraphElement>(null)

  const handleClick = useCallback((id: number, idx: number, e: React.MouseEvent) => {
    window.getSelection()?.removeAllRanges()
    if (e.shiftKey && lastClickedIdx.current >= 0 && lastClickedIdx.current < tracks.length) {
      const from = Math.min(lastClickedIdx.current, idx)
      const to = Math.max(lastClickedIdx.current, idx)
      libDispatch({ type: 'SELECT_RANGE', ids: tracks.slice(from, to + 1).map((t) => t.id) })
    } else {
      libDispatch({ type: 'SELECT_TRACK', id, multi: e.metaKey || e.ctrlKey })
      lastClickedIdx.current = idx
    }
    focusedIdx.current = idx
  }, [tracks, libDispatch])

  const handleDoubleClick = useCallback((idx: number) => {
    window.getSelection()?.removeAllRanges()
    const track = tracks[idx]
    if (track) playTrack(track, tracks, idx, undefined, true)
  }, [tracks, playTrack])

  // Cmd+I → Get Info for the selected rows (nothing selected → the
  // now-playing song). Same listener shape as SongsView's.
  useEffect(() => {
    if (lib.currentView !== 'album-detail') return
    const handler = () => {
      if (document.querySelector('.getinfo-overlay')) return
      const np = pb.nowPlaying ? lib.tracks.find(t => t.id === pb.nowPlaying!.id) : undefined
      const target = getInfoTarget(tracks, lib.selectedTrackIds, np)
      if (target) setGetInfoState(target)
    }
    window.addEventListener('jaketunes-get-info', handler)
    return () => window.removeEventListener('jaketunes-get-info', handler)
  }, [lib.currentView, lib.selectedTrackIds, lib.tracks, pb.nowPlaying, tracks])

  // ⚠️ TWIN: src/renderer/views/SongsView.tsx::handleRatingChange — keep in sync.
  const handleRatingChange = useCallback((trackId: number, rating: number) => {
    const value = String(rating)
    libDispatch({ type: 'UPDATE_TRACKS', updates: [{ id: trackId, field: 'rating', value }] })
    window.electronAPI.saveMetadataOverride(trackId, 'rating', value)
    if (rating > 0) {
      const stampValue = String(Date.now())
      libDispatch({ type: 'UPDATE_TRACKS', updates: [{ id: trackId, field: 'starredAt', value: stampValue }] })
      window.electronAPI.saveMetadataOverride(trackId, 'starredAt', stampValue)
    }
  }, [libDispatch])

  // ⚠️ TWIN: src/renderer/views/SongsView.tsx::handleGetInfoSave — keep in sync.
  const handleGetInfoSave = useCallback(async (updates: { id: number; field: string; value: string }[]) => {
    const fpById = new Map<number, string>()
    const oldArtAlbumById = new Map<number, { artist: string; album: string }>()
    for (const u of updates) {
      if (fpById.has(u.id)) continue
      const t = lib.tracks.find((tr) => tr.id === u.id)
      if (!t) continue
      fpById.set(u.id, `${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`)
      oldArtAlbumById.set(u.id, { artist: t.artist || '', album: t.album || '' })
    }
    for (const u of updates) {
      await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value, fpById.get(u.id))
    }
    if (updates.some((u) => u.field === 'artist' || u.field === 'album')) {
      const newById = new Map(oldArtAlbumById)
      for (const u of updates) {
        const cur = newById.get(u.id)
        if (!cur) continue
        if (u.field === 'artist') cur.artist = u.value
        else if (u.field === 'album') cur.album = u.value
      }
      for (const v of newById.values()) clearArtworkNegativeCache(v.artist, v.album)
    }
    libDispatch({ type: 'UPDATE_TRACKS', updates })
  }, [libDispatch, lib.tracks])

  const handleFetchArt = useCallback(async (artist: string, album: string, force?: boolean) => {
    const result = await window.electronAPI.fetchAlbumArt(artist, album, force)
    if (result.ok && result.key && result.hash) {
      libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
      return { key: result.key, hash: result.hash }
    }
    return null
  }, [libDispatch])

  const handleSetCustomArt = useCallback(async (artist: string, album: string, imagePath: string) => {
    const result = await window.electronAPI.setCustomArtwork(artist, album, imagePath)
    if (result.ok && result.key && result.hash) {
      libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
      return { key: result.key, hash: result.hash }
    }
    setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
    return null
  }, [libDispatch])

  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track, idx: number) => {
    e.preventDefault()
    if (!lib.selectedTrackIds.has(track.id)) libDispatch({ type: 'SELECT_TRACK', id: track.id })
    setCtxMenu({ x: e.clientX, y: e.clientY, track, idx })
  }, [lib.selectedTrackIds, libDispatch])

  // ⚠️ TWIN: src/renderer/views/SongsView.tsx::getContextMenuItems (lines ~207-356).
  // This is the SAME track context menu the rest of the app uses. If you add or
  // change an item there, mirror it here (and vice-versa) so the album page's
  // right-click never drifts from the Songs list.
  const getContextMenuItems = useCallback((): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, idx } = ctxMenu
    const selectedTracks = lib.selectedTrackIds.size > 1
      ? tracks.filter((t) => lib.selectedTrackIds.has(t.id))
      : [track]
    const count = selectedTracks.length
    const label = count > 1 ? `${count} Songs` : track.title

    const artPairs = new Map<string, { artist: string; album: string }>()
    for (const t of selectedTracks) {
      if (t.artist && t.album) {
        const k = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
        if (!artPairs.has(k)) artPairs.set(k, { artist: t.artist, album: t.album })
      }
    }
    const artworkItems: MenuEntry[] = artPairs.size > 0 ? [
      { separator: true as const },
      {
        label: 'Add Artwork…',
        onClick: async () => {
          const file = await window.electronAPI.chooseArtworkFile()
          if (!file.ok || !file.path) return
          let failed = 0, lastErr = ''
          for (const { artist, album } of artPairs.values()) {
            const result = await window.electronAPI.setCustomArtwork(artist, album, file.path)
            if (result.ok && result.key && result.hash) libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
            else { failed += 1; lastErr = result.error || '' }
          }
          if (failed > 0) setNotice(failed === 1 ? (lastErr ? `Couldn't save artwork: ${lastErr}` : "Couldn't save artwork.") : `Couldn't save artwork for ${failed} albums.`, { kind: 'error' })
        },
      },
      {
        label: 'Fetch Artwork from Internet',
        onClick: async () => {
          for (const { artist, album } of artPairs.values()) {
            const result = await window.electronAPI.fetchAlbumArt(artist, album, true)
            if (result.ok && result.key && result.hash) libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
          }
        },
      },
    ] : []

    const trackArtist = (track.artist || '').trim()
    const sourceContribs = (track.contributingArtists && track.contributingArtists.length > 0 ? track.contributingArtists : [trackArtist])
      .map((s) => (s || '').trim().toLowerCase()).filter((s) => s.length > 0)
    const artistTracks = sourceContribs.length
      ? lib.tracks.filter((t) => {
          const candidates = (t.contributingArtists && t.contributingArtists.length > 0 ? t.contributingArtists : [(t.artist || '').trim()])
            .map((s) => (s || '').trim().toLowerCase()).filter((s) => s.length > 0)
          return candidates.some((c) => sourceContribs.includes(c))
        })
      : []

    return [
      { label: `Play "${label}"`, onClick: () => playTrack(track, tracks, idx, undefined, true) },
      { separator: true as const },
      ...queueMenuEntries(selectedTracks, pbDispatch),
      addToPlaylistEntry(selectedTracks, lib.playlists, (pid, ids) => libDispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
      addToIpodPoolEntry(selectedTracks),
      { separator: true as const },
      // Already on the album page — only Go to Artist makes sense here.
      { label: 'Go to Artist', onClick: () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(track.albumArtist || track.artist || '') }) },
      ...(trackArtist && artistTracks.length > 0 ? [
        { separator: true as const },
        { label: `Start ${trackArtist} Radio`, onClick: () => { window.dispatchEvent(new CustomEvent('jaketunes-start-artist-radio', { detail: { tracks: artistTracks, label: trackArtist } })) } },
      ] : []),
      ...ratingMenuEntries(selectedTracks, libDispatch),
      { separator: true as const },
      { label: 'Get Info', onClick: () => setGetInfoState({ tracks: selectedTracks, index: idx }) },
      ...artworkItems,
      ...downloadMenuEntries(selectedTracks),
      { separator: true as const },
      {
        label: 'Cynthia!!',
        onClick: () => openCynthia({ x: ctxMenu.x, y: ctxMenu.y, scope: { type: 'tracks', label: count > 1 ? `${count} tracks` : track.title, tracks: selectedTracks.map(toCynthiaTrack) } }),
      },
      { separator: true as const },
      { label: count > 1 ? `Delete ${count} Songs` : 'Delete Song', onClick: () => setDeleteConfirm({ ids: selectedTracks.map((t) => t.id), count }) },
    ]
  }, [ctxMenu, lib.selectedTrackIds, lib.tracks, tracks, playTrack, pbDispatch, libDispatch, openCynthia])

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
    setTake(''); setTakeExpanded(false); setTakeOverflows(false); setTakeLoading(true); setTakeError(false)
    setPeople([]); setPeopleAll(false)
    const timer = window.setTimeout(() => {
      // Personnel rides on its own promise too: a cold MusicBrainz lookup is
      // a few seconds; the page never waits for it.
      window.electronAPI.getAlbumPersonnel?.(albumArtist, albumName)
        .then((r) => { if (!cancelled && r?.ok && r.people?.length) setPeople(presentablePeople(r.people, albumArtist)) })
        .catch(() => { /* unknown reads as nothing, like the credits */ })
      // The take rides beside the facts, never in front of them: its own
      // promise, so a slow opinion can't hold the history back.
      const takeCall = window.electronAPI.getAlbumTake?.(albumArtist, albumName, String(year || ''))
      if (takeCall) {
        takeCall
          .then((r) => { if (cancelled) return; if (r?.ok && r.take) setTake(r.take); else setTakeError(true) })
          .catch(() => { if (!cancelled) setTakeError(true) })
          .finally(() => { if (!cancelled) setTakeLoading(false) })
      } else {
        setTakeLoading(false); setTakeError(true)
      }
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

  // Show Read all / Show less only when the take's clamp actually hides text.
  useEffect(() => {
    if (!take || takeExpanded) return
    const el = takeRef.current
    if (!el) return
    const check = () => {
      setTakeOverflows(el.scrollHeight > el.clientHeight + 1)
    }
    check()
    const raf = requestAnimationFrame(check)
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [take, takeExpanded])

  // Drag-to-queue from the album page. This view never set the drag payload,
  // so dragging a song into the queue silently did nothing — the "works
  // (Songs view) then doesn't (album page)" glitch. Same multi-select
  // semantics as SongsView: drag the selection if the grabbed row is in it.
  const handleRowDragStart = useCallback((track: Track, e: React.DragEvent) => {
    const sel = lib.selectedTrackIds
    const chosen = sel.has(track.id) && sel.size > 1 ? tracks.filter(t => sel.has(t.id)) : [track]
    e.dataTransfer.setData('application/jaketunes-tracks', JSON.stringify(chosen.map(t => t.id)))
    e.dataTransfer.effectAllowed = 'copy'
  }, [lib.selectedTrackIds, tracks])

  // Keyboard in the table — the same keys as the Songs list (SongsView's
  // handler): ↑/↓ move the selection (⇧ extends it), Return plays the
  // highlighted song. Capture phase + stopPropagation on ↑/↓ so App.tsx's
  // global volume nudge doesn't ALSO fire while you arrow through the record.
  useEffect(() => { focusedIdx.current = -1 }, [albumKey])
  const scrollRowIntoView = useCallback((idx: number) => {
    const el = tableRef.current?.querySelector<HTMLElement>(`[data-row-idx="${idx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [])
  useEffect(() => {
    if (lib.currentView !== 'album-detail' || tracks.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.getinfo-overlay')) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        const dir = e.key === 'ArrowDown' ? 1 : -1
        let cur = focusedIdx.current
        if (cur < 0) cur = tracks.findIndex((t) => lib.selectedTrackIds.has(t.id))
        let next = cur < 0 ? (dir > 0 ? 0 : tracks.length - 1) : cur + dir
        next = Math.max(0, Math.min(tracks.length - 1, next))
        focusedIdx.current = next
        const track = tracks[next]
        if (!track) return
        if (e.shiftKey) {
          const anchor = lastClickedIdx.current >= 0 ? lastClickedIdx.current : next
          const from = Math.min(anchor, next)
          const to = Math.max(anchor, next)
          libDispatch({ type: 'SELECT_RANGE', ids: tracks.slice(from, to + 1).map((t) => t.id) })
        } else {
          libDispatch({ type: 'SELECT_TRACK', id: track.id })
          lastClickedIdx.current = next
        }
        scrollRowIntoView(next)
        return
      }
      if (e.key === 'Enter') {
        // A focused button (Play, Read all…) answers Return itself.
        if (tag === 'BUTTON' || tag === 'A') return
        const idx = focusedIdx.current >= 0 ? focusedIdx.current : tracks.findIndex((t) => lib.selectedTrackIds.has(t.id))
        const track = idx >= 0 ? tracks[idx] : null
        if (!track) return
        e.preventDefault()
        playTrack(track, tracks, idx, undefined, true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [lib.currentView, lib.selectedTrackIds, tracks, libDispatch, playTrack, scrollRowIntoView])

  if (tracks.length === 0) {
    return (
      <div className="album-page album-page--empty">
        <div className="album-page-topbar">
          <button type="button" className="album-page-back" onClick={goBack}>{shownBackLabel}</button>
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
    ...(genre ? [['Genre', genre] as [string, string]] : []),
    ['Length', `${totalClock(totalMs)} · ${tracks.length} song${tracks.length === 1 ? '' : 's'}`],
  ]

  const showBlurb = !!blurb && !isWeakBlurb(blurb)
  // The history opens on its first whole sentences and never cuts one short
  // (Jake 2026-10-30: "the description stops mid sentence"); Read more shows
  // the rest. Unclamped, a long history pushed the songs below the window.
  const bioPreview = useMemo(() => sentencePreview(blurb), [blurb])
  const bioHasMore = bioPreview.length < blurb.length
  const spine = spineLabel(albumArtist, albumName)

  // Artist column only when the record really has more than one artist.
  const multiArtist = new Set(tracks.map((t) => (t.artist || '').trim().toLowerCase())).size > 1
  const cols = gridCols(multiArtist)

  // "‹ Albums" — the chevron is drawn, so drop the label's text arrow.
  const backText = shownBackLabel.replace(/^[←‹]\s*/, '')

  // 2026-09-02 — no whole-page gate: the tracks are in memory, so the album
  // paints on frame one; the history blurb lands in its own line, with a
  // placeholder only after 400 ms (see ArtistDetailView for the why).
  void pageReady

  return (
    <div className="album-page album-page--d">
      <div className="apd-scroll" ref={tracklistRef}>
        <div className="apd-head">
          <div className="album-page-topbar apd-top">
            <button type="button" className="album-page-back apd-back" onClick={goBack} aria-label={backText}>{ICON_BACK}<span>{backText}</span></button>
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

          <div className="apd-sleeve">
            {/* A CD jewel case, closed, straight on: the cover is the booklet
                under the clear lid; the black tray shows round it through the
                lid's rim; on the left the lid's ribbed hinge over the tray
                card's printed spine, with the two hinge pins; two latch slots
                on the right edge. .album-page-cover stays the plain square —
                the disc handoff (discHandoff.ts / disc-handoff.css) morphs
                exactly that box. Sizes: album-page.css (the phone's case
                points from common/jewel-case.ts × the cover / 160). */}
            <div className="apd-art">
              <div className="apd-case" aria-hidden="true">
                <span className="apd-case-spine">
                  {spine && <span className={`apd-case-spine-text apd-case-spine-text--${spine.size}`}>{spine.text}</span>}
                </span>
                <span className="apd-case-knuckle apd-case-knuckle--top" />
                <span className="apd-case-knuckle apd-case-knuckle--bottom" />
              </div>
              <div className="album-page-cover apd-cover">
                {artHash
                  ? <AlbumArtImage hash={artHash} alt={albumName} priority />
                  : <div className="album-page-cover-placeholder apd-cover-placeholder">{ICON_NOTE_BIG}</div>}
              </div>
              <div className="apd-case-lid" aria-hidden="true">
                <span className="apd-case-ribs" />
                <span className="apd-case-gloss" />
                <span className="apd-case-latch apd-case-latch--top" />
                <span className="apd-case-latch apd-case-latch--bottom" />
                <span className="apd-case-edge" />
              </div>
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
                <button type="button" className="apd-btn" onClick={() => { const s = tracks.slice().sort(() => Math.random() - 0.5); if (s.length) playTrack(s[0], s, 0, undefined, true) }}>{ICON_SHUFFLE}Shuffle</button>
                {/* V5 Live Concert Mode — declare / play-set / undeclare.
                    Declaring is allowed IF AND ONLY IF the album is complete
                    (every track present, verified against declared counts). */}
                {!isLiveSetAlbumPage && <span className="apd-ctrls-gap" aria-hidden="true" />}
                {!isLiveSetAlbumPage && (liveSet && mergedTrack ? (
                  <>
                    <button type="button" className="apd-btn apd-btn--orange album-page-liveset-play" onClick={startShow} title="Play the whole show as one continuous set">{ICON_PLAY}Play Live Set</button>
                    <button
                      type="button"
                      className={`apd-btn album-page-liveset-crowd${crowdOn ? ' album-page-liveset-crowd--on' : ''}`}
                      onClick={() => setConcertCrowdEnabled(!crowdOn)}
                      title="Swell that night's crowd in the gaps between songs — off by default"
                    >
                      {crowdOn ? '◉ Crowd on' : '◎ Crowd'}
                    </button>
                    <button type="button" className="apd-btn album-page-liveset-undeclare" onClick={() => setUndeclareConfirm(true)} title="Remove this concert — the songs are unaffected">{REMOVE_CONCERT_LABEL}</button>
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
                {people.length > 0 && (
                  <section className="apd-people" aria-label="Personnel">
                    <h4 className="apd-people-label">Personnel</h4>
                    <ul className="apd-people-list">
                      {(peopleAll ? people : people.slice(0, PEOPLE_SHOWN)).map((p) => (
                        <li className="apd-person" key={p.name}>
                          <span className="apd-person-name">{p.name}</span>
                          {p.roles.length > 0 && <span className="apd-person-roles"> {p.roles.join(', ')}</span>}
                        </li>
                      ))}
                    </ul>
                    {people.length > PEOPLE_SHOWN && (
                      <button
                        type="button"
                        className={`apd-take-more apd-people-more${peopleAll ? ' is-open' : ''}`}
                        onClick={() => setPeopleAll((v) => !v)}
                        aria-expanded={peopleAll}
                      >
                        {peopleAll ? 'Fewer' : `All ${people.length}`}
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
                <span className="cs-head-title">Songs in this show</span>
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
                        title={setPlaying ? 'Right-click a song to add it to your library' : 'Play the live set from the top — right-click a song to add it to your library'}
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
                        <span className="cj-at" title="Starts at this point in the show">{startClock(cue.startMs)}</span>
                      </div>
                    </React.Fragment>
                  )
                })}
              </div>
            </div>
          )
        })()}

        <div className="apd-table" ref={tableRef} role="grid" aria-label={`${albumName} songs`}>
          <div className="apd-thead" style={{ gridTemplateColumns: cols }} role="row">
            <div className="apd-th apd-th--c apd-th--sorted" role="columnheader">#</div>
            <div className="apd-th" role="columnheader">Name</div>
            {multiArtist && <div className="apd-th" role="columnheader">Artist</div>}
            <div className="apd-th apd-th--r" role="columnheader">Plays</div>
            <div className="apd-th apd-th--c" role="columnheader">Star</div>
            <div className="apd-th apd-th--r" role="columnheader">Time</div>
          </div>
          {tracks.map((track, idx) => {
            const isPlaying = pb.nowPlaying?.id === track.id
            const isSelected = lib.selectedTrackIds.has(track.id)
            const starred = (Number(track.rating) || 0) > 0
            return (
              <div
                key={track.id}
                data-row-idx={idx}
                role="row"
                aria-selected={isSelected}
                className={`apd-row${idx % 2 ? ' apd-row--alt' : ''}${isPlaying ? ' apd-row--playing' : ''}${isSelected ? ' apd-row--selected' : ''}`}
                style={{ gridTemplateColumns: cols }}
                onClick={(e) => handleClick(track.id, idx, e)}
                onDoubleClick={() => handleDoubleClick(idx)}
                onMouseEnter={() => prefetchTrackForPlay(track)}
                onMouseDown={() => prefetchTrackImmediate(track)}
                onContextMenu={(e) => handleContextMenu(e, track, idx)}
                draggable
                onDragStart={(e) => handleRowDragStart(track, e)}
              >
                <div className="apd-td apd-td--c apd-td--num">{isPlaying ? <SpeakerPlayingIcon /> : (track.trackNumber || idx + 1)}</div>
                <div className="apd-td apd-td--name">
                  {track.audioMissing && <span className="songs-cell-missing-badge" title="Audio file missing — re-import to restore playback." aria-label="Audio file missing">!</span>}
                  <span className="apd-name-text">{track.title || ''}</span>
                </div>
                {multiArtist && <div className="apd-td apd-td--artist">{track.artist || ''}</div>}
                <div className="apd-td apd-td--r apd-td--dim">{playsEverywhere(track, elsewhere)}</div>
                <div className="apd-td apd-td--c">
                  <button
                    type="button"
                    className={`apd-star${starred ? ' apd-star--on' : ''}`}
                    onClick={(e) => { e.stopPropagation(); handleRatingChange(track.id, starred ? 0 : 5) }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title={starred ? 'Unstar' : 'Star'}
                    aria-label={starred ? 'Unstar' : 'Star'}
                    aria-pressed={starred}
                  >
                    <svg width="12" height="12" viewBox="0 0 10 10" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" aria-hidden="true">
                      <polygon points="5,1 6.2,3.8 9.5,4.1 7.1,6.2 7.9,9.5 5,7.8 2.1,9.5 2.9,6.2 0.5,4.1 3.8,3.8" />
                    </svg>
                  </button>
                </div>
                <div className="apd-td apd-td--r apd-td--time">{formatDuration(track.duration)}</div>
              </div>
            )
          })}
        </div>

        {/* The Music Man's take — his opinion, kept apart from the
            factual history. Under the songs: the songs come first (Jake
            2026-10-30). Read all un-clamps it when it runs long. */}
        <section className="apd-take" aria-label="The Music Man’s take">
          <div className="apd-take-mark" aria-hidden="true">{ICON_NOTE}</div>
          <h4 className="apd-take-title">The Music Man’s take</h4>
          {take && (takeOverflows || takeExpanded) ? (
            <button
              type="button"
              className={`apd-take-more${takeExpanded ? ' is-open' : ''}`}
              onClick={() => setTakeExpanded((v) => !v)}
              aria-expanded={takeExpanded}
            >
              {takeExpanded ? 'Show less' : 'Read all'}
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 3l2 2 2-2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
            </button>
          ) : <span />}
          {take && <p ref={takeRef} className={`apd-take-text${takeExpanded ? ' is-open' : ''}`}>{take}</p>}
          {!take && takeLoading && <p className="apd-take-status">The Music Man’s mulling it over…</p>}
          {!take && !takeLoading && takeError && <p className="apd-take-status">Couldn’t get his take right now.</p>}
        </section>
      </div>

      <div className="apd-statusbar">
        <span className="apd-statusbar-hint">Double-click a song to play from there · right-click for the full song menu</span>
        <span className="apd-statusbar-total">{tracks.length} song{tracks.length === 1 ? '' : 's'}, {totalClock(totalMs)} total time</span>
        <span aria-hidden="true" />
      </div>

      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={getContextMenuItems()} onClose={() => setCtxMenu(null)} />}
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
      {getInfoState && (
        <GetInfoModal
          tracks={getInfoState.tracks}
          allTracks={getInfoState.allTracks ?? tracks}
          initialIndex={getInfoState.index}
          artworkMap={lib.artworkMap}
          onClose={() => setGetInfoState(null)}
          onSave={handleGetInfoSave}
          onFetchArt={handleFetchArt}
          onSetCustomArt={handleSetCustomArt}
        />
      )}
      {deleteConfirm && (
        <ConfirmDialog
          message={deleteConfirm.count === 1 ? 'Are you sure you want to delete this song from your library?' : `Are you sure you want to delete ${deleteConfirm.count} songs from your library?`}
          detail="This will remove them from all playlists. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => { libDispatch({ type: 'DELETE_TRACKS', ids: deleteConfirm.ids }); setDeleteConfirm(null) }}
          onCancel={() => setDeleteConfirm(null)}
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

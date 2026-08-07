import { useCallback, useMemo, useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio, prefetchTrackForPlay, prefetchTrackImmediate } from '../hooks/useAudio'
import { useCynthia } from '../context/CynthiaContext'
import { toCynthiaTrack } from '../utils/cynthia'
import { albumKeyOf } from '../utils/albumKey'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { canonicalArtist } from '../utils/artistAlias'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import { albumCreditReleaseDate } from '../utils/albumReleaseDate'
import { albumDetailBackLabel } from '../utils/albumBackLabel'
import { useNavigation } from '../context/NavigationContext'
import { lookupArtwork, buildNormalizedArtworkIndex, clearArtworkNegativeCache } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumArtImage from '../components/AlbumArtImage'
import { ratingMenuEntries } from '../components/StarRating'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import { downloadMenuEntries } from '../utils/downloadStore'
import GetInfoModal from '../components/GetInfoModal'
import ConfirmDialog from '../components/ConfirmDialog'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import { setNotice } from '../activity'
// V5 Live Concert Mode — declared-set store + declare orchestration.
import { subscribeLiveSets, getLiveSetsSnapshot, ensureLiveSetsLoaded, liveSetFor, unregisterLiveSet, cueAt, promoteTrackToLibrary } from '../liveSets'
import { attachConcert, detachConcert, subscribeConcertCrowd, isConcertCrowdEnabled, setConcertCrowdEnabled } from '../concertCrowd'
import { declareLiveSet, isDeclareInFlight } from '../liveSetDeclare'
import { verifyLiveSetCompleteness } from '../utils/liveSetCompleteness'
import type { Track, LiveSetCue } from '../types'
import '../styles/songs.css'
import '../styles/album-page.css'
import { addToPlaylistEntry } from '../utils/playlistMenu'

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

// Album tracklist — #, name, duration only.
const GRID_COLS = '40px minmax(0, 1fr) 52px'

export default function AlbumDetailView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack, seek } = useAudio()
  const { openCynthia } = useCynthia()

  const albumKeyRef = useRef<string>('')
  if (lib.pendingAlbumKey) albumKeyRef.current = lib.pendingAlbumKey
  const albumKey = albumKeyRef.current || lib.pendingAlbumKey || ''
  // Page memory, per album — reopening the same record lands where you left.
  const tracklistRef = useRef<HTMLDivElement>(null)
  useScrollPersistence(`album-detail:${albumKey}`, tracklistRef)

  const { canGoBack, goBack: navBack } = useNavigation()
  const returnView = lib.albumDetailReturnView || 'albums'
  const backLabel = albumDetailBackLabel(lib.albumDetailReturnView)
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

  const [blurbExpanded, setBlurbExpanded] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; idx: number } | null>(null)
  // Right-click a setlist song → reimport that one track into the regular
  // library (promote). The concert stays intact; only that song re-appears.
  const [cueCtx, setCueCtx] = useState<{ x: number; y: number; cue: LiveSetCue } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)
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
  const playLiveSet = useCallback(() => {
    if (mergedTrack) playTrack(mergedTrack, [mergedTrack], 0, undefined, true)
  }, [mergedTrack, playTrack])
  const handleUndeclare = useCallback(async () => {
    if (!liveSet) return
    // Identity-gated: only the exact merged track id recorded at declare
    // time is ever deleted. save-library's existing unlink path (with its
    // UNLINK_CAP guard) removes the audio file; originals are untouched
    // by construction.
    libDispatch({ type: 'DELETE_TRACKS', ids: [liveSet.mergedTrackId] })
    await unregisterLiveSet(albumKey)
    setUndeclareConfirm(false)
    setNotice('Live Mode undeclared — the individual tracks are unchanged')
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
  const seekToCue = useCallback((cue: LiveSetCue) => {
    if (!liveSet) return
    if (setPlaying && liveSet.totalDurationMs > 0) {
      seek(cue.startMs / liveSet.totalDurationMs)
    } else {
      playLiveSet()
    }
  }, [liveSet, setPlaying, seek, playLiveSet])

  // Factual credits (MusicBrainz + iTunes) and the Music Man blurb. Both
  // fetched per-album, fail-soft (sections just stay hidden on error).
  const [credits, setCredits] = useState<{ released?: string; label?: string; producer?: string; recorded?: string } | null>(null)
  const [blurb, setBlurb] = useState<string>('')
  const [infoLoading, setInfoLoading] = useState(false)
  const [infoError, setInfoError] = useState(false)
  const [blurbOverflows, setBlurbOverflows] = useState(false)
  // The Music Man's take — opt-in opinion, lazily fetched when the user opens it.
  const [take, setTake] = useState<string>('')
  const [takeOpen, setTakeOpen] = useState(false)
  const [takeLoading, setTakeLoading] = useState(false)
  const [takeError, setTakeError] = useState(false)

  const lastClickedIdx = useRef<number>(-1)
  const blurbRef = useRef<HTMLParagraphElement>(null)

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
  }, [tracks, libDispatch])

  const handleDoubleClick = useCallback((idx: number) => {
    window.getSelection()?.removeAllRanges()
    const track = tracks[idx]
    if (track) playTrack(track, tracks, idx, undefined, true)
  }, [tracks, playTrack])

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
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: selectedTracks }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: selectedTracks }) },
      addToPlaylistEntry(selectedTracks, lib.playlists, (pid, ids) => libDispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
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

  useEffect(() => {
    if (tracks.length === 0) return
    let cancelled = false
    setCredits(null); setBlurb(''); setInfoLoading(true); setInfoError(false); setBlurbExpanded(false); setBlurbOverflows(false)
    setTake(''); setTakeOpen(false); setTakeLoading(false); setTakeError(false)
    const timer = window.setTimeout(() => {
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

  // Lazily fetch the Music Man's take the first time the user opens it.
  const handleToggleTake = useCallback(() => {
    if (!takeOpen && !take && !takeLoading) {
      setTakeLoading(true); setTakeError(false)
      window.electronAPI.getAlbumTake?.(albumArtist, albumName, String(year || ''))
        .then((r) => { if (r?.ok && r.take) setTake(r.take); else setTakeError(true) })
        .catch(() => setTakeError(true))
        .finally(() => setTakeLoading(false))
    }
    setTakeOpen((v) => !v)
  }, [takeOpen, take, takeLoading, albumArtist, albumName])

  // Show Read more / Show less only when the 3-line clamp actually hides text.
  useEffect(() => {
    if (!blurb || isWeakBlurb(blurb) || blurbExpanded) return
    const el = blurbRef.current
    if (!el) return
    const check = () => {
      setBlurbOverflows(el.scrollHeight > el.clientHeight + 1)
    }
    check()
    const raf = requestAnimationFrame(check)
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [blurb, blurbExpanded])

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

  if (tracks.length === 0) {
    return (
      <div className="album-page album-page--empty">
        <div className="album-page-topbar">
          <button type="button" className="album-page-back" onClick={goBack}>{backLabel}</button>
        </div>
        <p className="album-page-notfound">That album isn't in your library anymore.</p>
      </div>
    )
  }

  const hasCredits = credits && (credits.released || credits.label || credits.producer || credits.recorded)

  const releaseDisplay = albumCreditReleaseDate(year, credits?.released)

  const creditLine = hasCredits
    ? [
        releaseDisplay && `Released ${releaseDisplay}`,
        credits!.label && credits!.label,
        credits!.producer && `Produced by ${credits!.producer}`,
      ].filter(Boolean).join(' · ')
    : ''

  if (!pageReady) {
    return (
      <div className="album-page">
        <div className="page-gate" role="status" aria-label="Loading">
          <div className="page-gate-name">{albumName}</div>
          <div className="page-gate-bar"><span /></div>
        </div>
      </div>
    )
  }

  return (
    <div className="album-page">
      <div className="album-page-topbar">
        <button type="button" className="album-page-back" onClick={goBack}>{backLabel}</button>
        {siblingAlbums.length > 1 && curIdx >= 0 && (
          <div className="album-page-flip" title={`${albumArtist} — album ${curIdx + 1} of ${siblingAlbums.length}`}>
            <button
              type="button"
              className="album-page-flip-btn"
              disabled={!prevAlbum}
              onClick={() => prevAlbum && libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: prevAlbum.key })}
              title={prevAlbum ? `Newer: ${prevAlbum.name}${prevAlbum.year ? ` (${prevAlbum.year})` : ''}` : 'Newest album'}
              aria-label="Newer album"
            >‹</button>
            <span className="album-page-flip-pos">{curIdx + 1} / {siblingAlbums.length}</span>
            <button
              type="button"
              className="album-page-flip-btn"
              disabled={!nextAlbum}
              onClick={() => nextAlbum && libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: nextAlbum.key })}
              title={nextAlbum ? `Older: ${nextAlbum.name}${nextAlbum.year ? ` (${nextAlbum.year})` : ''}` : 'Oldest album'}
              aria-label="Older album"
            >›</button>
          </div>
        )}
      </div>
      <div className="album-page-hero">
        <div className="album-page-cover">
          {artHash
            ? <AlbumArtImage hash={artHash} alt={albumName} priority />
            : <div className="album-page-cover-placeholder">♫</div>}
        </div>
        <div className="album-page-meta">
          <div
            className={`album-page-artist${albumArtist ? ' album-page-artist--link' : ''}`}
            onClick={albumArtist ? () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: albumArtist }) : undefined}
            role={albumArtist ? 'button' : undefined}
            title={albumArtist ? `Go to ${albumArtist}` : undefined}
          >{albumArtist}</div>
          <h1 className="album-page-title">{albumName}</h1>
          <div className="album-page-facts">
            {[year && String(year), `${tracks.length} song${tracks.length === 1 ? '' : 's'}`, formatTotalDuration(totalMs), genre].filter(Boolean).join(' · ')}
          </div>
          <div className="album-page-actions">
            <button type="button" className="album-page-play" onClick={() => playTrack(tracks[0], tracks, 0, undefined, true)}>▶ Play</button>
            <button type="button" className="album-page-shuffle" onClick={() => { const s = tracks.slice().sort(() => Math.random() - 0.5); if (s.length) playTrack(s[0], s, 0, undefined, true) }}>⤮ Shuffle</button>
            {/* V5 Live Concert Mode — declare / play-set / undeclare.
                Declaring is allowed IF AND ONLY IF the album is complete
                (every track present, verified against declared counts). */}
            {!isLiveSetAlbumPage && (liveSet && mergedTrack ? (
              <>
                <button type="button" className="album-page-play album-page-liveset-play" onClick={playLiveSet} title="Play the whole show as one continuous set">♪ Play Live Set</button>
                <button
                  type="button"
                  className={`album-page-shuffle album-page-liveset-crowd${crowdOn ? ' album-page-liveset-crowd--on' : ''}`}
                  onClick={() => setConcertCrowdEnabled(!crowdOn)}
                  title="Swell that night's crowd in the gaps between songs — off by default"
                >
                  {crowdOn ? '◉ Crowd on' : '◎ Crowd'}
                </button>
                <button type="button" className="album-page-shuffle album-page-liveset-undeclare" onClick={() => setUndeclareConfirm(true)} title="Delete the merged set file (individual tracks unaffected)">Undeclare Live Mode</button>
              </>
            ) : (
              <button
                type="button"
                className="album-page-shuffle album-page-liveset-declare"
                onClick={handleDeclare}
                disabled={mergeBusy || !completeness.complete}
                title={!completeness.complete
                  ? `Live Mode needs the complete album — ${completeness.reason}`
                  : completeness.verifiedTotal
                    ? "Copy + merge this album's tracks into one continuous live set"
                    : "The files can't confirm the total — you'll be asked to confirm the show is complete"}
              >
                {mergeBusy ? (mergeLabel || 'Merging…') : 'Declare Live Concert Mode'}
              </button>
            ))}
          </div>
          {!isLiveSetAlbumPage && !liveSet && !completeness.complete && (
            <div className="album-page-liveset-blocked">
              Live Mode needs the complete album — {completeness.reason}
            </div>
          )}
          {creditLine && <div className="album-page-creditline">{creditLine}</div>}
          {infoLoading && !blurb && !creditLine && (
            <p className="album-page-loading">Loading album history…</p>
          )}
          {infoError && !infoLoading && !blurb && !creditLine && (
            <p className="album-page-loading">Couldn&apos;t load album info.</p>
          )}
        </div>
      </div>

      {blurb && !isWeakBlurb(blurb) && (
        <div className={`album-page-about ${blurbExpanded ? 'album-page-about--expanded' : ''}`}>
          <p ref={blurbRef} className="album-page-blurb">{blurb}</p>
          {blurbOverflows && (
            <button
              type="button"
              className="album-page-blurb-toggle"
              onClick={() => setBlurbExpanded((v) => !v)}
            >
              {blurbExpanded ? 'Show less' : 'Read more'}
            </button>
          )}
        </div>
      )}

      {/* The Music Man's take — opt-in opinion, separate from the factual
          history above. Collapsed by default; his voice lives behind a click. */}
      <div className="album-page-take">
        <button
          type="button"
          className={`album-page-take-toggle ${takeOpen ? 'is-open' : ''}`}
          onClick={handleToggleTake}
          aria-expanded={takeOpen}
        >
          <span className="album-page-take-icon" aria-hidden="true">♪</span>
          The Music Man’s take
          <span className="album-page-take-caret" aria-hidden="true">›</span>
        </button>
        {takeOpen && (
          <div className="album-page-take-body">
            {takeLoading && !take && <p className="album-page-take-status">The Music Man’s mulling it over…</p>}
            {take && <p className="album-page-take-text">{take}</p>}
            {takeError && !take && <p className="album-page-take-status">Couldn’t get his take right now.</p>}
          </div>
        )}
      </div>

      {/* V5 Live Concert Mode — the set list. Active song highlights while
          the merged set plays; clicking jumps the playing set to that song
          (or starts the set from the top when it isn't playing). */}
      {liveSet && mergedTrack && (
        <div className="album-page-setlist">
          <div className="album-page-setlist-head">
            <span className="album-page-setlist-title">Set List</span>
            <span className="album-page-setlist-sub">
              {liveSet.cues.length} songs · {formatTotalDuration(liveSet.totalDurationMs)} continuous
              {setPlaying && activeCue ? ` · now: ${activeCue.index + 1}/${liveSet.cues.length}` : ''}
            </span>
          </div>
          {liveSet.cues.map((cue, i) => {
            const inLibrary = (liveSet.promotedTrackIds || []).includes(cue.trackId)
            return (
            <div
              key={`${cue.trackId}-${i}`}
              className={`album-page-setlist-row${activeCue && activeCue.index === i ? ' album-page-setlist-row--active' : ''}${activeCue && i < activeCue.index ? ' album-page-setlist-row--played' : ''}${inLibrary ? ' album-page-setlist-row--in-library' : ''}`}
              onClick={() => seekToCue(cue)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCueCtx({ x: e.clientX, y: e.clientY, cue }) }}
              title={setPlaying ? `Jump to "${cue.title}"` : 'Play the live set — right-click a song to add it to your library'}
              role="button"
            >
              <span className="album-page-setlist-num">{i + 1}</span>
              <span className="album-page-setlist-name">{cue.title}</span>
              {inLibrary && <span className="album-page-setlist-inlib" title="In your library">✓</span>}
              <span className="album-page-setlist-time">{formatDuration(cue.durationMs)}</span>
            </div>
            )
          })}
        </div>
      )}

      <div className="album-page-tracklist songs-view" ref={tracklistRef}>
        <div className="songs-header" style={{ gridTemplateColumns: GRID_COLS }}>
          <div className="songs-header-cell" style={{ textAlign: 'center', justifyContent: 'center' }}>#</div>
          <div className="songs-header-cell">Name</div>
          <div className="songs-header-cell">Time</div>
        </div>
        <div className="album-page-track-body">
        {tracks.map((track, idx) => {
          const isPlaying = pb.nowPlaying?.id === track.id
          const isSelected = lib.selectedTrackIds.has(track.id)
          const starred = (Number(track.rating) || 0) > 0
          return (
            <div
              key={track.id}
              className={`songs-row ${idx % 2 ? 'songs-row--alt' : ''} ${isPlaying ? 'songs-row--playing' : ''} ${isSelected ? 'songs-row--selected' : ''}`}
              style={{ gridTemplateColumns: GRID_COLS }}
              onClick={(e) => handleClick(track.id, idx, e)}
              onDoubleClick={() => handleDoubleClick(idx)}
              onMouseEnter={() => prefetchTrackForPlay(track)}
              onMouseDown={() => prefetchTrackImmediate(track)}
              onContextMenu={(e) => handleContextMenu(e, track, idx)}
              draggable
              onDragStart={(e) => handleRowDragStart(track, e)}
            >
              <div className="songs-cell songs-cell--icon">{isPlaying ? <SpeakerPlayingIcon /> : <span className="album-page-tracknum">{track.trackNumber || idx + 1}</span>}</div>
              <div className="songs-cell songs-cell--title">
                {track.audioMissing && <span className="songs-cell-missing-badge" title="Audio file missing — re-import to restore playback." aria-label="Audio file missing">!</span>}
                <span className="title-row-text">{track.title || ''}</span>
                <button
                  className={`title-row-star ${starred ? 'title-row-star--filled' : ''}`}
                  onClick={(e) => { e.stopPropagation(); handleRatingChange(track.id, starred ? 0 : 5) }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={starred ? 'Unstar' : 'Star'}
                  aria-label={starred ? 'Unstar' : 'Star'}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill={starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round">
                    <polygon points="5,1 6.2,3.8 9.5,4.1 7.1,6.2 7.9,9.5 5,7.8 2.1,9.5 2.9,6.2 0.5,4.1 3.8,3.8" />
                  </svg>
                </button>
              </div>
              <div className="songs-cell songs-cell--time">{formatDuration(track.duration)}</div>
            </div>
          )
        })}
        </div>
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
          allTracks={tracks}
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
        <ConfirmDialog
          message={`Undeclare Live Mode for "${albumName}"?`}
          detail="The merged live-set file will be deleted. The individual tracks are not affected — they stay exactly as they always were."
          confirmLabel="Undeclare"
          onConfirm={() => { void handleUndeclare() }}
          onCancel={() => setUndeclareConfirm(false)}
        />
      )}
      {completenessConfirm && completeness.complete && (
        <ConfirmDialog
          message={`Is this the complete show?`}
          detail={`The files don't declare the album's total track count, so it can't be verified automatically. What's here checks out: ${completeness.total} tracks, numbered with no gaps or duplicates. Only declare Live Mode if this is every track of the show.`}
          confirmLabel="It's complete — merge"
          onConfirm={() => { setCompletenessConfirm(false); void runDeclare(true) }}
          onCancel={() => setCompletenessConfirm(false)}
        />
      )}
    </div>
  )
}

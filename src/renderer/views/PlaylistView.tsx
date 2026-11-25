import { useState, useRef, useEffect, useCallback, useMemo, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { Track } from '../types'
import { PlaylistQuickAdd } from '../components/PlaylistQuickAdd'
import { MAX_TAPE_SONGS } from '../../common/tape-physics'
import MixArtwork from '../components/MixArtwork'
import MixtapeSheet from '../components/MixtapeSheet'
import {
  subscribePlaylistCovers, getPlaylistCovers, ensurePlaylistCoversLoaded,
  playlistCoverSrc, pickPlaylistCover, clearPlaylistCover,
  ensurePlaylistNotesLoaded, getPlaylistNote, setPlaylistNote,
} from '../playlistCovers'
import { suggestForPlaylist, suggestFromVibeHits, nextStrip, suggestableOn } from '../utils/playlistSuggest'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import AlbumArtImage from '../components/AlbumArtImage'
import { CloseIcon } from '../components/TransportIcons'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../utils/artworkLookup'
import ConfirmDialog from '../components/ConfirmDialog'
import TrackGridView from '../components/TrackGridView'
import CoverFlowView from './CoverFlowView'
import { useViewMode } from '../context/ViewModeContext'
import SongTable, { type SongTableRemoval } from '../components/SongTable'
import { useListSort } from '../hooks/useListSort'
import { filterSongs, moveRows, removedFromListNotice, sortSongs } from '../utils/songTableRules'
import { usePlaysElsewhere } from '../playsElsewhere'
import '../styles/songs.css'

/** How long a suggestion strip must stay unchanged before it counts as shown. */
const STRIP_SETTLE_MS = 1500

/**
 * One of Jake's playlists. Its own look sits above the songs (the cover, the
 * name, the description, the suggestion strip); the songs are the one song
 * table (components/SongTable.tsx, V7). What is a playlist's own in the table:
 * Delete takes songs out of the playlist with Undo (never from the library),
 * rows drag to reorder in the playlist's own order, and the menu adds Make a
 * Mixtape and Remove from Playlist.
 */
export default function PlaylistView() {
  const { state, dispatch } = useLibrary()
  // 2026-10-20 — Plays sorts by the count everywhere (phone + workmini too).
  const elsewhere = usePlaysElsewhere()
  const { playTrack } = useAudio()
  const { mode: viewMode } = useViewMode()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [confirmAction, setConfirmAction] = useState<{ type: 'delete-playlist' } | null>(null)

  const playlist = state.playlists.find(p => p.id === state.activePlaylistId)

  // Custom playlist cover (2026-08-09). State lives in playlistCovers.ts —
  // a module store, because LibraryContext is do-not-touch.
  useSyncExternalStore(subscribePlaylistCovers, getPlaylistCovers)
  useEffect(() => { ensurePlaylistCoversLoaded() }, [])
  // Description Jake typed (2026-08-09). Falls back to any commentary a
  // generated playlist arrived with; his text always wins.
  useEffect(() => { ensurePlaylistNotesLoaded() }, [])
  const [descEditing, setDescEditing] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const savedNote = getPlaylistNote(playlist?.id ?? '')
  const shownDesc = savedNote || playlist?.commentary || ''
  const commitDesc = async (): Promise<void> => {
    if (!playlist) return
    setDescEditing(false)
    if (descDraft.trim() !== savedNote) await setPlaylistNote(playlist.id, descDraft)
  }

  // Tracks handed to the mixtape sheet — null when it's closed.
  const [mixtapeFrom, setMixtapeFrom] = useState<Track[] | null>(null)
  const [coverBusy, setCoverBusy] = useState(false)
  const [confirmDropCover, setConfirmDropCover] = useState(false)
  const [coverNote, setCoverNote] = useState('')
  const customCover = playlistCoverSrc(playlist?.id ?? '')
  const chooseCover = async (): Promise<void> => {
    if (!playlist || coverBusy) return
    setCoverBusy(true)
    const err = await pickPlaylistCover(playlist.id)
    setCoverBusy(false)
    if (err) { setCoverNote(err); setTimeout(() => setCoverNote(''), 8000) }
  }
  const dropCover = async (): Promise<void> => {
    if (!playlist || coverBusy) return
    setCoverBusy(true)
    await clearPlaylistCover(playlist.id)
    setCoverBusy(false)
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  // 2026-08-08 — suggestions must draw from the REGULAR library. A declared
  // concert's constituent songs are hidden everywhere else, but the strip was
  // reading raw state.tracks, so a Dead setlist cue turned up as a standalone
  // suggestion (Jake: "this track is apart of a live set why is it a seperate
  // thing"). The playlist's OWN tracks still resolve from the full map — a
  // tape or playlist that legitimately holds a concert track keeps working.
  const suggestPool = useRegularLibraryTracks(state.tracks)

  const trackMap = useMemo(() => new Map(state.tracks.map(t => [t.id, t])), [state.tracks])
  const allPlaylistTracks = useMemo(() => (playlist
    ? playlist.trackIds.map(id => trackMap.get(id)).filter((t): t is Track => t !== undefined)
    : []), [playlist, trackMap])

  // The "This page" search — the table's own filter (utils/songTableRules.ts).
  const tracks = useMemo(() => filterSongs(allPlaylistTracks, state.searchQuery), [allPlaylistTracks, state.searchQuery])

  // 4.5: brain-driven suggestions strip — the tracks most similar to this
  // playlist's actual songs (vibe match), filtered for fresh artists + no
  // same-album repeats. Replaces the old artist/genre string-match that just
  // surfaced more songs by the artists already on the playlist.
  const [suggestRotate, setSuggestRotate] = useState(0)
  const [vibeHits, setVibeHits] = useState<Array<{ trackId: number; score: number; cluster: number }>>([])
  const [vibeClusterSeeds, setVibeClusterSeeds] = useState<number[]>([])
  // Which playlist the hits were fetched for (2026-11-03): right after a
  // switch they still belong to the last one, and the strip must not keep a
  // row built from them (keepStripSteady below).
  const [vibeHitsPid, setVibeHitsPid] = useState<string | undefined>(undefined)
  // Taste-ledger loop: learned per-playlist blend weights + the diag map
  // (each shown candidate's blend components) that verdict events carry.
  const [tasteWeights, setTasteWeights] = useState<Record<string, { vibe?: number; genre?: number; taste?: number; era?: number }>>({})
  const suggestDiag = useRef(new Map<number, { vn: number; g: number; b: number; ta: number; e: number }>())
  useEffect(() => {
    void window.electronAPI.getTasteWeights?.().then((r) => {
      // v2 (2026-10-19) also carries a GLOBAL setting learned from every
      // playlist pooled; a playlist the learner hasn't seen uses it.
      const w = r?.weights as { playlists?: Record<string, { vibe?: number; genre?: number; taste?: number; era?: number }>; global?: { vibe?: number; genre?: number; taste?: number; era?: number } }
      if (w?.playlists || w?.global) setTasteWeights({ ...(w.global ? { '*': w.global } : {}), ...(w.playlists ?? {}) })
    })
  }, [])
  // The nightly taste engine's learned percentile per song — only present
  // while its ranking is promoted and fresh (src/main/taste-state.ts).
  const [learnedTaste, setLearnedTaste] = useState<Map<number, number> | undefined>(undefined)
  useEffect(() => {
    void window.electronAPI.getTasteState?.().then((r) => {
      if (r?.usable && r.pct) setLearnedTaste(new Map(Object.entries(r.pct).map(([id, v]) => [Number(id), v])))
    })
  }, [])
  // The Top 1000 Quiz's standings (src/main/top1000-scores.ts): his own verdicts, 1 = the
  // song he loves most. Leads the strip's taste term when present.
  const [quizLove, setQuizLove] = useState<Map<number, number> | undefined>(undefined)
  useEffect(() => {
    void window.electronAPI.getTop1000Scores?.().then((r) => {
      if (r?.usable && r.pct) setQuizLove(new Map(Object.entries(r.pct).map(([id, v]) => [Number(id), v])))
    })
  }, [])
  const ledger = (events: Array<{ surface: string; verdict: string; key?: Record<string, unknown>; ctx?: Record<string, unknown> }>) => {
    void window.electronAPI.tasteLedgerAppend?.(events)
  }
  useEffect(() => { setSuggestRotate(0) }, [state.activePlaylistId])
  // What the strip remembers for this playlist (src/common/strip-memory.ts):
  // ✕'d, taken-back, or refreshed-past-twice songs stay off it; the ✕'d and
  // taken-back ones also steer the brain away from near-copies (negatives).
  // `stripMemTick` re-reads it after this view writes a verdict.
  const [stripMem, setStripMem] = useState<{ hidden: Set<number>; negatives: number[] }>({ hidden: new Set(), negatives: [] })
  const [stripMemTick, setStripMemTick] = useState(0)
  const [localHidden, setLocalHidden] = useState<Set<number>>(new Set())
  useEffect(() => { setLocalHidden(new Set()) }, [state.activePlaylistId])
  useEffect(() => {
    let cancelled = false
    const pid = playlist?.id
    if (!pid || !window.electronAPI.stripMemory) { setStripMem({ hidden: new Set(), negatives: [] }); return }
    void window.electronAPI.stripMemory(pid, playlist?.trackIds ?? []).then((r) => {
      if (!cancelled && r?.ok) setStripMem({ hidden: new Set(r.hidden), negatives: r.negatives })
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activePlaylistId, (playlist?.trackIds ?? []).join(','), stripMemTick])
  const stripHidden = useMemo(() => new Set([...stripMem.hidden, ...localHidden]), [stripMem, localHidden])
  // Re-fetch whenever the playlist's MEMBERSHIP changes — adding a song (the +,
  // or manually), removing one, or swapping one for another all re-center the
  // suggestions. Keyed on the full trackIds content: NOT the search-filtered
  // `tracks` (suggestions are for the whole playlist), and NOT just length (a
  // same-size swap must still recompute). ↻ then re-pages this pool locally.
  const plMembershipKey = (playlist?.trackIds ?? []).join(',')
  // The playlist's NAME and DESCRIPTION are clues too (2026-09-04) — the brain
  // embeds them and gives the best text matches their own strip seat. Renaming
  // or editing the description re-fetches, same as a membership change.
  const plHint = playlist ? `${playlist.name}${shownDesc ? `. ${shownDesc}` : ''}` : ''
  useEffect(() => {
    let cancelled = false
    const ids = playlist?.trackIds ?? []
    if (ids.length === 0) { setVibeHits([]); setVibeHitsPid(playlist?.id); return }
    // This playlist's strip memory rides into the pool fetch (hidden songs
    // leave before the pool cut; ✕'d/taken-back ones steer away). Read fresh
    // here, never from state: on a playlist switch the state still holds the
    // previous playlist's memory. A ✕ mid-visit only swaps its own chip out
    // (localHidden) — no re-fetch, so the strip never reshuffles a beat later.
    const pid = playlist?.id
    const memP = pid && window.electronAPI.stripMemory
      ? window.electronAPI.stripMemory(pid, ids).then((m) => (m?.ok ? { hidden: m.hidden, negatives: m.negatives } : undefined), () => undefined)
      : Promise.resolve(undefined)
    memP.then((mem) => window.electronAPI.playlistSimilar(ids, 5, plHint, mem))
      .then(r => {
        if (cancelled) return
        setVibeHits(r.ok ? r.hits : [])
        setVibeClusterSeeds(r.ok ? (r.clusterSeeds ?? []) : [])
        setVibeHitsPid(pid)
      })
      .catch(() => { if (!cancelled) { setVibeHits([]); setVibeClusterSeeds([]) } })
    return () => { cancelled = true }
  }, [state.activePlaylistId, plMembershipKey, plHint])
  const hitsHere = vibeHits.length > 0 && vibeHitsPid === playlist?.id
  // The page's picks, best first, three strips deep: the strip shows the
  // first five, and the rest refill a card he adds or ✕'s.
  const STRIP = 5
  const candidates = useMemo(
    () => {
      suggestDiag.current = new Map()
      return hitsHere
        ? suggestFromVibeHits(allPlaylistTracks, suggestPool, vibeHits, STRIP, suggestRotate, vibeClusterSeeds,
            (playlist ? tasteWeights[playlist.id] ?? tasteWeights['*'] : undefined) ?? {}, suggestDiag.current, stripHidden, learnedTaste, quizLove, STRIP * 3)
        // The fallback draws only from songs the strip may show here (not
        // from an album already on the playlist), the brain path's own rule.
        : suggestForPlaylist(allPlaylistTracks, suggestPool.filter(suggestableOn(allPlaylistTracks, stripHidden)), STRIP, suggestRotate, STRIP * 3)
    },
    [allPlaylistTracks, suggestPool, hitsHere, vibeHits, vibeClusterSeeds, suggestRotate, tasteWeights, playlist, stripHidden, learnedTaste, quizLove],
  )
  // The strip stays put (2026-11-03, Jake: "why is it when i add a song, the
  // whole row refreshes?"). Adding a song re-fetches and re-centres the pool;
  // the cards he didn't touch now keep their slots and only the emptied one
  // takes the next pick (keepStripSteady). A new strip only on ↻, a playlist
  // switch, or when the brain's hits replace the tag-match fallback.
  const stripMemo = useRef<{ key: string; ids: number[] } | null>(null)
  const suggestions = useMemo(() => {
    const key = `${playlist?.id ?? ''}:${suggestRotate}:${hitsHere ? 'vibe' : 'tags'}`
    // nextStrip: steady across re-renders, empty or not (2026-11-08, the
    // Rocksurgence flicker — playlistSuggest.ts has the story).
    const strip = nextStrip(stripMemo.current, key, candidates, suggestPool, suggestableOn(allPlaylistTracks, stripHidden), STRIP)
    stripMemo.current = { key, ids: strip.map((t) => t.id) }
    return strip
  }, [candidates, playlist?.id, suggestRotate, hitsHere, suggestPool, allPlaylistTracks, stripHidden])
  // Every strip the user actually sees is one BATCH: one 'shown' row per
  // suggestion (rank + why it ranked), so the learner can tell an ignored
  // suggestion from one passed over for a neighbour, and acceptance has a
  // real denominator. Since the strip stays put (2026-11-03) a batch is ONE
  // STEADY STRIP: it starts with ↻, a playlist switch, or the brain's pool
  // replacing the fallback, and lasts while cards are refilled in place — so
  // a card passed over while he adds two others is one "skipped", not two
  // (scripts/taste-ledger-learn.py labels every card once per batch).
  const stripKey = `${playlist?.id ?? ''}:${suggestRotate}:${hitsHere ? 'vibe' : 'tags'}`
  const stripSession = useRef<{ key: string; batch: string; logged: Set<number> } | null>(null)
  const suggestBatch = useMemo(() => {
    if (!playlist || suggestions.length === 0) return ''
    const cur = stripSession.current
    if (cur && cur.key === stripKey) return cur.batch
    const batch = `${playlist.id}:${suggestions.map((t) => t.id).join('-')}:${Date.now()}`
    stripSession.current = { key: stripKey, batch, logged: new Set() }
    return batch
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist?.id, stripKey, suggestions.length > 0])
  const shownIds = suggestions.map((t) => t.id).join('-')
  // A card counts as shown only once it has SETTLED on screen (2026-10-19,
  // found on the installed build): opening a playlist passes through
  // placeholder strips inside a second — the metadata fallback while the
  // brain's pool loads, then a re-pick when the strip memory lands — and each
  // was being logged as five impressions the eye never registered. Within a
  // batch each card is logged once, the first time it settles (a refill).
  useEffect(() => {
    const session = stripSession.current
    if (!playlist || !suggestBatch || !session || session.batch !== suggestBatch) return
    const fresh = suggestions.map((sg, rank) => ({ sg, rank })).filter(({ sg }) => !session.logged.has(sg.id))
    if (fresh.length === 0) return
    const rows = fresh.map(({ sg, rank }) => ({
      surface: 'strip', verdict: 'shown',
      key: { trackId: sg.id, playlistId: playlist.id },
      ctx: { ...(suggestDiag.current.get(sg.id) ?? {}), rank, batch: suggestBatch },
    }))
    const t = window.setTimeout(() => {
      for (const { sg } of fresh) session.logged.add(sg.id)
      ledger(rows)
    }, STRIP_SETTLE_MS)
    return () => window.clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestBatch, shownIds])
  const suggestArtIndex = useMemo(() => buildNormalizedArtworkIndex(state.artworkMap), [state.artworkMap])
  const quickAddExclude = useMemo(() => new Set(playlist?.trackIds ?? []), [plMembershipKey])

  // The column sort, remembered per playlist (null = the playlist's own order).
  const [sort, setSort] = useListSort(`playlist:${state.activePlaylistId ?? ''}`)
  const sortedTracks = useMemo(() => sortSongs(tracks, sort, elsewhere), [tracks, sort, elsewhere])

  // Take songs out of THIS playlist — no confirm: the songs stay in the
  // library and the table's Undo puts them back where they were. Never the
  // play queue: what is sounding keeps sounding.
  const removeFromPlaylist = useCallback((songs: Track[]): SongTableRemoval | null => {
    if (!playlist || songs.length === 0) return null
    const trackIds = songs.map((t) => t.id)
    const atIndex = Math.max(0, playlist.trackIds.findIndex(id => trackIds.includes(id)))
    const playlistId = playlist.id
    dispatch({ type: 'REMOVE_TRACKS_FROM_PLAYLIST', playlistId, trackIds })
    return {
      message: removedFromListNotice(trackIds.length, playlist.name),
      undo: () => dispatch({ type: 'RESTORE_TRACKS_TO_PLAYLIST', playlistId, trackIds, atIndex }),
    }
  }, [playlist, dispatch])

  // Drag rows to reorder — in the playlist's own order only (the table offers it then).
  // ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/PlaylistsView.swift
  // PlaylistDetailView.move (Edit → drag handles) — same hub path as rename.
  const reorder = useCallback((ids: number[], beforeId: number | null) => {
    if (!playlist) return
    const order = playlist.trackIds
    const to = beforeId === null ? order.length : order.indexOf(beforeId)
    dispatch({ type: 'REORDER_PLAYLIST', playlistId: playlist.id, trackIds: moveRows(order, ids, to < 0 ? order.length : to) })
  }, [playlist, dispatch])

  // Actually delete / remove the playlist after confirmation
  const executeRemove = useCallback(() => {
    if (!playlist || !confirmAction) return
    if (confirmAction.type === 'delete-playlist') {
      dispatch({ type: 'REMOVE_PLAYLIST', id: playlist.id })
      if (playlist.id.startsWith('mm-')) {
        void window.electronAPI.tasteLedgerAppend?.([{
          surface: 'mm-playlist', verdict: 'reject',
          key: { playlistId: playlist.id },
          ctx: { name: playlist.name },
        }])
      }
    }
    setConfirmAction(null)
  }, [playlist, confirmAction, dispatch])

  if (!playlist) {
    return <div style={{ padding: 24, color: '#999' }}>Playlist not found.</div>
  }

  const totalMs = sortedTracks.reduce((sum, t) => sum + (t.duration || 0), 0)
  const totalMins = Math.floor(totalMs / 60000)
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  const timeStr = hours > 0 ? `${hours} hr ${mins} min` : `${mins} min`

  // ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/PlaylistsView.swift
  // PlaylistDetailView.commitRename (tap the name) — the phone's rename goes
  // to the playlist hub as a newer copy (PATCH /api/playlists/:id), and this
  // Mac adopts it on its next converge (main/playlist-hub-sync.ts).
  const commitRename = () => {
    const trimmed = editName.trim()
    if (trimmed && trimmed !== playlist.name) {
      dispatch({ type: 'RENAME_PLAYLIST', id: playlist.id, name: trimmed })
    }
    setEditing(false)
  }

  return (
    <div className="playlist-view">
      <div className="playlist-view-header">
        {/* Cover — Jake, 2026-08-09: "playlists on desktop need covers....like
            it is on mobile (first 4 songs' album covers or i can upload a
            custom cover)". The default is MixArtwork, which already builds
            the 2x2 of the first four unique album covers using the same rule
            iOS uses, so parity is structural rather than re-implemented.
            Click to choose your own; right-click a custom one to drop back
            to the mosaic. */}
        <button
          type="button"
          className="playlist-view-cover"
          title={customCover ? 'Click to replace this cover · right-click to go back to the album mosaic' : 'Click to choose a cover'}
          onClick={() => { void chooseCover() }}
          onContextMenu={(e) => { e.preventDefault(); if (customCover) setConfirmDropCover(true) }}
        >
          {customCover
            ? <img src={customCover} alt="" className="playlist-view-cover-img" />
            : <MixArtwork tracks={sortedTracks} alt={playlist.name} priority />}
          <span className="playlist-view-cover-hint">{coverBusy ? '…' : 'Cover'}</span>
        </button>
        <div>
          {editing ? (
            <input
              ref={inputRef}
              className="playlist-view-name-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <h2
              className="playlist-view-name playlist-view-name--editable"
              onDoubleClick={() => { setEditName(playlist.name); setEditing(true) }}
              title="Double-click to rename"
            >
              {playlist.name}
            </h2>
          )}
          <div className="playlist-view-meta">{sortedTracks.length} {sortedTracks.length === 1 ? 'song' : 'songs'}, {timeStr}</div>
          {coverNote && <div className="playlist-view-meta">{coverNote}</div>}
        </div>
        <div className="playlist-view-actions">
          <button
            className="playlist-view-play"
            onClick={() => {
              if (sortedTracks.length > 0) playTrack(sortedTracks[0], sortedTracks, 0, undefined, true)
            }}
          >
            Play All
          </button>
          <button
            className="playlist-view-tape"
            onClick={() => setMixtapeFrom(sortedTracks)}
            title={sortedTracks.length > MAX_TAPE_SONGS
              ? `A tape holds ${MAX_TAPE_SONGS} songs — you'll trim it on the deck`
              : 'Turn this playlist into a mixtape'}
          >
            Make a Mixtape
          </button>
          <button
            className="playlist-view-delete"
            onClick={() => setConfirmAction({ type: 'delete-playlist' })}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Click to write or edit. Always present (as a prompt when empty) so
          the ability is discoverable — a description you can only find by
          guessing isn't one. Enter saves, Escape cancels, blur saves. */}
      {descEditing ? (
        <textarea
          className="playlist-view-desc-input"
          autoFocus
          value={descDraft}
          rows={1}
          placeholder="What is this playlist for?"
          onChange={(e) => setDescDraft(e.target.value)}
          onBlur={() => { void commitDesc() }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void commitDesc() }
            if (e.key === 'Escape') { setDescDraft(savedNote); setDescEditing(false) }
          }}
        />
      ) : (
        <div
          className={`playlist-view-commentary${shownDesc ? '' : ' playlist-view-commentary--empty'}`}
          title="Click to write a description"
          onClick={() => { setDescDraft(savedNote); setDescEditing(true) }}
        >
          {shownDesc || 'Add a description…'}
        </div>
      )}
      {playlist && (suggestions.length > 0 || allPlaylistTracks.length === 0) && (
        <div className="pl-suggest">
          <div className="pl-suggest-head">
            <span className="pl-suggest-title">Suggested for This Playlist</span>
            {suggestions.length > 0 && <button
              className="pl-suggest-refresh"
              onClick={() => {
                if (playlist) {
                  ledger(suggestions.map((sg, rank) => ({
                    surface: 'strip', verdict: 'refresh',
                    key: { trackId: sg.id, playlistId: playlist.id },
                    ctx: { ...(suggestDiag.current.get(sg.id) ?? {}), rank, batch: suggestBatch },
                  })))
                }
                setSuggestRotate(r => r + 1)
              }}
              title="Show different suggestions"
              aria-label="More suggestions"
            >↻</button>}
            {/* Quick add — for the songs Jake already has in mind that the
                strip didn't surface. Same ADD_TRACKS_TO_PLAYLIST as the +
                chips; no taste-ledger verdict (it isn't a judgement on a
                suggestion, so it must not train the strip's weights). */}
            <PlaylistQuickAdd
              pool={suggestPool}
              excludeIds={quickAddExclude}
              onAdd={(t) => dispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: playlist.id, trackIds: [t.id] })}
            />
          </div>
          {suggestions.length > 0 && <div className="pl-suggest-row">
            {suggestions.map((s, rank) => {
              const hash = lookupArtwork(state.artworkMap, suggestArtIndex, s.albumArtist || s.artist, s.album)
              return (
                <div key={s.id} className="pl-suggest-chip" title={`${s.title} — ${s.artist}`}>
                  <div className="pl-suggest-art">
                    {hash ? <AlbumArtImage hash={hash} alt="" /> : <span className="pl-suggest-ph">♪</span>}
                    <button
                      type="button"
                      className="pl-suggest-nope"
                      onClick={() => {
                        if (!playlist) return
                        ledger([{ surface: 'strip', verdict: 'reject', key: { trackId: s.id, playlistId: playlist.id }, ctx: { ...(suggestDiag.current.get(s.id) ?? {}), rank, batch: suggestBatch } }])
                        setLocalHidden((h) => new Set(h).add(s.id))
                        setStripMemTick((n) => n + 1)
                      }}
                      title="Not for this playlist"
                      aria-label={`Not for this playlist: ${s.title}`}
                    ><CloseIcon size={12} /></button>
                  </div>
                  <div className="pl-suggest-meta">
                    <div className="pl-suggest-song">{s.title}</div>
                    <div className="pl-suggest-artist">{s.artist}</div>
                  </div>
                  <button
                    className="pl-suggest-add"
                    onClick={() => {
                      if (!playlist) return
                      dispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: playlist.id, trackIds: [s.id] })
                      ledger([{ surface: 'strip', verdict: 'accept', key: { trackId: s.id, playlistId: playlist.id }, ctx: { ...(suggestDiag.current.get(s.id) ?? {}), rank, batch: suggestBatch } }])
                    }}
                    title={`Add "${s.title}" to this playlist`}
                    aria-label={`Add ${s.title}`}
                  >＋</button>
                </div>
              )
            })}
          </div>}
        </div>
      )}
      {/* V5 facelift: Grid / Cover Flow modes swap only the table below
          the playlist header. */}
      {viewMode === 'grid' ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <TrackGridView tracks={sortedTracks} emptyNoun="songs" />
        </div>
      ) : viewMode === 'coverflow' ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <CoverFlowView tracks={sortedTracks} emptyNoun="songs" stateKey={`playlist:${playlist.id}`} />
        </div>
      ) : (
        <SongTable
          listKey={`playlist:${playlist.id}`}
          scrollKey={`playlist:${playlist.id}`}
          tracks={sortedTracks}
          active={state.currentView === 'playlist'}
          sort={sort}
          onSort={setSort}
          onRemove={removeFromPlaylist}
          removeLabel={(n) => (n > 1 ? `Remove ${n} from Playlist` : 'Remove from Playlist')}
          onReorder={reorder}
          menuExtras={(songs) => [{
            // Jake, 2026-08-09: "dont i have the option of turning into a
            // mixtape if i right click?" — the selection's way in; the header
            // button below takes the whole playlist.
            label: songs.length > 1 ? `Make a Mixtape from ${songs.length} songs` : 'Make a Mixtape from this song',
            onClick: () => setMixtapeFrom(songs),
          }]}
        />
      )}
      {confirmDropCover && (
        <ConfirmDialog
          message={`Remove the custom cover from "${playlist.name}"?`}
          detail="The cover goes back to the album mosaic. The picture file itself is not deleted."
          confirmLabel="Remove Cover"
          onConfirm={() => { setConfirmDropCover(false); void dropCover() }}
          onCancel={() => setConfirmDropCover(false)}
        />
      )}
      {confirmAction && confirmAction.type === 'delete-playlist' && (
        <ConfirmDialog
          message={`Delete the playlist "${playlist.name}"?`}
          detail={`This playlist has ${sortedTracks.length} song${sortedTracks.length !== 1 ? 's' : ''}. The songs will remain in your library.`}
          confirmLabel="Delete"
          onConfirm={executeRemove}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {/* The mixtape sheet, opened from either entrance (header button = the
          whole playlist, right-click = the selection). It handles the 25-song
          cap itself: anything past the limit shows greyed on the deck rather
          than vanishing silently. */}
      {mixtapeFrom && mixtapeFrom.length > 0 && (
        // keepOrder: the running order came from a playlist Jake sequenced
        // himself, so it goes on the tape exactly as laid out — Music Man
        // doesn't get to touch it (2026-08-09).
        <MixtapeSheet
          tracks={mixtapeFrom}
          keepOrder
          initialTitle={playlist.name}
          coverFromPlaylistId={playlist.id}
          onClose={() => setMixtapeFrom(null)}
        />
      )}
    </div>
  )
}

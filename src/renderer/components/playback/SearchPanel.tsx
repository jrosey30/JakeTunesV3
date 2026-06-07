import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import { useNavigation } from '../../context/NavigationContext'
import { usePlayback } from '../../context/PlaybackContext'
import { useAudio } from '../../hooks/useAudio'
import { buildIndex, search, normalize, type SearchIndex, type SearchRow, type RankedRow } from '../../utils/searchIndex'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../../utils/artworkLookup'
import AlbumArtImage from '../AlbumArtImage'
import '../../styles/search-panel.css'

/**
 * 4.5: Universal-search panel. Renders as an absolutely-positioned
 * dropdown beneath the SearchPill in the toolbar. Visible whenever
 * the input is focused AND the query is non-empty. Sections: top hit,
 * tracks, albums, artists, playlists. Click a row to navigate:
 *  - track    → playTrack (and queue context = visible tracks)
 *  - album    → VIEW_ALBUM_DETAIL with the album's canonical key
 *  - artist   → VIEW_ARTIST_DETAIL
 *  - playlist → VIEW_PLAYLIST
 *
 * Keyboard nav: ↑/↓ moves selection across all visible rows; ⏎
 * activates; Esc clears query + blurs input. Wired by SearchPill so
 * the input element's events drive panel behaviour without prop
 * drilling.
 */
interface Props {
  query: string
  inputEl: HTMLInputElement | null
  onClose: () => void
}

interface FlatRow extends RankedRow {
  /** Section label for jumpy keyboard nav highlighting. */
  section: 'top' | 'tracks' | 'albums' | 'artists' | 'playlists'
  /** Index within the FLAT visible list — used for ↑/↓ traversal. */
  flatIdx: number
}

function HighlightedText({ text, query }: { text: string; query: string }): JSX.Element {
  if (!query.trim()) return <>{text}</>
  const nText = normalize(text)
  const nQuery = normalize(query)
  if (!nQuery) return <>{text}</>
  const idx = nText.indexOf(nQuery)
  if (idx < 0) return <>{text}</>
  // Best-effort highlight: map normalized index back to display by
  // walking text and skipping non-alphanumeric chars. Good enough for
  // English titles; falls back to no highlight on diacritic-heavy
  // strings (rare).
  let nPos = 0, dStart = -1, dEnd = -1
  for (let i = 0; i < text.length; i++) {
    if (dStart < 0 && nPos === idx) dStart = i
    if (dStart >= 0 && nPos === idx + nQuery.length) { dEnd = i; break }
    const c = text[i].toLowerCase()
    if (/[a-z0-9]/.test(c)) nPos++
    else if (c === ' ' && nPos > 0 && (idx === 0 || nText[nPos - 1] !== ' ')) nPos++
  }
  if (dStart < 0) return <>{text}</>
  if (dEnd < 0) dEnd = text.length
  return (
    <>
      {text.slice(0, dStart)}
      <mark className="search-panel-hit">{text.slice(dStart, dEnd)}</mark>
      {text.slice(dEnd)}
    </>
  )
}

export default function SearchPanel({ query, inputEl, onClose }: Props) {
  const { state: lib, dispatch } = useLibrary()
  const { recordSearch } = useNavigation()
  const { state: pb } = usePlayback()
  const { playTrack } = useAudio()
  const panelRef = useRef<HTMLDivElement>(null)
  const [selectedFlatIdx, setSelectedFlatIdx] = useState(0)

  // Suppress unused-warn; pb is reserved for "now playing" highlight
  // in a follow-up. Kept imported so the future hook is one line away.
  void pb

  // 4.5: index rebuilds when tracks or playlists change. For a 6000-
  // track library this takes ~30-50ms; React's useMemo defers it until
  // the inputs actually shift, so it's effectively free per keystroke.
  const index: SearchIndex = useMemo(
    () => buildIndex(lib.tracks, lib.playlists || []),
    [lib.tracks, lib.playlists]
  )

  // 4.5: artwork lookup index — fault-tolerant normalized fallback so
  // result rows show real cover thumbnails even when stored keys differ
  // from current metadata (parens, diacritics, etc.).
  const normalizedArtIndex = useMemo(
    () => buildNormalizedArtworkIndex(lib.artworkMap),
    [lib.artworkMap]
  )
  const artHashFor = useCallback(
    (artist: string, album: string): string | undefined =>
      lookupArtwork(lib.artworkMap, normalizedArtIndex, artist || '', album || ''),
    [lib.artworkMap, normalizedArtIndex]
  )

  // 4.5: debounce search by 60ms — fast enough to feel live, slow
  // enough that ripping through chars doesn't fire 10 search passes.
  const [debouncedQuery, setDebouncedQuery] = useState(query)
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 60)
    return () => window.clearTimeout(t)
  }, [query])

  const results = useMemo(
    () => search(index, debouncedQuery, { perSectionCap: 6 }),
    [index, debouncedQuery]
  )

  // Build the flat row list used for keyboard navigation. Order
  // matches the visual layout: top hit, then sections in display
  // order. Each row carries its flatIdx so onClick can jump to it.
  const flatRows: FlatRow[] = useMemo(() => {
    const rows: FlatRow[] = []
    let i = 0
    if (results.topHit) rows.push({ ...results.topHit, section: 'top', flatIdx: i++ })
    for (const r of results.tracks) {
      // Don't double-show the top hit in the tracks section
      if (results.topHit && r.row === results.topHit.row) continue
      rows.push({ ...r, section: 'tracks', flatIdx: i++ })
    }
    for (const r of results.albums) {
      if (results.topHit && r.row === results.topHit.row) continue
      rows.push({ ...r, section: 'albums', flatIdx: i++ })
    }
    for (const r of results.artists) {
      if (results.topHit && r.row === results.topHit.row) continue
      rows.push({ ...r, section: 'artists', flatIdx: i++ })
    }
    for (const r of results.playlists) {
      if (results.topHit && r.row === results.topHit.row) continue
      rows.push({ ...r, section: 'playlists', flatIdx: i++ })
    }
    return rows
  }, [results])

  // Reset selection on query change.
  useEffect(() => { setSelectedFlatIdx(0) }, [debouncedQuery])

  const activate = useCallback((row: SearchRow) => {
    if (row.kind === 'track') {
      const t = lib.tracks.find(x => x.id === row.id)
      if (t) {
        // Queue context = all currently visible tracks of the same
        // kind. For now we just play the single match; future polish
        // can pull in adjacent matches as a queue.
        playTrack(t, [t], 0, undefined, true)
      }
    } else {
      // Opening a detail/playlist from a result — remember the search so the
      // first "back" out of it returns to these results (search-as-destination).
      recordSearch(query)
      if (row.kind === 'album') {
        dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: row.key })
      } else if (row.kind === 'artist') {
        dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: row.name })
      } else if (row.kind === 'playlist') {
        dispatch({ type: 'VIEW_PLAYLIST', id: row.id })
      }
    }
    onClose()
  }, [lib.tracks, playTrack, dispatch, onClose, recordSearch, query])

  // Keyboard nav — listens on the bound input so the user can type +
  // navigate without losing focus. The handler captures and stops
  // arrow/enter/esc; everything else passes through to the input.
  useEffect(() => {
    if (!inputEl) return
    const handler = (e: KeyboardEvent) => {
      if (flatRows.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedFlatIdx(i => Math.min(flatRows.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedFlatIdx(i => Math.max(0, i - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const row = flatRows[selectedFlatIdx]
        if (row) activate(row.row)
      }
    }
    inputEl.addEventListener('keydown', handler)
    return () => inputEl.removeEventListener('keydown', handler)
  }, [inputEl, flatRows, selectedFlatIdx, activate])

  // Click-outside dismiss — if user clicks anywhere not in the panel
  // or input, close. (Esc + global keyboard shortcut already handle
  // the keyboard side via the existing app-level Esc binding.)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (inputEl && inputEl.contains(t)) return
      onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [inputEl, onClose])

  if (flatRows.length === 0) {
    return (
      <div className="search-panel search-panel--empty" ref={panelRef}>
        <div className="search-panel-empty-msg">
          No results for "<strong>{query}</strong>"
        </div>
      </div>
    )
  }

  const renderArtThumb = (hash: string | undefined, fallback: string): JSX.Element => {
    if (hash) {
      return (
        <AlbumArtImage
          className="search-panel-row-art"
          hash={hash}
          alt=""
          onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
        />
      )
    }
    return <span className="search-panel-row-art search-panel-row-art--placeholder">{fallback}</span>
  }

  const renderRow = (fr: FlatRow): JSX.Element => {
    const selected = fr.flatIdx === selectedFlatIdx
    const onClick = () => activate(fr.row)
    const baseClass = `search-panel-row search-panel-row--${fr.row.kind} ${selected ? 'search-panel-row--selected' : ''}`
    if (fr.row.kind === 'track') {
      const hash = artHashFor(fr.row.artist, fr.row.album)
      return (
        <button key={`t-${fr.row.id}`} className={baseClass} onClick={onClick}>
          {renderArtThumb(hash, '♪')}
          <span className="search-panel-row-main">
            <span className="search-panel-row-title"><HighlightedText text={fr.row.title} query={query} /></span>
            <span className="search-panel-row-sub">
              <HighlightedText text={fr.row.artist} query={query} />
              {fr.row.album ? <> · <HighlightedText text={fr.row.album} query={query} /></> : null}
            </span>
          </span>
        </button>
      )
    }
    if (fr.row.kind === 'album') {
      const hash = artHashFor(fr.row.artist, fr.row.album)
      return (
        <button key={`al-${fr.row.key}`} className={baseClass} onClick={onClick}>
          {renderArtThumb(hash, '◙')}
          <span className="search-panel-row-main">
            <span className="search-panel-row-title"><HighlightedText text={fr.row.album} query={query} /></span>
            <span className="search-panel-row-sub">
              <HighlightedText text={fr.row.artist} query={query} /> · {fr.row.trackCount} track{fr.row.trackCount === 1 ? '' : 's'}
            </span>
          </span>
        </button>
      )
    }
    if (fr.row.kind === 'artist') {
      // Pick any track by this artist that has artwork as the thumb;
      // gives an artist row a real cover instead of a generic glyph.
      let hash: string | undefined
      for (const t of lib.tracks) {
        if (t.artist === fr.row.name) {
          const h = artHashFor(t.artist, t.album || '')
          if (h) { hash = h; break }
        }
      }
      return (
        <button key={`ar-${fr.row.name}`} className={baseClass} onClick={onClick}>
          {renderArtThumb(hash, '◐')}
          <span className="search-panel-row-main">
            <span className="search-panel-row-title"><HighlightedText text={fr.row.name} query={query} /></span>
            <span className="search-panel-row-sub">{fr.row.trackCount} track{fr.row.trackCount === 1 ? '' : 's'}</span>
          </span>
        </button>
      )
    }
    // playlist
    return (
      <button key={`pl-${fr.row.id}`} className={baseClass} onClick={onClick}>
        {renderArtThumb(undefined, '≡')}
        <span className="search-panel-row-main">
          <span className="search-panel-row-title"><HighlightedText text={fr.row.name} query={query} /></span>
          <span className="search-panel-row-sub">{fr.row.trackCount} track{fr.row.trackCount === 1 ? '' : 's'}</span>
        </span>
      </button>
    )
  }

  // Section grouping for visual headers
  const topRows     = flatRows.filter(r => r.section === 'top')
  const trackRows   = flatRows.filter(r => r.section === 'tracks')
  const albumRows   = flatRows.filter(r => r.section === 'albums')
  const artistRows  = flatRows.filter(r => r.section === 'artists')
  const playlistRows = flatRows.filter(r => r.section === 'playlists')

  return (
    <div className="search-panel" ref={panelRef}>
      {topRows.length > 0 && (
        <div className="search-panel-section search-panel-section--top">
          <div className="search-panel-section-header">Top hit</div>
          {topRows.map(renderRow)}
        </div>
      )}
      {trackRows.length > 0 && (
        <div className="search-panel-section">
          <div className="search-panel-section-header">Tracks</div>
          {trackRows.map(renderRow)}
        </div>
      )}
      {albumRows.length > 0 && (
        <div className="search-panel-section">
          <div className="search-panel-section-header">Albums</div>
          {albumRows.map(renderRow)}
        </div>
      )}
      {artistRows.length > 0 && (
        <div className="search-panel-section">
          <div className="search-panel-section-header">Artists</div>
          {artistRows.map(renderRow)}
        </div>
      )}
      {playlistRows.length > 0 && (
        <div className="search-panel-section">
          <div className="search-panel-section-header">Playlists</div>
          {playlistRows.map(renderRow)}
        </div>
      )}
    </div>
  )
}

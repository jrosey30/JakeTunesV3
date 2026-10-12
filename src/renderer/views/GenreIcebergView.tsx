/**
 * The Genre Iceberg (2026-10-11, v3) — the Genres page's second mode. Genre-
 * led, artists second (Jake): seven umbrellas on the peaks, each one's
 * subgenres sinking beneath it by how known they are; click a genre for his
 * artists in it, best-known first. Genres appear when he has songs tagged
 * with them right now. Layout + depth table: src/common/genre-iceberg.ts.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { canonicalArtist } from '../utils/artistAlias'
import { bergLayout, genreCounts, artistsIn, depthOf, umbrellaName, umbrellaGenres } from '../../common/genre-iceberg'
import '../styles/genre-iceberg.css'

const BANDS: Array<[1 | 2 | 3 | 4, string]> = [[1, 'Just below'], [2, 'Below'], [3, 'Deep water'], [4, 'Abyss']]
const fmt = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))
/** What's selected survives leaving the page (MainContent unmounts views). */
let lastPick: { genre?: string; umbrella?: string } | null = null

export default function GenreIcebergView(): JSX.Element {
  const { state: lib, dispatch } = useLibrary()
  const tracks = useRegularLibraryTracks(lib.tracks)
  const [pick, setPickState] = useState(lastPick)
  const setPick = (p: typeof lastPick): void => { lastPick = p; setPickState(p) }
  const [listeners, setListeners] = useState<Record<string, number>>({})
  useEffect(() => {
    let live = true
    window.electronAPI.artistListeners?.().then((m) => { if (live) setListeners(m) }).catch(() => { /* ranks by songs instead */ })
    return () => { live = false }
  }, [])

  const counts = useMemo(() => genreCounts(tracks), [tracks])
  const berg = useMemo(() => bergLayout(counts), [counts])
  const artists = useMemo(() => {
    if (!pick) return []
    const genres = pick.genre ? new Set([pick.genre]) : umbrellaGenres(pick.umbrella!)
    return artistsIn(tracks, genres, canonicalArtist, listeners)
  }, [pick, tracks, listeners])

  const g = (genre: string, label?: string): JSX.Element => (
    <button key={genre} type="button" className={`gi-g${pick?.genre === genre ? ' gi-g--on' : ''}`}
      title={`${genre} · ${(counts.get(genre) ?? 0).toLocaleString()} songs`} onClick={() => setPick({ genre })}>{label ?? genre}</button>
  )

  return (
    <div className="gi">
      <h1 className="gi-title">Genre Iceberg</h1>
      <p className="gi-sub">The genres everyone knows on top, the ones only diggers know at the bottom. Click a genre for your artists in it.</p>
      <div className="gi-berg" role="table" aria-label="Genre iceberg">
        <div className="gi-row gi-tip" role="row">
          <div className="gi-lab" role="rowheader">The tip</div>
          {berg.map((u) => (
            <div key={u.name} className="gi-cell" role="cell">
              {u.shelf ? g(u.shelf, u.name)
                : <button type="button" className={`gi-g${pick?.umbrella === u.name ? ' gi-g--on' : ''}`} onClick={() => setPick({ umbrella: u.name })}>{u.name}</button>}
            </div>
          ))}
        </div>
        <div className="gi-waterline" aria-hidden="true"><span>waterline</span></div>
        {BANDS.map(([k, name]) => (
          <div key={k} className={`gi-row gi-d${k}`} role="row">
            <div className="gi-lab" role="rowheader">{name}</div>
            {berg.map((u) => <div key={u.name} className="gi-cell" role="cell">{u.layers[k].map((genre) => g(genre))}</div>)}
          </div>
        ))}
      </div>

      <div className="gi-panel">
        {!pick ? <p className="gi-hint">Click any genre to see your artists in it.</p> : (
          <>
            <h2>{pick.genre ?? pick.umbrella}</h2>
            <p className="gi-where">
              {pick.genre ? `${umbrellaName(pick.genre) ?? ''} · ${depthOf(pick.genre)} · ` : 'The whole umbrella · '}
              {artists.length.toLocaleString()} of your artists, best-known first
            </p>
            <div className="gi-artists">
              {artists.map((a) => (
                <button key={a.name} type="button" className="gi-a" onClick={() => dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: a.name })} title={`Open ${a.name}`}>
                  <span>{a.name}</span>
                  <small>{a.songs} song{a.songs === 1 ? '' : 's'}{a.listeners ? ` · ${fmt(a.listeners)} listeners` : ''}</small>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

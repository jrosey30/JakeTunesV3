/**
 * Settings → Library: albums the genre filer wasn't sure about (2026-10-11).
 * Since 2026-10-28 an unsure album is filed under the filer's suggestion right
 * away (filedAs) and stays here until Jake confirms or changes it. Picks come
 * only from his list (src/common/genre-vocab.ts).
 */
import { useEffect, useState } from 'react'
import { GENRES } from '../../common/genre-vocab'

type Entry = { key: string; artist: string; album: string; ids: number[]; tag: string; suggested?: string; why: string; at: string; filedAs?: string }

const AREAS = [...new Set(GENRES.map((g) => g.area))]

export default function GenreCheckList(): JSX.Element | null {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.electronAPI.genreCheckList?.().then((list) => {
      if (!live) return
      setEntries(list)
      setPicks(Object.fromEntries(list.map((e) => [e.key, e.filedAs || e.suggested || ''])))
    }).catch(() => { if (live) setEntries([]) })
    return () => { live = false }
  }, [])

  if (!window.electronAPI.genreCheckList || entries === null) return null

  const file = async (e: Entry): Promise<void> => {
    const genre = picks[e.key]
    if (!genre || !window.electronAPI.genreCheckResolve) return
    setBusy(e.key); setError(null)
    const r = await window.electronAPI.genreCheckResolve(e.key, genre)
    setBusy(null)
    if (r.ok) setEntries((cur) => (cur || []).filter((x) => x.key !== e.key))
    else setError(r.error || 'Could not file it')
  }

  return (
    <>
      <div style={{ borderTop: '1px solid #d0d0d0', margin: '20px 0 14px' }} />
      <div style={{ fontSize: 13, fontWeight: 600, color: '#3a3a3a', marginBottom: 6 }}>Genres to check</div>
      {entries.length === 0 ? (
        <p className="imp-help" style={{ marginTop: 0 }}>Nothing to check. New songs are filed onto your genre list automatically.</p>
      ) : (
        <>
          <p className="imp-help" style={{ marginTop: 0 }}>
            The filer wasn&rsquo;t sure about {entries.length === 1 ? 'this album' : `these ${entries.length} albums`}. Each is filed under its best guess until you confirm or change it.
          </p>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {entries.map((e) => (
              <div key={e.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: '#2a2a2a' }}>{e.artist}</div>
                  <div style={{ color: '#6a6a6a' }}>{e.album}{e.filedAs ? ` · filed as ${e.filedAs}${e.tag ? ` (was “${e.tag}”)` : ''}` : e.tag ? ` · now “${e.tag}”` : ''}</div>
                  {e.why && <div style={{ color: '#8a8a8a', fontSize: 11.5 }}>{e.why}</div>}
                </div>
                <select
                  value={picks[e.key] || ''}
                  onChange={(ev) => setPicks({ ...picks, [e.key]: ev.target.value })}
                  style={{ fontSize: 12.5, padding: 4, maxWidth: 190 }}
                  aria-label={`Genre for ${e.artist} — ${e.album}`}
                >
                  <option value="">Pick a genre…</option>
                  {AREAS.map((a) => (
                    <optgroup key={a} label={a}>
                      {GENRES.filter((g) => g.area === a).map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
                    </optgroup>
                  ))}
                </select>
                <button type="button" className="imp-btn" disabled={!picks[e.key] || busy === e.key} onClick={() => { void file(e) }}>
                  {busy === e.key ? 'Filing…' : e.filedAs && picks[e.key] === e.filedAs ? 'Keep' : 'File'}
                </button>
              </div>
            ))}
          </div>
          {error && <p className="imp-help" style={{ color: '#b0322a', marginTop: 8 }}>{error}</p>}
        </>
      )}
    </>
  )
}

/**
 * Genre Icebergs (2026-10-11) — the Genres page's second mode. Pick a family
 * for the broad berg, zoom into one genre with the chips; membership is each
 * song's CURRENT genre tag. Depth = Deezer fans from identities confirmed
 * against Jake's own albums/songs (main: artist-photo.ts); unconfirmed artists
 * are listed, never guessed. Dashed names: the scene he doesn't own yet.
 * Rules live in src/common/genre-iceberg.ts (node-tested).
 */
import { useEffect, useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { canonicalArtist, artistIdentityKey } from '../utils/artistAlias'
import { LAYERS, FAMILIES, layerOf, buildScope, familyGenres, placeScope, sceneFinds, type Placed, type Find } from '../../common/genre-iceberg'
import '../styles/genre-iceberg.css'

const SEG = ['#e9f2f6', '#9cc6dc', '#5f98bb', '#2f668b', '#0f3550']
const CAP = 30
const fmt = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(n))
const weight = (p: { plays: number; stars: number }): number => p.plays + p.stars * 3
/** Remembered across visits (MainContent unmounts views). */
let lastFamily = 'Rock'
let lastGenre: string | null = null

// Each band's ice is `top`% wide at its top edge and `bottom`% at its bottom,
// so the five bands stack into one berg; the tip has a peak, the abyss a keel.
const WIDTH = [[2, 40], [40, 58], [58, 74], [74, 88], [88, 72]]
function shape(i: number): string {
  const [top, bottom] = WIDTH[i], t = (100 - top) / 2, b = (100 - bottom) / 2
  if (i === 0) return `polygon(49% 0, 52% 9%, 54% 5%, 58% 30%, 62% 42%, ${100 - b}% 100%, ${b}% 100%, 39% 48%, 44% 22%)`
  if (i === 4) return `polygon(${t}% 0, ${100 - t}% 0, ${100 - t + 1.5}% 30%, 90% 62%, 78% 92%, 62% 100%, 40% 98%, 22% 88%, ${t - 1.5}% 45%)`
  return `polygon(${t}% 0, ${100 - t}% 0, ${100 - b}% 100%, ${b}% 100%)`
}

export default function GenreIcebergView(): JSX.Element {
  const { state: lib, dispatch } = useLibrary()
  const tracks = useRegularLibraryTracks(lib.tracks)
  const [family, setFamily] = useState(lastFamily)
  const [genre, setGenre] = useState<string | null>(lastGenre)
  const [facts, setFacts] = useState<Record<string, { dz: number; fans: number }>>({})
  const [related, setRelated] = useState<Record<number, Array<[string, number]>>>({})
  const [pending, setPending] = useState(0)
  const [showFinds, setShowFinds] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const go = (f: string, g: string | null): void => { lastFamily = f; lastGenre = g; setFamily(f); setGenre(g); setSelected(null); setOpen(new Set()) }

  const familyScope = useMemo(() => buildScope(tracks, canonicalArtist, family), [tracks, family])
  const genres = useMemo(() => familyGenres(tracks, canonicalArtist, family), [tracks, family])
  const scope = (genre && genres.find((g) => g.name === genre)) || familyScope
  const familySizes = useMemo(() => new Map(FAMILIES.map((f) => [f, buildScope(tracks, canonicalArtist, f).members.length])), [tracks])

  // Depth: ask main for this family's identities, a budgeted batch at a time.
  useEffect(() => {
    let live = true
    const names = familyScope.members.map((m) => m.name)
    void (async () => {
      for (let round = 0; round < 80 && live; round++) {
        const r = await window.electronAPI.icebergFacts?.(names).catch(() => null)
        if (!live || !r) return
        setFacts((prev) => ({ ...prev, ...r.facts }))
        setPending(r.pending)
        if (!r.pending) return
      }
    })()
    return () => { live = false }
  }, [familyScope])

  const fans = useMemo(() => Object.fromEntries(Object.entries(facts).map(([n, f]) => [n, f.fans])), [facts])
  const stats = useMemo(() => placeScope(scope, fans), [scope, fans])

  // The scene: Deezer's related artists for the placed members, fetched in batches.
  useEffect(() => {
    if (!showFinds) return
    let live = true
    const ids = stats.placed.map((p) => facts[p.name]?.dz).filter((x): x is number => typeof x === 'number')
    void (async () => {
      for (let round = 0; round < 40 && live; round++) {
        const r = await window.electronAPI.icebergRelated?.(ids).catch(() => null)
        if (!live || !r) return
        setRelated((prev) => ({ ...prev, ...r.related }))
        if (!r.pending) return
      }
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFinds, stats.placed.length, scope.name])

  const ownedKeys = useMemo(() => {
    const s = new Set<string>()
    for (const t of lib.tracks) {
      for (const a of [t.artist, t.albumArtist, ...(t.contributingArtists ?? [])]) {
        if (!a) continue
        s.add(artistIdentityKey(a))
        for (const part of a.split(/\s*(?:&|,|\bx\b|\bwith\b)\s*/i)) if (part.trim()) s.add(artistIdentityKey(part))
      }
    }
    return s
  }, [lib.tracks])
  const finds = useMemo(() => (showFinds ? sceneFinds(stats.placed.map((p) => ({ name: p.name, dz: facts[p.name]?.dz })), related, (n) => ownedKeys.has(artistIdentityKey(n))) : []), [showFinds, stats.placed, facts, related, ownedKeys])
  const findsByLayer = useMemo(() => { const b: Find[][] = LAYERS.map(() => []); for (const f of finds) b[layerOf(f.fans)].push(f); return b }, [finds])

  const bar = (s: typeof scope, label: string, g: string | null): JSX.Element => {
    const st = placeScope(s, fans)
    return (
      <button key={label} type="button" className={`gi-cmp${(g ?? null) === genre ? ' gi-cmp--on' : ''}${g ? '' : ' gi-cmp--total'}`} onClick={() => go(family, g)}>
        <b>{label}</b>
        <span className="gi-bar">{st.byLayer.map((xs, i) => <i key={i} style={{ width: `${st.placed.length ? (xs.length / st.placed.length) * 100 : 0}%`, background: SEG[i] }} />)}</span>
        <span className="gi-pct">{st.placed.length ? `${st.pctBelowTip}% below the tip` : 'placing…'}</span>
      </button>
    )
  }
  const name = (label: string, fansN: number, w: number, key: string, find: boolean): JSX.Element => (
    <button key={key} type="button" className={`gi-nm${find ? ' gi-nm--find' : ''}${selected === key ? ' gi-nm--sel' : ''}`}
      style={{ fontSize: `${(find ? 12.5 : 12.5 + Math.min(7, Math.log2(1 + w) * 1.4)).toFixed(1)}px` }}
      title={`${label} · ${fmt(fansN)} fans`} onClick={() => setSelected(key)}>{label}</button>
  )

  const where = genre ?? family
  const sel = (() => {
    if (!selected) return null
    if (selected.startsWith('f:')) {
      const f = finds.find((x) => x.name === selected.slice(2))
      return f && (
        <div className="gi-card"><h3>Selected</h3><div className="gi-sel">{f.name}</div><span className="gi-tag gi-tag--find">Not in your library</span>
          <p>{LAYERS[layerOf(f.fans)].name} · {f.fans.toLocaleString()} Deezer fans</p>
          <p>Related to {f.via.length} of your {where} artists: {f.via.slice(0, 5).join(', ')}{f.via.length > 5 ? '…' : ''}</p></div>
      )
    }
    const p = stats.placed.find((x) => x.name === selected.slice(2))
    const fm = familyScope.members.find((m) => m.name === selected.slice(2))
    return p && (
      <div className="gi-card"><h3>Selected</h3><div className="gi-sel">{p.name}</div><span className="gi-tag">On your shelf</span>
        <p>{LAYERS[p.layer].name} · {p.fans.toLocaleString()} Deezer fans</p>
        <p>{p.songs} song{p.songs === 1 ? '' : 's'} here · {p.plays} play{p.plays === 1 ? '' : 's'}{p.stars ? ` · ${p.stars} starred` : ''}</p>
        <p className="gi-muted">How their songs are tagged in {family} right now:</p>
        <div className="gi-tags">{(fm?.tags ?? p.tags).map(([g, n]) => <span key={g} className={g === genre ? 'gi-here' : ''}>{g} · {n}</span>)}</div>
        <button type="button" className="gi-open" onClick={() => dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: p.name })}>Open artist page</button>
      </div>
    )
  })()
  const median = [...stats.placed].map((p) => p.fans).sort((a, b) => a - b)[Math.floor(stats.placed.length / 2)] ?? 0
  const dig = finds.filter((f) => f.fans <= median * 4).slice(0, 6)

  return (
    <div className="gi">
      <div className="gi-chips">
        {FAMILIES.filter((f) => (familySizes.get(f) ?? 0) > 0).map((f) => (
          <button key={f} type="button" className={`gi-chip${f === family ? ' gi-chip--on' : ''}`} onClick={() => go(f, null)}>{f}<span>{familySizes.get(f)}</span></button>
        ))}
      </div>
      <div className="gi-crumb">
        {genre ? <><button type="button" onClick={() => go(family, null)} title={`Zoom out to ${family}`}>{family}</button><span>›</span><h2>{genre}</h2></> : <><h2>{family}</h2><span className="gi-muted">all {genres.length} genres together</span></>}
      </div>
      {genres.length > 0 && (
        <div className="gi-zoom"><span>Zoom in</span>
          {genres.map((g) => <button key={g.name} type="button" className={`gi-zchip${g.name === genre ? ' gi-zchip--on' : ''}`} onClick={() => go(family, g.name === genre ? null : g.name)}>{g.name}<span>{g.members.length}</span></button>)}
        </div>
      )}
      <div className="gi-compare">{bar(familyScope, `All ${family}`, null)}{genres.slice(0, 9).map((g) => bar(g, g.name, g.name))}</div>
      <label className="gi-toggle"><input type="checkbox" checked={showFinds} onChange={(e) => setShowFinds(e.target.checked)} /> Show the scene you don't own yet (bands related to 2+ of yours here)</label>

      <div className="gi-grid">
        <div className="gi-berg">
          {LAYERS.map((l, i) => {
            const own = stats.byLayer[i]
            const shown = open.has(i) ? own : own.slice(0, CAP)
            const fs = findsByLayer[i].slice(0, open.has(i) ? 24 : 8)
            const inner = i === 0 ? WIDTH[0][1] - 6 : Math.min(...WIDTH[i]) - 6
            return (
              <div key={l.id} className={`gi-band gi-b${i}`}>
                {i === 1 && <div className="gi-wl" aria-hidden="true"><svg viewBox="0 0 100 12" preserveAspectRatio="none"><path d="M0 6 Q 2.5 2 5 6 T 10 6 T 15 6 T 20 6 T 25 6 T 30 6 T 35 6 T 40 6 T 45 6 T 50 6 T 55 6 T 60 6 T 65 6 T 70 6 T 75 6 T 80 6 T 85 6 T 90 6 T 95 6 T 100 6" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" /></svg><span>waterline</span></div>}
                <div className="gi-ice" style={{ ['--shape' as string]: shape(i) }}>
                  <div className="gi-label">{l.name} <em>· {l.range} · {own.length} of yours</em></div>
                  <div className="gi-names" style={{ maxWidth: `${inner}%` }}>
                    {shown.map((p: Placed) => name(p.name, p.fans, weight(p), `o:${p.name}`, false))}
                    {own.length > shown.length && <button type="button" className="gi-more" onClick={() => setOpen(new Set(open).add(i))}>+{own.length - shown.length} more</button>}
                    {fs.map((f) => name(f.name, f.fans, 0, `f:${f.name}`, true))}
                  </div>
                </div>
              </div>
            )
          })}
          <div className="gi-seabed">Depth is Deezer fans — confirmed against your own albums and songs. Deezer counts run smaller than Spotify's.</div>
        </div>

        <div className="gi-panel">
          <div className="gi-card"><div className="gi-big">{stats.placed.length ? `${stats.pctBelowTip}%` : '—'}</div>
            <p>of your {where} lives below the tip. {stats.placed.length} artists placed, {stats.byLayer[3].length + stats.byLayer[4].length} in deep water or the abyss.</p></div>
          {sel}
          {stats.deepest && <div className="gi-card"><h3>Deepest</h3><div className="gi-sel">{stats.deepest.name}</div><p>{stats.deepest.fans.toLocaleString()} Deezer fans</p></div>}
          <div className="gi-card"><h3>Most played at each depth</h3>
            {LAYERS.map((l, i) => stats.byLayer[i][0] && <div key={l.id} className="gi-row"><span>{stats.byLayer[i][0].name}</span><small>{l.name}</small></div>)}
          </div>
          {showFinds && <div className="gi-card"><h3>Where to dig</h3>
            {dig.length ? dig.map((f) => <div key={f.name} className="gi-row"><button type="button" className="gi-nm gi-nm--plain" onClick={() => setSelected(`f:${f.name}`)}>{f.name}</button><small>{fmt(f.fans)} fans · {f.via.length} links</small></div>)
              : <p>{Object.keys(related).length ? 'Nothing related to 2+ of yours at this depth yet.' : 'Finding the scene…'}</p>}
            <p className="gi-muted">Bands Deezer lists as related to two or more of your {where} artists.</p></div>}
          {(stats.unplaced.length > 0 || pending > 0) && (
            <p className="gi-note">{pending > 0 ? `Placing ${pending} more… ` : ''}{stats.unplaced.length > 0 ? `Not placed (${stats.unplaced.length}) — not on Deezer, or none of your albums or songs matched, so it could be a different band: ${stats.unplaced.slice(0, 20).join(', ')}${stats.unplaced.length > 20 ? '…' : ''}.` : ''}</p>
          )}
        </div>
      </div>
    </div>
  )
}

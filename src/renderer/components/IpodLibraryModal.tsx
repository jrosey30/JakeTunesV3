import { useEffect, useMemo, useState } from 'react'
import type { Track } from '../types'
import { useLibrary } from '../context/LibraryContext'
import '../styles/import-convert.css'

interface Props {
  onClose: () => void
}

/**
 * The "On This iPod" viewer. Reads the iPod's iTunesDB directly (not
 * library.json) and shows exactly what the device itself reports as
 * present, with a reconciliation indicator against the local library.
 *
 * Motivation: when library.json and iTunesDB drift out of sync — e.g.
 * user deleted tracks, sync ran, but the iPod hardware count still
 * looks off — the user needs to see the two sources side by side to
 * figure out which side is "wrong." This is the feature iTunes had
 * behind the iPod in the sidebar.
 */
export default function IpodLibraryModal({ onClose }: Props) {
  const { state: lib, dispatch } = useLibrary()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ipodTracks, setIpodTracks] = useState<Track[]>([])
  const [ipodPlaylists, setIpodPlaylists] = useState<{ name: string; trackIds: number[] }[]>([])
  const [search, setSearch] = useState('')
  const [showOnlyDiff, setShowOnlyDiff] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importDone, setImportDone] = useState<{ added: number; playlists: number } | null>(null)

  useEffect(() => {
    window.electronAPI.getIpodDbTracks().then(r => {
      if (r.ok) {
        setIpodTracks((r.tracks as Track[]) || [])
        setIpodPlaylists(r.playlists || [])
      } else {
        setError(r.error || 'Could not read iPod database.')
      }
      setLoading(false)
    }).catch(err => {
      setError(String(err))
      setLoading(false)
    })
  }, [])

  // Reconcile by file path (the stable identifier across both sides).
  //
  // Three distinct signals to surface:
  //   1. onlyOnIpod  — iPod holds tracks library doesn't have
  //   2. onlyInLibrary — library has tracks iPod doesn't (needs sync)
  //   3. ipodDuplicatePaths — iPod DB has multiple mhit records for
  //      the same file, which is always a leftover from a bad old
  //      sync. A fresh sync wipes them.
  const recon = useMemo(() => {
    const libByPath = new Map<string, Track>(lib.tracks.map(t => [t.path, t]))
    const ipodByPath = new Map<string, Track>()
    const ipodPathCounts = new Map<string, number>()
    for (const t of ipodTracks) {
      if (!ipodByPath.has(t.path)) ipodByPath.set(t.path, t)
      ipodPathCounts.set(t.path, (ipodPathCounts.get(t.path) || 0) + 1)
    }
    const onlyOnIpod: Track[] = []
    const onlyInLibrary: Track[] = []
    const ipodDuplicates: Track[] = []
    for (const t of ipodTracks) {
      if (!libByPath.has(t.path)) onlyOnIpod.push(t)
    }
    for (const t of lib.tracks) {
      if (!ipodByPath.has(t.path)) onlyInLibrary.push(t)
    }
    for (const [p, n] of ipodPathCounts) {
      if (n > 1) ipodDuplicates.push(ipodByPath.get(p)!)
    }
    const ipodUniquePaths = ipodByPath.size
    return { onlyOnIpod, onlyInLibrary, libByPath, ipodByPath, ipodDuplicates, ipodUniquePaths }
  }, [ipodTracks, lib.tracks])

  const filteredIpod = useMemo(() => {
    const q = search.trim().toLowerCase()
    let src = ipodTracks
    if (showOnlyDiff) {
      // "Only tracks that are on iPod but NOT in library" + flag the
      // "in library but not on iPod" ones in a separate banner.
      src = recon.onlyOnIpod
    }
    if (!q) return src
    return src.filter(t => {
      const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase()
      return hay.includes(q)
    })
  }, [ipodTracks, search, showOnlyDiff, recon.onlyOnIpod])

  const fmtTime = (ms: number) => {
    if (!ms || ms <= 0) return ''
    const s = Math.floor(ms / 1000)
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
  }

  // Pull iPod-only tracks into the local library. This is the action
  // path for "drift detected: N on iPod but not in library." The old
  // verify-and-repair flow tried to merge iPod entries into existing
  // library entries via fragile text matching and got it wrong on
  // edge cases like "Pt. 1" vs "Part 1". This flow is the safe
  // replacement: we don't merge anything — we just add the iPod-side
  // entries as new library tracks (path-keyed dedupe in
  // ADD_IMPORTED_TRACKS keeps it idempotent), backfill audio
  // fingerprints in the main process, and let the user proceed.
  // ADD_IMPORTED_TRACKS dedupes by id, and saveLibrary auto-fires on
  // libState.tracks change in App.tsx so we don't have to call it here.
  const handleImportIpodOnly = async () => {
    if (importing || recon.onlyOnIpod.length === 0) return
    setImporting(true)
    try {
      const existingIds = lib.tracks.map(t => t.id)
      const r = await window.electronAPI.syncIpod(existingIds)
      if (!r.ok) {
        setError(r.error || 'Could not pull tracks from iPod.')
        setImporting(false)
        return
      }
      // Filter the returned newTracks against the local library by
      // path too, just in case some IDs collide with library entries
      // that already point at the same colon path. Belt-and-suspenders
      // — the old verify-repair burned us, so we're paranoid here.
      const libPaths = new Set(lib.tracks.map(t => t.path))
      const toAdd = (r.newTracks || []).filter(t => !libPaths.has(t.path))
      if (toAdd.length > 0) {
        dispatch({ type: 'ADD_IMPORTED_TRACKS', tracks: toAdd })
      }
      // Merge any iPod-sourced playlists we don't already have. App.tsx
      // does this on initial load, but if the user hits import after the
      // initial load completed without those playlists, we top them up
      // here. Tombstones (deletedIpodPlaylistNames) keep deliberately
      // deleted ones from coming back.
      let addedPlaylists = 0
      const savedNames = new Set(lib.playlists.map(p => p.name))
      const tombstones = lib.deletedIpodPlaylistNames
      for (const ip of (r.playlists || [])) {
        if (savedNames.has(ip.name) || tombstones.has(ip.name)) continue
        dispatch({
          type: 'ADD_PLAYLIST',
          playlist: {
            id: `ipod-${ip.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: ip.name,
            trackIds: ip.trackIds,
          },
        })
        addedPlaylists++
      }
      setImportDone({ added: toAdd.length, playlists: addedPlaylists })
    } catch (err) {
      setError(String(err))
    }
    setImporting(false)
  }

  return (
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-modal" role="dialog" aria-modal="true" style={{ width: 820, maxHeight: '85vh' }}>
        <div className="imp-header">
          <h2>On This iPod</h2>
          <button className="imp-close" onClick={onClose} title="Close">×</button>
        </div>

        <div className="imp-body" style={{ gap: 10 }}>
          {loading && <p className="imp-help">Reading iTunesDB from iPod…</p>}
          {error && <div className="imp-result imp-result--error">{error}</div>}

          {!loading && !error && (
            <>
              <p className="imp-help" style={{ marginBottom: 4 }}>
                What the iPod's own database reports as present — independent of your local library.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
                <div style={{ padding: '6px 10px', background: '#fff', border: '1px solid #d8d8d8', borderRadius: 4 }}>
                  <div style={{ color: '#666' }}>On iPod (iTunesDB)</div>
                  <div style={{ fontSize: 20, fontWeight: 600 }}>{ipodTracks.length.toLocaleString()} songs</div>
                  <div style={{ color: '#888', fontSize: 11 }}>{ipodPlaylists.length} playlists</div>
                </div>
                <div style={{ padding: '6px 10px', background: '#fff', border: '1px solid #d8d8d8', borderRadius: 4 }}>
                  <div style={{ color: '#666' }}>In local library</div>
                  <div style={{ fontSize: 20, fontWeight: 600 }}>{lib.tracks.length.toLocaleString()} songs</div>
                  <div style={{ color: '#888', fontSize: 11 }}>
                    {lib.tracks.length === ipodTracks.length
                      ? 'matches iPod count'
                      : `${Math.abs(lib.tracks.length - ipodTracks.length)} ${lib.tracks.length > ipodTracks.length ? 'more than' : 'fewer than'} iPod`}
                  </div>
                </div>
              </div>

              {(recon.onlyOnIpod.length > 0 || recon.onlyInLibrary.length > 0) && (
                <div className="imp-result imp-result--error" style={{ fontSize: 11, lineHeight: 1.5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ flex: 1, minWidth: 240 }}>
                    <strong>Drift detected.</strong>&nbsp;
                    {recon.onlyOnIpod.length > 0 && <>{recon.onlyOnIpod.length} on iPod but not in library. </>}
                    {recon.onlyInLibrary.length > 0 && <>{recon.onlyInLibrary.length} in library but not on iPod (Sync to copy). </>}
                  </span>
                  {recon.onlyOnIpod.length > 0 && !importDone && (
                    <button
                      className="imp-btn imp-btn--start"
                      onClick={handleImportIpodOnly}
                      disabled={importing}
                      title="Add the iPod-only tracks to your local library so they show up everywhere in JakeTunes."
                      style={{ flexShrink: 0 }}
                    >
                      {importing ? 'Importing…' : `Import ${recon.onlyOnIpod.length} to Library`}
                    </button>
                  )}
                  {importDone && (
                    <span style={{ color: '#2c662d', fontWeight: 600, flexShrink: 0 }}>
                      ✓ Added {importDone.added} track{importDone.added === 1 ? '' : 's'}
                      {importDone.playlists > 0 ? ` and ${importDone.playlists} playlist${importDone.playlists === 1 ? '' : 's'}` : ''} to library.
                    </span>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="view-search-input"
                  type="search"
                  placeholder={`Search ${ipodTracks.length} iPod tracks…`}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ flex: 1 }}
                />
                <label style={{ fontSize: 11, color: '#555', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={showOnlyDiff} onChange={e => setShowOnlyDiff(e.target.checked)} />
                  Only show iPod-only tracks ({recon.onlyOnIpod.length})
                </label>
              </div>

              <div style={{ flex: 1, minHeight: 0, border: '1px solid #d8d8d8', borderRadius: 4, background: '#fff', overflowY: 'auto', maxHeight: '45vh' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'linear-gradient(180deg,#ececec,#dcdcdc)', borderBottom: '1px solid #ccc' }}>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Title</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Artist</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600 }}>Album</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 600, width: 60 }}>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredIpod.slice(0, 500).map((t, i) => {
                      const inLib = recon.libByPath.has(t.path)
                      return (
                        <tr key={`${t.id}-${i}`} style={{ borderBottom: '1px solid #ededed', background: inLib ? undefined : '#fff6e6' }}>
                          <td style={{ padding: '3px 8px' }}>{t.title}</td>
                          <td style={{ padding: '3px 8px', color: '#555' }}>{t.artist}</td>
                          <td style={{ padding: '3px 8px', color: '#555' }}>{t.album}</td>
                          <td style={{ padding: '3px 8px', color: '#777' }}>{fmtTime(t.duration)}</td>
                        </tr>
                      )
                    })}
                    {filteredIpod.length > 500 && (
                      <tr><td colSpan={4} style={{ padding: '4px 8px', textAlign: 'center', color: '#888' }}>
                        Showing first 500 of {filteredIpod.length.toLocaleString()} — narrow with search
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="imp-footer">
          <button className="imp-btn imp-btn--cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

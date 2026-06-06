import { useEffect, useState, useCallback, useRef } from 'react'
import { AppSettings, DEFAULT_APP_SETTINGS, ImportFormatChoice } from '../types'
import { EQ_BAND_FREQUENCIES, EQ_PRESETS } from '../audio/eq'
import '../styles/import-convert.css'

/**
 * App-level user preferences. Tabbed layout (Playback / Library / Sync /
 * AI / About) so we can keep adding settings without ballooning a single
 * pane. Reuses the import-convert.css modal shell so we don't grow a
 * second visual vocabulary.
 *
 * Save flow: edits live in local state until user clicks Save. Cancel
 * discards. On Save we persist to app-settings.json. The Claude daily
 * ceiling is also propagated to claude-stats.json (the runtime store
 * the wrapper reads from on every call) so the change takes effect
 * without an app restart.
 */
interface Props {
  initial: AppSettings
  onClose: () => void
  onSaved: (next: AppSettings) => void
}

type Tab = 'Playback' | 'EQ' | 'Library' | 'Sync' | 'Audio' | 'AI'
const TABS: Tab[] = ['Playback', 'EQ', 'Library', 'Sync', 'Audio', 'AI']

// Pretty Hz labels for the band frequencies (31, 62, 125, 250, 500,
// 1000, 2000, 4000, 8000, 16000). Anything ≥1k becomes "1k" / "16k".
function bandLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz)
}

function formatStateBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// 4.4.51: short transport suffix for the call-route speaker picker, so
// the user can tell an AirPlay speaker apart from a Bluetooth one at a
// glance. Empty string for built-in / unknown — no suffix needed.
function transportHint(transport: string): string {
  switch (transport) {
    case 'airplay':   return ' · AirPlay'
    case 'bluetooth': return ' · Bluetooth'
    case 'usb':       return ' · USB'
    default:          return ''
  }
}

const FORMAT_OPTIONS: { value: ImportFormatChoice; label: string }[] = [
  { value: 'aac-128', label: 'AAC 128 kbps (small)' },
  { value: 'aac-256', label: 'AAC 256 kbps (default)' },
  { value: 'aac-320', label: 'AAC 320 kbps (high)' },
  { value: 'alac',    label: 'Apple Lossless (ALAC)' },
  { value: 'aiff',    label: 'AIFF (uncompressed)' },
  { value: 'wav',     label: 'WAV (uncompressed)' },
]

function formatRelative(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}

function reasonLabel(reason: string | null): string {
  switch (reason) {
    case 'import':        return 'Imports'
    case 'metadata-edit': return 'Metadata edits'
    case 'playlist':      return 'Playlist changes'
    case 'safety-net':    return 'Routine backup'
    case 'manual':        return 'Manual'
    default:              return reason || 'Sync'
  }
}

interface LastSync {
  ok: boolean | null
  reason: string | null
  at: number | null
  durationMs: number | null
  error: string | null
  scriptPresent: boolean
}

export default function SettingsModal({ initial, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<AppSettings>(initial)
  const [tab, setTab] = useState<Tab>('Playback')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 4.4.13: resolved default path (~/Music2/_inbox) used as the placeholder
  // for the inbox folder input. Comes from main since renderer doesn't
  // know the user's homedir without a separate IPC.
  const [defaultInboxPath, setDefaultInboxPath] = useState<string>('')
  // 4.5: snapshot of the last laptop → homemini sync. Pulled on open and
  // refreshed every 15s while the modal stays open so the relative time
  // string ("3 min ago") stays roughly accurate without push wiring.
  const [lastSync, setLastSync] = useState<LastSync | null>(null)
  // 4.4.51: audio output devices for the call-route speaker picker. The
  // call-route feature moves music to a chosen speaker (e.g. an AirPlay
  // device) when a call grabs the mic, then restores it on hang-up.
  const [audioDevices, setAudioDevices] = useState<
    { id: number; name: string; transport: string; isDefault: boolean }[]
  >([])
  // 4.5.0-83 — locked-artwork count for the Library tab. Refreshed
  // every time the modal opens (cheap — one disk read of a small
  // JSON file). Gives a verifiable count of hand-set covers that
  // are protected from auto-fetch / re-import overwrite.
  const [artworkLockCount, setArtworkLockCount] = useState<number | null>(null)
  // 4.5.0-87 — RAG status + backfill button. configured=false when
  // OPENAI_API_KEY isn't set in .env; UI shows that explicitly so the
  // user knows what's missing. count/total drive the indexed-of-total
  // display. running flag locks the button + shows progress.
  const [embedStatus, setEmbedStatus] = useState<{ configured: boolean; count: number; total: number; stale: number } | null>(null)
  const [embedRunning, setEmbedRunning] = useState(false)
  const [embedProgress, setEmbedProgress] = useState<{ done: number; total: number } | null>(null)
  // 4.5.0-91 Phase 2.5 — storage-mode display + orphaned-edit
  // reconciliation. State conflicts are local-userData state files
  // newer than NAS, meaning the user edited offline and those
  // changes haven't reached NAS yet. The button pushes them.
  const [stateConflictInfo, setStateConflictInfo] = useState<{
    mode: 'NAS' | 'local-primary'
    nasDir: string
    localDir: string
    nasMounted: boolean
    conflicts: Array<{ file: string; localMtimeMs: number; nasMtimeMs: number; localPath: string; nasPath: string; localSizeBytes: number }>
  } | null>(null)
  const [reconcileRunning, setReconcileRunning] = useState(false)
  const [reconcileProgress, setReconcileProgress] = useState<{
    phase: 'backup' | 'push' | 'verify'
    file: string
    index: number
    total: number
    localSizeBytes?: number
    totalBytes: number
  } | null>(null)

  // Tab-scoped IPC: only fetch when the user opens that tab so Preferences
  // paints immediately (default Playback tab has no main-process work).
  const libraryDataLoaded = useRef(false)
  const audioDataLoaded = useRef(false)

  useEffect(() => { setDraft(initial) }, [initial])

  useEffect(() => {
    if (tab !== 'Library' || libraryDataLoaded.current) return
    libraryDataLoaded.current = true
    const t = window.setTimeout(() => {
      window.electronAPI.getDefaultInboxPath?.().then(r => {
        if (r?.ok && r.path) setDefaultInboxPath(r.path)
      }).catch(() => { /* fall back to empty placeholder */ })
      window.electronAPI.getArtworkLockCount?.().then(r => {
        if (r?.ok) setArtworkLockCount(r.count)
      }).catch(() => { /* leave null */ })
      window.electronAPI.getStateConflicts?.().then(setStateConflictInfo).catch(() => { /* leave null */ })
      window.electronAPI.embeddingStatus?.().then(setEmbedStatus).catch(() => { /* leave null */ })
    }, 0)
    return () => window.clearTimeout(t)
  }, [tab])

  useEffect(() => {
    if (tab !== 'Audio' || audioDataLoaded.current) return
    audioDataLoaded.current = true
    const t = window.setTimeout(() => {
      window.electronAPI.listAudioDevices?.().then(r => {
        if (r?.ok && Array.isArray(r.devices)) setAudioDevices(r.devices)
      }).catch(() => { /* leave empty */ })
    }, 0)
    return () => window.clearTimeout(t)
  }, [tab])

  useEffect(() => {
    if (tab !== 'Sync') return
    const fetchSnap = () => {
      window.electronAPI.getLastLibrarySync?.().then(r => setLastSync(r)).catch(() => { /* leave null */ })
    }
    const t = window.setTimeout(fetchSnap, 0)
    const id = window.setInterval(fetchSnap, 15_000)
    return () => {
      window.clearTimeout(t)
      window.clearInterval(id)
    }
  }, [tab])

  useEffect(() => {
    if (tab !== 'Library') return
    const unsub = window.electronAPI.onEmbeddingBackfillProgress?.((p) => setEmbedProgress(p))
    return () => { if (unsub) unsub() }
  }, [tab])

  useEffect(() => {
    if (tab !== 'Library') return
    const unsub = window.electronAPI.onReconcileStateProgress?.((p) => setReconcileProgress(p))
    return () => { if (unsub) unsub() }
  }, [tab])

  const reconcileStateNow = useCallback(async () => {
    setReconcileRunning(true)
    setReconcileProgress(null)
    try {
      await window.electronAPI.reconcileStateConflicts?.()
      const fresh = await window.electronAPI.getStateConflicts?.()
      if (fresh) setStateConflictInfo(fresh)
    } finally {
      setReconcileRunning(false)
      setReconcileProgress(null)
    }
  }, [])

  const runEmbeddingBackfill = useCallback(async () => {
    setEmbedRunning(true)
    setEmbedProgress({ done: 0, total: 0 })
    try {
      await window.electronAPI.embeddingBackfill?.()
      const fresh = await window.electronAPI.embeddingStatus?.()
      if (fresh) setEmbedStatus(fresh)
    } finally {
      setEmbedRunning(false)
      setEmbedProgress(null)
    }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    // try/catch/finally is load-bearing: Save AND Cancel are both
    // disabled={saving}, so a thrown save would trap the modal with no way
    // to retry or close. finally always re-enables the buttons.
    try {
      const result = await window.electronAPI.saveAppSettings(draft as unknown as Record<string, unknown>)
      if (result.ok) {
        // Mirror the Claude daily ceiling into claude-stats.json so the
        // runtime wrapper picks it up immediately (no app restart needed).
        try {
          await window.electronAPI.setClaudeDailyCeiling?.(draft.ai.claudeDailyCeiling)
        } catch { /* non-fatal */ }
        onSaved(draft)
      } else {
        setError(result.error || 'Failed to save settings.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-modal" role="dialog" aria-modal="true" style={{ minWidth: 460 }}>
        <div className="imp-header">
          <h2>Preferences</h2>
          <button className="imp-close" onClick={onClose} title="Close">×</button>
        </div>

        {/* Tab strip */}
        <div style={{ display: 'flex', borderBottom: '1px solid #c4c4c4', background: '#e8e8e8' }}>
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: '8px 0',
                border: 'none',
                background: tab === t ? '#f5f5f5' : 'transparent',
                borderBottom: tab === t ? '2px solid #4a7fbf' : '2px solid transparent',
                fontSize: 12,
                fontWeight: tab === t ? 600 : 400,
                color: tab === t ? '#222' : '#555',
                cursor: 'pointer',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="imp-body" style={{ minHeight: 220 }}>
          {tab === 'Playback' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <input
                  type="checkbox"
                  checked={draft.crossfade.enabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    crossfade: { ...draft.crossfade, enabled: e.target.checked },
                  })}
                />
                <span>Crossfade Songs</span>
              </label>

              <div style={{ opacity: draft.crossfade.enabled ? 1 : 0.4, transition: 'opacity 0.15s' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: '#555', minWidth: 30 }}>1 sec</span>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    step={1}
                    value={draft.crossfade.seconds}
                    disabled={!draft.crossfade.enabled}
                    onChange={(e) => setDraft({
                      ...draft,
                      crossfade: { ...draft.crossfade, seconds: Number(e.target.value) || DEFAULT_APP_SETTINGS.crossfade.seconds },
                    })}
                    style={{ flex: 1 }}
                  />
                  <span style={{ fontSize: 12, color: '#555', minWidth: 40, textAlign: 'right' }}>12 sec</span>
                </div>
                <div style={{ textAlign: 'center', fontSize: 12, color: '#3a3a3a' }}>
                  {draft.crossfade.seconds} second{draft.crossfade.seconds === 1 ? '' : 's'}
                </div>
              </div>
              <p className="imp-help" style={{ marginTop: 16 }}>
                Gapless playback (preload + instant start) is always on; no setting needed.
              </p>
            </>
          )}

          {tab === 'EQ' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.eq.enabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    eq: { ...draft.eq, enabled: e.target.checked },
                  })}
                />
                <span>Equalizer enabled</span>
              </label>

              <div style={{ opacity: draft.eq.enabled ? 1 : 0.4, transition: 'opacity 0.15s' }}>
                <label style={{ display: 'block', fontSize: 12, color: '#3a3a3a', marginBottom: 4 }}>
                  Preset
                </label>
                <select
                  value={draft.eq.preset in EQ_PRESETS ? draft.eq.preset : 'Custom'}
                  disabled={!draft.eq.enabled}
                  onChange={(e) => {
                    const name = e.target.value
                    if (name === 'Custom') {
                      setDraft({ ...draft, eq: { ...draft.eq, preset: 'Custom' } })
                      return
                    }
                    const p = EQ_PRESETS[name]
                    if (!p) return
                    setDraft({
                      ...draft,
                      eq: {
                        ...draft.eq,
                        preset: name,
                        preamp: p.preamp,
                        bands: [...p.bands],
                      },
                    })
                  }}
                  style={{ width: '100%', padding: 6, fontSize: 13, marginBottom: 16 }}
                >
                  {Object.keys(EQ_PRESETS).map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                  <option value="Custom">Custom</option>
                </select>

                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 180, paddingBottom: 4, borderBottom: '1px solid #d0d0d0' }}>
                  {/* Preamp */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                    <span style={{ fontSize: 10, color: '#555', minHeight: 12 }}>
                      {draft.eq.preamp > 0 ? `+${draft.eq.preamp}` : draft.eq.preamp} dB
                    </span>
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      step={1}
                      value={draft.eq.preamp}
                      disabled={!draft.eq.enabled}
                      onChange={(e) => setDraft({
                        ...draft,
                        eq: { ...draft.eq, preamp: Number(e.target.value), preset: 'Custom' },
                      })}
                      style={{
                        writingMode: 'vertical-lr',
                        WebkitAppearance: 'slider-vertical',
                        appearance: 'slider-vertical',
                        width: 22,
                        height: 130,
                        margin: 0,
                      } as unknown as React.CSSProperties}
                    />
                    <span style={{ fontSize: 9, color: '#777', marginTop: 2, fontWeight: 600 }}>Preamp</span>
                  </div>

                  {/* Divider */}
                  <div style={{ width: 1, height: 130, background: '#d0d0d0', alignSelf: 'center' }} />

                  {/* 10 bands */}
                  {EQ_BAND_FREQUENCIES.map((hz, i) => {
                    const value = draft.eq.bands[i] ?? 0
                    return (
                      <div key={hz} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                        <span style={{ fontSize: 10, color: '#555', minHeight: 12 }}>
                          {value > 0 ? `+${value}` : value}
                        </span>
                        <input
                          type="range"
                          min={-12}
                          max={12}
                          step={1}
                          value={value}
                          disabled={!draft.eq.enabled}
                          onChange={(e) => {
                            const next = [...draft.eq.bands]
                            next[i] = Number(e.target.value)
                            setDraft({
                              ...draft,
                              eq: { ...draft.eq, bands: next, preset: 'Custom' },
                            })
                          }}
                          style={{
                            writingMode: 'vertical-lr',
                            WebkitAppearance: 'slider-vertical',
                            appearance: 'slider-vertical',
                            width: 22,
                            height: 130,
                            margin: 0,
                          } as unknown as React.CSSProperties}
                        />
                        <span style={{ fontSize: 9, color: '#777', marginTop: 2 }}>{bandLabel(hz)}</span>
                      </div>
                    )
                  })}
                </div>

                <p className="imp-help" style={{ marginTop: 14 }}>
                  Range −12 dB to +12 dB. Toggling EQ on or off mid-track applies to the next song;
                  preset and slider changes apply immediately.
                </p>
                <p className="imp-help" style={{ marginTop: 4, fontSize: 10, color: '#888' }}>
                  Bands: 31, 62, 125, 250, 500 Hz · 1k, 2k, 4k, 8k, 16k Hz
                </p>
              </div>
            </>
          )}

          {tab === 'Library' && (
            <>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#3a3a3a' }}>
                Default import format
              </label>
              <select
                value={draft.library.defaultImportFormat}
                onChange={(e) => setDraft({
                  ...draft,
                  library: { defaultImportFormat: e.target.value as ImportFormatChoice },
                })}
                style={{ width: '100%', padding: 6, fontSize: 13 }}
              >
                {FORMAT_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="imp-help" style={{ marginTop: 10 }}>
                Applied when you drag-drop or use Import. Existing tracks aren't re-encoded.
              </p>

              {/* 4.5.0-83 — locked-artwork visibility. Surfaces the
                  count of covers you've hand-set so you can verify
                  protection at a glance. The four-layer protection
                  story: locked.json + sidecar self-heal + locked-
                  backup/ + force-confirm on remove. */}
              <div style={{ borderTop: '1px solid #d0d0d0', margin: '20px 0 14px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: '#3a3a3a', fontWeight: 600 }}>Locked artwork covers:</span>
                <span style={{ color: '#3a3520', fontFamily: 'var(--font-mono, monospace)' }}>
                  {artworkLockCount === null ? '—' : artworkLockCount.toLocaleString()}
                </span>
              </div>
              <p className="imp-help" style={{ marginTop: 0, marginBottom: 14 }}>
                Hand-set covers protected from auto-fetch + re-import overwrite. Backed up to <code>locked-backup/</code> and self-healed from sidecars on every launch.
              </p>

              {/* 4.5.0-91 Phase 2.5 — Storage Mode + conflict surface.
                  Renders the canonical state-storage location (NAS vs
                  local-fallback) plus a reconciliation button when
                  there are offline edits that haven't reached NAS yet. */}
              <div style={{ borderTop: '1px solid #d0d0d0', margin: '20px 0 14px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: '#3a3a3a', fontWeight: 600 }}>State storage:</span>
                <span style={{ color: stateConflictInfo?.nasMounted ? '#2a6e2a' : '#a23a2a', fontFamily: 'var(--font-mono, monospace)' }}>
                  {!stateConflictInfo ? '—'
                    : stateConflictInfo.mode === 'NAS'
                      ? `NAS canonical (${stateConflictInfo.nasDir})`
                      : stateConflictInfo.nasMounted
                        ? `Local SSD canonical (${stateConflictInfo.localDir}) — NAS backup mounted`
                        : `Local SSD canonical (${stateConflictInfo.localDir}) — NAS backup unavailable`}
                </span>
              </div>
              <p className="imp-help" style={{ marginTop: 0, marginBottom: 10 }}>
                Since 4.5.0-114, library.json and other state files live on this Mac&apos;s SSD for reliability. The Synology at <code>{stateConflictInfo?.nasDir ?? '/Volumes/JakeShared/JakeTunesState'}</code> receives an async backup mirror after each save — it is not read at boot. Audio files are separate: playback reads from your local JakeTunesLibrary folder, not streamed from the NAS.
              </p>
              {stateConflictInfo && stateConflictInfo.conflicts.length > 0 && (() => {
                const pushTotalBytes = stateConflictInfo.conflicts.reduce((n, c) => n + (c.localSizeBytes ?? 0), 0)
                const reconcileLabel = reconcileRunning && reconcileProgress
                  ? reconcileProgress.phase === 'verify'
                    ? 'Verifying on NAS…'
                    : reconcileProgress.phase === 'backup'
                      ? `Backing up ${reconcileProgress.file} (${reconcileProgress.index}/${reconcileProgress.total})…`
                      : `Copying ${reconcileProgress.file}${reconcileProgress.localSizeBytes ? ` (${formatStateBytes(reconcileProgress.localSizeBytes)})` : ''} (${reconcileProgress.index}/${reconcileProgress.total})…`
                  : reconcileRunning
                    ? 'Pushing…'
                    : 'Push local state to NAS backup'
                return (
                <div style={{ background: '#fff5e0', border: '1px solid #d6b34e', borderRadius: 6, padding: '10px 12px', marginBottom: 12, fontSize: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, color: '#7a5a10' }}>
                    {stateConflictInfo.conflicts.length} local file{stateConflictInfo.conflicts.length === 1 ? '' : 's'} newer than NAS backup — not yet mirrored
                    {pushTotalBytes > 0 ? ` (~${formatStateBytes(pushTotalBytes)} to copy)` : ''}:
                  </div>
                  <ul style={{ margin: '0 0 8px 18px', padding: 0, color: '#3a3a3a' }}>
                    {stateConflictInfo.conflicts.map(c => (
                      <li key={c.file}>
                        <code>{c.file}</code>
                        {c.localSizeBytes > 0 ? ` (${formatStateBytes(c.localSizeBytes)})` : ''}
                        {' '}— local +{Math.round((c.localMtimeMs - c.nasMtimeMs) / 1000)}s newer
                      </li>
                    ))}
                  </ul>
                  <p className="imp-help" style={{ marginTop: 0, marginBottom: 8, fontSize: 11, color: '#7a5a10' }}>
                    Copies run one file at a time over SMB to the Synology; large files (especially <code>embeddings.bin</code>) dominate wait time. The UI stays responsive — this runs in the main process, not the renderer.
                  </p>
                  <button
                    type="button"
                    onClick={reconcileStateNow}
                    disabled={reconcileRunning}
                    style={{
                      padding: '5px 12px', fontSize: 12,
                      cursor: reconcileRunning ? 'default' : 'pointer',
                    }}
                  >
                    {reconcileLabel}
                  </button>
                  <span style={{ marginLeft: 10, color: '#7a5a10', fontSize: 11 }}>
                    (Files ≥64 KB: NAS copy saved to <code>.reconcile-bak/</code> first.)
                  </span>
                </div>
                )
              })()}

              {/* 4.5.0-87 — RAG (per-track embeddings) status + manual
                  backfill. First Phase 1 hook is musicman-chat (replaces
                  the giant pre-computed digest with retrieval-grounded
                  context). Indexing costs ≈ $0.50 one-time at OpenAI's
                  text-embedding-3-small rate. Per-query embedding cost
                  is sub-penny. */}
              <div style={{ borderTop: '1px solid #d0d0d0', margin: '20px 0 14px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: '#3a3a3a', fontWeight: 600 }}>AI library index (RAG):</span>
                <span style={{ color: '#3a3520', fontFamily: 'var(--font-mono, monospace)' }}>
                  {!embedStatus ? '—'
                    : !embedStatus.configured ? 'OPENAI_API_KEY not set'
                    : embedRunning && embedProgress
                      ? `embedding ${embedProgress.done.toLocaleString()} / ${embedProgress.total.toLocaleString()}…`
                      : embedStatus.stale > 0
                        ? `${Math.min(embedStatus.count, embedStatus.total).toLocaleString()} / ${embedStatus.total.toLocaleString()} indexed (${embedStatus.stale.toLocaleString()} stale — re-index to prune)`
                        : `${embedStatus.count.toLocaleString()} / ${embedStatus.total.toLocaleString()} tracks indexed`}
                </span>
              </div>
              <p className="imp-help" style={{ marginTop: 0, marginBottom: 10 }}>
                Per-track semantic index that lets Music Man retrieve the actually-relevant tracks per question instead of guessing from a summary. One-time embedding ≈ $0.50 (OpenAI text-embedding-3-small); per-query cost is negligible.
              </p>
              <button
                type="button"
                onClick={runEmbeddingBackfill}
                disabled={embedRunning || !embedStatus?.configured}
                style={{
                  padding: '6px 14px',
                  fontSize: 13,
                  marginBottom: 14,
                  cursor: embedRunning || !embedStatus?.configured ? 'default' : 'pointer',
                  opacity: !embedStatus?.configured ? 0.5 : 1,
                }}
              >
                {embedRunning
                  ? 'Indexing…'
                  : embedStatus && embedStatus.stale > 0
                    ? `Re-index library (${embedStatus.stale.toLocaleString()} stale)`
                    : embedStatus && embedStatus.count < embedStatus.total
                      ? `Index ${(embedStatus.total - embedStatus.count).toLocaleString()} missing tracks`
                      : 'Re-index library'}
              </button>

              {/* 4.4.13 — Inbox auto-import. Lets users point Qobuz (or any
                  other downloader) at a folder and have JakeTunes pick up
                  new files automatically, eliminating the manual drag step. */}
              <div style={{ borderTop: '1px solid #d0d0d0', margin: '20px 0 14px' }} />

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={draft.inbox.enabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    inbox: { ...draft.inbox, enabled: e.target.checked },
                  })}
                />
                <span>Auto-import from inbox folder</span>
              </label>

              <div style={{ opacity: draft.inbox.enabled ? 1 : 0.4, transition: 'opacity 0.15s' }}>
                <label style={{ display: 'block', fontSize: 12, color: '#3a3a3a', marginBottom: 4 }}>
                  Inbox folder
                </label>
                <input
                  type="text"
                  value={draft.inbox.path}
                  placeholder={defaultInboxPath || '~/Music2/_inbox'}
                  disabled={!draft.inbox.enabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    inbox: { ...draft.inbox, path: e.target.value },
                  })}
                  style={{ width: '100%', padding: 6, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                />
                <p className="imp-help" style={{ marginTop: 8 }}>
                  Any audio file dropped here (or downloaded into it by Qobuz Downloader) gets
                  imported automatically using your default format above. The original is deleted
                  after a successful import — the iPod_Control copy is the canonical one. Leave
                  blank to use {defaultInboxPath || '~/Music2/_inbox'}.
                </p>
              </div>
            </>
          )}

          {tab === 'Sync' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.sync.autoSyncOnConnect}
                  onChange={(e) => setDraft({
                    ...draft,
                    sync: { ...draft.sync, autoSyncOnConnect: e.target.checked },
                  })}
                />
                <span>Automatically sync to iPod when connected</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.sync.autoRemoveDeletedFromIpod}
                  onChange={(e) => setDraft({
                    ...draft,
                    sync: { ...draft.sync, autoRemoveDeletedFromIpod: e.target.checked },
                  })}
                />
                <span>Automatically remove deleted tracks from iPod</span>
              </label>
              <p className="imp-help" style={{ marginTop: 10 }}>
                When off, both flows still work — they just require an explicit click. Turn on for set-and-forget syncing.
              </p>

              {/* 4.5 — Library backups to homemini. Pulled out of the
                  now-playing pill (was a chirp on every import / metadata
                  / playlist save, became visual noise). Lives here as a
                  passive read-out: last time, what it was for, whether
                  it succeeded. Failures still chirp the pill in real time. */}
              <div style={{
                marginTop: 22,
                padding: '12px 14px',
                background: '#f5f1e2',
                border: '1px solid #d8cda8',
                borderRadius: 6,
              }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                  Library backups to homemini
                </div>
                {!lastSync ? (
                  <div style={{ fontSize: 12, color: '#7a7560' }}>Loading…</div>
                ) : !lastSync.scriptPresent ? (
                  <div style={{ fontSize: 12, color: '#7a7560' }}>
                    Homemini sync is not configured on this machine.
                  </div>
                ) : lastSync.at === null ? (
                  <div style={{ fontSize: 12, color: '#7a7560' }}>
                    No backup yet this session — runs automatically when imports, edits, or playlists change (and every 10 min as a safety net).
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#3a3520' }}>
                    <div>
                      <span style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        marginRight: 8,
                        background: lastSync.ok ? '#4a8a4a' : '#c44a3a',
                        verticalAlign: 'middle',
                      }} />
                      Last backup <strong>{formatRelative(lastSync.at)}</strong>
                      <span style={{ color: '#7a7560' }}> · {reasonLabel(lastSync.reason)}</span>
                      {lastSync.durationMs !== null && (
                        <span style={{ color: '#9a9580' }}> · {(lastSync.durationMs / 1000).toFixed(1)}s</span>
                      )}
                    </div>
                    {!lastSync.ok && lastSync.error && (
                      <div style={{ color: '#a23a2a', fontSize: 11 }}>{lastSync.error}</div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'Audio' && (
            <>
              {/* 4.4.51 — Auto-move music to another speaker during calls.
                  When a Teams/Zoom/FaceTime call grabs the mic, JakeTunes
                  shifts its own audio to the chosen speaker so you don't
                  have to pause; on hang-up it restores the previous output.
                  Per-app routing — the call itself stays on your normal
                  device. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={draft.audio.callRouteEnabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    audio: { ...draft.audio, callRouteEnabled: e.target.checked },
                  })}
                />
                <span>Move music to another speaker during calls</span>
              </label>

              <div style={{ opacity: draft.audio.callRouteEnabled ? 1 : 0.4, transition: 'opacity 0.15s' }}>
                <label style={{ display: 'block', fontSize: 12, color: '#3a3a3a', marginBottom: 4 }}>
                  Speaker to use during calls
                </label>
                <select
                  value={draft.audio.callRouteDeviceLabel}
                  disabled={!draft.audio.callRouteEnabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    audio: { ...draft.audio, callRouteDeviceLabel: e.target.value },
                  })}
                  style={{ width: '100%', padding: 6, fontSize: 13 }}
                >
                  <option value="">— Select a speaker —</option>
                  {audioDevices
                    .filter(d => d.transport !== 'builtin')
                    .map(d => (
                      <option key={d.id} value={d.name}>
                        {d.name}{transportHint(d.transport)}
                      </option>
                    ))}
                  {draft.audio.callRouteDeviceLabel &&
                    !audioDevices.some(d => d.name === draft.audio.callRouteDeviceLabel) && (
                      <option value={draft.audio.callRouteDeviceLabel}>
                        {draft.audio.callRouteDeviceLabel} (not connected)
                      </option>
                    )}
                </select>
                <p className="imp-help" style={{ marginTop: 8 }}>
                  When a call starts (your mic goes live), music jumps to this speaker so the
                  call audio has your built-in output to itself. Music returns to your normal
                  output when the call ends.
                </p>
                <p className="imp-help" style={{ marginTop: 4, fontSize: 10, color: '#888' }}>
                  AirPlay speakers have a built-in ~2-second delay — that's a property of AirPlay
                  itself, not JakeTunes. Bluetooth or a wired/USB speaker switches instantly.
                </p>
              </div>
            </>
          )}

          {tab === 'AI' && (
            <>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#3a3a3a' }}>
                Default host
              </label>
              <div style={{ display: 'flex', gap: 16, marginBottom: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="radio"
                    name="ai-host"
                    checked={(draft.ai.aiHost ?? 'mm') === 'mm'}
                    onChange={() => setDraft({
                      ...draft,
                      ai: { ...draft.ai, aiHost: 'mm' },
                    })}
                  />
                  <span>The Music Man</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="radio"
                    name="ai-host"
                    checked={draft.ai.aiHost === 'megan'}
                    onChange={() => setDraft({
                      ...draft,
                      ai: { ...draft.ai, aiHost: 'megan' },
                    })}
                  />
                  <span>Megan</span>
                </label>
              </div>
              <p className="imp-help" style={{ marginTop: 0, marginBottom: 16 }}>
                Sets the persona + voice for chat, picks, recommendations, and DJ Set commentary. Each host has distinct taste and opinions — they disagree on almost everything. Radio Mode co-hosts both regardless of this setting.
              </p>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.ai.musicManVoiceEnabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    ai: { ...draft.ai, musicManVoiceEnabled: e.target.checked },
                  })}
                />
                <span>Voice (ElevenLabs)</span>
              </label>
              <p className="imp-help" style={{ marginTop: 0, marginBottom: 16 }}>
                When off, your selected host chats in text only. Saves ElevenLabs credits on quiet days.
              </p>

              {/* 4.5: Exa.ai key. Powers semantic music-journalism
                  search that augments every character call's facts
                  block. Optional — empty string disables the feature
                  and behavior reverts to Wikipedia + MusicBrainz only. */}
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#3a3a3a' }}>
                Exa.ai API key (optional — augments artist facts)
              </label>
              <input
                type="password"
                placeholder="sk-…"
                value={draft.ai.exaApiKey || ''}
                onChange={(e) => setDraft({
                  ...draft,
                  ai: { ...draft.ai, exaApiKey: e.target.value },
                })}
                style={{ width: '100%', padding: 6, fontSize: 12, fontFamily: 'monospace', marginBottom: 6 }}
              />
              <p className="imp-help" style={{ marginTop: 0, marginBottom: 16 }}>
                When set, Music Man / Megan / Stephen / chat all get
                richer per-track facts via Exa semantic search (Pitchfork,
                Stereogum, AllMusic, music press generally). 7-day cache,
                ~$0.005 per artist lookup. Edit the query templates in
                <code>src/main/exa.ts</code> to tune what Exa retrieves.
              </p>

              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#3a3a3a' }}>
                Daily Claude API call ceiling
              </label>
              <input
                type="number"
                min={1}
                max={10000}
                step={10}
                value={draft.ai.claudeDailyCeiling}
                onChange={(e) => setDraft({
                  ...draft,
                  ai: { ...draft.ai, claudeDailyCeiling: Math.max(1, Math.min(10000, Number(e.target.value) || DEFAULT_APP_SETTINGS.ai.claudeDailyCeiling)) },
                })}
                style={{ width: 120, padding: 6, fontSize: 13 }}
              />
              <p className="imp-help" style={{ marginTop: 10 }}>
                Hard cap on how many Claude calls JakeTunes makes per day. After hitting the ceiling, fallback uses the most recent cached response.
              </p>
            </>
          )}

          {error && (
            <div className="imp-result imp-result--error" style={{ marginTop: 16 }}>{error}</div>
          )}
        </div>

        <div className="imp-footer">
          <button className="imp-btn imp-btn--cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="imp-btn imp-btn--start" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

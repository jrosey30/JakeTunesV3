import { useEscape } from '../hooks/useKeyboard'
import { useEffect, useState, useCallback, useRef } from 'react'
import { AppSettings, DEFAULT_APP_SETTINGS, ImportFormatChoice } from '../types'
import { IMPORT_FORMATS, IMPORT_FORMAT_LABELS } from '../../common/import-format'
import { EQ_BAND_FREQUENCIES, EQ_PRESETS } from '../audio/eq'
import { getCorrelation, setEnhanceConfig } from '../audio/audioEnhance'
import { getCaptionsOn, setCaptionsOn, setNotice } from '../activity'
import '../styles/import-convert.css'
import MusicSourcesPanel from './MusicSourcesPanel'
import ConfirmDialog from './ConfirmDialog'
import LibraryStatsSection from './LibraryStatsSection'
import CloseButton from './CloseButton'

/**
 * App-level user preferences. Tabbed layout (Playback / EQ / Library /
 * Music Sources / Backups / Storage / Audio / AI). Words are for Jake, not
 * for engineers: settings-plain-words.test.ts keeps the internal names out. Reuses the import-convert.css modal shell so we don't grow a
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
  /** A setting saved on its own while Preferences stays open (Bring back turns offload off). */
  onApplied?: (next: AppSettings) => void
  /** Open on a given tab (a notice deep-links to Music Sources). */
  initialTab?: Tab
}

// V7: Sync was only ever about backups, so it says so; Storage holds the one
// offload switch and, folded away under Advanced, the few engineer controls
// still worth having.
export type SettingsTab = 'Playback' | 'EQ' | 'Library' | 'Music Sources' | 'Backups' | 'Storage' | 'Audio' | 'AI'
type Tab = SettingsTab
const TABS: Tab[] = ['Playback', 'EQ', 'Library', 'Music Sources', 'Backups', 'Storage', 'Audio', 'AI']

// Pretty Hz labels for the band frequencies (31, 62, 125, 250, 500,
// 1000, 2000, 4000, 8000, 16000). Anything ≥1k becomes "1k" / "16k".
/**
 * Live L/R correlation meter. Width tuning was guesswork by ear; this is the
 * number that says when wide became broken: >0.5 safe, 0.3–0.5 getting wide,
 * <0.3 mono compatibility is gone. Polls ~8 Hz only while mounted (the EQ tab).
 */
function CorrelationMeter() {
  const [corr, setCorr] = useState(1)
  useEffect(() => {
    const t = setInterval(() => setCorr(getCorrelation()), 120)
    return () => clearInterval(t)
  }, [])
  const pct = Math.max(0, Math.min(100, ((corr + 1) / 2) * 100))
  const color = corr >= 0.5 ? '#4c8a3f' : corr >= 0.3 ? '#b07a2a' : '#c0392b'
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#8d867a', marginBottom: 3 }}>
        <span>L/R correlation</span>
        <span style={{ color, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{corr.toFixed(2)}</span>
      </div>
      <div style={{ position: 'relative', height: 8, background: '#e8e4dc', borderRadius: 4, overflow: 'hidden' }}>
        {/* danger zone shading below 0.3 (left of 65%) */}
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '65%', background: 'rgba(192,57,43,0.10)' }} />
        <div style={{ position: 'absolute', left: `calc(${pct}% - 2px)`, top: 0, bottom: 0, width: 4, background: color, borderRadius: 2, transition: 'left var(--motion-instant) linear' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#b3ab9d', marginTop: 2 }}>
        <span>−1 · out of phase</span><span>0.3</span><span>+1 · mono</span>
      </div>
    </div>
  )
}

/** "Check first" in one line: how many can move now, how many can't yet. */
export function countsLine(c: { ready: number; notYet: number; alreadyMoved: number }): string {
  const songs = (n: number): string => (n === 1 ? 'one song' : `${n.toLocaleString()} songs`)
  const parts = [`${songs(c.ready)} can move now`]
  if (c.notYet) parts.push(`${songs(c.notYet)} can’t yet`)
  if (c.alreadyMoved) parts.push(`${songs(c.alreadyMoved)} already moved`)
  return parts.join(', ') + '.'
}

function bandLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz)
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

// The one import format (common/import-format.ts): drag and drop, File ›
// Import, Import and Convert and CD import all use this setting.
const FORMAT_OPTIONS: { value: ImportFormatChoice; label: string }[] =
  IMPORT_FORMATS.map((value) => ({ value, label: IMPORT_FORMAT_LABELS[value] }))

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
    case 'artwork':       return 'New artwork'
    case 'startup':       return 'Catch-up after launch'
    case 'taste':         return 'Taste choices'
    case 'manual':        return 'Manual'
    default:              return reason || 'Backup'
  }
}

interface LastSync {
  ok: boolean | null
  reason: string | null
  at: number | null
  durationMs: number | null
  error: string | null
  scriptPresent: boolean
  deferredAt?: number | null
  remote?: boolean
}

export default function SettingsModal({ initial, onClose, onSaved, onApplied, initialTab }: Props) {
  // The width/crossfeed sliders apply LIVE while dragging (tuning by ear needs
  // to be audible), so Cancel must put the sound back the way it was. Wrap
  // onClose: revert the audio chain to the settings the modal OPENED with.
  // Save overwrites `initial` upstream, so the saved path stays live.
  const closeAndRevertAudio = () => {
    setEnhanceConfig(initial.audio)
    onClose()
  }
  // Escape is Cancel: the sound goes back the way it was.
  useEscape('settings', true, closeAndRevertAudio)

  const [draft, setDraft] = useState<AppSettings>(initial)
  const [radioCaptions, setRadioCaptions] = useState(getCaptionsOn())  // 4.5 radioV2 CC toggle
  const [tab, setTab] = useState<Tab>(initialTab ?? 'Playback')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Spotify connect (AI tab) — status loads when the tab opens.
  const [spotify, setSpotify] = useState<{ ok: boolean; hasClientId: boolean; connected: boolean; connectedAt?: string; lastPullAt?: string; redirectUri: string } | null>(null)
  const [spotifyClientId, setSpotifyClientId] = useState('')
  const [spotifyBusy, setSpotifyBusy] = useState(false)
  const [spotifyMsg, setSpotifyMsg] = useState('')
  useEffect(() => {
    if (tab === 'AI' && !spotify) void window.electronAPI.spotifyStatus().then(setSpotify).catch(() => {})
  }, [tab, spotify])
  // 4.4.13: resolved default path (~/Music2/_inbox) used as the placeholder
  // for the inbox folder input. Comes from main since renderer doesn't
  // know the user's homedir without a separate IPC.
  const [defaultInboxPath, setDefaultInboxPath] = useState<string>('')
  // 4.5: snapshot of the last laptop → homemini sync. Pulled on open and
  // refreshed every 15s while the modal stays open so the relative time
  // string ("3 min ago") stays roughly accurate without push wiring.
  const [lastSync, setLastSync] = useState<LastSync | null>(null)
  // 4.5.0-117 — local library snapshots (Phase 0 backup/restore).
  const [backups, setBackups] = useState<Array<{ file: string; date: string; trackCount: number; sizeBytes: number; reason: string }>>([])
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  useEffect(() => {
    if (tab !== 'Backups') return
    window.electronAPI.listBackups?.().then((r) => { if (r?.ok) setBackups(r.backups) }).catch(() => { /* leave list */ })
  }, [tab])
  const loadBackups = () => window.electronAPI.listBackups?.().then((r) => { if (r?.ok) setBackups(r.backups) }).catch(() => {})
  const handleCreateBackup = async () => {
    setBackupBusy(true); setBackupMsg(null)
    try {
      const r = await window.electronAPI.createBackup?.()
      if (r?.ok) { setBackupMsg('Backed up.'); await loadBackups() } else setBackupMsg("Couldn't back up.")
    } finally { setBackupBusy(false) }
  }
  const handleRestore = async (file: string) => {
    setBackupBusy(true); setBackupMsg(null)
    try {
      const r = await window.electronAPI.restoreBackup?.(file)
      setBackupMsg(r?.ok ? `Restored ${(r.trackCount ?? 0).toLocaleString()} songs. Your library is reloading.` : "Couldn't restore.")
    } finally { setBackupBusy(false) }
  }
  // 4.4.51: audio output devices for the call-route speaker picker. The
  // call-route feature moves music to a chosen speaker (e.g. an AirPlay
  // device) when a call grabs the mic, then restores it on hang-up.
  const [audioDevices, setAudioDevices] = useState<
    { id: number; name: string; transport: string; isDefault: boolean }[]
  >([])
  // Storage › Advanced: covers Jake set by hand (one small read).
  const [artworkLockCount, setArtworkLockCount] = useState<number | null>(null)
  // Storage › Advanced: the Music Man's song index. The nightly check keeps it
  // current; "Update now" is the same run.
  const [embedStatus, setEmbedStatus] = useState<{ configured: boolean; count: number; total: number; stale: number } | null>(null)
  const [embedRunning, setEmbedRunning] = useState(false)
  const [embedProgress, setEmbedProgress] = useState<{ done: number; total: number } | null>(null)
  // Storage › Advanced: changes on this Mac not yet in the backup copy, and
  // the button that copies them.
  const [stateConflictInfo, setStateConflictInfo] = useState<{
    mode: string
    nasDir: string
    localDir: string
    nasMounted: boolean
    conflicts: Array<{ file: string; localMtimeMs: number; nasMtimeMs: number; localPath: string; nasPath: string; localSizeBytes: number }>
  } | null>(null)
  const [reconcileRunning, setReconcileRunning] = useState(false)

  // Storage: "Check first" counts; turning the switch on counts and asks
  // (a native confirm naming the count, main/ipc/offload-ipc.ts); Save starts.
  const [offloadBusy, setOffloadBusy] = useState(false)
  const [offloadMsg, setOffloadMsg] = useState<string | null>(null)
  const [confirmBringBack, setConfirmBringBack] = useState(false)
  const [bringBackMsg, setBringBackMsg] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<{ file: string; date: string; trackCount: number } | null>(null)

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
    }, 0)
    return () => window.clearTimeout(t)
  }, [tab])

  const storageDataLoaded = useRef(false)
  useEffect(() => {
    if (tab !== 'Storage' || storageDataLoaded.current) return
    storageDataLoaded.current = true
    window.electronAPI.getArtworkLockCount?.().then(r => {
      if (r?.ok) setArtworkLockCount(r.count)
    }).catch(() => { /* leave null */ })
    window.electronAPI.getStateConflicts?.().then(setStateConflictInfo).catch(() => { /* leave null */ })
    window.electronAPI.embeddingStatus?.().then(setEmbedStatus).catch(() => { /* leave null */ })
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
    if (tab !== 'Backups') return
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
    if (tab !== 'Storage') return
    const unsub = window.electronAPI.onEmbeddingBackfillProgress?.((p) => setEmbedProgress(p))
    return () => { if (unsub) unsub() }
  }, [tab])

  const reconcileStateNow = useCallback(async () => {
    setReconcileRunning(true)
    try {
      await window.electronAPI.reconcileStateConflicts?.()
      const fresh = await window.electronAPI.getStateConflicts?.()
      if (fresh) setStateConflictInfo(fresh)
    } finally {
      setReconcileRunning(false)
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
        // The switch was turned on: start moving songs now that the setting is saved.
        if (draft.library.offloadAudioToHomemini === true && initial.library.offloadAudioToHomemini !== true) {
          void window.electronAPI.offloadStart({ settingJustSaved: true }).then((r) => {
            setNotice(r.ok ? 'Moving songs to the home server, in the background.' : 'Couldn’t start. Nothing was moved.', { kind: r.ok ? 'info' : 'error' })
          }).catch(() => setNotice('Couldn’t start. Nothing was moved.', { kind: 'error' }))
        }
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
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeAndRevertAudio() }}>
      <div className="imp-modal" role="dialog" aria-modal="true" style={{ minWidth: 460 }}>
        <div className="imp-header">
          <h2>Preferences</h2>
          <CloseButton onClick={closeAndRevertAudio} />
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
                borderBottom: tab === t ? '2px solid var(--brand-orange, #FC5501)' : '2px solid transparent',
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

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <input
                  type="checkbox"
                  checked={radioCaptions}
                  onChange={(e) => {
                    const on = e.target.checked
                    setRadioCaptions(on)
                    setCaptionsOn(on)
                    void window.electronAPI.saveUiState({ radioCC: on })
                  }}
                />
                <span>Radio captions — show what the hosts are saying</span>
              </label>

              <div style={{ opacity: draft.crossfade.enabled ? 1 : 0.4, transition: 'opacity var(--motion-instant) var(--motion-ease)' }}>
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
              {/* 2026-10-30 — pause for video calls. Main-side watcher
                  (native/micwatch: CoreAudio per-process mic state) pauses
                  music when another app starts using the microphone and
                  resumes once the call is confirmed over. Default on. The
                  decision rules live in src/main/pause-for-calls-core.ts. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, marginBottom: 4 }}>
                <input
                  type="checkbox"
                  checked={draft.calls?.pauseForCalls ?? DEFAULT_APP_SETTINGS.calls.pauseForCalls}
                  onChange={(e) => setDraft({
                    ...draft,
                    calls: { ...DEFAULT_APP_SETTINGS.calls, ...draft.calls, pauseForCalls: e.target.checked },
                  })}
                />
                <span>Pause for video calls</span>
              </label>
              <p className="imp-help" style={{ marginTop: 0 }}>
                Pauses when a call starts (FaceTime, Zoom, Teams, Webex, Meet…) and resumes when it's over.
              </p>
              {draft.audio.callRouteEnabled && draft.audio.callRouteDeviceLabel && (
                <p className="imp-help" style={{ marginTop: 4, fontSize: 10, color: '#888' }}>
                  Not used while music is set to move to {draft.audio.callRouteDeviceLabel} during calls (Audio tab) — that keeps the music going instead.
                </p>
              )}
              <p className="imp-help" style={{ marginTop: 16 }}>
                Gapless playback (preload + instant start) is always on; no setting needed.
              </p>
            </>
          )}

          {tab === 'EQ' && (
            <>
              {/* Band-split stereo width — inserted at the master output, so unlike
                  the EQ below it DOES affect normal (Web Audio) playback.
                  Changes apply LIVE (setEnhanceConfig on every drag) — width is
                  tuned by ear against the meter, not blind until Save. */}
              <div style={{ marginBottom: 18, paddingBottom: 16, borderBottom: '1px solid #e0ded8' }}>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, fontWeight: 600 }}>
                  <span>Stereo width</span>
                  <input
                    type="checkbox"
                    checked={draft.audio.widthOn}
                    onChange={(e) => {
                      const audio = { ...draft.audio, widthOn: e.target.checked }
                      setDraft({ ...draft, audio })
                      setEnhanceConfig(audio)
                    }}
                  />
                </label>
                {(() => {
                  // ONE slider (Jake: "can we simplify it?"). The three-band
                  // engine stays underneath; this morphs all three along the
                  // tuned curve: bass slides toward mono, body takes up to
                  // +15%, air up to +60%. 100% = the tuned preset.
                  const x = Math.max(0, Math.min(1, (draft.audio.widthHigh - 1) / 0.6))
                  const setAmount = (nx: number) => {
                    const audio = {
                      ...draft.audio,
                      widthLow: Math.round((1 - nx) * 100) / 100,
                      widthMid: Math.round((1 + 0.15 * nx) * 100) / 100,
                      widthHigh: Math.round((1 + 0.6 * nx) * 100) / 100,
                    }
                    setDraft({ ...draft, audio })
                    setEnhanceConfig(audio)
                  }
                  return (
                    <div style={{ opacity: draft.audio.widthOn ? 1 : 0.45, marginBottom: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b665e' }}>
                        <span>Amount</span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(x * 100)}%</span>
                      </div>
                      <input
                        type="range" min={0} max={1} step={0.05}
                        value={x}
                        disabled={!draft.audio.widthOn}
                        onChange={(e) => setAmount(Number(e.target.value))}
                        style={{ width: '100%' }}
                      />
                    </div>
                  )
                })()}
                <CorrelationMeter />
                <p className="imp-help" style={{ marginTop: 6 }}>
                  One knob, three registers underneath: as you push it, bass narrows to
                  mono (stable low end), the vocal band takes a gentle nudge, and the
                  air above 5 kHz opens wide — each register getting only what suits it.
                  Watch the meter — under 0.3 and you've broken mono compatibility.
                </p>
              </div>

              {/* Headphone crossfeed — separate toggle so it can be A/B'd against
                  width. Feeds each ear a little of the other channel, low-passed
                  and ~260 µs late, the way a head does it for speakers. */}
              <div style={{ marginBottom: 18, paddingBottom: 16, borderBottom: '1px solid #e0ded8' }}>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, fontWeight: 600 }}>
                  <span>Headphone crossfeed <span style={{ fontWeight: 400, color: '#8a857c' }}>— headphones only; on speakers it just narrows the image</span></span>
                  <input
                    type="checkbox"
                    checked={draft.audio.crossfeedOn}
                    onChange={(e) => {
                      const audio = { ...draft.audio, crossfeedOn: e.target.checked }
                      setDraft({ ...draft, audio })
                      setEnhanceConfig(audio)
                    }}
                  />
                </label>
                <div style={{ opacity: draft.audio.crossfeedOn ? 1 : 0.45 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b665e' }}>
                    <span>Amount</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(draft.audio.crossfeedAmount * 100)}%</span>
                  </div>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={draft.audio.crossfeedAmount}
                    disabled={!draft.audio.crossfeedOn}
                    onChange={(e) => {
                      const audio = { ...draft.audio, crossfeedAmount: Number(e.target.value) }
                      setDraft({ ...draft, audio })
                      setEnhanceConfig(audio)
                    }}
                    style={{ width: '100%' }}
                  />
                </div>
                <p className="imp-help" style={{ marginTop: 6 }}>
                  For headphones only — biggest win on hard-panned '60s/'70s mixes
                  (drums all-left, vocals all-right stops being exhausting). 100% is
                  the standard bs2b setting. Leave off on speakers; the room does this
                  for free.
                </p>
              </div>

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

              <div style={{ opacity: draft.eq.enabled ? 1 : 0.4, transition: 'opacity var(--motion-instant) var(--motion-ease)' }}>
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

          {tab === 'Music Sources' && (
            <div className="settings-music-sources">
              {/* Record Shop step 5 — provider setup lives with the other
                  preferences, not on discovery cards or the search page.
                  Links and searches stay in Record Shop → Download. */}
              <MusicSourcesPanel />
              <p style={{ margin: '10px 2px 0', fontSize: 12, color: '#666' }}>
                Searching the catalogue and pasting a link live in Record Shop → Download.
              </p>
            </div>
          )}
          {tab === 'Library' && (
            <>
              {/* 2026-10-18 — the Home's lifetime stats strip lives here now
                  (Jake: "stats move to settings"). */}
              <LibraryStatsSection />
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#3a3a3a' }}>
                Import format
              </label>
              <select
                value={draft.library.defaultImportFormat}
                onChange={(e) => setDraft({
                  ...draft,
                  library: { ...draft.library, defaultImportFormat: e.target.value as ImportFormatChoice },
                })}
                style={{ width: '100%', padding: 6, fontSize: 13 }}
              >
                {FORMAT_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="imp-help" style={{ marginTop: 10 }}>
                Used for every import: drag and drop, Import and Convert, and CDs. Lossless sources (FLAC, WAV, AIFF) convert to this format. MP3 and AAC are copied unchanged. Songs already in the library are left alone.
              </p>
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

              <div style={{ opacity: draft.inbox.enabled ? 1 : 0.4, transition: 'opacity var(--motion-instant) var(--motion-ease)' }}>
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

          {tab === 'Storage' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={draft.library.offloadAudioToHomemini === true}
                  disabled={offloadBusy}
                  onChange={(e) => {
                    if (!e.target.checked || initial.library.offloadAudioToHomemini === true) {
                      setDraft({ ...draft, library: { ...draft.library, offloadAudioToHomemini: e.target.checked } })
                      return
                    }
                    setOffloadBusy(true); setOffloadMsg('Checking…')
                    void window.electronAPI.offloadConfirm().then((r) => {
                      setOffloadMsg(r.counts ? countsLine(r.counts) : 'Couldn’t check. Nothing was changed.')
                      if (r.ok) setDraft((d) => ({ ...d, library: { ...d.library, offloadAudioToHomemini: true } }))
                    }).catch(() => setOffloadMsg('Couldn’t check. Nothing was changed.')).finally(() => setOffloadBusy(false))
                  }}
                />
                <span>Keep songs on the home server</span>
              </label>
              <p className="imp-help" style={{ marginTop: 8 }}>
                Frees space on this Mac. A song leaves this Mac only once the home server has the exact same file, and it plays the same. Turning this off stops moving songs; the ones already moved keep playing.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                <button type="button" className="imp-btn" disabled={offloadBusy} onClick={() => {
                  setOffloadBusy(true); setOffloadMsg('Checking…')
                  void window.electronAPI.offloadCheck().then((r) => setOffloadMsg(r.ok && r.counts ? countsLine(r.counts) : 'Couldn’t check. Try again later.'))
                    .catch(() => setOffloadMsg('Couldn’t check. Try again later.')).finally(() => setOffloadBusy(false))
                }}>Check first</button>
                {offloadMsg && <span style={{ color: '#555' }}>{offloadMsg}</span>}
              </div>

              {/* V7: the engineer controls, folded away in plain words. */}
              <details className="settings-advanced" style={{ marginTop: 18, borderTop: '1px solid #d0d0d0', paddingTop: 12 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#3a3a3a' }}>Advanced</summary>

                <div style={{ marginTop: 12, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span>
                    <span style={{ fontWeight: 600 }}>Backup copy: </span>
                    {!stateConflictInfo ? '—'
                      : stateConflictInfo.conflicts.length === 0 ? 'up to date.'
                      : stateConflictInfo.conflicts.length === 1 ? 'one recent change isn’t in it yet.'
                      : `${stateConflictInfo.conflicts.length} recent changes aren’t in it yet.`}
                  </span>
                  {stateConflictInfo && stateConflictInfo.conflicts.length > 0 && (
                    <button type="button" className="imp-btn" onClick={reconcileStateNow} disabled={reconcileRunning}>
                      {reconcileRunning ? 'Copying…' : 'Copy now'}
                    </button>
                  )}
                </div>

                <div style={{ marginTop: 12, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span>
                    <span style={{ fontWeight: 600 }}>The Music Man’s song index: </span>
                    {!embedStatus ? '—'
                      : !embedStatus.configured ? 'not set up on this Mac.'
                      : embedRunning && embedProgress && embedProgress.total > 0
                        ? `adding ${embedProgress.done.toLocaleString()} of ${embedProgress.total.toLocaleString()}…`
                        : `${Math.min(embedStatus.count, embedStatus.total).toLocaleString()} of ${embedStatus.total.toLocaleString()} songs.`}
                  </span>
                  {embedStatus?.configured && (
                    <button type="button" className="imp-btn" onClick={runEmbeddingBackfill} disabled={embedRunning}>
                      {embedRunning ? 'Updating…' : 'Update now'}
                    </button>
                  )}
                </div>
                <p className="imp-help" style={{ marginTop: 4 }}>It lets the Music Man find the right songs when you ask him. It updates by itself every night.</p>

                <div style={{ marginTop: 12, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>Covers you set by hand: </span>
                  {artworkLockCount === null ? '—' : artworkLockCount.toLocaleString()}
                </div>
                <p className="imp-help" style={{ marginTop: 4 }}>These are never replaced when covers are looked up again.</p>

                <div style={{ marginTop: 12, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span>{bringBackMsg ?? 'Bring every moved song back to this Mac.'}</span>
                  <button type="button" className="imp-btn" onClick={() => setConfirmBringBack(true)} disabled={bringBackMsg === 'Bringing songs back…'}>Bring back…</button>
                </div>
                {confirmBringBack && (
                  <ConfirmDialog
                    message="Bring every moved song back to this Mac?"
                    detail="They download from the home server, one at a time. It stops by itself if this Mac runs low on space."
                    confirmLabel="Bring back"
                    destructive={false}
                    onCancel={() => setConfirmBringBack(false)}
                    onConfirm={() => {
                      setConfirmBringBack(false)
                      setBringBackMsg('Bringing songs back…')
                      // Bringing them back turns the switch off first and saves it, so nothing moves them out again.
                      const off: AppSettings = { ...initial, library: { ...initial.library, offloadAudioToHomemini: false } }
                      setDraft((d) => ({ ...d, library: { ...d.library, offloadAudioToHomemini: false } }))
                      void window.electronAPI.saveAppSettings(off as unknown as Record<string, unknown>)
                        .then((saved) => {
                          // Only once the switch-off is saved: otherwise the next pass would move them out again.
                          if (!saved.ok) throw new Error('switch-off not saved')
                          onApplied?.(off)
                          return window.electronAPI.offloadBringBack()
                        }).then((r) => {
                        const n = r.restored ?? 0
                        const songs = n === 1 ? 'one song' : `${n.toLocaleString()} songs`
                        setBringBackMsg(r.ok ? `Brought back ${songs}.` : n > 0 ? `Brought back ${songs}, then stopped. Try again later.` : 'Nothing to bring back.')
                      }).catch(() => setBringBackMsg('Couldn’t bring them back. Try again later.'))
                    }}
                  />
                )}
              </details>
            </>
          )}

          {tab === 'Backups' && (
            <>
              {/* A passive read-out of the last backup to the home server:
                  when, and what it was for. Failures still show in the
                  now-playing pill as they happen. */}
              <div style={{
                marginTop: 4,
                padding: '12px 14px',
                background: '#f5f1e2',
                border: '1px solid #d8cda8',
                borderRadius: 6,
              }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                  Backups to the home server
                </div>
                {!lastSync ? (
                  <div style={{ fontSize: 12, color: '#7a7560' }}>Loading…</div>
                ) : !lastSync.scriptPresent ? (
                  <div style={{ fontSize: 12, color: '#7a7560' }}>
                    Backups to the home server aren’t set up on this Mac.
                  </div>
                ) : lastSync.at === null ? (
                  <div style={{ fontSize: 12, color: '#7a7560' }}>
                    No backup since the app opened. It backs up by itself when your library changes, and every 10 minutes.
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
                    </div>
                    {!lastSync.ok && (
                      <div style={{ color: '#a23a2a', fontSize: 11 }}>The last backup didn’t finish. It tries again by itself.</div>
                    )}
                    {lastSync.deferredAt != null && (
                      <div style={{ color: '#8a6a1a', fontSize: 11 }}>
                        Waiting since {formatRelative(lastSync.deferredAt)}. It catches up by itself.
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Snapshots of the library on this Mac, and restoring one. */}
              <div style={{ marginTop: 18, padding: '12px 14px', background: '#eef2f6', border: '1px solid #c5d2dd', borderRadius: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>Snapshots on this Mac</span>
                  <button
                    disabled={backupBusy}
                    onClick={handleCreateBackup}
                    style={{ fontSize: 12, padding: '4px 12px', border: '1px solid #9bb0c2', borderRadius: 4, background: '#fff', cursor: backupBusy ? 'default' : 'pointer' }}
                  >Back up now</button>
                </div>
                <p className="imp-help" style={{ marginTop: 0, marginBottom: 8, fontSize: 11 }}>
                  Your library is saved here as it changes (the newest 20). Restoring one saves today’s library first, so you can undo it.
                </p>
                {backupMsg && (
                  <div style={{ fontSize: 12, marginBottom: 8, color: backupMsg.startsWith("Couldn't") ? '#a23a2a' : '#2a7a2a' }}>{backupMsg}</div>
                )}
                {backups.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#7a8590' }}>No snapshots yet. They appear as your library changes.</div>
                ) : (
                  <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #d5dee6', borderRadius: 4, background: '#fff' }}>
                    {backups.map((b) => (
                      <div key={b.file} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid #eef2f5', fontSize: 12 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: '#2a2a2a' }}>{new Date(b.date).toLocaleString()} · <strong>{b.trackCount.toLocaleString()}</strong> songs</div>
                        </div>
                        <button disabled={backupBusy} onClick={() => setConfirmRestore({ file: b.file, date: b.date, trackCount: b.trackCount })} style={{ fontSize: 11, padding: '2px 10px', border: '1px solid #b0b0b0', borderRadius: 4, background: '#fff', cursor: 'pointer', flexShrink: 0 }}>Restore…</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* The standard confirm: Cancel on the left, Restore on the right. */}
              {confirmRestore && (
                <ConfirmDialog
                  message="Restore this snapshot?"
                  detail={`Your library goes back to ${new Date(confirmRestore.date).toLocaleString()} (${confirmRestore.trackCount.toLocaleString()} songs). Today’s library is saved first, so you can undo it.`}
                  confirmLabel="Restore"
                  onCancel={() => setConfirmRestore(null)}
                  onConfirm={() => { const f = confirmRestore.file; setConfirmRestore(null); void handleRestore(f) }}
                />
              )}
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

              <div style={{ opacity: draft.audio.callRouteEnabled ? 1 : 0.4, transition: 'opacity var(--motion-instant) var(--motion-ease)' }}>
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
                    checked={draft.ai.aiHost === 'larry'}
                    onChange={() => setDraft({
                      ...draft,
                      ai: { ...draft.ai, aiHost: 'larry' },
                    })}
                  />
                  <span>Larry</span>
                </label>
              </div>
              <p className="imp-help" style={{ marginTop: 0, marginBottom: 16 }}>
                Who talks to you in chat, picks and DJ sets. They disagree on almost everything. Radio Mode always has both.
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

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.ai.larryChimesIn !== false}
                  onChange={(e) => setDraft({
                    ...draft,
                    ai: { ...draft.ai, larryChimesIn: e.target.checked },
                  })}
                />
                <span>Larry chimes in</span>
              </label>
              <p className="imp-help" style={{ marginTop: 0, marginBottom: 16 }}>
                When you ask the Music Man with the mic, Larry may add one line after him. Only when he has something to say, and never every time.
              </p>

              {/* 4.5: Exa.ai key. Powers semantic music-journalism
                  search that augments every character call's facts
                  block. Optional — empty string disables the feature
                  and behavior reverts to Wikipedia + MusicBrainz only.
                  The raw key is never returned by load-app-settings;
                  exaConfigured tells us one is already stored in main. */}
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#3a3a3a' }}>
                Exa.ai API key (optional — augments artist facts)
              </label>
              <input
                type="password"
                placeholder={draft.ai.exaConfigured ? '•••• configured — paste a new key to replace' : 'sk-…'}
                value={draft.ai.exaApiKey || ''}
                onChange={(e) => setDraft({
                  ...draft,
                  ai: { ...draft.ai, exaApiKey: e.target.value, clearExaKey: false },
                })}
                style={{ width: '100%', padding: 6, fontSize: 12, fontFamily: 'monospace', marginBottom: 6 }}
              />
              {draft.ai.exaConfigured && (
                <button
                  type="button"
                  className="imp-btn"
                  style={{ marginBottom: 8, fontSize: 12 }}
                  onClick={() => setDraft({
                    ...draft,
                    ai: { ...draft.ai, exaApiKey: '', exaConfigured: false, clearExaKey: true },
                  })}
                >
                  Clear stored Exa key
                </button>
              )}
              <p className="imp-help" style={{ marginTop: 0, marginBottom: 16 }}>
                When set, the Music Man, Larry and Stephen get more facts
                about each artist from music writing on the web (Pitchfork,
                Stereogum, AllMusic). About half a cent per artist, kept for
                a week. The key stays on this Mac.
              </p>

              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#3a3a3a' }}>
                Most questions to the hosts in a day
              </label>
              <input
                type="number"
                min={1}
                max={2000}
                step={10}
                value={draft.ai.claudeDailyCeiling}
                onChange={(e) => setDraft({
                  ...draft,
                  ai: { ...draft.ai, claudeDailyCeiling: Math.max(1, Math.min(2000, Number(e.target.value) || DEFAULT_APP_SETTINGS.ai.claudeDailyCeiling)) },
                })}
                style={{ width: 120, padding: 6, fontSize: 13 }}
              />
              <p className="imp-help" style={{ marginTop: 10 }}>
                Up to 2,000. After that, the hosts answer with what they last said.
              </p>
              {/* Spotify — Discover Weekly into the brain (greenlit 2026-07-14).
                  One-time setup: free dev app at developer.spotify.com with
                  the exact redirect URI shown, paste the Client ID, Connect. */}
              <div style={{ marginTop: 22, padding: '12px 14px', background: '#f5f1e2', borderRadius: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Spotify — Discover Weekly</div>
                {spotify && spotify.connected ? (
                  <>
                    <p className="imp-help" style={{ marginBottom: 8 }}>
                      Connected{spotify.connectedAt ? ` since ${new Date(spotify.connectedAt).toLocaleDateString()}` : ''}.
                      {spotify.lastPullAt ? ` Last pull ${new Date(spotify.lastPullAt).toLocaleString()}.` : ' No pull yet.'}
                      {' '}Weekly taste signal: your Spotify listening feeds the Record Shop's anchors.
                    </p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="imp-btn" disabled={spotifyBusy} onClick={() => { void (async () => {
                        setSpotifyBusy(true); setSpotifyMsg('Pulling…')
                        const r = await window.electronAPI.spotifyPullNow()
                        setSpotifyMsg(r.ok ? `Pulled ${r.tracks ?? 0} tracks · top: ${(r.topArtists ?? []).slice(0, 3).join(', ')}` : (r.error || 'Pull failed'))
                        setSpotifyBusy(false)
                      })() }}>Pull now</button>
                      <button className="imp-btn" disabled={spotifyBusy} onClick={() => { void (async () => {
                        await window.electronAPI.spotifyDisconnect()
                        setSpotify(await window.electronAPI.spotifyStatus())
                        setSpotifyMsg('Disconnected.')
                      })() }}>Disconnect</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="imp-help" style={{ marginBottom: 8 }}>
                      One-time setup: create a free app at developer.spotify.com with redirect URI
                      {' '}<code style={{ userSelect: 'all' }}>{spotify?.redirectUri || 'http://127.0.0.1:48213/callback'}</code>,
                      paste its Client ID here, then Connect (opens Spotify login once).
                    </p>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="text"
                        placeholder="Client ID"
                        value={spotifyClientId}
                        onChange={(e) => setSpotifyClientId(e.target.value)}
                        style={{ flex: 1, padding: 6, fontSize: 12, fontFamily: 'monospace' }}
                      />
                      <button className="imp-btn" disabled={spotifyBusy || !spotifyClientId.trim()} onClick={() => { void (async () => {
                        setSpotifyBusy(true); setSpotifyMsg('')
                        const set = await window.electronAPI.spotifySetClientId(spotifyClientId)
                        if (!set.ok) { setSpotifyMsg(set.error || 'Bad Client ID'); setSpotifyBusy(false); return }
                        setSpotifyMsg('Waiting for Spotify login in your browser…')
                        const r = await window.electronAPI.spotifyConnect()
                        setSpotifyMsg(r.ok ? 'Connected.' : (r.error || 'Connect failed'))
                        setSpotify(await window.electronAPI.spotifyStatus())
                        setSpotifyBusy(false)
                      })() }}>Connect</button>
                    </div>
                  </>
                )}
                {spotifyMsg && <p className="imp-help" style={{ marginTop: 8 }}>{spotifyMsg}</p>}
              </div>
            </>
          )}

          {error && (
            <div className="imp-result imp-result--error" style={{ marginTop: 16 }}>{error}</div>
          )}
        </div>

        <div className="imp-footer">
          <button className="imp-btn imp-btn--cancel" onClick={closeAndRevertAudio} disabled={saving}>Cancel</button>
          <button className="imp-btn imp-btn--start" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

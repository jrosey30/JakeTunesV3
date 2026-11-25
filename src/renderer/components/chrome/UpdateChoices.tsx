/**
 * The status bar's update control (2026-11-14). Jake: "Don't force anything,
 * user decides in app whether he wants to update now. update later in middle
 * of night or something (user will tell you when) or skip to next week."
 *
 *   offered     Update ready: <label> · <first note ▸>  Install now · Install at… · Skip to next week
 *               (an old-style offer, `decides` false, shows Install now only: its gate installs
 *               on idle by itself and reads neither a time nor a skip)
 *   scheduled   Update installs at 3:00 AM  Change · Cancel
 *   waiting     Update waiting: the music is playing  Change · Cancel
 *   installing  Installing — back in a moment
 *
 * The notes open as a list above the bar; "Install at…" opens a day and a time
 * (3:00 AM tonight to start with, anything in the next 7 days). Plain words,
 * the bar's own type, the text-safe orange for what can be clicked. Drawn from
 * props only, so tools/render-update-choices.mjs can draw every state headless.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { UpdateReadyState } from '../../types'
import { useEscape } from '../../hooks/useKeyboard'
import { defaultInstallAt, formatInstallAt, installAtAllowed, INSTALL_AT_MAX_AHEAD_MS } from '../../../common/update-ready'

export interface UpdateChoicesProps {
  ready: UpdateReadyState
  installing: boolean
  failed: boolean
  afterSync: boolean
  now: number
  /** Install now was clicked (the bar asks to confirm). */
  onInstallNow: () => void
  onInstallAt: (at: number) => Promise<boolean>
  /** Skip to next week was clicked (the bar asks to confirm). */
  onSkip: () => void
  onCancel: () => void
  /** Open a panel at first (the headless pictures). */
  initialPanel?: 'notes' | 'at' | null
}

const KIND_WORDS: Record<UpdateReadyState['kind'], string> = { weekly: 'Weekly update', monthly: 'Monthly update', fix: 'Fix' }

/** The next 8 calendar days from today, for the day menu. */
function dayChoices(now: number): Array<{ value: string; label: string; midnight: number }> {
  const out: Array<{ value: string; label: string; midnight: number }> = []
  const base = new Date(now)
  for (let i = 0; i < 8; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)
    const name = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    out.push({ value: String(i), label: i === 0 ? `Today, ${name}` : i === 1 ? `Tomorrow, ${name}` : name, midnight: d.getTime() })
  }
  return out
}

/** Every half hour of the day, as minutes after midnight. */
const TIMES: Array<{ value: string; label: string }> = Array.from({ length: 48 }, (_, i) => {
  const m = i * 30
  const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60)
  return { value: String(m), label: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }
})

function atFrom(day: number, minutes: number): number {
  const d = new Date(day)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return d.getTime()
}

export default function UpdateChoices(p: UpdateChoicesProps) {
  const { ready } = p
  const [panel, setPanel] = useState<'notes' | 'at' | null>(p.initialPanel ?? null)
  const days = useMemo(() => dayChoices(p.now), [p.now])
  // The time the picker starts on: the one already chosen, else 3:00 AM tonight.
  const startAt = ready.at ? Date.parse(ready.at) : defaultInstallAt(p.now)
  const startDay = Math.max(0, days.findIndex((d, i) => startAt >= d.midnight && (i === days.length - 1 || startAt < days[i + 1].midnight)))
  const [day, setDay] = useState(String(startDay))
  const [time, setTime] = useState(String(new Date(startAt).getHours() * 60 + (new Date(startAt).getMinutes() >= 30 ? 30 : 0)))
  const [saving, setSaving] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!panel) return
    const onDown = (e: MouseEvent): void => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setPanel(null) }
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('mousedown', onDown) }
  }, [panel])
  useEscape('update-choices', panel !== null, () => setPanel(null))

  const openAt = (): void => {
    const s = ready.at ? Date.parse(ready.at) : defaultInstallAt(Date.now())
    const di = days.findIndex((d, i) => s >= d.midnight && (i === days.length - 1 || s < days[i + 1].midnight))
    setDay(String(Math.max(0, di)))
    setTime(String(new Date(s).getHours() * 60 + (new Date(s).getMinutes() >= 30 ? 30 : 0)))
    setPanel('at')
  }

  const chosen = atFrom(days[Number(day)]?.midnight ?? p.now, Number(time))
  const chosenOk = installAtAllowed(chosen, p.now)
  const lastAllowed = p.now + INSTALL_AT_MAX_AHEAD_MS

  const save = async (): Promise<void> => {
    if (!chosenOk || saving) return
    setSaving(true)
    const ok = await p.onInstallAt(chosen)
    setSaving(false)
    if (ok) setPanel(null)
  }

  if (p.installing) {
    return (
      <span className="statusbar-update statusbar-update--busy" aria-live="polite" title={ready.label}>
        Installing — back in a moment
      </span>
    )
  }

  const firstNote = ready.notes[0] ?? ''
  const when = ready.at ? formatInstallAt(Date.parse(ready.at), p.now) : ''

  return (
    <div className="update-choices" ref={boxRef}>
      {ready.decides && (ready.phase === 'scheduled' || ready.phase === 'waiting') ? (
        <>
          <span className="update-choices-status" aria-live="polite">
            {ready.phase === 'scheduled' ? `Update installs at ${when}` : `Update waiting: ${ready.waitingFor ?? 'not idle yet'}`}
          </span>
          <button type="button" className="update-choices-link" onClick={openAt}>Change</button>
          <button type="button" className="update-choices-link" onClick={p.onCancel}>Cancel</button>
        </>
      ) : (
        <>
          <span className="update-choices-label">{p.afterSync ? 'Install after the iPod sync' : p.failed ? 'That didn’t take — try again' : `Update ready: ${ready.label}`}</span>
          {firstNote && (
            <button type="button" className="update-choices-note" title="All the notes" onClick={() => setPanel(panel === 'notes' ? null : 'notes')}>
              <span className="update-choices-note-text">{firstNote}</span>{ready.notes.length > 1 ? ` +${ready.notes.length - 1} more` : ''}
            </button>
          )}
          <button type="button" className="update-choices-link" onClick={p.onInstallNow}>Install now</button>
          {/* An old-style gate (no release file) never reads a chosen time or a skip, and installs
              by itself when the Mac is idle: offering either would be a promise it can't keep. */}
          {ready.decides && <button type="button" className="update-choices-link" onClick={openAt}>Install at…</button>}
          {ready.decides && <button type="button" className="update-choices-link" onClick={p.onSkip}>Skip to next week</button>}
        </>
      )}

      {panel === 'notes' && (
        <div className="update-choices-panel" role="dialog" aria-label="What is in this update">
          <div className="update-choices-panel-title">{ready.label}</div>
          <div className="update-choices-panel-sub">{KIND_WORDS[ready.kind]}{ready.version ? ` · Version ${ready.version}` : ''}</div>
          <ul className="update-choices-notes">
            {ready.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      )}

      {panel === 'at' && ready.decides && (
        <div className="update-choices-panel" role="dialog" aria-label="Install at">
          <div className="update-choices-panel-title">Install at</div>
          <div className="update-choices-panel-sub">Only if nothing is playing or syncing then; otherwise as soon as it stops.</div>
          <div className="update-choices-at">
            <select aria-label="Day" value={day} onChange={(e) => setDay(e.target.value)}>
              {days.map((d) => <option key={d.value} value={d.value} disabled={d.midnight > lastAllowed}>{d.label}</option>)}
            </select>
            <select aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)}>
              {TIMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {!chosenOk && <div className="update-choices-warn">Pick a time in the next 7 days.</div>}
          <div className="update-choices-actions">
            <button type="button" className="update-choices-button" onClick={() => setPanel(null)}>Cancel</button>
            <button type="button" className="update-choices-button update-choices-button--default" disabled={!chosenOk || saving} onClick={() => { void save() }}>
              {ready.phase === 'scheduled' || ready.phase === 'waiting' ? 'Change' : 'Set'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

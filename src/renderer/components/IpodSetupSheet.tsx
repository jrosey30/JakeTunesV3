/**
 * Setting up a new iPod (2026-11-13) — the steps, one at a time, in the strip
 * above the Device page (DeviceView is do-not-touch; this sits beside it, in
 * IpodIdentityBar). Every step and every word comes from main
 * ('ipod-setup:look' → common/ipod-onboarding.ts): this only shows the step it
 * is handed and sends back what Jake picked or typed.
 *
 *   mode 'setup' — an iPod with no ID file: list → name → checks → confirm → set up
 *   mode 'tail'  — an iPod already set up: first sync, the on-device checklist,
 *                  and anything the plug-in check says must be looked at
 */
import { useEscape } from '../hooks/useKeyboard'
import { useCallback, useEffect, useState } from 'react'
import { IPOD_COLORS } from '../../common/ipod-covers'
import type { IpodSetupLook, OnboardingCheck } from '../../common/ipod-onboarding'
import { IpodModelChoices } from './IpodArtworkAsk'

type Look = Extract<IpodSetupLook, { ok: true }>
/** Notes from "Set up this iPod", shown once by the strip that follows it. */
let carriedNotes: string[] = []
const MARK: Record<OnboardingCheck['status'], string> = { ok: '✓', warn: '!', stop: '✕', unknown: '?' }

function Checks({ checks }: { checks: OnboardingCheck[] }) {
  return (
    <ul className="ipod-setup-checks">
      {checks.map((c) => (
        <li key={c.id} className={`ipod-setup-check ipod-setup-check--${c.status}`}>
          <span className="ipod-setup-mark" aria-hidden="true">{MARK[c.status]}</span>
          <span>{c.line}</span>
        </li>
      ))}
    </ul>
  )
}

export default function IpodSetupSheet({ mode, onClose }: { mode: 'setup' | 'tail'; onClose?: () => void }) {
  const [look, setLook] = useState<Look | null>(null)
  const [listId, setListId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [matchCover, setMatchCover] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Escape is Cancel (setup only, and never mid-step).
  useEscape('ipod-setup', mode === 'setup' && !!onClose && !busy, () => onClose?.())
  const [notes] = useState<string[]>(() => {
    if (mode !== 'tail') return []
    const n = carriedNotes
    carriedNotes = []
    return n
  })

  const refresh = useCallback(async (over: { listId?: string | null; name?: string; typed?: string; recheck?: boolean } = {}) => {
    const r = await window.electronAPI.ipodSetupLook?.({
      listId: mode === 'tail' ? null : over.listId !== undefined ? over.listId : listId,
      name: (over.name ?? name).trim() || null,
      typed: over.typed ?? typed,
      recheck: over.recheck === true,
    })
    if (!r) { setError('This version can’t set up iPods.'); return null }
    if (!r.ok) { setError(r.error); return null }
    setLook(r)
    return r
  }, [mode, listId, name, typed])

  // A look never writes. Once a list is picked and nothing stops the set-up, the strip asks for
  // the test file itself (its own step, its own handler), then looks again: no button for Jake.
  const settle = useCallback(async (over: { listId?: string | null; name?: string; typed?: string; recheck?: boolean } = {}) => {
    const r = await refresh(over)
    const st = r?.step
    if (st?.step === 'checks' && !st.blocked && st.checks.some((c) => c.id === 'write-test' && c.status === 'unknown')) {
      const t = await window.electronAPI.ipodSetupTest?.({ listId: over.listId !== undefined ? over.listId : listId, name: (over.name ?? name).trim() || null })
      if (t && !t.ok) setError(t.error ?? 'Couldn’t test the iPod. Try again.')
      await refresh({ ...over, recheck: false })
    }
  }, [refresh, listId, name])

  // The card check runs by itself at the proof step; it says something only when Jake must act.
  const [proof, setProof] = useState<{ status: 'pass' | 'fail' | 'waiting' | 'none'; line: string } | null>(null)
  const [same, setSame] = useState('')
  const atProof = look?.step.step === 'proof'
  useEffect(() => {
    if (!atProof) return
    let live = true
    void window.electronAPI.ipodSetupCardProof?.().then((r) => { if (live && r?.ok && r.cardProof) setProof(r.cardProof) })
    return () => { live = false }
  }, [atProof])

  useEffect(() => {
    void refresh()
    const off = window.electronAPI.onIpodDeviceChanged?.(() => { void refresh() })
    return () => { off?.() }
    // The first look only; later looks are asked for by each step's button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try { await work() } catch (err) { console.warn('[ipod-setup]', err); setError('That didn’t work. Try again.') } finally { setBusy(null) }
  }

  if (!look) return error ? <span className="ipod-id-error">{error}</span> : null
  const step = look.step
  // What stops a sync, and what the next sync is about to repair (an unreadable database).
  const stops = look.health?.checks.filter((c) => c.status === 'stop' || (c.status === 'warn' && c.id === 'database' && /can’t be read/.test(c.line))) ?? []

  if (mode === 'tail') {
    // An iPod that is set up, synced and checked says nothing here unless the plug-in check found something.
    if (step.step === 'done' && stops.length === 0) return null
    if (step.step !== 'first-sync' && step.step !== 'proof' && step.step !== 'done') return null
  }

  const pick = (id: string) => {
    setListId(id)
    const row = look.targets.find((t) => t.listId === id)
    setColor(row?.color ?? null)
    setTyped('')
    setName('')
    void run('Checking the iPod…', () => settle({ listId: id, name: '', typed: '' }))
  }

  return (
    <div className="ipod-setup">
      {stops.length > 0 && <Checks checks={stops} />}
      {look.sameIpod && (
        <form
          className="ipod-id-form"
          onSubmit={(e) => { e.preventDefault(); void run('Saving…', async () => {
            const r = await window.electronAPI.ipodSetupSameIpod?.({ typed: same })
            if (r && !r.ok) setError(r.error ?? 'Couldn’t save that. Try again.')
            else { setSame(''); await refresh() }
          }) }}
        >
          <ul className="ipod-setup-checks">
            {look.sameIpod.lines.map((l) => <li key={l} className="ipod-setup-check"><span className="ipod-setup-mark" aria-hidden="true">•</span><span>{l}</span></li>)}
          </ul>
          <label className="ipod-id-field ipod-id-field--wide">
            <span>Type “{look.sameIpod.phrase}”</span>
            <input value={same} onChange={(e) => setSame(e.target.value)} />
          </label>
          <button type="submit" className="device-itunes-btn" disabled={!!busy || !same.trim()}>This is the same iPod</button>
        </form>
      )}

      {step.step === 'refused' && <span className="ipod-id-note ipod-id-note--strong">{step.line}</span>}
      {step.step === 'refused' && step.why === 'looks-like-the-original' && (
        <div className="ipod-id-actions">
          <button
            type="button" className="device-itunes-btn" disabled={!!busy}
            onClick={() => { void run('Saving…', async () => {
              const r = await window.electronAPI.ipodSetupReadoptOriginal?.()
              if (r && !r.ok) setError(r.error ?? 'That didn’t work. Try again.')
              else onClose?.()
            }) }}
          >This is my Original</button>
        </div>
      )}

      {step.step === 'choose-list' && (
        <>
          <span className="ipod-id-note ipod-id-note--strong">{step.line}</span>
          <div className="ipod-setup-lists">
            {look.targets.map((t) => (
              <button key={t.listId} type="button" className="device-itunes-btn" disabled={!!busy} onClick={() => pick(t.listId)}>
                {t.listName} · {t.songs.toLocaleString('en-US')} songs{t.listId === step.suggestListId ? ' · this one' : ''}
              </button>
            ))}
            <button type="button" className="device-link-btn" disabled={!!busy} onClick={() => pick('new')}>A brand-new iPod</button>
          </div>
          {look.targets.length === 0 && <span className="ipod-id-note">Can’t load your iPods right now. Try again in a minute.</span>}
        </>
      )}

      {step.step === 'name' && (
        <form className="ipod-id-form" onSubmit={(e) => { e.preventDefault(); void run('Checking the iPod…', () => settle()) }}>
          <span className="ipod-id-note ipod-id-note--strong">{step.line}</span>
          <label className="ipod-id-field">
            <span>iPod name</span>
            <input value={name} maxLength={11} autoFocus onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" className="device-itunes-btn" disabled={!!busy || !name.trim()}>Next</button>
        </form>
      )}

      {step.step === 'checks' && (
        <>
          <span className="ipod-id-note ipod-id-note--strong">{step.line}</span>
          <Checks checks={step.checks} />
          {step.checks.some((c) => c.id === 'covers' && c.status === 'stop') && (
            // "Which iPod is this?" for album covers, answered before the first sync (2026-11-23).
            <span className="ipod-id-note" role="group" aria-label="Which iPod is this?">
              <IpodModelChoices
                disabled={!!busy}
                onPick={(family) => {
                  void run('Checking…', async () => {
                    const r = await window.electronAPI.ipodSetupCovers?.({ family })
                    if (!r?.ok) { setError(r?.error ?? 'Couldn’t save that. Try again.'); return }
                    await settle()
                  })
                }}
              />
            </span>
          )}
          <div className="ipod-id-actions">
            <button type="button" className="device-itunes-btn" disabled={!!busy} onClick={() => { void run('Checking…', () => settle({ recheck: true })) }}>Check again</button>
          </div>
        </>
      )}

      {step.step === 'confirm' && (
        <form className="ipod-id-form" onSubmit={(e) => { e.preventDefault(); void run('Checking…', async () => { await refresh() }) }}>
          {step.onIt.length > 0 && (
            <>
              <span className="ipod-id-note ipod-id-note--strong">On it now:</span>
              <ul className="ipod-setup-checks">
                {step.onIt.map((l) => <li key={l} className="ipod-setup-check"><span className="ipod-setup-mark" aria-hidden="true">•</span><span>{l}</span></li>)}
              </ul>
            </>
          )}
          <ul className="ipod-setup-checks">
            {step.why.map((w) => <li key={w} className="ipod-setup-check ipod-setup-check--warn"><span className="ipod-setup-mark" aria-hidden="true">!</span><span>{w}</span></li>)}
          </ul>
          <label className="ipod-id-field ipod-id-field--wide">
            <span>Type “{step.phrase}” to go on</span>
            <input value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} />
          </label>
          <button type="submit" className="device-itunes-btn" disabled={!!busy || !typed.trim()}>Next</button>
        </form>
      )}

      {step.step === 'prepare' && listId && (
        <>
          <span className="ipod-id-note ipod-id-note--strong">Ready to set up:</span>
          <ul className="ipod-setup-checks">
            {step.actions.map((a) => <li key={a} className="ipod-setup-check"><span className="ipod-setup-mark" aria-hidden="true">•</span><span>{a}</span></li>)}
          </ul>
          <label className="ipod-id-field">
            <span>iPod name</span>
            <input value={name || step.name} maxLength={11} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="ipod-id-field">
            <span>Color</span>
            <div className="ipod-id-swatches" role="radiogroup" aria-label="iPod color">
              {IPOD_COLORS.map((c) => (
                <button
                  key={c.name} type="button" role="radio" aria-checked={color === c.name} aria-label={c.name} title={c.name}
                  className={`ipod-id-swatch${color === c.name ? ' is-on' : ''}`} style={{ background: c.hex }} onClick={() => setColor(c.name)}
                />
              ))}
            </div>
          </div>
          {look.cover && (
            <label className="ipod-setup-tick">
              <input type="checkbox" checked={matchCover} onChange={(e) => setMatchCover(e.target.checked)} />
              <span>{look.cover.line}</span>
            </label>
          )}
          <div className="ipod-id-actions">
            <button
              type="button" className="device-itunes-btn" disabled={!!busy}
              onClick={() => { void run('Setting up…', async () => {
                const r = await window.electronAPI.ipodSetupPrepare?.({ listId, name: name.trim() || step.name, color, typed, matchCover })
                if (!r) { setError('This version can’t set up iPods.'); return }
                if (!r.ok) { setError(r.error ?? 'Couldn’t set up the iPod. Try again.'); await refresh(); return }
                // Something worth reading (the drive kept its old name, the picture didn't save) is
                // handed to the strip that takes over once the iPod is known.
                carriedNotes = r.notes ?? []
                onClose?.()
              }) }}
            >Set up this iPod</button>
          </div>
        </>
      )}

      {step.step === 'first-sync' && (
        <>
          <span className="ipod-id-note ipod-id-note--strong">{step.line}</span>
          {step.estimate && <span className="ipod-id-note">{step.estimate}</span>}
        </>
      )}

      {step.step === 'proof' && (
        <>
          <span className="ipod-id-note ipod-id-note--strong">{step.line}</span>
          {/* The check is in the line; the card check speaks only when Jake must act. */}
          {proof && proof.line && <span className={proof.status === 'fail' ? 'ipod-id-error' : 'ipod-id-note'}>{proof.line}</span>}
          <div className="ipod-id-actions">
            <button
              type="button" className="device-itunes-btn" disabled={!!busy || proof?.status === 'fail' || proof?.status === 'waiting'}
              onClick={() => { void run('Saving…', async () => {
                const r = await window.electronAPI.ipodSetupChecked?.()
                if (r && !r.ok) setError(r.error ?? 'Couldn’t save that. Try again.')
                await refresh()
              }) }}
            >Looks right</button>
          </div>
        </>
      )}

      {step.step === 'done' && step.lines.map((l) => <span key={l} className="ipod-id-note">{l}</span>)}

      {notes.map((n) => <span key={n} className="ipod-id-note">{n}</span>)}
      {busy && <span className="ipod-id-note">{busy}</span>}
      {error && <span className="ipod-id-error">{error}</span>}
      {mode === 'setup' && onClose && (
        <button type="button" className="device-link-btn" disabled={!!busy} onClick={onClose}>Cancel</button>
      )}
    </div>
  )
}

/**
 * The Device page's iPod format and convert cache (Brief 265 Parts 2 and 5), inside the Options
 * disclosure. The format is stored for the iPod plugged in (by its serial when it has one) and
 * read by every sync of it; the cache is the converted copies on this Mac.
 */
import { useEffect, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import type { ConvertCacheAnswer, IpodAudioProfileAnswer } from '../types'
import { CACHE_CAPS, EMPTY_COST, FORMAT_CHOICES, LIMIT_COST, changeFor, choiceOf, gb, type FormatChoice } from '../ipodFormatChoice'

export default function IpodFormatOptions() {
  const api = window.electronAPI
  const [profile, setProfile] = useState<IpodAudioProfileAnswer | null>(null)
  const [cache, setCache] = useState<ConvertCacheAnswer | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [askEmpty, setAskEmpty] = useState(false)

  useEffect(() => {
    let live = true
    api.getIpodAudioProfile?.().then((r) => { if (live) setProfile(r) }).catch(() => { if (live) setProfile(null) })
    api.getConvertCacheStatus?.().then((r) => { if (live) setCache(r) }).catch(() => { if (live) setCache(null) })
    return () => { live = false }
  }, [api])

  const ipod = profile?.ok ? profile.ipod : null
  const current = profile?.ok ? profile.profile : null

  const choose = async (choice: FormatChoice) => {
    const r = await api.setIpodAudioProfile?.(changeFor(choice, current))
    if (!r) return
    setProfile(r)
    setNote(r.ok ? 'Saved. The next sync puts each song on in this format; songs already in it stay.' : r.error)
  }
  const resetFormat = async () => {
    const r = await api.setIpodAudioProfile?.({ reset: true })
    if (r) { setProfile(r); setNote(r.ok ? 'Back to this iPod’s default.' : r.error) }
  }
  const setCap = async (raw: string) => {
    const r = await api.setConvertCacheCap?.(raw === '' ? null : Number(raw))
    if (r) setCache(r)
  }
  const empty = async () => {
    setAskEmpty(false)
    const r = await api.clearConvertCache?.()
    if (!r) return
    setNote(r.ok ? `Emptied: ${gb(r.freedBytes)} freed.` : r.error)
    const s = await api.getConvertCacheStatus?.()
    if (s) setCache(s)
  }

  return (
    <>
      {ipod && (
        <label className="device-itunes-option">
          <span>Songs go on {ipod.name} as <select
            className="device-itunes-select"
            value={choiceOf(current)}
            onChange={(e) => { void choose(e.target.value as FormatChoice) }}
          >{FORMAT_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></span>
          {profile?.ok && profile.source === 'stored' && (
            <button type="button" className="device-link-btn" onClick={() => { void resetFormat() }}>Use its default</button>
          )}
        </label>
      )}
      {cache?.ok && (
        <label className="device-itunes-option">
          <span>Converted copies on this Mac: {gb(cache.bytes)} ({cache.files.toLocaleString()}). Keep at most <select
            className="device-itunes-select"
            value={cache.capGb === null ? '' : String(cache.capGb)}
            onChange={(e) => { void setCap(e.target.value) }}
          >{CACHE_CAPS.map((c) => <option key={String(c.value)} value={c.value === null ? '' : String(c.value)}>{c.label}</option>)}</select></span>
          <button type="button" className="device-link-btn" onClick={() => setAskEmpty(true)}>Empty…</button>
        </label>
      )}
      {cache?.ok && cache.capGb !== null && <div className="device-itunes-option device-itunes-option-note">{LIMIT_COST}</div>}
      {note && <div className="device-itunes-option device-itunes-option-note" role="status">{note}</div>}
      {askEmpty && cache?.ok && (
        <ConfirmDialog
          message="Empty the converted copies?"
          detail={`${gb(cache.bytes)} on this Mac. ${EMPTY_COST}`}
          confirmLabel="Empty"
          destructive
          onConfirm={() => { void empty() }}
          onCancel={() => setAskEmpty(false)}
        />
      )}
    </>
  )
}

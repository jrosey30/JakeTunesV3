/**
 * The Device page's iPod format and convert cache (Brief 265 Parts 2 and 5), inside the Options
 * disclosure. The format is stored for the iPod plugged in (by its serial when it has one) and
 * read by every sync of it; the cache is the converted copies on this Mac. Neither Empty nor a
 * limit ever takes a copy a song on an iPod was made from.
 */
import { useEffect, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import type { ConvertCacheAnswer, IpodAudioProfileAnswer } from '../types'
import { CACHE_CAPS, EMPTY_COST, LIMIT_COST, changeFor, choiceOf, choicesFor, gb, songsCount, type FormatChoice } from '../ipodFormatChoice'

export default function IpodFormatOptions() {
  const api = window.electronAPI
  const [profile, setProfile] = useState<IpodAudioProfileAnswer | null>(null)
  const [cache, setCache] = useState<ConvertCacheAnswer | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [askEmpty, setAskEmpty] = useState(false)
  const [askCap, setAskCap] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    api.getIpodAudioProfile?.().then((r) => { if (live) setProfile(r) }).catch(() => { if (live) setProfile(null) })
    api.getConvertCacheStatus?.().then((r) => { if (live) setCache(r) }).catch(() => { if (live) setCache(null) })
    return () => { live = false }
  }, [api])

  const ipod = profile?.ok ? profile.ipod : null
  const current = profile?.ok ? profile.profile : null

  const choose = async (choice: FormatChoice) => {
    if (!ipod) return
    // Saved for the iPod this page showed; a different iPod plugged in meanwhile is refused.
    const r = await api.setIpodAudioProfile?.({ ...changeFor(choice, current), expectedId: ipod.id })
    if (!r) return
    setProfile(r)
    setNote(r.ok ? 'Saved. The next sync puts each song on in this format; songs already in it stay.' : r.error)
  }
  const resetFormat = async () => {
    if (!ipod) return
    const r = await api.setIpodAudioProfile?.({ reset: true, expectedId: ipod.id })
    if (r) { setProfile(r); setNote(r.ok ? 'Back to this iPod’s default.' : r.error) }
  }
  const applyCap = async (capGb: number | null) => {
    setAskCap(null)
    const r = await api.setConvertCacheCap?.(capGb)
    if (!r) return
    setCache(r)
    setNote(r.ok ? (r.note ?? null) : r.error)
  }
  const pickCap = (raw: string) => {
    const capGb = raw === '' ? null : Number(raw)
    // A limit below what's there now empties some copies at once: ask first.
    if (capGb !== null && cache?.ok && cache.bytes > capGb * 1e9) setAskCap(capGb)
    else void applyCap(capGb)
  }
  const empty = async () => {
    setAskEmpty(false)
    const r = await api.clearConvertCache?.()
    if (!r) return
    setNote(r.ok ? `Emptied: ${gb(r.freedBytes)} freed. ${songsCount(r.kept)} on your iPods kept.` : r.error)
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
          >{choicesFor(current).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></span>
          {profile?.ok && profile.source === 'stored' && (
            <button type="button" className="device-link-btn" onClick={() => { void resetFormat() }}>Use its default</button>
          )}
        </label>
      )}
      {cache?.ok && (
        <label className="device-itunes-option">
          <span>Converted copies on this Mac: {gb(cache.bytes)} ({songsCount(cache.files)}). Keep at most <select
            className="device-itunes-select"
            value={cache.capGb === null ? '' : String(cache.capGb)}
            onChange={(e) => pickCap(e.target.value)}
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
      {askCap !== null && cache?.ok && (
        <ConfirmDialog
          message={`Keep at most ${askCap} GB of converted copies?`}
          detail={`${gb(cache.bytes)} is there now, so some go at once. ${LIMIT_COST}`}
          confirmLabel="Set the limit"
          destructive
          onConfirm={() => { void applyCap(askCap) }}
          onCancel={() => setAskCap(null)}
        />
      )}
    </>
  )
}

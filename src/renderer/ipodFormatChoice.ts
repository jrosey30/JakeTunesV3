/**
 * The Device page's iPod format choice (Brief 265 Part 2), as plain values for a <select>.
 * Pure: node --test loads it.
 */
import type { IpodAudioProfileView } from './types'

export type FormatChoice = 'off' | 'alac' | `aac-${128 | 192 | 256 | 320}` | `mp3-${128 | 192 | 256 | 320}`

export const FORMAT_CHOICES: ReadonlyArray<{ value: FormatChoice; label: string }> = [
  { value: 'alac', label: 'Lossless (ALAC), as in the library' },
  { value: 'aac-320', label: 'AAC 320 kbps' },
  { value: 'aac-256', label: 'AAC 256 kbps' },
  { value: 'aac-192', label: 'AAC 192 kbps' },
  { value: 'aac-128', label: 'AAC 128 kbps' },
  { value: 'mp3-320', label: 'MP3 320 kbps' },
  { value: 'mp3-256', label: 'MP3 256 kbps' },
  { value: 'mp3-192', label: 'MP3 192 kbps' },
  { value: 'mp3-128', label: 'MP3 128 kbps' },
  { value: 'off', label: 'The convert setting below' },
]

/** The choice a stored or default profile shows as. No profile, or one switched off, is 'off'. */
export function choiceOf(p: IpodAudioProfileView | null): FormatChoice {
  if (!p || !p.enabled) return 'off'
  if (p.codec === 'alac') return 'alac'
  const k = [128, 192, 256, 320].includes(Number(p.kbps)) ? Number(p.kbps) : 256
  return `${p.codec}-${k}` as FormatChoice
}

/** What the page sends to save a choice. 'off' keeps the format but switches it off. */
export function changeFor(choice: FormatChoice, current: IpodAudioProfileView | null): { codec: 'alac' | 'aac' | 'mp3'; kbps?: number; enabled: boolean } {
  if (choice === 'off') {
    const keep = current ?? { codec: 'alac' as const, enabled: false }
    return { codec: keep.codec, ...(keep.codec === 'alac' ? {} : { kbps: keep.kbps ?? 256 }), enabled: false }
  }
  if (choice === 'alac') return { codec: 'alac', enabled: true }
  const [codec, kbps] = choice.split('-') as ['aac' | 'mp3', string]
  return { codec, kbps: Number(kbps), enabled: true }
}

/** "12.3 GB" */
export function gb(bytes: number): string {
  return `${(Math.max(0, bytes) / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`
}

/**
 * What emptying the cache, or a limit, costs, said plainly (Jake, 2026-11-20: an emptied cache
 * made the punkPod convert 1,190 songs again and the music popped).
 */
export const EMPTY_COST = 'Songs already on your iPods stay on them. But every song a sync has to copy is converted again first, and a full copy converts every song. On a big iPod that can take hours, and music on this Mac stutters while it runs.'
export const LIMIT_COST = 'A limit never takes the copies the songs on your iPods were made from. A song not on an iPod is converted again the next time it has to be copied, which slows music on this Mac while it runs.'

export const CACHE_CAPS: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: null, label: 'No limit (never emptied by itself)' },
  { value: 10, label: '10 GB' },
  { value: 25, label: '25 GB' },
  { value: 50, label: '50 GB' },
  { value: 100, label: '100 GB' },
]

/**
 * The Device page's iPod format choice (Brief 265 Part 2), as plain values for a <select>.
 * Pure: node --test loads it.
 */
import type { IpodAudioProfileView } from './types'

export type FormatChoice = 'off' | 'alac' | `aac-${number}` | `mp3-${number}`

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

/** The choice a stored or default profile shows as, exactly (an unusual bitrate is shown as it is). No profile, or one switched off, is 'off'. */
export function choiceOf(p: IpodAudioProfileView | null): FormatChoice {
  if (!p || !p.enabled) return 'off'
  if (p.codec === 'alac') return 'alac'
  return `${p.codec}-${Number(p.kbps) || 0}` as FormatChoice
}

/** The list to show: the standard choices, plus the stored one when it isn't among them. */
export function choicesFor(p: IpodAudioProfileView | null): ReadonlyArray<{ value: FormatChoice; label: string }> {
  const now = choiceOf(p)
  if (FORMAT_CHOICES.some((c) => c.value === now)) return FORMAT_CHOICES
  const [codec, k] = now.split('-')
  return [...FORMAT_CHOICES, { value: now, label: `${codec.toUpperCase()} ${Number(k) ? `${k} kbps` : '(no bitrate)'}, as set before` }]
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

/** "1,234 songs" */
export function songsCount(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'song' : 'songs'}`
}

/** "12.3 GB" */
export function gb(bytes: number): string {
  return `${(Math.max(0, bytes) / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`
}

/**
 * What emptying the cache, or a limit, costs, said plainly (Jake, 2026-11-20: an emptied cache
 * made the punkPod convert 1,190 songs again and the music popped).
 */
export const EMPTY_COST = 'The copies of the songs on your iPods stay. The rest go: each of those songs is converted again the next time a sync has to copy it, and music on this Mac stutters while that runs.'
export const LIMIT_COST = 'A limit never takes the copies of the songs on your iPods. Other songs are converted again the next time a sync has to copy them, and music on this Mac stutters while that runs.'

export const CACHE_CAPS: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: null, label: 'No limit (never emptied by itself)' },
  { value: 10, label: '10 GB' },
  { value: 25, label: '25 GB' },
  { value: 50, label: '50 GB' },
  { value: 100, label: '100 GB' },
]

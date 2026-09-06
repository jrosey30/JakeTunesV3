/**
 * When a missing Qobuz account is worth saying (placement audit P3, Jake
 * 2026-09-06): only when the attempted operation needs it. Browsing,
 * searching and previews never do — they stay usable without an account.
 * A Get resolves on Qobuz first (lossless), so an unconfigured account is
 * said out loud, with the one place that fixes it; the job still runs so
 * the other providers can answer for a song.
 */
export type QobuzState = { configured: boolean; email?: string } | null
export type DownloadOp = 'search' | 'preview' | 'get' | 'link'

export interface QobuzNotice {
  kind: 'qobuz-missing'
  title: string
  body: string
  /** Where the fix lives — the Preferences tab to open. */
  action: { label: string; preferencesTab: 'Music Sources' }
}

export function qobuzNoticeFor(qobuz: QobuzState, op: DownloadOp, what?: { kind: 'album' | 'song'; title: string }): QobuzNotice | null {
  if (op !== 'get') return null                    // search / preview / link never need it
  if (!qobuz || qobuz.configured) return null      // unknown yet, or connected
  const album = what?.kind === 'album'
  return {
    kind: 'qobuz-missing',
    title: 'Qobuz isn’t connected',
    body: album
      ? `Records resolve on Qobuz. ${what?.title ? `“${what.title}” ` : 'This one '}can’t be fetched until an account is connected.`
      : `Songs resolve on Qobuz first; without an account ${what?.title ? `“${what.title}” ` : 'this one '}can only come from Bandcamp or SoundCloud.`,
    action: { label: 'Open Music Sources', preferencesTab: 'Music Sources' },
  }
}

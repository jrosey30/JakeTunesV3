/**
 * Base64 speech → a playable Audio element (2026-08-29).
 *
 * Chromium rejects large data: URLs on media elements ("Media load
 * rejected by URL safety check", surfacing as "no supported sources").
 * Short Music Man quips squeaked under the cap for months; a full-length
 * take crossed it and every voice in the app died with a misleading
 * "couldn't reach the mic" notice. Blob URLs carry no such cap — same
 * bytes, measured OK at 747KB where the data: URI refused.
 *
 * The object URL is revoked once the clip ends or errors, so memory
 * stays flat across a night of radio.
 */
export function audioFromBase64Mpeg(b64: string): HTMLAudioElement {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
  const audio = new Audio(url)
  const revoke = (): void => URL.revokeObjectURL(url)
  audio.addEventListener('ended', revoke, { once: true })
  audio.addEventListener('error', revoke, { once: true })
  return audio
}

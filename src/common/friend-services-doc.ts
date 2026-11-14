/**
 * Share by service (2026-11-14) — which app each of Jake's people listens on,
 * as homemini serves it (GET /api/friend-services; homemini's
 * friend-services.json, homemini the only writer: this desktop only reads).
 * The share dialog's SEND TO row: one click on a person copies THEIR message
 * (the signature line and their app's one link).
 *
 * ⚠️ CONTRACT: JakeTunesMobile backend util/friendServices.ts (the file and the
 * route), routes/share.ts `byService`.
 * ⚠️ TWIN: JakeTunesMobile ios FriendSend.swift FriendSendRules.chip.
 */
import type { ShareInfo } from './friend-share-doc.ts'

export type FriendService = 'apple' | 'spotify' | 'unknown'

export interface FriendPerson {
  key: string
  name: string
  service: FriendService
  setBy: 'jake' | 'auto'
  seed: boolean
}

const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** The route's people, in its order; rows that don't read are dropped. */
export function parseFriendServices(raw: unknown): FriendPerson[] {
  const list = Array.isArray(o(raw).people) ? (o(raw).people as unknown[]) : []
  const out: FriendPerson[] = []
  for (const r0 of list) {
    const r = o(r0)
    const key = typeof r.key === 'string' ? r.key : ''
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    const service = r.service === 'apple' || r.service === 'spotify' || r.service === 'unknown' ? r.service : null
    if (!key || !name || !service) continue
    out.push({ key, name, service, setBy: r.setBy === 'auto' ? 'auto' : 'jake', seed: r.seed === true })
  }
  return out
}

export type Chip = { state: 'waiting' } | { state: 'ready'; text: string } | { state: 'no-link' }

/** What clicking a person does for this share. Their app's own message; both
 *  links when their app isn't known (or homemini predates byService); greyed
 *  when their app has no proven link (never a stranger's page). */
export function chipFor(person: FriendPerson | null, info: ShareInfo | null): Chip {
  if (!info) return { state: 'waiting' }
  if (!person || person.service === 'unknown' || !info.byService) return { state: 'ready', text: info.text }
  const link = person.service === 'apple' ? info.byService.apple : info.byService.spotify
  return link ? { state: 'ready', text: link.text } : { state: 'no-link' }
}

export function serviceLabel(s: FriendService): string {
  return s === 'apple' ? 'Apple Music' : s === 'spotify' ? 'Spotify' : 'both apps'
}

export function serviceTag(s: FriendService): string | null {
  return s === 'apple' ? 'APPLE' : s === 'spotify' ? 'SPOTIFY' : null
}

/** The plain line under the row after a click: what was copied and what to do. The
 *  desktop can't open Messages addressed to one person, so it says so. */
export function copiedNote(person: FriendPerson): string {
  const first = person.name.split(' ')[0] || person.name
  const what = person.service === 'unknown' ? 'message (both links)' : `${serviceLabel(person.service)} message`
  return `${first}’s ${what} is copied. The desktop can’t open Messages to one person, so paste it in Messages to ${first}.`
}

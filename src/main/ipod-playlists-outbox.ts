/**
 * Jake's own playlists for one iPod, on this Mac (2026-11-14). Jake: "i also
 * have the ability to create my own per ipod playlist, if i so choose".
 *
 * homemini keeps them (JakeTunesMobile util/ipodPlaylists.ts, Brief 246):
 *   GET    /api/ipod-playlists?device=<key>     their list, in order
 *   PUT    /api/ipod-playlists/:device/:id      create (the id is this Mac's: twice is one)
 *   PATCH  /api/ipod-playlists/:device/:id      { name, trackIds } (the whole list, in order)
 *   DELETE /api/ipod-playlists/:device/:id
 *   409 { error: 'not-on-ipod', notOnIpod } / { error: 'name-taken', name }
 * and a "yes, put it on the iPod too" goes through the iPod's list route,
 *   POST   /api/ipod-lists/:id/add { ids, by: 'claude', why }
 * which may skip a song ('full', 'not-in-library').
 *
 * The same rules as every write the desktop makes to homemini (the tag queue's
 * #415, Headline…'s #419): what Jake did is on THIS Mac's disk before homemini
 * is asked (ipod-playlists-pending.json), it is what this Mac shows until
 * homemini has it, and it goes on the next read of that iPod's playlists or the
 * 5-minute retry.
 *   - The waiting file is only ever changed under one lock, read and written in
 *     one turn, through writeJsonAtomic (a staging name no other write shares).
 *   - One send at a time per iPod. A send that finishes clears its entry only if
 *     the entry is still the edit that was sent (`rev`); a newer edit goes next.
 *   - Each entry is what the playlist should BE now (the whole list), so a
 *     re-send after a lost reply changes nothing and newest wins.
 *   - A "put it on the iPod too" goes before that iPod's playlists, so the songs
 *     are on the iPod's list when the playlist reaches homemini.
 *   - homemini's refusals Jake can answer (a song not on the iPod, a name taken)
 *     HOLD the playlist as he made it, never drop it, until he answers.
 *
 * Deps injected so node --test runs it against a fake homemini.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { writeJsonAtomic } from './atomic-write.ts'
import { withLocalLock } from './hub-local-state.ts'
import { withCompanionInit } from './hub-companion.ts'
import type { FetchLike } from './top1000-client.ts'
import {
  checkPlaylistName, cleanTrackIds, emptyPending, foldIpodPlaylists, isIpodPlaylistKey, parseStoredPlaylists, pendingKey,
  skippedAddNotice,
  type IpodPlaylistsAnswer, type IpodPlaylistWriteAnswer, type IpodPlaylistsPendingDoc, type PendingIpodPlaylist, type StoredIpodPlaylist,
} from '../common/ipod-playlists-view.ts'

export const PENDING_FILE = 'ipod-playlists-pending.json'
export const CACHE_FILE = 'ipod-playlists-cache.json'

// ── homemini ───────────────────────────────────────────────────────────

export type SaveAnswer =
  | { kind: 'done'; playlist: StoredIpodPlaylist | null }
  | { kind: 'missing' }
  | { kind: 'not-on-ipod'; trackIds: number[] }
  | { kind: 'name-taken'; name: string }
  | { kind: 'refused'; error: string }
  | { kind: 'retry' }

export type AddAnswer =
  | { kind: 'done'; skipped: Array<{ id: number; reason: string }>; cap: number | null }
  | { kind: 'refused'; error: string }
  | { kind: 'retry' }

export interface IpodPlaylistsRemote {
  /** null = no clean answer. */
  list: (device: string) => Promise<StoredIpodPlaylist[] | null>
  put: (device: string, id: string, body: { name: string; trackIds: number[]; createdAt: string }) => Promise<SaveAnswer>
  patch: (device: string, id: string, body: { name: string; trackIds: number[] }) => Promise<SaveAnswer>
  remove: (device: string, id: string) => Promise<SaveAnswer>
  addToIpod: (device: string, trackIds: number[], why: string) => Promise<AddAnswer>
}

async function json(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown> | null> {
  const b = await res.json().catch(() => null)
  return b && typeof b === 'object' ? b as Record<string, unknown> : null
}

/** What a write's answer means. Only homemini's own answer counts: a proxy's page is "not now". */
async function saveAnswer(device: string, res: { status: number; json: () => Promise<unknown> }): Promise<SaveAnswer> {
  const body = await json(res)
  if (res.status === 200 && body) {
    const parsed = body.playlist ? parseStoredPlaylists({ playlists: [body.playlist] }, device) : null
    return { kind: 'done', playlist: parsed?.[0] ?? null }
  }
  if (res.status === 404 && body) return { kind: 'missing' }
  if (res.status === 409 && body?.error === 'not-on-ipod') return { kind: 'not-on-ipod', trackIds: cleanTrackIds(body.notOnIpod) ?? [] }
  if (res.status === 409 && body?.error === 'name-taken') return { kind: 'name-taken', name: typeof body.name === 'string' ? body.name : '' }
  if ((res.status === 400 || res.status === 403) && body) return { kind: 'refused', error: typeof body.error === 'string' ? body.error : `homemini answered ${res.status}` }
  return { kind: 'retry' }
}

export function createIpodPlaylistsRemote(opts: { baseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number; warn?: (m: string) => void }): IpodPlaylistsRemote {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const timeoutMs = opts.timeoutMs ?? 8_000
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const base = opts.baseUrl.replace(/\/+$/, '')
  const url = (device: string, id?: string): string =>
    `${base}/api/ipod-playlists/${encodeURIComponent(device)}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`
  const call = async (u: string, method: string, body?: unknown) => fetchImpl(u, withCompanionInit({
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  }) as Record<string, unknown>)
  const write = async (what: string, device: string, go: () => ReturnType<typeof call>): Promise<SaveAnswer> => {
    try {
      const res = await go()
      const a = await saveAnswer(device, res)
      if (a.kind === 'retry') warn(`[ipod-playlists] ${what}: homemini answered ${res.status}; it waits`)
      return a
    } catch (err) {
      warn(`[ipod-playlists] ${what} not sent (${(err as Error)?.message ?? err}); it waits`)
      return { kind: 'retry' }
    }
  }
  return {
    async list(device) {
      try {
        const res = await call(`${base}/api/ipod-playlists?device=${encodeURIComponent(device)}`, 'GET')
        if (res.status !== 200) { warn(`[ipod-playlists] ${device}: homemini answered ${res.status}`); return null }
        return parseStoredPlaylists(await res.json().catch(() => null), device)
      } catch (err) {
        warn(`[ipod-playlists] ${device} not read (${(err as Error)?.message ?? err})`)
        return null
      }
    },
    put: (device, id, body) => write(`create ${device}/${id}`, device, () => call(url(device, id), 'PUT', { ...body, source: 'jake' })),
    patch: (device, id, body) => write(`save ${device}/${id}`, device, () => call(url(device, id), 'PATCH', body)),
    remove: (device, id) => write(`delete ${device}/${id}`, device, () => call(url(device, id), 'DELETE')),
    async addToIpod(device, trackIds, why) {
      try {
        const res = await fetchImpl(`${base}/api/ipod-lists/${encodeURIComponent(device)}/add`, withCompanionInit({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: trackIds, by: 'claude', why }),
          signal: AbortSignal.timeout(timeoutMs),
        }) as Record<string, unknown>)
        const body = await json(res)
        if (res.status === 200 && body) {
          const skipped = Array.isArray(body.skipped)
            ? (body.skipped as Array<{ id?: unknown; reason?: unknown }>).filter((s) => Number.isInteger(Number(s?.id))).map((s) => ({ id: Number(s.id), reason: String(s.reason ?? '') }))
            : []
          const list = body.list as { cap?: unknown } | undefined
          return { kind: 'done', skipped, cap: Number.isInteger(Number(list?.cap)) ? Number(list?.cap) : null }
        }
        if ((res.status === 400 || res.status === 404) && body) return { kind: 'refused', error: typeof body.error === 'string' ? body.error : `homemini answered ${res.status}` }
        warn(`[ipod-playlists] add to ${device}'s list: homemini answered ${res.status}; it waits`)
        return { kind: 'retry' }
      } catch (err) {
        warn(`[ipod-playlists] add to ${device}'s list not sent (${(err as Error)?.message ?? err}); it waits`)
        return { kind: 'retry' }
      }
    },
  }
}

// ── this Mac's disk ────────────────────────────────────────────────────

const fileLock = (stateDir: string): string => `ipod-playlists-file:${stateDir}`
const sendLock = (stateDir: string, device: string): string => `ipod-playlists-send:${stateDir}:${device}`

function parsePending(raw: unknown): IpodPlaylistsPendingDoc {
  const out = emptyPending()
  const doc = raw as Partial<IpodPlaylistsPendingDoc> | null
  if (!doc || doc.version !== 1) return out
  for (const [k, v] of Object.entries(doc.saves ?? {})) {
    const p = v as Partial<PendingIpodPlaylist> | null
    const ids = cleanTrackIds(p?.trackIds)
    if (!p || !isIpodPlaylistKey(p.device) || !isIpodPlaylistKey(p.id) || k !== pendingKey(p.device, p.id) || !ids) continue
    if (p.op !== 'save' && p.op !== 'delete') continue
    out.saves[k] = {
      device: p.device, id: p.id, rev: Number(p.rev) || 0, op: p.op, name: String(p.name ?? ''), trackIds: ids,
      createdAt: String(p.createdAt ?? ''), isNew: p.isNew === true,
      ...(p.hold ? { hold: p.hold } : {}),
      ...(Array.isArray(p.notices) && p.notices.length ? { notices: p.notices.map(String) } : {}),
    }
  }
  for (const a of Array.isArray(doc.adds) ? doc.adds : []) {
    const ids = cleanTrackIds(a?.trackIds)
    if (!a || typeof a.opId !== 'string' || !isIpodPlaylistKey(a.device) || !ids || !ids.length) continue
    out.adds.push({ opId: a.opId, device: a.device, trackIds: ids, forName: String(a.forName ?? '') })
  }
  return out
}

/** What this Mac hasn't told homemini yet. An unreadable file reads as nothing waiting (it is never written over unread: see editPending). */
export async function readPending(stateDir: string): Promise<IpodPlaylistsPendingDoc> {
  try {
    return parsePending(JSON.parse(await readFile(join(stateDir, PENDING_FILE), 'utf-8')))
  } catch {
    // No file yet: nothing is waiting.
    return emptyPending()
  }
}

type CacheDoc = Record<string, { savedAt: string; playlists: StoredIpodPlaylist[] }>

async function readCache(stateDir: string): Promise<CacheDoc> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, CACHE_FILE), 'utf-8')) as Record<string, { savedAt?: unknown; playlists?: unknown }>
    const out: CacheDoc = {}
    for (const [device, v] of Object.entries(raw ?? {})) {
      if (!isIpodPlaylistKey(device)) continue
      const rows = parseStoredPlaylists({ playlists: v?.playlists }, device)
      if (rows) out[device] = { savedAt: String(v?.savedAt ?? ''), playlists: rows }
    }
    return out
  } catch {
    // No copy kept yet.
    return {}
  }
}

/** Change the waiting file in one locked turn. `edit` changes the doc and returns its answer. */
function editPending<T>(stateDir: string, edit: (doc: IpodPlaylistsPendingDoc) => T): Promise<T> {
  return withLocalLock(fileLock(stateDir), async () => {
    const doc = await readPending(stateDir)
    const before = JSON.stringify(doc)
    const answer = edit(doc)
    if (JSON.stringify(doc) !== before) await writeJsonAtomic(join(stateDir, PENDING_FILE), doc)
    return answer
  })
}

/** Change the kept copy of homemini's answers in one locked turn (the same lock: one file at a time). */
function editCache(stateDir: string, edit: (doc: CacheDoc) => void): Promise<void> {
  return withLocalLock(`${fileLock(stateDir)}:cache`, async () => {
    const doc = await readCache(stateDir)
    edit(doc)
    await writeJsonAtomic(join(stateDir, CACHE_FILE), doc)
  })
}

// ── the desk ───────────────────────────────────────────────────────────

export interface IpodPlaylistsDeskDeps {
  stateDir: string
  remote: IpodPlaylistsRemote
  /** The app's one name sort (main/ipod-artist-sort.ts compareIpodArtistNames). */
  compareNames: (a: string, b: string) => number
  /** A song's title, for the plain lines ("punkPod is full, so “X” couldn’t go on it"). */
  titleOf?: (id: number) => string
  now?: () => Date
  newId?: () => string
  warn?: (msg: string) => void
}

export type IpodPlaylistsView = Extract<IpodPlaylistsAnswer, { ok: true }>
export type IpodPlaylistWrite = IpodPlaylistWriteAnswer

/** How many newer edits one turn sends for one playlist before leaving the rest for the next flush. */
const MAX_SENDS_PER_TURN = 10

export function createIpodPlaylistsDesk(deps: IpodPlaylistsDeskDeps) {
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const now = deps.now ?? (() => new Date())
  const titleOf = deps.titleOf ?? ((id: number) => `song ${id}`)

  async function local(device: string, from: IpodPlaylistsView['from'] | null = null): Promise<IpodPlaylistsView> {
    const [cache, pending] = await Promise.all([readCache(deps.stateDir), withLocalLock(fileLock(deps.stateDir), () => readPending(deps.stateDir))])
    const kept = cache[device]
    return {
      ok: true,
      device,
      playlists: foldIpodPlaylists(device, kept?.playlists ?? [], pending, deps.compareNames),
      from: from ?? (kept ? 'kept' : 'none'),
    }
  }

  /** The kept copy learns what homemini now has for one playlist (or that it is gone). */
  async function keep(device: string, id: string, playlist: StoredIpodPlaylist | null): Promise<void> {
    await editCache(deps.stateDir, (doc) => {
      const rows = (doc[device]?.playlists ?? []).filter((p) => p.id !== id)
      if (playlist) rows.push(playlist)
      doc[device] = { savedAt: doc[device]?.savedAt ?? now().toISOString(), playlists: rows }
    }).catch((err) => warn(`[ipod-playlists] could not keep ${device}/${id}: ${(err as Error)?.message ?? err}`))
  }

  /** One playlist's turn: send what it should be; clear it only if it is still what was sent. */
  async function sendOne(key: string): Promise<'sent' | 'held' | 'still-waiting'> {
    for (let i = 0; i < MAX_SENDS_PER_TURN; i++) {
      const pending = await withLocalLock(fileLock(deps.stateDir), () => readPending(deps.stateDir))
      const e = pending.saves[key]
      if (!e) return 'sent'
      if (e.hold) return 'held'
      let a: SaveAnswer
      if (e.op === 'delete') {
        a = await deps.remote.remove(e.device, e.id)
        if (a.kind === 'missing') a = { kind: 'done', playlist: null }
      } else if (e.isNew) {
        a = await deps.remote.put(e.device, e.id, { name: e.name, trackIds: e.trackIds, createdAt: e.createdAt })
      } else {
        a = await deps.remote.patch(e.device, e.id, { name: e.name, trackIds: e.trackIds })
        // Never landed, or gone from homemini: Jake still has it here, so it is made again under its id.
        if (a.kind === 'missing') a = await deps.remote.put(e.device, e.id, { name: e.name, trackIds: e.trackIds, createdAt: e.createdAt })
      }
      if (a.kind === 'retry' || a.kind === 'missing') return 'still-waiting'
      if (a.kind === 'not-on-ipod' || a.kind === 'name-taken') {
        const hold = a.kind === 'not-on-ipod' ? { kind: a.kind, trackIds: a.trackIds } : { kind: a.kind, name: a.name || e.name }
        const held = await editPending(deps.stateDir, (doc) => {
          const cur = doc.saves[key]
          if (!cur || cur.rev !== e.rev) return false
          cur.hold = hold
          return true
        })
        if (held) return 'held'
        continue   // Jake changed it meanwhile: the newer edit goes now
      }
      if (a.kind === 'refused') {
        warn(`[ipod-playlists] homemini refused ${key}: ${a.error}`)
        const cleared = await editPending(deps.stateDir, (doc) => {
          if (doc.saves[key]?.rev !== e.rev) return false
          delete doc.saves[key]
          return true
        })
        if (cleared) return 'sent'
        continue
      }
      // done. Decide under the file's lock what this answer means now, then keep homemini's copy.
      const now = await editPending(deps.stateDir, (doc) => {
        const cur = doc.saves[key]
        if (!cur || cur.rev === e.rev) { delete doc.saves[key]; return 'cleared' as const }
        // A newer edit came in while this one was on its way: homemini has the playlist now.
        if (e.op === 'save') cur.isNew = false
        // Deleted meanwhile: what homemini just made must not come back here; the delete goes next.
        return cur.op === 'delete' ? 'deleted-meanwhile' as const : 'newer-save' as const
      })
      if (now !== 'deleted-meanwhile') {
        await keep(e.device, e.id, e.op === 'delete' ? null : (a.playlist ?? {
          id: e.id, device: e.device, name: e.name, source: 'jake', trackIds: e.trackIds, createdAt: e.createdAt,
        }))
      }
      const cleared = now === 'cleared'
      if (cleared) return 'sent'
    }
    return 'still-waiting'
  }

  /** The "put it on the iPod too"s for one iPod, oldest first. false = one is still waiting (the playlists wait behind it). */
  async function sendAdds(device: string): Promise<boolean> {
    for (;;) {
      const pending = await withLocalLock(fileLock(deps.stateDir), () => readPending(deps.stateDir))
      const add = pending.adds.find((x) => x.device === device)
      if (!add) return true
      const a = await deps.remote.addToIpod(device, add.trackIds, `Jake said yes on the desktop, for his iPod playlist “${add.forName}”`)
      if (a.kind === 'retry') return false
      const skipped = a.kind === 'done' ? a.skipped.filter((s) => s.reason === 'full' || s.reason === 'not-in-library') : add.trackIds.map((id) => ({ id, reason: 'refused' }))
      await editPending(deps.stateDir, (doc) => {
        doc.adds = doc.adds.filter((x) => x.opId !== add.opId)
        if (!skipped.length) return
        // A song the iPod couldn't take comes out of the playlists still waiting for it, and says so.
        const gone = new Set(skipped.map((s) => s.id))
        for (const e of Object.values(doc.saves)) {
          if (e.device !== device || e.op !== 'save' || !e.trackIds.some((id) => gone.has(id))) continue
          e.trackIds = e.trackIds.filter((id) => !gone.has(id))
          e.rev += 1
          const lines = skipped.filter((s) => !(e.notices ?? []).some((n) => n.includes(`“${titleOf(s.id)}”`)))
            .map((s) => skippedAddNotice(ipodNameOf(device), a.kind === 'done' ? a.cap : null, s.reason, titleOf(s.id)))
          e.notices = [...(e.notices ?? []), ...lines]
        }
      })
    }
  }

  const ipodNames = new Map<string, string>()
  const ipodNameOf = (device: string): string => ipodNames.get(device) ?? (device === 'top1000' ? 'The Original' : 'this iPod')

  /** Send what one iPod's playlists are waiting for. */
  function flushDevice(device: string): Promise<'none' | 'sent' | 'still-waiting'> {
    return withLocalLock(sendLock(deps.stateDir, device), async () => {
      const before = await withLocalLock(fileLock(deps.stateDir), () => readPending(deps.stateDir))
      const keys = Object.keys(before.saves).filter((k) => before.saves[k]?.device === device && !before.saves[k]?.hold)
      if (!keys.length && !before.adds.some((a) => a.device === device)) return 'none'
      if (!(await sendAdds(device))) return 'still-waiting'
      let waiting = false
      for (const k of keys) {
        const out = await sendOne(k).catch((err) => { warn(`[ipod-playlists] ${k}: ${(err as Error)?.message ?? err}`); return 'still-waiting' as const })
        if (out === 'still-waiting') { waiting = true; break }   // homemini is away: the rest wait too, in order
      }
      return waiting ? 'still-waiting' : 'sent'
    })
  }

  /** Every iPod's waiting playlists (the 5-minute retry). */
  async function flushAll(): Promise<void> {
    const pending = await withLocalLock(fileLock(deps.stateDir), () => readPending(deps.stateDir))
    const devices = new Set([...Object.values(pending.saves).map((e) => e.device), ...pending.adds.map((a) => a.device)])
    await Promise.all([...devices].map((d) => flushDevice(d).catch(() => 'still-waiting')))
  }

  /** One iPod's playlists: what's waiting goes first, then homemini is asked; its answer is kept for next time. */
  async function view(device: string, opts: { fresh?: boolean; ipodName?: string } = {}): Promise<IpodPlaylistsView | { ok: false; error: string }> {
    if (!isIpodPlaylistKey(device)) return { ok: false, error: 'No iPod.' }
    if (opts.ipodName) ipodNames.set(device, opts.ipodName)
    if (!opts.fresh) return local(device)
    await flushDevice(device).catch((err) => warn(`[ipod-playlists] flush ${device}: ${(err as Error)?.message ?? err}`))
    // In the iPod's send turn, so an answer asked for while an edit is on its way can't be kept over it.
    return withLocalLock(sendLock(deps.stateDir, device), async () => {
      const fresh = await deps.remote.list(device)
      if (!fresh) return local(device)
      await editCache(deps.stateDir, (doc) => { doc[device] = { savedAt: now().toISOString(), playlists: fresh } })
        .catch((err) => warn(`[ipod-playlists] could not keep ${device}'s playlists: ${(err as Error)?.message ?? err}`))
      return local(device, 'homemini')
    })
  }

  /**
   * Create or change one of Jake's playlists: on disk first, then homemini (not awaited
   * here: the renderer asks for a fresh view, which sends it). `defaults` = the names of
   * this iPod's defaults (the renderer works them out), so a name can't hide behind one.
   * `alsoOnIpod` = songs Jake said yes to putting on the iPod's list first.
   */
  async function save(input: {
    device: unknown; id?: unknown; name?: unknown; trackIds?: unknown; defaults?: unknown; ipodName?: unknown; alsoOnIpod?: unknown
  }): Promise<IpodPlaylistWrite> {
    const device = input.device
    if (!isIpodPlaylistKey(device)) return { ok: false, error: 'No iPod.' }
    const ipodName = typeof input.ipodName === 'string' && input.ipodName.trim() ? input.ipodName.trim() : ipodNameOf(device)
    ipodNames.set(device, ipodName)
    const creating = input.id === undefined || input.id === null
    const id = creating ? `mac-${deps.newId?.() ?? randomUUID()}` : input.id
    if (!isIpodPlaylistKey(id)) return { ok: false, error: 'No playlist.' }
    const shown = await local(device)
    const current = shown.playlists.find((p) => p.id === id)
    if (!creating && !current) return { ok: false, error: 'That playlist isn’t on this iPod any more.' }
    if (current && current.source !== 'jake') return { ok: false, error: 'Only your own playlists can be changed here.' }
    const defaults = Array.isArray(input.defaults) ? input.defaults.filter((n): n is string => typeof n === 'string') : []
    let name = current?.name ?? ''
    if (input.name !== undefined || creating) {
      const check = checkPlaylistName(input.name, ipodName, { defaults, others: shown.playlists.filter((p) => p.id !== id).map((p) => p.name) })
      if (!check.ok) return check
      name = check.name
    }
    const trackIds = input.trackIds === undefined ? (current?.trackIds ?? []) : cleanTrackIds(input.trackIds)
    if (!trackIds) return { ok: false, error: 'Those aren’t songs.' }
    const also = cleanTrackIds(input.alsoOnIpod ?? []) ?? []
    if (also.length && device === 'top1000') return { ok: false, error: 'The Original carries the Top 1000 only.' }
    const stamp = now().toISOString()
    const onHomemini = ((await readCache(deps.stateDir))[device]?.playlists ?? []).some((p) => p.id === id)
    await editPending(deps.stateDir, (doc) => {
      const key = pendingKey(device, id)
      const was = doc.saves[key]
      // An edit answers any question that was holding it: what Jake sees now is what he wants.
      doc.saves[key] = {
        device, id, rev: (was?.rev ?? 0) + 1, op: 'save', name, trackIds,
        createdAt: was?.createdAt || current?.createdAt || stamp,
        // A PUT until homemini has it; a PATCH that finds it gone falls back to a PUT anyway.
        isNew: creating || (was ? was.isNew : !onHomemini),
        ...(was?.notices?.length ? { notices: was.notices } : {}),
      }
      if (also.length) doc.adds.push({ opId: deps.newId?.() ?? randomUUID(), device, trackIds: also, forName: name })
    })
    return { ok: true, id, view: await local(device) }
  }

  /** Delete one of Jake's playlists: on disk first. */
  async function remove(input: { device: unknown; id: unknown }): Promise<IpodPlaylistWrite> {
    const { device, id } = input
    if (!isIpodPlaylistKey(device) || !isIpodPlaylistKey(id)) return { ok: false, error: 'No playlist.' }
    const shown = await local(device)
    const current = shown.playlists.find((p) => p.id === id)
    if (current && current.source !== 'jake') return { ok: false, error: 'Only your own playlists can be deleted here.' }
    await editPending(deps.stateDir, (doc) => {
      const key = pendingKey(device, id)
      const was = doc.saves[key]
      // Always sent, even for a playlist this Mac thinks homemini never had: its create may have
      // landed with the reply lost, or be on its way right now. A second delete is fine (existed: false).
      doc.saves[key] = { device, id, rev: (was?.rev ?? 0) + 1, op: 'delete', name: current?.name ?? was?.name ?? '', trackIds: [], createdAt: was?.createdAt ?? '', isNew: false }
    })
    return { ok: true, id, view: await local(device) }
  }

  /** Jake's answer to a held playlist: put the songs on the iPod too, take them out, or (a name) rename it. */
  async function answer(input: { device: unknown; id: unknown; choice: unknown; name?: unknown; ipodName?: unknown; defaults?: unknown }): Promise<IpodPlaylistWrite> {
    const { device, id, choice } = input
    if (!isIpodPlaylistKey(device) || !isIpodPlaylistKey(id)) return { ok: false, error: 'No playlist.' }
    if (choice === 'rename') return save({ device, id, name: input.name, ipodName: input.ipodName, defaults: input.defaults })
    if (choice === 'add' && device === 'top1000') return { ok: false, error: 'The Original carries the Top 1000 only.' }
    const ok = await editPending(deps.stateDir, (doc) => {
      const e = doc.saves[pendingKey(device, id)]
      if (!e || e.hold?.kind !== 'not-on-ipod') return false
      const ids = e.hold.trackIds
      if (choice === 'add') doc.adds.push({ opId: deps.newId?.() ?? randomUUID(), device, trackIds: ids, forName: e.name })
      else if (choice === 'drop') e.trackIds = e.trackIds.filter((t) => !ids.includes(t))
      else return false
      delete e.hold
      e.rev += 1
      return true
    })
    if (!ok) return { ok: false, error: 'Nothing is waiting on that question.' }
    return { ok: true, id, view: await local(device) }
  }

  return { view, save, remove, answer, flushDevice, flushAll }
}

export type IpodPlaylistsDesk = ReturnType<typeof createIpodPlaylistsDesk>

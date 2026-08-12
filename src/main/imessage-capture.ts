/**
 * iMessage capture — Jake (2026-07-19): "everytime someone sends me a song
 * on spotify or apple music via imessage, i want it automatically on the
 * list."
 *
 * The watcher polls ~/Library/Messages/chat.db (read-only, via the macOS
 * sqlite3 CLI — the child inherits the app's Full Disk Access grant) for
 * NEW incoming messages carrying open.spotify.com / spotify.link /
 * music.apple.com links, resolves each link to a song or album, and adds
 * it through the SAME add-recommendation path the omnibox uses — so the
 * sender gets "from <name>" attribution, a Scouts-ledger tick, identity
 * dedupe, and outbox replay for free. Nothing here writes the list
 * directly.
 *
 * Rules:
 * - Incoming only (is_from_me = 0); tapbacks/reactions skipped (a "Loved"
 *   on a link must not re-capture it).
 * - Each message is processed EXACTLY ONCE (monotonic ROWID cursor) — a
 *   song Jake tossed can only come back if a human actually texts it again.
 * - First run looks back 7 days, capped at 20 adds (no list flooding);
 *   after that the cursor moves strictly forward.
 * - A link that fails to resolve (offline, Spotify bot-wall) retries up to
 *   5 scans, then lands as a note-only jot carrying the raw link — a texted
 *   song is never silently dropped.
 * - No Full Disk Access → status 'denied'; the LTL view shows the one-time
 *   setup hint. The watcher keeps probing, so the moment Jake flips the
 *   toggle it starts without a relaunch.
 *
 * Pure parsing/classification lives in imessage-capture-core.ts (tested).
 */

import { readFile, writeFile, rename } from 'fs/promises'
import type { IpcRegistrar } from './ipc-register.ts'
import { safeIpcError } from './safe-ipc-error.ts'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  extractMusicLinks, decodeAttributedBodyHex, classifyMusicLink,
  parseSpotifyTitle, parseAppleLookup, normalizeMusicUrl,
  buildContactsIndex, senderName, appleDateToMs,
  type ResolvedLink,
} from './imessage-capture-core'

const execP = promisify(execFile)

const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db')
const SCAN_EVERY_MS = 3 * 60_000
const FIRST_SCAN_DELAY_MS = 20_000
const FIRST_RUN_LOOKBACK_DAYS = 7
const FIRST_RUN_MAX_ADDS = 20
const MAX_RESOLVES_PER_SCAN = 10
const MAX_PENDING_ATTEMPTS = 5
const PAGE_SIZE = 800

export interface CapturedItem {
  guid: string
  url: string
  song?: string
  artist?: string
  album?: string
  from?: string
  at: string
  status: 'added' | 'deduped' | 'note-fallback' | 'failed'
}

interface PendingLink {
  guid: string
  url: string
  sender: string | null
  at: string
  attempts: number
}

interface CaptureState {
  v: 1
  lastRowId: number
  initializedAt?: string
  pending: PendingLink[]
  /** normalized urls already handled — a re-forwarded link is one capture */
  seen: string[]
  captures: CapturedItem[]
  lastScanAt?: string
}

export interface ImessageCaptureHost {
  stateFile: string
  addRecommendation: (input: {
    song?: string; artist?: string; album?: string; note?: string; from?: string; link?: string
  }) => Promise<{ ok: boolean; deduped?: boolean; error?: string }>
}

// ── IO ──

async function fetchText(url: string, timeoutMs = 8000): Promise<{ text: string; finalUrl: string } | null> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) JakeTunes/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return null
    return { text: await r.text(), finalUrl: r.url || url }
  } catch { return null }
}

async function resolveLink(url: string): Promise<ResolvedLink | null> {
  let kind = classifyMusicLink(url)
  let pageUrl = url
  if (kind.service === 'spotify' && kind.kind === 'short') {
    // spotify.link → follow the redirect, classify where it lands
    const page = await fetchText(url)
    if (!page) return null
    kind = classifyMusicLink(page.finalUrl)
    pageUrl = page.finalUrl
    if (kind.service === 'spotify') {
      const t = page.text.match(/<title>([^<]+)<\/title>/i)?.[1]
      const parsed = t ? parseSpotifyTitle(t) : null
      if (parsed) return parsed
    }
  }
  if (kind.service === 'apple') {
    const page = await fetchText(`https://itunes.apple.com/lookup?id=${kind.id}`)
    if (!page) return null
    try { return parseAppleLookup(JSON.parse(page.text)) } catch { return null }
  }
  if (kind.service === 'spotify') {
    const page = await fetchText(pageUrl)
    const t = page?.text.match(/<title>([^<]+)<\/title>/i)?.[1]
    const parsed = t ? parseSpotifyTitle(t) : null
    if (parsed) return parsed
    // bot-walled page → oEmbed still serves the bare title
    const oe = await fetchText(`https://open.spotify.com/oembed?url=${encodeURIComponent(pageUrl)}`)
    if (oe) {
      try {
        const title = (JSON.parse(oe.text) as { title?: string }).title
        if (title) return kind.kind === 'album' ? { album: title } : { song: title }
      } catch { /* fall through */ }
    }
    return null
  }
  return null
}

interface DbRow {
  rowid: number
  guid: string
  text: string | null
  body_hex: string | null
  sender: string | null
  date: number
}

async function queryDb(sql: string): Promise<{ ok: true; rows: DbRow[] } | { ok: false; denied: boolean; error: string }> {
  try {
    const { stdout } = await execP('/usr/bin/sqlite3', ['-readonly', '-json', CHAT_DB, sql],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
    const trimmed = stdout.trim()
    return { ok: true, rows: trimmed ? JSON.parse(trimmed) as DbRow[] : [] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, denied: /authorization denied|operation not permitted/i.test(msg), error: msg }
  }
}

// One JXA round trip: names + phones + emails, index-aligned. Uses the same
// Contacts Automation grant the "From" typeahead already prompted for.
let contactsIndexCache: { at: number; map: Map<string, string> } | null = null
async function getContactsIndex(): Promise<Map<string, string>> {
  if (contactsIndexCache && Date.now() - contactsIndexCache.at < 3600_000) return contactsIndexCache.map
  try {
    const script = 'const p=Application("Contacts").people; JSON.stringify({n:p.name(),ph:p.phones.value(),em:p.emails.value()})'
    const { stdout } = await execP('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 45_000, maxBuffer: 16 * 1024 * 1024 })
    const j = JSON.parse(stdout.trim()) as { n: string[]; ph: string[][]; em: string[][] }
    const map = buildContactsIndex(j.n || [], j.ph || [], j.em || [])
    contactsIndexCache = { at: Date.now(), map }
    return map
  } catch {
    return contactsIndexCache?.map || new Map()
  }
}

// ── state ──

function emptyState(): CaptureState {
  return { v: 1, lastRowId: 0, pending: [], seen: [], captures: [] }
}

async function loadState(file: string): Promise<CaptureState> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as CaptureState
    if (parsed && parsed.v === 1 && typeof parsed.lastRowId === 'number') {
      return { ...emptyState(), ...parsed, pending: parsed.pending || [], seen: parsed.seen || [], captures: parsed.captures || [] }
    }
  } catch { /* first run */ }
  return emptyState()
}

async function saveState(file: string, state: CaptureState): Promise<void> {
  state.seen = state.seen.slice(-400)
  state.captures = state.captures.slice(-200)
  const tmp = join(dirname(file), `.imessage-capture.${process.pid}.tmp`)
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
  await rename(tmp, file)
}

// ── the watcher ──

let scanning = false
let lastStatus: { access: 'granted' | 'denied' | 'unknown'; lastScanAt?: string; error?: string } = { access: 'unknown' }
let fdaRegressionNotified = false
async function notifyFdaRegression(): Promise<void> {
  try {
    const { dialog, shell } = await import('electron')
    const r = await dialog.showMessageBox({
      type: 'warning',
      title: 'Texted songs are not being captured',
      message: 'JakeTunes lost Full Disk Access — songs friends text you are NOT landing on your list.',
      detail: 'This usually happens after the app is updated (macOS ties the permission to the app\'s signature). Nothing is lost: once access is restored, every missed text is captured retroactively.\n\nIn the list, remove JakeTunes with −, then re-add it with + from Applications.',
      buttons: ['Open Full Disk Access Settings', 'Later'],
      defaultId: 0,
    })
    if (r.response === 0) {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    }
  } catch (e) {
    console.warn('[imsg] FDA regression notice failed:', e)
  }
}

export function startImessageCapture(ipc: IpcRegistrar, host: ImessageCaptureHost): void {
  const scan = async (): Promise<void> => {
    if (scanning) return
    scanning = true
    try {
      await scanOnce(host)
    } catch (err) {
      console.warn('[imsg] scan failed:', err instanceof Error ? err.message : err)
    } finally {
      scanning = false
    }
  }

  ipc.handle('imessage-capture-status', async () => {
    const state = await loadState(host.stateFile)
    return { ok: true, ...lastStatus, lastRowId: state.lastRowId, pending: state.pending.length, recent: state.captures.slice(-20).reverse() }
  }, { public: true })
  ipc.handle('imessage-capture-scan', async () => {
    await scan()
    return { ok: true, ...lastStatus }
  }, { refuse: { ok: false, access: 'unknown' as const, error: 'refused-sender' } })

  setTimeout(() => { void scan() }, FIRST_SCAN_DELAY_MS)
  setInterval(() => { void scan() }, SCAN_EVERY_MS)
}

async function scanOnce(host: ImessageCaptureHost): Promise<void> {
  const state = await loadState(host.stateFile)

  // Probe + cursor init in one query.
  const probe = await queryDb('SELECT MAX(ROWID) AS rowid, NULL AS guid, NULL AS text, NULL AS body_hex, NULL AS sender, 0 AS date FROM message')
  if (!probe.ok) {
    lastStatus = { access: probe.denied ? 'denied' : 'unknown', error: probe.denied ? undefined : safeIpcError(probe.error, 'io-failed') }
    // ── LOUD failure on REGRESSION (2026-08-07, Jake: "this cant happen
    // again") ─────────────────────────────────────────────────────────────
    // Full Disk Access is tied to the app's code signature, so replacing the
    // bundle (every reinstall) can silently revoke it. The capture then goes
    // blind while texted songs pile up unseen — Lorin sent two and nobody
    // knew for days; the only tell was a quiet banner. A DENIED probe on a
    // watcher that has previously captured (lastRowId > 0 = it worked
    // before) is a regression, not a first-run state, and gets a real
    // dialog: once per app session, with the settings one click away.
    if (probe.denied && state.lastRowId > 0 && !fdaRegressionNotified) {
      fdaRegressionNotified = true
      void notifyFdaRegression()
    }
    return
  }
  lastStatus = { access: 'granted', lastScanAt: new Date().toISOString() }
  const maxRowId = Number(probe.rows[0]?.rowid || 0)

  const firstRun = state.lastRowId === 0 && !state.initializedAt
  const found: PendingLink[] = []

  let cursor = state.lastRowId
  const sinceSec = Math.floor(Date.now() / 1000) - FIRST_RUN_LOOKBACK_DAYS * 86400
  const appleNs = (sinceSec - 978307200) * 1e9
  for (;;) {
    const where = firstRun
      ? `m.ROWID > ${cursor} AND m.date > ${appleNs}`
      : `m.ROWID > ${cursor}`
    const q = await queryDb(
      `SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text,
              CASE WHEN m.text IS NULL OR m.text = '' THEN hex(m.attributedBody) ELSE NULL END AS body_hex,
              h.id AS sender, m.date AS date
       FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE ${where} AND m.is_from_me = 0
         AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
       ORDER BY m.ROWID ASC LIMIT ${PAGE_SIZE}`)
    if (!q.ok) { lastStatus = { access: q.denied ? 'denied' : 'unknown', error: safeIpcError(q.error, 'io-failed') }; return }
    for (const row of q.rows) {
      cursor = Math.max(cursor, Number(row.rowid))
      const text = row.text || (row.body_hex ? decodeAttributedBodyHex(row.body_hex) : '')
      if (!text) continue
      for (const url of extractMusicLinks(text)) {
        const norm = normalizeMusicUrl(url)
        if (state.seen.includes(norm)) continue
        state.seen.push(norm)
        found.push({ guid: String(row.guid), url, sender: row.sender, at: new Date(appleDateToMs(Number(row.date))).toISOString(), attempts: 0 })
      }
    }
    if (q.rows.length < PAGE_SIZE) break
  }

  if (firstRun) {
    state.initializedAt = new Date().toISOString()
    if (found.length > FIRST_RUN_MAX_ADDS) {
      console.log(`[imsg] first run: ${found.length} links in the last ${FIRST_RUN_LOOKBACK_DAYS}d — keeping the newest ${FIRST_RUN_MAX_ADDS}`)
      found.splice(0, found.length - FIRST_RUN_MAX_ADDS)
    }
  }
  state.lastRowId = Math.max(maxRowId, cursor)

  // Work queue: retries first, then the new finds.
  const queue = [...state.pending, ...found]
  state.pending = []
  if (queue.length > 0) {
    const contacts = await getContactsIndex()
    let resolved = 0
    for (const item of queue) {
      if (resolved >= MAX_RESOLVES_PER_SCAN) { state.pending.push(item); continue }
      resolved += 1
      const from = senderName(item.sender, contacts)
      const link = await resolveLink(item.url)
      if (link && (link.song || link.album)) {
        const res = await host.addRecommendation({ ...link, from, link: item.url })
        state.captures.push({ guid: item.guid, url: item.url, ...link, from, at: item.at, status: res.ok ? (res.deduped ? 'deduped' : 'added') : 'failed' })
        if (res.ok) console.log(`[imsg] captured: ${link.song || link.album} — ${link.artist || '?'} (from ${from || 'unknown'})${res.deduped ? ' [already on list]' : ''}`)
        else state.pending.push({ ...item, attempts: item.attempts + 1 })
      } else if (item.attempts + 1 >= MAX_PENDING_ATTEMPTS) {
        // Never silently drop a texted song — land the raw link as a jot.
        const res = await host.addRecommendation({ note: 'texted song link', from, link: item.url })
        state.captures.push({ guid: item.guid, url: item.url, from, at: item.at, status: res.ok ? 'note-fallback' : 'failed' })
        console.log(`[imsg] unresolvable after ${MAX_PENDING_ATTEMPTS} tries — landed as note: ${item.url}`)
      } else {
        state.pending.push({ ...item, attempts: item.attempts + 1 })
      }
    }
  }

  state.lastScanAt = new Date().toISOString()
  await saveState(host.stateFile, state)
}

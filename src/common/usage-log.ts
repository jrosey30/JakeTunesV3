/**
 * The usage log — the shape and the rules (2026-11-14).
 *
 * Jake: "I also want to introduce a proper log for long to update process. For
 * mobile and desktop. I want as much as possible to be as logged as I use the
 * app. Every Friday morning, it's a minor glitch/back end update based on the
 * logs findings."
 *
 * The desktop writes what happens as Jake uses the app to its own disk first
 * (main/usage-log-store.ts) and sends it to homemini in batches when homemini
 * answers. Claude reads homemini's digest on Friday.
 *
 * ⚠️ CONTRACT with JakeTunesMobile `POST /api/usage-log` (the ingest route):
 *   body   { device, app: "desktop", build, events: UsageEvent[] }
 *   device "macbook" | "workmini" | "homemini" — the machine the app runs on
 *   build  short git sha
 *   event  { t (ISO), kind, name, ms?, ok?, detail? }
 *   detail a small flat object (≤ 1 KB, strings ≤ 200)
 *   ≤ 500 events and ≤ 256 KB per POST (413 otherwise); answer { ok, accepted }
 *
 * What never goes in: secrets (keys, tokens, headers), file paths outside the
 * music library's own relative paths, query strings, song lyrics. scrubEvent
 * is the one door every event goes through, renderer and main alike.
 *
 * Pure: no Electron, no filesystem, no clock (node --test covers it).
 */

export type UsageKind =
  | 'launch' | 'screen' | 'action' | 'play' | 'stall' | 'error' | 'slow'
  | 'crash' | 'network' | 'sync' | 'update' | 'memory' | 'dropped'
  | (string & {})

export type DetailValue = string | number | boolean | null
export type UsageDetail = Record<string, DetailValue>

export interface UsageEvent {
  t: string
  kind: UsageKind
  name: string
  ms?: number
  ok?: boolean
  detail?: UsageDetail
}

export type UsageDevice = 'macbook' | 'workmini' | 'homemini'

export interface UsageBatch {
  device: UsageDevice
  app: 'desktop'
  build: string
  events: UsageEvent[]
}

export const USAGE_ROUTE = '/api/usage-log'
export const MAX_EVENTS_PER_POST = 500
export const MAX_BYTES_PER_POST = 256 * 1024
export const MAX_DETAIL_BYTES = 1024
export const MAX_STRING = 200
export const MAX_NAME = 80
/** A renderer batch over IPC; more is refused whole (a runaway loop, not a log). */
export const MAX_EVENTS_PER_IPC = 200

/** Which of the three Macs this is, from its host name. Anything unknown is the MacBook (the dev machine). */
export function deviceFromHostname(hostname: string): UsageDevice {
  const h = hostname.trim().toLowerCase()
  if (/^workmini\b/.test(h)) return 'workmini'
  // homemini's host name is "Jakes-Mini-6224" / "Jakes-Mac-mini…" (offload-audio.ts AUDIO_HOST_NAME).
  if (/^homemini\b/.test(h) || /^jakes-(mac-)?mini\b/.test(h)) return 'homemini'
  return 'macbook'
}

// ── scrubbing ─────────────────────────────────────────────────────────────

const SECRET_KEY = /(token|secret|password|passwd|authorization|auth|cookie|api[-_]?key|apikey|bearer|credential|session|companion)/i
/** Keys whose values are words Jake typed or sang along to: dropped whole. */
const LYRIC_KEY = /lyric|^(q|query|queries|search|searches|searchterms?|term|terms|keywords?|words|typed|input|text)$|query|search/i
const SECRET_SHAPES: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,                       // vendor keys (sk-ant-…, sk-…)
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,   // JWTs
]
/**
 * A long opaque run (a token, a hash of one). A run of hex digits (a git sha, a
 * content hash) keeps its first 12, which name a build and unlock nothing.
 */
const OPAQUE = /\b[A-Za-z0-9+/_=-]{32,}\b/g
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const URL_QUERY = /\b((?:https?|ipod-audio|file):\/\/[^\s?#"']*)[?#][^\s"']*/gi
/** A query string with no scheme in front: "/api/search?q=…&token=…", or a bare "?q=…". */
const BARE_QUERY = /((?:^|[\s("'=])\/?[A-Za-z0-9._~%/-]*)\?[A-Za-z0-9_.%-]+=[^\s"']*/g
/** user:password@ (or a lone user@) in a URL. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi
/**
 * A header or a key=value whose name says what it is: "X-JakeTunes-Companion: abc",
 * "Authorization: Basic …", "token=…", "password: …". The value goes, however short.
 */
const NAMED_SECRET = /\b([A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|pwd|authorization|auth(?!or)|companion|api[-_]?key|apikey|cookie|session|credential)[A-Za-z0-9_-]*)(\s*[:=]\s*)(?:(?:Basic|Bearer|Token|Digest)\s+)?("[^"]*"|'[^']*'|[^\s,;&]+)/gi

const encoder = new TextEncoder()
export const utf8Bytes = (s: string): number => encoder.encode(s).length

/** Cut a string to at most `max` UTF-8 bytes, an ellipsis marking the cut. */
function cutBytes(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s
  const chars = Array.from(s)
  let out = ''
  let bytes = 0
  for (const c of chars) {
    const b = utf8Bytes(c)
    if (bytes + b > max - 3) break
    out += c
    bytes += b
  }
  return `${out}…`
}

/**
 * A path, made safe. The music library's own relative path (the part from
 * `iPod_Control/` on, or `F12/ABCD.m4a`) may stay; anything else on the disk
 * is "[path]". `ipod-audio://` URLs are decoded first.
 */
export function scrubPath(p: string): string {
  let s = p
  if (/^ipod-audio:\/\//i.test(s)) {
    s = s.replace(/^ipod-audio:\/\//i, '')
    try { s = decodeURIComponent(s) } catch { /* keep as is */ }
  }
  const lib = /iPod_Control[/\\]Music[/\\](.+)$/i.exec(s)
  if (lib) return `iPod_Control/Music/${lib[1].replace(/\\/g, '/')}`.slice(0, MAX_STRING)
  return '[path]'
}

// A path runs to a quote, a comma, a bracket or the end: "Application Support" has a space in it.
const ABS_PATH = /(?:file:\/\/|ipod-audio:\/\/)[^\s"']+|(?:~|\/(?:Users|Volumes|private|var|tmp|Applications|Library|System|opt|home))\/[^"'\n,;()]*/g

/** One string, made safe and short. */
export function scrubString(input: string): string {
  let s = input
  s = s.replace(URL_USERINFO, '$1[secret]@')
  s = s.replace(URL_QUERY, '$1')
  s = s.replace(BARE_QUERY, '$1')
  s = s.replace(NAMED_SECRET, '$1$2[secret]')
  s = s.replace(ABS_PATH, (m) => scrubPath(m))
  for (const re of SECRET_SHAPES) s = s.replace(re, '[secret]')
  s = s.replace(EMAIL, '[email]')
  s = s.replace(OPAQUE, (m) => (/^[0-9a-f]+$/i.test(m) ? m.slice(0, 12) : '[secret]'))
  return cutBytes(s, MAX_STRING)
}

/** A name: short, stable, lower-case words with . : _ - only. */
export function scrubName(name: unknown): string {
  const s = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return (s || 'unnamed').slice(0, MAX_NAME)
}

/**
 * A detail object, flat and small. Nested objects and arrays are left out
 * (arrays of plain values become their length), so is anything whose key
 * names a secret, a lyric or typed words (q, query, search…). Over 1 KB of
 * UTF-8, keys are dropped from the end and
 * `truncated: true` says so.
 */
export function scrubDetail(raw: unknown): UsageDetail | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: UsageDetail = {}
  let n = 0
  for (const [k0, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 40) break
    const k = k0.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)
    if (!k || SECRET_KEY.test(k) || LYRIC_KEY.test(k)) continue
    if (v === null || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'number') { if (Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000 }
    else if (typeof v === 'string') out[k] = scrubString(v)
    else if (Array.isArray(v)) out[`${k}Count`] = v.length
    else continue
    n++
  }
  // Sized in UTF-8 bytes, as homemini sizes it: an accented title is longer than it looks.
  let json = JSON.stringify(out)
  if (utf8Bytes(json) > MAX_DETAIL_BYTES) {
    const keys = Object.keys(out)
    while (keys.length && utf8Bytes(JSON.stringify(out)) > MAX_DETAIL_BYTES - 20) delete out[keys.pop()!]
    out.truncated = true
    json = JSON.stringify(out)
  }
  return json === '{}' ? undefined : out
}

/**
 * The one door: anything that claims to be an event comes out as a clean one,
 * or null when it can't be one. `now` stamps an event that has no usable time.
 */
export function scrubEvent(raw: unknown, now: number): UsageEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.kind !== 'string' || !o.kind.trim()) return null
  if (o.name === undefined || o.name === null || String(o.name).trim() === '') return null
  const tMs = typeof o.t === 'string' ? Date.parse(o.t) : typeof o.t === 'number' ? o.t : NaN
  const ev: UsageEvent = {
    t: new Date(Number.isFinite(tMs) ? tMs : now).toISOString(),
    kind: scrubName(o.kind).slice(0, 20),
    name: scrubName(o.name),
  }
  if (typeof o.ms === 'number' && Number.isFinite(o.ms) && o.ms >= 0) ev.ms = Math.round(o.ms)
  if (typeof o.ok === 'boolean') ev.ok = o.ok
  const d = scrubDetail(o.detail)
  if (d) ev.detail = d
  return ev
}

// ── network routes ───────────────────────────────────────────────────────

/**
 * A homemini URL as a route: the path only, never the query, with anything that
 * looks like an id or a name ("/api/albums/Radiohead%7COK%20Computer/page")
 * folded to ":x" so one route is one name.
 */
export function routeOf(url: string): string {
  let path: string
  try { path = new URL(url).pathname } catch { path = url.split(/[?#]/)[0] }
  const segs = path.split('/').filter(Boolean).map((seg) => {
    if (/^\d+$/.test(seg)) return ':id'
    if (/^[a-z][a-z0-9-]{0,31}$/.test(seg)) return seg
    if (/^[a-z][a-z0-9-]{0,31}(\.[a-z0-9]{1,5})$/.test(seg)) return seg   // usage-log.json, cover.jpg
    return ':x'
  })
  return `/${segs.slice(0, 8).join('/')}`
}

// ── IPC channels as events ───────────────────────────────────────────────

/** Channels that only read: logged only when slow or failed, or every look at a page would be a line. */
const READ_CHANNEL = /^(get|load|list|read|check|search|lookup|preview|inspect|scan|track-local|plays-elsewhere|artist-image|album-art|playlist-cover$|playlist-covers-map|playlist-notes-get|brain-status|embedding-status|artwork-backfill-status|nav-dx|update-ready:get)|:(get|list|status|known|all|env|look|lately|rsvps|proposals|info|local-plays|wanted-shelf|nav-state)$|-status$/
/** Called many times a minute as the app runs: never worth a line unless slow or failed. */
const CHATTY_CHANNEL = /^(save-ui-state|set-library-context|ipod-audio|musicman-prefetch-facts|bandcamp:(resize|set-visible|nav-state)|record-shop:resolve|refresh-deezer-preview)$/

/** The names Jake's actions carry in the log, where the channel's own name says less. */
const CHANNEL_NAMES: Record<string, { kind: UsageKind; name: string }> = {
  'rip-cd-tracks': { kind: 'action', name: 'import.cd' },
  'import-track': { kind: 'action', name: 'import.file' },
  'import-tracks': { kind: 'action', name: 'import.files' },
  'sync-ipod': { kind: 'sync', name: 'ipod.sync' },
  'sync-to-ipod': { kind: 'sync', name: 'ipod.sync' },
  'plan-ipod-sync': { kind: 'sync', name: 'ipod.plan' },
  'preview-ipod-sync': { kind: 'sync', name: 'ipod.preview' },
  'cancel-sync': { kind: 'sync', name: 'ipod.sync-cancel' },
  'eject-ipod': { kind: 'action', name: 'ipod.eject' },
  'register-ipod-device': { kind: 'action', name: 'ipod.register' },
  'rename-ipod-device': { kind: 'action', name: 'ipod.rename' },
  'save-metadata-override': { kind: 'action', name: 'edit.track' },
  'apply-overrides-batch': { kind: 'action', name: 'edit.apply-overrides' },
  'save-playlists': { kind: 'action', name: 'playlist.save' },
  'playlist-note-set': { kind: 'action', name: 'playlist.headline' },
  'playlist-cover-pick': { kind: 'action', name: 'cover.pick' },
  'playlist-cover-clear': { kind: 'action', name: 'cover.clear' },
  'set-custom-artwork': { kind: 'action', name: 'cover.custom' },
  'download-track': { kind: 'action', name: 'download.track' },
  'streamrip:download': { kind: 'action', name: 'download.qobuz' },
  'streamrip:download-id': { kind: 'action', name: 'download.qobuz' },
  'streamrip:download-by-query': { kind: 'action', name: 'download.qobuz' },
  'musicman-ask': { kind: 'action', name: 'musicman.ask' },
  'musicman-chat': { kind: 'action', name: 'musicman.chat' },
  'record-play': { kind: 'play', name: 'play.counted' },
  'record-skip': { kind: 'action', name: 'skip' },
  'record-rating': { kind: 'action', name: 'rate' },
  'install-update-now': { kind: 'update', name: 'update.install-click' },
  'update-ready:decide': { kind: 'update', name: 'update.decide-click' },
  'update-ready:cancel': { kind: 'update', name: 'update.cancel-click' },
}

/** Slower than this, a read is worth a line. */
export const SLOW_IPC_MS = 1000

/**
 * What one answered invoke becomes in the log, or null when it isn't worth a
 * line. Refusals of another window's sender are never logged (not Jake).
 */
export function ipcEvent(o: { channel: string; ms: number; ok: boolean; error?: string; refused?: boolean }): { kind: UsageKind; name: string; ms: number; ok: boolean; detail?: UsageDetail } | null {
  if (o.refused) return null
  const mapped = CHANNEL_NAMES[o.channel]
  const quiet = !mapped && (READ_CHANNEL.test(o.channel) || CHATTY_CHANNEL.test(o.channel))
  if (quiet && o.ok && o.ms < SLOW_IPC_MS) return null
  const kind: UsageKind = !o.ok ? 'error' : quiet ? 'slow' : (mapped?.kind ?? 'action')
  const name = mapped ? mapped.name : `ipc.${scrubName(o.channel)}`
  const detail: UsageDetail = {}
  if (!o.ok && o.error) detail.error = scrubString(o.error)
  if (!o.ok || quiet) detail.channel = scrubName(o.channel)
  return { kind, name, ms: o.ms, ok: o.ok, ...(Object.keys(detail).length ? { detail } : {}) }
}

// ── batching ─────────────────────────────────────────────────────────────


/**
 * Split serialized events (one JSON line each) into POST-sized batches: at
 * most MAX_EVENTS_PER_POST each, and a body (with its envelope) under
 * MAX_BYTES_PER_POST. A single line over the byte limit gets a batch of its
 * own (homemini answers 413 and the sender drops it, counted).
 */
export function planBatches(lines: string[], envelopeBytes: number, maxEvents = MAX_EVENTS_PER_POST, maxBytes = MAX_BYTES_PER_POST): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  let bytes = envelopeBytes
  for (const line of lines) {
    const b = utf8Bytes(line) + 1
    if (cur.length && (cur.length >= maxEvents || bytes + b > maxBytes)) {
      out.push(cur)
      cur = []
      bytes = envelopeBytes
    }
    cur.push(line)
    bytes += b
  }
  if (cur.length) out.push(cur)
  return out
}

/** The POST body for a batch of already-scrubbed JSON lines. */
export function batchBody(device: UsageDevice, build: string, lines: string[]): string {
  return `{"device":${JSON.stringify(device)},"app":"desktop","build":${JSON.stringify(build)},"events":[${lines.join(',')}]}`
}

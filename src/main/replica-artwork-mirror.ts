// Full artwork mirror for replicas (2026-10-19). Jake: workmini's artwork must
// be identical to the MacBook's, "eye for eye" — "doesnt have the artwork on
// workmini and it does on this macbook".
//
// Measured that day, workmini against the laptop (artwork/index.json + jpgs):
//   • 143 of the laptop's 3,001 keys missing (e.g. geese|||a beautiful memory)
//   • 581 keys naming a different version
//   • 894 keys naming the SAME version over different jpg bytes
// Content diff: 1,090 distinct files (477.7 MB) to fetch; 475 of the 581
// version mismatches already had the right bytes (index-only fix).
//
// Why it drifted: art reached workmini by the laptop's deploy push, which has
// failed nightly since August; replacing art rewrites <bare>.jpg in place and
// only bumps the index's `_<epoch>` suffix; workmini no longer mounts the NAS,
// on purpose. homemini holds a checksum mirror of the laptop's artwork dir, so
// a replica pulls from there over HTTP, the same way the concert poster mirror
// (replica-concerts.ts) does, generalized to the whole store:
//
//   1. GET /api/artwork-mirror/manifest (ETag; 304 when nothing changed)
//        → { v: 1, index, files: { <bare>: [size, md5] } }
//   2. verify each local jpg by md5 (cached in artwork/replica-mirror.json by
//      size+mtime, so only the first run hashes the store)
//   3. index entries whose bytes already match → one index save
//   4. changed / missing jpgs → serial downloads from /artwork/:bare, paced
//      BETWEEN requests (range-chunk-download.ts — never by reading slowly),
//      yielding to playback, md5-verified, written atomically, in priority
//      order (concert keys, then recently added/played albums, then keys
//      missing here, then the rest). Each landed file drops the main-process
//      byte cache + thumbs for its hash; the index and the renderer are told
//      per BATCH, never per file.
//
// Never deletes: a key or jpg the laptop lacks stays. A key the laptop HAS is
// the laptop's (a replica mirrors; it does not author), and a jpg is only
// overwritten when its content hash differs from the laptop's and the
// downloaded bytes hash to exactly what the manifest promised (identity-gated).
// The ledger is what makes a 1,600-file first sync resumable across restarts:
// landed files are recorded by md5, so a relaunch re-plans from the manifest
// and fetches only what is still different.
//
// Electron-free: every path, cache and fetch is injected so node --test loads it.
// ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/artworkManifest.ts + routes/artworkMirror.ts
// (the manifest shape; change both together).
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withCompanionInit } from './hub-companion.ts'
import { fetchInRangeChunks } from './range-chunk-download.ts'

export const MANIFEST_PATH = '/api/artwork-mirror/manifest'
/** artwork/<this>: { v: 1, files: { bare: [size, mtimeMs, md5] } } — what each local jpg IS. */
export const MIRROR_LEDGER_FILE = 'replica-mirror.json'
const BARE = /^[0-9a-f]{32}$/
const MD5 = /^[0-9a-f]{32}$/
const INDEX_VALUE = /^[0-9a-f]{32}(?:_\d+)?$/
/** Sanity ceiling only — the laptop's largest cover is 27.8 MB (4fb31690…, 2026-10-19). */
const MAX_ART_BYTES = 64 * 1024 * 1024

/** Office link (workmini, ~300-750 KB/s measured, congested): a third of the
 *  measured floor, so a song can still start while the mirror runs. An
 *  AVERAGE: each file arrives at wire speed (homemini's /artwork ignores
 *  Range, so it is one request), then the mirror waits out the rest of the
 *  file's share before the next one. Reading the body slowly instead got the
 *  socket dropped at ~30 s (workmini 2026-10-19: 2/3 of the 2.9 MB aa82bc48…). */
export const THIN_LINK_PACE_BYTES_PER_SEC = 96_000
export const FAT_LINK_PACE_BYTES_PER_SEC = 2_000_000

export interface MirrorManifest {
  index: Record<string, string>
  /** bare → [size, md5] */
  files: Record<string, [number, string]>
}

export const bareOf = (hash: string): string => hash.replace(/_\d+$/, '')

/** The hub's manifest body, or null when it isn't one. Bad entries are dropped;
 *  a body without the v1 shape is refused whole. Null-prototype maps, so a
 *  '__proto__' key stays data. */
export function parseManifest(body: unknown): MirrorManifest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as { v?: unknown; index?: unknown; files?: unknown }
  if (b.v !== 1 || !b.index || typeof b.index !== 'object' || !b.files || typeof b.files !== 'object') return null
  const index: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [k, v] of Object.entries(b.index as Record<string, unknown>)) {
    if (k.includes('|||') && k.length <= 512 && typeof v === 'string' && INDEX_VALUE.test(v)) index[k] = v
  }
  const files: Record<string, [number, string]> = Object.create(null) as Record<string, [number, string]>
  for (const [bare, v] of Object.entries(b.files as Record<string, unknown>)) {
    if (!BARE.test(bare) || !Array.isArray(v) || v.length !== 2) continue
    const [size, md5] = v as [unknown, unknown]
    if (typeof size === 'number' && Number.isInteger(size) && size > 0 && size <= MAX_ART_BYTES && typeof md5 === 'string' && MD5.test(md5)) files[bare] = [size, md5]
  }
  return { index, files }
}

export interface MirrorPlan {
  /** key → laptop hash, for keys whose bytes already match here (save now). */
  indexNow: Record<string, string>
  /** Bares to fetch, highest priority first. */
  downloads: string[]
  /** bare → the keys that may point at it once it has landed. */
  keysByBare: Map<string, string[]>
  /** Download counts per priority tier (for the log). */
  tiers: { priority: number; missingKey: number; rest: number; orphan: number }
}

/**
 * Pure diff of the laptop's store (manifest) against this one.
 * `localMd5(bare)` is the VERIFIED md5 of the local jpg, null when absent.
 * `priority` lists keys most likely on screen first (concerts, recent albums).
 */
export function planMirror(
  local: Readonly<Record<string, string>>,
  remote: MirrorManifest,
  localMd5: (bare: string) => string | null,
  priority: readonly string[],
): MirrorPlan {
  const indexNow: Record<string, string> = {}
  const keysByBare = new Map<string, string[]>()
  const need = new Set<string>()
  const matches = (bare: string): boolean => {
    const f = remote.files[bare]
    return !!f && localMd5(bare) === f[1]
  }
  for (const [key, hash] of Object.entries(remote.index)) {
    const bare = bareOf(hash)
    if (!remote.files[bare]) continue           // homemini hasn't got the file yet: leave ours
    if (matches(bare)) {
      if (local[key] !== hash) indexNow[key] = hash
      continue
    }
    need.add(bare)
    const ks = keysByBare.get(bare)
    if (ks) ks.push(key)
    else keysByBare.set(bare, [key])
  }
  // A jpg no key names (the laptop's resolver can still find it by hash on
  // disk): mirrored too, last.
  const orphans: string[] = []
  const named = new Set(Object.values(remote.index).map(bareOf))
  for (const bare of Object.keys(remote.files)) {
    if (!named.has(bare) && !matches(bare)) orphans.push(bare)
  }

  const order: string[] = []
  const seen = new Set<string>()
  const take = (bare: string | undefined): boolean => {
    if (!bare || seen.has(bare) || !need.has(bare)) return false
    seen.add(bare)
    order.push(bare)
    return true
  }
  const tiers = { priority: 0, missingKey: 0, rest: 0, orphan: 0 }
  for (const key of priority) {
    const h = remote.index[key]
    if (h && take(bareOf(h))) tiers.priority++
  }
  for (const [key, hash] of Object.entries(remote.index)) {
    if (local[key] === undefined && take(bareOf(hash))) tiers.missingKey++
  }
  for (const bare of need) if (take(bare)) tiers.rest++
  for (const bare of orphans) {
    if (!seen.has(bare)) { seen.add(bare); order.push(bare); tiers.orphan++ }
  }
  return { indexNow, downloads: order, keysByBare, tiers }
}

export interface RecentRow {
  artist?: string | null
  album?: string | null
  dateAdded?: string | number | null
  lastPlayedAt?: number | null
}

/** Album artwork keys by most recent add/play, newest first (the albums the
 *  UI's Home, Recently Added and recent-plays surfaces are most likely to show). */
export function recentAlbumKeys(rows: readonly RecentRow[], limit = 600): string[] {
  const best = new Map<string, number>()
  for (const r of rows) {
    if (!r || !r.artist || !r.album) continue
    const key = `${String(r.artist).toLowerCase().trim()}|||${String(r.album).toLowerCase().trim()}`
    const added = typeof r.dateAdded === 'number' ? r.dateAdded : Date.parse(String(r.dateAdded ?? '')) || 0
    const t = Math.max(added, Number(r.lastPlayedAt) || 0)
    if (t > (best.get(key) ?? -1)) best.set(key, t)
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k)
}

export function md5OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('md5')
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

export interface ArtworkMirrorUpdate {
  /** key → hash entries now in the index (merge into the renderer's map). */
  entries: Record<string, string>
  /** Bares whose BYTES changed here (the renderer re-requests them). */
  bares: string[]
}

export interface ReplicaArtworkMirrorDeps {
  /** Hub origin on a replica; null on the canonical laptop (then all inert). */
  hubBase: () => Promise<string | null>
  artwork: {
    dir: string
    loadIndex: () => Promise<Record<string, string>>
    saveIndex: (index: Record<string, string>) => Promise<void>
  }
  /** Drop the main-process byte cache + thumbs for a bare (invalidateArtBytes). */
  invalidate: (bare: string) => void
  /** Keys to fetch first (concert posters, recent albums). */
  priorityKeys: () => Promise<readonly string[]>
  isPlaying: () => boolean
  /** Read pace for downloads (bytes/s); 0 = wire speed. */
  paceBytesPerSec: () => Promise<number>
  /** One batch landed / index entries changed: tell the renderer ONCE. */
  notify: (u: ArtworkMirrorUpdate) => void
  /** Optional: thumbs for freshly landed art (pregeneration). */
  onLanded?: (bares: string[]) => void
  fetchImpl?: typeof fetch
  log?: (msg: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  intervalMs?: number
  /** Playback must have been off this long before the next download. */
  quietMs?: number
  pollMs?: number
  batchFiles?: number
  batchMs?: number
}

export interface ReplicaArtworkMirrorHandle {
  stop: () => void
  /** One full pass (manifest → verify → index → downloads). Single-flight. */
  tick: () => Promise<void>
  /** True while the hub serves the manifest — the concert poster pass defers to us. */
  active: () => boolean
}

type Ledger = Record<string, [number, number, string]>   // bare → [size, mtimeMs, md5]

export function startReplicaArtworkMirror(deps: ReplicaArtworkMirrorDeps): ReplicaArtworkMirrorHandle {
  const log = deps.log ?? ((m: string) => console.warn(m))
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const quietMs = deps.quietMs ?? 30_000
  const pollMs = deps.pollMs ?? 5_000
  const batchFiles = deps.batchFiles ?? 25
  const batchMs = deps.batchMs ?? 60_000
  const dir = deps.artwork.dir
  const ledgerPath = join(dir, MIRROR_LEDGER_FILE)
  let etag: string | null = null
  let manifest: MirrorManifest | null = null
  let manifestOkAt = 0
  let inFlight = false
  let stopped = false
  let lastPlayingAt = -Infinity
  let lastSummary = ''
  let current: AbortController | null = null

  async function loadLedger(): Promise<Ledger> {
    try {
      const raw = JSON.parse(await readFile(ledgerPath, 'utf-8')) as { v?: number; files?: unknown }
      if (raw?.v === 1 && raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files)) return raw.files as Ledger
    } catch { /* first run, or unreadable: re-verify by hashing */ }
    return {}
  }

  async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
    const tmp = `${path}.${process.pid}.${now()}.tmp`
    try {
      await writeFile(tmp, data)
      await rename(tmp, path)
    } catch (err) {
      await unlink(tmp).catch((e: unknown) => log(`[art-mirror] could not remove ${tmp}: ${(e as Error)?.message ?? e}`))
      throw err
    }
  }

  /** The md5 of each local jpg the manifest names (null = absent), via the ledger when size+mtime still match. */
  async function verifyLocal(bares: readonly string[], ledger: Ledger): Promise<{ md5: Map<string, string | null>; hashed: number }> {
    const out = new Map<string, string | null>()
    let hashed = 0
    for (const bare of bares) {
      if (stopped) break
      const p = join(dir, `${bare}.jpg`)
      let st
      try { st = await stat(p) } catch { out.set(bare, null); continue }
      if (!st.isFile() || st.size === 0) { out.set(bare, null); continue }
      const l = ledger[bare]
      if (l && l[0] === st.size && l[1] === st.mtimeMs) { out.set(bare, l[2]); continue }
      try {
        const md5 = await md5OfFile(p)
        ledger[bare] = [st.size, st.mtimeMs, md5]
        out.set(bare, md5)
        hashed++
      } catch { out.set(bare, null) }
    }
    return { md5: out, hashed }
  }

  /** Resolves once playback has been off for quietMs (track changes flip it
   *  briefly). Music on workmini shares the office link: the mirror never
   *  competes with a song. Returns the ms spent waiting. */
  async function waitForQuiet(): Promise<number | 'stopped'> {
    const from = now()
    for (;;) {
      if (stopped) return 'stopped'
      const t = now()
      if (deps.isPlaying()) lastPlayingAt = t
      if (t - lastPlayingAt >= quietMs) return t - from
      await sleep(pollMs)
    }
  }

  type Outcome = ({ kind: 'landed'; bytes: number; mtimeMs: number } | { kind: 'playback' } | { kind: 'mismatch' } | { kind: 'failed'; why: string }) & { paceDebtMs?: number }

  async function downloadOne(origin: string, bare: string, want: [number, string]): Promise<Outcome> {
    const ac = new AbortController()
    current = ac
    let why: 'playback' | null = null
    const watch = setInterval(() => { if (deps.isPlaying()) { why = 'playback'; ac.abort() } }, 1_000)
    const pace = await deps.paceBytesPerSec()
    // Generous ceiling: the size at the pace, plus slack for a slow start.
    const deadline = setTimeout(() => ac.abort(), Math.max(60_000, pace > 0 ? (want[0] / pace) * 3_000 : 0))
    try {
      const chunks: Uint8Array[] = []
      const got = await fetchInRangeChunks(`${origin}/artwork/${bare}`, (c) => { chunks.push(c) }, {
        fetchFn: fetchImpl, bytesPerSec: pace, signal: ac.signal, headers: { accept: 'image/*' },
        stallMs: 20_000, maxBytes: MAX_ART_BYTES, now, sleep,
        onFirstResponse: ({ status, contentType }) => {
          if (status < 200 || status > 299 || !contentType.startsWith('image/')) throw new Error(`HTTP ${status} ${contentType}`)
        },
      })
      const bytes = Buffer.concat(chunks)
      const md5 = createHash('md5').update(bytes).digest('hex')
      // Identity gate: only bytes that ARE the laptop's file replace ours.
      if (bytes.length !== want[0] || md5 !== want[1]) return { kind: 'mismatch', paceDebtMs: got.paceDebtMs }
      const target = join(dir, `${bare}.jpg`)
      await writeAtomic(target, bytes)
      const st = await stat(target)
      return { kind: 'landed', bytes: bytes.length, mtimeMs: st.mtimeMs, paceDebtMs: got.paceDebtMs }
    } catch (err) {
      if (why === 'playback') return { kind: 'playback' }
      const msg = (err as Error)?.message ?? String(err)
      return { kind: 'failed', why: /^oversized/.test(msg) ? 'oversized' : msg }
    } finally {
      clearInterval(watch)
      clearTimeout(deadline)
      current = null
    }
  }

  /** Hold the average pace between files (a whole file arrives at wire speed). */
  async function settle(ms: number): Promise<void> {
    for (let left = ms; left > 0 && !stopped;) {
      const step = Math.min(left, pollMs)
      await sleep(step)
      left -= step
    }
  }

  async function fetchManifest(origin: string): Promise<MirrorManifest | 'unchanged' | 'absent' | null> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 120_000)
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (etag && manifest) headers['If-None-Match'] = etag
      const res = await fetchImpl(`${origin}${MANIFEST_PATH}`, withCompanionInit({ signal: ac.signal, headers }))
      if (res.status === 304) return 'unchanged'
      if (res.status === 404) return 'absent'
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`)
      const parsed = parseManifest(await res.json())
      if (!parsed) throw new Error('manifest did not parse')
      etag = res.headers.get('etag')
      return parsed
    } finally { clearTimeout(timer) }
  }

  async function pass(): Promise<void> {
    const base = await deps.hubBase()
    if (!base) return
    const origin = base.replace(/\/$/, '')
    let m: MirrorManifest | 'unchanged' | 'absent' | null
    try { m = await fetchManifest(origin) } catch (err) {
      log(`[art-mirror] manifest pull failed (will retry): ${(err as Error)?.message ?? err}`)
      return
    }
    if (m === 'absent') { manifestOkAt = 0; return }   // an older hub: the concert poster pass carries on
    manifestOkAt = now()
    if (m !== 'unchanged') manifest = m
    if (!manifest) return
    const remote = manifest

    const ledger = await loadLedger()
    const { md5: localMd5, hashed } = await verifyLocal(Object.keys(remote.files), ledger)
    if (stopped) return
    if (hashed > 0) await writeAtomic(ledgerPath, JSON.stringify({ v: 1, files: ledger }))
    const localIndex = await deps.artwork.loadIndex()
    let priority: readonly string[] = []
    try { priority = await deps.priorityKeys() } catch { priority = [] }
    const plan = planMirror(localIndex, remote, (b) => localMd5.get(b) ?? null, priority)

    // Index entries whose bytes already match: one save, one notify.
    if (Object.keys(plan.indexNow).length) {
      const latest = await deps.artwork.loadIndex()
      await deps.artwork.saveIndex({ ...latest, ...plan.indexNow })
      deps.notify({ entries: plan.indexNow, bares: [] })
    }
    const total = plan.downloads.length
    const summary = `${total} file(s) to fetch (priority ${plan.tiers.priority}, missing keys ${plan.tiers.missingKey}, rest ${plan.tiers.rest}, unnamed ${plan.tiers.orphan}); ${Object.keys(plan.indexNow).length} index entr(ies) fixed in place`
    if (total === 0) {
      const line = `[art-mirror] in sync with the laptop: ${Object.keys(remote.index).length} keys, ${Object.keys(remote.files).length} files`
      if (line !== lastSummary || Object.keys(plan.indexNow).length) log(Object.keys(plan.indexNow).length ? `${line} (${summary})` : line)
      lastSummary = line
      return
    }
    log(`[art-mirror] ${summary}`)
    lastSummary = ''

    let entries: Record<string, string> = {}
    let landed: string[] = []
    let lastFlush = now()
    let landedTotal = 0
    let bytesTotal = 0
    let failures = 0
    let consecutive = 0
    let pausedMs = 0
    let notBefore = 0
    const started = now()
    const flush = async (): Promise<void> => {
      if (!landed.length && !Object.keys(entries).length) return
      const batchEntries = entries
      const batchBares = landed
      entries = {}
      landed = []
      lastFlush = now()
      if (Object.keys(batchEntries).length) {
        const latest = await deps.artwork.loadIndex()
        await deps.artwork.saveIndex({ ...latest, ...batchEntries })
      }
      await writeAtomic(ledgerPath, JSON.stringify({ v: 1, files: ledger }))
      deps.notify({ entries: batchEntries, bares: batchBares })
      deps.onLanded?.(batchBares)
    }

    for (let i = 0; i < plan.downloads.length; i++) {
      const bare = plan.downloads[i]!
      const waited = await waitForQuiet()
      if (waited === 'stopped') break
      pausedMs += waited
      const want = remote.files[bare]!
      await settle(notBefore - now())                         // the last file's share of the pace
      if (stopped) break
      const out = await downloadOne(origin, bare, want)
      notBefore = now() + (out.paceDebtMs ?? 0)
      if (out.kind === 'playback') { i--; continue }          // same file, after the music stops
      if (out.kind === 'landed') {
        consecutive = 0
        landedTotal++
        bytesTotal += out.bytes
        ledger[bare] = [out.bytes, out.mtimeMs, want[1]]
        deps.invalidate(bare)
        landed.push(bare)
        for (const key of plan.keysByBare.get(bare) ?? []) entries[key] = remote.index[key]!
      } else {
        failures++
        consecutive++
        log(`[art-mirror] ${bare} not fetched (${out.kind === 'failed' ? out.why : 'bytes did not match the manifest — homemini mid-sync?'}) — next pass retries`)
        if (consecutive >= 5) { log('[art-mirror] 5 failures in a row — stopping this pass (hub or link down?)'); break }
      }
      if (landed.length >= batchFiles || now() - lastFlush >= batchMs) await flush()
    }
    await flush()
    const mins = ((now() - started) / 60_000).toFixed(1)
    log(`[art-mirror] pass done: landed ${landedTotal}/${total} (${(bytesTotal / 1e6).toFixed(1)} MB) in ${mins} min (${(pausedMs / 60_000).toFixed(1)} of it paused for playback)${failures ? `, ${failures} not fetched` : ''}`)
  }

  async function tick(): Promise<void> {
    if (stopped || inFlight) return
    inFlight = true
    try { await pass() } catch (err) {
      log(`[art-mirror] pass failed (will retry): ${(err as Error)?.message ?? err}`)
    } finally { inFlight = false }
  }

  const timer = setInterval(() => { void tick() }, deps.intervalMs ?? 10 * 60_000)
  timer.unref?.()
  return {
    stop: () => { stopped = true; clearInterval(timer); current?.abort() },
    tick,
    // A first sync can run for hours (it waits out every song): active for its whole length.
    active: () => manifestOkAt > 0 && (inFlight || now() - manifestOkAt < 30 * 60_000),
  }
}

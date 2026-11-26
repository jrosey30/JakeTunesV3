/**
 * The fake-card rig the swap-engine tests share (split out of ipod-swap-engine.test.ts so each
 * file stays well under the 300 s per-file test limit). The real activity engine, the real
 * core/db_reader.py writer and itdb_verify.py validator; only the cold remount is stubbed.
 * Never touches an iPod.
 */
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import { mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { runActivitySync, type ActivitySyncHost, type ActivitySyncResult } from '../ipod-activity-engine.ts'
import { catalogIdsAscend } from '../ipod-swap-sync.ts'
import { parseCatalogPaths } from '../sync-engine/roundtrip.ts'

export const REPO = join(import.meta.dirname, '..', '..', '..')
export const N = 20
export const SONG_BYTES = 250_000    // 250 KB over 200 s = 10 kbps: the validator's bitrate floor is 8
export const DURATION_MS = 200_000   // shorter reads as a skit and never boards

/** An empty iTunesDB, the shape db_reader accepts as a template (as core/tests does). */
export function emptyTemplate(): Buffer {
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(0, 8)
  const mhsd = Buffer.alloc(96); mhsd.write('mhsd', 0, 'latin1'); mhsd.writeUInt32LE(96, 4); mhsd.writeUInt32LE(96 + 92, 8); mhsd.writeUInt32LE(1, 12)
  const mhbd = Buffer.alloc(104); mhbd.write('mhbd', 0, 'latin1'); mhbd.writeUInt32LE(104, 4); mhbd.writeUInt32LE(104 + 96 + 92, 8); mhbd.writeUInt32LE(1, 20)
  return Buffer.concat([mhbd, mhsd, mhlt])
}

export interface Rig {
  root: string
  lib: string
  card: string
  state: string
  host: ActivitySyncHost
  library: Map<number, Record<string, unknown>>
  events: Array<{ phase: string; title: string; mode?: string; summary?: string; total: number }>
  /** Hook run on every progress event (to cancel, or to break the card at a moment). */
  onEvent: (e: { phase: string; title: string }) => void
  cancel: boolean
}

export function songName(id: number): string { return `S${String(id).padStart(3, '0')}.m4a` }
export const folder = (id: number) => `F${String(id % 5).padStart(2, '0')}`

export async function addSong(r: Rig, id: number, bytes = SONG_BYTES, fill = id): Promise<void> {
  const dir = join(r.lib, 'iPod_Control', 'Music', folder(id))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, songName(id)), Buffer.alloc(bytes, fill & 0xff))
  r.library.set(id, {
    id, title: `Song ${id}`, artist: `Band ${String.fromCharCode(65 + (id % 26))}`, album: `Album ${id % 4}`, genre: 'Rock',
    duration: DURATION_MS, codec: 'alac', path: `:iPod_Control:Music:${folder(id)}:${songName(id)}`,
    audioFingerprint: `sha1:${id.toString(16).padStart(8, '0')}|${bytes}`,
  })
}

export function readJsonCatalog(card: string): Promise<{ tracks: Array<Record<string, unknown>>; playlists?: unknown[] }> {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [join(REPO, 'core', 'db_reader.py'), '--json', join(card, 'iPod_Control', 'iTunes', 'iTunesDB')])
    let out = ''
    py.stdout.on('data', (d: Buffer) => { out += d.toString() })
    py.on('error', reject)
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(`db_reader --json exited ${code}`))
      try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
  })
}

export async function makeRig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'jt-swap-engine-'))
  const lib = join(root, 'lib')
  const card = join(root, 'card')
  const state = join(root, 'state')
  await mkdir(join(card, 'iPod_Control', 'iTunes'), { recursive: true })
  await mkdir(join(card, 'iPod_Control', 'Music'), { recursive: true })
  await mkdir(state, { recursive: true })
  await writeFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'), emptyTemplate())
  const r = {
    root, lib, card, state,
    library: new Map(),
    events: [],
    onEvent: () => {},
    cancel: false,
  } as unknown as Rig
  r.host = {
    pythonCmd: 'python3',
    pythonHint: '',
    coreScript: (rel) => join(REPO, rel),
    tempDir: root,
    stateDir: state,
    pid: process.pid,
    musicDir: join(lib, 'iPod_Control', 'Music'),
    pathSep: '/',
    isMac: true,
    sendProgress: (p) => {
      r.events.push({ phase: p.phase, title: p.title, mode: p.mode, summary: p.summary, total: p.total })
      r.onEvent(p)
    },
    isCancelled: () => r.cancel,
    isStreamedTrackFile: async () => false,
    buildAacMirror: async () => null,
    buildIpodSafeAlacMirror: async () => null,
    readIpodDatabase: () => readJsonCatalog(card),
    writeJournal: async () => {},
    writeManifest: async (m) => { await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify(m, null, 1)) },
    writeSeal: async (s) => { await writeFile(join(state, 'ipod-activity-tsa-seal.json'), JSON.stringify(s, null, 2)) },
    clearSeal: async () => { await unlink(join(state, 'ipod-activity-tsa-seal.json')).catch(() => {}) },
    writeReport: async () => {},
    getDetectedMount: () => card,
    setDetectedMount: () => {},
    probeHomeminiTrack: async () => ({ ok: false, error: 'not in this test' }),
    stageTrack: async () => ({ ok: false, error: 'not in this test', reason: 'other' } as never),
    freeBytes: async () => 500 * 1024 ** 3,
    remountVolume: async (m: string) => ({ ok: true, mountPoint: m }),
  }
  for (let id = 0; id < N; id++) await addSong(r, id)
  return r
}

export async function sync(r: Rig, ids: number[], opts: { listOnly?: boolean } = {}): Promise<ActivitySyncResult> {
  r.events = []
  const tracks = ids.map((id) => ({ ...r.library.get(id)! }))
  const playlists = [{ name: 'Top 1000', trackIds: ids }]
  return runActivitySync(r.host, { tracks, playlists, requestedTarget: ids.length, listOnly: opts.listOnly ?? true, ipodName: 'TestPod' })
}

/** Card files: colon path → { size, ino, mtimeMs }. */
export async function cardFiles(card: string): Promise<Map<string, { size: number; ino: number; mtimeMs: number }>> {
  const out = new Map<string, { size: number; ino: number; mtimeMs: number }>()
  const music = join(card, 'iPod_Control', 'Music')
  for (const f of await readdir(music).catch(() => [] as string[])) {
    for (const n of await readdir(join(music, f)).catch(() => [] as string[])) {
      const st = await stat(join(music, f, n))
      out.set(`:iPod_Control:Music:${f}:${n}`, { size: st.size, ino: st.ino, mtimeMs: st.mtimeMs })
    }
  }
  return out
}

/** The card's catalog, as the firmware would see it: paths in record order + id order. */
export async function cardCatalog(card: string): Promise<{ paths: string[]; ascend: boolean | null }> {
  const buf = await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))
  return { paths: parseCatalogPaths(buf) || [], ascend: catalogIdsAscend(buf) }
}

/** The invariant: the catalog on the card names only files that are on the card, at size. */
export async function assertCardWhole(r: Rig): Promise<void> {
  const files = await cardFiles(r.card)
  const { paths, ascend } = await cardCatalog(r.card)
  for (const p of paths) assert.ok(files.has(p) && files.get(p)!.size > 0, `the catalog names ${p}, which is not on the card`)
  assert.equal(ascend, true, 'catalog ids must ascend (the firmware binary search)')
}

export const pathOf = (id: number) => `:iPod_Control:Music:${folder(id)}:${songName(id)}`
export const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i)

/**
 * The activity engine, driven end to end up to the copy on a fake card in a
 * temp folder (no real iPod, no Python, no remount): what does it board?
 *
 * 2026-11-07, iPod EVIL (list-only, its own 500-song list): 74 .flac songs
 * were called "unplayable", plus one segue, and the 75 seats went to library
 * ids 0..77 through the library loader. A list-only set must never call that
 * loader; it lands fewer and says which and why. FLAC goes to conversion.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { runActivitySync, type ActivitySyncHost } from '../ipod-activity-engine.ts'

interface Rig {
  root: string
  host: ActivitySyncHost
  loaderCalls: Array<{ needed: number }>
  alacCalls: string[]
  tracks: Array<Record<string, unknown>>
}

async function rig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'jt-activity-listonly-'))
  const lib = join(root, 'lib')
  const card = join(root, 'card')
  const state = join(root, 'state')
  await mkdir(join(lib, 'iPod_Control', 'Music', 'F00'), { recursive: true })
  await mkdir(join(card, 'iPod_Control', 'Music'), { recursive: true })
  await mkdir(state, { recursive: true })

  const tracks: Array<Record<string, unknown>> = []
  const add = async (id: number, name: string, extra: Record<string, unknown> = {}, onDisk = true) => {
    const path = `:iPod_Control:Music:F00:${name}`
    if (onDisk) await writeFile(join(lib, 'iPod_Control', 'Music', 'F00', name), `audio ${id}`)
    tracks.push({ id, title: `Song ${id}`, artist: `Band ${id}`, album: 'A', genre: 'Rock', duration: 200000, path, ...extra })
  }
  for (let i = 0; i < 6; i++) await add(5000 + i, `${5000 + i}.m4a`, { codec: 'alac' })
  await add(5006, '5006.flac', { codec: null })                                   // FLAC, codec null: boards, converts
  await add(12813, '12813.m4a', { title: 'HIDE ALL YOUR RECORDS SEGUE', duration: 61107, genre: 'Hardcore Punk' })
  await add(5008, '5008.m4a', {}, false)                                          // not on this Mac, homemini misses

  const loaderCalls: Array<{ needed: number }> = []
  const alacCalls: string[] = []
  let copying = false
  const mirror = join(root, 'mirror.m4a')
  await writeFile(mirror, 'alac mirror')

  const host: ActivitySyncHost = {
    pythonCmd: 'python3',
    pythonHint: '',
    coreScript: (rel) => rel,
    tempDir: root,
    stateDir: state,
    pid: 1,
    musicDir: join(lib, 'iPod_Control', 'Music'),
    pathSep: '/',
    isMac: true,
    // Stop at the copy: everything that decides the set has run by then.
    sendProgress: (p) => { if (p.phase === 'copy') copying = true },
    isCancelled: () => copying,
    isStreamedTrackFile: async () => false,
    buildAacMirror: async () => null,
    buildIpodSafeAlacMirror: async (src) => { alacCalls.push(src); return mirror },
    readIpodDatabase: async () => ({ tracks: [] }),
    writeJournal: async () => {},
    writeManifest: async () => {},
    writeSeal: async () => {},
    clearSeal: async () => {},
    writeReport: async () => {},
    getDetectedMount: () => card,
    setDetectedMount: () => {},
    probeHomeminiTrack: async () => ({ ok: false, error: '404' }),
    stageTrack: async () => ({ ok: false, error: 'not staged', reason: 'other' } as never),
    freeBytes: async () => 500 * 1024 ** 3,
    loadReplacementTracks: async (exclude, needed) => {
      loaderCalls.push({ needed })
      // What the old fallback handed out: the lowest library ids.
      const out: Array<Record<string, unknown>> = []
      for (let id = 0; out.length < needed && id < 200; id++) {
        if (exclude.has(id)) continue
        const name = `low${id}.m4a`
        await writeFile(join(lib, 'iPod_Control', 'Music', 'F00', name), `audio ${id}`)
        out.push({ id, title: `Low ${id}`, artist: 'Parallelle', album: 'L', genre: 'House', duration: 200000, path: `:iPod_Control:Music:F00:${name}` })
      }
      return out
    },
  }
  return { root, host, loaderCalls, alacCalls, tracks }
}

async function lastPicks(root: string): Promise<{ pickedIds: number[]; target: number; leftOff?: Array<{ id: number; why: string }>; requested?: number }> {
  const lines = (await readFile(join(root, 'state', 'activity-sync-ledger.jsonl'), 'utf-8')).trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

describe('runActivitySync — list-only iPod', () => {
  it('lands its own list minus what cannot go on, names them, and never asks the library', async () => {
    const r = await rig()
    try {
      const res = await runActivitySync(r.host, { tracks: r.tracks, playlists: [], listOnly: true })
      assert.equal(res.cancelled, true, `stopped at the copy as rigged: ${res.error}`)
      assert.equal(r.loaderCalls.length, 0, 'a list-only set must never call the library loader')

      const picks = await lastPicks(r.root)
      assert.equal(picks.requested, 9)
      assert.equal(picks.target, 7)
      assert.deepEqual(picks.pickedIds.slice().sort((a, b) => a - b), [5000, 5001, 5002, 5003, 5004, 5005, 5006])
      assert.ok(picks.pickedIds.every((id) => id >= 5000), 'nothing from outside the list')
      const why = new Map((picks.leftOff || []).map((l) => [l.id, l.why]))
      assert.match(String(why.get(12813)), /segue/)
      assert.match(String(why.get(5008)), /homemini/)
      assert.equal(why.size, 2)

      // The FLAC went to the ALAC conversion.
      assert.equal(r.alacCalls.length, 1)
      assert.match(r.alacCalls[0], /5006\.flac$/)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('the Original (not list-only) still fills N from the loader — the contrast the guard exists for', async () => {
    const r = await rig()
    try {
      const res = await runActivitySync(r.host, { tracks: r.tracks, playlists: [] })
      assert.equal(res.cancelled, true, `stopped at the copy as rigged: ${res.error}`)
      assert.ok(r.loaderCalls.length > 0)
      const picks = await lastPicks(r.root)
      assert.equal(picks.target, 9)
      assert.equal(picks.pickedIds.length, 9)
      assert.ok(picks.pickedIds.includes(5006), 'the FLAC boards on the Original too')
      assert.ok(!picks.pickedIds.includes(12813))
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

describe('the sync engine tells the activity engine which iPod is list-only', () => {
  it('passes listOnly from the iPod identity and withholds the library loader', async () => {
    const src = await readFile(new URL('../sync-engine/index.ts', import.meta.url), 'utf-8')
    assert.match(src, /listOnlyIpod = !!\(ipod\.device && !ipod\.device\.primary\)/)
    assert.match(src, /loadReplacementTracks: listOnlyIpod \? undefined : bindActivityReplacements\(/)
    assert.match(src, /\{ tracks, playlists, convertOptions, listOnly: listOnlyIpod, ipodName \}/)
  })
})

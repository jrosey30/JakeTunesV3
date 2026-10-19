/**
 * cache-manager.py eviction guard (2026-10-19).
 *
 * workmini's cache warm evicts cold tracks by deleting the real local file
 * and leaving a NAS symlink. It used to do that on "not hot" alone, so a song
 * whose only audio lived on workmini would be deleted the first time the warm
 * ran at home. Now each eviction must prove that homemini serves the SAME bytes
 * for that track id (exact size + first 256 KB + last 64 KB); anything less
 * keeps the file and logs why.
 *
 * These run the shipped script for real: a temp HOME holds library.json and
 * the local cache, a stub `ping` passes the home-LAN gate, and a fake homemini
 * answers /healthz and /audio/:id range reads the way the backend does
 * (206 + Content-Range with the full size; suffix ranges return the tail).
 *
 * CACHE_MANAGER_PY picks the interpreter (workmini runs /usr/bin/python3, 3.9).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scriptPath = join(repoRoot, 'Dr. Claude', 'scripts', 'cache-manager.py')
const PY = process.env.CACHE_MANAGER_PY ?? 'python3'
const KB = 1024

interface FakeTrack { id?: string; path: string; local: Buffer }
type AudioMode = 'serve' | 'drop'

/** Deterministic bytes, so two "songs" never share content by accident. */
function bytes(size: number, seed: number): Buffer {
  const b = Buffer.alloc(size)
  let x = seed * 2654435761 >>> 0
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24 }
  return b
}

/** homemini's /audio/:id, reduced to what the guard reads (mirrors util/rangeHeader.ts). */
async function fakeHomemini(copies: Map<string, Buffer>, mode: AudioMode = 'serve'): Promise<{ server: Server; base: string; audioHits: string[] }> {
  const audioHits: string[] = []
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url === '/healthz') { res.writeHead(200).end('ok'); return }
    const m = /^\/audio\/([^/?]+)$/.exec(url)
    if (!m) { res.writeHead(404).end(); return }
    const id = decodeURIComponent(m[1])
    audioHits.push(id)
    if (mode === 'drop') { req.socket.destroy(); return }
    const file = copies.get(id)
    if (!file) { res.writeHead(404).end('{"error":"Track not found"}'); return }
    const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    if (!r) { res.writeHead(200, { 'Content-Length': file.length }).end(file); return }
    const size = file.length
    let start: number, end: number
    if (r[1] === '') { start = Math.max(0, size - Number(r[2])); end = size - 1 }
    else { start = Number(r[1]); end = r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1) }
    if (size <= 0 || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    res.end(file.subarray(start, end + 1))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}`, audioHits }
}

/** A port nothing listens on: bind, read the number, close. */
async function deadBase(): Promise<string> {
  const s = createServer()
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((ok) => s.close(() => ok()))
  return `http://127.0.0.1:${port}`
}

interface Outcome { home: string; out: string; status: number | null; localPath: (t: FakeTrack) => string }

/** Lay out a workmini HOME, run the shipped script against `base`, report what happened. */
async function runWarm(tracks: FakeTrack[], base: string): Promise<Outcome> {
  const home = mkdtempSync(join(tmpdir(), 'jt-cache-guard-'))
  const appDir = join(home, 'Library', 'Application Support', 'JakeTunes')
  const dst = join(home, 'JakeTunesLib', 'JakeTunesLibrary')
  const bin = join(home, 'bin')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(bin)
  // The script's home-LAN gate pings homemini.local; answer "home".
  writeFileSync(join(bin, 'ping'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'ping'), 0o755)
  const localPath = (t: FakeTrack): string => join(dst, t.path.replace(/^:+/, '').replace(/:/g, '/'))
  for (const t of tracks) {
    const lp = localPath(t)
    mkdirSync(join(lp, '..'), { recursive: true })
    writeFileSync(lp, t.local)
  }
  writeFileSync(join(appDir, 'library.json'), JSON.stringify({
    tracks: tracks.map((t, i) => ({
      ...(t.id !== undefined ? { id: t.id } : {}),
      path: t.path, title: `Song ${i}`, fileSize: t.local.length, playCount: 0,
    })),
  }))
  const child = spawn(PY, [scriptPath], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      CAP_GB: '0',                       // nothing is hot: every track is an eviction candidate
      JAKETUNES_MOBILE_BACKEND: base,
    },
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const status = await new Promise<number | null>((ok) => child.on('close', ok))
  return { home, out, status, localPath }
}

function isRealFile(p: string): boolean {
  return existsSync(p) && !lstatSync(p).isSymbolicLink() && lstatSync(p).isFile()
}

const song = (id: string | undefined, n: number, size = 400 * KB): FakeTrack =>
  ({ id, path: `:Music:Artist ${n}:Album:${n} Song.m4a`, local: bytes(size, n) })

describe('cache-manager.py evicts only what homemini provably holds', () => {
  it('evicts a cold track when homemini serves the identical bytes', async () => {
    const t = song('101', 1)
    const fake = await fakeHomemini(new Map([['101', Buffer.from(t.local)]]))
    try {
      const r = await runWarm([t], fake.base)
      assert.equal(r.status, 0, r.out)
      const lp = r.localPath(t)
      assert.ok(lstatSync(lp).isSymbolicLink(), `the proven copy should be evicted to a symlink:\n${r.out}`)
      assert.match(readlinkSync(lp), /JakeShareNAS\/JakeTunesLibrary\/Music\/Artist 1\/Album\/1 Song\.m4a$/)
      assert.match(r.out, /evicted=1 kept_unproven=0/)
      rmSync(r.home, { recursive: true, force: true })
    } finally { fake.server.close() }
  })

  it('keeps the file when homemini has no audio for that id (the only copy)', async () => {
    const t = song('202', 2)
    const fake = await fakeHomemini(new Map())
    try {
      const r = await runWarm([t], fake.base)
      assert.equal(r.status, 0, r.out)
      assert.ok(isRealFile(r.localPath(t)), `the only copy was deleted:\n${r.out}`)
      assert.deepEqual(readFileSync(r.localPath(t)), t.local)
      assert.match(r.out, /KEPT Music\/Artist 2\/Album\/2 Song\.m4a \(id 202\): homemini answered 404/)
      assert.match(r.out, /evicted=0 kept_unproven=1/)
      rmSync(r.home, { recursive: true, force: true })
    } finally { fake.server.close() }
  })

  it('keeps the file when the same id on homemini is a different song', async () => {
    const t = song('303', 3)
    const other = bytes(t.local.length, 999)            // same size, other audio
    const fake = await fakeHomemini(new Map([['303', other]]))
    try {
      const r = await runWarm([t], fake.base)
      assert.ok(isRealFile(r.localPath(t)), r.out)
      assert.match(r.out, /\(id 303\): first 256 KB differs from homemini's copy/)
      rmSync(r.home, { recursive: true, force: true })
    } finally { fake.server.close() }
  })

  it('keeps the file when homemini\'s copy is truncated', async () => {
    const t = song('404', 4)
    const fake = await fakeHomemini(new Map([['404', t.local.subarray(0, t.local.length - 10 * KB)]]))
    try {
      const r = await runWarm([t], fake.base)
      assert.ok(isRealFile(r.localPath(t)), r.out)
      assert.match(r.out, new RegExp(`\\(id 404\\): size differs \\(local ${t.local.length}, homemini ${t.local.length - 10 * KB}\\)`))
      rmSync(r.home, { recursive: true, force: true })
    } finally { fake.server.close() }
  })

  it('keeps the file when only the tail differs (same size, same head)', async () => {
    const t = song('505', 5)
    const damaged = Buffer.from(t.local)
    damaged.fill(0, damaged.length - 4 * KB)            // zeroed tail, e.g. a torn write
    const fake = await fakeHomemini(new Map([['505', damaged]]))
    try {
      const r = await runWarm([t], fake.base)
      assert.ok(isRealFile(r.localPath(t)), r.out)
      assert.match(r.out, /\(id 505\): last 64 KB differs from homemini's copy/)
      rmSync(r.home, { recursive: true, force: true })
    } finally { fake.server.close() }
  })

  it('keeps a track that has no id, without asking homemini', async () => {
    const t = song(undefined, 6)
    const fake = await fakeHomemini(new Map())
    try {
      const r = await runWarm([t], fake.base)
      assert.ok(isRealFile(r.localPath(t)), r.out)
      assert.match(r.out, /\(id None\): track has no id/)
      assert.equal(fake.audioHits.length, 0)
      rmSync(r.home, { recursive: true, force: true })
    } finally { fake.server.close() }
  })

  it('handles files smaller than the 256 KB window', async () => {
    const t = song('707', 7, 3 * KB)
    const fake = await fakeHomemini(new Map([['707', Buffer.from(t.local)]]))
    try {
      const r = await runWarm([t], fake.base)
      assert.ok(lstatSync(r.localPath(t)).isSymbolicLink(), r.out)
      assert.match(r.out, /evicted=1 kept_unproven=0/)
      rmSync(r.home, { recursive: true, force: true })
    } finally { fake.server.close() }
  })

  it('keeps everything when homemini is unreachable', async () => {
    const ts = [song('801', 8), song('802', 9), song('803', 10)]
    const r = await runWarm(ts, await deadBase())
    assert.equal(r.status, 0, r.out)
    for (const t of ts) assert.ok(isRealFile(r.localPath(t)), r.out)
    assert.match(r.out, /KEPT 3 eviction candidates: homemini unreachable/)
    assert.match(r.out, /evicted=0 kept_unproven=3/)
    rmSync(r.home, { recursive: true, force: true })
  })

  it('stops asking after 3 failed requests in a row, and keeps every file', async () => {
    const ts = [11, 12, 13, 14, 15, 16].map((n) => song(String(900 + n), n))
    const fake = await fakeHomemini(new Map(ts.map((t) => [t.id!, Buffer.from(t.local)])), 'drop')
    try {
      const r = await runWarm(ts, fake.base)
      assert.equal(r.status, 0, r.out)
      for (const t of ts) assert.ok(isRealFile(r.localPath(t)), r.out)
      assert.equal(fake.audioHits.length, 3, `expected the circuit breaker to stop at 3 requests, saw ${fake.audioHits.length}`)
      assert.match(r.out, /homemini request failed/)
      assert.match(r.out, /KEPT 3 eviction candidates: homemini unreachable/)
      assert.match(r.out, /evicted=0 kept_unproven=6/)
      rmSync(r.home, { recursive: true, force: true })
    } finally { fake.server.close() }
  })

  it('decides each track on its own bytes in a mixed run', async () => {
    const proven = song('1001', 21)
    const only = song('1002', 22)
    const fake = await fakeHomemini(new Map([['1001', Buffer.from(proven.local)]]))
    try {
      const r = await runWarm([proven, only], fake.base)
      assert.ok(lstatSync(r.localPath(proven)).isSymbolicLink(), r.out)
      assert.ok(isRealFile(r.localPath(only)), r.out)
      assert.match(r.out, /evicted=1 kept_unproven=1/)
      rmSync(r.home, { recursive: true, force: true })
    } finally { fake.server.close() }
  })
})

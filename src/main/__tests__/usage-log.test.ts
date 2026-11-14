/**
 * The usage log (2026-11-14): the rules, the disk, the way to homemini, and the wiring.
 *
 *  - scrubbing: secrets, headers, query strings, paths outside the library, e-mail
 *    addresses and lyrics never get in; details stay flat and ≤ 1 KB, strings ≤ 200
 *  - which IPC invokes become lines, and as what; homemini routes fold ids to ":x"
 *  - batching: ≤ 500 events and ≤ 256 KB per POST
 *  - the store: buffered then appended; rotated into sealed segments; capped at its byte
 *    limit with a counted `dropped` event; a send clears only what homemini took; 404 / 5xx /
 *    no answer leave everything on disk; 413 halves and finally drops one, counted
 *  - 200 rounds of overlapping writers, flushes and sends against a homemini that
 *    stalls, fails and refuses: every event arrives exactly once, nothing is left behind
 *  - wiring: index.ts starts it once; the registrar times every invoke; the preload and
 *    renderer send through one channel; the protected files are untouched
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  batchBody, deviceFromHostname, ipcEvent, MAX_BYTES_PER_POST, MAX_EVENTS_PER_POST, planBatches, routeOf,
  scrubDetail, scrubEvent, scrubPath, scrubString, utf8Bytes,
} from '../../common/usage-log.ts'
import { createUsageStore, CURRENT_FILE, type PostAnswer } from '../usage-log-store.ts'
import { observed, observeIpc, ipcInFlight, type IpcObservation } from '../ipc-register.ts'

const SRC = join(import.meta.dirname, '../..')
const T = Date.parse('2026-11-14T15:00:00Z')

describe('usage log — nothing private gets in', () => {
  test('secrets, bearer headers, JWTs and long tokens are replaced', () => {
    const s = scrubString('key sk-ant-api03-abcdefghijklmnopqrstuv and Bearer abc.def-ghi and eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig and ' + 'Zq9_'.repeat(12))
    assert.doesNotMatch(s, /sk-ant|abc\.def|eyJhbGci|Zq9_/)
    assert.equal((s.match(/\[secret\]/g) || []).length, 4, s)
  })

  test('a git sha survives as 12 characters; an e-mail address does not survive at all', () => {
    assert.equal(scrubString('build 0123456789abcdef0123456789abcdef01234567'), 'build 0123456789ab')
    assert.equal(scrubString('mail jake@example.com now'), 'mail [email] now')
  })

  test('query strings go; paths outside the library go; the library-relative part stays', () => {
    assert.equal(scrubString('GET http://homemini:3000/api/search?q=radiohead&token=x failed'), 'GET http://homemini:3000/api/search failed')
    assert.equal(scrubString('ENOENT /Users/jake/Library/Application Support/JakeTunes/x.json'), 'ENOENT [path]', 'a space in a path does not let its tail through')
    assert.equal(scrubString("ENOENT: no such file, open '/Volumes/JakeShared/state/x.json'"), "ENOENT: no such file, open '[path]'")
    assert.equal(scrubPath('/Volumes/JakeShared/Music/iPod_Control/Music/F12/ABCD.m4a'), 'iPod_Control/Music/F12/ABCD.m4a')
    assert.equal(scrubPath(`ipod-audio://${encodeURIComponent('/Users/jake/Music/JakeTunesLibrary/iPod_Control/Music/F03/X Y.m4a')}`), 'iPod_Control/Music/F03/X Y.m4a')
    assert.equal(scrubPath('/Users/jake/.ssh/id_ed25519'), '[path]')
    assert.doesNotMatch(scrubString('read /Users/jake/.config/jaketunes/companion-token'), /companion-token|jake/)
  })

  test('a detail is flat, keyless of secrets and lyrics, and ≤ 1 KB with strings ≤ 200', () => {
    const d = scrubDetail({
      route: '/api/x', status: 200, ok: true, none: null, nested: { a: 1 }, list: [1, 2, 3],
      token: 'abc', Authorization: 'Bearer x', companionHeader: 'x', apiKey: 'k', lyrics: 'la la', songLyric: 'la',
      long: 'a few words '.repeat(50), weird: NaN,
    })
    assert.deepEqual(Object.keys(d ?? {}).sort(), ['listCount', 'long', 'none', 'ok', 'route', 'status'])
    assert.equal(String(d?.long).length, 200)
    const big = scrubDetail(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'why '.repeat(40)])))
    assert.ok(JSON.stringify(big).length <= 1024, `${JSON.stringify(big).length}`)
    assert.equal(big?.truncated, true)
  })

  test('scrubEvent: names are stable ids, times are ISO, junk is null', () => {
    const e = scrubEvent({ kind: 'Action', name: 'Album Open!', ms: 12.6, ok: true, detail: { a: 1 } }, T)
    assert.deepEqual(e, { t: new Date(T).toISOString(), kind: 'action', name: 'album-open', ms: 13, ok: true, detail: { a: 1 } })
    assert.equal(scrubEvent({ kind: 'action' }, T), null)
    assert.equal(scrubEvent({ name: 'x' }, T), null)
    assert.equal(scrubEvent('x', T), null)
    assert.equal(scrubEvent({ kind: 'x', name: 'y', ms: -4 }, T)?.ms, undefined)
    assert.equal(scrubEvent({ kind: 'x', name: 'y', t: '2026-01-01T00:00:00Z' }, T)?.t, '2026-01-01T00:00:00.000Z')
  })

  test('which Mac: workmini, homemini (its real host name), everything else the MacBook', () => {
    assert.equal(deviceFromHostname('Workmini.localdomain'), 'workmini')
    assert.equal(deviceFromHostname('Jakes-Mini-6224'), 'homemini')
    assert.equal(deviceFromHostname('Jakes-Mac-mini.local'), 'homemini')
    assert.equal(deviceFromHostname('Jakes-MacBook-Pro-2458'), 'macbook')
  })
})

describe('usage log — what becomes a line', () => {
  test('homemini routes: no query, ids and names folded', () => {
    assert.equal(routeOf('http://homemini:3000/api/albums/Radiohead%7COK%20Computer/page?x=1'), '/api/albums/:x/page')
    assert.equal(routeOf('http://homemini:3000/audio/12345?fmt=flac'), '/audio/:id')
    assert.equal(routeOf('http://homemini:3000/api/ipod-lists/punkPod'), '/api/ipod-lists/:x')
    assert.equal(routeOf('http://homemini:3000/api/usage-log'), '/api/usage-log')
  })

  test('an action is a line; a quick read is not; a slow or failed read is', () => {
    assert.deepEqual(ipcEvent({ channel: 'rip-cd-tracks', ms: 90_000, ok: true }), { kind: 'action', name: 'import.cd', ms: 90_000, ok: true })
    assert.equal(ipcEvent({ channel: 'sync-ipod', ms: 1, ok: true })?.kind, 'sync')
    assert.equal(ipcEvent({ channel: 'ipod-setup:prepare', ms: 1, ok: true })?.name, 'ipc.ipod-setup:prepare')
    assert.equal(ipcEvent({ channel: 'get-album-info', ms: 40, ok: true }), null)
    assert.equal(ipcEvent({ channel: 'top1000:list', ms: 40, ok: true }), null)
    assert.equal(ipcEvent({ channel: 'save-ui-state', ms: 4, ok: true }), null)
    assert.deepEqual(ipcEvent({ channel: 'get-album-info', ms: 1500, ok: true }), { kind: 'slow', name: 'ipc.get-album-info', ms: 1500, ok: true, detail: { channel: 'get-album-info' } })
    assert.deepEqual(ipcEvent({ channel: 'load-tracks', ms: 3, ok: false, error: 'EACCES /Users/jake/x' }), { kind: 'error', name: 'ipc.load-tracks', ms: 3, ok: false, detail: { error: 'EACCES [path]', channel: 'load-tracks' } })
    assert.equal(ipcEvent({ channel: 'sync-ipod', ms: 1, ok: false, error: 'refused-sender', refused: true }), null)
  })

  test('the registrar times every invoke, says when one failed, and knows what is still running', async () => {
    const seen: IpcObservation[] = []
    observeIpc((o) => seen.push(o))
    try {
      let release!: () => void
      const rip = observed('rip-cd-tracks', () => new Promise<{ ok: true }>((r) => { release = () => r({ ok: true }) }))
      assert.ok(ipcInFlight('rip-cd-tracks'), 'a rip is running')
      release()
      await rip
      assert.ok(!ipcInFlight('rip-cd-tracks'))
      await observed('save-metadata-override', () => ({ ok: false, error: 'nope' }))
      await assert.rejects(observed('import-track', () => { throw new Error('bad file') }))
      assert.deepEqual(seen.map((o) => [o.channel, o.ok, o.error ?? null]), [
        ['rip-cd-tracks', true, null], ['save-metadata-override', false, 'nope'], ['import-track', false, 'bad file'],
      ])
      // An observer that throws changes nothing for the renderer.
      observeIpc(() => { throw new Error('observer broke') })
      assert.deepEqual(await observed('x', () => ({ ok: true, v: 1 })), { ok: true, v: 1 })
    } finally { observeIpc(null) }
  })
})

describe('usage log — batches', () => {
  test('≤ 500 events per POST, and ≤ 256 KB with the envelope', () => {
    const line = JSON.stringify({ t: 'x', kind: 'a', name: 'b' })
    const many = Array.from({ length: 1201 }, () => line)
    assert.deepEqual(planBatches(many, 80).map((b) => b.length), [MAX_EVENTS_PER_POST, MAX_EVENTS_PER_POST, 201])
    const fat = JSON.stringify({ t: 'x', kind: 'a', name: 'b', detail: { s: 'y'.repeat(990) } })
    const batches = planBatches(Array.from({ length: 600 }, () => fat), 80)
    for (const b of batches) assert.ok(utf8Bytes(batchBody('macbook', 'abc', b)) <= MAX_BYTES_PER_POST, `${utf8Bytes(batchBody('macbook', 'abc', b))}`)
    assert.equal(batches.reduce((a, b) => a + b.length, 0), 600)
  })

  test('the body is the contract\'s envelope', () => {
    const body = JSON.parse(batchBody('workmini', 'abc123', ['{"t":"x","kind":"a","name":"b"}'])) as Record<string, unknown>
    assert.deepEqual(body, { device: 'workmini', app: 'desktop', build: 'abc123', events: [{ t: 'x', kind: 'a', name: 'b' }] })
  })
})

// ── The store ────────────────────────────────────────────────────────────

const tmp = (): string => mkdtempSync(join(tmpdir(), 'jt-usage-log-'))
const ids = (bodies: string[]): number[] => bodies.flatMap((b) => (JSON.parse(b) as { events: Array<{ detail?: { id?: number } }> }).events.map((e) => e.detail?.id ?? -1))
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : [])

describe('usage log — the store on disk', () => {
  test('buffered, then appended in one write; flushSync writes what is left at quit', async () => {
    const dir = tmp()
    try {
      const store = createUsageStore({ dir, device: 'macbook', build: 'abc', post: async () => ({ status: 200 }), flushMs: 60_000 })
      store.log({ kind: 'action', name: 'a', detail: { id: 1 } })
      store.log({ kind: 'action', name: 'b', detail: { id: 2 } })
      assert.ok(!existsSync(join(dir, CURRENT_FILE)), 'nothing on disk before the flush')
      await store.flush()
      assert.equal(readFileSync(join(dir, CURRENT_FILE), 'utf8').trim().split('\n').length, 2)
      store.log({ kind: 'launch', name: 'app.quit' })
      store.flushSync()
      assert.match(readFileSync(join(dir, CURRENT_FILE), 'utf8'), /app\.quit/)
      store.stop()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('rotation: current.jsonl is sealed into segments as it grows', async () => {
    const dir = tmp()
    try {
      const store = createUsageStore({ dir, device: 'macbook', build: 'abc', post: async () => ({ status: 200 }), segmentBytes: 400, flushAt: 3 })
      for (let i = 0; i < 30; i++) { store.log({ kind: 'action', name: 'x', detail: { id: i } }); if (i % 3 === 2) await store.flush() }
      await store.flush()
      const segs = files(dir).filter((f) => f.startsWith('seg-'))
      assert.ok(segs.length >= 3, segs.join(','))
      const all = [...segs.sort(), CURRENT_FILE].flatMap((f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean) : []))
      assert.deepEqual(all.map((l) => (JSON.parse(l) as { detail: { id: number } }).detail.id), Array.from({ length: 30 }, (_, i) => i), 'in order, none lost')
      store.stop()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('the cap: the oldest segments go, and a dropped event counts exactly what went', async () => {
    const dir = tmp()
    try {
      const bodies: string[] = []
      const store = createUsageStore({ dir, device: 'macbook', build: 'abc', post: async (b) => { bodies.push(b); return { status: 200 } }, segmentBytes: 300, capBytes: 1500, flushAt: 1 })
      for (let i = 0; i < 200; i++) { store.log({ kind: 'action', name: 'x', detail: { id: i } }); await store.flush() }
      assert.ok(await store.diskBytes() <= 1500 + 300, `${await store.diskBytes()}`)
      const r = await store.send()
      assert.ok(r.ok)
      const got = ids(bodies).filter((i) => i >= 0)
      const dropped = (bodies.flatMap((b) => (JSON.parse(b) as { events: Array<{ name: string; detail?: { count?: number; reason?: string } }> }).events)
        .filter((e) => e.name === 'usage-log.dropped' && e.detail?.reason === 'cap'))
        .reduce((a, e) => a + (e.detail?.count ?? 0), 0)
      assert.equal(got.length + dropped, 200, `sent ${got.length} + dropped ${dropped}`)
      assert.ok(dropped > 0)
      assert.deepEqual(got, [...got].sort((a, b) => a - b), 'what survives is the newest, in order')
      assert.equal(got.at(-1), 199)
      assert.equal(store.stats().dropped, dropped)
      store.stop()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a send clears only what homemini took; 404, 503 and no answer leave it all on disk', async () => {
    const dir = tmp()
    try {
      let answer: PostAnswer | 'throw' = { status: 404 }
      const bodies: string[] = []
      const store = createUsageStore({
        dir, device: 'macbook', build: 'abc', maxEvents: 4,
        post: async (b) => { if (answer === 'throw') throw new Error('ECONNREFUSED'); bodies.push(b); return answer },
      })
      for (let i = 0; i < 10; i++) store.log({ kind: 'action', name: 'x', detail: { id: i } })
      let r = await store.send()
      assert.deepEqual(r, { ok: false, sent: 0, dropped: 0, status: 404 }, 'the route is not deployed yet')
      answer = 'throw'
      r = await store.send()
      assert.equal(r.ok, false)
      // Homemini takes the first batch, then falls over.
      let n = 0
      answer = { status: 200 }
      const s2 = createUsageStore({
        dir, device: 'macbook', build: 'abc', maxEvents: 4,
        post: async (b) => { n++; bodies.push(b); return n === 1 ? { status: 200 } : { status: 503 } },
      })
      r = await s2.send()
      assert.deepEqual(r, { ok: false, sent: 4, dropped: 0, status: 503 })
      const left = files(dir).filter((f) => f.startsWith('seg-')).flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n'))
      assert.deepEqual(left.map((l) => (JSON.parse(l) as { detail: { id: number } }).detail.id), [4, 5, 6, 7, 8, 9], 'exactly the six it did not take')
      store.stop(); s2.stop()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('413 halves the batch; a single event still refused is dropped and counted', async () => {
    const dir = tmp()
    try {
      const accepted: number[] = []
      const store = createUsageStore({
        dir, device: 'macbook', build: 'abc', maxEvents: 8,
        post: async (b) => {
          const evs = (JSON.parse(b) as { events: Array<{ detail?: { id?: number; reason?: string } }> }).events
          if (evs.length > 2) return { status: 413 }
          if (evs.some((e) => e.detail?.id === 5)) return { status: 413 }
          for (const e of evs) accepted.push(e.detail?.id ?? -1)
          return { status: 200 }
        },
      })
      for (let i = 0; i < 8; i++) store.log({ kind: 'action', name: 'x', detail: { id: i } })
      const r = await store.send()
      assert.ok(r.ok)
      assert.deepEqual(accepted.filter((i) => i >= 0), [0, 1, 2, 3, 4, 6, 7])
      assert.equal(r.dropped, 1)
      await store.send()
      assert.ok(accepted.includes(-1), 'the dropped event itself reaches homemini')
      store.stop()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('two sends at once are one send', async () => {
    const dir = tmp()
    try {
      let posts = 0
      const store = createUsageStore({ dir, device: 'macbook', build: 'abc', post: async () => { posts++; await new Promise((r) => setTimeout(r, 20)); return { status: 200 } } })
      store.log({ kind: 'a', name: 'b' })
      const [a, b] = [store.send(), store.send()]
      assert.equal(a, b)
      await a
      assert.equal(posts, 1)
      store.stop()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('usage log — 200 rounds of overlapping writers', () => {
  test('every event arrives exactly once (or is counted as dropped by the cap); no temp file, no segment is left behind', async () => {
    for (let round = 0; round < 200; round++) {
      const dir = tmp()
      // Every third round runs against a cap small enough to bite while sends are in flight.
      const capped = round % 3 === 2
      try {
        const got: number[] = []
        let droppedSum = 0
        let calls = 0
        const store = createUsageStore({
          dir, device: 'macbook', build: 'abc', segmentBytes: 200 + (round % 7) * 90, flushAt: 1 + (round % 5), flushMs: 1, maxEvents: 3 + (round % 4),
          ...(capped ? { capBytes: 700 } : {}),
          post: async (b) => {
            calls++
            await new Promise((r) => setTimeout(r, calls % 3))
            if (calls % 5 === 0) throw new Error('no answer')
            if (calls % 7 === 0) return { status: 503 }
            for (const e of (JSON.parse(b) as { events: Array<{ name: string; detail?: { id?: number; count?: number } }> }).events) {
              if (e.name === 'usage-log.dropped') droppedSum += e.detail?.count ?? 0
              else got.push(e.detail?.id ?? -1)
            }
            return { status: 200 }
          },
        })
        const writers = Array.from({ length: 4 }, (_, w) => (async () => {
          for (let i = 0; i < 15; i++) {
            store.log({ kind: 'action', name: 'w', detail: { id: w * 1000 + i } })
            if ((i + w) % 4 === 0) void store.flush()
            if ((i + round) % 6 === 0) void store.send()
            if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0))
          }
        })())
        await Promise.all(writers)
        // Drain against a homemini that takes everything.
        for (let k = 0; k < 50; k++) {
          await store.idle()
          const r = await store.send()
          if (r.ok && !files(dir).some((f) => f.startsWith('seg-')) && store.stats().buffered === 0 && !existsSync(join(dir, CURRENT_FILE))) break
        }
        const want = Array.from({ length: 4 }, (_, w) => Array.from({ length: 15 }, (_, i) => w * 1000 + i)).flat().sort((a, b) => a - b)
        const real = got.filter((i) => i >= 0).sort((a, b) => a - b)
        if (capped) {
          assert.equal(new Set(real).size, real.length, `round ${round}: an event arrived twice`)
          assert.ok(real.every((i) => want.includes(i)))
          assert.equal(real.length + droppedSum, want.length, `round ${round}: ${real.length} arrived + ${droppedSum} counted dropped ≠ ${want.length}`)
        } else {
          assert.deepEqual(real, want, `round ${round}: ${real.length} arrived of ${want.length}`)
          assert.equal(droppedSum, 0)
        }
        const left = files(dir)
        assert.deepEqual(left.filter((f) => f.endsWith('.tmp')), [], `round ${round}: temp files left`)
        assert.deepEqual(left.filter((f) => f.startsWith('seg-')), [], `round ${round}: segments left`)
        store.stop()
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  })
})

// ── Wiring ───────────────────────────────────────────────────────────────

describe('usage log wiring — the tested code is the live code', () => {
  const read = (p: string): string => readFileSync(join(SRC, p), 'utf8')

  test('index.ts starts it once, with the build, homemini and the sync flag', () => {
    const index = read('main/index.ts')
    assert.equal((index.match(/(?<![\w.])startUsageLog\(/g) || []).length, 1)
    assert.match(index, /startUsageLog\(\{ userData: app\.getPath\('userData'\), build: getBuildProvenance\(app\.getVersion\(\)\)\.buildSha/)
    assert.match(index, /syncInFlight: \(\) => syncEngine\.isSyncInFlight\(\) \}\)\n {2}createWindow\(\)/, 'started before the window, so its first load is seen')
  })

  test('every registrar invoke goes through the observer', () => {
    assert.match(read('main/ipc-register.ts'), /return observed\(channel, \(\) => listener\(event, \.\.\.\(args as Args\)\)\)/)
  })

  test('main posts to the contract route with the companion header, and only from disk', () => {
    const start = read('main/usage-log-start.ts')
    assert.match(start, /\$\{hub\}\$\{USAGE_ROUTE\}/)
    assert.match(start, /withCompanionInit\(\{/)
    assert.match(start, /if \(Date\.now\(\) < nextAt \|\| busyReason\(\)\) return/, 'never sends during an iPod sync or a CD rip')
    assert.match(start, /ipcInFlight\('rip-cd-tracks'\)/)
    assert.doesNotMatch(start, /console\.(log|warn)\([^)]*(token|header)/i, 'the token is never logged')
  })

  test('preload and renderer: one channel, a twin type, the page hooks in place', () => {
    assert.match(read('preload/index.ts'), /usageLog: \(events: unknown\[\]\): void => \{ ipcRenderer\.send\('usage-log:events', events\) \}/)
    assert.match(read('renderer/types.ts'), /usageLog\?: \(events: unknown\[\]\) => void/)
    assert.match(read('renderer/main.tsx'), /if \(!yirExport\) initUsageLog\(\)/)
    assert.match(read('renderer/components/MainContent.tsx'), /if \(from !== null\) noteScreen\(\{ from, to: activeKey/, 'every page, dx.nav or not')
    assert.match(read('renderer/CrashNet.tsx'), /noteError\(kind, message\)/)
    assert.match(read('renderer/App.tsx'), /noteLaunch\('launch\.library-painted'\)/)
  })

  test('the protected files are not touched by it', () => {
    for (const p of ['renderer/context/PlaybackContext.tsx', 'renderer/context/LibraryContext.tsx', 'renderer/hooks/useAudio.ts', 'renderer/hooks/useVirtualScroll.ts',
      'renderer/components/playback/NowPlaying.tsx', 'renderer/views/GenresView.tsx', 'renderer/views/CDImportView.tsx', 'renderer/views/DeviceView.tsx']) {
      assert.doesNotMatch(read(p), /usageLog|usage-log|noteScreen|noteLaunch/, p)
    }
  })
})

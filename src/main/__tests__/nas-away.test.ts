/**
 * No SMB when away from home (2026-11-06, the away-from-home audit).
 *
 * The route decides (nas-route.ts), the breaker obeys it without a single stat
 * (nas-breaker.ts), coming home counts as a recovery so the sync that moves a
 * tailnet mount back to the LAN path fires, and a crowd clip the app could not copy
 * still has a way to the phone (concert-crowd-mirror.ts + Mobile's sync job).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAwayCheck, routeShowsGateway, NAS_LAN_IP } from '../nas-route.ts'
import { createNasBreaker } from '../nas-breaker.ts'
import { mirrorCrowdClipToNas } from '../concert-crowd-mirror.ts'

const repoRoot = join(import.meta.dirname, '..', '..', '..')

// Real output of `route -n get 192.168.1.223` on this Mac, away, 2026-11-06.
const AWAY = `   route to: 192.168.1.223
destination: 192.168.1.223
    gateway: 172.17.1.1
  interface: en0
      flags: <UP,GATEWAY,HOST,DONE,WASCLONED,IFSCOPE,IFREF,GLOBAL>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
`
const HOME = `   route to: 192.168.1.223
destination: 192.168.1.223
  interface: en0
      flags: <UP,HOST,DONE,LLINFO,WASCLONED,IFSCOPE,IFREF>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500      1187
`

describe('the route says away', () => {
  it('a gateway and an interface = away; on-link, empty, or an error line = not proven', () => {
    assert.equal(routeShowsGateway(AWAY), true)
    assert.equal(routeShowsGateway(HOME), false)
    assert.equal(routeShowsGateway(''), false)
    assert.equal(routeShowsGateway('route: writing to routing socket: not in table\n'), false)
    assert.equal(routeShowsGateway('    gateway: 172.17.1.1\n'), false, 'a gateway with no interface proves nothing')
  })

  it('asks once per 30 s, and looks again after that', async () => {
    let t = 1_000_000
    let runs = 0
    let out: string | null = AWAY
    const away = createAwayCheck({ readRoute: async () => { runs++; return out }, now: () => t })
    assert.equal(await away(), true)
    assert.equal(await away(), true)
    assert.equal(runs, 1)
    t += 29_999
    assert.equal(await away(), true)
    assert.equal(runs, 1)
    out = HOME
    t += 2
    assert.equal(await away(), false)
    assert.equal(runs, 2)
  })

  it('calls that overlap share one route read', async () => {
    let runs = 0
    let release: (s: string) => void = () => {}
    const away = createAwayCheck({ readRoute: () => { runs++; return new Promise((r) => { release = r }) } })
    const both = Promise.all([away(), away()])
    release(AWAY)
    assert.deepEqual(await both, [true, true])
    assert.equal(runs, 1)
  })

  it('a route that cannot be read, or rejects, is not away', async () => {
    assert.equal(await createAwayCheck({ readRoute: async () => null })(), false)
    assert.equal(await createAwayCheck({ readRoute: async () => { throw new Error('spawn failed') } })(), false)
  })
})

function world(opts: { away?: boolean; statOk?: boolean } = {}) {
  const w = {
    t: 5_000_000,
    away: opts.away ?? false,
    statOk: opts.statOk ?? true,
    probes: 0,
    kicks: 0,
    warnings: [] as string[],
  }
  const breaker = createNasBreaker({
    probe: async () => { w.probes++; if (!w.statOk) throw new Error('ENOENT') },
    isAway: async () => w.away,
    now: () => w.t,
    warn: (m) => { w.warnings.push(m) },
    probeTimeoutMs: 50,
  })
  breaker.onNasRecovery(() => { w.kicks++ })
  return { w, breaker }
}

describe('the breaker when away', () => {
  it('answers no without one stat, however often it is asked, and says so once', async () => {
    const { w, breaker } = world({ away: true })
    for (let i = 0; i < 5; i++) {
      assert.equal(await breaker.nasAvailable(), false)
      w.t += 60_000
    }
    assert.equal(w.probes, 0, 'the share is never touched while away')
    assert.equal(w.warnings.length, 1)
    assert.match(w.warnings[0], /away from home/)
    assert.equal(breaker.isNasMounted(), false)
  })

  it('home again: the next probe recovers it, and the kick fires once', async () => {
    const { w, breaker } = world({ away: true })
    assert.equal(await breaker.nasAvailable(), false)
    w.t += 120_000
    w.away = false
    assert.equal(await breaker.nasAvailable(), true)
    assert.equal(w.probes, 1)
    assert.equal(w.kicks, 1, 'coming home fires the recovery kick')
    assert.equal(breaker.isNasMounted(), true)
    assert.match(w.warnings[w.warnings.length - 1], /NAS recovered/)
    w.t += 60_000
    assert.equal(await breaker.nasAvailable(), true)
    assert.equal(w.kicks, 1, 'once')
  })

  it('a share that was fine a moment ago: leaving home takes effect at once, even inside the verdict cache', async () => {
    const { w, breaker } = world()
    assert.equal(await breaker.nasAvailable(), true)
    w.t += 1000
    w.away = true
    assert.equal(await breaker.nasAvailable(), false)
    assert.equal(breaker.isNasMounted(), false)
    assert.equal(w.probes, 1)
    // …and back inside the same 30 s: no stale yes, and the episode still closes with a kick.
    w.t += 1000
    w.away = false
    assert.equal(await breaker.nasAvailable(), false, 'still inside the verdict cache of the away answer')
    w.t += 30_000
    assert.equal(await breaker.nasAvailable(), true)
    assert.equal(w.kicks, 1)
  })

  it('home and the share not answering: today\'s breaker, untouched', async () => {
    const { w, breaker } = world({ statOk: false })
    assert.equal(await breaker.nasAvailable(), false)
    assert.equal(w.probes, 1)
    assert.match(w.warnings[0], /slow or absent/)
    w.t += 59_000
    assert.equal(await breaker.nasAvailable(), false)
    assert.equal(w.probes, 1, 'no second probe inside the half-open minute')
    w.t += 2000
    w.statOk = true
    assert.equal(await breaker.nasAvailable(), true)
    assert.equal(w.kicks, 1)
  })

  it('home and never away: a good probe is no recovery, so no kick', async () => {
    const { w, breaker } = world()
    assert.equal(await breaker.nasAvailable(), true)
    assert.equal(w.kicks, 0)
    assert.deepEqual(w.warnings, [])
  })

  it('a probe that never answers counts as no', async () => {
    const breaker = createNasBreaker({
      probe: () => new Promise(() => {}),
      isAway: async () => false,
      warn: () => {},
      probeTimeoutMs: 10,
    })
    assert.equal(await breaker.nasAvailable(), false)
  })
})

describe('a crowd clip is not lost when the share is not there', () => {
  const clip = (root: string): string => {
    const p = join(root, 'clip.m4a')
    writeFileSync(p, 'crowd')
    return p
  }

  it('home: copied into concert-crowd/ on the NAS state dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-crowd-'))
    try {
      const r = await mirrorCrowdClipToNas({ clipPath: clip(root), mergedTrackId: 42, nasDir: join(root, 'nas'), nasAvailable: async () => true, log: () => {} })
      assert.equal(r, 'copied')
      assert.equal(readFileSync(join(root, 'nas', 'concert-crowd', '42.m4a'), 'utf8'), 'crowd')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('away: no touch of the share at all, and the log names who carries it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-crowd-'))
    try {
      const logs: string[] = []
      let touched = false
      const r = await mirrorCrowdClipToNas({
        clipPath: clip(root), mergedTrackId: 42, nasDir: join(root, 'nas'), nasAvailable: async () => false,
        log: (m) => logs.push(m),
        copy: async () => { touched = true }, makeDir: async () => { touched = true },
      })
      assert.equal(r, 'waits-for-sync')
      assert.equal(touched, false)
      assert.ok(!existsSync(join(root, 'nas')))
      assert.match(logs[0], /sync job carries the clip/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('a copy that fails says so and never fails the extraction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-crowd-'))
    try {
      const logs: string[] = []
      const r = await mirrorCrowdClipToNas({
        clipPath: clip(root), mergedTrackId: 42, nasDir: join(root, 'nas'), nasAvailable: async () => true,
        log: (m) => logs.push(m), copy: async () => { throw new Error('EIO') },
      })
      assert.equal(r, 'waits-for-sync')
      assert.match(logs[0], /EIO/)
      assert.match(logs[0], /sync job carries the clip/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('wiring', () => {
  const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8')

  it('state-dir builds the one breaker on the route check', () => {
    const src = read('src/main/state-dir.ts')
    assert.match(src, /createNasBreaker\(\{\s*probe: \(\) => stat\(NAS_STATE_DIR_PATH\),\s*isAway: createAwayCheck\(\{ readRoute: readNasRoute \}\),/)
    for (const name of ['nasAvailable', 'isNasMounted', 'onNasRecovery']) assert.match(src, new RegExp(`export const ${name} = breaker\\.${name}`))
  })

  it('the clip copy goes through the gate; live-sets-ipc has no raw copy left', () => {
    const src = read('src/main/ipc/live-sets-ipc.ts')
    assert.match(src, /await mirrorCrowdClipToNas\(\{ clipPath: out, mergedTrackId, nasDir: NAS_STATE_DIR_PATH, nasAvailable \}\)/)
    assert.doesNotMatch(src, /copyFile/)
  })

  it('the library mirror\'s second try asks again', () => {
    const src = read('src/main/index.ts')
    const fn = src.slice(src.indexOf('async function mirrorLibraryToNas('), src.indexOf('let librarySaveChain'))
    assert.match(fn, /attempt > 1 && !\(await nasAvailable\(\)\)\) return/)
  })

  it('the app and the script ask about the same address, by the same rule', () => {
    const script = read('Dr. Claude/scripts/jaketunes-homemini-sync.sh')
    assert.ok(script.includes(`NAS_LAN_IP="${NAS_LAN_IP}"`), 'NAS_LAN_IP twin')
    assert.match(script, /share_is_away\(\) \{[\s\S]*?\^ \*interface:[\s\S]*?\^ \*gateway:/)
  })
})

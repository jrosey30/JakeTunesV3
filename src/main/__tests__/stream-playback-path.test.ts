/**
 * A lock on the workmini / streaming playback path — the shape that must
 * not regress the way the July 2026 "NAS playback" gate did.
 *
 * Jake, 2026-08-10/11: workmini stuck at 0:00 / hung entirely because the
 * player followed SMB symlinks on the hot path. The fix is homemini-first
 * for any streamRoot machine, and never following those symlinks on a miss.
 *
 * This file reads SOURCE TEXT the same way audio-signal-path.test.ts does.
 * If it fails, the audible/network path for workmini changed — decide on
 * purpose, then update the allow-list in the same commit.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN = join(import.meta.dirname, '..')
const index = readFileSync(join(MAIN, 'index.ts'), 'utf-8')
const streamPlayback = readFileSync(join(MAIN, 'stream-playback.ts'), 'utf-8')
const useAudio = readFileSync(join(MAIN, '../renderer/hooks/useAudio.ts'), 'utf-8')
const deploy = readFileSync(
  join(MAIN, '../../Dr. Claude/scripts/jaketunes-workmini-deploy.sh'),
  'utf-8',
)

/** Body of the ipod-audio protocol handler — the only place bytes leave disk/HTTP for play. */
function ipodAudioHandlerBody(): string {
  const start = index.indexOf("protocol.handle('ipod-audio'")
  assert.notEqual(start, -1, "ipod-audio protocol handler missing")
  const open = index.indexOf('{', start)
  let depth = 0
  for (let i = open; i < index.length; i++) {
    if (index[i] === '{') depth++
    else if (index[i] === '}' && --depth === 0) return index.slice(open, i + 1)
  }
  assert.fail('unbalanced braces in ipod-audio handler')
}

describe('workmini playback routing (policy module)', () => {
  test('streamRoot alone makes a homemini playback client', () => {
    // The July regression: streamRoot set, streamSource unset → SMB path.
    assert.match(
      streamPlayback,
      /return typeof opts\.streamRoot === 'string' && opts\.streamRoot\.length > 0/,
      'isHomeminiPlaybackClient no longer treats streamRoot as a homemini client',
    )
  })

  test('symlink follow is forbidden on homemini clients', () => {
    assert.match(
      streamPlayback,
      /if \(opts\.isHomeminiClient\) return false/,
      'mayFollowPlaybackSymlink no longer refuses SMB follows on streaming clients',
    )
  })
})

describe('ipod-audio:// handler shape', () => {
  const body = ipodAudioHandlerBody()

  test('uses the shared homemini-client gate (not a one-off streamSource check)', () => {
    assert.match(
      body,
      /isHomeminiPlaybackClientCached\(\)/,
      'ipod-audio handler no longer calls isHomeminiPlaybackClientCached — streamRoot machines can fall off homemini again',
    )
    // The July gate looked like: streamSource === 'homemini' ONLY, with an
    // explicit comment that streamRoot machines must stay OFF. That comment
    // must not return.
    assert.doesNotMatch(
      body,
      /this must stay OFF/,
      'July 2026 "streamRoot must stay OFF homemini" gate text is back in the handler',
    )
    assert.doesNotMatch(
      body,
      /normal NAS playback breaks/,
      'July 2026 NAS-playback justification is back — that path is the hang',
    )
  })

  test('refuses SMB symlink follow after a homemini miss', () => {
    assert.match(
      body,
      /mayFollowPlaybackSymlink/,
      'handler no longer uses mayFollowPlaybackSymlink — policy can drift from the lock',
    )
    assert.match(
      body,
      /homemini miss \+ symlink/,
      'explicit refuse-SMB log/path missing — easy to delete by accident',
    )
  })

  test('asks homemini before resolveContainedPath / realpath', () => {
    // Match CALL sites only — the early-block comments also mention
    // resolveContainedPath by name (that's the danger they document).
    const homeminiCall = body.search(/await fetchAudioFromHomemini\s*\(/)
    const containedCall = body.search(/await resolveContainedPath\s*\(/)
    assert.notEqual(homeminiCall, -1, 'await fetchAudioFromHomemini(...) missing from handler')
    assert.notEqual(containedCall, -1, 'await resolveContainedPath(...) missing from handler')
    assert.ok(
      homeminiCall < containedCall,
      'resolveContainedPath runs BEFORE homemini fetch — that realpath() follows SMB symlinks and hangs workmini',
    )
  })
})

describe('renderer Howls stay on html5 (no Web Audio XHR death)', () => {
  test('every new Howl({...}) sets html5: true', () => {
    // howler.js:2430 — Web Audio XHR error silently empties _sounds and the
    // track sits at 0:00 with no error. Measured all day on workmini.
    const blocks = useAudio.split(/new Howl\(/).slice(1)
    assert.ok(blocks.length >= 3, `expected ≥3 Howl sites, found ${blocks.length}`)
    for (let i = 0; i < blocks.length; i++) {
      // Options objects carry long comments; look through the whole Howl
      // constructor args (until the matching play/assign), not a tiny head.
      const head = blocks[i].slice(0, 1200)
      assert.match(
        head,
        /html5:\s*true/,
        `Howl site #${i + 1} is missing html5:true near construction — Web Audio XHR path can eat the play`,
      )
    }
  })
})

describe('silent-until-volume-nudge cannot return', () => {
  test('fade-in snaps Howl volume if Howler queued the fade under playLock', () => {
    assert.match(useAudio, /function fadeInHowl\(/,
      'fadeInHowl missing — html5 fade can stay queued and leave the Howl at volume 0')
    assert.match(useAudio, /function ensureHowlAudible\(/,
      'ensureHowlAudible missing — heartbeat/fade-in have nothing to snap a stuck-at-0 Howl')
    assert.match(useAudio, /ensureHowlAudible\(h, stateRef\.current\.volume\)/,
      'heartbeat no longer snaps a Howl stuck at volume 0 — the volume-bar wake-up is back')
  })

  test('gapless sample-accurate promote does not wait for a second play event', () => {
    // Prewarm already called play(); Howler will not emit 'play' again.
    assert.match(useAudio, /if \(next\.playing\(\)\)/,
      'sample-accurate promote no longer handles an already-playing prewarmed Howl — it stays at volume 0')
  })

  test('gapless promote clears outgoing-faded so the incoming Howl can snap audible', () => {
    // Sticky gaplessOutgoingFaded=true after handoff made ensureHowlAudible
    // a no-op for the whole next track — silent until volume nudge at every
    // natural-end seam.
    const handoff = useAudio.indexOf('Detach gapless state')
    assert.notEqual(handoff, -1, 'gapless promote handoff marker missing')
    const slice = useAudio.slice(handoff, handoff + 800)
    assert.match(slice, /gaplessOutgoingFaded\s*=\s*false/,
      'promote no longer clears gaplessOutgoingFaded — seam snap stays disabled and the next song goes silent')
  })
})

describe('libuv threadpool is raised before any fs import side effects', () => {
  test('UV_THREADPOOL_SIZE is set at the top of main', () => {
    // Default 4 threads + hung SMB readdir = permanent playback freeze until
    // relaunch. Must be set before other imports touch the pool. The file
    // opens with a long comment block — search the prologue, not 800 chars.
    const head = index.slice(0, 2500)
    assert.match(
      head,
      /UV_THREADPOOL_SIZE.*=.*['"]64['"]/,
      'UV_THREADPOOL_SIZE=64 missing from the top of index.ts',
    )
    const firstImport = head.search(/^import /m)
    const threadpool = head.search(/UV_THREADPOOL_SIZE/)
    assert.ok(firstImport === -1 || threadpool < firstImport,
      'UV_THREADPOOL_SIZE is set AFTER an import — libuv may already have sized the pool')
  })
})

describe('workmini deploy pins streamSource', () => {
  test('streaming deploy writes library.streamSource = homemini', () => {
    assert.match(
      deploy,
      /settings\["library"\]\["streamSource"\]\s*=\s*"homemini"/,
      'deploy script no longer pins streamSource=homemini — settings can silently regress',
    )
    assert.match(
      deploy,
      /settings\["library"\]\["streamRoot"\]/,
      'deploy script no longer pins streamRoot',
    )
  })
})

describe('homemini fetch must not AbortSignal.timeout the body', () => {
  test('fetchAudioFromHomemini uses fetchHeadersWithin, not AbortSignal.timeout', () => {
    // AbortSignal.timeout(8000) on fetch() kills the body 8s after the
    // request starts — even after headers have returned. That is the
    // "certain songs need a restart" leftover (cold FLAC / long tracks).
    const start = index.indexOf('async function fetchAudioFromHomemini')
    assert.notEqual(start, -1, 'fetchAudioFromHomemini missing')
    const open = index.indexOf('{', start)
    let depth = 0
    let end = open
    for (let i = open; i < index.length; i++) {
      if (index[i] === '{') depth++
      else if (index[i] === '}' && --depth === 0) { end = i; break }
    }
    const body = index.slice(open, end + 1)
    assert.match(body, /fetchHeadersWithin\s*\(/,
      'fetchAudioFromHomemini must use fetchHeadersWithin (header-only deadline)')
    // Match a real call site, not the comment that documents why we removed it.
    assert.doesNotMatch(body, /signal:\s*AbortSignal\.timeout\s*\(/,
      'AbortSignal.timeout is back on the fetch signal — it will cut mid-stream bodies again')
  })
})

describe('workmini-index-sync teaches homemini before workmini can race', () => {
  const syncScript = readFileSync(
    join(MAIN, '../../Dr. Claude/scripts/jaketunes-workmini-index-sync.sh'),
    'utf-8',
  )

  test('has an independent homemini stamp (heals workmini-already-current mornings)', () => {
    // Aug 12: early-exit keyed only on workmini size/mtime left homemini
    // never kickstarted after a partial overnight run — new songs stayed 404.
    assert.match(
      syncScript,
      /HM_STAMP=/,
      'index-sync must stamp successful homemini teaches separately from workmini',
    )
    assert.match(
      syncScript,
      /NEED_HM=/,
      'index-sync must decide homemini teach independently of the workmini push',
    )
  })

  test('kickstarts homemini and waits for healthz before pushing workmini', () => {
    assert.match(
      syncScript,
      /launchctl kickstart -k/,
      'index-sync must kickstart the stream backend so new ids enter the in-memory map',
    )
    assert.match(
      syncScript,
      /healthz/,
      'index-sync must wait for healthz — kickstart returns before the id map is ready',
    )
    const teachFn = syncScript.indexOf('teach_homemini()')
    const wmPush = syncScript.indexOf('pushed index → workmini')
    assert.notEqual(teachFn, -1, 'teach_homemini function missing')
    assert.notEqual(wmPush, -1, 'workmini push log missing')
    assert.ok(
      teachFn < wmPush,
      'homemini teach must be defined/run before the workmini push — otherwise the UI races ahead of the id map',
    )
    assert.match(
      syncScript,
      /deferring workmini push/,
      'index-sync must refuse to push workmini when homemini did not learn the ids',
    )
  })

  test('cache-farm link pass never exists()/stat-follows into JakeShareNAS', () => {
    // os.path.exists on a farm→SMB path hangs the SSH tick when the mount wedges.
    const linkPass = syncScript.slice(syncScript.indexOf('Cache-farm links'))
    assert.doesNotMatch(
      linkPass,
      /os\.path\.exists\s*\(/,
      'link pass must not os.path.exists into the NAS mount — that is the SMB hang',
    )
  })
})

describe('workmini must not sync-probe SMB on the main thread', () => {
  test('loadDupeFingerprintsFromLibrary uses lstat, never existsSync', () => {
    const start = index.indexOf('async function loadDupeFingerprintsFromLibrary')
    assert.notEqual(start, -1)
    const open = index.indexOf('{', start)
    let depth = 0
    let end = open
    for (let i = open; i < index.length; i++) {
      if (index[i] === '{') depth++
      else if (index[i] === '}' && --depth === 0) { end = i; break }
    }
    const body = index.slice(open, end + 1)
    assert.match(body, /lstat\s*\(/, 'dupe scan must lstat local farm entries')
    assert.doesNotMatch(body, /existsSync\s*\(/,
      'existsSync is back in the dupe scan — that follows farm symlinks into SMB on the main thread and beachballs workmini')
  })

  test('resolveTrackAbsPath lstats before any follow', () => {
    const start = index.indexOf('async function resolveTrackAbsPath')
    assert.notEqual(start, -1)
    const open = index.indexOf('{', start)
    let depth = 0
    let end = open
    for (let i = open; i < index.length; i++) {
      if (index[i] === '{') depth++
      else if (index[i] === '}' && --depth === 0) { end = i; break }
    }
    const body = index.slice(open, end + 1)
    const lstatIdx = body.search(/await lstat\s*\(/)
    const statIdx = body.search(/await stat\s*\(/)
    assert.notEqual(lstatIdx, -1, 'resolveTrackAbsPath must lstat')
    assert.ok(statIdx === -1 || lstatIdx < statIdx,
      'resolveTrackAbsPath must not stat()-follow before lstat — that hangs on farm symlinks')
  })

  test('candidateMusicMounts does not existsSync and skips streamRoot on streaming clients', () => {
    const start = index.indexOf('async function candidateMusicMounts')
    assert.notEqual(start, -1)
    const open = index.indexOf('{', start)
    let depth = 0
    let end = open
    for (let i = open; i < index.length; i++) {
      if (index[i] === '{') depth++
      else if (index[i] === '}' && --depth === 0) { end = i; break }
    }
    const body = index.slice(open, end + 1)
    assert.doesNotMatch(body, /existsSync\s*\(/,
      'existsSync is back in candidateMusicMounts — sync SMB probe beachballs the UI')
    assert.match(body, /isHomeminiPlaybackClientCached/,
      'candidateMusicMounts must gate streamRoot out on streaming/cache-farm machines')
  })
})

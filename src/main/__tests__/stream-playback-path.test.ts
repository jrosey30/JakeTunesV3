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

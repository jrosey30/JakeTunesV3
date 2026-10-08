/**
 * A replica must not publish library.json, and must still run every other
 * leg of jaketunes-homemini-sync.sh. The early return in runSyncOnce skipped
 * music, artwork, overrides, playlists, play logs, and stars.
 *
 * The process that runs is ~/bin/jaketunes-homemini-sync.sh, a copy of
 * Dr. Claude/scripts/jaketunes-homemini-sync.sh. An older copy ignores
 * --skip-library-json and still publishes library.json.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { syncLaunchArgs, SKIP_LIBRARY_JSON_ARG } from '../../common/sync-launch-args.ts'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scriptPath = join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh')

describe('replica sync still runs everything except the library.json publish', () => {
  it('launch args keep the script and only add the library skip on a replica', () => {
    const script = '/Users/jake/bin/jaketunes-homemini-sync.sh'
    assert.deepEqual(
      syncLaunchArgs({ script, quick: true, homeminiOnly: true, skipLibraryJson: true }),
      [script, '--quick', '--homemini-only', SKIP_LIBRARY_JSON_ARG],
    )
    assert.deepEqual(
      syncLaunchArgs({ script, quick: false, homeminiOnly: false, skipLibraryJson: false }),
      [script],
    )
    assert.equal(syncLaunchArgs({
      script, quick: false, homeminiOnly: false, skipLibraryJson: true,
    })[0], script)
  })

  it('runSyncOnce does not return before launching the script', () => {
    const src = readFileSync(join(repoRoot, 'src', 'main', 'sync-orchestrator.ts'), 'utf8')
    const start = src.indexOf('async function runSyncOnce')
    const end = src.indexOf('export function triggerSync')
    assert.ok(start > 0 && end > start)
    const body = src.slice(start, end)
    assert.match(body, /blocksHubLibraryPublish/)
    assert.match(body, /syncLaunchArgs\(/)
    assert.match(body, /skipLibraryJson/)
    assert.equal(body.includes('return { ok: true, durationMs: 0 }'), false)
    assert.match(body, /spawn\('nice'/)
  })

  it('the script skips both library.json publishes and still runs the other legs', () => {
    const src = readFileSync(scriptPath, 'utf8')
    execFileSync('bash', ['-n', scriptPath])
    assert.match(src, /--skip-library-json/)
    assert.match(src, /\[ "\$f" = "library\.json" \] && continue/)
    const pushStart = src.indexOf('push_homemini_state() {')
    const pushEnd = src.indexOf('sync_artwork_to_homemini() {', pushStart)
    assert.ok(pushStart > 0 && pushEnd > pushStart)
    const push = src.slice(pushStart, pushEnd)
    assert.match(push, /if \[ "\$SKIP_LIBRARY_JSON" -eq 0 \]; then[\s\S]*publish_backend_library "\$lib_src"/)
    assert.equal(push.includes('run_music_rsync'), false)
    assert.equal(push.includes('mobile-stars'), false)
    assert.equal(push.includes('mobile-plays'), false)
    assert.equal(push.includes('PHONE_PLAYLIST_SIDECARS'), false)
    // Default assignment still publishes library.json when the flag is absent.
    const assigned = src.match(/SYNC_FILES=\(([^)]*)\)/)
    assert.ok(assigned)
    assert.ok(assigned[1].split(/\s+/).includes('library.json'))
    assert.match(assigned[1], /metadata-overrides\.json/)
    assert.match(assigned[1], /playlists\.json/)
    assert.match(assigned[1], /play-events\.jsonl/)
    assert.match(src, /\nrun_music_rsync\n/)
    assert.match(src, /\nsync_artwork_to_homemini\n/)
    assert.match(src, /mobile-stars\.json/)
    assert.match(src, /mobile-plays\.json/)
    assert.match(src, /PHONE_PLAYLIST_SIDECARS/)
    assert.match(src, /recommendations-deleted\.json/)
    assert.match(src, /listening-log\.jsonl/)
  })
})

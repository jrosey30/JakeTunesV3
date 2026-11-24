/**
 * The library's master audio files are never re-encoded by a menu tool.
 *
 * V7 steady (2026-11-24): File › Library › "Fix iPod Compatibility…" ran
 * core/alac_compat_fix.py --apply, which rewrote every hi-res ALAC master
 * in the library to 16-bit / 44.1 kHz in place. Sync already gives the iPod
 * a 16-bit copy from its own convert cache (buildIpodSafeAlacMirror), so
 * the tool could only shrink the masters. It is gone, and these checks keep
 * any tool like it from coming back unseen:
 *
 *   - no menu item, menu action, IPC channel, preload bridge or script
 *     for it;
 *   - the only `ipodSafe: true` (16-bit downsample) conversion writes
 *     into the sync convert cache, never beside the master;
 *   - every core/ Python script that runs ffmpeg or afconvert is on a
 *     short reviewed list, each writing somewhere other than the master.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../../..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue
      walk(rel, out)
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel)
  }
  return out
}

test('no menu item, action, IPC or bridge re-encodes library masters for the iPod', () => {
  const banned = [
    /Fix iPod Compatibility/i,
    /fix-ipod-compat/,
    /alac-compat-(scan|fix|progress)/,
    /alacCompat(Scan|Fix)|onAlacCompatProgress/,
    /alac_compat_fix/,
  ]
  const offenders: string[] = []
  for (const rel of walk('src')) {
    const src = readFileSync(join(ROOT, rel), 'utf-8')
    // Comments may name the removed tool to explain its absence; only code counts.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const re of banned) if (re.test(code)) offenders.push(`${rel}: ${re}`)
  }
  assert.deepEqual(offenders, [])
  assert.equal(existsSync(join(ROOT, 'core/alac_compat_fix.py')), false)
  assert.equal(existsSync(join(ROOT, 'src/renderer/components/LibraryMaintenanceModal.tsx')), false)
})

test('the 16-bit iPod-safe conversion writes only into the sync convert cache', () => {
  const index = read('src/main/index.ts')
  const calls = [...index.matchAll(/ipodSafe:\s*true/g)]
  assert.equal(calls.length, 1, 'one ipodSafe conversion, inside buildIpodSafeAlacMirror')
  const start = index.indexOf('async function buildIpodSafeAlacMirror(')
  assert.ok(start > 0)
  const body = index.slice(start, index.indexOf('\n}\n', start))
  assert.ok(body.includes('ipodSafe: true'), 'the ipodSafe call sits in buildIpodSafeAlacMirror')
  assert.match(body, /const cacheDir = join\(app\.getPath\('userData'\), SYNC_CONVERT_CACHE_SUBDIR\)/)
  assert.match(body, /const cached = join\(cacheDir, /)
  assert.match(body, /const tmp = cached \+ /)
  assert.match(body, /convertAudio\(srcPath, tmp, /)
  assert.match(body, /rename\(tmp, cached\)/)
  // Nowhere else in main asks for the downsample.
  for (const rel of walk('src/main')) {
    if (rel === 'src/main/index.ts' || rel === 'src/main/platform.ts') continue
    assert.doesNotMatch(read(rel), /ipodSafe:\s*true/, rel)
  }
})

test('every core/ script that encodes audio is a reviewed one', () => {
  // Each writes somewhere other than the master: the play cache, or tags
  // only. A new encoder here needs a look, then a line in this list.
  const reviewed = new Set(['prewarm_play_cache.py', 'tag_writer.py'])
  const encoders = readdirSync(join(ROOT, 'core'))
    .filter((f) => f.endsWith('.py'))
    .filter((f) => /['"](ffmpeg|afconvert)['"]/.test(read(`core/${f}`)))
  for (const f of encoders) assert.ok(reviewed.has(f), `core/${f} runs an encoder and is not reviewed`)
})

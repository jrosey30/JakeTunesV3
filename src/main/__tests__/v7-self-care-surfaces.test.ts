/**
 * V7 "the library looks after itself": what Jake sees.
 *   - File › Library holds only his decisions (Needs You…, Show Duplicates…).
 *   - Settings speaks in plain words: no internal names anywhere in its copy.
 *   - Settings › Sync is Backups; Storage holds the one offload switch; tabs
 *     underline in orange; Restore asks with the standard confirm; one close button.
 *   - The Music Man page is only the chat.
 *   - Offload keeps every refusal rule: the switch goes through runStart.
 * Source-shape locks, like structural-rails.test.ts.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

/** Code with its comments taken out: words in comments are for engineers. */
function withoutComments(code: string): string {
  return code
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

describe('File › Library', () => {
  const index = read('main/index.ts')
  const appMenu = read('main/app-menu.ts')
  const start = appMenu.indexOf("label: 'Library',")
  const menu = appMenu.slice(start, appMenu.indexOf('],', start))

  test('holds only Needs You… and Show Duplicates…', () => {
    const labels = [...menu.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(labels, ['Library', 'Needs You…', 'Show Duplicates…'])
  })

  test('none of the old tools are anywhere in the menus', () => {
    for (const gone of ['Prune Play-Cache', 'Refresh File Sizes', 'Apply Overrides to Files', 'Clean Orphan Files', 'Prepare ALAC', 'Offload Audio', 'Undo Offload', 'Fix iPod Compatibility']) {
      assert.ok(!index.includes(`'${gone}`) && !appMenu.includes(`'${gone}`), `${gone} is still in a menu`)
    }
  })

  test('the renderer opens Needs You, and it lists duplicates, files and genres', () => {
    assert.match(read('renderer/App.tsx'), /case 'show-needs-you':\s+setNeedsYouOpen\(true\)/)
    const sheet = read('renderer/components/NeedsYouSheet.tsx')
    assert.match(sheet, /onShowDuplicates/)
    assert.match(sheet, /onShowOrphans/)
    assert.match(sheet, /<GenreCheckList \/>/)
  })

  test('the hand-built maintenance progress windows are gone from App.tsx', () => {
    const app = read('renderer/App.tsx')
    for (const gone of ['applyOverridesProgress', 'refreshSizesProgress', 'PlayCacheModal', 'applyOverridesBatch', 'refreshFileSizes(']) {
      assert.ok(!app.includes(gone), gone)
    }
  })
})

describe('Settings in plain words', () => {
  // Names Jake should never read in the app (the V7 slop list).
  const BANNED: Array<[string, RegExp]> = [
    ['homemini', /\bhomemini\b/i],
    ['TSA', /\bTSA\b/],
    ['RAG', /\bRAG\b/],
    ['symlink', /symlink/i],
    ['OPENAI_API_KEY', /OPENAI_API_KEY/],
    ['library.json', /library\.json/i],
    ['NAS', /\bNAS\b/],
    ['Tailscale', /tailscale/i],
    ['SMB', /\bSMB\b/],
    ['.env', /\.env\b/],
    ['sha1', /\bsha1\b/i],
    ['embeddings.bin', /embeddings\.bin/i],
    ['a version number', /\b4\.5\.0/],
    ['auto-repair', /auto-repair/i],
    ['an error code', /\berror code\b/i],
  ]
  const FILES = ['renderer/components/SettingsModal.tsx', 'renderer/components/NeedsYouSheet.tsx', 'renderer/components/CloseButton.tsx', 'renderer/views/MusicManView.tsx']

  for (const file of FILES) {
    test(`${file} says none of the internal names`, () => {
      const code = withoutComments(read(file))
      const found = BANNED.filter(([, re]) => re.test(code)).map(([w]) => w)
      assert.deepEqual(found, [], `${file} shows: ${found.join(', ')}`)
    })
  }

  test('the check would catch one (mutation guard)', () => {
    const planted = withoutComments(read('renderer/components/SettingsModal.tsx')) + '\n<p>Copies to homemini over SMB.</p>'
    assert.ok(BANNED.some(([, re]) => re.test(planted)))
    assert.equal(BANNED.some(([, re]) => re.test(withoutComments('// homemini in a comment is fine\nconst a = 1'))), false)
  })

  const settings = read('renderer/components/SettingsModal.tsx')
  test('Sync is Backups, Storage is new, and the tabs underline in orange', () => {
    assert.match(settings, /const TABS: Tab\[\] = \['Playback', 'EQ', 'Library', 'Music Sources', 'Backups', 'Storage', 'Audio', 'AI'\]/)
    assert.ok(!settings.includes("'Sync'"))
    // ⌘K's list of Preferences tabs is the same list.
    assert.match(read('renderer/goAnywhere.ts'), /GO_SETTINGS: readonly string\[\] = \['Playback', 'EQ', 'Library', 'Music Sources', 'Backups', 'Storage', 'Audio', 'AI'\]/)
    assert.ok(!settings.includes('#4a7fbf'), 'no blue underline')
    assert.match(settings, /borderBottom: tab === t \? '2px solid var\(--brand-orange, #FC5501\)'/)
  })

  test('Restore asks with the standard confirm (Cancel left, Restore right)', () => {
    assert.match(settings, /<ConfirmDialog\s+message="Restore this snapshot\?"/)
    assert.ok(!/>Yes<\/button>/.test(settings), 'no hand-made Yes/No')
  })

  test('one close button: the shared one, never a typed × or ✕', () => {
    assert.match(settings, /<CloseButton onClick=\{closeAndRevertAudio\} \/>/)
    for (const f of ['renderer/components/SettingsModal.tsx', 'renderer/components/NeedsYouSheet.tsx', 'renderer/components/ShowDuplicatesModal.tsx', 'renderer/components/OrphanCleanupModal.tsx']) {
      const code = withoutComments(read(f))
      assert.ok(!/>[×✕]</.test(code), `${f} types its own close`)
    }
  })

  test('Storage holds the one offload switch; Library no longer does; the engineer controls are under Advanced', () => {
    const storage = settings.slice(settings.indexOf("{tab === 'Storage' && ("), settings.indexOf("{tab === 'Backups' && ("))
    assert.match(storage, /checked=\{draft\.library\.offloadAudioToHomemini === true\}/)
    assert.match(storage, /<summary[^>]*>Advanced<\/summary>/)
    for (const control of ['reconcileStateNow', 'runEmbeddingBackfill', 'artworkLockCount', 'offloadBringBack']) assert.ok(storage.includes(control), control)
    const library = settings.slice(settings.indexOf("{tab === 'Library' && ("), settings.indexOf("{tab === 'Storage' && ("))
    assert.ok(!library.includes('offloadAudioToHomemini'))
    assert.ok(!library.includes('GenreCheckList'))
  })
})

describe('the Music Man page is the chat', () => {
  const view = read('renderer/views/MusicManView.tsx')
  test('no brain wall, no analysis bar, no badge', () => {
    for (const gone of ['brainStatus', 'THE BRAIN', 'Re-measure', 'In the Store', 'audioAnalysisEnqueueMany', 'mm-wall']) assert.ok(!view.includes(gone), gone)
    assert.match(view, /<MusicManChat variant="page" \/>/)
  })
})

describe('offload keeps its rules', () => {
  const ipc = read('main/ipc/offload-ipc.ts')
  test('the Settings switch starts through runStart, which still refuses a replica or a switch that is off', () => {
    assert.match(ipc, /ipc\.handle\('offload-audio-start', async \(_e, opts\?: \{ settingJustSaved\?: boolean \}\) => \{[\s\S]*?return runStart\(false\)/)
    const start = ipc.slice(ipc.indexOf('async function runStart('), ipc.indexOf('async function runStart(') + 600)
    assert.match(start, /if \(!hubOffloadActive\(\{ streamSource: source, offload: await host\.readOffloadAudio\(\) \}\)\)/)
    assert.ok(!ipc.includes('menuHubOffload'), 'no menu path left')
  })
  test('the per-file refusal (never on homemini, never into the vault) is untouched', () => {
    const oa = read('main/offload-audio.ts')
    assert.match(oa, /if \(AUDIO_HOST_NAME\.test\(facts\.hostname\)\) return 'this machine serves \/audio'/)
    assert.match(oa, /if \(facts\.realPath\.startsWith\('\/Volumes\/'\) \|\| facts\.realPath\.startsWith\('\\\\\\\\'\)\)/)
  })
})

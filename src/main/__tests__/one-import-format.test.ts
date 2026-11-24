/**
 * One import format (V7 steady, 2026-11-24).
 *
 * There were three: Settings › Library's default, Import and Convert's own
 * picker (started at ALAC) and the CD page's own picker (remembered in
 * ui-state.json, started at AAC 256; drag and drop and File › Import read
 * that ui-state key too). Now Settings › Library holds the only one,
 * default Apple Lossless, and every import reads it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_IMPORT_FORMAT, IMPORT_FORMATS, IMPORT_FORMAT_LABELS, importFormatFromSettings,
} from '../../common/import-format.ts'
import { DEFAULT_IMPORT_FORMAT as PLATFORM_DEFAULT } from '../platform.ts'

const SRC = join(import.meta.dirname, '../..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf-8')

test('the setting decides; missing or unknown is Apple Lossless', () => {
  assert.equal(DEFAULT_IMPORT_FORMAT, 'alac')
  assert.equal(PLATFORM_DEFAULT, 'alac')
  assert.equal(IMPORT_FORMAT_LABELS.alac, 'Apple Lossless')
  assert.equal(importFormatFromSettings(null), 'alac')
  assert.equal(importFormatFromSettings({}), 'alac')
  assert.equal(importFormatFromSettings({ library: {} }), 'alac')
  assert.equal(importFormatFromSettings({ library: { defaultImportFormat: 'mp3' } }), 'alac')
  assert.equal(importFormatFromSettings({ library: { defaultImportFormat: 42 } }), 'alac')
  for (const f of IMPORT_FORMATS) {
    assert.equal(importFormatFromSettings({ library: { defaultImportFormat: f } }), f)
  }
})

test('Settings › Library is the only picker, labelled from the shared list', () => {
  const settings = read('renderer/components/SettingsModal.tsx')
  assert.match(settings, /IMPORT_FORMATS\.map\(\(value\) => \(\{ value, label: IMPORT_FORMAT_LABELS\[value\] \}\)\)/)
  assert.match(settings, /value=\{draft\.library\.defaultImportFormat\}/)
})

test('the CD page and Import and Convert show the format, never pick or store it', () => {
  for (const rel of ['renderer/views/CDImportView.tsx', 'renderer/components/ImportConvertModal.tsx']) {
    const src = read(rel)
    assert.doesNotMatch(src, /<select/, `${rel} has a format picker`)
    assert.doesNotMatch(src, /saveUiState\([^)]*importFormat/, `${rel} stores its own format`)
    assert.doesNotMatch(src, /\.importFormat\b/, `${rel} reads a remembered format`)
    assert.match(src, /importFormatFromSettings\(/, `${rel} shows Settings' format`)
  }
  const modal = read('renderer/components/ImportConvertModal.tsx')
  assert.match(modal, /await enqueueFiles\(paths\)\n/, 'Import and Convert sends no format')
  const cd = read('renderer/views/CDImportView.tsx')
  assert.match(cd, /ripCdTracks\(\s*tracksToRip,\s*\{[^}]*\},\s*nextId,\s*\)/, 'the CD rip sends no format')
})

test('drag and drop and File › Import send no format of their own', () => {
  const app = read('renderer/App.tsx')
  assert.doesNotMatch(app, /\.importFormat\b/)
  assert.match(app, /void enqueueFiles\(droppedPaths\)\n/)
  assert.match(app, /void enqueueFiles\(r\.paths\)\n/)
  // No renderer file keeps an import format in ui-state any more.
  for (const rel of ['renderer/App.tsx', 'renderer/views/CDImportView.tsx', 'renderer/components/ImportConvertModal.tsx']) {
    assert.doesNotMatch(read(rel), /importFormat:/, rel)
  }
})

test('the CD rip in main reads Settings, not a format from the renderer', () => {
  const cd = read('main/ipc/cd-ipc.ts')
  const start = cd.indexOf("ipc.handle('rip-cd-tracks'")
  assert.ok(start > 0)
  const head = cd.slice(start, cd.indexOf(') => {', start))
  assert.doesNotMatch(head, /format/, 'rip-cd-tracks takes no format argument')
  assert.match(cd, /const fmt: ImportFormat = await host\.readImportFormat\(\)/)
  assert.match(read('main/index.ts'), /readImportFormat: async \(\) => importFormatFromSettings\(await readAppSettingsAsync\(\)\)/)
  assert.doesNotMatch(read('preload/index.ts'), /invoke\('rip-cd-tracks', tracks, metadata, nextId, format\)/)
})

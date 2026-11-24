/**
 * Device page options (V7 steady, 2026-11-24): only options something
 * reads, each saved the moment it changes, and nothing greys out Sync.
 * "Sync only checked songs", "Manually manage music" and "Enable disk use"
 * were saved and never read; ticking one blocked Sync until Apply.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  convertKbps, DEFAULT_DEVICE_OPTIONS, readDeviceOptions, saveDeviceOption,
} from '../../renderer/deviceOptions.ts'

const SRC = join(import.meta.dirname, '../..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf-8')

function fakeUiState(initial: Record<string, unknown> | null) {
  let state = initial
  const saves: Array<Record<string, unknown>> = []
  return {
    saves,
    get state() { return state },
    loadUiState: async () => ({ ok: true, state }),
    saveUiState: async (s: Record<string, unknown>) => { saves.push(s); state = s; return { ok: true } },
  }
}

test('a change saves at once and keeps every other ui-state key', async () => {
  const ui = fakeUiState({ sortKey: 'artist', optConvertBitrate: true })
  await saveDeviceOption(ui, { optOpenOnConnect: true })
  assert.equal(ui.saves.length, 1)
  assert.deepEqual(ui.state, { sortKey: 'artist', optConvertBitrate: true, optOpenOnConnect: true })
  await saveDeviceOption(ui, { optConvertBitrateTarget: '256' })
  assert.deepEqual(ui.state, { sortKey: 'artist', optConvertBitrate: true, optOpenOnConnect: true, optConvertBitrateTarget: '256' })
})

test('saving works with no ui-state yet', async () => {
  const ui = fakeUiState(null)
  await saveDeviceOption(ui, { optOpenOnConnect: false })
  assert.deepEqual(ui.state, { optOpenOnConnect: false })
})

test('reading: kept values, defaults otherwise, and no removed option', () => {
  assert.deepEqual(readDeviceOptions(null), DEFAULT_DEVICE_OPTIONS)
  assert.deepEqual(
    readDeviceOptions({ optOpenOnConnect: true, optConvertBitrate: true, optConvertBitrateTarget: '192', optSyncOnlyChecked: true, optDiskUse: false }),
    { optOpenOnConnect: true, optConvertBitrate: true, optConvertBitrateTarget: '192' },
  )
  assert.equal(readDeviceOptions({ optConvertBitrateTarget: '320' }).optConvertBitrateTarget, '128')
  assert.equal(convertKbps('128'), 128)
  assert.equal(convertKbps('192'), 192)
  assert.equal(convertKbps('256'), 256)
})

test('the Device page has no Apply step and no option nothing reads', () => {
  const view = read('renderer/views/DeviceView.tsx')
  for (const gone of [/optSyncOnlyChecked/, /optManualManage/, /optDiskUse/, /Sync only checked songs/,
    /Manually manage music/, /Enable disk use/, /isDirty/, /appliedSettings/, /Click Apply first/, />Apply</]) {
    assert.doesNotMatch(view, gone, String(gone))
  }
  // Sync and Full Sync are disabled only while a sync runs.
  assert.match(view, /className="device-itunes-btn device-itunes-btn--sync"\s*disabled=\{syncing\}/)
  assert.match(view, /disabled=\{syncing\} onClick=\{handleFullSync\}/)
  // Every kept option saves on change.
  assert.match(view, /onChange=\{e => changeDeviceOption\(\{ optOpenOnConnect: e\.target\.checked \}\)\}/)
  assert.match(view, /onChange=\{e => changeDeviceOption\(\{ optConvertBitrate: e\.target\.checked \}\)\}/)
  assert.match(view, /saveDeviceOption\(window\.electronAPI, patch\)/)
})

test('the removed options are read nowhere in the app', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(rel); continue }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      if (/optSyncOnlyChecked|optManualManage|optDiskUse/.test(read(rel))) offenders.push(rel)
    }
  }
  for (const d of ['main', 'renderer', 'preload', 'common']) walk(d)
  assert.deepEqual(offenders, [])
})

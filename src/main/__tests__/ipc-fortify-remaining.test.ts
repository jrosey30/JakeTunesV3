/**
 * Desktop fortification leftover: no raw ipcMain.handle outside the
 * registrar wrapper. Domain pockets (record-store, imessage, gapless)
 * must register through IpcRegistrar.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertIpcRegisterOptions, REFUSED_SENDER } from '../ipc-register.ts'

const here = dirname(fileURLToPath(import.meta.url))
const mainDir = join(here, '..')

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name === '__tests__' || name.name.startsWith('.')) continue
    const p = join(dir, name.name)
    if (name.isDirectory()) walkTs(p, acc)
    else if (name.name.endsWith('.ts')) acc.push(p)
  }
  return acc
}

test('no raw ipcMain.handle outside ipc-register.ts', () => {
  const files = walkTs(mainDir)
  const leaks: string[] = []
  for (const file of files) {
    if (file.endsWith('ipc-register.ts')) continue
    const src = readFileSync(file, 'utf-8')
    if (/ipcMain\.handle\s*\(/.test(src)) leaks.push(file.replace(mainDir + '/', ''))
  }
  assert.deepEqual(leaks, [], `raw ipcMain.handle remaining in: ${leaks.join(', ')}`)
})

test('record-store / imessage / gapless register through IpcRegistrar', () => {
  const recordStore = readFileSync(join(mainDir, 'record-store/index.ts'), 'utf-8')
  assert.match(recordStore, /ipc: IpcRegistrar/)
  assert.match(recordStore, /record-store:get-shelves/)
  assert.match(recordStore, /refuse: REFUSED_SHELVES/)
  assert.match(recordStore, /refuse: null/)
  assert.match(recordStore, /refuse: REFUSED_SENDER/)

  const imsg = readFileSync(join(mainDir, 'imessage-capture.ts'), 'utf-8')
  assert.match(imsg, /startImessageCapture\(ipc: IpcRegistrar/)
  assert.match(imsg, /imessage-capture-status/)
  assert.match(imsg, /public: true/)
  assert.match(imsg, /imessage-capture-scan/)
  assert.match(imsg, /refused-sender/)

  const gapless = readFileSync(join(mainDir, 'gapless-trim.ts'), 'utf-8')
  assert.match(gapless, /registerGaplessTrimIpc\(ipc: IpcRegistrar/)
  assert.match(gapless, /refuse: null/)
})

test('index.ts leftover pockets use ipc.handle with public or refuse', () => {
  const src = readFileSync(join(mainDir, 'index.ts'), 'utf-8')
  assert.doesNotMatch(src, /ipcMain\.handle\s*\(/)
  assert.match(src, /ipc\.handle\('get-related-artists'/)
  assert.match(src, /ipc\.handle\('get-app-version', \(\) => app\.getVersion\(\), \{ public: true \}/)
  assert.match(src, /ipc\.handle\('alac-compat-scan'/)
  assert.match(src, /ipc\.handle\('scan-dead-tracks'/)
  assert.match(src, /ipc\.handle\('prepare-alac-cache'/)
  assert.match(src, /ipc\.handle\('load-tracks'/)
  assert.match(src, /ipc\.handle\('open-full-disk-access-settings'/)
  // One-liners carry the option on the same statement.
  assert.match(src, /get-app-version.*\{ public: true \}/)
  assert.match(src, /track-local-state[\s\S]*?\{ refuse: 'unknown' as const \}/)
})

test('paid / mutate leftovers still default-deny at the registrar', () => {
  for (const ch of ['get-related-artists', 'alac-compat-scan', 'prepare-alac-cache', 'record-store:get-shelves']) {
    assert.throws(
      () => assertIpcRegisterOptions(ch, undefined),
      /must pass \{ refuse \} or \{ public: true \}/,
    )
  }
  assert.deepEqual(
    assertIpcRegisterOptions('load-tracks', { public: true }),
    { public: true },
  )
  assert.deepEqual(
    assertIpcRegisterOptions('alac-compat-scan', { refuse: REFUSED_SENDER }),
    { public: false },
  )
})

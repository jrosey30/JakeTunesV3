/**
 * Default-deny contract for channels extracted into domain IPC modules.
 * (Loading the modules themselves needs Electron; this covers the
 * createIpcRegistrar options rule those modules rely on.)
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REFUSED_SENDER, assertIpcRegisterOptions } from '../ipc-register.ts'

const here = dirname(fileURLToPath(import.meta.url))
const ipcDir = join(here, '..', 'ipc')

test('domain ipc module files exist', () => {
  for (const name of ['library-ipc.ts', 'ipod-ipc.ts', 'sync-ipc.ts', 'ai-ipc.ts']) {
    const src = readFileSync(join(ipcDir, name), 'utf-8')
    assert.match(src, /export function register\w+Ipc/)
    assert.match(src, /createIpcRegistrar|IpcRegistrar|REFUSED_SENDER/)
  }
})

test('extracted mutating channels require refuse (default-deny contract)', () => {
  for (const ch of [
    'save-artist-aliases',
    'eject-ipod',
    'cancel-sync',
    'sync-to-ipod',
    'save-chat-history',
    'cynthia-dismiss-fix',
  ]) {
    assert.throws(
      () => assertIpcRegisterOptions(ch, undefined),
      /must pass \{ refuse \} or \{ public: true \}/,
    )
  }
  assert.deepEqual(
    assertIpcRegisterOptions('load-artist-aliases', { public: true }),
    { public: true },
  )
  assert.deepEqual(
    assertIpcRegisterOptions('save-artist-aliases', { refuse: REFUSED_SENDER }),
    { public: false },
  )
})

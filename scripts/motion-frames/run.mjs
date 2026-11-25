// npm run test:frames — start the page-move frame test (main.mjs) in Electron.
// ELECTRON_BIN overrides the binary (a worktree whose node_modules has no
// Electron download can point at another checkout's).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
let bin = process.env.ELECTRON_BIN
if (!bin) {
  try { bin = createRequire(import.meta.url)('electron') } catch (e) {
    console.error(`No Electron binary (${e.message}). Set ELECTRON_BIN to one.`)
    process.exit(2)
  }
}
const r = spawnSync(bin, [join(here, 'main.mjs')], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' } })
process.exit(r.status ?? 1)

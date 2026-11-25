// Node module hooks for jake-edits-stay.test.ts, which runs the real Cynthia
// sweep (cynthia-sweep.ts). Only what can't load outside the app is replaced:
//
//   electron          a stub: only userData is asked for
//   main/state-dir    a stub: STATE_DIR is the test's temp dir (the real one
//                     reaches for the NAS at load)
//   a relative import with no extension resolves to its .ts, as vite does.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIR = () => process.env.JT_USER_DATA || '/nonexistent/userdata'
const STUBS = {
  electron: `
    const userData = ${JSON.stringify(DIR())}
    export const app = { getPath: () => userData, getName: () => 'JakeTunes', getVersion: () => 'test', isPackaged: false }
    export default { app }
  `,
  statedir: `
    export const STATE_DIR = ${JSON.stringify(DIR())}
    export const STATE_IS_NAS = false
    export const NAS_STATE_DIR_PATH = '/nonexistent/nas'
    export function isSaveLocked() { return null }
  `,
}

function stubFor(specifier, parentURL) {
  if (specifier === 'electron') return 'electron'
  if (!specifier.startsWith('.') || !parentURL?.startsWith('file:')) return null
  const path = new URL(specifier, parentURL).pathname
  if (/\/main\/state-dir(\.ts)?$/.test(path)) return 'statedir'
  return null
}

export async function resolve(specifier, context, next) {
  const stub = stubFor(specifier, context.parentURL)
  if (stub) return { url: `jake-edits-stub:${stub}`, shortCircuit: true }
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL)
    const path = fileURLToPath(url)
    if (!existsSync(path) && existsSync(`${path}.ts`)) return next(`${url.href}.ts`, context)
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.startsWith('jake-edits-stub:')) {
    return { format: 'module', source: STUBS[url.slice('jake-edits-stub:'.length)], shortCircuit: true }
  }
  return next(url, context)
}

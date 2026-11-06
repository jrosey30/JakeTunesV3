// Node module hooks for the tests that run the real RadioEngine and the real
// speech handlers (radio-engine.test.ts, speech-ipc.test.ts). Only what can't load
// outside the app is replaced, at the import boundary, so the code under test
// stays the file that ships:
//
//   electron                        a stub: these paths only ask it for userData
//   main/cynthia-sweep              a stub: it pulls in state-dir, which reaches the NAS
//   renderer/audio/eq, stingers     recording stubs: no Web Audio or Howler here
//   renderer/activity               a recording stub: says what the pill was told
//   a relative import with no       its .ts, the way vite resolves it in the app
//   extension
//
// The stubs run on the test's own thread, so they report to a function the test
// puts on globalThis.__radioEffects.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const STUBS = {
  electron: `
    const userData = process.env.JT_USER_DATA || '/nonexistent/userdata'
    export const app = { getPath: () => userData, getName: () => 'JakeTunes', getVersion: () => 'test', isPackaged: false }
    export const dialog = {}
    export class BrowserWindow {}
    export const ipcMain = { handle() { throw new Error('the tests use their own registrar') } }
    export default { app, dialog, BrowserWindow, ipcMain }
  `,
  cynthia: `
    export const getFindingsFor = async () => []
    export const dismissFinding = async () => {}
    export const getLedger = async () => []
    export const sweepStatus = async () => ({})
  `,
  eq: `
    const report = (...args) => globalThis.__radioEffects?.(...args)
    export const attachClipToBroadcast = (audio) => report('attachClip', audio)
    export const attachAnnouncerToBroadcast = (audio) => report('attachAnnouncer', audio)
    export const detachClipFromBroadcast = (audio) => report('detach', audio)
  `,
  stingers: `
    const report = (...args) => globalThis.__radioEffects?.(...args)
    export const randomPreStinger = () => 'pre-stinger'
    export const randomEndStinger = () => 'end-stinger'
    export const playStinger = (type) => { report('stinger', type); return 0.1 }
  `,
  activity: `
    const report = (...args) => globalThis.__radioEffects?.(...args)
    export const setBroadcastTimed = (caption, durationMs) => report('caption', caption, durationMs)
    export const setRadio = (status) => report('radio', status)
  `,
}

function stubFor(specifier, parentURL) {
  if (specifier === 'electron') return 'electron'
  if (!specifier.startsWith('.') || !parentURL?.startsWith('file:')) return null
  const path = new URL(specifier, parentURL).pathname
  if (/\/main\/cynthia-sweep(\.ts)?$/.test(path)) return 'cynthia'
  if (/\/renderer\/audio\/eq(\.ts)?$/.test(path)) return 'eq'
  if (/\/renderer\/audio\/stingers(\.ts)?$/.test(path)) return 'stingers'
  if (/\/renderer\/activity(\.ts)?$/.test(path)) return 'activity'
  return null
}

export async function resolve(specifier, context, next) {
  const stub = stubFor(specifier, context.parentURL)
  if (stub) return { url: `speech-test-stub:${stub}`, shortCircuit: true }
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL)
    const path = fileURLToPath(url)
    if (!existsSync(path) && existsSync(`${path}.ts`)) return next(`${url.href}.ts`, context)
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.startsWith('speech-test-stub:')) {
    return { format: 'module', source: STUBS[url.slice('speech-test-stub:'.length)], shortCircuit: true }
  }
  return next(url, context)
}

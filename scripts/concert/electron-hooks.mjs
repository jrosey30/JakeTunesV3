// Node module-customization hooks: map the bare `electron` specifier to a
// stub so src/main/live-set-merge.ts (→ platform.ts → tag-writer.ts) runs
// outside the app. Registered by shim-register.mjs.
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'electron-stub:app', shortCircuit: true }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === 'electron-stub:app') {
    const repo = process.env.JT_REPO_ROOT || process.cwd()
    const userData = process.env.JT_USER_DATA || `${process.env.HOME}/Library/Application Support/JakeTunes`
    const source = `
      export const app = {
        isPackaged: false,
        getAppPath: () => ${JSON.stringify(repo)},
        getPath: (name) => name === 'userData' ? ${JSON.stringify(userData)} : ${JSON.stringify(userData)},
        getVersion: () => 'headless',
        on: () => {}, once: () => {},
      }
      export const dialog = { showMessageBox: async () => ({ response: 0 }) }
      export const shell = { openPath: async () => '' }
      export default { app, dialog, shell }
    `
    return { format: 'module', source, shortCircuit: true }
  }
  return next(url, context)
}

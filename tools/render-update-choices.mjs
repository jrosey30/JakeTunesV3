#!/usr/bin/env node
/**
 * The status bar's update control in every state, drawn headless (2026-11-14).
 *
 *   node tools/render-update-choices.mjs <out-dir>
 *
 * Bundles src/renderer/components/chrome/UpdateChoices.tsx with esbuild,
 * renders each state to static HTML with the app's own stylesheets
 * (variables.css, reset.css, app.css) inside a status bar strip, and takes a
 * picture of each with headless Chrome. Nothing opens on screen; nothing
 * touches the app or its data. One PNG per state, plus the HTML beside it.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const out = resolve(process.argv[2] ?? 'update-choices-shots')
const root = resolve(import.meta.dirname, '..')
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(existsSync)
if (!chrome) { console.error('no Chrome or Chromium in /Applications'); process.exit(1) }
mkdirSync(out, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'jt-update-choices-'))

const entry = `
import { renderToStaticMarkup } from 'react-dom/server'
import UpdateChoices from ${JSON.stringify(join(root, 'src/renderer/components/chrome/UpdateChoices.tsx'))}
export function render(props) { return renderToStaticMarkup(<UpdateChoices {...props} />) }
`
await build({
  stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile: join(work, 'render.cjs'), logLevel: 'error',
})
const { render } = createRequire(import.meta.url)(join(work, 'render.cjs'))

// A Friday morning, 9:40.
const now = new Date(2026, 10, 14, 9, 40).getTime()
const tonight = new Date(2026, 10, 15, 3, 0).getTime()
const offer = {
  sha: '0123456789abcdef0123456789abcdef01234567', version: '6.1.0', note: '', label: 'This week’s fixes', kind: 'weekly',
  notes: ['Album pages open faster from the Artists grid', 'The iPod page counts its songs right after a sync', 'A seek on a streamed song no longer stutters'],
  offeredAt: new Date(now - 3600_000).toISOString(), decides: true, phase: 'offered', at: null, waitingFor: null,
}
const noop = () => {}
const base = { installing: false, failed: false, afterSync: false, now, onInstallNow: noop, onInstallAt: async () => true, onSkip: noop, onCancel: noop }
const states = [
  ['1-offered', { ...base, ready: offer }],
  ['1b-offered-notes', { ...base, ready: offer, initialPanel: 'notes' }],
  ['1c-offered-install-at', { ...base, ready: offer, initialPanel: 'at' }],
  ['1d-offered-old-style-gate', { ...base, ready: { ...offer, decides: false, label: 'Version 6.1.0', notes: ['Album page fixes'] } }],
  ['2-scheduled', { ...base, ready: { ...offer, phase: 'scheduled', at: new Date(tonight).toISOString() } }],
  ['2b-waiting', { ...base, ready: { ...offer, phase: 'waiting', at: new Date(tonight).toISOString(), waitingFor: 'the music is playing' } }],
  ['3-installing', { ...base, ready: { ...offer, phase: 'installing' }, installing: true }],
]

const css = ['variables.css', 'reset.css', 'app.css'].map((f) => readFileSync(join(root, 'src/renderer/styles', f), 'utf8')).join('\n')
for (const [name, props] of states) {
  const control = render(props)
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html, body { margin: 0; height: 100%; background: #ffffff; overflow: hidden; }
.shot { position: absolute; left: 0; right: 0; bottom: 0; height: var(--statusbar-height, 24px); }
.page { position: absolute; inset: 0 0 24px 0; background: linear-gradient(180deg, #ffffff, #f4f4f4); }
</style></head><body>
<div class="page"></div>
<div class="shot statusbar-area"><div class="statusbar statusbar--update"><span class="statusbar-info">9,731 songs, 27 days, 13 hours, 412.6 GB</span>${control}</div></div>
</body></html>`
  const htmlPath = join(out, `${name}.html`)
  writeFileSync(htmlPath, html)
  // Its own profile each time, and three tries: headless Chrome now and then exits 2 on a busy Mac.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${join(work, `profile-${name}-${attempt}`)}`, '--force-device-scale-factor=2', `--screenshot=${join(out, `${name}.png`)}`, '--window-size=1100,300', pathToFileURL(htmlPath).href], { stdio: 'ignore', timeout: 60_000 })
      break
    } catch (err) {
      if (attempt >= 3) throw err
    }
  }
  console.log(join(out, `${name}.png`))
}
rmSync(work, { recursive: true, force: true })

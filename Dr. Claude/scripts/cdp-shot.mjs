#!/usr/bin/env node
// ============================================================================
// cdp-shot.mjs — screenshot a running JakeTunes renderer, optionally after
//                navigating the app to a given view.
// ============================================================================
//
// WHY
//   Sibling of cdp-eval.mjs. Design work on a running Electron app kept
//   stalling because there was no way to SEE the app without asking Jake for a
//   screenshot — so pages got redesigned from CSS, which produces exactly the
//   kind of "lazy" restyle that misses what's actually wrong on screen (empty
//   lanes, placeholder artwork, filler copy). This closes that loop.
//
// USAGE
//   node "Dr. Claude/scripts/cdp-shot.mjs" out.png
//   node "Dr. Claude/scripts/cdp-shot.mjs" out.png "<js to run first>"
//
//   The optional second argument is evaluated in the renderer and awaited
//   briefly before the capture — use it to navigate:
//
//     node ... discover.png "window.dispatchEvent(new CustomEvent('jaketunes-nav',{detail:{view:'discovery'}}))"
//
//   Requires the app launched with --remote-debugging-port=9222.
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const [out, pre] = process.argv.slice(2)
if (!out) { console.error('usage: cdp-shot.mjs <out.png> [js-to-run-first]'); process.exit(2) }

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(t => t.type === 'page')
if (!page) { console.error('no page target — is the app running with --remote-debugging-port=9222?'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id
  pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
})
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

if (pre) {
  const r = await send('Runtime.evaluate', { expression: pre, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) console.error('pre-script threw:', JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  await sleep(1400)   // let React commit + artwork paint
}

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (!shot.result?.data) { console.error('capture failed:', JSON.stringify(shot).slice(0, 300)); process.exit(1) }
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log(`wrote ${out}`)
ws.close()

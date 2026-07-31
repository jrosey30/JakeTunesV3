#!/usr/bin/env node
// ============================================================================
// cdp-app.mjs — evaluate JS in the JakeTunes APP window specifically.
// ============================================================================
//
// WHY THIS EXISTS (2026-07-28)
//   cdp-eval.mjs takes the FIRST page target. That was fine until the Bandcamp
//   store opened a webview — then "the first page" became a bandcamp.com tab,
//   window.electronAPI was undefined, the sidebar had zero items, and it looked
//   like the app was broken. It wasn't; I was inspecting the wrong window.
//
//   This picks the target by title, and FAILS LOUDLY if it can't find it rather
//   than silently inspecting whatever happened to be first.
//
// USAGE
//   node "Dr. Claude/scripts/cdp-app.mjs" '<expression>'
//   node "Dr. Claude/scripts/cdp-app.mjs" '<expression>' --world=isolated
//
//   --world=isolated runs in the PRELOAD's context, where window.electronAPI
//   lives. Without it you get the main world, which cannot see the IPC bridge
//   under contextIsolation.
import { setTimeout as sleep } from 'node:timers/promises'

const expr = process.argv[2]
const isolated = process.argv.includes('--world=isolated')
if (!expr) { console.error('usage: cdp-app.mjs <expression> [--world=isolated]'); process.exit(2) }

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find((t) => t.type === 'page' && /JakeTunes/i.test(t.title || ''))
if (!page) {
  console.error('No JakeTunes app window found. Pages seen:')
  for (const t of targets.filter((t) => t.type === 'page')) console.error(`  - ${t.title}`)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id
  pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
})
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let ctxId
if (isolated) {
  // Make our own isolated world on the main frame, then reach the bridge from
  // there. (Electron's preload world isn't directly addressable by name.)
  await send('Page.enable')
  const { result: tree } = await send('Page.getFrameTree')
  const frameId = tree.frameTree.frame.id
  const r = await send('Page.createIsolatedWorld', { frameId, worldName: 'cdp-app', grantUniveralAccess: true })
  ctxId = r.result?.executionContextId
}

const r = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  ...(ctxId ? { contextId: ctxId } : {}),
})
if (r.result?.exceptionDetails) {
  console.error('Page exception:', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails))
  process.exit(1)
}
console.log(JSON.stringify(r.result?.result?.value, null, 2))
ws.close()

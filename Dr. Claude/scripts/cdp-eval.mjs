#!/usr/bin/env node
// ============================================================================
// cdp-eval.mjs — evaluate JavaScript inside a running Electron renderer
// ============================================================================
//
// WHAT THIS IS
//   A ~30-line CDP (Chrome DevTools Protocol) client that runs a JS expression
//   inside JakeTunes' renderer process and prints the JSON result. It uses
//   Node's built-in `WebSocket` global (Node 21+), so there are NO npm
//   dependencies — it works from a bare checkout.
//
//   Born out of Briefs 033c + 033d, where runtime verification needed to read
//   real DOM/app state (heartbeat-log buffer, modal button counts) instead of
//   eyeballing screenshots. Persisted here so the next CDP-driven verification
//   is cheap to set up rather than re-derived each time.
//
// THE END-TO-END VERIFICATION PATTERN (this is the reusable skill)
//
//   1. Launch the app with the remote-debugging port open:
//
//        open -a /Applications/JakeTunes.app --args --remote-debugging-port=9222
//        # wait a few seconds for the window to come up
//
//   2. (optional) Confirm the target is reachable:
//
//        curl -s http://127.0.0.1:9222/json | grep webSocketDebuggerUrl
//
//   3. Read app state / inspect the DOM by evaluating an expression:
//
//        node "Dr. Claude/scripts/cdp-eval.mjs" \
//          "(() => Array.from(document.querySelectorAll('.confirm-btn')).map(b => b.textContent.trim()))()"
//
//      The expression must be a single JS expression that returns a
//      JSON-serializable value. Wrap multi-statement logic in an IIFE:
//      "(() => { ...; return result; })()".  awaitPromise is on, so you can
//      return a Promise and it'll be awaited.
//
//   4. Drive native macOS menus (which CDP cannot reach — they live in the
//      main process menu bar) with AppleScript / System Events, THEN inspect
//      the result with this script. Example: trigger File → Library → Refresh
//      File Sizes…, then read the resulting modal:
//
//        osascript <<'OSA'
//        tell application "JakeTunes" to activate
//        delay 0.4
//        tell application "System Events" to tell process "JakeTunes"
//          click menu item "Refresh File Sizes…" of menu "Library" \
//            of menu item "Library" of menu "File" of menu bar item "File" \
//            of menu bar 1
//        end tell
//        OSA
//        node "Dr. Claude/scripts/cdp-eval.mjs" \
//          "(() => document.querySelectorAll('.confirm-btn').length)()"
//
//      Discover the real menu nesting first — don't assume it:
//        osascript -e 'tell application "System Events" to tell process "JakeTunes" to get name of menus of menu bar 1'
//
//   5. Click in-app (non-native) buttons by dispatching DOM events through
//      this same script — React listens at the root, so a bubbling native
//      event triggers its handlers:
//
//        node "Dr. Claude/scripts/cdp-eval.mjs" \
//          "(() => { document.querySelector('.songs-row').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 'ok'; })()"
//
//   6. Synthetic keyboard / overlay dismissal works too:
//        window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))
//
//   CLEANUP: kill the debug instance and relaunch normally when done:
//        pgrep -f "remote-debugging-port=9222" | xargs -r kill
//        open -a /Applications/JakeTunes.app
//
// WHY THIS BEATS SCREENSHOTS
//   Removes human-in-the-loop ambiguity from UI-state verification. Button
//   counts, label text, log-buffer contents, and playback position come back
//   as exact JSON, not pixels to interpret.
//
// USAGE
//   node cdp-eval.mjs '<expression>'  [port]
//   PORT defaults to 9222; override with the 2nd arg or CDP_PORT env var.
//
// EXIT CODES: 0 ok · 1 usage/connection error · 2 JS exception in the page
// ============================================================================

const expr = process.argv[2]
if (!expr) {
  console.error('usage: node cdp-eval.mjs "<js expression>" [port]')
  process.exit(1)
}
const port = process.argv[3] || process.env.CDP_PORT || '9222'
const base = `http://127.0.0.1:${port}`

// Fail fast with a clear message if the debug port isn't open.
let targets
try {
  targets = await (await fetch(`${base}/json`)).json()
} catch {
  console.error(`Cannot reach ${base}/json — is the app running with --remote-debugging-port=${port}?`)
  process.exit(1)
}
const page = targets.find(t => t.type === 'page')
if (!page) { console.error('No page target found.'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params) => new Promise((resolve) => {
  const msgId = ++id
  pending.set(msgId, resolve)
  ws.send(JSON.stringify({ id: msgId, method, params }))
})

// Hard timeout so a hung target can't wedge a verification run.
const timeout = setTimeout(() => { console.error('Timed out after 15s.'); process.exit(1) }, 15000)

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
ws.addEventListener('error', (e) => { console.error('WS error:', e.message || String(e)); process.exit(1) })
await new Promise((res) => ws.addEventListener('open', res))

await send('Runtime.enable', {})
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
clearTimeout(timeout)

if (r.result?.exceptionDetails) {
  console.error('Page exception:', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails, null, 2))
  ws.close()
  process.exit(2)
}
console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2))
ws.close()

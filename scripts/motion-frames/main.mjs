// The page-move frame test (Electron main). Run it with `npm run test:frames`
// (scripts/motion-frames/run.mjs finds Electron and starts this).
//
// It opens one invisible window on the app's real stylesheets
// (page.html), mounts a heavy page the way the app does, and measures every
// frame of the page's move with requestAnimationFrame (page.js). The rule from
// the V7 plan: no animation may drop a frame. It fails when:
//   - any trial drops a frame during the move (a gap over 1.5 refresh intervals),
//   - the page has no move at all, or the move isn't the normal speed,
//   - with Reduce Motion on, anything still moves.
// The first frame after the mount (building the page) is reported, not judged.
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const TRIALS = Number(process.env.JT_FRAME_TRIALS || 8)
const motionTs = readFileSync(join(here, '../../src/renderer/motion.ts'), 'utf-8')
const NORMAL_MS = Number(/normal:\s*(\d+)/.exec(motionTs)?.[1])

app.commandLine.appendSwitch('disable-renderer-backgrounding')

async function trials(win, opts, n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(await win.webContents.executeJavaScript(`measurePageMove(${JSON.stringify(opts)})`))
  return out
}

app.whenReady().then(async () => {
  let code = 0
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false, opacity: 0, focusable: false, skipTaskbar: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true },
  })
  try {
    await win.loadFile(join(here, 'page.html'))
    win.showInactive() // composited (rAF runs at the display's rate) but invisible and never focused
    await win.webContents.executeJavaScript(`document.documentElement.dataset.motionLock = '1'; document.documentElement.dataset.motion = 'full'`)
    await trials(win, { direction: 'forward' }, 2) // warm-up: fonts, styles, GPU
    // Forward slides the new page in from the right; back slides the page
    // you leave out to the right (pageSlide.ts, motion.css).
    const DIRECTIONS = ['forward', 'back']
    const results = {}
    for (const dir of DIRECTIONS) results[dir] = await trials(win, { direction: dir }, TRIALS)
    await win.webContents.executeJavaScript(`document.documentElement.dataset.motion = 'reduce'`)
    results.reduceMotion = await trials(win, { direction: 'forward' }, 3)

    const problems = []
    for (const dir of DIRECTIONS) {
      for (const [i, r] of results[dir].entries()) {
        if (r.animations < 1) problems.push(`${dir} #${i + 1}: the page did not move at all`)
        else if (Math.abs(r.longestAnimationMs - NORMAL_MS) > 1) problems.push(`${dir} #${i + 1}: the move took ${r.longestAnimationMs} ms, not the normal speed (${NORMAL_MS} ms)`)
        if (r.dropped > 0) problems.push(`${dir} #${i + 1}: dropped ${r.dropped} frame(s); worst gap ${r.worstGapMs} ms at ${r.vsyncMs} ms a frame`)
      }
    }
    for (const [i, r] of results.reduceMotion.entries()) {
      if (r.longestAnimationMs > 1) problems.push(`Reduce Motion #${i + 1}: still moving for ${r.longestAnimationMs} ms`)
    }
    const sum = (rs) => ({
      trials: rs.length,
      refreshMs: rs[0]?.vsyncMs,
      moveMs: rs.map((r) => r.longestAnimationMs)[0],
      framesInMove: rs.map((r) => r.moveFrames),
      worstGapMs: Math.max(...rs.map((r) => r.worstGapMs)),
      dropped: rs.reduce((a, r) => a + r.dropped, 0),
      firstFrameMs: rs.map((r) => r.firstFrameMs),
      longFramesMs: rs.flatMap((r) => r.longFramesMs),
    })
    const report = {}
    for (const k of Object.keys(results)) report[k] = sum(results[k])
    console.log(JSON.stringify(report, null, 2))
    if (problems.length) {
      console.error('FAIL — the page move:\n  ' + problems.join('\n  '))
      code = 1
    } else {
      console.log(`PASS — ${TRIALS * DIRECTIONS.length} page moves, no dropped frame; Reduce Motion holds still.`)
    }
  } catch (e) {
    console.error('frame test error:', e)
    code = 2
  }
  win.destroy()
  app.exit(code)
})

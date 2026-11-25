/* The frame meter (runs in the page). window.measurePageMove(opts) mounts a
   new page the way the app does (main-content-view's child is replaced, as a
   new React key would), records every animation frame until the page's move
   has finished, and reports the gaps between frames.

   A dropped frame is a gap of more than 1.5 refresh intervals; the refresh
   interval is measured on the idle page first. The first frame after the
   mount carries building the page itself (what React would render), so it is
   reported apart from the move. */
'use strict'

const raf = () => new Promise((r) => requestAnimationFrame(r))

function buildPage(seed) {
  const page = document.createElement('div')
  page.className = 'fx-page'
  const head = document.createElement('div')
  head.className = 'fx-head'
  head.textContent = `Albums ${seed}`
  page.appendChild(head)
  const grid = document.createElement('div')
  grid.className = 'fx-grid'
  for (let i = 0; i < 48; i++) {
    const card = document.createElement('div')
    card.className = 'fx-card'
    const art = document.createElement('div')
    art.className = 'fx-art'
    const h = (i * 37 + seed * 11) % 360
    art.style.background = `linear-gradient(135deg, hsl(${h} 60% 55%), hsl(${(h + 40) % 360} 55% 35%))`
    const t = document.createElement('div')
    t.className = 'fx-t'
    t.textContent = `An Album Title Number ${i}`
    const s = document.createElement('div')
    s.className = 'fx-s'
    s.textContent = `Artist ${i}`
    card.append(art, t, s)
    grid.appendChild(card)
  }
  page.appendChild(grid)
  const table = document.createElement('div')
  table.className = 'fx-table'
  for (let i = 0; i < 120; i++) {
    const row = document.createElement('div')
    row.className = 'fx-row'
    for (const text of [String(i + 1), `Song title ${i}`, `Artist ${i % 17}`, `Album ${i % 23}`, '3:41']) {
      const c = document.createElement('span')
      c.textContent = text
      row.appendChild(c)
    }
    table.appendChild(row)
  }
  page.appendChild(table)
  return page
}

async function refreshInterval() {
  const ts = []
  for (let i = 0; i < 61; i++) ts.push(await raf())
  const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

let seed = 0
window.measurePageMove = async function measurePageMove({ direction = 'forward' } = {}) {
  const view = document.getElementById('view')
  const vsync = await refreshInterval()
  const page = buildPage(++seed)
  const stamps = []
  let recording = true
  const loafs = []
  let po = null
  try {
    po = new PerformanceObserver((list) => { for (const e of list.getEntries()) loafs.push(Math.round(e.duration)) })
    po.observe({ type: 'long-animation-frame', buffered: false })
  } catch { /* not in this Chromium */ }
  const tick = (t) => { stamps.push(t); if (recording) requestAnimationFrame(tick) }
  await raf()
  requestAnimationFrame(tick)
  await raf()
  const t0 = performance.now()
  // The app's mount: the keyed child is replaced. A back move is marked the
  // way MainContent marks it (data-nav="return" on the view).
  const mount = (slid) => {
    if (direction === 'back') view.dataset.nav = 'return'
    else delete view.dataset.nav
    if (slid) view.dataset.slide = ''
    else delete view.dataset.slide
    view.replaceChildren(page)
  }
  const root = document.documentElement
  let vt = null
  if (typeof document.startViewTransition === 'function' && root.dataset.motion !== 'reduce') {
    // What pageSlide.ts runPageSlide does: the classes, then the swap inside
    // a View Transition (the CSS that moves the pages is the app's own).
    const kind = direction === 'back' ? 'out' : 'in'
    root.classList.add('jt-page-vt', `jt-page-vt--${kind}`)
    vt = document.startViewTransition(() => mount(true))
    await vt.ready.catch(() => {})
  } else {
    mount(false)
  }
  // Let the move start, then wait for every animation on the page to end.
  await raf()
  if (window.__midShot) await window.__midShot()
  await raf()
  const anims = document.getAnimations()
  const durations = anims.map((a) => Number(a.effect?.getComputedTiming().duration) || 0)
  await Promise.all(anims.map((a) => a.finished.catch(() => {})))
  if (vt) await vt.finished.catch(() => {})
  root.classList.remove('jt-page-vt', 'jt-page-vt--in', 'jt-page-vt--out')
  const tEnd = performance.now()
  await raf(); await raf()
  recording = false
  po?.disconnect()
  // gaps between consecutive frames from the mount on
  const after = stamps.filter((t) => t >= t0 - vsync)
  const gaps = after.slice(1).map((t, i) => t - after[i])
  const commit = gaps[0] ?? 0
  const move = gaps.slice(1).filter((_, i) => after[i + 1] <= tEnd + vsync)
  const dropped = move.filter((g) => g > vsync * 1.5).length
  return {
    vsyncMs: +vsync.toFixed(2),
    animations: anims.length,
    longestAnimationMs: Math.max(0, ...durations),
    moveMs: +(tEnd - t0).toFixed(1),
    firstFrameMs: +commit.toFixed(1),
    moveFrames: move.length,
    worstGapMs: +Math.max(0, ...move).toFixed(1),
    dropped,
    longFramesMs: loafs,
  }
}

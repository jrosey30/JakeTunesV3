/**
 * Opt-in master-output stereo-width enhancer (4.5 audio pass).
 *
 * Normal playback is html5:false (Web Audio), which BYPASSES the EQ chain — so
 * the only place to add processing that affects what you actually hear is
 * Howler's MASTER output. This splices a mid/side width matrix between
 * Howler.masterGain and ctx.destination:
 *
 *   masterGain → input → splitter ┬ L →[a]┐                 ┌→ merger.0
 *                                 │    [b]┴→ lSum ──────────┘
 *                                 └ R →[b]┐                 ┌→ merger.1 → destination
 *                                      [a]┴→ rSum ──────────┘
 *
 *   L_out = a·L + b·R,  R_out = b·L + a·R,  with a = (1+w)/2, b = (1-w)/2.
 *
 * At w = 1 it is mathematically transparent (a=1, b=0). Mono content (L=R) is
 * unchanged at ANY width — the center image (lead vocal, kick, bass) stays put;
 * only panned/stereo content (backing vocals, guitars, cymbals, room) widens.
 *
 * OFF by default. setStereoWidth(1.0) fully removes the insert and restores
 * Howler's direct master→destination wiring, so "off" === untouched playback.
 *
 * Does NOT pre-create or assign Howler.ctx (the 4.5.0-52 playback-killing
 * landmine) — it only READS Howler's existing ctx + masterGain and splices
 * nodes into the live graph, exactly as eq.ts does for its analyser tap.
 */
import { Howler } from 'howler'

let ctx: AudioContext | null = null
let input: GainNode | null = null
let splitter: ChannelSplitterNode | null = null
let merger: ChannelMergerNode | null = null
let lSum: GainNode | null = null
let rSum: GainNode | null = null
let gLL: GainNode | null = null
let gRL: GainNode | null = null
let gLR: GainNode | null = null
let gRR: GainNode | null = null
let inserted = false
let currentWidth = 1.0
let retryTimer: ReturnType<typeof setTimeout> | null = null

const MAX_WIDTH = 1.8

function howlerCtx(): AudioContext | null {
  return (Howler as unknown as { ctx?: AudioContext }).ctx ?? null
}
function howlerMaster(): GainNode | null {
  return (Howler as unknown as { masterGain?: GainNode }).masterGain ?? null
}

function buildGraph(c: AudioContext): void {
  if (input) return // already built; never torn down, only (dis)connected at the ends
  input = c.createGain(); input.gain.value = 1.0
  splitter = c.createChannelSplitter(2)
  merger = c.createChannelMerger(2)
  lSum = c.createGain(); lSum.gain.value = 1.0
  rSum = c.createGain(); rSum.gain.value = 1.0
  gLL = c.createGain(); gRL = c.createGain(); gLR = c.createGain(); gRR = c.createGain()
  input.connect(splitter)
  splitter.connect(gLL, 0); gLL.connect(lSum)  // a·L ┐
  splitter.connect(gRL, 1); gRL.connect(lSum)  // b·R ┴→ L_out
  splitter.connect(gLR, 0); gLR.connect(rSum)  // b·L ┐
  splitter.connect(gRR, 1); gRR.connect(rSum)  // a·R ┴→ R_out
  lSum.connect(merger, 0, 0)
  rSum.connect(merger, 0, 1)
  applyWidth(currentWidth)
}

function applyWidth(w: number): void {
  const a = (1 + w) / 2, b = (1 - w) / 2
  if (gLL) gLL.gain.value = a
  if (gRL) gRL.gain.value = b
  if (gLR) gLR.gain.value = b
  if (gRR) gRR.gain.value = a
}

function insert(): boolean {
  if (inserted) return true
  const c = howlerCtx(), master = howlerMaster()
  if (!c || !master) return false
  ctx = c
  buildGraph(c)
  if (!input || !merger) return false
  try { master.disconnect(c.destination) } catch { /* wasn't directly connected */ }
  master.connect(input)
  merger.connect(c.destination)
  inserted = true
  if (c.state === 'suspended') void c.resume()
  return true
}

function bypass(): void {
  if (!inserted) return
  const c = ctx, master = howlerMaster()
  if (c && master && input && merger) {
    try { master.disconnect(input) } catch { /* ignore */ }
    try { merger.disconnect(c.destination) } catch { /* ignore */ }
    try { master.connect(c.destination) } catch { /* ignore */ } // restore direct wiring
  }
  inserted = false
}

/** Set the stereo width. 1.0 (or less) = OFF (transparent; insert removed and
 *  Howler's direct wiring restored). Up to ~1.8 widens. Safe to call before
 *  Howler's ctx exists — it retries until the first track has played. */
export function setStereoWidth(width: number): void {
  currentWidth = Math.max(1.0, Math.min(MAX_WIDTH, Number(width) || 1.0))
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  if (currentWidth <= 1.001) { bypass(); return }
  if (inserted) { applyWidth(currentWidth); return }
  if (!insert()) {
    // Howler's ctx isn't up yet (no track has played) — retry until it is.
    retryTimer = setTimeout(() => { retryTimer = null; setStereoWidth(currentWidth) }, 600)
    return
  }
  applyWidth(currentWidth)
}

export function getStereoWidth(): number {
  return currentWidth
}

// Dev escape hatch, mirrors eq.ts's window.__resetAudio.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__resetStereoWidth = () => setStereoWidth(1.0)
}

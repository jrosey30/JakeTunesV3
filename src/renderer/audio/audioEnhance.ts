/**
 * Master-output enhancement chain (4.5 audio pass; band-split 2026-08-06).
 *
 * Normal playback is html5:false (Web Audio), which BYPASSES the EQ chain — so
 * the only place to add processing that affects what you actually hear is
 * Howler's MASTER output. This splices between Howler.masterGain and
 * ctx.destination:
 *
 *   masterGain → input ┬ LOW  (LR4 lowpass @250)   → M/S width (default MONO)┐
 *                      ├ MID  (LR4 250–5k bandpass) → M/S width (modest)      ├→ sum → [crossfeed] → destination
 *                      └ HIGH (LR4 highpass @5k)    → M/S width (aggressive) ┘
 *
 * WHY BANDS (replacing the broadband matrix that lived here before): widening
 * everything at once forces one compromise number. Bass side-content just
 * makes the low end unstable (and breaks vinyl/club mono compatibility), the
 * 250Hz–5k band holds the lead vocal and body and only wants a nudge, and the
 * air above 5k — cymbals, room tails — is where width actually reads as
 * spaciousness and can take real pushing. Three numbers, each honest for its
 * register: push harder, sounds tighter not hollower.
 *
 * Crossovers are Linkwitz-Riley 4th-order (two cascaded Q=1/√2 biquads per
 * side) at 250 Hz and 5 kHz — LR4 bands sum flat, so with every band at
 * width 1.0 the chain is audibly transparent.
 *
 * Per band: L' = a·L + b·R, R' = b·L + a·R with a=(1+w)/2, b=(1-w)/2.
 * w=1 transparent · w=0 full mono (a=b=½) · w>1 wider. Mono content is
 * unchanged at ANY width — the center image stays put.
 *
 * CROSSFEED (separate toggle; for headphones): each ear also hears a little
 * of the other channel, low-passed at 700 Hz and delayed ~260 µs — the Bauer
 * bs2b model of what a head does to sound arriving from a speaker on the
 * other side. Hard-panned '60s/'70s mixes stop ping-ponging. Output is
 * renormalized by 1/(1+feed) so engaging it never clips.
 *
 * CORRELATION METER: L/R Pearson correlation measured post-chain (or on the
 * untouched master when bypassed). +1 mono-ish · 0 decorrelated · negative =
 * phase trouble. Read via getCorrelation() at ~10 Hz from the UI.
 *
 * OFF means OFF: with width disabled and crossfeed disabled the insert is
 * removed and Howler's direct master→destination wiring restored.
 *
 * Does NOT pre-create or assign Howler.ctx (the 4.5.0-52 playback-killing
 * landmine) — it only READS Howler's existing ctx + masterGain and splices
 * nodes into the live graph, exactly as eq.ts does for its analyser tap.
 */
import { Howler } from 'howler'

export interface EnhanceConfig {
  widthOn: boolean
  /** 0 = hard mono (default), 1 = natural. Below 250 Hz. */
  widthLow: number
  /** 1 = natural; up to ~1.5. 250 Hz – 5 kHz: lead vocal + body. */
  widthMid: number
  /** 1 = natural; up to ~2.2. Above 5 kHz: cymbals, air, room. */
  widthHigh: number
  crossfeedOn: boolean
  /** 0..1 scaling of the standard bs2b feed (700 Hz / −4.5 dB). */
  crossfeedAmount: number
}

export const ENHANCE_DEFAULTS: EnhanceConfig = {
  widthOn: false,
  widthLow: 0.0,
  widthMid: 1.15,
  widthHigh: 1.6,
  crossfeedOn: false,
  crossfeedAmount: 1.0,
}

const XOVER_LOW_HZ = 250
const XOVER_HIGH_HZ = 5000
const LR_Q = Math.SQRT1_2          // two cascaded Butterworths = LR4
const CF_LOWPASS_HZ = 700
const CF_DELAY_S = 0.00026         // ~260 µs interaural delay
const CF_FEED_LINEAR = Math.pow(10, -4.5 / 20)   // bs2b default feed level

let ctx: AudioContext | null = null
let inserted = false
let cfg: EnhanceConfig = { ...ENHANCE_DEFAULTS }
let retryTimer: ReturnType<typeof setTimeout> | null = null

// chain nodes
let input: GainNode | null = null
let sumL: GainNode | null = null
let sumR: GainNode | null = null
let merger: ChannelMergerNode | null = null
interface Band { filters: BiquadFilterNode[]; splitter: ChannelSplitterNode; gLL: GainNode; gRL: GainNode; gLR: GainNode; gRR: GainNode }
let bands: { low: Band; mid: Band; high: Band } | null = null

// crossfeed nodes (after the width sum)
let cfSplitter: ChannelSplitterNode | null = null
let cfDirectL: GainNode | null = null
let cfDirectR: GainNode | null = null
let cfFeedL: GainNode | null = null       // R→L feed amount
let cfFeedR: GainNode | null = null       // L→R feed amount
let cfLpL: BiquadFilterNode | null = null
let cfLpR: BiquadFilterNode | null = null
let cfDelayL: DelayNode | null = null
let cfDelayR: DelayNode | null = null
let cfSumL: GainNode | null = null
let cfSumR: GainNode | null = null
let cfMerger: ChannelMergerNode | null = null

// correlation tap
let corrSplitter: ChannelSplitterNode | null = null
let corrL: AnalyserNode | null = null
let corrR: AnalyserNode | null = null
let corrTapNode: AudioNode | null = null
let corrBufL: Float32Array | null = null
let corrBufR: Float32Array | null = null

function howlerCtx(): AudioContext | null {
  return (Howler as unknown as { ctx?: AudioContext }).ctx ?? null
}
function howlerMaster(): GainNode | null {
  return (Howler as unknown as { masterGain?: GainNode }).masterGain ?? null
}

function makeBand(c: AudioContext, kind: 'low' | 'mid' | 'high'): Band {
  const filters: BiquadFilterNode[] = []
  const add = (type: BiquadFilterType, freq: number) => {
    const f = c.createBiquadFilter()
    f.type = type; f.frequency.value = freq; f.Q.value = LR_Q
    filters.push(f)
  }
  if (kind === 'low') { add('lowpass', XOVER_LOW_HZ); add('lowpass', XOVER_LOW_HZ) }
  if (kind === 'mid') { add('highpass', XOVER_LOW_HZ); add('highpass', XOVER_LOW_HZ); add('lowpass', XOVER_HIGH_HZ); add('lowpass', XOVER_HIGH_HZ) }
  if (kind === 'high') { add('highpass', XOVER_HIGH_HZ); add('highpass', XOVER_HIGH_HZ) }
  for (let i = 1; i < filters.length; i++) filters[i - 1].connect(filters[i])
  const splitter = c.createChannelSplitter(2)
  filters[filters.length - 1].connect(splitter)
  const gLL = c.createGain(), gRL = c.createGain(), gLR = c.createGain(), gRR = c.createGain()
  splitter.connect(gLL, 0)   // a·L → L
  splitter.connect(gRL, 1)   // b·R → L
  splitter.connect(gLR, 0)   // b·L → R
  splitter.connect(gRR, 1)   // a·R → R
  return { filters, splitter, gLL, gRL, gLR, gRR }
}

function applyBandWidth(b: Band, w: number): void {
  const a = (1 + w) / 2, bb = (1 - w) / 2
  b.gLL.gain.value = a; b.gRL.gain.value = bb
  b.gLR.gain.value = bb; b.gRR.gain.value = a
}

function buildGraph(c: AudioContext): void {
  if (input) return   // built once; only (dis)connected at the ends
  input = c.createGain()
  sumL = c.createGain(); sumR = c.createGain()
  merger = c.createChannelMerger(2)
  bands = { low: makeBand(c, 'low'), mid: makeBand(c, 'mid'), high: makeBand(c, 'high') }
  for (const b of [bands.low, bands.mid, bands.high]) {
    input.connect(b.filters[0])
    b.gLL.connect(sumL); b.gRL.connect(sumL)
    b.gLR.connect(sumR); b.gRR.connect(sumR)
  }
  sumL.connect(merger, 0, 0)
  sumR.connect(merger, 0, 1)

  // Crossfeed stage (built once; feed gains at 0 = transparent).
  cfSplitter = c.createChannelSplitter(2)
  merger.connect(cfSplitter)
  cfDirectL = c.createGain(); cfDirectR = c.createGain()
  cfFeedL = c.createGain(); cfFeedR = c.createGain()
  cfLpL = c.createBiquadFilter(); cfLpL.type = 'lowpass'; cfLpL.frequency.value = CF_LOWPASS_HZ; cfLpL.Q.value = LR_Q
  cfLpR = c.createBiquadFilter(); cfLpR.type = 'lowpass'; cfLpR.frequency.value = CF_LOWPASS_HZ; cfLpR.Q.value = LR_Q
  cfDelayL = c.createDelay(0.005); cfDelayL.delayTime.value = CF_DELAY_S
  cfDelayR = c.createDelay(0.005); cfDelayR.delayTime.value = CF_DELAY_S
  cfSumL = c.createGain(); cfSumR = c.createGain()
  cfMerger = c.createChannelMerger(2)
  cfSplitter.connect(cfDirectL, 0); cfDirectL.connect(cfSumL)
  cfSplitter.connect(cfDirectR, 1); cfDirectR.connect(cfSumR)
  // opposite-ear feeds: R → (lowpass → delay → gain) → L, and mirrored
  cfSplitter.connect(cfLpL, 1); cfLpL.connect(cfDelayL); cfDelayL.connect(cfFeedL); cfFeedL.connect(cfSumL)
  cfSplitter.connect(cfLpR, 0); cfLpR.connect(cfDelayR); cfDelayR.connect(cfFeedR); cfFeedR.connect(cfSumR)
  cfSumL.connect(cfMerger, 0, 0)
  cfSumR.connect(cfMerger, 0, 1)

  applyConfig()
}

function applyConfig(): void {
  if (!bands) return
  applyBandWidth(bands.low, cfg.widthOn ? clamp(cfg.widthLow, 0, 1.2) : 1)
  applyBandWidth(bands.mid, cfg.widthOn ? clamp(cfg.widthMid, 0, 1.5) : 1)
  applyBandWidth(bands.high, cfg.widthOn ? clamp(cfg.widthHigh, 0, 2.2) : 1)
  const feed = cfg.crossfeedOn ? CF_FEED_LINEAR * clamp(cfg.crossfeedAmount, 0, 1) : 0
  // Renormalize so mono content (which receives direct + feed) stays at
  // unity — engaging crossfeed must never push the master into clipping.
  const norm = 1 / (1 + feed)
  if (cfFeedL && cfFeedR && cfDirectL && cfDirectR && cfSumL && cfSumR) {
    cfFeedL.gain.value = feed; cfFeedR.gain.value = feed
    cfSumL.gain.value = norm; cfSumR.gain.value = norm
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number(v) || 0))
}

function attachCorrelation(c: AudioContext, tap: AudioNode): void {
  if (!corrSplitter) {
    corrSplitter = c.createChannelSplitter(2)
    corrL = c.createAnalyser(); corrL.fftSize = 2048
    corrR = c.createAnalyser(); corrR.fftSize = 2048
    corrSplitter.connect(corrL, 0)
    corrSplitter.connect(corrR, 1)
    corrBufL = new Float32Array(corrL.fftSize)
    corrBufR = new Float32Array(corrR.fftSize)
  }
  if (corrTapNode === tap) return
  if (corrTapNode) { try { corrTapNode.disconnect(corrSplitter) } catch { /* moved */ } }
  tap.connect(corrSplitter)
  corrTapNode = tap
}

function insert(): boolean {
  if (inserted) return true
  const c = howlerCtx(), master = howlerMaster()
  if (!c || !master) return false
  ctx = c
  buildGraph(c)
  if (!input || !cfMerger) return false
  try { master.disconnect(c.destination) } catch { /* wasn't directly connected */ }
  master.connect(input)
  cfMerger.connect(c.destination)
  inserted = true
  attachCorrelation(c, cfMerger)
  if (c.state === 'suspended') void c.resume()
  console.log('[audioEnhance] chain spliced into the master path')
  return true
}

function bypass(): void {
  if (!inserted) return
  const c = ctx, master = howlerMaster()
  if (c && master && input && cfMerger) {
    try { master.disconnect(input) } catch { /* ignore */ }
    try { cfMerger.disconnect(c.destination) } catch { /* ignore */ }
    try { master.connect(c.destination) } catch { /* ignore */ } // restore direct wiring
    attachCorrelation(c, master)   // the meter keeps reading the untouched master
  }
  inserted = false
}

/** Apply the full enhancement config. Both off → true bypass.
 *
 * 2026-08-06 hardening: the boot-time call arrives before Howler's ctx
 * reliably exists, and the original one-shot retry could die silently — an
 * exception anywhere in the attempt killed the chain with no rearm and no
 * log, leaving the whole panel as placebo (found live: music playing, meter
 * pinned at 1.00 = tap hearing silence). Now: every attempt is exception-
 * proof, failure keeps a persistent retry alive until the splice actually
 * lands, and both outcomes log to the main-stdout capture. */
export function setEnhanceConfig(next: Partial<EnhanceConfig>): void {
  cfg = { ...cfg, ...next }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  const wantInsert = cfg.widthOn || cfg.crossfeedOn
  if (!wantInsert) {
    try { bypass() } catch (e) { console.warn('[audioEnhance] bypass failed:', e) }
    return
  }
  let ok = false
  try { ok = insert() } catch (e) { console.warn('[audioEnhance] insert threw:', e) }
  if (!ok) {
    retryTimer = setTimeout(() => { retryTimer = null; setEnhanceConfig({}) }, 600)
    return
  }
  try { applyConfig() } catch (e) { console.warn('[audioEnhance] applyConfig failed:', e) }
}

export function getEnhanceConfig(): EnhanceConfig {
  return { ...cfg }
}

/**
 * L/R Pearson correlation of what is actually playing, −1..+1.
 * Above 0.5 safe · 0.3–0.5 getting wide · below 0.3 mono compatibility is
 * broken. NaN-safe: silence returns +1 (nothing to disagree about).
 */
export function getCorrelation(): number {
  if (!corrL || !corrR || !corrBufL || !corrBufR) {
    // No tap yet — try attaching to whatever exists so the meter works even
    // before the user enables any processing.
    const c = howlerCtx(), master = howlerMaster()
    if (c && master) attachCorrelation(c, inserted && cfMerger ? cfMerger : master)
    if (!corrL || !corrR || !corrBufL || !corrBufR) return 1
  }
  corrL.getFloatTimeDomainData(corrBufL as Float32Array<ArrayBuffer>)
  corrR.getFloatTimeDomainData(corrBufR as Float32Array<ArrayBuffer>)
  let sl = 0, sr = 0
  const n = corrBufL.length
  for (let i = 0; i < n; i++) { sl += corrBufL[i]; sr += corrBufR[i] }
  const ml = sl / n, mr = sr / n
  let num = 0, dl = 0, dr = 0
  for (let i = 0; i < n; i++) {
    const a = corrBufL[i] - ml, b = corrBufR[i] - mr
    num += a * b; dl += a * a; dr += b * b
  }
  const den = Math.sqrt(dl * dr)
  if (den < 1e-9) return 1
  return num / den
}

/** Legacy shim: the old broadband control. Maps onto the band config so any
 *  stored setting keeps doing something sensible until re-saved. */
export function setStereoWidth(width: number): void {
  const w = Number(width) || 1
  if (w <= 1.001) { setEnhanceConfig({ widthOn: false }); return }
  setEnhanceConfig({
    widthOn: true,
    widthLow: ENHANCE_DEFAULTS.widthLow,
    widthMid: Math.min(1.5, 1 + (w - 1) * 0.5),
    widthHigh: Math.min(2.2, w * 1.05),
  })
}

export function getStereoWidth(): number {
  return cfg.widthOn ? cfg.widthHigh : 1
}

// Dev escape hatch, mirrors eq.ts's window.__resetAudio.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__resetStereoWidth = () => setEnhanceConfig({ widthOn: false, crossfeedOn: false })
}

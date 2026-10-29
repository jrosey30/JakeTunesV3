/**
 * Friend share card — drawn on a canvas (2026-10-29). The desktop twin of the
 * phone's iPod story card (JakeTunesMobile ShareCard.swift): the song on an
 * iPod classic's screen in Chicago, the click wheel below (story only), and
 * the footer with the JakeTunes wordmark, the signature line and a QR for the
 * share link. Sizes and text rules: common/friend-share-card.ts.
 */
import qrcode from 'qrcode-generator'
import chicagoUrl from '../assets/fonts/pixChicago.ttf?url'
import {
  CARD_SIZE, SCREEN_WIDTH, STORY_SAFE, px, titleSize, artistSize, detailSize, counterText, scrubTimes, wrapText,
  type CardFormat,
} from '../../common/friend-share-card'

export interface CardContent {
  title: string
  artist: string
  /** Album (song) or "12 songs · 1997" (album). */
  detail?: string
  /** album-art:// URL, or undefined for the vinyl placeholder. */
  artUrl?: string
  durationMs: number
  counter: { index: number; total: number } | null
  cardLine: string
  /** What the QR opens. */
  link: string | null
}

const ORANGE = '#FD5601'
/** Chicago draws taller than its em box: lines are spaced like the phone's SwiftUI text. */
const LINE = 1.5
const FONT = 'pixChicago'

let fontReady: Promise<void> | null = null
function loadFont(): Promise<void> {
  fontReady ??= (async () => {
    try {
      const face = new FontFace(FONT, `url(${chicagoUrl})`)
      await face.load()
      document.fonts.add(face)
    } catch { /* the system font stands in; the card still draws */ }
  })()
  return fontReady
}

function loadImage(url: string | undefined): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

function font(size: number, weight = 'normal'): string {
  return `${weight} ${size}px ${FONT}, -apple-system, sans-serif`
}

function drawQR(ctx: CanvasRenderingContext2D, link: string, x: number, y: number, size: number): void {
  const qr = qrcode(0, 'M')
  qr.addData(link)
  qr.make()
  const n = qr.getModuleCount()
  const pad = 12
  ctx.fillStyle = '#fff'
  roundRect(ctx, x - pad, y - pad, size + pad * 2, size + pad * 2, 14)
  ctx.fill()
  const cell = size / n
  ctx.fillStyle = '#000'
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.isDark(r, c)) ctx.fillRect(x + c * cell, y + r * cell, Math.ceil(cell), Math.ceil(cell))
  }
}

/** Returns the bottom y of the screen. */
function drawScreen(ctx: CanvasRenderingContext2D, c: CardContent, art: HTMLImageElement | null, x: number, y: number, w: number): number {
  const k = (v: number) => px(v, w)
  const barH = k(62)
  const pad = k(30)
  const artS = k(252)
  const counter = counterText(c.counter)
  const times = scrubTimes(c.durationMs)
  const counterH = counter ? k(20) + k(22) : 0
  const bodyTop = y + barH + counterH + (counter ? k(18) : k(34))
  // Lay the text out first: a long name can make the text taller than the art.
  const tw = w - pad - (pad + artS + k(30))
  const ts = titleSize(c.title, w), as = artistSize(c.artist, w), ds = c.detail ? detailSize(c.detail, w) : 0
  const measureAt = (f: string) => (t: string) => { ctx.font = f; return ctx.measureText(t).width }
  const titleLines = wrapText(c.title, tw, 3, measureAt(font(ts, 'bold')))
  const artistLines = wrapText(c.artist, tw, 2, measureAt(font(as)))
  const detailLines = c.detail ? wrapText(c.detail, tw, 2, measureAt(font(ds))) : []
  const textH = k(10) + titleLines.length * Math.round(ts * LINE) + k(16) - Math.round(ts * 0.25)
    + artistLines.length * Math.round(as * LINE) + (detailLines.length ? k(16) - Math.round(as * 0.25) + detailLines.length * Math.round(ds * LINE) : 0)
  const bodyH = Math.max(artS, textH) + k(34)
  const progH = times ? k(14) + k(12) + k(30) + k(28) : 0
  const h = bodyTop - y + bodyH + progH

  // Body + bezel
  ctx.save()
  roundRect(ctx, x, y, w, h, k(18))
  ctx.clip()
  const g = ctx.createLinearGradient(0, y, 0, y + h)
  g.addColorStop(0, '#f7f7f2'); g.addColorStop(1, '#e0e3de')
  ctx.fillStyle = g
  ctx.fillRect(x, y, w, h)
  // Status bar
  const sb = ctx.createLinearGradient(0, y, 0, y + barH)
  sb.addColorStop(0, '#f0f0f0'); sb.addColorStop(1, '#d6d6d6')
  ctx.fillStyle = sb
  ctx.fillRect(x, y, w, barH)
  ctx.fillStyle = 'rgba(0,0,0,0.18)'
  ctx.fillRect(x, y + barH - 2, w, 2)
  ctx.fillStyle = '#383838'
  ctx.font = font(k(26))
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('Now Playing', x + w / 2, y + barH / 2 + k(4))
  // play triangle + battery
  ctx.fillStyle = '#595959'
  ctx.beginPath()
  ctx.moveTo(x + pad, y + barH / 2 - k(10)); ctx.lineTo(x + pad + k(16), y + barH / 2); ctx.lineTo(x + pad, y + barH / 2 + k(10)); ctx.closePath(); ctx.fill()
  ctx.strokeStyle = '#595959'; ctx.lineWidth = 2
  ctx.strokeRect(x + w - pad - k(40), y + barH / 2 - k(9), k(36), k(18))
  ctx.fillRect(x + w - pad - k(37), y + barH / 2 - k(6), k(30), k(12))
  ctx.fillRect(x + w - pad - k(3), y + barH / 2 - k(4), k(4), k(8))

  ctx.textAlign = 'left'; ctx.textBaseline = 'top'
  if (counter) {
    ctx.fillStyle = '#666'
    ctx.font = font(k(22))
    ctx.fillText(counter, x + pad, y + barH + k(20))
  }

  // Art
  const ax = x + pad
  if (art) {
    ctx.save(); roundRect(ctx, ax, bodyTop, artS, artS, k(6)); ctx.clip()
    const s = Math.min(art.width, art.height)
    ctx.drawImage(art, (art.width - s) / 2, (art.height - s) / 2, s, s, ax, bodyTop, artS, artS)
    ctx.restore()
  } else {
    ctx.fillStyle = '#1c1c1c'; roundRect(ctx, ax, bodyTop, artS, artS, k(6)); ctx.fill()
    ctx.fillStyle = '#2c2c2c'; ctx.beginPath(); ctx.arc(ax + artS / 2, bodyTop + artS / 2, artS * 0.42, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = ORANGE; ctx.beginPath(); ctx.arc(ax + artS / 2, bodyTop + artS / 2, artS * 0.14, 0, Math.PI * 2); ctx.fill()
  }

  // Text, top-aligned beside the art (names never clip: 3 / 2 / 2 lines)
  const tx = ax + artS + k(30)
  let ty = bodyTop + k(10)
  ctx.font = font(ts, 'bold'); ctx.fillStyle = '#141414'
  for (const line of titleLines) { ctx.fillText(line, tx, ty); ty += Math.round(ts * LINE) }
  ty += k(16) - Math.round(ts * 0.25)
  ctx.font = font(as); ctx.fillStyle = '#525252'
  for (const line of artistLines) { ctx.fillText(line, tx, ty); ty += Math.round(as * LINE) }
  if (detailLines.length) {
    ty += k(16) - Math.round(as * 0.25)
    ctx.font = font(ds); ctx.fillStyle = '#7a7a7a'
    for (const line of detailLines) { ctx.fillText(line, tx, ty); ty += Math.round(ds * LINE) }
  }

  // Progress + times
  if (times) {
    const py = bodyTop + bodyH
    const bw = w - pad * 2
    ctx.fillStyle = '#c7c7c7'; roundRect(ctx, x + pad, py, bw, k(14), k(7)); ctx.fill()
    ctx.fillStyle = ORANGE; roundRect(ctx, x + pad, py, bw * 0.37, k(14), k(7)); ctx.fill()
    ctx.font = font(k(24)); ctx.fillStyle = '#595959'
    ctx.fillText(times.elapsed, x + pad, py + k(14) + k(12))
    ctx.textAlign = 'right'; ctx.fillText(times.remaining, x + w - pad, py + k(14) + k(12)); ctx.textAlign = 'left'
  }
  ctx.restore()
  // Bezel
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = k(10)
  roundRect(ctx, x + k(5), y + k(5), w - k(10), h - k(10), k(14)); ctx.stroke()
  return y + h
}

function drawWheel(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
  const u = R / 240
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.30)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 10
  const g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
  g.addColorStop(0, '#f7f7f7'); g.addColorStop(1, '#e0e0e0')
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
  ctx.fillStyle = '#8c8c8c'
  ctx.font = `600 ${Math.round(30 * u)}px -apple-system, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('MENU', cx, cy - 190 * u)
  const tri = (x: number, y: number, dir: 1 | -1) => { ctx.beginPath(); ctx.moveTo(x, y - 12 * u); ctx.lineTo(x + 16 * u * dir, y); ctx.lineTo(x, y + 12 * u); ctx.closePath(); ctx.fill() }
  tri(cx - 182 * u, cy, -1); tri(cx - 198 * u, cy, -1)   // ⏮
  tri(cx + 182 * u, cy, 1); tri(cx + 198 * u, cy, 1)     // ⏭
  tri(cx - 14 * u, cy + 190 * u, 1); ctx.fillRect(cx + 8 * u, cy + 178 * u, 6 * u, 24 * u); ctx.fillRect(cx + 18 * u, cy + 178 * u, 6 * u, 24 * u)  // ⏯
  const c = ctx.createRadialGradient(cx - 20 * u, cy - 25 * u, 10, cx, cy, 110 * u)
  c.addColorStop(0, '#fcfcfc'); c.addColorStop(1, '#e6e6e6')
  ctx.fillStyle = c; ctx.beginPath(); ctx.arc(cx, cy, 95 * u, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 2; ctx.stroke()
}

function drawFooter(ctx: CanvasRenderingContext2D, c: CardContent, W: number, bottom: number, side: number, qrSize: number): void {
  const qrX = W - side - qrSize
  const qrY = bottom - qrSize - 36
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#fff'; ctx.font = font(44, 'bold')
  ctx.letterSpacing = '6px'
  ctx.fillText('JAKETUNES', side, qrY + qrSize / 2 - 4)
  ctx.letterSpacing = '0px'
  ctx.fillStyle = '#9e9e9e'; ctx.font = font(26)
  const maxW = (c.link ? qrX - 40 : W - side) - side
  let y = qrY + qrSize / 2 + 50
  for (const line of wrapText(c.cardLine, maxW, 2, (s) => ctx.measureText(s).width)) { ctx.fillText(line, side, y); y += 38 }
  if (c.link) {
    drawQR(ctx, c.link, qrX, qrY, qrSize)
    ctx.fillStyle = '#8c8c8c'; ctx.font = font(20); ctx.textAlign = 'center'
    ctx.fillText('scan to listen', qrX + qrSize / 2, qrY + qrSize + 42)
  }
}

/** Draw the card; resolves to a PNG data URL. */
export async function renderShareCard(c: CardContent, format: CardFormat): Promise<string> {
  await loadFont()
  const art = await loadImage(c.artUrl)
  const { w: W, h: H } = CARD_SIZE[format]
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')!
  // The room
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, '#212121'); bg.addColorStop(1, '#121212')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)
  const glow = ctx.createRadialGradient(W / 2, H * 0.4, 60, W / 2, H * 0.4, 800)
  glow.addColorStop(0, 'rgba(253,86,1,0.28)'); glow.addColorStop(1, 'rgba(253,86,1,0)')
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H)
  // Eyebrow
  ctx.fillStyle = ORANGE; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.font = font(format === 'story' ? 34 : 30, 'bold')
  ctx.letterSpacing = format === 'story' ? '10px' : '9px'
  ctx.fillText('NOW SPINNING', W / 2, format === 'story' ? STORY_SAFE.top + 12 : 52)
  ctx.letterSpacing = '0px'

  const sw = SCREEN_WIDTH[format]
  if (format === 'story') {
    // Inside Instagram's safe zone (STORY_SAFE), like the phone's card.
    const bodyW = sw + 120
    const bodyX = (W - bodyW) / 2
    const bodyY = STORY_SAFE.top + 12 + 44 + 36
    const screenY = bodyY + 56
    // The screen's height is known only once drawn: draw it on a scratch
    // canvas, paint the body under it, then lay the screen on top.
    const scratch = document.createElement('canvas'); scratch.width = W; scratch.height = H
    const screenBottom = drawScreen(scratch.getContext('2d')!, c, art, bodyX + 60, screenY, sw)
    const R = 200
    const wheelCY = screenBottom + 48 + R
    const bodyH = wheelCY + R + 56 - bodyY
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 120; ctx.shadowOffsetY = 30
    const bg2 = ctx.createLinearGradient(bodyX, bodyY, bodyX + bodyW, bodyY + bodyH)
    bg2.addColorStop(0, '#dbdbdb'); bg2.addColorStop(1, '#b3b3b3')
    ctx.fillStyle = bg2; roundRect(ctx, bodyX, bodyY, bodyW, bodyH, 56); ctx.fill()
    ctx.restore()
    ctx.drawImage(scratch, 0, 0)
    drawWheel(ctx, W / 2, wheelCY, R)
    drawFooter(ctx, c, W, H - STORY_SAFE.bottom - 16, 110, 130)
  } else {
    const plate = 30
    const sx = (W - sw) / 2
    const sy = 52 + 40 + 36 + plate
    // plate first (screen height is known only after drawing, so draw to a scratch pass)
    const scratch = document.createElement('canvas'); scratch.width = W; scratch.height = H
    const sctx = scratch.getContext('2d')!
    const screenBottom = drawScreen(sctx, c, art, sx, sy, sw)
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 100; ctx.shadowOffsetY = 28
    const pg = ctx.createLinearGradient(sx - plate, sy - plate, sx + sw + plate, screenBottom + plate)
    pg.addColorStop(0, '#dbdbdb'); pg.addColorStop(1, '#b3b3b3')
    ctx.fillStyle = pg; roundRect(ctx, sx - plate, sy - plate, sw + plate * 2, screenBottom - sy + plate * 2, 44); ctx.fill()
    ctx.restore()
    ctx.drawImage(scratch, 0, 0)
    drawFooter(ctx, c, W, H - 30, 84, 130)
  }
  return canvas.toDataURL('image/png')
}

/**
 * The poster maker's pixels. Electron-free, so the app (at declare time) and the
 * headless script (scripts/concert/concert-posters.mts) run the same drawing.
 *
 * It uses what every Mac already has, the way the artwork engine leans on `sips`:
 *   - osascript (JavaScript for Automation) draws through AppKit into an
 *     offscreen bitmap. No window, no Dock icon, no focus steal, and text with
 *     real fonts, which the Homebrew ffmpeg cannot do (it has no drawtext).
 *   - sips turns any other image format into a JPEG.
 *   - ffmpeg decodes a poster to raw pixels for its edge colour.
 *
 * Off a Mac, or if a tool is missing, these reject. Callers treat that as "no
 * poster yet": a show draws its cover whole in the frame, on the plain ground.
 */
import { execFile } from 'node:child_process'
import { copyFile, open, rename, stat, unlink } from 'node:fs/promises'
import { edgeMatte, POSTER_FRAME_H, POSTER_FRAME_W, type BuiltPosterSpec } from '../common/concert-poster.ts'

function run(cmd: string, args: string[], opts: { timeoutMs: number; binary?: boolean }): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr || '').trim().split('\n').slice(-1)[0] || err.message
        reject(new Error(`${cmd}: ${why}`))
        return
      }
      resolve({ stdout, stderr: String(stderr) })
    })
  })
}

/**
 * The drawing. Top-down layout in pixels; AppKit's origin is bottom-left, hence
 * flipY. Names never clip: the band's size comes down until its longest word fits
 * the width. The cover takes the height that is left and is drawn whole.
 */
export const BUILT_POSTER_JXA = String.raw`
ObjC.import('AppKit');
ObjC.import('CoreText');
ObjC.import('Foundation');
function run(argv) {
  const s = JSON.parse(argv[0]);
  const W = s.w, H = s.h;
  if (s.fontPath) $.CTFontManagerRegisterFontsForURL($.NSURL.fileURLWithPath(s.fontPath), 1, null);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    $(), W, H, 8, 4, true, false, 'NSDeviceRGBColorSpace', 0, 32);
  const gfx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  if (gfx.isNil()) throw new Error('no bitmap context');
  $.NSGraphicsContext.setCurrentContext(gfx);
  gfx.imageInterpolation = 3;
  const color = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return $.NSColor.colorWithSRGBRedGreenBlueAlpha(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1);
  };
  const attrs = (font, c, lh, kern) => {
    const p = $.NSMutableParagraphStyle.alloc.init;
    p.minimumLineHeight = lh; p.maximumLineHeight = lh; p.lineBreakMode = 0;
    return $.NSDictionary.dictionaryWithObjectsForKeys(
      $([font, color(c), p, $(kern || 0)]),
      $([$.NSFontAttributeName, $.NSForegroundColorAttributeName, $.NSParagraphStyleAttributeName, $.NSKernAttributeName]));
  };
  const opts = 1 | 2;
  const heightOf = (text, a, width) => Math.ceil($(text).boundingRectWithSizeOptionsAttributes($.NSMakeSize(width, 100000), opts, a).size.height);
  const widthOf = (text, a) => $(text).sizeWithAttributes(a).width;
  const CW = W - s.pad.left - s.pad.right;

  const bandFontAt = (size) => {
    const f = $.NSFont.fontWithNameSize(s.band.font, size);
    return f.isNil() ? $.NSFont.boldSystemFontOfSize(size) : f;
  };
  let bandSize = s.band.size, bandLH = s.band.lineHeight;
  for (let i = 0; i < 8; i++) {
    const a = attrs(bandFontAt(bandSize), s.band.color, bandLH);
    const widest = s.band.text.split(/\s+/).reduce((m, w) => Math.max(m, widthOf(w, a)), 0);
    if (widest <= CW || bandSize <= s.band.minSize) break;
    const k = Math.max(s.band.minSize / bandSize, CW / widest);
    bandSize *= k; bandLH *= k;
  }
  const bandA = attrs(bandFontAt(bandSize), s.band.color, bandLH);
  const bandH = heightOf(s.band.text, bandA, CW);

  const lineFont = $.NSFont.systemFontOfSizeWeight(s.lines.size, $.NSFontWeightSemibold);
  const linesA = attrs(lineFont, s.lines.color, s.lines.lineHeight, s.lines.tracking);
  const printed = [s.lines.title];
  let cur = '';
  for (const d of s.lines.details) {
    const next = cur ? cur + ' · ' + d : d;
    if (cur && widthOf(next, linesA) > CW) { printed.push(cur); cur = d; } else cur = next;
  }
  if (cur) printed.push(cur);
  const linesText = printed.join('\n');
  const linesH = heightOf(linesText, linesA, CW);

  color(s.ground).setFill; $.NSRectFill($.NSMakeRect(0, 0, W, H));
  const flipY = (top, h) => H - top - h;
  $(s.band.text).drawWithRectOptionsAttributes($.NSMakeRect(s.pad.left, flipY(s.pad.top, bandH), CW, bandH), opts, bandA);

  const coverTop = s.pad.top + bandH + s.coverGap;
  const linesTop = H - s.pad.bottom - linesH;
  const ruleTop = linesTop - s.lines.gap - s.rule.h;
  const boxH = Math.max(0, ruleTop - s.rule.gap - coverTop);
  let cover = null;
  if (s.coverPath && boxH > 0) {
    const data = $.NSData.dataWithContentsOfFile(s.coverPath);
    const src = data.isNil() ? $() : $.NSBitmapImageRep.imageRepWithData(data);
    if (src.isNil()) throw new Error('cover unreadable: ' + s.coverPath);
    const pw = Number(src.pixelsWide), ph = Number(src.pixelsHigh);
    const scale = Math.min(CW / pw, boxH / ph);
    const dw = Math.round(pw * scale), dh = Math.round(ph * scale);
    const dx = s.pad.left + Math.round((CW - dw) / 2), dy = coverTop + Math.round((boxH - dh) / 2);
    src.drawInRectFromRectOperationFractionRespectFlippedHints($.NSMakeRect(dx, flipY(dy, dh), dw, dh), $.NSZeroRect, 2, 1, true, $());
    cover = { x: dx, y: dy, w: dw, h: dh };
  }
  color(s.rule.color).setFill; $.NSRectFill($.NSMakeRect(s.pad.left, flipY(ruleTop, s.rule.h), s.rule.w, s.rule.h));
  $(linesText).drawWithRectOptionsAttributes($.NSMakeRect(s.pad.left, flipY(linesTop, linesH), CW, linesH), opts, linesA);
  $.NSGraphicsContext.setCurrentContext($());

  const tagged = rep.bitmapImageRepByRetaggingWithColorSpace($.NSColorSpace.sRGBColorSpace);
  const props = $.NSDictionary.dictionaryWithObjectForKey($(s.quality), $.NSImageCompressionFactor);
  const jpg = (tagged.isNil() ? rep : tagged).representationUsingTypeProperties(3, props);
  if (jpg.isNil() || !jpg.writeToFileAtomically(s.out, true)) throw new Error('jpeg write failed: ' + s.out);
  return JSON.stringify({ bandSize: Math.round(bandSize), bandH, linesH, boxH, cover, printed });
}
`

export interface RenderedPoster {
  bandSize: number
  cover: { x: number; y: number; w: number; h: number } | null
  /** The words as printed, one entry per line before any wrap inside a line. */
  printed: string[]
}

/** Draw one built poster to `outPath` (a flat JPEG, 961×1292). */
export async function renderBuiltPoster(input: {
  spec: BuiltPosterSpec
  coverPath: string | null
  outPath: string
  /** pixChicago's TTF. Without it the band's name falls back to the bold system face. */
  fontPath: string | null
}): Promise<RenderedPoster> {
  const payload = { ...input.spec, coverPath: input.coverPath, out: input.outPath, fontPath: input.fontPath }
  const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', BUILT_POSTER_JXA, JSON.stringify(payload)], { timeoutMs: 60_000 })
  return JSON.parse(stdout.toString('utf-8')) as RenderedPoster
}

/** A poster's matte from the file itself. The width is small on purpose: a median needs no detail. */
export async function readEdgeMatte(imagePath: string): Promise<string> {
  const width = 200
  const { stdout } = await run('ffmpeg', [
    '-v', 'error', '-i', imagePath,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2:flags=bilinear`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { timeoutMs: 30_000 })
  const height = Math.floor(stdout.length / (width * 3))
  return edgeMatte(new Uint8Array(stdout), width, height)
}

async function magic(path: string): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(4)
    await fh.read(buf, 0, 4, 0)
    return buf
  } finally { await fh.close() }
}

export const isJpegBytes = (b: Uint8Array): boolean => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

/**
 * A JPEG copy of any image at `destPath`, never half-written: the artwork store
 * only holds .jpg files. A JPEG is copied byte for byte (a poster is not
 * re-encoded); anything else goes through sips, like set-custom-artwork.
 */
export async function imageToJpeg(srcPath: string, destPath: string): Promise<void> {
  const tmp = `${destPath}.${process.pid}.${Date.now()}.tmp.jpg`
  try {
    if (isJpegBytes(await magic(srcPath))) await copyFile(srcPath, tmp)
    else await run('sips', ['-s', 'format', 'jpeg', srcPath, '--out', tmp], { timeoutMs: 60_000 })
    if (!(await stat(tmp)).size) throw new Error(`empty image from ${srcPath}`)
    await rename(tmp, destPath)
  } catch (err) {
    await unlink(tmp).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') console.warn('[concert-poster] temp file left behind:', e.message)
    })
    throw err
  }
}

/** Pixel size of an image, for the dry run's report. */
export async function imageSize(path: string): Promise<{ w: number; h: number } | null> {
  try {
    const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeoutMs: 15_000 })
    const text = stdout.toString('utf-8')
    const w = Number(/pixelWidth:\s*(\d+)/.exec(text)?.[1])
    const h = Number(/pixelHeight:\s*(\d+)/.exec(text)?.[1])
    return w > 0 && h > 0 ? { w, h } : null
  } catch { return null }
}

/** The frame, for anything that wants to check a built poster's size. */
export const BUILT_POSTER_SIZE = { w: POSTER_FRAME_W, h: POSTER_FRAME_H }

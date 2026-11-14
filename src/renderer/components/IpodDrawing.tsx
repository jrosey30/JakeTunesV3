// The drawn iPod of the ad page (2026-11-14, common/ipod-ad.ts): front on,
// evenly lit, the right proportions for its model, in its own colour. One
// drawing per model the app knows ('mini', 'classic', '3g', 'default'), in any
// colour. Jake on the first mock: "too quirky and cartoony", so nothing here
// tilts, glows or reflects; the only shadow is the floor's, and it goes away
// on black.
//
// Static SVG: no state, no effects, nothing measured.
import { memo } from 'react'
import { ipodDrawingColors, ipodScreenTitle } from '../../common/ipod-ad'
import type { IpodModel } from '../../common/ipod-covers'

const INK = '#262a20'
const PAPER = '#cfd5c4'
const MONO = 'Geneva,Verdana,sans-serif'
const SANS = 'Helvetica Neue,Helvetica,Arial,sans-serif'
const ROWS = ['Playlists', 'Artists', 'Songs', 'Shuffle Songs', 'Settings']
/** Shuffle Songs is the one row that opens nothing, so it has no arrow. */
const NO_ARROW = 3

/** The gradients every model shares. One ad is on screen at a time, so the ids are fixed. */
function Defs() {
  return (
    <defs>
      <linearGradient id="ipodad-alu" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stopColor="#000" stopOpacity=".30" /><stop offset=".035" stopColor="#000" stopOpacity=".08" />
        <stop offset=".09" stopColor="#fff" stopOpacity=".30" /><stop offset=".2" stopColor="#fff" stopOpacity=".12" />
        <stop offset=".5" stopColor="#fff" stopOpacity="0" /><stop offset=".84" stopColor="#000" stopOpacity=".03" />
        <stop offset=".955" stopColor="#000" stopOpacity=".15" /><stop offset="1" stopColor="#000" stopOpacity=".36" />
      </linearGradient>
      <linearGradient id="ipodad-vsh" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity=".10" /><stop offset=".3" stopColor="#fff" stopOpacity="0" />
        <stop offset=".75" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".12" />
      </linearGradient>
      <linearGradient id="ipodad-gloss" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity=".30" /><stop offset=".34" stopColor="#fff" stopOpacity=".05" />
        <stop offset=".62" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".15" />
      </linearGradient>
      <linearGradient id="ipodad-sides" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stopColor="#000" stopOpacity=".16" /><stop offset=".05" stopColor="#000" stopOpacity="0" />
        <stop offset=".95" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".2" />
      </linearGradient>
      <linearGradient id="ipodad-chrome" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stopColor="#eceef1" /><stop offset=".3" stopColor="#a4a8ae" /><stop offset=".55" stopColor="#f4f5f7" />
        <stop offset=".8" stopColor="#8b8f96" /><stop offset="1" stopColor="#5f636a" />
      </linearGradient>
      <linearGradient id="ipodad-lcd" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#d3d8c8" /><stop offset="1" stopColor="#bcc3b0" /></linearGradient>
      <linearGradient id="ipodad-lcdsh" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#000" stopOpacity=".2" /><stop offset="1" stopColor="#000" stopOpacity="0" /></linearGradient>
      <linearGradient id="ipodad-cbar" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#f1f1f2" /><stop offset="1" stopColor="#c6c7ca" /></linearGradient>
      <linearGradient id="ipodad-csel" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#62a3ee" /><stop offset="1" stopColor="#2c6fd2" /></linearGradient>
      <radialGradient id="ipodad-wheelw" cx=".36" cy=".3" r=".85"><stop offset="0" stopColor="#ffffff" /><stop offset=".55" stopColor="#f1f1f3" /><stop offset="1" stopColor="#dcdde1" /></radialGradient>
      <radialGradient id="ipodad-hubw" cx=".4" cy=".34" r=".8"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#e3e4e7" /></radialGradient>
      <radialGradient id="ipodad-hubc" cx=".4" cy=".32" r=".85"><stop offset="0" stopColor="#fff" stopOpacity=".28" /><stop offset=".6" stopColor="#fff" stopOpacity=".04" /><stop offset="1" stopColor="#000" stopOpacity=".14" /></radialGradient>
      <radialGradient id="ipodad-key" cx=".4" cy=".32" r=".9"><stop offset="0" stopColor="#fff" stopOpacity=".2" /><stop offset=".6" stopColor="#fff" stopOpacity=".04" /><stop offset="1" stopColor="#000" stopOpacity=".1" /></radialGradient>
      <radialGradient id="ipodad-touch" cx=".38" cy=".3" r=".9"><stop offset="0" stopColor="#fff" stopOpacity=".2" /><stop offset=".6" stopColor="#fff" stopOpacity=".07" /><stop offset="1" stopColor="#000" stopOpacity=".05" /></radialGradient>
      <radialGradient id="ipodad-floor"><stop offset="0" stopColor="#000" stopOpacity=".3" /><stop offset=".55" stopColor="#000" stopOpacity=".1" /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient>
    </defs>
  )
}

const u = (id: string) => `url(#ipodad-${id})`

function Skip({ x, y, fill, flip, scale = 1 }: { x: number; y: number; fill: string; flip?: boolean; scale?: number }) {
  return (
    <g transform={`translate(${x},${y}) scale(${flip ? -scale : scale},${scale})`} fill={fill}>
      <rect x="-6" y="-3" width="1.4" height="6" />
      <path d="M-4.2 0L-.4-3V3ZM-.2 0L3.8-3V3Z" />
    </g>
  )
}

function PlayPause({ x, y, fill, scale = 1 }: { x: number; y: number; fill: string; scale?: number }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`} fill={fill}>
      <path d="M-5.4-3L-1 0L-5.4 3Z" />
      <rect x=".8" y="-3" width="1.5" height="6" />
      <rect x="3.4" y="-3" width="1.5" height="6" />
    </g>
  )
}

function Menu({ x, y, fill, size = 7.6 }: { x: number; y: number; fill: string; size?: number }) {
  return <text x={x} y={y} textAnchor="middle" fontFamily={SANS} fontWeight="700" fontSize={size} letterSpacing=".7" fill={fill}>MENU</text>
}

/** The grey screen of the mini, the third generation and the default iPod: a title bar and five rows, the first one picked. */
function GreyScreen({ x, y, w, h, row, title }: { x: number; y: number; w: number; h: number; row: number; title: string }) {
  const top = y + 12.4
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx="1.5" fill={u('lcd')} />
      <path d={`M${x + 4} ${y + 3.4}l4 2.3l-4 2.3z`} fill={INK} />
      <rect x={x + w - 13} y={y + 3.2} width="8.5" height="4.6" rx=".8" fill="none" stroke={INK} strokeWidth=".8" />
      <rect x={x + w - 12} y={y + 4.2} width="5" height="2.6" fill={INK} />
      <text x="120" y={y + 8.6} textAnchor="middle" fontFamily={MONO} fontWeight="700" fontSize="7.4" fill={INK}>{title}</text>
      <rect x={x} y={y + 11.2} width={w} height=".7" fill={INK} opacity=".7" />
      <rect x={x} y={top} width={w} height={row} fill={INK} />
      {ROWS.map((label, i) => {
        const ink = i === 0 ? PAPER : INK
        const base = top + i * row
        return (
          <g key={label}>
            <text x={x + 4} y={base + row - 3.2} fontFamily={MONO} fontWeight="700" fontSize="6.9" fill={ink}>{label}</text>
            {i !== NO_ARROW && <path d={`M${x + w - 7} ${base + row * 0.5 - 2.4}l2.6 2.4l-2.6 2.4`} fill="none" stroke={ink} strokeWidth="1" />}
          </g>
        )
      })}
      <rect x={x} y={y} width={w} height="9" rx="1.5" fill={u('lcdsh')} />
    </>
  )
}

/** The classic's colour screen: a grey title bar, a blue picked row, black type on white. */
function ColourScreen({ title }: { title: string }) {
  const row = 12.7333
  const rows = [...ROWS, 'Now Playing']
  return (
    <>
      <rect x="57" y="81" width="126" height="98" rx="3.5" fill="#0b0b0c" />
      <rect x="61" y="85" width="118" height="90" fill="#fff" />
      <rect x="61" y="85" width="118" height="13" fill={u('cbar')} />
      <rect x="61" y="98" width="118" height=".6" fill="#8e9094" />
      <text x="120" y="94.6" textAnchor="middle" fontFamily={SANS} fontWeight="700" fontSize="7.6" fill="#1c1c1e">{title}</text>
      <rect x="164" y="89" width="10" height="5" rx="1" fill="#58b947" />
      <rect x="61" y="98.6" width="118" height={row} fill={u('csel')} />
      {rows.map((label, i) => {
        const ink = i === 0 ? '#fff' : '#111'
        const base = 98.6 + i * row
        return (
          <g key={label}>
            <text x="66" y={base + 9.13} fontFamily={SANS} fontWeight="700" fontSize="7.6" fill={ink}>{label}</text>
            {i !== NO_ARROW && i !== rows.length - 1 && <path d={`M171 ${base + 3.77}l2.8 2.6l-2.8 2.6`} fill="none" stroke={ink} strokeWidth="1.1" />}
          </g>
        )
      })}
    </>
  )
}

/** An anodised case (the mini, the classic). */
function AluCase({ x, y, w, h, rx, body, bezel }: { x: number; y: number; w: number; h: number; rx: number; body: string; bezel?: boolean }) {
  return (
    <>
      {bezel && <rect x={x - 0.8} y={y - 0.8} width={w + 1.6} height={h + 1.6} rx={rx + 0.8} fill={u('chrome')} />}
      <rect x={x} y={y} width={w} height={h} rx={rx} fill={body} />
      <rect x={x} y={y} width={w} height={h} rx={rx} fill={u('alu')} />
      <rect x={x} y={y} width={w} height={h} rx={rx} fill={u('vsh')} />
      {!bezel && (
        <>
          <rect x={x + 2} y={y + 0.6} width={w - 4} height="2.6" rx="1.3" fill="#fff" opacity=".7" />
          <rect x={x + 2} y={y + h - 3.2} width={w - 4} height="2.6" rx="1.3" fill="#fff" opacity=".45" />
        </>
      )}
      <rect className="ipod-drawing-rim" x={bezel ? x - 0.8 : x} y={bezel ? y - 0.8 : y} width={bezel ? w + 1.6 : w} height={bezel ? h + 1.6 : h} rx={bezel ? rx + 0.8 : rx} fill="none" />
    </>
  )
}

/** A glossy case in a chrome edge (the third generation, the default iPod). */
function GlossCase({ body }: { body: string }) {
  return (
    <>
      <rect x="44.8" y="65.8" width="150.4" height="256.4" rx="15.2" fill={u('chrome')} />
      <rect x="45.6" y="66.6" width="148.8" height="254.8" rx="14.4" fill={body} />
      <rect x="45.6" y="66.6" width="148.8" height="254.8" rx="14.4" fill={u('gloss')} />
      <rect x="45.6" y="66.6" width="148.8" height="254.8" rx="14.4" fill={u('sides')} />
      <rect className="ipod-drawing-rim" x="44.8" y="65.8" width="150.4" height="256.4" rx="15.2" fill="none" />
    </>
  )
}

export interface IpodDrawingProps {
  model: IpodModel
  /** A named iPod colour or '#rrggbb'. */
  color: string | null
  /** The list's name, on the screen's title bar. */
  name: string
}

function IpodDrawingInner({ model, color, name }: IpodDrawingProps) {
  const c = ipodDrawingColors(model, color)
  const title = ipodScreenTitle(name)
  const label = `${name} iPod`

  if (model === 'mini') {
    return (
      <svg className="ipod-drawing" viewBox="30 50 180 296" role="img" aria-label={label}>
        <Defs />
        <ellipse className="ipod-drawing-floor" cx="120" cy="334" rx="86" ry="8" fill={u('floor')} />
        <AluCase x={45} y={60} w={150} h={268} rx={9} body={c.body} />
        <rect x="69" y="82" width="102" height="76" rx="4" fill="#2a2c2d" />
        <GreyScreen x={73} y={86} w={94} h={68} row={11.1} title={title} />
        <circle cx="120" cy="244" r="54.6" fill="#000" opacity=".12" />
        <circle cx="120" cy="244" r="54" fill={u('wheelw')} />
        <Menu x={120} y={205.5} fill={c.glyph} />
        <Skip x={79} y={244} fill={c.glyph} />
        <Skip x={161} y={244} fill={c.glyph} flip />
        <PlayPause x={120} y={286} fill={c.glyph} />
        <circle cx="120" cy="244" r="19.4" fill="#000" opacity=".13" />
        <circle cx="120" cy="244" r="18.8" fill={u('hubw')} />
      </svg>
    )
  }

  if (model === '3g') {
    return (
      <svg className="ipod-drawing" viewBox="30 50 180 296" role="img" aria-label={label}>
        <Defs />
        <ellipse className="ipod-drawing-floor" cx="120" cy="328" rx="86" ry="8" fill={u('floor')} />
        <GlossCase body={c.body} />
        <rect x="67" y="84" width="106" height="84" rx="4.5" fill="#2a2c2d" />
        <GreyScreen x={72} y={89} w={96} h={74} row={12.3} title={title} />
        {[78.5, 106, 134, 161.5].map((cx) => (
          <g key={cx}>
            <circle cx={cx} cy="189" r="10.6" fill="#000" opacity=".16" />
            <circle cx={cx} cy="189" r="10" fill={c.body} />
            <circle cx={cx} cy="189" r="10" fill={u('key')} />
          </g>
        ))}
        <Skip x={79.1} y={189} fill={c.glyph} scale={0.82} />
        <Menu x={106} y={191.1} fill={c.glyph} size={5.4} />
        <PlayPause x={134.2} y={189} fill={c.glyph} scale={0.82} />
        <Skip x={160.9} y={189} fill={c.glyph} scale={0.82} flip />
        <circle cx="120" cy="259" r="50.6" fill="#000" opacity=".15" />
        <circle cx="120" cy="259" r="50" fill={c.body} />
        <circle cx="120" cy="259" r="50" fill={u('touch')} />
        <circle cx="120" cy="259" r="18.6" fill="#000" opacity=".17" />
        <circle cx="120" cy="259" r="18" fill={c.body} />
        <circle cx="120" cy="259" r="18" fill={u('key')} />
      </svg>
    )
  }

  if (model === 'classic') {
    return (
      <svg className="ipod-drawing" viewBox="30 50 180 296" role="img" aria-label={label}>
        <Defs />
        <ellipse className="ipod-drawing-floor" cx="120" cy="326" rx="86" ry="8" fill={u('floor')} />
        <AluCase x={45.6} y={68.6} w={148.8} h={250.8} rx={9.4} body={c.body} bezel />
        <ColourScreen title={title} />
        <circle cx="120" cy="252" r="50.6" fill="#000" opacity=".14" />
        <circle cx="120" cy="252" r="50" fill={c.wheel ?? u('wheelw')} />
        {c.wheel && <circle cx="120" cy="252" r="50" fill={u('touch')} />}
        <Menu x={120} y={217} fill={c.glyph} />
        <Skip x={82.5} y={252} fill={c.glyph} />
        <Skip x={157.5} y={252} fill={c.glyph} flip />
        <PlayPause x={120} y={290.5} fill={c.glyph} />
        <circle cx="120" cy="252" r="18.6" fill="#000" opacity=".18" />
        <circle cx="120" cy="252" r="18" fill={c.hub ?? c.body} />
        <circle cx="120" cy="252" r="18" fill={u('hubc')} />
      </svg>
    )
  }

  return (
    <svg className="ipod-drawing" viewBox="30 50 180 296" role="img" aria-label={label}>
      <Defs />
      <ellipse className="ipod-drawing-floor" cx="120" cy="328" rx="86" ry="8" fill={u('floor')} />
      <GlossCase body={c.body} />
      <rect x="67" y="84" width="106" height="84" rx="4.5" fill="#2a2c2d" />
      <GreyScreen x={72} y={89} w={96} h={74} row={12.3} title={title} />
      <circle cx="120" cy="246" r="54.6" fill="#000" opacity=".14" />
      <circle cx="120" cy="246" r="54" fill={c.wheel ?? '#f3f3f4'} />
      <circle cx="120" cy="246" r="54" fill={u('touch')} />
      <Menu x={120} y={207.5} fill={c.glyph} />
      <Skip x={79} y={246} fill={c.glyph} />
      <Skip x={161} y={246} fill={c.glyph} flip />
      <PlayPause x={120} y={288} fill={c.glyph} />
      <circle cx="120" cy="246" r="19.4" fill="#000" opacity=".16" />
      <circle cx="120" cy="246" r="18.8" fill={c.hub ?? c.body} />
      <circle cx="120" cy="246" r="18.8" fill={u('key')} />
    </svg>
  )
}

export const IpodDrawing = memo(IpodDrawingInner)

/**
 * Step Inside — the playable shop.
 *
 * One street, one door, nine bins filed the way a shop files them
 * (shopPlan.ts), one listening station. No city, no dashboard: the brief
 * asked for walking, entering and flipping to feel right before anything
 * expands, so everything here serves those three.
 *
 * The normal app is never more than Esc away, and the regular Record Shop
 * tabs are untouched — this is an alternative way in, not a replacement.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useLibrary } from '../../../context/LibraryContext'
import { usePlayback } from '../../../context/PlaybackContext'
import { useAudio } from '../../../hooks/useAudio'
import { buildWorld, SPAWN, STATION_POS, SHOP_DOOR_Z } from './world'
import { buildAvatar } from './avatar'
import { buildCrateView, type CrateView } from './crateView'
import { useShopStock, type ShopBin } from './useCrateStock'
import { BINS } from './shopPlan'
import { bodyStart, stepBody, gait, resolveCollisions, type Body } from './playerModel'
import { digStart, digFlip, digTogglePull, digPosition, digAtEdge } from './digModel'
import { claimTransportKeys } from '../../../input-mode'
import type { CrateRecord, DigState } from './types'
import './step-inside.css'

// PS2 style is deliberate low-poly geometry and honest textures — NOT a
// pixelation filter. Rendering at 448p and stretching it was hiding the
// models and destroying album art, so the scene now draws at native size
// with antialiasing on, and the era reads from the geometry and the flat
// shading instead. (Jake 2026-09-09.)
const MAX_PIXEL_RATIO = 2
const CAM_DISTANCE = 4.2
const CAM_HEIGHT = 2.15
const REACH = 2.1

/** Scripted acceptance run (#stepInsideDemo): approach, enter, browse,
 *  pull, return. Exists so a playable run can be RECORDED and repeated,
 *  rather than claimed from a screenshot.
 *
 *  Walking is by WAYPOINT, not by holding a key for N seconds: the avatar
 *  steers toward each goal through the same momentum model a person
 *  drives, and stops when it arrives. Timed key-holds overshot the crate
 *  and ended the first run standing at the counter. The dig step still
 *  goes through the reach gate, so if the walk is wrong the run says so
 *  instead of flying the camera to the crate anyway. */
type DemoStep = { at: number; note: string } & (
  | { goto: { x: number; z: number } }
  | { act: 'dig' | 'undig' | 'flip+' | 'flip-' | 'pull' }
)
const DEMO: DemoStep[] = [
  { at: 0.6,  note: 'walk to the door',   goto: { x: 0, z: -4.2 } },
  { at: 3.4,  note: 'in to the ROCK bin', goto: { x: 0, z: -7.8 } },       // 1.6 m from the bin, clear of its footprint
  { at: 8.0,  note: 'start digging',      act: 'dig' },
  { at: 9.0,  note: 'flip',               act: 'flip+' },
  { at: 9.8,  note: 'flip',               act: 'flip+' },
  { at: 10.6, note: 'flip',               act: 'flip+' },
  { at: 11.4, note: 'flip',               act: 'flip+' },
  { at: 12.6, note: 'pull it out',        act: 'pull' },
  { at: 15.4, note: 'slide it back',      act: 'pull' },
  { at: 16.6, note: 'flip back',          act: 'flip-' },
  { at: 17.8, note: 'step back',          act: 'undig' },
  { at: 18.4, note: 'over to PUNK',       goto: { x: -4.5, z: -10.9 } },
  { at: 23.0, note: 'dig the punk bin',   act: 'dig' },
  { at: 24.0, note: 'flip',               act: 'flip+' },
  { at: 24.8, note: 'flip',               act: 'flip+' },
  { at: 26.0, note: 'pull it out',        act: 'pull' },
  { at: 29.0, note: 'step back',          act: 'undig' },
]
// Digging framing: your own eyes at the front rail. Standing height, a
// step back from the bin, looking down ~35° at the record you're on, so
// the cover reads, the fan of sleeve tops behind it is in frame and the
// shop is still there behind the bin. The flipped pile at the front hides
// the record's foot the way a real crate does; the top-down camera that
// showed the whole cover made every sleeve behind it a blank tan edge.
// The avatar is hidden while the camera is here — it is where his head is.
const DIG_DISTANCE = 1.05
const DIG_HEIGHT = 1.75

type Mode = 'walk' | 'dig'

export default function StepInsideView({ onLeave }: { onLeave: () => void }) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const { state: lib } = useLibrary()
  const { state: playback } = usePlayback()
  const { playTrack } = useAudio()

  // Hold the transport keys for as long as this view is mounted, so the
  // arrows dig instead of skipping tracks — and hand them straight back on
  // the way out, whether that is the button, Escape or an unmount.
  useEffect(() => claimTransportKeys('step-inside'), [])

  const demoMode = useMemo(
    () => typeof window !== 'undefined' && /stepInsideDemo/i.test(window.location.hash),
    [],
  )
  const visitSeed = useMemo(() => (demoMode ? 12345 : Math.floor(Math.random() * 1e9)), [demoMode])
  const bins = useShopStock(visitSeed)

  const [mode, setMode] = useState<Mode>('walk')
  const [dig, setDig] = useState<DigState>(digStart)
  const [prompt, setPrompt] = useState<string | null>(null)
  /** The bin within reach (walking) or being dug (digging). */
  const [binId, setBinId] = useState<string | null>(null)
  const [inside, setInside] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Refs the render loop reads — state it must not re-subscribe to.
  const modeRef = useRef(mode); modeRef.current = mode
  const digRef = useRef(dig); digRef.current = dig
  const binsRef = useRef(bins); binsRef.current = bins
  const binIdRef = useRef(binId); binIdRef.current = binId
  const insideRef = useRef(inside); insideRef.current = inside
  const demoGoalRef = useRef<{ x: number; z: number } | null>(null)
  const promptRef = useRef(prompt); promptRef.current = prompt
  /** The last record pulled out of any bin — what goes on the deck. */
  const inHandRef = useRef<CrateRecord | null>(null)

  const binById = (id: string | null): ShopBin | null => (id ? binsRef.current.find((b) => b.id === id) ?? null : null)
  const activeRecords = (): CrateRecord[] => binById(binIdRef.current)?.records ?? []

  const bin = bins.find((b) => b.id === binId) ?? null
  const records = bin?.records ?? []
  const current = records[Math.min(dig.index, Math.max(0, records.length - 1))] ?? null

  // ── Actions ──
  const trackById = useMemo(() => {
    const m = new Map<number, typeof lib.tracks[number]>()
    for (const t of lib.tracks) m.set(t.id, t)
    return m
  }, [lib.tracks])

  const playRecord = useCallback((ids: number[]) => {
    const ts = ids.map((id) => trackById.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t))
    if (!ts.length) { setNotice('That sleeve is empty.'); return }
    // Side A, track 1 — the running order IS the record.
    playTrack(ts[0], ts, 0, undefined, true, true)
  }, [trackById, playTrack])

  const flash = useCallback((msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2600)
  }, [])

  // Pulling a record out is what puts it "in hand" — the deck plays that.
  const pull = useCallback(() => {
    setDig((d) => {
      const next = digTogglePull(d)
      if (next.pulled) inHandRef.current = activeRecords()[next.index] ?? null
      return next
    })
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── The world ──
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    // The shop's lights sum to more than white on a sleeve under the lamp,
    // and without a tone curve anything pale clips: Turnstile's sky-blue
    // Never Enough rendered as a blank white card. Neutral tone mapping
    // (Khronos PBR Neutral) leaves midtones alone and rolls the top off,
    // which is what a cover needs — its colours are the product.
    renderer.toneMapping = THREE.NeutralToneMapping
    renderer.toneMappingExposure = 0.9
    mount.appendChild(renderer.domElement)
    renderer.domElement.className = 'stepinside__canvas'

    const world = buildWorld()
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 120)
    const avatar = buildAvatar()
    world.scene.add(avatar.root)

    // One crate view per bin, parked in the world's anchor for it.
    const crates = new Map<string, CrateView>()
    for (const b of binsRef.current) {
      const crate = buildCrateView(b.records, b.sections)
      world.bins.get(b.id)?.add(crate.group)
      crates.set(b.id, crate)
    }
    const binPos = (id: string | null): { x: number; z: number } => {
      const def = BINS.find((b) => b.id === id) ?? BINS[0]
      return { x: def.x, z: def.z }
    }

    let body: Body = bodyStart(SPAWN.x, SPAWN.z, Math.PI)
    let camYaw = 0
    let camPos = new THREE.Vector3(SPAWN.x, CAM_HEIGHT, SPAWN.z + CAM_DISTANCE)
    const lookPos = new THREE.Vector3(SPAWN.x, 1.05, SPAWN.z)
    // Locked when a dig starts: the angle you approached the crate from.
    let digYaw: number | null = null
    let distanceWalked = 0

    const keys = new Set<string>()
    const onKeyDown = (e: KeyboardEvent): void => {
      // Never eat typing in an input.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      keys.add(e.code)
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent): void => { keys.delete(e.code) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    // Camera drag — hold anywhere on the scene and swing the view.
    let dragging = false
    let lastX = 0
    const onDown = (e: PointerEvent): void => { dragging = true; lastX = e.clientX; renderer.domElement.setPointerCapture(e.pointerId) }
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return
      camYaw -= (e.clientX - lastX) * 0.006
      lastX = e.clientX
    }
    const onUp = (e: PointerEvent): void => { dragging = false; try { renderer.domElement.releasePointerCapture(e.pointerId) } catch { /* gone */ } }
    renderer.domElement.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)

    const resize = (): void => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(mount)

    let raf = 0
    let last = performance.now()
    const tmp = new THREE.Vector3()

    const loop = (): void => {
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      const dt = Math.min(0.05, (now - last) / 1000)   // clamp: a stalled tab must not teleport you
      last = now

      // Camera yaw on keys too, so this is playable without a mouse.
      if (keys.has('KeyQ')) camYaw += 2.2 * dt
      if (keys.has('KeyE') && modeRef.current === 'walk' && keys.has('ShiftLeft')) camYaw -= 2.2 * dt

      const digging = modeRef.current === 'dig' && binIdRef.current !== null
      const active = binIdRef.current
      const at = binPos(active)
      let input = { x: 0, z: 0 }
      if (!digging) {
        const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0)
        const s = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
        // Camera-relative: forward is always "away from the camera".
        input = {
          x: -Math.sin(camYaw) * f + Math.cos(camYaw) * s,
          z: -Math.cos(camYaw) * f - Math.sin(camYaw) * s,
        }
        // Harness waypoint: a world-space push toward the goal, easing off
        // on arrival so the body settles instead of oscillating.
        const goal = demoGoalRef.current
        if (goal && f === 0 && s === 0) {
          const dx = goal.x - body.x
          const dz = goal.z - body.z
          const dist = Math.hypot(dx, dz)
          // A generous arrival radius: at 0.12 the momentum model overshot,
          // turned round and walked back, and the run showed his face.
          if (dist < 0.3) demoGoalRef.current = null
          else {
            const g = Math.min(1, dist / 1.2)
            input = { x: (dx / dist) * g, z: (dz / dist) * g }
          }
        }
      }

      const prev = body
      const moved = stepBody(body, input.x, input.z, dt)
      body = resolveCollisions(prev, moved, world.blockers)
      distanceWalked += Math.hypot(body.x - prev.x, body.z - prev.z)

      avatar.root.position.set(body.x, 0, body.z)
      avatar.root.rotation.y = body.heading + Math.PI
      avatar.update(gait(body), distanceWalked, dt)

      // Camera. Walking: a spring behind the player. Digging: locked to the
      // side you approached from, close and angled down into the bin, so
      // the whole selected cover is legible.
      if (digging) {
        // The bin's front rail faces +Z (the aisle). Always frame from
        // there — a crate is dug from the front, whichever way you walked up.
        if (digYaw === null) digYaw = 0
        tmp.set(at.x, DIG_HEIGHT, at.z + DIG_DISTANCE)
        camPos.lerp(tmp, Math.min(1, 5.5 * dt))
        camera.position.copy(camPos)
        // Follow the record you're on as the dig goes deeper into the bin,
        // and rise to the one in your hands when you pull it. Eased, so a
        // pull is a glance up and not a cut.
        const crate = crates.get(active!)
        const f = crate ? crate.focus(digRef.current.index, digRef.current.pulled) : { y: 1.0, z: 0 }
        tmp.set(at.x, f.y, at.z + f.z)
        lookPos.lerp(tmp, Math.min(1, 7 * dt))
        camera.lookAt(lookPos)
      } else {
        digYaw = null
        tmp.set(
          body.x + Math.sin(camYaw) * CAM_DISTANCE,
          CAM_HEIGHT,
          body.z + Math.cos(camYaw) * CAM_DISTANCE,
        )
        camPos.lerp(tmp, Math.min(1, 4.2 * dt))
        camera.position.copy(camPos)
        lookPos.set(body.x, 1.05, body.z)
        camera.lookAt(lookPos)
      }
      // At the rail the camera stands where the player's head is; he is
      // out of shot until it pulls back behind him again.
      tmp.set(at.x, DIG_HEIGHT, at.z + DIG_DISTANCE)
      avatar.root.visible = !(active && camPos.distanceTo(tmp) < 0.7)

      for (const [id, crate] of crates) {
        const mine = digging && id === active
        crate.update(digRef.current.index, digRef.current.pulled, dt, mine)
        crate.setFocus(mine ? digRef.current.index : null)
      }
      world.platter.rotation.y += dt * (playback.isPlaying ? 3.4 : 0)

      // Proximity — what's within reach right now: the nearest bin, or the deck.
      const dStation = Math.hypot(body.x - STATION_POS.x, body.z - STATION_POS.z)
      const nowInside = body.z < SHOP_DOOR_Z
      if (nowInside !== insideRef.current) { insideRef.current = nowInside; setInside(nowInside) }

      if (!digging) {
        let nearest: string | null = null
        let best = REACH
        for (const def of BINS) {
          const d = Math.hypot(body.x - def.x, body.z - def.z)
          if (d < best) { best = d; nearest = def.id }
        }
        if (nearest) { setPrompt('crate'); if (nearest !== binIdRef.current) setBinId(nearest) }
        else if (dStation < REACH) setPrompt('station')
        else if (!nowInside && Math.abs(body.x) < 2.4 && body.z < SHOP_DOOR_Z + 3) setPrompt('door')
        else setPrompt(null)
      }

      renderer.render(world.scene, camera)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      renderer.domElement.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      for (const c of crates.values()) c.dispose()
      world.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
    // Built once. Data changes are read through refs so the world is never
    // torn down mid-visit.
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keys that drive React state (mode, flipping) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

      if (mode === 'dig') {
        if (e.code === 'Escape') { setMode('walk'); setDig(digStart()); return }
        if (e.code === 'ArrowLeft' || e.code === 'KeyA') { setDig((d) => digFlip(d, -1, activeRecords().length)); e.preventDefault(); return }
        if (e.code === 'ArrowRight' || e.code === 'KeyD') { setDig((d) => digFlip(d, 1, activeRecords().length)); e.preventDefault(); return }
        if (e.code === 'Enter' || e.code === 'Space') { pull(); e.preventDefault(); return }
        if (e.code === 'KeyP') {
          const rec = activeRecords()[digRef.current.index]
          if (rec) { playRecord(rec.trackIds); flash(`Playing ${rec.album}`) }
          return
        }
        return
      }

      if (e.code === 'Escape') { onLeave(); return }
      if (e.code === 'KeyE') {
        if (prompt === 'crate' && binIdRef.current) { setMode('dig'); setDig(digStart()) }
        else if (prompt === 'station') {
          const rec = inHandRef.current
          if (rec) { playRecord(rec.trackIds); flash(`On the deck: ${rec.album}`) }
          else flash('Nothing on the deck yet — pull something out first.')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, prompt, onLeave, playRecord, flash, pull])

  // The harness pushes the same transitions the keyboard does — it is a
  // driver for the real interaction, not a second code path.
  useEffect(() => {
    if (!demoMode || !bins.length) return
    const t0 = performance.now()
    const timers = DEMO.map((step) => window.setTimeout(() => {
      if ('goto' in step) demoGoalRef.current = step.goto
      else {
        demoGoalRef.current = null
        if (step.act === 'dig') {
          if (promptRef.current === 'crate' && binIdRef.current) { setMode('dig'); setDig(digStart()) }
          else flash('HARNESS: not within reach of a bin — dig refused')
        } else if (step.act === 'undig') { setMode('walk'); setDig(digStart()) }
        else if (modeRef.current !== 'dig') flash(`HARNESS: ${step.act} ignored — not digging`)
        else if (step.act === 'flip+') setDig((d) => digFlip(d, 1, activeRecords().length))
        else if (step.act === 'flip-') setDig((d) => digFlip(d, -1, activeRecords().length))
        else if (step.act === 'pull') pull()
      }
      console.log('[step-inside/demo]', ((performance.now() - t0) / 1000).toFixed(1) + 's', step.note)
    }, step.at * 1000))
    return () => { timers.forEach((t) => window.clearTimeout(t)); demoGoalRef.current = null }
  }, [demoMode, bins.length, flash, pull])   // eslint-disable-line react-hooks/exhaustive-deps

  const pos = digPosition(dig, records.length)
  const edge = digAtEdge(dig, records.length)

  return (
    <div className="stepinside">
      <div className="stepinside__stage" ref={mountRef} />

      <div className="stepinside__hud">
        <button type="button" className="stepinside__leave" onClick={onLeave}>← Leave (Esc)</button>
        <span className="stepinside__where">{inside ? 'WJLR Records' : 'Manhattan Ave, Greenpoint'}</span>
      </div>

      {mode === 'walk' && (
        <div className="stepinside__help">
          <span><b>WASD</b> walk</span>
          <span><b>drag</b> or <b>Q</b> look</span>
          {prompt && <span className="stepinside__prompt"><b>E</b> {prompt === 'crate' ? `dig through ${bin?.label ?? 'the bin'}` : prompt === 'station' ? 'put it on the deck' : 'step inside'}</span>}
        </div>
      )}

      {mode === 'dig' && current && (
        <div className="stepinside__dig">
          <div className="stepinside__dig-card">
            <p className="stepinside__dig-album">{current.album}</p>
            <p className="stepinside__dig-artist">{current.artist}{current.year ? ` · ${current.year}` : ''}</p>
            {dig.pulled && (
              <p className="stepinside__dig-back">{current.trackIds.length} tracks · in your library</p>
            )}
          </div>
          <div className="stepinside__dig-keys">
            <span className={edge === 'front' ? 'is-edge' : ''}><b>A</b>/<b>D</b> flip</span>
            <span><b>Enter</b> {dig.pulled ? 'slide it back' : 'pull it out'}</span>
            <span><b>P</b> play it</span>
            <span><b>Esc</b> step back</span>
            <span className="stepinside__dig-count">{bin?.label} · {pos.at} / {pos.of}</span>
          </div>
        </div>
      )}

      {notice && <div className="stepinside__notice">{notice}</div>}
    </div>
  )
}

/**
 * Step Inside — the playable shop.
 *
 * One street, one door, one crate, one listening station. No city, no
 * dashboard: the brief asked for walking, entering and flipping to feel
 * right before anything expands, so everything here serves those three.
 *
 * The normal app is never more than Esc away, and the regular Record Shop
 * tabs are untouched — this is an alternative way in, not a replacement.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useLibrary } from '../../../context/LibraryContext'
import { usePlayback } from '../../../context/PlaybackContext'
import { useAudio } from '../../../hooks/useAudio'
import { buildWorld, SPAWN, CRATE_POS, STATION_POS, SHOP_DOOR_Z } from './world'
import { buildAvatar } from './avatar'
import { buildCrateView } from './crateView'
import { useCrateStock } from './useCrateStock'
import { bodyStart, stepBody, gait, resolveCollisions, type Body } from './playerModel'
import { digStart, digFlip, digTogglePull, digPosition, digAtEdge } from './digModel'
import { claimTransportKeys } from '../../../input-mode'
import type { DigState } from './types'
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
  { at: 3.6,  note: 'step inside',        goto: { x: 0, z: -8.6 } },
  { at: 6.4,  note: 'over to the crate',  goto: { x: -1.6, z: -10.9 } },   // 1.5 m from the bin, clear of its footprint
  { at: 10.2, note: 'start digging',      act: 'dig' },
  { at: 11.4, note: 'flip',               act: 'flip+' },
  { at: 12.2, note: 'flip',               act: 'flip+' },
  { at: 13.0, note: 'flip',               act: 'flip+' },
  { at: 13.8, note: 'flip',               act: 'flip+' },
  { at: 15.0, note: 'pull it out',        act: 'pull' },
  { at: 18.2, note: 'slide it back',      act: 'pull' },
  { at: 19.6, note: 'back up the crate',  act: 'flip-' },
  { at: 20.4, note: 'flip back',          act: 'flip-' },
  { at: 22.0, note: 'step back',          act: 'undig' },
]
// Digging framing: close enough to read a cover, angled down into the bin.
// Digging is framed from over the FRONT rail, like standing at the bin:
// close, looking down ~40°, so the selected cover is legible and the run
// of sleeve tops behind it is in frame.
const DIG_DISTANCE = 1.18
const DIG_HEIGHT = 1.92
const DIG_LOOK_Y = 1.02

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
  const records = useCrateStock(visitSeed)

  const [mode, setMode] = useState<Mode>('walk')
  const [dig, setDig] = useState<DigState>(digStart)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [inside, setInside] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Refs the render loop reads — state it must not re-subscribe to.
  const modeRef = useRef(mode); modeRef.current = mode
  const digRef = useRef(dig); digRef.current = dig
  const recordsRef = useRef(records); recordsRef.current = records
  const insideRef = useRef(inside); insideRef.current = inside
  const demoGoalRef = useRef<{ x: number; z: number } | null>(null)
  const promptRef = useRef(prompt); promptRef.current = prompt

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

  // ── The world ──
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)
    renderer.domElement.className = 'stepinside__canvas'

    const world = buildWorld()
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 120)
    const avatar = buildAvatar()
    world.scene.add(avatar.root)

    const crate = buildCrateView(recordsRef.current)
    world.crateAnchor.add(crate.group)

    let body: Body = bodyStart(SPAWN.x, SPAWN.z, Math.PI)
    let camYaw = 0
    let camPos = new THREE.Vector3(SPAWN.x, CAM_HEIGHT, SPAWN.z + CAM_DISTANCE)
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

      const digging = modeRef.current === 'dig'
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
          if (dist < 0.12) demoGoalRef.current = null
          else {
            const g = Math.min(1, dist / 0.9)
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
        tmp.set(CRATE_POS.x, DIG_HEIGHT, CRATE_POS.z + DIG_DISTANCE)
        camPos.lerp(tmp, Math.min(1, 5.5 * dt))
        camera.position.copy(camPos)
        camera.lookAt(CRATE_POS.x, DIG_LOOK_Y, CRATE_POS.z + 0.08)
      } else {
        digYaw = null
        tmp.set(
          body.x + Math.sin(camYaw) * CAM_DISTANCE,
          CAM_HEIGHT,
          body.z + Math.cos(camYaw) * CAM_DISTANCE,
        )
        camPos.lerp(tmp, Math.min(1, 4.2 * dt))
        camera.position.copy(camPos)
        camera.lookAt(body.x, 1.05, body.z)
      }

      crate.update(digRef.current.index, digRef.current.pulled, dt)
      world.platter.rotation.y += dt * (playback.isPlaying ? 3.4 : 0)

      // Proximity — what's within reach right now.
      const dCrate = Math.hypot(body.x - CRATE_POS.x, body.z - CRATE_POS.z)
      const dStation = Math.hypot(body.x - STATION_POS.x, body.z - STATION_POS.z)
      const nowInside = body.z < SHOP_DOOR_Z
      if (nowInside !== insideRef.current) { insideRef.current = nowInside; setInside(nowInside) }

      if (!digging) {
        if (dCrate < REACH) setPrompt('crate')
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
      crate.dispose()
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
        if (e.code === 'ArrowLeft' || e.code === 'KeyA') { setDig((d) => digFlip(d, -1, recordsRef.current.length)); e.preventDefault(); return }
        if (e.code === 'ArrowRight' || e.code === 'KeyD') { setDig((d) => digFlip(d, 1, recordsRef.current.length)); e.preventDefault(); return }
        if (e.code === 'Enter' || e.code === 'Space') { setDig((d) => digTogglePull(d)); e.preventDefault(); return }
        if (e.code === 'KeyP') {
          const rec = recordsRef.current[digRef.current.index]
          if (rec) { playRecord(rec.trackIds); flash(`Playing ${rec.album}`) }
          return
        }
        return
      }

      if (e.code === 'Escape') { onLeave(); return }
      if (e.code === 'KeyE') {
        if (prompt === 'crate') { setMode('dig'); setDig(digStart()) }
        else if (prompt === 'station') {
          const rec = recordsRef.current[digRef.current.index]
          if (rec) { playRecord(rec.trackIds); flash(`On the deck: ${rec.album}`) }
          else flash('Nothing on the deck yet — dig something out first.')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, prompt, onLeave, playRecord, flash])

  // The harness pushes the same transitions the keyboard does — it is a
  // driver for the real interaction, not a second code path.
  useEffect(() => {
    if (!demoMode || !records.length) return
    const t0 = performance.now()
    const timers = DEMO.map((step) => window.setTimeout(() => {
      if ('goto' in step) demoGoalRef.current = step.goto
      else {
        demoGoalRef.current = null
        if (step.act === 'dig') {
          if (promptRef.current === 'crate') { setMode('dig'); setDig(digStart()) }
          else flash('HARNESS: not within reach of the crate — dig refused')
        } else if (step.act === 'undig') { setMode('walk'); setDig(digStart()) }
        else if (modeRef.current !== 'dig') flash(`HARNESS: ${step.act} ignored — not digging`)
        else if (step.act === 'flip+') setDig((d) => digFlip(d, 1, recordsRef.current.length))
        else if (step.act === 'flip-') setDig((d) => digFlip(d, -1, recordsRef.current.length))
        else if (step.act === 'pull') setDig((d) => digTogglePull(d))
      }
      console.log('[step-inside/demo]', ((performance.now() - t0) / 1000).toFixed(1) + 's', step.note)
    }, step.at * 1000))
    return () => { timers.forEach((t) => window.clearTimeout(t)); demoGoalRef.current = null }
  }, [demoMode, records.length, flash])

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
          {prompt && <span className="stepinside__prompt"><b>E</b> {prompt === 'crate' ? 'dig through the crate' : prompt === 'station' ? 'put it on the deck' : 'step inside'}</span>}
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
            <span className="stepinside__dig-count">{pos.at} / {pos.of}</span>
          </div>
        </div>
      )}

      {notice && <div className="stepinside__notice">{notice}</div>}
    </div>
  )
}

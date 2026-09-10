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
import type { DigState } from './types'
import './step-inside.css'

/** PS2 output: draw small, upscale hard. 640x448 was the era's workhorse. */
const RENDER_HEIGHT = 448
const CAM_DISTANCE = 4.2
const CAM_HEIGHT = 2.15
const REACH = 2.1

type Mode = 'walk' | 'dig'

export default function StepInsideView({ onLeave }: { onLeave: () => void }) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const { state: lib } = useLibrary()
  const { state: playback } = usePlayback()
  const { playTrack } = useAudio()

  const visitSeed = useMemo(() => Math.floor(Math.random() * 1e9), [])
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

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
    renderer.setPixelRatio(1)                 // never supersample: the crunch is the look
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
    let camYaw = Math.PI
    let camPos = new THREE.Vector3(SPAWN.x, CAM_HEIGHT, SPAWN.z + CAM_DISTANCE)
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
      const scale = RENDER_HEIGHT / h
      renderer.setSize(Math.max(320, Math.round(w * scale)), RENDER_HEIGHT, false)
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
      }

      const prev = body
      const moved = stepBody(body, input.x, input.z, dt)
      body = resolveCollisions(prev, moved, world.blockers)
      distanceWalked += Math.hypot(body.x - prev.x, body.z - prev.z)

      avatar.root.position.set(body.x, 0, body.z)
      avatar.root.rotation.y = body.heading
      avatar.update(gait(body), distanceWalked, dt)

      // Camera: spring behind the player. Pulls in close over the crate.
      const wantDist = digging ? 1.9 : CAM_DISTANCE
      const wantHeight = digging ? 1.65 : CAM_HEIGHT
      const anchorX = digging ? CRATE_POS.x : body.x
      const anchorZ = digging ? CRATE_POS.z : body.z
      tmp.set(
        anchorX + Math.sin(camYaw) * wantDist,
        wantHeight,
        anchorZ + Math.cos(camYaw) * wantDist,
      )
      camPos.lerp(tmp, Math.min(1, (digging ? 6 : 4.2) * dt))
      camera.position.copy(camPos)
      camera.lookAt(anchorX, digging ? 1.0 : 1.05, anchorZ)

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

  const pos = digPosition(dig, records.length)
  const edge = digAtEdge(dig, records.length)

  return (
    <div className="stepinside">
      <div className="stepinside__stage" ref={mountRef} />

      <div className="stepinside__hud">
        <button type="button" className="stepinside__leave" onClick={onLeave}>← Leave (Esc)</button>
        <span className="stepinside__where">{inside ? 'WJLR Records' : 'Atlantic Ave'}</span>
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

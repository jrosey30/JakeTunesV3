/**
 * You, in the shop.
 *
 * Built from boxes on purpose. A low-poly figure with a real walk cycle
 * reads as a person; a detailed model with a bad walk reads as a puppet,
 * and consistent character art was already a losing fight on this project.
 * So: PS2 proportions, four limbs, and animation doing the work.
 *
 * The cycle is driven by distance walked, not by wall time, so the feet
 * never skate — speed up and the legs swing faster because you covered
 * more ground, which is what selling a walk actually depends on.
 */
import * as THREE from 'three'

export interface Avatar {
  root: THREE.Group
  /** Advance the walk cycle. `gait` is 0..1 of full speed. */
  update: (gait: number, distanceWalked: number, dt: number) => void
}

const SKIN = 0xd8a07a
const SHIRT = 0x6b4630
const JEANS = 0x3d4a63
const HAIR = 0x2a1c14

function part(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }))
}

export function buildAvatar(): Avatar {
  const root = new THREE.Group()

  const hips = new THREE.Group()
  hips.position.y = 0.86
  root.add(hips)

  const torso = part(0.46, 0.62, 0.26, SHIRT)
  torso.position.y = 0.31
  hips.add(torso)

  const head = part(0.26, 0.28, 0.26, SKIN)
  head.position.y = 0.78
  hips.add(head)
  const hair = part(0.28, 0.09, 0.28, HAIR)
  hair.position.y = 0.91
  hips.add(hair)

  // Limbs pivot from the top, so a rotation swings them like joints.
  const limb = (w: number, h: number, d: number, color: number): THREE.Group => {
    const pivot = new THREE.Group()
    const mesh = part(w, h, d, color)
    mesh.position.y = -h / 2
    pivot.add(mesh)
    return pivot
  }

  const armL = limb(0.13, 0.56, 0.15, SHIRT); armL.position.set(-0.3, 0.56, 0); hips.add(armL)
  const armR = limb(0.13, 0.56, 0.15, SHIRT); armR.position.set(0.3, 0.56, 0); hips.add(armR)
  const legL = limb(0.16, 0.8, 0.18, JEANS); legL.position.set(-0.12, 0.02, 0); hips.add(legL)
  const legR = limb(0.16, 0.8, 0.18, JEANS); legR.position.set(0.12, 0.02, 0); hips.add(legR)

  const update = (gait: number, distanceWalked: number, dt: number): void => {
    // Stride length ~0.9m: one full swing per 1.8m covered.
    const phase = distanceWalked * (Math.PI * 2 / 1.8)
    const swing = Math.sin(phase) * 0.72 * gait
    const counter = Math.sin(phase + Math.PI) * 0.5 * gait

    legL.rotation.x = swing
    legR.rotation.x = -swing
    armL.rotation.x = counter
    armR.rotation.x = -counter

    // Bob twice per stride, and lean in a touch when moving — the two
    // cheapest cues that a body has weight.
    hips.position.y = 0.86 + Math.abs(Math.sin(phase)) * 0.045 * gait
    const targetLean = gait * 0.07
    hips.rotation.x += (targetLean - hips.rotation.x) * Math.min(1, 8 * dt)
    // Idle: a slow breath so standing still isn't a freeze-frame.
    if (gait < 0.02) {
      torso.scale.y = 1 + Math.sin(performance.now() / 900) * 0.012
    } else {
      torso.scale.y = 1
    }
  }

  return { root, update }
}

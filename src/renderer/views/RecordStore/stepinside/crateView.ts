/**
 * The sleeves in the bin.
 *
 * Rebuilt 2026-09-09 after Jake: "the crate view is not acceptable visually."
 * What was wrong and what each fix is for:
 *
 *   • Sleeves sank through a solid box. The bin is now open furniture
 *     (world.ts BIN) and the records stand ON its base, INSIDE its walls,
 *     with roughly half the cover above the rim — which is what makes a
 *     bin readable at a glance.
 *   • Everything was one brown mass. Sleeves get their own light board
 *     backing and manila SECTION DIVIDERS break the run up, so the stack
 *     has structure instead of being a smear.
 *   • Packing was too thick to look like records and too thin to browse.
 *     Now ~14mm apart, which reads as a real stack while still letting a
 *     dozen covers show.
 *   • You could not see what you were looking at. The SELECTED sleeve
 *     lifts clear of its neighbours and squares up to the camera, so the
 *     whole cover is visible while you flip — pulling it out is then a
 *     second, bigger move, not the only way to see the art.
 *
 * The flip is critically damped toward its target every frame, so holding
 * a direction glides instead of snapping, and letting go settles.
 */
import * as THREE from 'three'
import { BIN } from './world'
import type { CrateRecord } from './types'

const SLEEVE = 0.62
const SPACING = 0.014
const LEAN = 0.16                 // the whole stack leans back on the bin
const FLIPPED = 1.22              // a sleeve you've dug past, tipped forward
const SELECTED_LIFT = 0.13
const SELECTED_TILT = -0.42       // squared up toward a browsing eyeline
const PULLED_LIFT = 0.52
const PULLED_TILT = -0.62       // faces a camera looking down at ~35°, not the ceiling
const DIVIDER_EVERY = 8
const VISIBLE_EITHER_SIDE = 16

export interface CrateView {
  group: THREE.Group
  update: (index: number, pulled: boolean, dt: number) => void
  dispose: () => void
}

export function buildCrateView(records: CrateRecord[]): CrateView {
  const group = new THREE.Group()
  const loader = new THREE.TextureLoader()
  const sleeveGeo = new THREE.PlaneGeometry(SLEEVE, SLEEVE)
  // A sleeve has a back. Without it, a tipped-forward record shows the
  // room through itself.
  const boardGeo = new THREE.BoxGeometry(SLEEVE + 0.012, SLEEVE + 0.012, 0.008)
  const dividerGeo = new THREE.BoxGeometry(SLEEVE + 0.06, SLEEVE + 0.14, 0.012)
  const dividerMat = new THREE.MeshLambertMaterial({ color: 0xb08f5e })
  const boardMat = new THREE.MeshLambertMaterial({ color: 0x2b2620 })

  const materials: THREE.Material[] = [dividerMat, boardMat]
  const pivots: THREE.Group[] = []
  const dividers: THREE.Mesh[] = []

  const zFor = (i: number): number => -i * SPACING

  records.forEach((rec, i) => {
    const mat = new THREE.MeshLambertMaterial({ color: 0x9a8f7d })
    materials.push(mat)
    if (rec.coverUrl) {
      loader.load(
        rec.coverUrl,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace
          // Linear + mipmaps + anisotropy: the art has to stay READABLE.
          // Nearest-filtering it was pixelation hiding the model, which is
          // the opposite of the PS2 look we want.
          tex.magFilter = THREE.LinearFilter
          tex.minFilter = THREE.LinearMipmapLinearFilter
          tex.anisotropy = 8
          tex.generateMipmaps = true
          mat.map = tex
          mat.color.set(0xffffff)
          mat.needsUpdate = true
        },
        undefined,
        () => { /* no artwork — plain board, honestly blank */ },
      )
    }

    // Pivot on the BOTTOM edge: a record tips on its spine.
    const pivot = new THREE.Group()
    const board = new THREE.Mesh(boardGeo, boardMat)
    board.position.set(0, SLEEVE / 2, -0.006)
    pivot.add(board)
    const face = new THREE.Mesh(sleeveGeo, mat)
    face.position.set(0, SLEEVE / 2, 0.002)
    pivot.add(face)

    pivot.position.set(0, BIN.baseTop, zFor(i))
    pivot.rotation.x = -LEAN
    group.add(pivot)
    pivots.push(pivot)

    // Section dividers stand proud of the records, like real tabs.
    if (i > 0 && i % DIVIDER_EVERY === 0) {
      const d = new THREE.Mesh(dividerGeo, dividerMat)
      d.position.set(0, BIN.baseTop + (SLEEVE + 0.14) / 2, zFor(i) + SPACING / 2)
      d.rotation.x = -LEAN
      group.add(d)
      dividers.push(d)
    }
  })

  const update = (index: number, pulled: boolean, dt: number): void => {
    const k = 1 - Math.exp(-11 * dt)      // frame-rate independent easing

    for (let i = 0; i < pivots.length; i++) {
      const p = pivots[i]
      const rel = i - index
      const near = Math.abs(rel) <= VISIBLE_EITHER_SIDE
      if (p.visible !== near) p.visible = near
      if (!near) continue

      let rot = -LEAN
      let y = BIN.baseTop
      let z = zFor(rel)

      if (rel < 0) {
        // Dug past: tipped forward and bunched, so the stack in front of
        // you visibly thins as you go deeper.
        rot = FLIPPED
        z = Math.max(rel, -7) * SPACING * 2.1 + 0.20
      } else if (rel === 0) {
        rot = pulled ? PULLED_TILT : SELECTED_TILT
        y = BIN.baseTop + (pulled ? PULLED_LIFT : SELECTED_LIFT)
        z = pulled ? 0.30 : 0.10
      }

      p.rotation.x += (rot - p.rotation.x) * k
      p.position.y += (y - p.position.y) * k
      p.position.z += (z - p.position.z) * k
    }

    // Dividers ride with the stack so they stay between the same records.
    let n = 0
    for (let i = DIVIDER_EVERY; i < pivots.length; i += DIVIDER_EVERY) {
      const d = dividers[n++]
      if (!d) break
      const rel = i - index
      const near = Math.abs(rel) <= VISIBLE_EITHER_SIDE
      if (d.visible !== near) d.visible = near
      if (!near) continue
      const target = rel < 0 ? Math.max(rel, -7) * SPACING * 2.1 + 0.22 : zFor(rel) + SPACING / 2
      d.position.z += (target - d.position.z) * k
      d.rotation.x += ((rel < 0 ? FLIPPED : -LEAN) - d.rotation.x) * k
    }
  }

  const dispose = (): void => {
    sleeveGeo.dispose()
    boardGeo.dispose()
    dividerGeo.dispose()
    materials.forEach((m) => {
      const lm = m as THREE.MeshLambertMaterial
      lm.map?.dispose()
      lm.dispose()
    })
  }

  return { group, update, dispose }
}

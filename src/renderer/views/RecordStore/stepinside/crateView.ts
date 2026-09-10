/**
 * The sleeves in the bin.
 *
 * This is the interaction the brief put first, so it is modelled the way
 * the real thing works rather than as a carousel of cover art:
 *
 *   • Sleeves stand upright, packed front-to-back, leaning on each other.
 *   • Flipping tips the ones you've passed FORWARD, out of the way. The
 *     stack in front of you visibly thins as you dig deeper — that is how
 *     you feel your position in a crate without reading a counter.
 *   • Only a few sleeves either side are drawn upright; the rest are
 *     bunched. A crate of forty records should look like forty records
 *     without costing forty draw calls of animation.
 *   • Pulling one out lifts it clear and turns it to face you.
 *
 * Covers are the real album artwork off album-art://; a record with no
 * artwork in the library gets a blank sleeve rather than being hidden,
 * because a blank sleeve is what an unsleeved record looks like.
 */
import * as THREE from 'three'
import type { CrateRecord } from './types'

const SLEEVE = 0.62          // metres square — a 12" at this scale
const SPACING = 0.028        // how thickly they pack
const LEAN = 0.22            // radians the upright stack leans back
const FLIPPED = 1.32         // radians a passed sleeve tips forward
const VISIBLE_EITHER_SIDE = 14

export interface CrateView {
  group: THREE.Group
  /** Point the stack at `index`, animating toward it. Call every frame. */
  update: (index: number, pulled: boolean, dt: number) => void
  dispose: () => void
}

function blankMaterial(): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color: 0x8d7f6d })
}

export function buildCrateView(records: CrateRecord[]): CrateView {
  const group = new THREE.Group()
  const loader = new THREE.TextureLoader()
  const geo = new THREE.PlaneGeometry(SLEEVE, SLEEVE)
  const materials: THREE.Material[] = []
  const pivots: THREE.Group[] = []

  records.forEach((rec, i) => {
    const mat = blankMaterial()
    materials.push(mat)
    if (rec.coverUrl) {
      // Load lazily; a cover that never arrives just stays a blank sleeve.
      loader.load(
        rec.coverUrl,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace
          // Nearest keeps the PS2 crunch instead of a soapy filtered cover.
          tex.magFilter = THREE.NearestFilter
          tex.minFilter = THREE.LinearMipmapLinearFilter
          mat.map = tex
          mat.color.set(0xffffff)
          mat.needsUpdate = true
        },
        undefined,
        () => { /* no artwork — blank sleeve, which is honest */ },
      )
    }

    // Pivot at the BOTTOM edge so a sleeve tips forward on its spine.
    const pivot = new THREE.Group()
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.y = SLEEVE / 2
    pivot.add(mesh)
    pivot.position.set(0, 0.52, -i * SPACING)
    pivot.rotation.x = -LEAN
    group.add(pivot)
    pivots.push(pivot)
  })

  const update = (index: number, pulled: boolean, dt: number): void => {
    const k = Math.min(1, 12 * dt)
    for (let i = 0; i < pivots.length; i++) {
      const p = pivots[i]
      const rel = i - index
      // Cull the far field: a crate is deep, the animation budget is not.
      const near = Math.abs(rel) <= VISIBLE_EITHER_SIDE
      p.visible = near
      if (!near) continue

      let targetRot: number
      let targetY = 0.52
      let targetZ: number

      if (rel < 0) {
        // Already dug past: tipped forward, bunched at the front.
        targetRot = FLIPPED
        targetZ = Math.max(rel, -6) * SPACING * 1.6 + 0.18
      } else if (rel === 0 && pulled) {
        // Pulled out to read: lifted clear and turned face-on.
        targetRot = -1.05
        targetY = 0.95
        targetZ = 0.34
      } else {
        // Still to come: upright, leaning back, packed.
        targetRot = -LEAN
        targetZ = -rel * SPACING
      }

      p.rotation.x += (targetRot - p.rotation.x) * k
      p.position.y += (targetY - p.position.y) * k
      p.position.z += (targetZ - p.position.z) * k
    }
  }

  const dispose = (): void => {
    geo.dispose()
    materials.forEach((m) => {
      const lm = m as THREE.MeshLambertMaterial
      lm.map?.dispose()
      lm.dispose()
    })
  }

  return { group, update, dispose }
}
